import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AccessStrategy, BridgeConfig, SandboxMode } from "./config.js";
import { enforceSandbox } from "./config.js";
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
import {
  MAX_REGISTERED_PROJECTS,
  PROJECT_NOT_FOUND,
  ProjectRegistry,
  legacyDefaultProject,
  normalizeProjectId,
  type ProjectTarget
} from "./projectRegistry.js";

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
  usePriorityServiceTier: boolean;
  /** Migration-only compatibility for legacy defaults that selected a model but no effort. */
  legacyPreferredModel?: string;
  projects: ProjectTarget[];
  uiLocalePreference: UiLocalePreference;
  maxConcurrentJobs: number;
  /** Persist bridge-created Codex threads so they appear in the Codex app. */
  showBridgeThreadsInCodexApp: boolean;
  activityCardVisibility: ActivityCardVisibility;
  completionHandoff: CompletionHandoffMode;
};

export type BridgeUserSettingsPatch = Partial<
  Omit<
    BridgeUserSettings,
    "schemaVersion" | "revision" | "updatedAt" | "legacyPreferredModel"
  >
>;

export type ProjectRegistryOperation =
  | { kind: "add"; project: ProjectTarget }
  | { kind: "rename"; projectId: string; label: string }
  | { kind: "relocate"; projectId: string; cwd: string }
  | { kind: "remove"; projectId: string };

type PersistedSettingsState = {
  version: 2;
  settings: BridgeUserSettings;
};

