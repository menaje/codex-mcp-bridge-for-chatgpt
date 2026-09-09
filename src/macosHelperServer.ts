import { randomUUID, createHash } from "node:crypto";
import { RuntimeLifecycleCoordinator, lifecycleRequestSchema, isLifecycleHandoff, type LifecycleRequest, type LifecycleRecord, type LifecycleSnapshot, type LifecycleReason, type LifecycleReconciliation } from "./runtimeLifecycle.js";
import { ChangeSignal, changeWaitParamsSchema } from "./changeSignal.js";
import { CodexService } from "./codexService.js";
import { DiagnosticLog } from "./diagnosticLog.js";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync,
  watch,
  type FSWatcher
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as z from "zod/v4";
import {
  commitRuntimeEnvUpdate,
  defaultRuntimeEnvFile,
  inspectRuntimeEnvFile,
  prepareRuntimeEnvUpdate,
  readRuntimeEnvSubset,
  repairRuntimeEnvPermissions,
  rollbackRuntimeEnvUpdate,
  type PreparedRuntimeEnvUpdate,
  type RuntimeEnvStatus
} from "../scripts/runtime-env.mjs";
import { readPrivateFile, writePrivateFileAtomic } from "../scripts/managed-file.mjs";
import {
  readManagedRuntimeStatus,
  type ManagedTunnelStatus
} from "../scripts/runtime-status.mjs";
import {
  defaultRuntimeLockDirectory,
  readRuntimeLockOwner
} from "../scripts/runtime-lock.mjs";
import {
  COMPANION_PROTOCOL_NAME,
  COMPANION_PROTOCOL_VERSION,
  startPrivateJsonLineServer,
  type BridgeCompanionServer
} from "./companionServer.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { atomicRuntimeJson, CodexRuntimeManager, withRuntimeLock, type CliRuntimeSnapshot } from "./codexRuntime.js";
import { assertRuntimeEnvOutsideProjectRoots } from "./runtimeEnvProjectGuard.js";
import {
  discoverTunnelSetup,
  resolveTunnelSetupCandidate,
  type TunnelSetupDiscovery,
  type TunnelSetupDiscoveryOptions
} from "./tunnelSetupDiscovery.js";

export const MACOS_HELPER_PROTOCOL_NAME = "codex-mcp-bridge-macos-helper";
export const MACOS_HELPER_PROTOCOL_VERSION = 2;
const HELPER_MAX_REQUEST_BYTES = 256 * 1_024;
const HELPER_MAX_RESPONSE_BYTES = 512 * 1_024;
const HELPER_LOG_LIMIT = 200;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const MAX_DRAIN_TIMEOUT_MS = 5 * 60_000;
const MANAGED_LAUNCHER_SHUTDOWN_TIMEOUT_MS = 20_000;
const MANAGED_PROCESS_TREE_TERM_TIMEOUT_MS = 3_000;
const MANAGED_PROCESS_TREE_KILL_TIMEOUT_MS = 2_000;
const PROCESS_TABLE_MAX_BYTES = 4 * 1_024 * 1_024;
const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_AUTOMATIC_RESTARTS = 3;
const MACOS_MANAGED_TUNNEL_PROFILE = "codex-mcp-bridge-macos";
// Tunnel's persistent stdio path (tunnel-client 0.0.12) queues behind Activity watches.
// HTTP keeps those long polls independent of card reads and new work admission.
const MACOS_MANAGED_TUNNEL_TRANSPORT = "http";
const MAX_RUNTIME_LOG_LINE_BYTES = 64 * 1_024;

type RuntimeOutputStream = "stdout" | "stderr";
type RuntimeOutputCapture = {
  buffers: Record<RuntimeOutputStream, Buffer>;
  discarding: Set<RuntimeOutputStream>;
};

type ManagedProcessIdentity = {
  pid: number;
  parentPid: number;
  processGroupId: number;
};

const requestIdSchema = z.union([
  z.string().min(1).max(128),
  z.number().int().safe()
]);
const helperRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema,
  method: z.enum([
    "helper.hello",
    "helper.status",
    "helper.health",
    "changes.wait",
    "helper.prepare-shutdown",
    "setup.discover",
    "setup.import",
    "setup.apply",
    "setup.repair-permissions",
    "auth.status",
    "auth.login",
    "runtime.start",
    "runtime.stop",
    "runtime.restart",
    "runtime.configure",
    "codex.runtime",
    "runtime.repair",
    "runtime.logs",
    "lifecycle.request",
    "lifecycle.status",
    "lifecycle.cancel",
    "lifecycle.acknowledge"
  ]),
  params: z.unknown().optional()
});
const emptyParamsSchema = z.strictObject({});
const setupApplyParamsSchema = z.strictObject({
  apiKey: z.string().max(4_096).optional(),
  tunnelId: z.string().max(200).optional(),
  mode: z.enum(["drain", "force"]).default("drain"),
  timeoutMs: z.number().int().min(1_000).max(MAX_DRAIN_TIMEOUT_MS)
    .default(DEFAULT_DRAIN_TIMEOUT_MS)
});
const setupImportParamsSchema = z.strictObject({
  candidateId: z.string().regex(/^setup_[a-f0-9]{24}$/),
  mode: z.enum(["drain", "force"]).default("drain"),
  timeoutMs: z.number().int().min(1_000).max(MAX_DRAIN_TIMEOUT_MS)
    .default(DEFAULT_DRAIN_TIMEOUT_MS)
});
const stopParamsSchema = z.strictObject({
  mode: z.enum(["drain", "force"]).default("drain"),
  timeoutMs: z.number().int().min(1_000).max(MAX_DRAIN_TIMEOUT_MS)
    .default(DEFAULT_DRAIN_TIMEOUT_MS)
});
const restartParamsSchema = stopParamsSchema;
const runtimeConfigureParamsSchema = z.strictObject({
  defaultBackend: z.literal("app-server"),
  maximumAccess: z.enum(["read-only", "workspace-write", "full-access"]),
  mode: z.enum(["drain", "force"]).default("drain"),
  timeoutMs: z.number().int().min(1_000).max(MAX_DRAIN_TIMEOUT_MS)
    .default(DEFAULT_DRAIN_TIMEOUT_MS)
});
const logsParamsSchema = z.strictObject({
  limit: z.number().int().min(1).max(HELPER_LOG_LIMIT).default(100)
});
const codexRuntimeParamsSchema = z.strictObject({
  kind: z.literal("cli").optional(),
  includeAccount: z.boolean().optional(),
  action: z.enum(["status", "configure-billing", "remove-billing", "login", "select", "install", "update", "remove", "reinstall", "rollback", "cleanup", "retry", "check-updates", "apply-pending", "preferences"]),
  selectionId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  billing: z.object({ adminKey: z.string().max(32768), organizationId: z.string().max(164), projectId: z.string().max(165).nullable() }).optional(),
  preferences: z.strictObject({
    pinnedVersion: z.string().regex(/^\d+\.\d+\.\d+$/).nullable().optional(),
    skippedVersion: z.string().regex(/^\d+\.\d+\.\d+$/).nullable().optional(),
    notifications: z.boolean().optional()
  }).optional()
});
export type CodexRuntimeAction = z.infer<typeof codexRuntimeParamsSchema>;
const companionHelloSchema = z.object({
  protocol: z.object({
    name: z.string(),
    version: z.number().int()
  }),
  bridge: z.object({
    buildId: z.string()
  })
});

export type MacOSRuntimePhase =
  | "stopped"
  | "starting"
  | "running"
  | "draining"
  | "stopping"
  | "backoff"
  | "safe-mode";

export type MacOSHelperLogEntry = {
  at: string;
  source: "helper" | "runtime";
  message: string;
};

export type StatusProblem = {
  code: string;
  arguments: Record<string, string>;
};

export type MacOSHelperStatus = {
  kind: "helper-status";
  generatedAt: string;
  phase: MacOSRuntimePhase;
  pid: number | null;
  startedAt: string | null;
  lastExit: { at: string; code: number | null; signal: string | null } | null;
  lastError: string | null;
  lastProblem: StatusProblem | null;
  restartAttempt: number;
  lifecycle?: LifecycleSnapshot | null;
  configuration: RuntimeEnvStatus;
  codexRuntime?: CliRuntimeSnapshot;
  bridge: {
    socketPath: string;
    connected: boolean;
    acceptingNewJobs: boolean | null;
    activeJobs: number | null;
    pendingAdmissions: number | null;
    backgroundProcessState: "confirmed" | "unknown" | null;
    backgroundProcesses: number | null;
    backgroundProcessAgents: number | null;
    backgroundProcessUnknownAgents: number | null;
  };
  tunnel: {
    phase: string;
    profile: string | null;
    transport: string | null;
    doctorPassed: boolean;
    processRunning: boolean;
    connected: boolean;
    lastCheckedAt: string | null;
    lastError: string | null;
    lastProblem: StatusProblem | null;
  };
};

export type CodexLoginStatus = {
  installed: boolean;
  authenticated: boolean;
  summary: string;
  requestedAuthMode?: "chatgpt" | "api-key";
  resolvedAuthMode?: "chatgpt" | "api-key" | null;
};

export type MacOSHelperController = {
  requestLifecycle?(request: LifecycleRequest): Promise<LifecycleSnapshot>;
  lifecycleStatus?(requestId?: string): LifecycleSnapshot | null;
  cancelLifecycle?(requestId: string): LifecycleSnapshot;
  acknowledgeLifecycle?(requestId: string): LifecycleSnapshot;
  codexRuntime?(request: CodexRuntimeAction): Promise<CliRuntimeSnapshot>;
  snapshot(): Promise<MacOSHelperStatus>;
  health?(): Promise<MacOSHelperStatus>;
  subscribeChanges?(listener: (topic: string) => void): () => void;
  discoverSetup(): Promise<TunnelSetupDiscovery>;
  importSetup(values: {
    candidateId: string;
    mode: "drain" | "force";
    timeoutMs: number;
  }): Promise<{
    configuration: RuntimeEnvStatus;
    status: MacOSHelperStatus;
    restarted: boolean;
    rolledBack: false;
  }>;
  applyConfiguration(values: {
    apiKey?: string;
    tunnelId?: string;
    defaultBackend?: "app-server";
    maximumAccess?: "read-only" | "workspace-write" | "full-access";
    mode: "drain" | "force";
    timeoutMs: number;
  }): Promise<{
    configuration: RuntimeEnvStatus;
    status: MacOSHelperStatus;
    restarted: boolean;
    rolledBack: false;
  }>;
  repairConfigurationPermissions(): Promise<RuntimeEnvStatus>;
  authStatus(): Promise<CodexLoginStatus>;
  startLogin(): Promise<{ started: true }>;
  prepareShutdown(options: { mode: "drain" | "force"; timeoutMs: number }): Promise<MacOSHelperStatus>;
  start(): Promise<MacOSHelperStatus>;
  stop(options: { mode: "drain" | "force"; timeoutMs: number }): Promise<MacOSHelperStatus>;
  restart(options: { mode: "drain" | "force"; timeoutMs: number }): Promise<MacOSHelperStatus>;
  repair(options: { mode: "drain" | "force"; timeoutMs: number }): Promise<MacOSHelperStatus>;
  logs(limit: number): MacOSHelperLogEntry[];
};

export type MacOSBridgeSupervisorOptions = {
  logRetentionMs?: number;
  logMaxBytes?: number;
  bridgeRoot: string;
  envFile?: string;
  bridgeSocketPath: string;
  launcherPath?: string;
  runtimeStatusFile?: string;
  runtimeLockDirectory?: string;
  profileRebuildMarker?: string;
  registeredProjectRoots?: () => string[] | Promise<string[]>;
  autoRestart?: boolean;
  startTimeoutMs?: number;
  setupDiscoveryEnvironment?: NodeJS.ProcessEnv;
  setupDiscoveryProfileDirectory?: string;
  setupDiscoveryHomeDirectory?: string;
  codexRuntimeManager?: CodexRuntimeManager;
  lifecycleIntervalMs?: number;
};

