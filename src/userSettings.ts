import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AccessStrategy, BridgeConfig, SandboxMode } from "./config.js";
import { enforceSandbox } from "./config.js";
import { BridgeStateStore } from "./stateStore.js";
import {
  MODEL_POLICY_SCHEMA_VERSION,
  automaticModelPolicy,
  validateModelPolicy,
  type ModelPolicy
} from "./modelPolicy.js";
import { isUiLocalePreference, type UiLocalePreference } from "./uiI18n.js";
import {
  MAX_REGISTERED_PROJECTS,
  PROJECT_REQUIRED,
  ProjectRegistry,
  normalizeProjectId,
  normalizeProjectName,
  projectNameKey,
  type ProjectRegistryOperation,
  type ProjectRegistrySnapshot,
  type ProjectSelection,
  type ProjectTarget
} from "./projectRegistry.js";

export type { ProjectRegistryOperation } from "./projectRegistry.js";

export const ACTIVITY_CARD_VISIBILITIES = ["always", "background-only", "never"] as const;
export type ActivityCardVisibility = (typeof ACTIVITY_CARD_VISIBILITIES)[number];
export const COMPLETION_HANDOFF_MODES = ["off", "auto-handoff"] as const;
export type CompletionHandoffMode = (typeof COMPLETION_HANDOFF_MODES)[number];
export const SETTINGS_REVISION_CONFLICT = "SETTINGS_REVISION_CONFLICT";

export type BridgeUserSettings = {
  schemaVersion: typeof MODEL_POLICY_SCHEMA_VERSION;
  settingsRevision: number;
  registryRevision: number;
  /** Internal compatibility spelling used by model-policy code. */
  revision: number;
  updatedAt: string | null;
  accessStrategy: AccessStrategy;
  modelPolicy: ModelPolicy;
  usePriorityServiceTier: boolean;
  /** Migration-only compatibility for legacy model-only preferences. */
  legacyPreferredModel?: string;
  /** App-private composed registry view. UUID/cwd are stripped from public results. */
  projects: ProjectTarget[];
  uiLocalePreference: UiLocalePreference;
  maxConcurrentJobs: number;
  showBridgeThreadsInCodexApp: boolean;
  activityCardVisibility: ActivityCardVisibility;
  completionHandoff: CompletionHandoffMode;
};

export type BridgeUserSettingsPatch = Partial<
  Omit<
    BridgeUserSettings,
    | "schemaVersion"
    | "settingsRevision"
    | "registryRevision"
    | "revision"
    | "updatedAt"
    | "legacyPreferredModel"
    | "projects"
  >
> & {
  /** Internal compatibility surface; public settings mutations use operations. */
  projects?: Array<Partial<ProjectTarget> & { cwd: string; name?: string; label?: string }>;
};

type GeneralSettings = Omit<
  BridgeUserSettings,
  "registryRevision" | "revision" | "projects"
>;

type PersistedSettingsState = {
  version: 3;
  settings: GeneralSettings;
  projectRegistry: ProjectRegistrySnapshot;
};

export type UserSettingsStoreOptions = {
  stateFile?: string;
  stateStore?: BridgeStateStore;
  now?: () => number;
};

export class UserSettingsStore {
  private readonly stateFile?: string;
  private readonly stateStore: BridgeStateStore;
  private readonly suppliedStateStore: boolean;
  private readonly now: () => number;
  private readonly initial: GeneralSettings;
  private settings: GeneralSettings;
  private readonly warnings: string[] = [];

  constructor(
    private readonly config: BridgeConfig,
    options: UserSettingsStoreOptions = {}
  ) {
    this.stateFile = options.stateFile;
    this.suppliedStateStore = Boolean(options.stateStore);
    this.stateStore = options.stateStore || new BridgeStateStore({ file: ":memory:" });
    this.now = options.now || Date.now;
    this.initial = this.validateGeneral({
      schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
      settingsRevision: 0,
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
      uiLocalePreference: "auto",
      maxConcurrentJobs: config.maxConcurrentJobs,
      showBridgeThreadsInCodexApp: false,
      activityCardVisibility: "always",
      completionHandoff: "off"
    });
    this.settings = cloneGeneralSettings(this.initial);
    this.load();
    this.noteUnavailableProjects();
  }

  get persistent(): boolean {
    return Boolean(this.stateStore.persistent || this.stateFile);
  }

