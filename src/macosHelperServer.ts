import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync
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
import { writePrivateFileAtomic } from "../scripts/managed-file.mjs";
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
import { assertRuntimeEnvOutsideProjectRoots } from "./runtimeEnvProjectGuard.js";

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
    "helper.prepare-shutdown",
    "setup.apply",
    "setup.repair-permissions",
    "auth.status",
    "auth.login",
    "runtime.start",
    "runtime.stop",
    "runtime.restart",
    "runtime.configure",
    "runtime.repair",
    "runtime.logs"
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
const stopParamsSchema = z.strictObject({
  mode: z.enum(["drain", "force"]).default("drain"),
  timeoutMs: z.number().int().min(1_000).max(MAX_DRAIN_TIMEOUT_MS)
    .default(DEFAULT_DRAIN_TIMEOUT_MS)
});
const restartParamsSchema = stopParamsSchema;
const runtimeConfigureParamsSchema = z.strictObject({
  defaultBackend: z.enum(["app-server", "mcp-server"]),
  maximumAccess: z.enum(["read-only", "workspace-write", "full-access"]),
  mode: z.enum(["drain", "force"]).default("drain"),
  timeoutMs: z.number().int().min(1_000).max(MAX_DRAIN_TIMEOUT_MS)
    .default(DEFAULT_DRAIN_TIMEOUT_MS)
});
const logsParamsSchema = z.strictObject({
  limit: z.number().int().min(1).max(HELPER_LOG_LIMIT).default(100)
});
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

export type MacOSHelperStatus = {
  kind: "helper-status";
  generatedAt: string;
  phase: MacOSRuntimePhase;
  pid: number | null;
  startedAt: string | null;
  lastExit: { at: string; code: number | null; signal: string | null } | null;
  lastError: string | null;
  restartAttempt: number;
  configuration: RuntimeEnvStatus;
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
  };
};

export type CodexLoginStatus = {
  installed: boolean;
  authenticated: boolean;
  summary: string;
};