export class MacOSBridgeSupervisor implements MacOSHelperController {
  private readonly changeListeners = new Set<(topic: string) => void>();
  private readonly watchedManagers = new WeakSet<CodexRuntimeManager>();
  private readonly managerSubscriptions = new Set<() => void>();
  private configurationGeneration = 0;
  private healthConfiguration?: { at: number; generation: number; value: RuntimeEnvStatus };

  private changed(topic: string): void {
    if (topic === "configuration") { this.configurationGeneration++; this.healthConfiguration = undefined; }
    if (topic === "configuration" || topic === "installation") this.lifecycleManager?.signal();
    for (const listener of this.changeListeners) listener(topic);
  }

  subscribeChanges(listener: (topic: string) => void): () => void {
    this.changeListeners.add(listener);
    const watchers: ReturnType<typeof watch>[] = [];
    const observeFile = (file: string, changed: () => void) => {
      try {
        // Watch the directory because private state files are replaced atomically.
        const watcher = watch(path.dirname(file), { persistent: false }, (_, filename) => {
          if (!filename || String(filename) === path.basename(file)) changed();
        });
        watcher.on("error", () => { watcher.close(); });
        watchers.push(watcher);
      } catch { /* The watchdog also works before directories are created. */ }
    };
    let runtimeFingerprint = this.runtimeChangeFingerprint();
    observeFile(this.runtimeStatusFile, () => {
      const next = this.runtimeChangeFingerprint();
      if (next !== runtimeFingerprint) { runtimeFingerprint = next; this.changed("runtime"); }
    });
    observeFile(this.envFile, () => this.changed("configuration"));
    const environment = commandEnvironment(this.envFile);
    observeFile(path.join(environment.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json"), () => this.changed("auth"));
    return () => { this.changeListeners.delete(listener); for (const watcher of watchers) watcher.close(); };
  }

  private runtimeChangeFingerprint(): string {
    const state = readManagedRuntimeStatus(this.runtimeStatusFile);
    if (!state) return "missing";
    // A routine heartbeat is not a connection change.
    return JSON.stringify({ pid: state.launcherPid, phase: state.phase, build: state.runtimeBuildId,
      tunnel: { ...state.tunnel, lastCheckedAt: null } });
  }

  private watchManager(manager: CodexRuntimeManager): void {
    if (this.watchedManagers.has(manager)) return;
    this.watchedManagers.add(manager);
    this.managerSubscriptions.add(manager.subscribeChanges(() => this.changed("installation")));
  }

  private codexService?: CodexService;
  private readonly bridgeRoot: string;
  private readonly envFile: string;
  private readonly bridgeSocketPath: string;
  private readonly launcherPath: string;
  private readonly runtimeStatusFile: string;
  private readonly runtimeLockDirectory: string;
  private readonly legacyRuntimeLockDirectory: string;
  private readonly profileRebuildMarker: string;
  private readonly registeredProjectRoots: () => string[] | Promise<string[]>;
  private readonly permissionRepairProjectRoots: () => string[] | Promise<string[]>;
  private readonly autoRestart: boolean;
  private readonly startTimeoutMs: number;
  private readonly setupDiscoveryEnvironment: NodeJS.ProcessEnv;
  private readonly setupDiscoveryProfileDirectory: string | undefined;
  private readonly setupDiscoveryHomeDirectory: string | undefined;
  private child: ChildProcess | undefined;
  private managedPid: number | undefined;
  private phase: MacOSRuntimePhase = "stopped";
  private startedAt: string | null = null;
  private lastExit: MacOSHelperStatus["lastExit"] = null;
  private lastError: string | null = null;
  private restartAttempt = 0;
  private unexpectedExits: number[] = [];
  private restartTimer: NodeJS.Timeout | undefined;
  private stabilityTimer: NodeJS.Timeout | undefined;
  private manualStop = false;
  private loginProcess: ChildProcess | undefined;
  private pendingProcessCleanup: ManagedProcessIdentity[] = [];
  private readonly logEntries: DiagnosticLog<MacOSHelperLogEntry>;
  private bridgeStatusProbe: Promise<RuntimeAdmissionSnapshot | null> | undefined;
  private bridgeProbeObservation: { pid: number | undefined; connected: boolean; failedAt: number | null } | undefined;
  private operation: Promise<unknown> = Promise.resolve();
  private lifecycleManager?: RuntimeLifecycleCoordinator;
  private handoffWatcher?: FSWatcher;
  private closed = false;
  private readonly lifecycleIntervalMs: number;
  private lifecyclePhaseReporter?: (phase: "executing" | "reconnecting") => void;
  private executingLifecycle?: LifecycleRecord;
  private readonly helperInstance = randomUUID();
  private cliManager?: CodexRuntimeManager;
  private cliInstallation?: Promise<unknown>;
  private cliUpdateCheck?: Promise<unknown>;

  constructor(options: MacOSBridgeSupervisorOptions) {
    this.logEntries = new DiagnosticLog({ maxEntries: HELPER_LOG_LIMIT,
      maxBytes: options.logMaxBytes ?? 1_024 * 1_024, retentionMs: options.logRetentionMs ?? 24 * 60 * 60_000 });
    this.lifecycleIntervalMs = options.lifecycleIntervalMs ?? 5000;
    this.bridgeRoot = path.resolve(options.bridgeRoot);
    this.envFile = path.resolve(options.envFile || defaultRuntimeEnvFile());
    this.cliManager = options.codexRuntimeManager;
    this.bridgeSocketPath = path.resolve(options.bridgeSocketPath);
    this.launcherPath = path.resolve(
      options.launcherPath || path.join(this.bridgeRoot, "scripts", "start-codex-mcp-bridge.mjs")
    );
    const runDirectory = path.dirname(this.bridgeSocketPath);
    this.runtimeStatusFile = path.resolve(
      options.runtimeStatusFile || path.join(runDirectory, "launcher-status.json")
    );
    this.runtimeLockDirectory = path.resolve(
      options.runtimeLockDirectory || defaultRuntimeLockDirectory()
    );
    this.legacyRuntimeLockDirectory = path.resolve(
      path.dirname(this.envFile),
      "run",
      "launcher.lock"
    );
    this.profileRebuildMarker = path.resolve(
      options.profileRebuildMarker || path.join(path.dirname(this.envFile), "profile-rebuild-required")
    );
    this.registeredProjectRoots = options.registeredProjectRoots || (() =>
      readRegisteredProjectRoots(this.envFile)
    );
    this.permissionRepairProjectRoots = options.registeredProjectRoots || (() =>
      readRegisteredProjectRoots(this.envFile, { allowBroadReadOnlyPermissions: true })
    );
    this.autoRestart = options.autoRestart !== false;
    this.startTimeoutMs = options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS;
    this.setupDiscoveryEnvironment = options.setupDiscoveryEnvironment || process.env;
    this.setupDiscoveryProfileDirectory = options.setupDiscoveryProfileDirectory;
    this.setupDiscoveryHomeDirectory = options.setupDiscoveryHomeDirectory;
  }

  health(): Promise<MacOSHelperStatus> { return this.snapshot({ includeDetails: false }); }

  async snapshot(options: { includeDetails?: boolean } = {}): Promise<MacOSHelperStatus> {
    this.reconcileManagedRuntime();
    const bridgeAdmission = await this.readBridgeStatus();
    const includeDetails = options.includeDetails !== false;
    const generation = this.configurationGeneration;
    const cached = this.healthConfiguration;
    const configuration = !includeDetails && cached?.generation === generation && Date.now() - cached.at < 60_000
      ? cached.value : await this.configurationStatus();
    if (configuration !== cached?.value && generation === this.configurationGeneration) this.healthConfiguration = { at: Date.now(), generation, value: configuration };
    const managedRuntime = readManagedRuntimeStatus(this.runtimeStatusFile);
    const tunnel = normalizeTunnelStatus(
      managedRuntime,
      this.managedPid || null,
      BRIDGE_BUILD_INFO.id
    );
    return {
      kind: "helper-status",
      generatedAt: new Date().toISOString(),
      phase: this.phase,
      pid: this.managedPid || null,
      startedAt: this.startedAt,
      lastExit: this.lastExit,
      lastError: this.lastError,
      lastProblem: helperStatusProblem(this.lastError),
      restartAttempt: this.restartAttempt,
      lifecycle: this.lifecycleStatus(),
      configuration,
      ...(includeDetails && this.cliManager ? { codexRuntime: await this.cliManager.snapshot() } : {}),
      bridge: {
        socketPath: this.bridgeSocketPath,
        connected: bridgeAdmission !== null,
        acceptingNewJobs: bridgeAdmission?.acceptingNewJobs ?? null,
        activeJobs: bridgeAdmission?.activeJobs ?? null,
        pendingAdmissions: bridgeAdmission?.pendingAdmissions ?? null,
        backgroundProcessState: bridgeAdmission?.backgroundProcessState ?? null,
        backgroundProcesses: bridgeAdmission?.backgroundProcesses ?? null,
        backgroundProcessAgents: bridgeAdmission?.backgroundProcessAgents ?? null,
        backgroundProcessUnknownAgents: bridgeAdmission?.backgroundProcessUnknownAgents ?? null
      },
      tunnel
    };
  }

  private readBridgeStatus(): Promise<RuntimeAdmissionSnapshot | null> {
    if (this.bridgeStatusProbe) return this.bridgeStatusProbe;
    const pid = this.managedPid;
    const started = Date.now();
    let failure: unknown;
    const probe = readBridgeHealth(this.bridgeSocketPath, (error) => { failure = error; })
      .then((admission) => {
        if (pid !== this.managedPid) return null;
        const connected = admission !== null;
        const previous = this.bridgeProbeObservation?.pid === pid ? this.bridgeProbeObservation : undefined;
        const failedAt = connected ? null : previous?.failedAt ?? started;
        if (!connected && previous?.connected !== false && this.phase === "running") {
          this.appendLog("helper", `Bridge status check failed (pid ${pid ?? "unknown"}, ${Date.now() - started}ms): ${safeErrorMessage(failure)}`);
        } else if (connected && previous?.connected === false && previous.failedAt !== null) {
          this.appendLog("helper", `Bridge status check recovered (pid ${pid ?? "unknown"}, unavailable for ${Date.now() - previous.failedAt}ms).`);
        }
        this.bridgeProbeObservation = { pid, connected, failedAt };
        return admission;
      }).finally(() => {
        if (this.bridgeStatusProbe === probe) this.bridgeStatusProbe = undefined;
      });
    this.bridgeStatusProbe = probe;
    return probe;
  }

  async discoverSetup(): Promise<TunnelSetupDiscovery> {
    return discoverTunnelSetup(this.setupDiscoveryOptions());
  }

  private applyConfigurationImmediate(values: {
    apiKey?: string;
    tunnelId?: string;
    defaultBackend?: "app-server";
    maximumAccess?: "read-only" | "workspace-write" | "full-access";
    mode: "drain" | "force";
    timeoutMs: number;
  }): Promise<{
    configuration: RuntimeEnvStatus;
    status: MacOSHelperStatus;
    restarted: boolean;
    rolledBack: false;
  }> {
    return this.exclusive(async () => {
      await this.assertEnvironmentLocation();
      this.reconcileManagedRuntime();
      if (!this.isManagedRuntimeRunning()) {
        await this.adoptExistingRuntime();
      }
      const prepared = prepareRuntimeEnvUpdate(this.envFile, values);

      const wasRunning = this.isManagedRuntimeRunning();
      if (!prepared.changed) {
        const status = wasRunning
          ? await this.snapshot()
          : await this.startUnlocked(true);
        return {
          configuration: status.configuration,
          status,
          restarted: !wasRunning,
          rolledBack: false
        };
      }

      if (wasRunning) {
        if (values.defaultBackend && values.mode === "drain") await this.assertRuntimeChangeSafe();
        await this.stopUnlocked({ mode: values.mode, timeoutMs: values.timeoutMs, protectMemory: !!values.defaultBackend });
      }
      let committed = false;
      try {
        const configuration = commitRuntimeEnvUpdate(prepared);
        committed = true;
        if (prepared.tunnelIdChanged) {
          this.appendLog(
            "helper",
            "Tunnel identity changed; managed profile identity will be revalidated before reuse."
          );
        }
        this.appendLog("helper", "Runtime configuration was atomically committed.");
        const status = await this.startUnlocked(true);
        return {
          configuration,
          status,
          restarted: true,
          rolledBack: false
        };
      } catch (error) {
        await this.recoverConfigurationApply(prepared, committed, wasRunning, error);
        const recoveryMessage = committed
          ? "Previous runtime configuration was restored."
          : "Runtime configuration was not changed and the existing runtime was restarted.";
        throw new Error(
          `CONFIG_APPLY_FAILED: ${safeErrorMessage(error)} ${recoveryMessage}`
        );
      }
    });
  }

  private async configurationStatus(): Promise<RuntimeEnvStatus> {
    const status = inspectRuntimeEnvFile(this.envFile);
    if (!status.valid) return status;
    try {
      await this.assertEnvironmentLocation();
      return status;
    } catch (error) {
      const issue = safeErrorMessage(error);
      return {
        ...status,
        valid: false,
        issue,
        issueProblem: runtimeConfigurationProblem(issue)
      };
    }
  }

  private setupDiscoveryOptions(): TunnelSetupDiscoveryOptions {
    let runtimeValues: Record<string, string> = {};
    try {
      runtimeValues = readRuntimeEnvSubset(this.envFile, [
        "CONTROL_PLANE_API_KEY",
        "CONTROL_PLANE_TUNNEL_ID"
      ]);
    } catch {
      // Permission repair remains explicit. Discovery never weakens the dotenv boundary.
    }
    return {
      environment: this.setupDiscoveryEnvironment,
      runtimeValues,
      ...(this.setupDiscoveryProfileDirectory
        ? { profileDirectory: this.setupDiscoveryProfileDirectory }
        : {}),
      ...(this.setupDiscoveryHomeDirectory
        ? { homeDirectory: this.setupDiscoveryHomeDirectory }
        : {})
    };
  }

  private currentRuntimeApiKeyAvailable(): boolean {
    try {
      const values = readRuntimeEnvSubset(this.envFile, ["CONTROL_PLANE_API_KEY"]);
      return /^sk-(?!admin-)\S{16,}$/i.test(values.CONTROL_PLANE_API_KEY || "");
    } catch {
      return false;
    }
  }

  private async assertEnvironmentLocation(): Promise<void> {
    const projectRoots = await this.registeredProjectRoots();
    assertRuntimeEnvOutsideProjectRoots(this.envFile, projectRoots);
  }

  private async recoverConfigurationApply(
    prepared: PreparedRuntimeEnvUpdate,
    committed: boolean,
    wasRunning: boolean,
    applyError: unknown
  ): Promise<void> {
    if (committed) {
      try {
        rollbackRuntimeEnvUpdate(prepared);
        this.appendLog("helper", "Configuration apply failed; the previous private dotenv was restored.");
      } catch (rollbackError) {
        this.lastError = `CONFIG_ROLLBACK_FAILED: ${safeErrorMessage(rollbackError)}`;
        this.appendLog("helper", this.lastError);
        throw new Error(
          `${safeErrorMessage(applyError)} ${this.lastError}`
        );
      }
    }
    if (!wasRunning) return;
    try {
      await this.startUnlocked(true);
      this.appendLog(
        "helper",
        committed
          ? "The previous runtime configuration was restarted successfully."
          : "The unchanged runtime configuration was restarted successfully."
      );
    } catch (restartError) {
      this.lastError = `CONFIG_ROLLBACK_RESTART_FAILED: ${safeErrorMessage(restartError)}`;
      this.appendLog("helper", this.lastError);
      throw new Error(
        `${safeErrorMessage(applyError)} ${this.lastError}`
      );
    }
  }

  repairConfigurationPermissions(): Promise<RuntimeEnvStatus> {
    return this.exclusive(async () => {
      const projectRoots = await this.permissionRepairProjectRoots();
      assertRuntimeEnvOutsideProjectRoots(this.envFile, projectRoots);
      const status = repairRuntimeEnvPermissions(this.envFile);
      this.appendLog("helper", "Restricted runtime dotenv permissions to the current user.");
      return status;
    });
  }

  private selectedCliManager(): CodexRuntimeManager {
    return this.cliManager ||= new CodexRuntimeManager({ environment: commandEnvironment(this.envFile) });
  }

  private selectedCodexService(): CodexService {
    return this.codexService ||= new CodexService(commandEnvironment(this.envFile), this.selectedCliManager());
  }

  async codexRuntime(request: CodexRuntimeAction): Promise<CliRuntimeSnapshot> {
    const manager = this.selectedCliManager();
    this.watchManager(manager);
    if (!["status", "check-updates"].includes(request.action) &&
        ["executing", "reconnecting"].includes(this.lifecycleManager?.active?.phase || "")) {
      throw new Error("LIFECYCLE_BUSY: Runtime activation is in progress.");
    }
    switch (request.action) {
      case "status": {
        const base = await manager.snapshot();
        const service = this.selectedCodexService(), kind = "app-server" as const;
        const snapshot = { ...base, billing: await service.billing.configuration(), account: base.selection?.available
          ? request.includeAccount === false ? service.cachedAccount(kind) : await service.readAccount(kind, true) || service.cachedAccount(kind) : null };
        if (snapshot.selection?.source === "bridge" && snapshot.preferences.notifications && !this.cliUpdateCheck &&
            (!snapshot.checkedAt || Date.now() - Date.parse(snapshot.checkedAt) > 24 * 60 * 60_000)) {
          this.cliUpdateCheck = manager.checkUpdates().catch(() => undefined).finally(() => { this.cliUpdateCheck = undefined; });
        }
        return snapshot;
      }
      case "configure-billing": {
        if (!request.billing) throw new Error("CODEX_BILLING_SETTINGS_REQUIRED");
        const billing = this.selectedCodexService().billing;
        assertRuntimeEnvOutsideProjectRoots(billing.file, await this.registeredProjectRoots());
        await billing.configure(request.billing);
        return { ...await manager.snapshot(), billing: await billing.snapshot() };
      }
      case "remove-billing": {
        await this.selectedCodexService().billing.remove();
        return { ...await manager.snapshot(), billing: await this.selectedCodexService().billing.snapshot() };
      }
      case "login": await this.startLogin(request.kind); return manager.snapshot();
      case "select":
        if (!request.selectionId) throw new Error("CODEX_SELECTION_REQUIRED: Choose an installation.");
        return manager.select(request.selectionId);
      case "install": case "update": case "reinstall": case "retry": {
        if (this.cliInstallation) throw new Error("CODEX_OPERATION_BUSY: Installation is already in progress.");
        if (!(await manager.snapshot()).actions[request.action]) throw new Error("CODEX_ACTION_UNAVAILABLE: This action is not currently applicable.");
        this.cliInstallation = (request.action === "retry" ? manager.retry() : manager.install(request.action, request.version))
          .catch(() => { this.appendLog("helper", "Codex installation failed. The previous installation was preserved."); })
          .finally(() => { this.cliInstallation = undefined; });
        // Installation continues independently of this local UI request; status survives re-entry.
        return manager.snapshot();
      }
      case "check-updates": return manager.checkUpdates();
      case "preferences": return manager.setPreferences(request.preferences || {});
      case "rollback": return manager.rollback();
      case "cleanup": return manager.cleanup();
      case "remove": return manager.remove();
      case "apply-pending": await manager.applyPending(); return manager.snapshot();

    }
  }

  async authStatus(): Promise<CodexLoginStatus> {
    const environment = commandEnvironment(this.envFile);
    const selected = await this.selectedCliManager().resolve(environment.CODEX_MCP_BRIDGE_CODEX || environment.CODEX_GPT_BRIDGE_CODEX).catch(() => null);
    if (!selected) return { installed: false, authenticated: false, summary: "Choose or install Codex in the bridge settings." };
    const account = await this.selectedCodexService().readAccount("app-server");
    return { installed: true, authenticated: account?.authenticated === true,
      resolvedAuthMode: account && account.authMode !== "unknown" ? account.authMode : null,
      summary: account?.authenticated ? "Codex login is available." : "Codex login is required." };
  }

  startLogin(_kind?: "cli"): Promise<{ started: true }> {
    return this.exclusive(async () => {
      if (isChildRunning(this.loginProcess)) {
        this.appendLog("helper", "The existing Codex browser login is still in progress.");
        return { started: true };
      }

      const environment = commandEnvironment(this.envFile);
      const { selection: selected, release } = await this.selectedCliManager().acquire(environment.CODEX_MCP_BRIDGE_CODEX || environment.CODEX_GPT_BRIDGE_CODEX);
      const command = selected.command;
      const child = spawn(command, ["login"], {
        detached: true,
        env: environment,
        stdio: "ignore"
      });
      this.loginProcess = child;
      child.once("exit", () => {
        void release();
        if (this.loginProcess === child) this.loginProcess = undefined;
        this.changed("auth");
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
          child.once("error", reject);
        });
      } catch (error) {
        await release();
        if (this.loginProcess === child) this.loginProcess = undefined;
        this.lastError = safeErrorMessage(error);
        this.appendLog("helper", `Codex login could not start: ${this.lastError}`);
        throw error;
      }
      this.appendLog("helper", "Codex browser login was requested.");
      return { started: true };
    });
  }

  private lifecycle(): RuntimeLifecycleCoordinator {
    if (this.lifecycleManager) return this.lifecycleManager;
    if (this.closed) throw new Error("LIFECYCLE_CLOSED: The helper is shutting down.");
    this.lifecycleManager = new RuntimeLifecycleCoordinator(
      path.join(path.dirname(this.runtimeLockDirectory), "lifecycle.json"), {
        prepare: async request => {
          await this.assertEnvironmentLocation();
          assertRuntimeEnvOutsideProjectRoots(path.join(path.dirname(this.runtimeLockDirectory), "lifecycle.json"), await this.registeredProjectRoots());
          if (request.candidateId) {
            const candidate = resolveTunnelSetupCandidate(request.candidateId, this.setupDiscoveryOptions());
            if (!candidate) throw new Error("SETUP_CANDIDATE_UNAVAILABLE: Refresh the discovered settings.");
            if (!candidate.apiKey && !this.currentRuntimeApiKeyAvailable()) throw new Error("SETUP_API_KEY_UNAVAILABLE: The selected Runtime API key is unavailable.");
            request = { ...request, candidateId: undefined, configuration: {
              ...(candidate.apiKey ? { apiKey: candidate.apiKey } : {}), tunnelId: candidate.tunnelId
            } };
          }
          if (request.configuration) prepareRuntimeEnvUpdate(this.envFile, request.configuration);
          const changesRuntime = ["start", "restart", "repair", "configure", "helper-replace"].includes(request.kind);
          const cli = changesRuntime ? await this.selectedCliManager().activationTarget() : undefined;
          return { request, target: { cli, helperInstance: this.helperInstance,
            ...(request.configuration ? { environmentFingerprint: this.environmentFingerprint() } : {}) }, description: cli?.description };
        },
        inspect: record => this.inspectLifecycle(record),
        execute: async (record, reportPhase, recoveryAction) => {
          this.lifecyclePhaseReporter = reportPhase;
          this.executingLifecycle = record;
          try {
            if (recoveryAction === "activate-helper") {
              const status = await this.exclusive(() => this.startUnlocked(true));
              if (!status.bridge.connected || !status.tunnel.connected) {
                throw new Error("LIFECYCLE_RECOVERY_REQUIRED: The replacement runtime is not ready.");
              }
              return "completed";
            }
            const options = { mode: record.request.force ? "force" as const : "drain" as const,
              timeoutMs: record.deadlineAt === undefined ? 1000 : Math.max(1000, record.deadlineAt - Date.now()) };
            switch (record.request.kind) {
              case "start": await this.exclusive(() => this.startUnlocked(true)); break;
              case "restart": await this.restartImmediate(options); break;
              case "stop": await this.stopImmediate(options); break;
              case "repair": await this.repairImmediate(options); break;
              case "configure": await this.applyConfigurationImmediate({ ...record.request.configuration, ...options }); break;
              case "shutdown": case "mode-switch": case "helper-replace": await this.prepareShutdownImmediate(options); break;
            }
            return isLifecycleHandoff(record.request.kind) ? "handoff-ready" : "completed";
          } finally { this.lifecyclePhaseReporter = undefined; this.executingLifecycle = undefined; }
        },
        reconcile: record => this.reconcileLifecycle(record),
        changed: () => { this.watchHandoffReceipt(); this.changed("runtime"); },
        error: error => safeErrorMessage(error),
        watch: async (changed, signal) => {
          let revision: string | undefined;
          while (!signal.aborted) {
            try {
              const notice = await bridgeRequest<{ revision: string; topics: string[] }>(this.bridgeSocketPath, "changes.wait", {
                ...(revision ? { after: revision } : {}), waitMs: 25000
              }, 27000, signal);
              if (signal.aborted) return;
              revision = notice.revision;
              if (notice.topics.length) changed();
              // Older companions and test launchers may not support invalidation notices.
              if (!revision) await delay(this.lifecycleIntervalMs);
            } catch {
              revision = undefined;
              if (!signal.aborted) await delay(Math.min(5000, this.lifecycleIntervalMs));
            }
          }
        }
      }, { intervalMs: this.lifecycleIntervalMs }
    );
    this.watchHandoffReceipt();
    return this.lifecycleManager;
  }

  private watchHandoffReceipt(): void {
    if (this.closed || this.handoffWatcher) return;
    try {
      const watcher = watch(path.dirname(this.runtimeLockDirectory), { persistent: false }, (_, filename) => {
        if (!filename || filename === "lifecycle-handoff.json") this.lifecycleManager?.signal();
      });
      this.handoffWatcher = watcher;
      watcher.on("error", () => {
        watcher.close();
        if (this.handoffWatcher === watcher) this.handoffWatcher = undefined;
      });
    } catch { /* The directory is created on first reservation; the fallback also reconciles receipts. */ }
  }

  private environmentFingerprint(): string | null {
    try { return createHash("sha256").update(readPrivateFile(this.envFile)).digest("hex"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async inspectLifecycle(record: LifecycleRecord): Promise<{ run: string | null; reasons: LifecycleReason[] }> {
    this.reconcileManagedRuntime();
    if (!this.isManagedRuntimeRunning()) await this.adoptExistingRuntime();
    await this.validateLifecycleTarget(record);
    const run = this.lifecycleRunIdentity();
    if (!run || record.request.kind === "start") return { run, reasons: [] };
    const impact = await bridgeRequest<RuntimeAdmissionSnapshot>(this.bridgeSocketPath, "runtime.snapshot", { inspectBackgroundProcesses: true }, 15000)
      .catch(() => null);
    if (!impact) return { run, reasons: [{ code: "runtime-unreachable" }] };
    const reasons: LifecycleReason[] = [];
    for (const [code, count] of [
      ["active-jobs", impact.activeJobs], ["pending-admissions", impact.pendingAdmissions],
      ["pending-interactions", impact.pendingInteractions], ["memory-only-threads", impact.memoryOnlyThreads],
      ["background-processes", impact.backgroundProcesses]
    ] as const) if ((count || 0) > 0) reasons.push({ code, count });
    if (impact.backgroundProcessState !== "confirmed" || impact.backgroundProcessUnknownAgents > 0) reasons.push({ code: "background-state-unknown" });
    return { run, reasons };
  }

  private lifecycleRunIdentity(): string | null {
    if (!this.isManagedRuntimeRunning()) return null;
    const owner = readRuntimeLockOwner(this.runtimeLockDirectory);
    return owner && owner.pid === this.managedPid ? `${owner.pid}:${owner.token}` : `${this.managedPid}:${this.startedAt}`;
  }

  private async validateLifecycleTarget(record: LifecycleRecord): Promise<void> {
    const expectedCli = record.target.cli as { revision: number; command: string | null } | undefined;
    if (expectedCli) {
      const cli = await this.selectedCliManager().activationTarget();
      if (cli.revision !== expectedCli.revision || cli.command !== expectedCli.command) {
        throw new Error("LIFECYCLE_TARGET_CHANGED: The selected CLI changed. Submit a reservation for the current selection.");
      }
    }
    if (record.request.configuration && record.target.environmentFingerprint !== this.environmentFingerprint()) {
      throw new Error("LIFECYCLE_TARGET_CHANGED: Runtime settings changed after this reservation was accepted.");
    }
  }

  private async reconcileLifecycle(record: LifecycleRecord): Promise<LifecycleReconciliation> {
    if (["waiting", "blocked"].includes(record.phase)) return "retry";
    let receipt: { requestId?: string; outcome?: string; failureCode?: string } | undefined;
    try { receipt = JSON.parse(readPrivateFile(path.join(path.dirname(this.runtimeLockDirectory), "lifecycle-handoff.json"), { encoding: "utf8" })); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (receipt?.requestId === record.request.requestId && receipt.outcome === "failed") {
      const code = typeof receipt.failureCode === "string" && /^[A-Z][A-Z0-9_]{2,79}$/.test(receipt.failureCode)
        ? receipt.failureCode : "LIFECYCLE_EXTERNAL_ACTION_FAILED";
      throw new Error(`LIFECYCLE_HANDOFF_FAILED: ${code}: The application could not finish the prepared action.`);
    }
    if (record.request.kind === "helper-replace" && record.request.targetBuildId === BRIDGE_BUILD_INFO.id && record.target.helperInstance !== this.helperInstance) {
      await this.validateLifecycleTarget(record);
      return "activate-helper";
    }
    this.reconcileManagedRuntime();
    if (!this.isManagedRuntimeRunning()) await this.adoptExistingRuntime();
    const run = this.lifecycleRunIdentity();
    if (isLifecycleHandoff(record.request.kind) || record.request.kind === "stop") {
      if (record.phase === "handing-off") {
        if (receipt?.requestId === record.request.requestId && receipt.outcome === "completed") {
          if (run) throw new Error("LIFECYCLE_RECOVERY_REQUIRED: A runtime is running after the handoff receipt.");
          return "completed";
        }
        return "retry";
      }
      if (!run) return isLifecycleHandoff(record.request.kind) ? "handoff-ready" : "completed";
      if (record.phase === "handoff-ready" || run !== record.beforeRun) throw new Error("LIFECYCLE_RECOVERY_REQUIRED: A different runtime is running. Review the pending shutdown.");
      return "retry";
    }
    if (record.request.configuration && !prepareRuntimeEnvUpdate(this.envFile, record.request.configuration).changed) {
      record.target.environmentFingerprint = this.environmentFingerprint();
    }
    if (run && run !== record.beforeRun) {
      await this.inspectLifecycle(record);
      const status = await this.snapshot();
      if (status.bridge.connected && status.tunnel.connected) return "completed";
      throw new Error("LIFECYCLE_RECOVERY_REQUIRED: The replacement runtime is not ready.");
    }
    return "retry";
  }

  requestLifecycle(request: LifecycleRequest): Promise<LifecycleSnapshot> { return this.lifecycle().submit(request); }
  lifecycleStatus(requestId?: string): LifecycleSnapshot | null {
    return this.closed ? this.lifecycleManager?.snapshot(requestId) ?? null : this.lifecycle().snapshot(requestId);
  }
  cancelLifecycle(requestId: string): LifecycleSnapshot { return this.lifecycle().cancel(requestId); }
  acknowledgeLifecycle(requestId: string): LifecycleSnapshot { return this.lifecycle().acknowledge(requestId); }

  async startOnLaunch(): Promise<MacOSHelperStatus> {
    const coordinator = this.lifecycle();
    const recovering = coordinator.active !== null;
    coordinator.resume();
    await coordinator.settled();
    // Recovery owns this launch, including a concurrent cancel or failure.
    // Do not replace its result with an implicit start reservation.
    if (recovering || coordinator.active || (["stop", "mode-switch"].includes(coordinator.latest?.kind || "") && coordinator.latest?.phase === "completed")) return this.snapshot();
    return this.start();
  }

  private async legacyLifecycle(request: Omit<LifecycleRequest, "requestId">, timeoutMs: number): Promise<MacOSHelperStatus> {
    const coordinator = this.lifecycle();
    const accepted = await coordinator.submit({ ...request, requestId: randomUUID() }, timeoutMs);
    while (true) {
      const status = coordinator.snapshot(accepted.requestId)!;
      if (status.phase === "failed") {
        this.lastError = status.error || "LIFECYCLE_FAILED";
        this.appendLog("helper", `Graceful runtime stop was blocked: ${this.lastError}`);
        throw new Error(this.lastError);
      }
      if (status.phase === "cancelled") throw new Error("LIFECYCLE_CANCELLED");
      if (status.phase === "handoff-ready") coordinator.completeLegacyHandoff(status.requestId);
      if (["completed", "handoff-ready"].includes(status.phase)) return this.snapshot();
      await delay(250);
      coordinator.signal();
    }
  }

  async importSetup(values: { candidateId: string; mode: "drain" | "force"; timeoutMs: number }) {
    const status = await this.legacyLifecycle({ kind: "configure", candidateId: values.candidateId, force: values.mode === "force" }, values.timeoutMs);
    return { configuration: status.configuration, status, restarted: true, rolledBack: false as const };
  }
  async applyConfiguration(values: { apiKey?: string; tunnelId?: string; defaultBackend?: "app-server"; maximumAccess?: "read-only" | "workspace-write" | "full-access"; mode: "drain" | "force"; timeoutMs: number }) {
    const { mode, timeoutMs, ...configuration } = values;
    const before = this.managedPid;
    const status = await this.legacyLifecycle({ kind: "configure", configuration, force: mode === "force" }, timeoutMs);
    return { configuration: status.configuration, status, restarted: status.pid !== before, rolledBack: false as const };
  }
  prepareShutdown(options: { mode: "drain" | "force"; timeoutMs: number }) {
    return this.legacyLifecycle({ kind: "shutdown", force: options.mode === "force" }, options.timeoutMs);
  }
  stop(options: { mode: "drain" | "force"; timeoutMs: number }) {
    return this.legacyLifecycle({ kind: "stop", force: options.mode === "force" }, options.timeoutMs);
  }
  restart(options: { mode: "drain" | "force"; timeoutMs: number }) {
    return this.legacyLifecycle({ kind: "restart", force: options.mode === "force" }, options.timeoutMs);
  }
  repair(options: { mode: "drain" | "force"; timeoutMs: number }) {
    return this.legacyLifecycle({ kind: "repair", force: options.mode === "force" }, options.timeoutMs);
  }

  start(): Promise<MacOSHelperStatus> {
    return this.legacyLifecycle({ kind: "start", force: false }, 90_000);
  }

  private prepareShutdownImmediate(options: {
    mode: "drain" | "force";
    timeoutMs: number;
  }): Promise<MacOSHelperStatus> {
    return this.exclusive(() => this.prepareShutdownUnlocked(options));
  }

  private stopImmediate(options: { mode: "drain" | "force"; timeoutMs: number }): Promise<MacOSHelperStatus> {
    return this.exclusive(() => this.stopUnlocked(options));
  }

  private restartImmediate(options: { mode: "drain" | "force"; timeoutMs: number }): Promise<MacOSHelperStatus> {
    return this.exclusive(async () => {
      const cli = await this.selectedCliManager().snapshot();
      const protectMemory = !!(cli.operation?.phase === "pending" || cli.pendingSelection);
      if (protectMemory && options.mode === "drain") {
        await this.assertRuntimeChangeSafe();
      }
      await this.stopUnlocked(options);
      return this.startUnlocked(true);
    });
  }

  private async assertRuntimeChangeSafe(): Promise<void> {
    if (!this.isManagedRuntimeRunning()) return;
    const impact = await readBridgeAdmission(this.bridgeSocketPath);
    if (!impact) throw new Error("CODEX_APPLY_PENDING: The running bridge could not be inspected. Its environment was preserved.");
    if ((impact.memoryOnlyThreads || 0) > 0) throw new Error("CODEX_MEMORY_THREADS_ACTIVE: Archive memory-only agents before applying a runtime change. The current environment was preserved.");
    if ((impact.pendingInteractions || 0) > 0) throw new Error("CODEX_INTERACTIONS_PENDING: Resolve the pending approvals or questions before applying a runtime change.");
  }

  private repairImmediate(options: { mode: "drain" | "force"; timeoutMs: number }): Promise<MacOSHelperStatus> {
    return this.exclusive(async () => {
      await this.stopUnlocked(options);
      writePrivateFileAtomic(
        this.profileRebuildMarker,
        `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`,
        { encoding: "utf8" }
      );
      this.appendLog("helper", "Rebuilding the managed Secure MCP Tunnel profile.");
      return this.startUnlocked(true);
    });
  }

  logs(limit: number): MacOSHelperLogEntry[] {
    return this.logEntries.recent(limit);
  }

  /** A helper exit releases supervision, preserving the detached runtime for
   * adoption. Runtime termination is a separate explicit lifecycle operation. */
  async close(options: { runtime?: "preserve" | "force-stop" } = {}): Promise<void> {
    this.closed = true;
    this.manualStop = true;
    await this.lifecycleManager?.close();
    this.handoffWatcher?.close();
    this.handoffWatcher = undefined;
    for (const unsubscribe of this.managerSubscriptions) unsubscribe();
    this.managerSubscriptions.clear();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    await this.exclusive(async () => {
      if (options.runtime === "force-stop") await this.prepareShutdownUnlocked({ mode: "force", timeoutMs: 5_000 });
      else await this.stopLoginProcessUnlocked();
    });
  }

  private async prepareShutdownUnlocked(options: {
    mode: "drain" | "force";
    timeoutMs: number;
  }): Promise<MacOSHelperStatus> {
    const failures: string[] = [];
    let status: MacOSHelperStatus | undefined;
    try {
      status = await this.stopUnlocked(options);
    } catch (error) {
      if (options.mode === "drain") throw error;
      failures.push(safeErrorMessage(error));
    }
    try {
      await this.stopLoginProcessUnlocked();
    } catch (error) {
      failures.push(safeErrorMessage(error));
    }
    if (failures.length > 0) {
      throw new Error(`HELPER_SHUTDOWN_FAILED: ${failures.join(" ")}`);
    }
    return status || this.snapshot();
  }

  private async stopLoginProcessUnlocked(): Promise<void> {
    const child = this.loginProcess;
    const pid = child?.pid;
    if (!pid || !processIsAlive(pid)) {
      if (this.loginProcess === child) this.loginProcess = undefined;
      return;
    }

    let processTree: ManagedProcessIdentity[];
    try {
      processTree = await snapshotManagedProcessTree(pid);
    } catch (error) {
      throw new Error(`LOGIN_PROCESS_TREE_INSPECTION_FAILED: ${safeErrorMessage(error)}`);
    }
    try {
      await terminateManagedProcessTree(processTree);
    } catch (error) {
      throw new Error(`LOGIN_PROCESS_TREE_CLEANUP_FAILED: ${safeErrorMessage(error)}`);
    }
    if (this.loginProcess === child) this.loginProcess = undefined;
    this.appendLog("helper", "Stopped the Codex browser login process during helper shutdown.");
  }

  private async startUnlocked(manualAttempt: boolean): Promise<MacOSHelperStatus> {
    if (this.closed) throw new Error("LIFECYCLE_CLOSED: The helper is shutting down.");
    await this.finishPendingProcessCleanup();
    this.reconcileManagedRuntime();
    if (this.isManagedRuntimeRunning()) return this.snapshot();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = undefined;
    }
    if (manualAttempt) {
      this.unexpectedExits = [];
      this.restartAttempt = 0;
    }
    if (await this.adoptExistingRuntime()) return this.snapshot();

    await this.selectedCliManager().applyPending(this.executingLifecycle?.target.cli as { revision: number; command: string | null } | undefined);

    await this.assertEnvironmentLocation();
    const configuration = inspectRuntimeEnvFile(this.envFile);
    if (!configuration.valid) {
      throw new Error(`SETUP_REQUIRED: ${configuration.issue || "Runtime configuration is missing."}`);
    }
    if (!existsSync(this.launcherPath)) {
      throw new Error(`BRIDGE_RUNTIME_MISSING: Launcher not found at ${this.launcherPath}`);
    }
    if (!existsSync(path.join(this.bridgeRoot, "dist", "cli.js"))) {
      throw new Error("BRIDGE_RUNTIME_MISSING: Built HTTP runtime is not installed.");
    }

    this.manualStop = false;
    this.phase = "starting";
    this.lifecyclePhaseReporter?.("reconnecting");
    this.lastError = null;
    this.appendLog("helper", "Starting the app-managed bridge and Secure MCP Tunnel runtime.");
    const launcherArguments = [
      this.launcherPath,
      "--mode",
      "secure",
      "--transport",
      MACOS_MANAGED_TUNNEL_TRANSPORT,
      "--env-file",
      this.envFile,
      "--require-built",
      "--runtime-status-file",
      this.runtimeStatusFile,
      "--runtime-lock-directory",
      this.runtimeLockDirectory,
      "--profile",
      MACOS_MANAGED_TUNNEL_PROFILE
    ];
    if (!existsSync(this.profileRebuildMarker)) launcherArguments.push("--reuse-profile");
    const child = spawn(process.execPath, launcherArguments, {
      cwd: this.bridgeRoot,
      env: runtimeEnvironment(this.envFile, this.bridgeSocketPath),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const outputCapture = createRuntimeOutputCapture();
    this.child = child;
    this.managedPid = child.pid;
    this.startedAt = new Date().toISOString();
    child.stdout?.on("data", (chunk: Buffer) =>
      this.captureRuntimeOutput(outputCapture, "stdout", chunk)
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      this.captureRuntimeOutput(outputCapture, "stderr", chunk)
    );
    child.once("close", () => this.flushRuntimeOutput(outputCapture));
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.lastError = safeErrorMessage(error);
      this.appendLog("runtime", this.lastError);
    });
    child.once("exit", (code, signal) => this.observeExit(child, code, signal));

    try {
      await waitForManagedRuntime(
        this.bridgeSocketPath,
        this.runtimeStatusFile,
        child,
        BRIDGE_BUILD_INFO.id,
        this.startTimeoutMs
      );
      if (this.child === child && isChildRunning(child)) {
        this.phase = "running";
        removePrivateMarker(this.profileRebuildMarker);
        this.scheduleStabilityReset(child.pid);
        this.appendLog("helper", "The bridge companion and Secure MCP Tunnel are ready.");
      }
    } catch (error) {
      this.lastError = safeErrorMessage(error);
      this.appendLog("helper", this.lastError);
      this.manualStop = true;
      if (isChildRunning(child)) {
        child.kill("SIGTERM");
        const exited = await waitForExit(child, MANAGED_LAUNCHER_SHUTDOWN_TIMEOUT_MS);
        if (!exited && isChildRunning(child)) {
          killManagedRuntimeGroup(child, "SIGKILL");
          await waitForExit(child, 2_000);
        }
      }
      if (this.child === child) this.child = undefined;
      if (this.managedPid === child.pid) this.managedPid = undefined;
      this.phase = "stopped";
      this.startedAt = null;
      throw error;
    }
    return this.snapshot();
  }

  private async stopUnlocked(options: {
    mode: "drain" | "force";
    timeoutMs: number;
    protectMemory?: boolean;
  }): Promise<MacOSHelperStatus> {
    options = { ...options, protectMemory: options.mode === "drain" };
    if (this.executingLifecycle) await this.validateLifecycleTarget(this.executingLifecycle);
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = undefined;
    }
    this.reconcileManagedRuntime();
    if (!this.isManagedRuntimeRunning()) {
      await this.adoptExistingRuntime();
    }
    const child = this.child;
    const managedPid = this.managedPid;
    if (!managedPid || !processIsAlive(managedPid)) {
      await this.finishPendingProcessCleanup();
      this.phase = "stopped";
      this.child = undefined;
      this.managedPid = undefined;
      this.lastError = null;
      return this.snapshot();
    }

    this.manualStop = true;
    this.phase = options.mode === "drain" ? "draining" : "stopping";
    this.changed("runtime");
    let drainStarted = false;
    try {
      const state = await bridgeRequest<RuntimeAdmissionSnapshot>(
        this.bridgeSocketPath,
        "runtime.beginDrain",
        { inspectBackgroundProcesses: false }
      );
      drainStarted = true;
      if (options.mode === "drain") {
        const deadline = Date.now() + options.timeoutMs;
        let activeJobs = state.activeJobs;
        let pendingAdmissions = state.pendingAdmissions || 0;
        while (activeJobs + pendingAdmissions > 0 && Date.now() < deadline) {
          await delay(500);
          const current = await bridgeRequest<RuntimeAdmissionSnapshot>(
            this.bridgeSocketPath,
            "runtime.snapshot",
            {}
          );
          activeJobs = current.activeJobs;
          pendingAdmissions = current.pendingAdmissions || 0;
        }
        if (activeJobs + pendingAdmissions > 0) {
          throw new Error(
            `DRAIN_TIMEOUT: ${activeJobs} active job(s) and ${pendingAdmissions} pending admission(s) did not finish before the timeout.`
          );
        }
        const impact = await bridgeRequest<RuntimeAdmissionSnapshot>(
          this.bridgeSocketPath,
          "runtime.snapshot",
          { inspectBackgroundProcesses: true },
          15_000
        );
        if (options.protectMemory && ((impact.memoryOnlyThreads || 0) > 0 || (impact.pendingInteractions || 0) > 0)) {
          throw new Error("CODEX_APPLY_PENDING: Memory-only agents or pending interactions still require the running environment. Archive or resolve them before applying this change.");
        }
        if (
          impact.backgroundProcessState !== "confirmed" ||
          impact.backgroundProcessUnknownAgents > 0
        ) {
          throw new Error(
            `BACKGROUND_PROCESS_STATE_UNKNOWN: Could not verify background processes for ${impact.backgroundProcessUnknownAgents || 1} agent(s). Use force only after reviewing the global status card.`
          );
        }
        if (impact.backgroundProcesses > 0) {
          throw new Error(
            `BACKGROUND_PROCESSES_ACTIVE: ${impact.backgroundProcesses} background process(es) across ${impact.backgroundProcessAgents} agent(s) would be interrupted. Use force only after reviewing the global status card.`
          );
        }
      } else if (options.protectMemory) {
        await this.assertRuntimeChangeSafe();
      }
    } catch (error) {
      if (options.mode === "drain" || options.protectMemory) {
        const failureMessage = safeErrorMessage(error);
        this.lastError = failureMessage;
        this.appendLog("helper", `Graceful runtime stop was blocked: ${failureMessage}`);
        const stillRunning = processIsAlive(managedPid);
        if (stillRunning) {
          try {
            // beginDrain may have reached the bridge even when its response was
            // lost. Always cancel on a failed graceful stop before reporting
            // that the existing runtime is available again.
            await bridgeRequest(this.bridgeSocketPath, "runtime.cancelDrain", {});
          } catch (cancelError) {
            this.phase = "safe-mode";
            this.manualStop = false;
            this.lastError = `DRAIN_CANCEL_FAILED: ${safeErrorMessage(cancelError)}`;
            this.appendLog("helper", this.lastError);
            throw new Error(`${failureMessage} ${this.lastError}`);
          }
        }
        this.phase = stillRunning ? "running" : "stopped";
        this.manualStop = stillRunning ? false : this.manualStop;
        this.changed("runtime");
        throw error;
      }
      this.appendLog("helper", `Force stop continuing without a drain acknowledgement: ${safeErrorMessage(error)}`);
    }

    let managedProcessTree: ManagedProcessIdentity[];
    try {
      managedProcessTree = await snapshotManagedProcessTree(managedPid);
      this.pendingProcessCleanup = managedProcessTree;
    } catch (error) {
      if (drainStarted) {
        await bridgeRequest(this.bridgeSocketPath, "runtime.cancelDrain", {}).catch(() => undefined);
      }
      this.phase = "running";
      this.manualStop = false;
      throw new Error(`RUNTIME_TREE_INSPECTION_FAILED: ${safeErrorMessage(error)}`);
    }

    this.phase = "stopping";
    this.appendLog(
      "helper",
      options.mode === "drain"
        ? "Active work drained; stopping the managed runtime."
        : "Force-stopping the managed runtime; active work may be interrupted."
    );
    killManagedRuntimePid(managedPid, "SIGTERM");
    const exited = child && child.pid === managedPid
      ? await waitForExit(child, MANAGED_LAUNCHER_SHUTDOWN_TIMEOUT_MS)
      : await waitForPidExit(managedPid, MANAGED_LAUNCHER_SHUTDOWN_TIMEOUT_MS);
    if (!exited && processIsAlive(managedPid)) {
      killManagedRuntimePid(managedPid, "SIGKILL");
      const killed = child && child.pid === managedPid
        ? await waitForExit(child, 2_000)
        : await waitForPidExit(managedPid, 2_000);
      if (!killed && processIsAlive(managedPid)) {
        if (drainStarted) {
          await bridgeRequest(this.bridgeSocketPath, "runtime.cancelDrain", {}).catch(() => undefined);
        }
        throw new Error("RUNTIME_STOP_FAILED: Managed runtime did not exit after SIGKILL.");
      }
    }
    if (drainStarted && processIsAlive(managedPid)) {
      await bridgeRequest(this.bridgeSocketPath, "runtime.cancelDrain", {}).catch(() => undefined);
    }
    await this.finishPendingProcessCleanup();
    if (this.child === child) this.child = undefined;
    if (this.managedPid === managedPid) this.managedPid = undefined;
    this.phase = "stopped";
    this.startedAt = null;
    this.lastError = null;
    return this.snapshot();
  }

  private async finishPendingProcessCleanup(): Promise<void> {
    if (this.pendingProcessCleanup.length === 0) return;
    try {
      await terminateManagedProcessTree(this.pendingProcessCleanup);
      this.pendingProcessCleanup = [];
    } catch (error) {
      this.phase = "safe-mode";
      this.lastError = `RUNTIME_TREE_CLEANUP_FAILED: ${safeErrorMessage(error)}`;
      this.appendLog("helper", this.lastError);
      throw new Error(this.lastError);
    }
  }

  private async adoptExistingRuntime(): Promise<boolean> {
    const owner = readRuntimeLockOwner(this.runtimeLockDirectory);
    const legacyOwner = this.legacyRuntimeLockDirectory === this.runtimeLockDirectory
      ? null
      : readRuntimeLockOwner(this.legacyRuntimeLockDirectory);
    if (
      legacyOwner &&
      processIsAlive(legacyOwner.pid) &&
      legacyOwner.pid !== owner?.pid
    ) {
      throw new Error(
        `LEGACY_RUNTIME_DETECTED: Runtime pid ${legacyOwner.pid} is still using the previous alternate-dotenv lock. Stop the previous CLI bridge, then retry.`
      );
    }
    if (!owner) {
      const legacyCompanion = await readCompanionHello(this.bridgeSocketPath);
      if (legacyCompanion) {
        throw new Error(
          "LEGACY_RUNTIME_DETECTED: A bridge started outside the macOS app is still using the app socket. Stop the previous CLI bridge, then retry."
        );
      }
      return false;
    }
    if (!processIsAlive(owner.pid)) return false;

    const runtime = readManagedRuntimeStatus(this.runtimeStatusFile);
    const companion = await readCompanionHello(this.bridgeSocketPath);
    const valid = Boolean(
      runtime &&
      !runtime.stale &&
      runtime.launcherPid === owner.pid &&
      runtime.runtimeBuildId === BRIDGE_BUILD_INFO.id &&
      runtime.phase === "running" &&
      runtime.tunnel.profile === MACOS_MANAGED_TUNNEL_PROFILE &&
      runtime.tunnel.transport === MACOS_MANAGED_TUNNEL_TRANSPORT &&
      companion &&
      companion.protocol.name === COMPANION_PROTOCOL_NAME &&
      companion.protocol.version === COMPANION_PROTOCOL_VERSION &&
      companion.bridge.buildId === BRIDGE_BUILD_INFO.id
    );
    if (!valid) {
      throw new Error(
        `RUNTIME_OWNERSHIP_CONFLICT: Runtime pid ${owner.pid} holds the per-user lock but cannot be safely adopted. Stop the previous bridge process, then retry.`
      );
    }

    this.child = undefined;
    this.managedPid = owner.pid;
    this.startedAt = owner.startedAt;
    this.phase = "running";
    this.manualStop = false;
    this.lastError = null;
    this.scheduleStabilityReset(owner.pid);
    this.appendLog(
      "helper",
      `Adopted the existing app-managed runtime after helper recovery (pid ${owner.pid}).`
    );
    return true;
  }

  private isManagedRuntimeRunning(): boolean {
    return Boolean(this.managedPid && processIsAlive(this.managedPid));
  }

  private reconcileManagedRuntime(): void {
    if (!this.managedPid || processIsAlive(this.managedPid)) return;
    const exitedPid = this.managedPid;
    this.managedPid = undefined;
    this.child = undefined;
    this.startedAt = null;
    if (this.manualStop || this.phase === "stopped") {
      if (this.phase !== "safe-mode") this.phase = "stopped";
      return;
    }
    this.lastExit = {
      at: new Date().toISOString(),
      code: null,
      signal: null
    };
    this.lastError = `Managed runtime pid ${exitedPid} exited unexpectedly.`;
    this.appendLog("runtime", this.lastError);
    this.scheduleAutomaticRestart();
  }

  private observeExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.closed || this.child !== child) return;
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = undefined;
    }
    this.child = undefined;
    if (this.managedPid === child.pid) this.managedPid = undefined;
    this.startedAt = null;
    this.lastExit = { at: new Date().toISOString(), code, signal };
    this.changed("runtime");
    this.appendLog("runtime", `Managed runtime exited (${code ?? signal ?? "unknown"}).`);
    if (this.manualStop) {
      this.phase = "stopped";
      return;
    }
    this.lastError = `Managed runtime exited unexpectedly (${code ?? signal ?? "unknown"}).`;
    try {
      killManagedRuntimeGroup(child, "SIGKILL");
    } catch (error) {
      this.lastError = `RUNTIME_TREE_CLEANUP_FAILED: ${safeErrorMessage(error)}`;
      this.phase = "safe-mode";
      this.appendLog("helper", this.lastError);
      return;
    }
    this.scheduleAutomaticRestart();
  }

