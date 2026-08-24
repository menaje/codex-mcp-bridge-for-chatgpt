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
export const CWD_OVERRIDE_RETIRED = "CWD_OVERRIDE_RETIRED";
export const DEFAULT_CWD_REQUIRED = "DEFAULT_CWD_REQUIRED";
export const DEFAULT_CWD_NOT_ALLOWED = "DEFAULT_CWD_NOT_ALLOWED";

export type BridgeUserSettings = {
  schemaVersion: typeof MODEL_POLICY_SCHEMA_VERSION;
  revision: number;
  updatedAt: string | null;
  accessStrategy: AccessStrategy;
  modelPolicy: ModelPolicy;
  usePriorityServiceTier: boolean;
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
  private unavailableDefaultCwd?: string;

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
      usePriorityServiceTier: false,
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
    if (
      this.unavailableDefaultCwd !== undefined &&
      !Object.prototype.hasOwnProperty.call(patch, "defaultCwd")
    ) {
      throw new Error(
        `${DEFAULT_CWD_NOT_ALLOWED}: The saved default working folder is outside the current allowed roots. Save an allowed default working folder with this update.`
      );
    }
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
    if (Object.prototype.hasOwnProperty.call(patch, "defaultCwd")) {
      this.unavailableDefaultCwd = undefined;
    }
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
    this.unavailableDefaultCwd = undefined;
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
    if (requested !== undefined) {
      throw new Error(
        `${CWD_OVERRIDE_RETIRED}: Per-call cwd is retired. Refresh the tool list and save the default working folder in Codex settings.`
      );
    }
    if (this.unavailableDefaultCwd !== undefined) {
      throw new Error(
        `${DEFAULT_CWD_NOT_ALLOWED}: The saved default working folder is no longer inside an allowed root. Update Codex settings before starting a new Activity.`
      );
    }
    if (!this.settings.defaultCwd) {
      throw new Error(
        `${DEFAULT_CWD_REQUIRED}: Save a default working folder in Codex settings before starting a new Activity.`
      );
    }
    try {
      return requireAllowedCwd(this.settings.defaultCwd, this.config.allowedRoots);
    } catch {
      throw new Error(
        `${DEFAULT_CWD_NOT_ALLOWED}: The saved default working folder is no longer inside an allowed root. Update Codex settings before starting a new Activity.`
      );
    }
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
    if (typeof candidate.usePriorityServiceTier !== "boolean") {
      throw new Error("Invalid Priority service-tier preference.");
    }
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
    const persisted = { ...candidate };
    this.unavailableDefaultCwd = undefined;
    if (reconciled.accessStrategy === "always-full" && !this.config.allowDangerFullAccess) {
      reconciled.accessStrategy = "read-only";
      persisted.accessStrategy = "read-only";
      this.warnings.push(
        "Saved full-access mode was downgraded to read-only because the bridge security policy disables danger-full-access."
      );
    }
    if (reconciled.defaultCwd !== null) {
      try {
        reconciled.defaultCwd = requireAllowedCwd(reconciled.defaultCwd, this.config.allowedRoots);
        persisted.defaultCwd = reconciled.defaultCwd;
      } catch {
        this.unavailableDefaultCwd = reconciled.defaultCwd;
        reconciled.defaultCwd = null;
        this.warnings.push(
          `${DEFAULT_CWD_NOT_ALLOWED}: The saved working directory is outside the current allowed roots. Save an allowed default before starting a new Activity.`
        );
      }
    }
    if (reconciled.maxConcurrentJobs > this.config.maxConcurrentJobs) {
      reconciled.maxConcurrentJobs = this.config.maxConcurrentJobs;
      persisted.maxConcurrentJobs = this.config.maxConcurrentJobs;
      this.warnings.push("Saved concurrent-job limit was reduced to the current bridge maximum.");
    }
    const persistentlyChanged =
      this.retiredSettingsMigrationPending || JSON.stringify(persisted) !== JSON.stringify(candidate);
    if (persistentlyChanged) {
      reconciled.revision += 1;
      reconciled.updatedAt = new Date(this.now()).toISOString();
      persisted.revision = reconciled.revision;
      persisted.updatedAt = reconciled.updatedAt;
    }
    this.settings = this.validate(reconciled);
    if (persistentlyChanged) {
      // Preserve an unavailable saved path verbatim while persisting independent
      // capability/retired-field reconciliation. It becomes usable again when
      // the operator restores the corresponding allowed root.
      this.persist(persisted);
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
      "defaultReasoningEffort",
      "activityCardView"
    ].filter(
      (key) => key in value
    );
    const migratedModelPolicy = migrateModelPolicyServiceTiers(value.modelPolicy);
    if (
      retired.length === 0 &&
      value.schemaVersion === MODEL_POLICY_SCHEMA_VERSION &&
      "modelPolicy" in value &&
      "usePriorityServiceTier" in value &&
      !migratedModelPolicy.changed &&
      "uiLocalePreference" in value &&
      "activityCardVisibility" in value &&
      "completionHandoff" in value
    ) return;
    this.retiredSettingsMigrationPending = true;
    if (
      migratedModelPolicy.changed &&
      !this.warnings.some((warning) => warning.includes("independent Priority preference"))
    ) {
      this.warnings.push(
        "Saved model-policy serviceTier values were migrated to the independent Priority preference. GPT now selects only model and reasoning effort."
      );
    }
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
  if (value.usePriorityServiceTier !== undefined && typeof value.usePriorityServiceTier !== "boolean") {
    throw new Error(`Invalid usePriorityServiceTier in bridge settings at ${stateFile}.`);
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
  const migratedModelPolicy = migrateModelPolicyServiceTiers(value.modelPolicy);
  const modelPolicy = hasCurrentPolicy
    ? validateModelPolicy(migratedModelPolicy.value)
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
    usePriorityServiceTier: typeof value.usePriorityServiceTier === "boolean"
      ? value.usePriorityServiceTier
      : migratedModelPolicy.usedFastTier,
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

function migrateModelPolicyServiceTiers(value: unknown): {
  value: unknown;
  usedFastTier: boolean;
  changed: boolean;
} {
  if (!isRecord(value)) return { value, usedFastTier: false, changed: false };
  let usedFastTier = false;
  let changed = false;
  const withoutTier = (selection: unknown): unknown => {
    if (!isRecord(selection) || !("serviceTier" in selection)) return selection;
    const tier = selection.serviceTier;
    if (typeof tier === "string" && ["priority", "fast"].includes(tier.toLowerCase())) {
      usedFastTier = true;
    }
    const copy = { ...selection };
    delete copy.serviceTier;
    changed = true;
    return copy;
  };
  const migrated: Record<string, unknown> = { ...value };
  if (value.mode === "fixed") {
    migrated.selection = withoutTier(value.selection);
  } else if (value.mode === "automatic") {
    if (value.preferredSelection !== undefined) {
      migrated.preferredSelection = withoutTier(value.preferredSelection);
    }
    if (isRecord(value.allowedSelections) && Array.isArray(value.allowedSelections.selections)) {
      const seen = new Set<string>();
      const selections = value.allowedSelections.selections.flatMap((selection) => {
        const normalized = withoutTier(selection);
        if (!isRecord(normalized)) return [normalized];
        const key = JSON.stringify([normalized.model, normalized.reasoningEffort]);
        if (seen.has(key)) {
          changed = true;
          return [];
        }
        seen.add(key);
        return [normalized];
      });
      migrated.allowedSelections = { ...value.allowedSelections, selections };
    }
  }
  return { value: migrated, usedFastTier, changed };
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
