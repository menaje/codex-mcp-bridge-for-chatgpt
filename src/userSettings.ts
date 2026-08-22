import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AccessStrategy, BridgeConfig, DefaultSessionMode, SandboxMode } from "./config.js";
import { enforceSandbox, requireAllowedCwd } from "./config.js";
import type { BridgeStateStore } from "./stateStore.js";

export const MIN_AUTO_RESUME_TTL_MS = 60 * 1000;
export const MAX_AUTO_RESUME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_TASK_TIMEOUT_MS = 1000;

export type BridgeUserSettings = {
  revision: number;
  updatedAt: string | null;
  accessStrategy: AccessStrategy;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  defaultCwd: string | null;
  defaultSessionMode: DefaultSessionMode;
  autoResumeTtlMs: number;
  taskTimeoutMs: number;
  maxConcurrentJobs: number;
};

export type BridgeUserSettingsPatch = Partial<
  Omit<BridgeUserSettings, "revision" | "updatedAt">
>;

type PersistedSettingsState = {
  version: 1;
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

  constructor(
    private readonly config: BridgeConfig,
    options: UserSettingsStoreOptions = {}
  ) {
    this.stateFile = options.stateFile;
    this.stateStore = options.stateStore;
    this.now = options.now || Date.now;
    this.initial = this.validate({
      revision: 0,
      updatedAt: null,
      accessStrategy: config.defaultAccessStrategy,
      defaultModel: config.defaultModel || null,
      defaultReasoningEffort: config.defaultReasoningEffort || null,
      defaultCwd: config.allowedRoots.length === 1 ? config.allowedRoots[0] : null,
      defaultSessionMode: config.defaultSessionMode,
      autoResumeTtlMs: config.autoResumeTtlMs,
      taskTimeoutMs: config.upstreamTimeoutMs,
      maxConcurrentJobs: config.maxConcurrentJobs
    });
    this.settings = { ...this.initial };
    this.load();
  }

  get persistent(): boolean {
    return Boolean(this.stateStore?.persistent || this.stateFile);
  }

  get persistencePath(): string | null {
    return this.stateStore?.persistencePath || this.stateFile || null;
  }

  get current(): BridgeUserSettings {
    return { ...this.settings };
  }

  get defaults(): BridgeUserSettings {
    return { ...this.initial };
  }

  get loadWarnings(): string[] {
    return [...this.warnings];
  }

  get maxAutoResumeTtlMs(): number {
    return Math.max(MAX_AUTO_RESUME_TTL_MS, this.config.autoResumeTtlMs);
  }

  update(patch: BridgeUserSettingsPatch, expectedRevision?: number): BridgeUserSettings {
    this.assertRevision(expectedRevision);
    const candidate: BridgeUserSettings = {
      ...this.settings,
      ...patch,
      revision: this.settings.revision + 1,
      updatedAt: new Date(this.now()).toISOString()
    };
    if (patch.defaultModel === null && patch.defaultReasoningEffort === undefined) {
      candidate.defaultReasoningEffort = null;
    }
    const validated = this.validate(candidate);
    this.persist(validated);
    this.settings = validated;
    return this.current;
  }

  reset(expectedRevision?: number): BridgeUserSettings {
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

  private assertRevision(expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && expectedRevision !== this.settings.revision) {
      throw new Error(
        `Settings changed after this card was opened (expected revision ${expectedRevision}, current ${this.settings.revision}). Refresh the settings card and try again.`
      );
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
      throw new Error("always-full is unavailable because the bridge owner disabled danger-full-access.");
    }
    if (candidate.defaultCwd !== null) {
      candidate.defaultCwd = requireAllowedCwd(candidate.defaultCwd, this.config.allowedRoots);
    }
    validateOptionalIdentifier(candidate.defaultModel, "default model", 200);
    validateOptionalIdentifier(candidate.defaultReasoningEffort, "default reasoning effort", 100);
    if (!candidate.defaultModel && candidate.defaultReasoningEffort) {
      throw new Error("A default reasoning effort requires a default model.");
    }
    if (candidate.defaultSessionMode !== "auto" && candidate.defaultSessionMode !== "new") {
      throw new Error(`Invalid default session mode: ${String(candidate.defaultSessionMode)}`);
    }
    validateIntegerRange(
      candidate.autoResumeTtlMs,
      MIN_AUTO_RESUME_TTL_MS,
      this.maxAutoResumeTtlMs,
      "Auto-resume window"
    );
    validateIntegerRange(
      candidate.taskTimeoutMs,
      MIN_TASK_TIMEOUT_MS,
      this.config.upstreamTimeoutMs,
      "Task timeout"
    );
    validateIntegerRange(candidate.maxConcurrentJobs, 1, this.config.maxConcurrentJobs, "Concurrent job limit", "jobs");
    if (!Number.isInteger(candidate.revision) || candidate.revision < 0) {
      throw new Error("Invalid settings revision.");
    }
    if (candidate.updatedAt !== null && !Number.isFinite(Date.parse(candidate.updatedAt))) {
      throw new Error("Invalid settings update timestamp.");
    }
    return { ...candidate };
  }

  private load(): void {
    if (this.stateStore) {
      const stored = this.stateStore.getSettings();
      if (stored !== undefined) {
        if (!isRecord(stored)) throw new Error("Invalid bridge settings in the state database.");
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
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.settings)) {
      throw new Error(`Invalid bridge settings format at ${this.stateFile}.`);
    }
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
        if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.settings)) {
          throw new Error(`Invalid bridge settings format at ${this.stateFile}.`);
        }
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
        "Saved full-access mode was downgraded to read-only because the bridge owner disabled danger-full-access."
      );
    }
    if (reconciled.defaultCwd !== null) {
      try {
        reconciled.defaultCwd = requireAllowedCwd(reconciled.defaultCwd, this.config.allowedRoots);
      } catch {
        reconciled.defaultCwd = this.config.allowedRoots.length === 1 ? this.config.allowedRoots[0] : null;
        this.warnings.push(
          "Saved working directory was outside the current owner allowlist and was replaced with a safe allowed default."
        );
      }
    }
    if (reconciled.taskTimeoutMs > this.config.upstreamTimeoutMs) {
      reconciled.taskTimeoutMs = this.config.upstreamTimeoutMs;
      this.warnings.push("Saved task timeout was reduced to the current owner maximum.");
    }
    if (reconciled.maxConcurrentJobs > this.config.maxConcurrentJobs) {
      reconciled.maxConcurrentJobs = this.config.maxConcurrentJobs;
      this.warnings.push("Saved concurrent-job limit was reduced to the current owner maximum.");
    }
    const changed = JSON.stringify(reconciled) !== JSON.stringify(candidate);
    if (changed) {
      reconciled.revision += 1;
      reconciled.updatedAt = new Date(this.now()).toISOString();
    }
    this.settings = this.validate(reconciled);
    if (changed) this.persist(this.settings);
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
      version: 1,
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
  const defaultSessionMode = value.defaultSessionMode;
  const updatedAt = requiredStringOrNull("updatedAt");
  return {
    revision: requiredNumber("revision"),
    updatedAt,
    accessStrategy: accessStrategy as AccessStrategy,
    defaultModel: requiredStringOrNull("defaultModel"),
    defaultReasoningEffort: requiredStringOrNull("defaultReasoningEffort"),
    defaultCwd: requiredStringOrNull("defaultCwd"),
    defaultSessionMode: defaultSessionMode as DefaultSessionMode,
    autoResumeTtlMs: requiredNumber("autoResumeTtlMs"),
    taskTimeoutMs: requiredNumber("taskTimeoutMs"),
    maxConcurrentJobs: requiredNumber("maxConcurrentJobs")
  };
}

function validateOptionalIdentifier(value: string | null, label: string, maxLength: number): void {
  if (value === null) return;
  if (!value.trim() || value.length > maxLength || /[\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