  private scheduleAutomaticRestart(): void {
    if (this.closed) return;
    if (this.lifecycleManager?.active) { this.lifecycleManager.signal(); return; }
    const now = Date.now();
    this.unexpectedExits = this.unexpectedExits.filter((at) => now - at <= CRASH_WINDOW_MS);
    this.unexpectedExits.push(now);
    this.restartAttempt = this.unexpectedExits.length;
    if (!this.autoRestart || this.restartAttempt > MAX_AUTOMATIC_RESTARTS) {
      this.phase = "safe-mode";
      this.appendLog("helper", "Automatic restart stopped after repeated runtime crashes.");
      return;
    }
    this.phase = "backoff";
    const backoffMs = 1_000 * (2 ** (this.restartAttempt - 1));
    this.appendLog("helper", `Retrying the runtime after ${backoffMs / 1_000}s backoff.`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closed || this.manualStop || this.lifecycleManager?.active) { this.lifecycleManager?.signal(); return; }
      void this.exclusive(() => this.startUnlocked(false)).catch((error) => {
        this.lastError = safeErrorMessage(error);
        if (this.phase !== "safe-mode" && !this.restartTimer) this.scheduleAutomaticRestart();
      });
    }, backoffMs);
    this.restartTimer.unref();
  }

  private scheduleStabilityReset(pid: number | undefined): void {
    if (!pid) return;
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = undefined;
      if (this.managedPid !== pid || !processIsAlive(pid) || this.phase !== "running") return;
      this.unexpectedExits = [];
      this.restartAttempt = 0;
      this.appendLog("helper", "Managed runtime remained stable; crash backoff was reset.");
    }, CRASH_WINDOW_MS);
    this.stabilityTimer.unref();
  }

  private captureRuntimeOutput(
    capture: RuntimeOutputCapture,
    stream: RuntimeOutputStream,
    chunk: Buffer
  ): void {
    let pending = Buffer.concat([capture.buffers[stream], chunk]);
    capture.buffers[stream] = Buffer.alloc(0);
    while (pending.length > 0) {
      const newline = pending.indexOf(0x0a);
      if (capture.discarding.has(stream)) {
        if (newline < 0) return;
        capture.discarding.delete(stream);
        pending = pending.subarray(newline + 1);
        continue;
      }
      if (newline >= 0) {
        if (newline > MAX_RUNTIME_LOG_LINE_BYTES) {
          this.appendLog("runtime", "Oversized runtime log line omitted.");
        } else {
          this.appendRuntimeLogLine(pending.subarray(0, newline));
        }
        pending = pending.subarray(newline + 1);
        continue;
      }
      if (pending.length > MAX_RUNTIME_LOG_LINE_BYTES) {
        capture.discarding.add(stream);
        this.appendLog("runtime", "Oversized runtime log line omitted.");
        return;
      }
      capture.buffers[stream] = Buffer.from(pending);
      return;
    }
  }

  private flushRuntimeOutput(capture: RuntimeOutputCapture): void {
    for (const stream of ["stdout", "stderr"] as const) {
      if (!capture.discarding.has(stream) && capture.buffers[stream].length > 0) {
        this.appendRuntimeLogLine(capture.buffers[stream]);
      }
      capture.buffers[stream] = Buffer.alloc(0);
      capture.discarding.delete(stream);
    }
  }

  private appendRuntimeLogLine(line: Buffer): void {
    const withoutCarriageReturn = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    const message = redactRuntimeText(withoutCarriageReturn.toString("utf8"));
    if (message) this.appendLog("runtime", message);
  }

  private appendLog(source: MacOSHelperLogEntry["source"], message: string): void {
    const safe = redactRuntimeText(message);
    if (!safe) return;
    this.logEntries.append({ at: new Date().toISOString(), source, message: safe });
    if (source === "helper") this.changed("runtime");
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}