type LoadedSettingsState = {
  settings: BridgeUserSettings;
  legacyDefaultCwd: string | null;
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
  private projectRegistryMigrationPending = false;
  private unavailableProjectIds = new Set<string>();

  constructor(
    private readonly config: BridgeConfig,
    options: UserSettingsStoreOptions = {}
  ) {
    this.stateFile = options.stateFile;
    this.stateStore = options.stateStore;
    this.now = options.now || Date.now;
    // Preserve the former single-root bootstrap only for deployments that
    // still explicitly configure the retired ROOTS compatibility ceiling.
    // The bundled launcher sets no roots, so every normal fresh install starts
    // empty and onboards projects through Settings.
    const legacyBootstrapCwd = config.allowedRoots.length === 1
      ? config.allowedRoots[0]!
      : null;
    const legacyBootstrapRegistry = new ProjectRegistry(
      legacyBootstrapCwd ? [legacyDefaultProject(legacyBootstrapCwd)] : [],
      config.allowedRoots
    );
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
      projects: legacyBootstrapRegistry.projects,
      uiLocalePreference: "auto",
      maxConcurrentJobs: config.maxConcurrentJobs,
      showBridgeThreadsInCodexApp: true,
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

  /** Available and recovery-only projects with their current admission state. */
  get projectRegistry(): ProjectRegistry {
    return new ProjectRegistry(this.settings.projects, this.config.allowedRoots, {
      retainUnavailable: true
    });
  }

  /** Resolve only a registered and currently admissible project. */
  resolveProject(projectId?: string): ProjectTarget {
    return this.projectRegistry.resolve(projectId);
  }

  update(patch: BridgeUserSettingsPatch, expectedRevision: number): BridgeUserSettings {
    this.assertRevision(expectedRevision);
    assertSettingsPatchKeys(patch);
    const candidate: BridgeUserSettings = {
      ...this.settings,
      ...patch,
      revision: this.settings.revision + 1,
      updatedAt: new Date(this.now()).toISOString()
    };
    if (patch.modelPolicy !== undefined) delete candidate.legacyPreferredModel;
    const retainUnavailableProjects = this.reconcileProjectPatch(candidate, patch);
    const validated = this.validate(candidate, { retainUnavailableProjects });
    this.persist(validated);
    this.settings = validated;
    this.refreshProjectAvailability(validated);
    return this.current;
  }

  /**
   * Fail fast before policy validation that may consult an external catalog.
   * The eventual reset/update call repeats this check immediately before
   * persistence so an intervening card save cannot be overwritten.
   */
  assertExpectedRevision(expectedRevision: number): void {
    this.assertRevision(expectedRevision);
  }

  /** Apply an explicit project-registry delta and ordinary settings as one revision. */
  updateWithProjectOperations(
    patch: BridgeUserSettingsPatch,
    operations: readonly ProjectRegistryOperation[],
    expectedRevision: number
  ): BridgeUserSettings {
    this.assertRevision(expectedRevision);
    if (operations.length === 0) return this.update(patch, expectedRevision);
    if (operations.length > MAX_REGISTERED_PROJECTS * 2) {
      throw new Error(
        `PROJECT_OPERATION_LIMIT: At most ${MAX_REGISTERED_PROJECTS * 2} project operations are allowed per save.`
      );
    }

    const projects = this.settings.projects.map((project) => ({ ...project }));
    const operationKindsByProject = new Map<string, Set<ProjectRegistryOperation["kind"]>>();
    for (const operation of operations) {
      const projectId = normalizeProjectId(
        operation.kind === "add" ? operation.project.id : operation.projectId
      );
      const kinds = operationKindsByProject.get(projectId) || new Set();
      if (
        kinds.has(operation.kind) ||
        (
          kinds.size > 0 &&
          (
            kinds.has("add") ||
            kinds.has("remove") ||
            operation.kind === "add" ||
            operation.kind === "remove"
          )
        )
      ) {
        throw new Error(
          `PROJECT_OPERATION_CONFLICT: Conflicting project operations for "${projectId}".`
        );
      }
      kinds.add(operation.kind);
      operationKindsByProject.set(projectId, kinds);
    }

    for (const operation of operations) {
      if (operation.kind === "add") {
        projects.push({ ...operation.project });
        continue;
      }
      const projectId = normalizeProjectId(operation.projectId);
      const index = projects.findIndex((project) => project.id === projectId);
      if (index < 0) {
        throw new Error(`${PROJECT_NOT_FOUND}: Unknown project ID: ${projectId}`);
      }
      if (operation.kind === "remove") {
        projects.splice(index, 1);
      } else if (operation.kind === "rename") {
        projects[index] = { ...projects[index]!, label: operation.label };
      } else {
        projects[index] = { ...projects[index]!, cwd: operation.cwd };
      }
    }

    return this.update({ ...patch, projects }, expectedRevision);
  }

  reset(expectedRevision: number): BridgeUserSettings {
    this.assertRevision(expectedRevision);
    // Restoring defaults applies only to general bridge preferences. Projects
    // are user data: preserve their IDs, labels, paths, order, and availability
    // exactly across the reset.
    const preservedRegistry = new ProjectRegistry(
      this.settings.projects,
      this.config.allowedRoots,
      {
        retainUnavailable: true
      }
    );
    const validated = this.validate({
      ...this.initial,
      projects: preservedRegistry.projects,
      revision: this.settings.revision + 1,
      updatedAt: new Date(this.now()).toISOString()
    }, { retainUnavailableProjects: true });
    this.persist(validated);
    this.settings = validated;
    this.refreshProjectAvailability(validated);
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

  private reconcileProjectPatch(
    candidate: BridgeUserSettings,
    patch: BridgeUserSettingsPatch
  ): boolean {
    const projectsChanged = hasOwn(patch, "projects");

    if (projectsChanged) {
      const registry = new ProjectRegistry(candidate.projects, this.config.allowedRoots, {
        retainUnavailable: false
      });
      candidate.projects = registry.projects;
      return false;
    }
    return true;
  }

  private refreshProjectAvailability(settings: BridgeUserSettings): void {
    const registry = new ProjectRegistry(settings.projects, this.config.allowedRoots, {
      retainUnavailable: true
    });
    this.unavailableProjectIds = new Set(registry.unavailableProjectIds);
  }

  private assertRevision(expectedRevision: number): void {
    if (expectedRevision !== this.settings.revision) {
      throw new Error(`${SETTINGS_REVISION_CONFLICT}: Settings changed after this card was opened.`);
    }
  }

  private validate(
    candidate: BridgeUserSettings,
    options: { retainUnavailableProjects?: boolean } = {}
  ): BridgeUserSettings {
    const projectRegistry = new ProjectRegistry(candidate.projects, this.config.allowedRoots, {
      retainUnavailable: options.retainUnavailableProjects
    });
    candidate.projects = projectRegistry.projects;
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
    if (typeof candidate.showBridgeThreadsInCodexApp !== "boolean") {
      throw new Error("Invalid Codex app thread-visibility preference.");
    }
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
        const loaded = readSettings(
          stored,
          this.stateStore.persistencePath || "state database"
        );
        this.loadCandidate(loaded.settings, { legacyDefaultCwd: loaded.legacyDefaultCwd });
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
    const loaded = readSettings(parsed.settings, this.stateFile);
    this.loadCandidate(loaded.settings, { legacyDefaultCwd: loaded.legacyDefaultCwd });
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
        const loaded = readSettings(parsed.settings, this.stateFile as string);
        this.loadCandidate(loaded.settings, {
          legacyDefaultCwd: loaded.legacyDefaultCwd,
          persistIfUnchanged: true
        });
      }
      this.stateStore?.setMeta(marker, new Date().toISOString());
    });
  }

  private loadCandidate(
    candidate: BridgeUserSettings,
    options: {
      legacyDefaultCwd?: string | null;
      persistIfUnchanged?: boolean;
    } = {}
  ): void {
    const reconciled = { ...candidate };
    const persisted = { ...candidate };
    this.unavailableProjectIds.clear();
    if (reconciled.accessStrategy === "always-full" && !this.config.allowDangerFullAccess) {
      reconciled.accessStrategy = "read-only";
      persisted.accessStrategy = "read-only";
      this.warnings.push(
        "Saved full-access mode was downgraded to read-only because the bridge security policy disables danger-full-access."
      );
    }
    const migratedLegacyProject =
      this.projectRegistryMigrationPending && options.legacyDefaultCwd
        ? legacyDefaultProject(options.legacyDefaultCwd)
        : null;
    const projectRegistry = new ProjectRegistry(
      this.projectRegistryMigrationPending
        ? migratedLegacyProject === null ? [] : [migratedLegacyProject]
        : candidate.projects,
      this.config.allowedRoots,
      { retainUnavailable: true }
    );
    reconciled.projects = projectRegistry.projects;
    persisted.projects = projectRegistry.projects;
    this.unavailableProjectIds = new Set(projectRegistry.unavailableProjectIds);

    for (const entry of projectRegistry.availability) {
      if (entry.available) continue;
      this.warnings.push(
        `PROJECT_UNAVAILABLE: Saved project "${entry.project.id}" folder is unavailable. Its metadata was retained for recovery, but it cannot admit new work.`
      );
    }
    if (reconciled.maxConcurrentJobs > this.config.maxConcurrentJobs) {
      reconciled.maxConcurrentJobs = this.config.maxConcurrentJobs;
      persisted.maxConcurrentJobs = this.config.maxConcurrentJobs;
      this.warnings.push("Saved concurrent-job limit was reduced to the current bridge maximum.");
    }
    const persistentlyChanged =
      this.retiredSettingsMigrationPending ||
      this.projectRegistryMigrationPending ||
      JSON.stringify(persisted) !== JSON.stringify(candidate);
    if (persistentlyChanged) {
      reconciled.revision += 1;
      reconciled.updatedAt = new Date(this.now()).toISOString();
      persisted.revision = reconciled.revision;
      persisted.updatedAt = reconciled.updatedAt;
    }
    this.settings = this.validate(reconciled, { retainUnavailableProjects: true });
    if (persistentlyChanged || options.persistIfUnchanged) {
      this.persist(persisted);
    }
    if (persistentlyChanged) {
      this.retiredSettingsMigrationPending = false;
      this.projectRegistryMigrationPending = false;
    }
  }

  private noteRetiredSettings(value: Record<string, unknown>): void {
    this.projectRegistryMigrationPending =
      !Object.prototype.hasOwnProperty.call(value, "projects");
    const retired = [
      "taskTimeoutMs",
      "defaultSessionMode",
      "autoResumeTtlMs",
      "completionDeliveryMode",
      "defaultModel",
      "defaultReasoningEffort",
      "activityCardView",
      "defaultProjectId",
      "defaultCwd"
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
      "showBridgeThreadsInCodexApp" in value &&
      "activityCardVisibility" in value &&
      "completionHandoff" in value &&
      !this.projectRegistryMigrationPending
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
      ("defaultProjectId" in value || "defaultCwd" in value) &&
      !this.warnings.some((warning) => warning.includes("default project selection"))
    ) {
      this.warnings.push(
        "The saved default project selection was retired. Registered projects were preserved, and new work now requires an explicit project."
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

function readSettings(value: Record<string, unknown>, stateFile: string): LoadedSettingsState {
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
  if (
    value.showBridgeThreadsInCodexApp !== undefined &&
    typeof value.showBridgeThreadsInCodexApp !== "boolean"
  ) {
    throw new Error(`Invalid showBridgeThreadsInCodexApp in bridge settings at ${stateFile}.`);
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
  const projects = value.projects === undefined
    ? []
    : readProjectTargets(value.projects, stateFile);
  if (value.defaultProjectId !== undefined) requiredStringOrNull("defaultProjectId");
  const legacyDefaultCwd = value.defaultCwd === undefined
    ? null
    : requiredStringOrNull("defaultCwd");
  return {
    settings: {
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
      projects,
      uiLocalePreference: isUiLocalePreference(value.uiLocalePreference)
        ? value.uiLocalePreference
        : "auto",
      maxConcurrentJobs: requiredNumber("maxConcurrentJobs"),
      showBridgeThreadsInCodexApp: typeof value.showBridgeThreadsInCodexApp === "boolean"
        ? value.showBridgeThreadsInCodexApp
        : true,
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
    },
    legacyDefaultCwd
  };
}

function cloneSettings(settings: BridgeUserSettings): BridgeUserSettings {
  return {
    ...settings,
    projects: settings.projects.map((project) => ({ ...project })),
    modelPolicy: validateModelPolicy(settings.modelPolicy)
  };
}

function readProjectTargets(value: unknown, stateFile: string): ProjectTarget[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid projects in bridge settings at ${stateFile}.`);
  }
  return value.map((project, index) => {
    if (!isRecord(project)) {
      throw new Error(`Invalid project at index ${index} in bridge settings at ${stateFile}.`);
    }
    if (
      typeof project.id !== "string" ||
      typeof project.label !== "string" ||
      typeof project.cwd !== "string"
    ) {
      throw new Error(`Invalid project at index ${index} in bridge settings at ${stateFile}.`);
    }
    return { id: project.id, label: project.label, cwd: project.cwd };
  });
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

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertSettingsPatchKeys(patch: BridgeUserSettingsPatch): void {
  const allowed = new Set([
    "accessStrategy",
    "modelPolicy",
    "usePriorityServiceTier",
    "projects",
    "uiLocalePreference",
    "maxConcurrentJobs",
    "showBridgeThreadsInCodexApp",
    "activityCardVisibility",
    "completionHandoff"
  ]);
  const unsupported = Object.keys(patch).find((key) => !allowed.has(key));
  if (!unsupported) return;
  if (unsupported === "defaultProjectId" || unsupported === "defaultCwd") {
    throw new Error(
      `SETTINGS_FIELD_RETIRED: ${unsupported} was removed; select an explicit project for each new Activity or fresh Agent context.`
    );
  }
  throw new Error(`SETTINGS_FIELD_UNKNOWN: Unsupported setting: ${unsupported}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
