import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AccessStrategy, BridgeConfig, SandboxMode } from "./config.js";
import { enforceSandbox, requireAllowedCwd } from "./config.js";
import type { BridgeStateStore } from "./stateStore.js";
import {
  MODEL_POLICY_SCHEMA_VERSION,
  automaticModelPolicy,
  validateModelPolicy,
  type ModelPolicy
} from "./modelPolicy.js";
import {
  isUiLocalePreference,
  type UiLocalePreference
} from "./uiI18n.js";

export const ACTIVITY_CARD_VISIBILITIES = ["always", "background-only", "never"] as const;
export type ActivityCardVisibility = (typeof ACTIVITY_CARD_VISIBILITIES)[number];
export const COMPLETION_HANDOFF_MODES = ["off", "auto-handoff"] as const;
export type CompletionHandoffMode = (typeof COMPLETION_HANDOFF_MODES)[number];
export const SETTINGS_REVISION_CONFLICT = "SETTINGS_REVISION_CONFLICT";

export type BridgeUserSettings = {
  schemaVersion: typeof MODEL_POLICY_SCHEMA_VERSION;
  revision: number;
  updatedAt: string | null;
  accessStrategy: AccessStrategy;
  modelPolicy: ModelPolicy;
  /** Migration-only compatibility for legacy defaults that selected a model but no effort. */
  legacyPreferredModel?: string;
  defaultCwd: string | null;
  uiLocalePreference: UiLocalePreference;
  maxConcurrentJobs: number;
  activityCardVisibility: ActivityCardVisibility;
  completionHandoff: CompletionHandoffMode;
};

export type BridgeUserSettingsPatch = Partial<
  Omit<
    BridgeUserSettings,
    "schemaVersion" | "revision" | "updatedAt" | "legacyPreferredModel"
  >
>;

type PersistedSettingsState = {
  version: 2;
  settings: BridgeUserSettings;
};

export type UserSettingsStoreOptions = {
  stateFile?: string;
  stateStore?: BridgeStateStore;
  now?: () => number;
};

export class UserSettingsStore {
  private readonly stateFile?: string;
  private readonly stateStore?: BridgeStateStore;
  private readonly now: () => number;
  private readonly initial: BridgeUserSettings;
  private settings: BridgeUserSettings;
  private readonly warnings: string[] = [];
  private retiredSettingsMigrationPending = false;

  constructor(
    private readonly config: BridgeConfig,
    options: UserSettingsStoreOptions = {}
  ) {
    this.stateFile = options.stateFile;
    this.stateStore = options.stateStore;
    this.now = options.now || Date.now;
    this.initial = this.validate({
      schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
      revision: 0,
      updatedAt: null,
      accessStrategy: config.defaultAccessStrategy,
      modelPolicy: automaticModelPolicy(
        config.defaultModel && config.defaultReasoningEffort
          ? {
              model: config.defaultModel,
              reasoningEffort: config.defaultReasoningEffort
            }
          : undefined
      ),
      defaultCwd: config.allowedRoots.length === 1 ? config.allowedRoots[0] : null,
      uiLocalePreference: "auto",
      maxConcurrentJobs: config.maxConcurrentJobs,
      activityCardVisibility: "always",
      completionHandoff: "off"
    });
    this.settings = cloneSettings(this.initial);
    this.load();
  }

  get persistent(): boolean {
    return Boolean(this.stateStore?.persistent || this.stateFile);
  }

  get persistencePath(): string | null {
    return this.stateStore?.persistencePath || this.stateFile || null;
  }

  get current(): BridgeUserSettings {
    return cloneSettings(this.settings);
  }

  get defaults(): BridgeUserSettings {
    return cloneSettings(this.initial);
  }

  get loadWarnings(): string[] {
    return [...this.warnings];
  }

  update(patch: BridgeUserSettingsPatch, expectedRevision: number): BridgeUserSettings {
    this.assertRevision(expectedRevision);
    const candidate: BridgeUserSettings = {
      ...this.settings,
      ...patch,
      revision: this.settings.revision + 1,
      updatedAt: new Date(this.now()).toISOString()
    };
    if (patch.modelPolicy !== undefined) delete candidate.legacyPreferredModel;
    const validated = this.validate(candidate);
    this.persist(validated);
    this.settings = validated;
    return this.current;
  }