export async function startMacOSHelperServer(options: {
  socketPath: string;
  controller: MacOSHelperController;
}): Promise<BridgeCompanionServer> {
  const changes = new ChangeSignal(["runtime", "configuration", "auth", "installation"]);
  const unsubscribe = options.controller.subscribeChanges?.(topic => changes.notify(topic));
  const server = await startPrivateJsonLineServer({
    socketPath: options.socketPath,
    maxRequestBytes: HELPER_MAX_REQUEST_BYTES,
    maxResponseBytes: HELPER_MAX_RESPONSE_BYTES,
    maxClients: 8,
    dispatch: (line, signal) => dispatchHelperLine(line, options.controller, unsubscribe ? changes : undefined, signal),
    requestTooLarge: () => helperError(null, -32600, "Helper request is too large."),
    internalError: (error) => helperError(null, -32603, safeErrorMessage(error))
  }).catch(error => { unsubscribe?.(); changes.close(); throw error; });
  return { socketPath: server.socketPath, close: async () => { unsubscribe?.(); changes.close(); await server.close(); } };
}

async function dispatchHelperLine(
  line: string,
  controller: MacOSHelperController,
  changes?: ChangeSignal,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return helperError(null, -32700, "Invalid JSON.");
  }
  const parsed = helperRequestSchema.safeParse(decoded);
  if (!parsed.success) {
    return helperError(helperRequestId(decoded), -32600, "Invalid helper request.");
  }
  const request = parsed.data;
  try {
    let result: unknown;
    switch (request.method) {
      case "helper.hello":
        emptyParamsSchema.parse(request.params || {});
        result = {
          protocol: {
            name: MACOS_HELPER_PROTOCOL_NAME,
            version: MACOS_HELPER_PROTOCOL_VERSION
          },
          runtime: {
            buildId: BRIDGE_BUILD_INFO.id,
            version: BRIDGE_BUILD_INFO.version
          },
          capabilities: [
            "runtime.read",
            ...(controller.requestLifecycle ? ["lifecycle.reservations.v1"] : []),
            "runtime.start",
            "runtime.stop",
            "runtime.restart",
            "runtime.configure",
            "runtime.repair-profile",
            "runtime.logs.redacted",
            "helper.prepare-shutdown",
            "setup.discovery.import",
            "setup.dotenv.atomic-apply",
            "setup.dotenv.repair-permissions",
            "auth.codex-browser-login"
          ],
          status: await controller.snapshot()
        };
        break;
      case "changes.wait": {
        if (!changes) throw new Error("CHANGES_UNSUPPORTED");
        const params = changeWaitParamsSchema.parse(request.params || {});
        result = await changes.wait(params.after, params.waitMs, signal);
        break;
      }
      case "helper.health":
        emptyParamsSchema.parse(request.params || {});
        result = await (controller.health?.() || controller.snapshot());
        break;
      case "helper.status":
        emptyParamsSchema.parse(request.params || {});
        result = await controller.snapshot();
        break;
      case "lifecycle.request":
        if (!controller.requestLifecycle) throw new Error("LIFECYCLE_UNSUPPORTED");
        result = await controller.requestLifecycle(lifecycleRequestSchema.parse(request.params || {}));
        break;
      case "lifecycle.status": {
        if (!controller.lifecycleStatus) throw new Error("LIFECYCLE_UNSUPPORTED");
        const params = z.strictObject({ requestId: z.string().uuid().optional() }).parse(request.params || {});
        result = { operation: controller.lifecycleStatus(params.requestId) };
        break;
      }
      case "lifecycle.cancel": case "lifecycle.acknowledge": {
        const params = z.strictObject({ requestId: z.string().uuid() }).parse(request.params || {});
        const action = request.method === "lifecycle.cancel" ? controller.cancelLifecycle : controller.acknowledgeLifecycle;
        if (!action) throw new Error("LIFECYCLE_UNSUPPORTED");
        result = action.call(controller, params.requestId);
        break;
      }
      case "helper.prepare-shutdown":
        result = await controller.prepareShutdown(stopParamsSchema.parse(request.params || {}));
        break;
      case "setup.discover":
        emptyParamsSchema.parse(request.params || {});
        result = await controller.discoverSetup();
        break;
      case "setup.import":
        result = await controller.importSetup(setupImportParamsSchema.parse(request.params || {}));
        break;
      case "setup.apply":
        result = await controller.applyConfiguration(setupApplyParamsSchema.parse(request.params || {}));
        break;
      case "setup.repair-permissions":
        emptyParamsSchema.parse(request.params || {});
        result = await controller.repairConfigurationPermissions();
        break;
      case "auth.status":
        emptyParamsSchema.parse(request.params || {});
        result = await controller.authStatus();
        break;
      case "auth.login":
        emptyParamsSchema.parse(request.params || {});
        result = await controller.startLogin();
        break;
      case "runtime.start":
        emptyParamsSchema.parse(request.params || {});
        result = await controller.start();
        break;
      case "runtime.stop":
        result = await controller.stop(stopParamsSchema.parse(request.params || {}));
        break;
      case "runtime.restart":
        result = await controller.restart(restartParamsSchema.parse(request.params || {}));
        break;
      case "runtime.configure":
        result = await controller.applyConfiguration(
          runtimeConfigureParamsSchema.parse(request.params || {})
        );
        break;
      case "codex.runtime":
        if (!controller.codexRuntime) throw new Error("Codex runtime management is unavailable in this helper.");
        result = await controller.codexRuntime(codexRuntimeParamsSchema.parse(request.params || {}));
        break;

      case "runtime.repair":
        result = await controller.repair(restartParamsSchema.parse(request.params || {}));
        break;
      case "runtime.logs": {
        const params = logsParamsSchema.parse(request.params || {});
        result = { entries: controller.logs(params.limit) };
        break;
      }
    }
    if (["runtime.start", "runtime.stop", "runtime.restart", "runtime.repair", "helper.prepare-shutdown"].includes(request.method)) changes?.notify("runtime");
    if (["setup.apply", "setup.import", "setup.repair-permissions", "runtime.configure"].includes(request.method)) changes?.notify("configuration");
    if (request.method === "codex.runtime" && (request.params as { action?: string })?.action !== "status") changes?.notify("installation");
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    return helperError(request.id, -32602, safeErrorMessage(error));
  }
}

