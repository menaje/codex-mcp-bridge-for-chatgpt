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
  projects: ProjectTarget[];
  defaultProjectId: string | null;
  /** Legacy persistence/UI compatibility mirror for the effective default project. */
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

export type ProjectRegistryOperation =
  | { kind: "add"; project: ProjectTarget }
  | { kind: "rename"; projectId: string; label: string }
  | { kind: "relocate"; projectId: string; cwd: string }
  | { kind: "remove"; projectId: string };

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
  private projectRegistryMigrationPending = false;
  private unavailableDefaultCwd?: string;
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
      config.allowedRoots,
      { defaultProjectId: legacyBootstrapCwd ? "default" : null }
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
      defaultProjectId: legacyBootstrapRegistry.defaultProjectId,
      defaultCwd: legacyBootstrapCwd,
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

  /** Available and recovery-only projects with their current admission state. */
  get projectRegistry(): ProjectRegistry {
    return new ProjectRegistry(this.settings.projects, this.config.allowedRoots, {
      defaultProjectId: this.settings.defaultProjectId,
      retainUnavailable: true
    });
  }

  /** Resolve only a registered and currently admissible project. */
  resolveProject(projectId?: string): ProjectTarget {
    return this.projectRegistry.resolve(projectId);
  }

  update(patch: BridgeUserSettingsPatch, expectedRevision: number): BridgeUserSettings {
    this.assertRevision(expectedRevision);
    if (
      this.unavailableDefaultCwd !== undefined &&
      (!hasOwn(patch, "defaultCwd") || patch.defaultCwd === null) &&
      !hasOwn(patch, "projects") &&
      !hasOwn(patch, "defaultProjectId")
    ) {
      throw new Error(
        `${DEFAULT_CWD_NOT_ALLOWED}: The saved default project folder is unavailable. Update that project folder with this save.`
      );
    }
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
    // are user data: preserve their IDs, labels, paths, order, availability,
    // and selected default exactly across the reset.
    const preservedRegistry = new ProjectRegistry(
      this.settings.projects,
      this.config.allowedRoots,
      {
        defaultProjectId: this.settings.defaultProjectId,
        retainUnavailable: true
      }
    );
    const validated = this.validate({
      ...this.initial,
      projects: preservedRegistry.projects,
      defaultProjectId: preservedRegistry.defaultProjectId,
      defaultCwd: this.settings.defaultCwd,
      revision: this.settings.revision + 1,
      updatedAt: new Date(this.now()).toISOString()
    }, { retainUnavailableProjects: true });
    // Runtime settings hide an unavailable compatibility mirror, while the
    // persisted recovery record retains it exactly as loading does.
    this.persist({
      ...validated,
      defaultCwd: compatibilityDefaultCwd(preservedRegistry)
    });
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

  resolveCwd(): string {
    if (this.unavailableDefaultCwd !== undefined) {
      throw new Error(
        `${DEFAULT_CWD_NOT_ALLOWED}: The saved default project folder is unavailable. Update it in Codex settings before starting a new Activity.`
      );
    }
    if (!this.settings.defaultCwd) {
      throw new Error(
        `${DEFAULT_CWD_REQUIRED}: Register a project folder in Codex settings before starting a new Activity.`
      );
    }
    try {
      return requireAllowedCwd(this.settings.defaultCwd, this.config.allowedRoots);
    } catch {
      throw new Error(
        `${DEFAULT_CWD_NOT_ALLOWED}: The saved default project folder is unavailable. Update it in Codex settings before starting a new Activity.`
      );
    }
  }

  private reconcileProjectPatch(
    candidate: BridgeUserSettings,
    patch: BridgeUserSettingsPatch
  ): boolean {
    const projectsChanged = hasOwn(patch, "projects");
    const defaultProjectChanged = hasOwn(patch, "defaultProjectId");
    const legacyDefaultChanged = hasOwn(patch, "defaultCwd");

    if (projectsChanged || defaultProjectChanged) {
      const registry = new ProjectRegistry(candidate.projects, this.config.allowedRoots, {
        defaultProjectId: candidate.defaultProjectId,
        retainUnavailable: !projectsChanged
      });
      if (defaultProjectChanged && registry.defaultProjectId !== null) {
        registry.resolve(registry.defaultProjectId);
      }
      candidate.projects = registry.projects;
      candidate.defaultProjectId = registry.defaultProjectId;
      candidate.defaultCwd = compatibilityDefaultCwd(registry);
      return !projectsChanged;
    }

    if (!legacyDefaultChanged) return true;
    if (candidate.defaultCwd === null) {
      if (
        candidate.projects.length === 1 &&
        candidate.projects[0]?.id === "default"
      ) {
        candidate.projects = [];
      }
      candidate.defaultProjectId = null;
      return true;
    }

    const canonicalCwd = requireAllowedCwd(candidate.defaultCwd, this.config.allowedRoots);
    const existing = new ProjectRegistry(candidate.projects, this.config.allowedRoots, {
      defaultProjectId: candidate.defaultProjectId,
      retainUnavailable: true
    });
    const matching = existing.availability.find(
      (entry) => entry.available && entry.project.cwd === canonicalCwd
    );
    if (matching) {
      candidate.projects = existing.projects;
      candidate.defaultProjectId = matching.project.id;
      candidate.defaultCwd = canonicalCwd;
      return true;
    }

    const compatibilityProject = legacyDefaultProject(canonicalCwd);
    if (
      existing.projects.length === 0 ||
      (existing.projects.length === 1 && existing.projects[0]?.id === "default")
    ) {
      candidate.projects = [compatibilityProject];
      candidate.defaultProjectId = compatibilityProject.id;
    } else {
      const project = {
        ...compatibilityProject,
        id: availableCompatibilityProjectId(compatibilityProject.label, existing.projects)
      };
      candidate.projects = [...existing.projects, project];
      candidate.defaultProjectId = project.id;
    }
    candidate.defaultCwd = canonicalCwd;
    return true;
  }

  private refreshProjectAvailability(settings: BridgeUserSettings): void {
    const registry = new ProjectRegistry(settings.projects, this.config.allowedRoots, {
      defaultProjectId: settings.defaultProjectId,
      retainUnavailable: true
    });
    this.unavailableProjectIds = new Set(registry.unavailableProjectIds);
    const effectiveDefaultId = registry.effectiveDefaultProjectId;
    if (
      effectiveDefaultId !== null &&
      this.unavailableProjectIds.has(effectiveDefaultId)
    ) {
      this.unavailableDefaultCwd = registry.projects.find(
        (project) => project.id === effectiveDefaultId
      )?.cwd;
    } else {
      this.unavailableDefaultCwd = undefined;
    }
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
      defaultProjectId: candidate.defaultProjectId,
      retainUnavailable: options.retainUnavailableProjects
    });
    candidate.projects = projectRegistry.projects;
    candidate.defaultProjectId = projectRegistry.defaultProjectId;
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
        this.loadCandidate(
          readSettings(parsed.settings, this.stateFile as string),
          { persistIfUnchanged: true }
        );
      }
      this.stateStore?.setMeta(marker, new Date().toISOString());
    });
  }

  private loadCandidate(
    candidate: BridgeUserSettings,
    options: { persistIfUnchanged?: boolean } = {}
  ): void {
    const reconciled = { ...candidate };
    const persisted = { ...candidate };
    this.unavailableDefaultCwd = undefined;
    this.unavailableProjectIds.clear();
    if (reconciled.accessStrategy === "always-full" && !this.config.allowDangerFullAccess) {
      reconciled.accessStrategy = "read-only";
      persisted.accessStrategy = "read-only";
      this.warnings.push(
        "Saved full-access mode was downgraded to read-only because the bridge security policy disables danger-full-access."
      );
    }
    const migratedLegacyProject =
      this.projectRegistryMigrationPending && candidate.defaultCwd !== null
        ? legacyDefaultProject(candidate.defaultCwd)
        : null;
    const projectRegistry = new ProjectRegistry(
      this.projectRegistryMigrationPending
        ? migratedLegacyProject === null ? [] : [migratedLegacyProject]
        : candidate.projects,
      this.config.allowedRoots,
      {
        defaultProjectId: this.projectRegistryMigrationPending
          ? migratedLegacyProject === null ? null : migratedLegacyProject.id
          : candidate.defaultProjectId,
        retainUnavailable: true
      }
    );
    reconciled.projects = projectRegistry.projects;
    reconciled.defaultProjectId = projectRegistry.defaultProjectId;
    persisted.projects = projectRegistry.projects;
    persisted.defaultProjectId = projectRegistry.defaultProjectId;
    this.unavailableProjectIds = new Set(projectRegistry.unavailableProjectIds);

    const effectiveDefaultId = projectRegistry.effectiveDefaultProjectId;
    const effectiveDefault = effectiveDefaultId === null
      ? undefined
      : projectRegistry.availability.find(
          ({ project }) => project.id === effectiveDefaultId
        );
    if (effectiveDefault === undefined) {
      reconciled.defaultCwd = null;
      persisted.defaultCwd = null;
    } else if (effectiveDefault.available) {
      reconciled.defaultCwd = effectiveDefault.project.cwd;
      persisted.defaultCwd = effectiveDefault.project.cwd;
    } else {
      this.unavailableDefaultCwd = effectiveDefault.project.cwd;
      reconciled.defaultCwd = null;
      persisted.defaultCwd = effectiveDefault.project.cwd;
      this.warnings.push(
        `${DEFAULT_CWD_NOT_ALLOWED}: The saved default project folder is unavailable. Update it in Codex settings before starting a new Activity.`
      );
    }
    for (const entry of projectRegistry.availability) {
      if (entry.available || entry.project.id === effectiveDefaultId) continue;
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
      // Preserve an unavailable saved path verbatim while persisting independent
      // capability/retired-field reconciliation. It becomes usable again when
      // the operator restores the corresponding allowed root.
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
      "completionHandoff" in value &&
      "defaultProjectId" in value &&
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
  const projects = value.projects === undefined
    ? []
    : readProjectTargets(value.projects, stateFile);
  const defaultProjectId = value.defaultProjectId === undefined
    ? null
    : requiredStringOrNull("defaultProjectId");
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
    projects,
    defaultProjectId,
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

function compatibilityDefaultCwd(registry: ProjectRegistry): string | null {
  const effectiveDefaultId = registry.effectiveDefaultProjectId;
  if (effectiveDefaultId === null) return null;
  return registry.projects.find((project) => project.id === effectiveDefaultId)?.cwd || null;
}

function availableCompatibilityProjectId(
  label: string,
  existingProjects: readonly ProjectTarget[]
): string {
  let base: string;
  try {
    base = normalizeProjectId(label);
  } catch {
    base = "project";
  }
  const existingIds = new Set(existingProjects.map((project) => project.id));
  if (!existingIds.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const suffixText = `-${suffix}`;
    const truncatedBase = base.slice(0, 64 - suffixText.length).replace(/-+$/g, "") || "project";
    const candidate = `${truncatedBase}${suffixText}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a compatibility project ID.");
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