  reset(expectedRevision: number): BridgeUserSettings {
    this.assertRevision(expectedRevision);
    const validated = this.validate({
      ...this.initial,
      revision: this.settings.revision + 1,
      updatedAt: new Date(this.now()).toISOString()
    });
    this.persist(validated);
    this.settings = validated;
    return this.current;
  }

  resolveSandbox(requested?: SandboxMode): SandboxMode {
    if (this.settings.accessStrategy === "read-only") {
      return "read-only";
    }
    if (this.settings.accessStrategy === "always-full") {
      return enforceSandbox(this.config, "danger-full-access");
    }
    return enforceSandbox(this.config, requested);
  }

  resolveCwd(requested?: string): string {
    const cwd = requested || this.settings.defaultCwd;
    if (cwd) return requireAllowedCwd(cwd, this.config.allowedRoots);
    if (this.config.allowedRoots.length === 1) return this.config.allowedRoots[0];
    throw new Error("cwd is required when multiple CODEX_MCP_BRIDGE_ROOTS are configured.");
  }

  private assertRevision(expectedRevision: number): void {
    if (expectedRevision !== this.settings.revision) {
      throw new Error(`${SETTINGS_REVISION_CONFLICT}: Settings changed after this card was opened.`);
    }
  }

  private validate(candidate: BridgeUserSettings): BridgeUserSettings {
    if (
      candidate.accessStrategy !== "read-only" &&
      candidate.accessStrategy !== "adaptive" &&
      candidate.accessStrategy !== "always-full"
    ) {
      throw new Error(`Invalid access strategy: ${String(candidate.accessStrategy)}`);
    }
    if (candidate.accessStrategy === "always-full" && !this.config.allowDangerFullAccess) {
      throw new Error("always-full is unavailable because the bridge security policy disables danger-full-access.");
    }
    if (candidate.defaultCwd !== null) {
      candidate.defaultCwd = requireAllowedCwd(candidate.defaultCwd, this.config.allowedRoots);
    }
    if (candidate.schemaVersion !== MODEL_POLICY_SCHEMA_VERSION) {
      throw new Error("Invalid settings schema version.");
    }
    if (candidate.legacyPreferredModel !== undefined) {
      validateIdentifier(candidate.legacyPreferredModel, "legacy preferred model", 200);
      if (
        candidate.modelPolicy.mode !== "automatic" ||
        candidate.modelPolicy.preferredSelection !== undefined
      ) {
        throw new Error(
          "A legacy model-only preference is valid only for an automatic policy without an exact preferred selection."
        );
      }
    }
    candidate.modelPolicy = validateModelPolicy(candidate.modelPolicy);
    if (!isUiLocalePreference(candidate.uiLocalePreference)) {
      throw new Error(`Invalid interface language preference: ${String(candidate.uiLocalePreference)}`);
    }
    validateIntegerRange(candidate.maxConcurrentJobs, 1, this.config.maxConcurrentJobs, "Concurrent job limit", "jobs");
    if (!ACTIVITY_CARD_VISIBILITIES.includes(candidate.activityCardVisibility)) {
      throw new Error(`Invalid Activity card visibility: ${String(candidate.activityCardVisibility)}`);
    }
    if (!COMPLETION_HANDOFF_MODES.includes(candidate.completionHandoff)) {
      throw new Error(`Invalid completion handoff mode: ${String(candidate.completionHandoff)}`);
    }
    if (candidate.activityCardVisibility === "never" && candidate.completionHandoff === "auto-handoff") {
      throw new Error("Automatic GPT handoff requires the Activity card to be visible.");
    }
    if (!Number.isInteger(candidate.revision) || candidate.revision < 0) {
      throw new Error("Invalid settings revision.");
    }
    if (candidate.updatedAt !== null && !Number.isFinite(Date.parse(candidate.updatedAt))) {
      throw new Error("Invalid settings update timestamp.");
    }
    return cloneSettings(candidate);
  }