type RuntimeAdmissionSnapshot = {
  acceptingNewJobs: boolean;
  activeJobs: number;
  pendingAdmissions: number;
  pendingInteractions?: number;
  memoryOnlyThreads?: number;
  backgroundProcessState: "confirmed" | "unknown";
  backgroundProcesses: number;
  backgroundProcessAgents: number;
  backgroundProcessUnknownAgents: number;
};

type CompanionHello = z.infer<typeof companionHelloSchema>;

function normalizeTunnelStatus(
  runtime: ReturnType<typeof readManagedRuntimeStatus>,
  childPid: number | null,
  expectedBuildId: string
): MacOSHelperStatus["tunnel"] {
  const unavailable: MacOSHelperStatus["tunnel"] = {
    phase: childPid === null ? "stopped" : "unknown",
    profile: null,
    transport: null,
    doctorPassed: false,
    processRunning: false,
    connected: false,
    lastCheckedAt: null,
    lastError: null,
    lastProblem: null
  };
  if (!runtime) return unavailable;
  const belongsToChild = childPid !== null && runtime.launcherPid === childPid;
  const buildMatches = runtime.runtimeBuildId === expectedBuildId;
  const tunnel = runtime.tunnel as ManagedTunnelStatus;
  const identityMatches = tunnel.profile === MACOS_MANAGED_TUNNEL_PROFILE &&
    tunnel.transport === MACOS_MANAGED_TUNNEL_TRANSPORT;
  const current = belongsToChild && buildMatches && identityMatches && !runtime.stale;
  return {
    phase: current ? tunnel.phase : childPid === null ? "stopped" : "stale",
    profile: tunnel.profile,
    transport: tunnel.transport,
    doctorPassed: current && tunnel.doctorPassed,
    processRunning: current && tunnel.processRunning,
    connected: current && tunnel.processRunning && tunnel.connected,
    lastCheckedAt: tunnel.lastCheckedAt,
    lastError: current
      ? tunnel.lastError && safeErrorMessage(tunnel.lastError)
      : childPid === null
        ? null
        : !belongsToChild
          ? "Tunnel status belongs to a previous launcher process."
          : !buildMatches
            ? "Tunnel status belongs to a different runtime build."
            : !identityMatches
              ? "Tunnel status belongs to a different managed profile or transport."
              : "Tunnel status is stale.",
    lastProblem: current
      ? tunnel.lastProblem ?? tunnelStatusProblem(tunnel.lastError)
      : childPid === null
        ? null
        : !belongsToChild
          ? statusProblem("tunnel-status-previous-launcher")
          : !buildMatches
            ? statusProblem("tunnel-status-different-build")
            : !identityMatches
              ? statusProblem("tunnel-status-different-profile")
              : statusProblem("tunnel-status-stale")
  };
}