  get persistencePath(): string | null {
    return this.stateStore.persistent ? this.stateStore.persistencePath : this.stateFile || null;
  }

  /** Internal composition hook: admission participants must share this DB. */
  get admissionStateStore(): BridgeStateStore {
    return this.stateStore;
  }

  get current(): BridgeUserSettings {
    const registry = this.stateStore.getProjectRegistrySnapshot();
    return composeSettings(this.settings, registry);
  }

  get defaults(): BridgeUserSettings {
    return composeSettings(this.initial, this.stateStore.getProjectRegistrySnapshot());
  }

  get loadWarnings(): string[] {
    return [...this.warnings];
  }

  get projectRegistry(): ProjectRegistry {
    const snapshot = this.stateStore.getProjectRegistrySnapshot();
    return new ProjectRegistry(
      snapshot.projects,
      this.config.allowedRoots,
      snapshot.registryRevision,
      { retainUnavailable: true }
    );
  }

  /** Runtime name+generation resolution. There is no ID, slug, alias, or default fallback. */
  resolveProject(selection?: ProjectSelection): ProjectTarget {
    if (!selection) return this.projectRegistry.resolve();
    return this.stateStore.resolveProjectSelection(selection, this.config.allowedRoots);
  }

  update(patch: BridgeUserSettingsPatch, expectedRevision: number): BridgeUserSettings {
    assertSettingsPatchKeys(patch);
    const projectReplacement = patch.projects;
    const generalPatch = { ...patch } as BridgeUserSettingsPatch;
    delete generalPatch.projects;
    const operations = projectReplacement
      ? this.operationsForProjectReplacement(projectReplacement)
      : [];
    return this.applyConfiguration(
      generalPatch,
      operations,
      Object.keys(generalPatch).length > 0 ? expectedRevision : undefined,
      operations.length > 0 ? this.current.registryRevision : undefined
    );
  }

  assertExpectedRevision(expectedRevision: number): void {
    this.stateStore.assertSettingsRevision(expectedRevision);
  }

  assertExpectedRegistryRevision(expectedRevision: number): void {
    this.stateStore.assertProjectRegistryRevision(expectedRevision);
  }

  updateWithProjectOperations(
    patch: BridgeUserSettingsPatch,
    operations: readonly ProjectRegistryOperation[],
    expectedSettingsRevision: number | undefined,
    expectedRegistryRevision = this.current.registryRevision
  ): BridgeUserSettings {
    assertSettingsPatchKeys(patch);
    if (patch.projects !== undefined) {
      throw new Error("SETTINGS_FIELD_RETIRED: Use explicit project registry operations.");
    }
    return this.applyConfiguration(
      patch,
      operations,
      Object.keys(patch).length > 0 ? expectedSettingsRevision : undefined,
      operations.length > 0 ? expectedRegistryRevision : undefined
    );
  }

  reset(expectedSettingsRevision: number): BridgeUserSettings {
    const patch: BridgeUserSettingsPatch = {
      accessStrategy: this.initial.accessStrategy,
      modelPolicy: this.initial.modelPolicy,
      usePriorityServiceTier: this.initial.usePriorityServiceTier,
      uiLocalePreference: this.initial.uiLocalePreference,
      maxConcurrentJobs: this.initial.maxConcurrentJobs,
      showBridgeThreadsInCodexApp: this.initial.showBridgeThreadsInCodexApp,
      activityCardVisibility: this.initial.activityCardVisibility,
      completionHandoff: this.initial.completionHandoff
    };
    return this.applyConfiguration(patch, [], expectedSettingsRevision, undefined);
  }

  resolveSandbox(requested?: SandboxMode): SandboxMode {
    if (this.settings.accessStrategy === "read-only") return "read-only";
    if (this.settings.accessStrategy === "always-full") {
      return enforceSandbox(this.config, "danger-full-access");
    }
    return enforceSandbox(this.config, requested);
  }

  /** Keep registry verification and Activity/Agent/Job admission in one sync boundary. */
  admissionTransaction<T>(operation: () => T): T {
    return this.stateStore.transaction(operation);
  }