  private load(): void {
    if (this.stateStore) {
      const stored = this.stateStore.getSettings();
      if (stored !== undefined) {
        if (!isRecord(stored)) throw new Error("Invalid bridge settings in the state database.");
        this.noteRetiredSettings(stored);
        this.loadCandidate(readSettings(stored, this.stateStore.persistencePath || "state database"));
      }
      this.importLegacyState(stored !== undefined);
      return;
    }
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read bridge settings at ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      !isRecord(parsed) ||
      (parsed.version !== 1 && parsed.version !== 2) ||
      !isRecord(parsed.settings)
    ) {
      throw new Error(`Invalid bridge settings format at ${this.stateFile}.`);
    }
    this.noteRetiredSettings(parsed.settings);
    this.loadCandidate(readSettings(parsed.settings, this.stateFile));
  }

  private importLegacyState(alreadyStored: boolean): void {
    if (!this.stateStore || !this.stateFile || !existsSync(this.stateFile)) return;
    const marker = `legacy_settings_imported:${this.stateFile}`;
    if (this.stateStore.getMeta(marker)) return;
    this.stateStore.transaction(() => {
      if (!alreadyStored) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(this.stateFile as string, "utf8"));
        } catch (error) {
          throw new Error(
            `Could not read bridge settings at ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (
          !isRecord(parsed) ||
          (parsed.version !== 1 && parsed.version !== 2) ||
          !isRecord(parsed.settings)
        ) {
          throw new Error(`Invalid bridge settings format at ${this.stateFile}.`);
        }
        this.noteRetiredSettings(parsed.settings);
        this.loadCandidate(readSettings(parsed.settings, this.stateFile as string));
        this.stateStore?.setSettings(this.settings);
      }
      this.stateStore?.setMeta(marker, new Date().toISOString());
    });
  }

  private loadCandidate(candidate: BridgeUserSettings): void {
    const reconciled = { ...candidate };
    if (reconciled.accessStrategy === "always-full" && !this.config.allowDangerFullAccess) {
      reconciled.accessStrategy = "read-only";
      this.warnings.push(
        "Saved full-access mode was downgraded to read-only because the bridge security policy disables danger-full-access."
      );
    }
    if (reconciled.defaultCwd !== null) {
      try {
        reconciled.defaultCwd = requireAllowedCwd(reconciled.defaultCwd, this.config.allowedRoots);
      } catch {
        reconciled.defaultCwd = this.config.allowedRoots.length === 1 ? this.config.allowedRoots[0] : null;
        this.warnings.push(
          "Saved working directory was outside the currently allowed roots and was replaced with a safe allowed default."
        );
      }
    }
    if (reconciled.maxConcurrentJobs > this.config.maxConcurrentJobs) {
      reconciled.maxConcurrentJobs = this.config.maxConcurrentJobs;
      this.warnings.push("Saved concurrent-job limit was reduced to the current bridge maximum.");
    }
    const changed =
      this.retiredSettingsMigrationPending || JSON.stringify(reconciled) !== JSON.stringify(candidate);
    if (changed) {
      reconciled.revision += 1;
      reconciled.updatedAt = new Date(this.now()).toISOString();
    }
    this.settings = this.validate(reconciled);
    if (changed) {
      this.persist(this.settings);
      this.retiredSettingsMigrationPending = false;
    }
  }

  private noteRetiredSettings(value: Record<string, unknown>): void {
    const retired = [
      "taskTimeoutMs",
      "defaultSessionMode",
      "autoResumeTtlMs",
      "completionDeliveryMode",
      "defaultModel",
      "defaultReasoningEffort"
    ].filter(
      (key) => key in value
    );
    if (
      retired.length === 0 &&
      value.schemaVersion === MODEL_POLICY_SCHEMA_VERSION &&
      "modelPolicy" in value &&
      "uiLocalePreference" in value &&
      "activityCardVisibility" in value &&
      "completionHandoff" in value
    ) return;
    this.retiredSettingsMigrationPending = true;
    const modelOnlyLegacy =
      typeof value.defaultModel === "string" &&
      Boolean(value.defaultModel) &&
      (value.defaultReasoningEffort === null || value.defaultReasoningEffort === undefined);
    if (
      ("defaultModel" in value || "defaultReasoningEffort" in value) &&
      !this.warnings.some((warning) => warning.includes("model policy"))
    ) {
      this.warnings.push(
        modelOnlyLegacy
          ? "Saved defaultModel was preserved in the automatic model policy as a legacy preference; its exact default effort is materialized from the backend catalog at execution time."
          : "Saved defaultModel/defaultReasoningEffort values were migrated to the versioned automatic model policy."
      );
    }
    if ("taskTimeoutMs" in value && !this.warnings.some((warning) => warning.includes("taskTimeoutMs"))) {
      this.warnings.push(
        "Saved taskTimeoutMs was retired and removed. Codex execution is now unlimited-only."
      );
    }
    if (
      ("defaultSessionMode" in value || "autoResumeTtlMs" in value) &&
      !this.warnings.some((warning) => warning.includes("Activity-managed"))
    ) {
      this.warnings.push(
        "Saved defaultSessionMode and autoResumeTtlMs were retired and removed. Session selection is now Activity-managed with no age limit for exact continuation."
      );
    }
    if (
      "completionDeliveryMode" in value &&
      !this.warnings.some((warning) => warning.includes("completionDeliveryMode"))
    ) {
      this.warnings.push(
        "Saved completionDeliveryMode was migrated to independent Activity card visibility and completion handoff settings."
      );
    }
  }

  private persist(settings: BridgeUserSettings): void {
    if (this.stateStore) {
      this.stateStore.setSettings(settings);
      return;
    }
    if (!this.stateFile) return;
    const directory = path.dirname(this.stateFile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    const state: PersistedSettingsState = {
      version: 2,
      settings
    };
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    renameSync(temporary, this.stateFile);
    chmodSync(this.stateFile, 0o600);
  }
}

function readSettings(value: Record<string, unknown>, stateFile: string): BridgeUserSettings {
  const requiredStringOrNull = (key: string): string | null => {
    const entry = value[key];
    if (entry === null || typeof entry === "string") return entry;
    throw new Error(`Invalid ${key} in bridge settings at ${stateFile}.`);
  };
  const requiredNumber = (key: string): number => {
    const entry = value[key];
    if (typeof entry === "number") return entry;
    throw new Error(`Invalid ${key} in bridge settings at ${stateFile}.`);
  };
  const accessStrategy = value.accessStrategy;
  if (value.uiLocalePreference !== undefined && !isUiLocalePreference(value.uiLocalePreference)) {
    throw new Error(`Invalid uiLocalePreference in bridge settings at ${stateFile}.`);
  }
  const updatedAt = requiredStringOrNull("updatedAt");
  const legacyModel = value.defaultModel === undefined ? null : requiredStringOrNull("defaultModel");
  const legacyEffort = value.defaultReasoningEffort === undefined
    ? null
    : requiredStringOrNull("defaultReasoningEffort");
  if (legacyEffort && !legacyModel) {
    throw new Error(`A legacy defaultReasoningEffort requires defaultModel in bridge settings at ${stateFile}.`);
  }
  const persistedLegacyPreferredModel = value.legacyPreferredModel === undefined
    ? undefined
    : requiredStringOrNull("legacyPreferredModel") || undefined;
  const hasCurrentPolicy =
    value.schemaVersion === MODEL_POLICY_SCHEMA_VERSION && value.modelPolicy !== undefined;
  const modelPolicy = hasCurrentPolicy
    ? validateModelPolicy(value.modelPolicy)
    : automaticModelPolicy(
        legacyModel && legacyEffort
          ? { model: legacyModel, reasoningEffort: legacyEffort }
          : undefined
      );
  return {
    schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
    revision: requiredNumber("revision"),
    updatedAt,
    accessStrategy: accessStrategy as AccessStrategy,
    modelPolicy,
    ...(persistedLegacyPreferredModel || (!hasCurrentPolicy && legacyModel && !legacyEffort)
      ? { legacyPreferredModel: (persistedLegacyPreferredModel || legacyModel) as string }
      : {}),
    defaultCwd: requiredStringOrNull("defaultCwd"),
    uiLocalePreference: isUiLocalePreference(value.uiLocalePreference)
      ? value.uiLocalePreference
      : "auto",
    maxConcurrentJobs: requiredNumber("maxConcurrentJobs"),
    activityCardVisibility:
      value.activityCardVisibility === "always" ||
      value.activityCardVisibility === "background-only" ||
      value.activityCardVisibility === "never"
        ? value.activityCardVisibility
        : "always",
    completionHandoff:
      value.completionHandoff === "off" || value.completionHandoff === "auto-handoff"
        ? value.completionHandoff
        : value.completionDeliveryMode === "auto-handoff"
          ? "auto-handoff"
          : "off"
  };
}

function cloneSettings(settings: BridgeUserSettings): BridgeUserSettings {
  return {
    ...settings,
    modelPolicy: validateModelPolicy(settings.modelPolicy)
  };
}

function validateIntegerRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
  unit = "milliseconds"
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum} ${unit}.`);
  }
}

function validateIdentifier(value: string, label: string, maximum: number): void {
  if (!value.trim() || value !== value.trim() || value.length > maximum || /[\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