export type MacOSHelperController = {
  snapshot(): Promise<MacOSHelperStatus>;
  applyConfiguration(values: {
    apiKey?: string;
    tunnelId?: string;
    defaultBackend?: "app-server" | "mcp-server";
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
};

export class MacOSBridgeSupervisor implements MacOSHelperController {
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
  private readonly logEntries: MacOSHelperLogEntry[] = [];
  private operation: Promise<unknown> = Promise.resolve();

  constructor(options: MacOSBridgeSupervisorOptions) {
    this.bridgeRoot = path.resolve(options.bridgeRoot);
    this.envFile = path.resolve(options.envFile || defaultRuntimeEnvFile());
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
  }

  async snapshot(): Promise<MacOSHelperStatus> {
    this.reconcileManagedRuntime();
    const bridgeAdmission = await readBridgeAdmission(this.bridgeSocketPath);
    const configuration = await this.configurationStatus();
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
      restartAttempt: this.restartAttempt,
      configuration,
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

  applyConfiguration(values: {
    apiKey?: string;
    tunnelId?: string;
    defaultBackend?: "app-server" | "mcp-server";
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
        await this.stopUnlocked({ mode: values.mode, timeoutMs: values.timeoutMs });
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
      return {
        ...status,
        valid: false,
        issue: safeErrorMessage(error)
      };
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

  async authStatus(): Promise<CodexLoginStatus> {
    const environment = commandEnvironment(this.envFile);
    const result = await runCommandStatus(
      resolveCommand("codex", environment),
      ["login", "status"],
      environment,
      15_000
    );
    if (!result.installed) {
      return {
        installed: false,
        authenticated: false,
        summary: "Codex CLI is not installed or is not available in PATH."
      };
    }
    return {
      installed: true,
      authenticated: result.exitCode === 0,
      summary: result.exitCode === 0
        ? "Codex login is available."
        : "Codex login is required."
    };
  }

  startLogin(): Promise<{ started: true }> {
    return this.exclusive(async () => {
      if (isChildRunning(this.loginProcess)) {
        this.appendLog("helper", "The existing Codex browser login is still in progress.");
        return { started: true };
      }

      const environment = commandEnvironment(this.envFile);
      const child = spawn(resolveCommand("codex", environment), ["login"], {
        detached: true,
        env: environment,
        stdio: "ignore"
      });
      this.loginProcess = child;
      child.once("exit", () => {
        if (this.loginProcess === child) this.loginProcess = undefined;
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
        if (this.loginProcess === child) this.loginProcess = undefined;
        this.lastError = safeErrorMessage(error);
        this.appendLog("helper", `Codex login could not start: ${this.lastError}`);
        throw error;
      }
      this.appendLog("helper", "Codex browser login was requested.");
      return { started: true };
    });
  }

  start(): Promise<MacOSHelperStatus> {
    return this.exclusive(() => this.startUnlocked(true));
  }

  prepareShutdown(options: {
    mode: "drain" | "force";
    timeoutMs: number;
  }): Promise<MacOSHelperStatus> {
    return this.exclusive(() => this.prepareShutdownUnlocked(options));
  }

  stop(options: { mode: "drain" | "force"; timeoutMs: number }): Promise<MacOSHelperStatus> {
    return this.exclusive(() => this.stopUnlocked(options));
  }

  restart(options: { mode: "drain" | "force"; timeoutMs: number }): Promise<MacOSHelperStatus> {
    return this.exclusive(async () => {
      await this.stopUnlocked(options);
      return this.startUnlocked(true);
    });
  }

  repair(options: { mode: "drain" | "force"; timeoutMs: number }): Promise<MacOSHelperStatus> {
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
    return this.logEntries.slice(-Math.max(1, Math.min(HELPER_LOG_LIMIT, limit)));
  }

  async close(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    await this.exclusive(() => this.prepareShutdownUnlocked({ mode: "force", timeoutMs: 5_000 }));
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

    await this.assertEnvironmentLocation();
    const configuration = inspectRuntimeEnvFile(this.envFile);
    if (!configuration.valid) {
      throw new Error(`SETUP_REQUIRED: ${configuration.issue || "Runtime configuration is missing."}`);
    }
    if (!existsSync(this.launcherPath)) {
      throw new Error(`BRIDGE_RUNTIME_MISSING: Launcher not found at ${this.launcherPath}`);
    }
    if (!existsSync(path.join(this.bridgeRoot, "dist", "stdio.js"))) {
      throw new Error("BRIDGE_RUNTIME_MISSING: Built persistent-stdio runtime is not installed.");
    }

    this.manualStop = false;
    this.phase = "starting";
    this.lastError = null;
    this.appendLog("helper", "Starting the app-managed bridge and Secure MCP Tunnel runtime.");
    const launcherArguments = [
      this.launcherPath,
      "--mode",
      "secure",
      "--transport",
      "stdio",
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
  }): Promise<MacOSHelperStatus> {
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
      }
    } catch (error) {
      if (options.mode === "drain") {
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
      runtime.tunnel.transport === "stdio" &&
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
    if (this.child !== child) return;
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = undefined;
    }
    this.child = undefined;
    if (this.managedPid === child.pid) this.managedPid = undefined;
    this.startedAt = null;
    this.lastExit = { at: new Date().toISOString(), code, signal };
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
    this.logEntries.push({ at: new Date().toISOString(), source, message: safe });
    if (this.logEntries.length > HELPER_LOG_LIMIT) {
      this.logEntries.splice(0, this.logEntries.length - HELPER_LOG_LIMIT);
    }
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
  return startPrivateJsonLineServer({
    socketPath: options.socketPath,
    maxRequestBytes: HELPER_MAX_REQUEST_BYTES,
    maxResponseBytes: HELPER_MAX_RESPONSE_BYTES,
    maxClients: 8,
    dispatch: (line) => dispatchHelperLine(line, options.controller),
    requestTooLarge: () => helperError(null, -32600, "Helper request is too large."),
    internalError: (error) => helperError(null, -32603, safeErrorMessage(error))
  });
}

async function dispatchHelperLine(
  line: string,
  controller: MacOSHelperController
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
            "runtime.start",
            "runtime.stop",
            "runtime.restart",
            "runtime.configure",
            "runtime.repair-profile",
            "runtime.logs.redacted",
            "helper.prepare-shutdown",
            "setup.dotenv.atomic-apply",
            "setup.dotenv.repair-permissions",
            "auth.codex-browser-login"
          ],
          status: await controller.snapshot()
        };
        break;
      case "helper.status":
        emptyParamsSchema.parse(request.params || {});
        result = await controller.snapshot();
        break;
      case "helper.prepare-shutdown":
        result = await controller.prepareShutdown(stopParamsSchema.parse(request.params || {}));
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
      case "runtime.repair":
        result = await controller.repair(restartParamsSchema.parse(request.params || {}));
        break;
      case "runtime.logs": {
        const params = logsParamsSchema.parse(request.params || {});
        result = { entries: controller.logs(params.limit) };
        break;
      }
    }
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    return helperError(request.id, -32602, safeErrorMessage(error));
  }
}

type RuntimeAdmissionSnapshot = {
  acceptingNewJobs: boolean;
  activeJobs: number;
  pendingAdmissions: number;
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
    lastError: childPid === null
      ? null
      : "Managed tunnel status is not available yet."
  };
  if (!runtime) return unavailable;
  const belongsToChild = childPid !== null && runtime.launcherPid === childPid;
  const buildMatches = runtime.runtimeBuildId === expectedBuildId;
  const tunnel = runtime.tunnel as ManagedTunnelStatus;
  const identityMatches = tunnel.profile === MACOS_MANAGED_TUNNEL_PROFILE &&
    tunnel.transport === "stdio";
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
              : "Tunnel status is stale."
  };
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

async function readBridgeAdmission(
  socketPath: string
): Promise<RuntimeAdmissionSnapshot | null> {
  try {
    return await bridgeRequest<RuntimeAdmissionSnapshot>(
      socketPath,
      "runtime.snapshot",
      {},
      500
    );
  } catch {
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
      throw new Error("Managed runtime exited before the bridge and tunnel became ready.");
    }
    const bridge = await readBridgeAdmission(socketPath);
    const tunnel = normalizeTunnelStatus(
      readManagedRuntimeStatus(runtimeStatusFile),
      child.pid || null,
      expectedBuildId
    );
    if (bridge && tunnel.connected) return;
    await delay(250);
  }
  throw new Error("Timed out waiting for the bridge companion and Secure MCP Tunnel readiness.");
}

function bridgeRequest<T = unknown>(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5_000
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
      socket.destroy();
      if (error) reject(error);
      else resolve(value as T);
    };
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
          error?: { message?: string };
        };
        if (response.jsonrpc !== "2.0" || response.id !== requestId) {
          finish(new Error("Bridge companion response identity did not match the request."));
        } else if (response.error) finish(new Error(response.error.message || "Bridge companion request failed."));
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