  private applyConfiguration(
    patch: BridgeUserSettingsPatch,
    operations: readonly ProjectRegistryOperation[],
    expectedSettingsRevision: number | undefined,
    expectedRegistryRevision: number | undefined
  ): BridgeUserSettings {
    if (operations.length > MAX_REGISTERED_PROJECTS * 2) {
      throw new Error(
        `PROJECT_OPERATION_LIMIT: At most ${MAX_REGISTERED_PROJECTS * 2} project operations are allowed per save.`
      );
    }
    const hasGeneralPatch = Object.keys(patch).length > 0;
    if (hasGeneralPatch && expectedSettingsRevision === undefined) {
      throw new Error(`${SETTINGS_REVISION_CONFLICT}: expectedSettingsRevision is required.`);
    }
    if (operations.length > 0 && expectedRegistryRevision === undefined) {
      throw new Error("PROJECT_REGISTRY_REVISION_CONFLICT: expectedRegistryRevision is required.");
    }

    const candidate = this.validateGeneral({
      ...this.settings,
      ...patch,
      settingsRevision: this.settings.settingsRevision,
      updatedAt: this.settings.updatedAt
    } as GeneralSettings);
    if (patch.modelPolicy !== undefined) delete candidate.legacyPreferredModel;
    const generalChanged = hasGeneralPatch &&
      canonicalGeneralSettings(candidate) !== canonicalGeneralSettings(this.settings);
    const now = this.now();
    let committedSettings = this.settings;

    this.stateStore.transaction(() => {
      if (hasGeneralPatch) {
        this.stateStore.assertSettingsRevision(expectedSettingsRevision as number);
      }
      if (operations.length > 0) {
        this.stateStore.assertProjectRegistryRevision(expectedRegistryRevision as number);
      }
      if (generalChanged) {
        const persisted = {
          ...candidate,
          settingsRevision: (expectedSettingsRevision as number) + 1,
          updatedAt: new Date(now).toISOString()
        };
        this.stateStore.writeSettings(
          persisted,
          expectedSettingsRevision as number,
          now
        );
        committedSettings = this.validateGeneral(persisted);
      }
      if (operations.length > 0) {
        this.stateStore.applyProjectOperations(
          operations,
          expectedRegistryRevision as number,
          this.config.allowedRoots,
          now
        );
      }
    });

    this.settings = committedSettings;
    this.persistStandaloneState();
    return this.current;
  }

  private operationsForProjectReplacement(
    desired: Array<Partial<ProjectTarget> & { cwd: string; name?: string; label?: string }>
  ): ProjectRegistryOperation[] {
    const active = this.current.projects.filter((project) => project.archivedAt === undefined);
    const matched = new Set<string>();
    const operations: ProjectRegistryOperation[] = [];
    for (const input of desired) {
      const name = normalizeProjectName(input.name ?? input.label ?? "");
      const key = projectNameKey(name);
      let existing: ProjectTarget | undefined;
      if (typeof input.id === "string") {
        try {
          const id = normalizeProjectId(input.id);
          existing = active.find((project) => project.id === id);
        } catch {
          // Legacy caller-supplied slugs are not identities in the new model.
        }
      }
      existing ||= active.find((project) => project.nameKey === key && !matched.has(project.id));
      if (!existing) {
        operations.push({ kind: "add", project: { name, cwd: input.cwd } });
        continue;
      }
      matched.add(existing.id);
      if (existing.name !== name) {
        operations.push({ kind: "rename", projectId: existing.id, name });
      }
      if (existing.cwd !== input.cwd) {
        operations.push({ kind: "relocate", projectId: existing.id, cwd: input.cwd });
      }
    }
    for (const project of active) {
      if (!matched.has(project.id)) operations.push({ kind: "archive", projectId: project.id });
    }
    return operations;
  }