function statusProblem(
  code: string,
  arguments_: Record<string, string> = {}
): StatusProblem {
  return { code, arguments: arguments_ };
}

function normalizedProblemCode(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

function stableProblemCode(message: string): string | undefined {
  const prefixed = message.match(/^([A-Z][A-Z0-9_]{2,79})(?::|$)/)?.[1];
  return prefixed ? normalizedProblemCode(prefixed) : undefined;
}

function helperStatusProblem(message: string | null): StatusProblem | null {
  if (!message) return null;
  const stableCode = stableProblemCode(message);
  if (stableCode) return statusProblem(stableCode);
  const exitedPid = message.match(/^Managed runtime pid (\d+) exited unexpectedly\./)?.[1];
  if (exitedPid) return statusProblem("managed-runtime-exited", { pid: exitedPid });
  if (message.startsWith("Managed runtime exited unexpectedly")) {
    return statusProblem("managed-runtime-exited");
  }
  if (message.includes("before the bridge and tunnel became ready")) {
    return statusProblem("runtime-readiness-exited");
  }
  if (message.includes("Timed out waiting for the bridge companion")) {
    return statusProblem("runtime-readiness-timeout");
  }
  return statusProblem("helper-operation-failed");
}

function tunnelStatusProblem(message: string | null | undefined): StatusProblem | null {
  if (!message) return null;
  if (message === "Waiting for a successful control-plane poll.") {
    return statusProblem("tunnel-connection-pending");
  }
  if (message === "The tunnel-client process exited unexpectedly.") {
    return statusProblem("tunnel-process-exited");
  }
  if (message === "The tunnel-client process is not running.") {
    return statusProblem("tunnel-process-not-running");
  }
  if (message.startsWith("The tunnel readiness probe is failing")) {
    return statusProblem("tunnel-readiness-probe-failed");
  }
  return statusProblem("tunnel-health-probe-failed");
}

function runtimeConfigurationProblem(message: string): StatusProblem {
  if (message.includes("RUNTIME_ENV_PROJECT_CONFLICT")) {
    return statusProblem("runtime-env-project-conflict");
  }
  if (message.includes("permissions are too broad")) {
    return statusProblem("runtime-env-permissions-too-broad");
  }
  if (message.includes("regular, non-symlink") || message.includes("regular directory")) {
    return statusProblem("runtime-env-not-regular");
  }
  if (message.includes("owned by the current user")) {
    return statusProblem("runtime-env-owner-mismatch");
  }
  return statusProblem("runtime-env-invalid");
}

function helperError(
  id: string | number | null,
  code: number,
  message: string
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function helperRequestId(value: unknown): string | number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return requestIdSchema.safeParse(id).success ? id as string | number : null;
}

async function readBridgeHealth(
  socketPath: string,
  onFailure: (error: unknown) => void
): Promise<RuntimeAdmissionSnapshot | null> {
  try {
    return await bridgeRequest<RuntimeAdmissionSnapshot>(socketPath, "runtime.health", {}, 2_000);
  } catch (error) {
    // Only an older companion's explicit method rejection permits the legacy
    // snapshot fallback. A slow health response must not start heavier work.
    const code = (error as { code?: number }).code;
    if (code === -32600 || code === -32601) {
      return readBridgeAdmission(socketPath, 2_000, onFailure);
    }
    onFailure(error);
    return null;
  }
}

async function readBridgeAdmission(
  socketPath: string,
  timeoutMs = 500,
  onFailure?: (error: unknown) => void
): Promise<RuntimeAdmissionSnapshot | null> {
  try {
    return await bridgeRequest<RuntimeAdmissionSnapshot>(
      socketPath,
      "runtime.snapshot",
      {},
      timeoutMs
    );
  } catch (error) {
    onFailure?.(error);
    return null;
  }
}

async function readCompanionHello(socketPath: string): Promise<CompanionHello | null> {
  try {
    const result = await bridgeRequest<unknown>(
      socketPath,
      "companion.hello",
      {},
      1_000
    );
    const parsed = companionHelloSchema.safeParse(result);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function waitForManagedRuntime(
  socketPath: string,
  runtimeStatusFile: string,
  child: ChildProcess,
  expectedBuildId: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("RUNTIME_READINESS_EXITED: Managed runtime exited before the bridge and tunnel became ready.");
    }
    const bridge = await readBridgeAdmission(socketPath, 2_000);
    const tunnel = normalizeTunnelStatus(
      readManagedRuntimeStatus(runtimeStatusFile),
      child.pid || null,
      expectedBuildId
    );
    if (bridge && tunnel.connected) return;
    await delay(250);
  }
  throw new Error("RUNTIME_READINESS_TIMEOUT: Timed out waiting for the bridge companion and Secure MCP Tunnel readiness.");
}

function bridgeRequest<T = unknown>(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5_000,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const requestId = `helper-${process.pid}-${Date.now()}-${++bridgeRequestSequence}`;
    let buffer = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(new Error("CHANGE_WAIT_CANCELLED"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => finish(new Error("Bridge companion request timed out.")),
      timeoutMs
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params
      })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > HELPER_MAX_RESPONSE_BYTES) {
        finish(new Error("Bridge companion response is too large."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as {
          jsonrpc?: unknown;
          id?: unknown;
          result?: T;
          error?: { message?: string; code?: number };
        };
        if (response.jsonrpc !== "2.0" || response.id !== requestId) {
          finish(new Error("Bridge companion response identity did not match the request."));
        } else if (response.error) finish(Object.assign(new Error(response.error.message || "Bridge companion request failed."), { code: response.error.code }));
        else finish(undefined, response.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      finish(new Error("Bridge companion closed the connection without a response."));
    });
  });
}

let bridgeRequestSequence = 0;

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isChildRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await delay(100);
  }
  return !processIsAlive(pid);
}

function isChildRunning(child: ChildProcess | undefined): child is ChildProcess {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function snapshotManagedProcessTree(rootPid: number): Promise<ManagedProcessIdentity[]> {
  if (process.platform === "win32") {
    return [{ pid: rootPid, parentPid: 0, processGroupId: rootPid }];
  }
  const rows = await readProcessTable();
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) {
    if (!processIsAlive(rootPid)) return [];
    throw new Error(`Managed runtime pid ${rootPid} is alive but absent from the process table.`);
  }
  const children = new Map<number, ManagedProcessIdentity[]>();
  for (const row of rows) {
    const current = children.get(row.parentPid) || [];
    current.push(row);
    children.set(row.parentPid, current);
  }
  const managed: ManagedProcessIdentity[] = [];
  const pending = [rootPid];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    const row = rows.find((candidate) => candidate.pid === pid);
    if (row) managed.push(row);
    for (const child of children.get(pid) || []) pending.push(child.pid);
  }
  return managed;
}

async function terminateManagedProcessTree(
  captured: readonly ManagedProcessIdentity[]
): Promise<void> {
  if (captured.length === 0) return;
  let running = await matchingManagedProcesses(captured);
  if (running.length === 0) return;
  signalManagedProcessGroups(running, "SIGTERM");
  running = await waitForManagedProcesses(
    captured,
    MANAGED_PROCESS_TREE_TERM_TIMEOUT_MS
  );
  if (running.length === 0) return;
  signalManagedProcessGroups(running, "SIGKILL");
  running = await waitForManagedProcesses(
    captured,
    MANAGED_PROCESS_TREE_KILL_TIMEOUT_MS
  );
  if (running.length > 0) {
    throw new Error(
      `${running.length} captured process(es) remained after SIGKILL ` +
      `(pid ${running.map((entry) => entry.pid).join(", ")}).`
    );
  }
}