  private validateGeneral(candidate: GeneralSettings): GeneralSettings {
    if (
      candidate.accessStrategy !== "read-only" &&
      candidate.accessStrategy !== "adaptive" &&
      candidate.accessStrategy !== "always-full"
    ) {
      throw new Error(`Invalid access strategy: ${String(candidate.accessStrategy)}`);
    }
    if (candidate.accessStrategy === "always-full" && !this.config.allowDangerFullAccess) {
      throw new Error(
        "always-full is unavailable because the bridge security policy disables danger-full-access."
      );
    }
    if (candidate.schemaVersion !== MODEL_POLICY_SCHEMA_VERSION) {
      throw new Error("Invalid settings schema version.");
    }
    if (candidate.legacyPreferredModel !== undefined) {
      validateIdentifier(candidate.legacyPreferredModel, "legacy preferred model", 200);
      if (
        candidate.modelPolicy.mode !== "automatic" ||
        candidate.modelPolicy.fallbackSelection !== undefined
      ) {
        throw new Error(
          "A legacy model-only preference is valid only for an automatic policy without an exact configured fallback."
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
    validateIntegerRange(
      candidate.maxConcurrentJobs,
      1,
      this.config.maxConcurrentJobs,
      "Concurrent job limit",
      "jobs"
    );
    if (typeof candidate.showBridgeThreadsInCodexApp !== "boolean") {
      throw new Error("Invalid Codex app thread-visibility preference.");
    }
    if (!ACTIVITY_CARD_VISIBILITIES.includes(candidate.activityCardVisibility)) {
      throw new Error(`Invalid Activity card visibility: ${String(candidate.activityCardVisibility)}`);
    }
    if (!COMPLETION_HANDOFF_MODES.includes(candidate.completionHandoff)) {
      throw new Error(`Invalid completion handoff mode: ${String(candidate.completionHandoff)}`);
    }
    if (
      candidate.activityCardVisibility === "never" &&
      candidate.completionHandoff === "auto-handoff"
    ) {
      throw new Error("Automatic GPT handoff requires the Activity card to be visible.");
    }
    if (!Number.isInteger(candidate.settingsRevision) || candidate.settingsRevision < 0) {
      throw new Error("Invalid settings revision.");
    }
    if (candidate.updatedAt !== null && !Number.isFinite(Date.parse(candidate.updatedAt))) {
      throw new Error("Invalid settings update timestamp.");
    }
    return cloneGeneralSettings(candidate);
  }

  private load(): void {
    const stored = this.stateStore.getSettingsRecord();
    if (stored) {
      const source = isRecord(stored.payload) ? stored.payload : undefined;
      if (!source) throw new Error("Invalid bridge settings in the state database.");
      if (isRecord(stored.payload) && "projects" in stored.payload) {
        this.warnings.push(
          "Legacy project IDs/default aliases were intentionally not migrated. Register projects by name in Settings."
        );
      }
      const loaded = this.reconcileLoadedGeneral(
        source,
        "state database",
        stored.settingsRevision
      );
      if (loaded.changed) {
        this.stateStore.writeSettings(
          loaded.settings,
          stored.settingsRevision,
          Date.parse(loaded.settings.updatedAt as string)
        );
      }
      this.settings = loaded.settings;
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
    if (!isRecord(parsed) || !isRecord(parsed.settings)) {
      throw new Error(`Invalid bridge settings format at ${this.stateFile}.`);
    }
    const settingsRevision = Number.isInteger(parsed.settings.settingsRevision)
      ? Number(parsed.settings.settingsRevision)
      : Number.isInteger(parsed.settings.revision)
        ? Number(parsed.settings.revision)
        : 0;
    const loaded = this.reconcileLoadedGeneral(
      parsed.settings,
      this.stateFile,
      settingsRevision
    );
    this.settings = loaded.settings;
    this.stateStore.setSettings(this.settings);
    if (parsed.version === 3 && isRecord(parsed.projectRegistry)) {
      this.stateStore.importProjectRegistry(readProjectRegistrySnapshot(parsed.projectRegistry));
    } else if ("projects" in parsed.settings) {
      this.warnings.push(
        "Legacy project IDs/default aliases were intentionally not migrated. Register projects by name in Settings."
      );
    }
    if (loaded.changed) this.persistStandaloneState();
  }

  private reconcileLoadedGeneral(
    source: Record<string, unknown>,
    sourceLabel: string,
    settingsRevision: number
  ): { settings: GeneralSettings; changed: boolean } {
    const candidate = readGeneralSettings(source, sourceLabel, settingsRevision);
    let changed = needsGeneralSettingsRewrite(source);
    if (candidate.accessStrategy === "always-full" && !this.config.allowDangerFullAccess) {
      candidate.accessStrategy = "read-only";
      changed = true;
      this.warnings.push(
        "Saved full-access mode was downgraded to read-only because the bridge security policy disables danger-full-access."
      );
    }
    if (candidate.maxConcurrentJobs > this.config.maxConcurrentJobs) {
      candidate.maxConcurrentJobs = this.config.maxConcurrentJobs;
      changed = true;
      this.warnings.push("Saved concurrent-job limit was reduced to the current bridge maximum.");
    }
    if (changed) {
      candidate.settingsRevision = settingsRevision + 1;
      candidate.updatedAt = new Date(this.now()).toISOString();
    }
    return { settings: this.validateGeneral(candidate), changed };
  }

  private noteUnavailableProjects(): void {
    for (const entry of this.projectRegistry.availability) {
      if (entry.project.archivedAt !== undefined || entry.available) continue;
      this.warnings.push(
        `PROJECT_UNAVAILABLE: Saved project "${entry.project.name}" is unavailable and cannot admit new work.`
      );
    }
  }

  private persistStandaloneState(): void {
    if (this.suppliedStateStore || !this.stateFile) return;
    const directory = path.dirname(this.stateFile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    const state: PersistedSettingsState = {
      version: 3,
      settings: cloneGeneralSettings(this.settings),
      projectRegistry: this.stateStore.getProjectRegistrySnapshot()
    };
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    renameSync(temporary, this.stateFile);
    chmodSync(this.stateFile, 0o600);
  }
}

function composeSettings(
  settings: GeneralSettings,
  registry: ProjectRegistrySnapshot
): BridgeUserSettings {
  return {
    ...cloneGeneralSettings(settings),
    registryRevision: registry.registryRevision,
    revision: settings.settingsRevision,
    projects: registry.projects.map((project) => ({ ...project }))
  };
}

function cloneGeneralSettings(settings: GeneralSettings): GeneralSettings {
  return {
    ...settings,
    modelPolicy: validateModelPolicy(settings.modelPolicy)
  };
}

function canonicalGeneralSettings(settings: GeneralSettings): string {
  const { settingsRevision: _revision, updatedAt: _updatedAt, ...semantic } = settings;
  return JSON.stringify(semantic);
}

function needsGeneralSettingsRewrite(value: Record<string, unknown>): boolean {
  const required = [
    "schemaVersion",
    "settingsRevision",
    "updatedAt",
    "accessStrategy",
    "modelPolicy",
    "usePriorityServiceTier",
    "uiLocalePreference",
    "maxConcurrentJobs",
    "showBridgeThreadsInCodexApp",
    "activityCardVisibility",
    "completionHandoff"
  ];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return true;
  if (value.schemaVersion !== MODEL_POLICY_SCHEMA_VERSION) return true;
  if (
    [
      "revision",
      "projects",
      "defaultProjectId",
      "defaultCwd",
      "defaultModel",
      "defaultReasoningEffort",
      "completionDeliveryMode",
      "activityCardView",
      "taskTimeoutMs",
      "defaultSessionMode",
      "autoResumeTtlMs"
    ].some((key) => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    return true;
  }
  const migrated = migrateModelPolicyServiceTiers(value.modelPolicy);
  return JSON.stringify(migrated.value) !== JSON.stringify(value.modelPolicy);
}

function readGeneralSettings(
  value: unknown,
  source: string,
  settingsRevision: number
): GeneralSettings {
  if (!isRecord(value)) throw new Error(`Invalid bridge settings at ${source}.`);
  const accessStrategy = value.accessStrategy as AccessStrategy;
  const migratedPolicy = migrateModelPolicyServiceTiers(value.modelPolicy);
  const legacyModel = typeof value.defaultModel === "string" ? value.defaultModel : undefined;
  const legacyEffort = typeof value.defaultReasoningEffort === "string"
    ? value.defaultReasoningEffort
    : undefined;
  const hasMigratablePolicy =
    (value.schemaVersion === MODEL_POLICY_SCHEMA_VERSION || value.schemaVersion === 2) &&
    value.modelPolicy;
  const modelPolicy = hasMigratablePolicy
    ? validateModelPolicy(migratedPolicy.value)
    : automaticModelPolicy(
        legacyModel && legacyEffort
          ? { model: legacyModel, reasoningEffort: legacyEffort }
          : undefined
      );
  const updatedAt = value.updatedAt === null || typeof value.updatedAt === "string"
    ? value.updatedAt
    : null;
  const maxConcurrentJobs = typeof value.maxConcurrentJobs === "number"
    ? value.maxConcurrentJobs
    : 1;
  const persistedLegacyPreferredModel = typeof value.legacyPreferredModel === "string"
    ? value.legacyPreferredModel
    : undefined;
  return {
    schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
    settingsRevision,
    updatedAt,
    accessStrategy,
    modelPolicy,
    usePriorityServiceTier: typeof value.usePriorityServiceTier === "boolean"
      ? value.usePriorityServiceTier
      : migratedPolicy.usedFastTier,
    ...(persistedLegacyPreferredModel || (legacyModel && !legacyEffort)
      ? { legacyPreferredModel: persistedLegacyPreferredModel || legacyModel }
      : {}),
    uiLocalePreference: isUiLocalePreference(value.uiLocalePreference)
      ? value.uiLocalePreference
      : "auto",
    maxConcurrentJobs,
    showBridgeThreadsInCodexApp: typeof value.showBridgeThreadsInCodexApp === "boolean"
      ? value.showBridgeThreadsInCodexApp
      : false,
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

function readProjectRegistrySnapshot(value: Record<string, unknown>): ProjectRegistrySnapshot {
  if (
    !Number.isInteger(value.registryRevision) ||
    typeof value.updatedAt !== "number" ||
    !Array.isArray(value.projects)
  ) {
    throw new Error("Invalid project registry state.");
  }
  return {
    registryRevision: Number(value.registryRevision),
    updatedAt: value.updatedAt,
    projects: value.projects.map((entry) => {
      if (!isRecord(entry)) throw new Error("Invalid project registry entry.");
      if (
        typeof entry.id !== "string" ||
        typeof entry.name !== "string" ||
        typeof entry.nameKey !== "string" ||
        typeof entry.cwd !== "string" ||
        typeof entry.sortOrder !== "number" ||
        typeof entry.createdAt !== "number" ||
        typeof entry.updatedAt !== "number"
      ) {
        throw new Error("Invalid project registry entry.");
      }
      const name = normalizeProjectName(entry.name);
      const target: ProjectTarget = {
        id: normalizeProjectId(entry.id),
        name,
        label: name,
        nameKey: projectNameKey(name),
        cwd: entry.cwd,
        sortOrder: entry.sortOrder,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        ...(typeof entry.archivedAt === "number" ? { archivedAt: entry.archivedAt } : {})
      };
      return target;
    })
  };
}

function migrateModelPolicyServiceTiers(value: unknown): {
  value: unknown;
  usedFastTier: boolean;
} {
  if (!isRecord(value)) return { value, usedFastTier: false };
  let usedFastTier = false;
  const withoutTier = (selection: unknown): unknown => {
    if (!isRecord(selection) || !("serviceTier" in selection)) return selection;
    const tier = selection.serviceTier;
    if (typeof tier === "string" && ["priority", "fast"].includes(tier.toLowerCase())) {
      usedFastTier = true;
    }
    const copy = { ...selection };
    delete copy.serviceTier;
    return copy;
  };
  const migrated: Record<string, unknown> = { ...value };
  if (value.mode === "fixed") {
    migrated.selection = withoutTier(value.selection);
  } else if (value.mode === "automatic") {
    const fallbackSelection = value.fallbackSelection ?? value.preferredSelection;
    if (fallbackSelection !== undefined) {
      migrated.fallbackSelection = withoutTier(fallbackSelection);
    }
    delete migrated.preferredSelection;
    if (isRecord(value.allowedSelections) && Array.isArray(value.allowedSelections.selections)) {
      const seen = new Set<string>();
      migrated.allowedSelections = {
        ...value.allowedSelections,
        selections: value.allowedSelections.selections.flatMap((selection) => {
          const normalized = withoutTier(selection);
          if (!isRecord(normalized)) return [normalized];
          const key = JSON.stringify([normalized.model, normalized.reasoningEffort]);
          if (seen.has(key)) return [];
          seen.add(key);
          return [normalized];
        })
      };
    }
  }
  return { value: migrated, usedFastTier };
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
  if (!value.trim() || value !== value.trim() || value.length > maximum || /[\r\n]/u.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
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
  if (
    unsupported === "defaultProjectId" ||
    unsupported === "defaultCwd" ||
    unsupported === "projectId"
  ) {
    throw new Error(
      `SETTINGS_FIELD_RETIRED: ${unsupported} was removed; projects are selected only by current user-defined name.`
    );
  }
  throw new Error(`SETTINGS_FIELD_UNKNOWN: Unsupported setting: ${unsupported}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