async function matchingManagedProcesses(
  captured: readonly ManagedProcessIdentity[]
): Promise<ManagedProcessIdentity[]> {
  if (process.platform === "win32") {
    return captured.filter((entry) => processIsAlive(entry.pid));
  }
  const current = new Map(
    (await readProcessTable()).map((entry) => [entry.pid, entry] as const)
  );
  return captured.filter((entry) => {
    const observed = current.get(entry.pid);
    return observed?.processGroupId === entry.processGroupId;
  });
}

async function waitForManagedProcesses(
  captured: readonly ManagedProcessIdentity[],
  timeoutMs: number
): Promise<ManagedProcessIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let running = await matchingManagedProcesses(captured);
  while (running.length > 0 && Date.now() < deadline) {
    await delay(50);
    running = await matchingManagedProcesses(captured);
  }
  return running;
}

function signalManagedProcessGroups(
  running: readonly ManagedProcessIdentity[],
  signal: NodeJS.Signals
): void {
  if (process.platform === "win32") {
    for (const entry of running) {
      try {
        process.kill(entry.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return;
  }
  const groups = new Set(running.map((entry) => entry.processGroupId));
  for (const processGroupId of groups) {
    if (processGroupId <= 1 || processGroupId === process.pid) {
      throw new Error(`Refusing to signal unsafe managed process group ${processGroupId}.`);
    }
    try {
      process.kill(-processGroupId, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

function readProcessTable(): Promise<ManagedProcessIdentity[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/ps", ["-axo", "pid=,ppid=,pgid="], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > PROCESS_TABLE_MAX_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (outputBytes > PROCESS_TABLE_MAX_BYTES) {
        reject(new Error("Process table output exceeded the private helper limit."));
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(detail || `/bin/ps exited with status ${code ?? "unknown"}.`));
        return;
      }
      try {
        const rows = Buffer.concat(stdout).toString("utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.split(/\s+/).map(Number))
          .map(([pid, parentPid, processGroupId]) => ({ pid, parentPid, processGroupId }))
          .filter((row): row is ManagedProcessIdentity =>
            Number.isSafeInteger(row.pid) && row.pid > 0 &&
            Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 &&
            Number.isSafeInteger(row.processGroupId) && row.processGroupId > 0
          );
        resolve(rows);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function killManagedRuntimePid(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function killManagedRuntimeGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function runtimeEnvironment(envFile: string, bridgeSocketPath: string): NodeJS.ProcessEnv {
  const environment = commandEnvironment(envFile);
  const explicitNames = new Set([
    "TUNNEL_CLIENT",
    "TUNNEL_CLIENT_PROFILE",
    "TUNNEL_CLIENT_PROFILE_DIR",
    "MCP_MAX_CONCURRENT_REQUESTS",
    "LOG_LEVEL"
  ]);
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (
        name.startsWith("CODEX_MCP_BRIDGE_") ||
        name.startsWith("CODEX_GPT_BRIDGE_") ||
        (name.startsWith("CONTROL_PLANE_") && name !== "CONTROL_PLANE_API_KEY") ||
        explicitNames.has(name)
      )
    ) {
      environment[name] = value;
    }
  }
  environment.CODEX_MCP_BRIDGE_ENV_FILE = envFile;
  environment.CODEX_MCP_BRIDGE_COMPANION_SOCKET = bridgeSocketPath;
  environment.CODEX_MCP_BRIDGE_MANAGED_BY_APP = "1";
  delete environment.CONTROL_PLANE_API_KEY;
  delete environment.CONTROL_PLANE_TUNNEL_ID;
  return environment;
}

function commandEnvironment(envFile?: string): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "CODEX_HOME",
    "CODEX_MCP_BRIDGE_RUNTIME_HOME",
    "CODEX_MCP_BRIDGE_CODEX",
    "CODEX_GPT_BRIDGE_CODEX"
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  if (envFile) {
    const fileValues = readRuntimeEnvSubset(envFile, [
      "CODEX_HOME",
      "CODEX_MCP_BRIDGE_CODEX",
      "CODEX_GPT_BRIDGE_CODEX"
    ]);
    for (const [name, value] of Object.entries(fileValues)) {
      if (environment[name] === undefined && process.env[name] === undefined) {
        environment[name] = value;
      }
    }
  }
  const home = process.env.HOME || "";
  const pathEntries = [
    process.env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? path.join(home, ".local", "bin") : undefined,
    home ? path.join(home, ".npm-global", "bin") : undefined,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ]
    .flatMap((entry) => entry?.split(path.delimiter) || [])
    .filter((entry, index, entries) => Boolean(entry) && entries.indexOf(entry) === index);
  environment.PATH = pathEntries.join(path.delimiter);
  return environment;
}

function resolveCommand(command: string, environment: NodeJS.ProcessEnv): string {
  const configured = environment.CODEX_MCP_BRIDGE_CODEX || environment.CODEX_GPT_BRIDGE_CODEX;
  return configured && command === "codex"
    ? configured
    : command;
}

function runCommandStatus(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ installed: boolean; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: "ignore"
    });
    let settled = false;
    const finish = (result: { installed: boolean; exitCode: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The timeout result is authoritative even if the process exited in
        // the narrow window before the signal was delivered.
      }
      if (settled) return;
      settled = true;
      reject(new Error("Codex login status check timed out."));
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        finish({ installed: false, exitCode: null });
      } else if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("exit", (code) => finish({ installed: true, exitCode: code }));
  });
}

function readRegisteredProjectRoots(
  envFile: string,
  options: { allowBroadReadOnlyPermissions?: boolean } = {}
): string[] {
  const fileValues = readRuntimeEnvSubset(envFile, [
    "CODEX_MCP_BRIDGE_STATE_DATABASE_FILE",
    "CODEX_GPT_BRIDGE_STATE_DATABASE_FILE",
    "CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE",
    "CODEX_GPT_BRIDGE_SETTINGS_STATE_FILE"
  ], options);
  const stateDatabaseFile = configuredRuntimePath(
    fileValues,
    "STATE_DATABASE_FILE",
    path.join(homedir(), ".codex-mcp-bridge", "state.sqlite")
  );
  if (existsSync(stateDatabaseFile)) {
    assertRegularStateFile(stateDatabaseFile);
    const database = new Database(stateDatabaseFile, {
      readonly: true,
      fileMustExist: true
    });
    try {
      const columns = database.pragma("table_info(projects)") as Array<{ name?: unknown }>;
      if (!columns.some((column) => column.name === "cwd")) {
        throw new Error("Project registry table is unavailable.");
      }
      const hasDeletedAt = columns.some((column) => column.name === "deleted_at");
      const rows = database.prepare(
        hasDeletedAt
          ? "SELECT cwd FROM projects WHERE deleted_at IS NULL"
          : "SELECT cwd FROM projects"
      ).all() as Array<{ cwd?: unknown }>;
      if (rows.some((row) => typeof row.cwd !== "string" || !path.isAbsolute(row.cwd))) {
        throw new Error("Project registry contains an invalid folder path.");
      }
      return [...new Set(rows.map((row) => row.cwd as string))];
    } finally {
      database.close();
    }
  }

  const settingsStateFile = configuredRuntimePath(
    fileValues,
    "SETTINGS_STATE_FILE",
    path.join(homedir(), ".codex-mcp-bridge", "settings.json")
  );
  if (!existsSync(settingsStateFile)) return [];
  assertRegularStateFile(settingsStateFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsStateFile, "utf8"));
  } catch {
    throw new Error("Could not inspect the registered project folders.");
  }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const registry = record.projectRegistry && typeof record.projectRegistry === "object"
    ? record.projectRegistry as Record<string, unknown>
    : undefined;
  const projects = Array.isArray(registry?.projects) ? registry.projects : [];
  const roots = projects.map((project) =>
    project && typeof project === "object" && !Array.isArray(project)
      ? (project as Record<string, unknown>).cwd
      : undefined
  );
  if (roots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
    throw new Error("Stored project registry contains an invalid folder path.");
  }
  return [...new Set(roots as string[])];
}

function configuredRuntimePath(
  fileValues: Record<string, string>,
  suffix: string,
  fallback: string
): string {
  const currentName = `CODEX_MCP_BRIDGE_${suffix}`;
  const legacyName = `CODEX_GPT_BRIDGE_${suffix}`;
  const configured = process.env[currentName] || process.env[legacyName] ||
    fileValues[currentName] || fileValues[legacyName];
  if (!configured) return fallback;
  if (!path.isAbsolute(configured)) {
    throw new Error(`${currentName} must be an absolute file path.`);
  }
  return path.resolve(configured);
}

function assertRegularStateFile(filePath: string): void {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Project registry state must be a regular, non-symlink file: ${filePath}`);
  }
}

function removePrivateMarker(filePath: string): void {
  if (!existsSync(filePath)) return;
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Profile rebuild marker must be a regular, non-symlink file: ${filePath}`);
  }
  unlinkSync(filePath);
}

function redactRuntimeText(value: string): string {
  return value
    // Runtime configuration deliberately accepts any non-whitespace suffix so
    // future API-key formats do not require an app update. Keep the log
    // boundary at least as broad as that validation contract.
    .replace(/sk-[^\s]{8,}/g, "[REDACTED_API_KEY]")
    .replace(/tunnel_[A-Za-z0-9_-]{8,}/g, "[REDACTED_TUNNEL_ID]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /(["'])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)\1\s*:\s*(["'])[^"'\r\n]*\3/gi,
      '$1$2$1:$3[REDACTED]$3'
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)\s*([:=])\s*[^\s,;]+/gi,
      "$1$2[REDACTED]"
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function safeErrorMessage(error: unknown): string {
  return redactRuntimeText(error instanceof Error ? error.message : String(error)) ||
    "macOS helper operation failed.";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createRuntimeOutputCapture(): RuntimeOutputCapture {
  return {
    buffers: {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0)
    },
    discarding: new Set()
  };
}
