import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import * as z from "zod/v4";
import {
  defaultRuntimeEnvFile,
  inspectRuntimeEnvFile,
  updateRuntimeEnvFile,
  type RuntimeEnvStatus
} from "../scripts/runtime-env.mjs";
import {
  startPrivateJsonLineServer,
  type BridgeCompanionServer
} from "./companionServer.js";

export const MACOS_HELPER_PROTOCOL_NAME = "codex-mcp-bridge-macos-helper";
export const MACOS_HELPER_PROTOCOL_VERSION = 1;
const HELPER_MAX_REQUEST_BYTES = 256 * 1_024;
const HELPER_MAX_RESPONSE_BYTES = 512 * 1_024;
const HELPER_LOG_LIMIT = 200;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const MAX_DRAIN_TIMEOUT_MS = 5 * 60_000;
const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_AUTOMATIC_RESTARTS = 3;

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
    "setup.save",
    "auth.status",
    "auth.login",
    "runtime.start",
    "runtime.stop",
    "runtime.restart",
    "runtime.repair",
    "runtime.logs"
  ]),
  params: z.unknown().optional()
});
const emptyParamsSchema = z.strictObject({});
const setupSaveParamsSchema = z.strictObject({
  apiKey: z.string().max(4_096).optional(),
  tunnelId: z.string().max(200).optional()
});
const stopParamsSchema = z.strictObject({
  mode: z.enum(["drain", "force"]).default("drain"),
  timeoutMs: z.number().int().min(1_000).max(MAX_DRAIN_TIMEOUT_MS)
    .default(DEFAULT_DRAIN_TIMEOUT_MS)
});
const restartParamsSchema = stopParamsSchema;
const logsParamsSchema = z.strictObject({
  limit: z.number().int().min(1).max(HELPER_LOG_LIMIT).default(100)
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
  };
};

export type CodexLoginStatus = {
  installed: boolean;
  authenticated: boolean;
  summary: string;
};

export type MacOSHelperController = {
  snapshot(): Promise<MacOSHelperStatus>;
  saveConfiguration(values: { apiKey?: string; tunnelId?: string }): Promise<{
    configuration: RuntimeEnvStatus;
    restartRequired: boolean;
  }>;
  authStatus(): Promise<CodexLoginStatus>;
  startLogin(): Promise<{ started: true }>;
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
  autoRestart?: boolean;
  startTimeoutMs?: number;
};

export class MacOSBridgeSupervisor implements MacOSHelperController {
  private readonly bridgeRoot: string;
  private readonly envFile: string;
  private readonly bridgeSocketPath: string;
  private readonly launcherPath: string;
  private readonly autoRestart: boolean;
  private readonly startTimeoutMs: number;
  private child: ChildProcess | undefined;
  private phase: MacOSRuntimePhase = "stopped";
  private startedAt: string | null = null;
  private lastExit: MacOSHelperStatus["lastExit"] = null;
  private lastError: string | null = null;
  private restartAttempt = 0;
  private unexpectedExits: number[] = [];
  private restartTimer: NodeJS.Timeout | undefined;
  private stabilityTimer: NodeJS.Timeout | undefined;
  private manualStop = false;
  private reinitializeTunnelProfile = false;
  private readonly logEntries: MacOSHelperLogEntry[] = [];
  private operation: Promise<unknown> = Promise.resolve();

  constructor(options: MacOSBridgeSupervisorOptions) {
    this.bridgeRoot = path.resolve(options.bridgeRoot);
    this.envFile = path.resolve(options.envFile || defaultRuntimeEnvFile());
    this.bridgeSocketPath = path.resolve(options.bridgeSocketPath);
    this.launcherPath = path.resolve(
      options.launcherPath || path.join(this.bridgeRoot, "scripts", "start-codex-mcp-bridge.mjs")
    );
    this.autoRestart = options.autoRestart !== false;
    this.startTimeoutMs = options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS;
  }

  async snapshot(): Promise<MacOSHelperStatus> {
    const bridgeAdmission = await readBridgeAdmission(this.bridgeSocketPath);
    return {
      kind: "helper-status",
      generatedAt: new Date().toISOString(),
      phase: this.phase,
      pid: this.child?.pid || null,
      startedAt: this.startedAt,
      lastExit: this.lastExit,
      lastError: this.lastError,
      restartAttempt: this.restartAttempt,
      configuration: inspectRuntimeEnvFile(this.envFile),
      bridge: {
        socketPath: this.bridgeSocketPath,
        connected: bridgeAdmission !== null,
        acceptingNewJobs: bridgeAdmission?.acceptingNewJobs ?? null,
        activeJobs: bridgeAdmission?.activeJobs ?? null,
        pendingAdmissions: bridgeAdmission?.pendingAdmissions ?? null
      }
    };
  }

  async saveConfiguration(values: {
    apiKey?: string;
    tunnelId?: string;
  }): Promise<{ configuration: RuntimeEnvStatus; restartRequired: boolean }> {
    const previous = inspectRuntimeEnvFile(this.envFile);
    const configuration = updateRuntimeEnvFile(this.envFile, values);
    if (
      typeof values.tunnelId === "string" &&
      values.tunnelId.trim() &&
      values.tunnelId.trim() !== previous.tunnelId
    ) {
      this.reinitializeTunnelProfile = true;
      this.appendLog("helper", "Tunnel identity changed; the managed profile will be rebuilt on restart.");
    }
    this.appendLog("helper", "Runtime configuration was saved with private file permissions.");
    return {
      configuration,
      restartRequired: Boolean(this.child && this.child.exitCode === null)
    };
  }

  async authStatus(): Promise<CodexLoginStatus> {
    const result = spawnSync(resolveCommand("codex"), ["login", "status"], {
      encoding: "utf8",
      env: commandEnvironment(),
      timeout: 15_000
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        installed: false,
        authenticated: false,
        summary: "Codex CLI is not installed or is not available in PATH."
      };
    }
    const output = redactRuntimeText(`${result.stdout || ""}\n${result.stderr || ""}`);
    return {
      installed: !result.error,
      authenticated: result.status === 0,
      summary: output || (result.status === 0 ? "Codex login is available." : "Codex login is required.")
    };
  }

  async startLogin(): Promise<{ started: true }> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(resolveCommand("codex"), ["login"], {
        detached: true,
        env: commandEnvironment(),
        stdio: "ignore"
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
      child.once("error", (error) => reject(error));
    }).catch((error) => {
      this.lastError = safeErrorMessage(error);
      this.appendLog("helper", `Codex login could not start: ${this.lastError}`);
      throw error;
    });
    this.appendLog("helper", "Codex browser login was requested.");
    return { started: true };
  }

  start(): Promise<MacOSHelperStatus> {
    return this.exclusive(() => this.startUnlocked(true));
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
      this.reinitializeTunnelProfile = true;
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
    await this.exclusive(() => this.stopUnlocked({ mode: "force", timeoutMs: 5_000 }));
  }

  private async startUnlocked(manualAttempt: boolean): Promise<MacOSHelperStatus> {
    if (this.child && this.child.exitCode === null) return this.snapshot();
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
      "--require-built"
    ];
    if (!this.reinitializeTunnelProfile) launcherArguments.push("--reuse-profile");
    const child = spawn(process.execPath, launcherArguments, {
      cwd: this.bridgeRoot,
      env: runtimeEnvironment(this.envFile, this.bridgeSocketPath),
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    this.startedAt = new Date().toISOString();
    child.stdout?.on("data", (chunk: Buffer) => this.captureRuntimeOutput(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.captureRuntimeOutput(chunk));
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.lastError = safeErrorMessage(error);
      this.appendLog("runtime", this.lastError);
    });
    child.once("exit", (code, signal) => this.observeExit(child, code, signal));

    try {
      await waitForBridge(this.bridgeSocketPath, this.startTimeoutMs, () => child.exitCode !== null);
      if (this.child === child && child.exitCode === null) {
        this.phase = "running";
        this.reinitializeTunnelProfile = false;
        this.scheduleStabilityReset(child);
        this.appendLog("helper", "The bridge companion channel is ready.");
      }
    } catch (error) {
      this.lastError = safeErrorMessage(error);
      this.appendLog("helper", this.lastError);
      if (child.exitCode === null) child.kill("SIGTERM");
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
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.phase = "stopped";
      this.child = undefined;
      return this.snapshot();
    }

    this.manualStop = true;
    this.phase = options.mode === "drain" ? "draining" : "stopping";
    let drainStarted = false;
    try {
      const state = await bridgeRequest<RuntimeAdmissionSnapshot>(
        this.bridgeSocketPath,
        "runtime.beginDrain",
        {}
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
          await bridgeRequest(this.bridgeSocketPath, "runtime.cancelDrain", {}).catch(() => undefined);
          this.phase = "running";
          this.manualStop = false;
          throw new Error(
            `DRAIN_TIMEOUT: ${activeJobs} active job(s) and ${pendingAdmissions} pending admission(s) did not finish before the timeout.`
          );
        }
      }
    } catch (error) {
      if (options.mode === "drain") throw error;
      this.appendLog("helper", `Force stop continuing without a drain acknowledgement: ${safeErrorMessage(error)}`);
    }

    this.phase = "stopping";
    this.appendLog(
      "helper",
      options.mode === "drain"
        ? "Active work drained; stopping the managed runtime."
        : "Force-stopping the managed runtime; active work may be interrupted."
    );
    child.kill("SIGTERM");
    const exited = await waitForExit(child, options.mode === "force" ? 3_000 : 10_000);
    if (!exited && child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, 2_000);
    }
    if (drainStarted && child.exitCode === null) {
      await bridgeRequest(this.bridgeSocketPath, "runtime.cancelDrain", {}).catch(() => undefined);
    }
    if (this.child === child) this.child = undefined;
    this.phase = "stopped";
    this.startedAt = null;
    return this.snapshot();
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
    this.startedAt = null;
    this.lastExit = { at: new Date().toISOString(), code, signal };
    this.appendLog("runtime", `Managed runtime exited (${code ?? signal ?? "unknown"}).`);
    if (this.manualStop) {
      this.phase = "stopped";
      return;
    }
    this.lastError = `Managed runtime exited unexpectedly (${code ?? signal ?? "unknown"}).`;
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

  private scheduleStabilityReset(child: ChildProcess): void {
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = undefined;
      if (this.child !== child || child.exitCode !== null || this.phase !== "running") return;
      this.unexpectedExits = [];
      this.restartAttempt = 0;
      this.appendLog("helper", "Managed runtime remained stable; crash backoff was reset.");
    }, CRASH_WINDOW_MS);
    this.stabilityTimer.unref();
  }

  private captureRuntimeOutput(chunk: Buffer): void {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      const message = redactRuntimeText(line);
      if (message) this.appendLog("runtime", message);
    }
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
          capabilities: [
            "runtime.read",
            "runtime.start",
            "runtime.stop",
            "runtime.restart",
            "runtime.repair-profile",
            "runtime.logs.redacted",
            "setup.dotenv",
            "auth.codex-browser-login"
          ],
          status: await controller.snapshot()
        };
        break;
      case "helper.status":
        emptyParamsSchema.parse(request.params || {});
        result = await controller.snapshot();
        break;
      case "setup.save":
        result = await controller.saveConfiguration(setupSaveParamsSchema.parse(request.params || {}));
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
};

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

async function probeBridge(socketPath: string): Promise<boolean> {
  return (await readBridgeAdmission(socketPath)) !== null;
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

async function waitForBridge(
  socketPath: string,
  timeoutMs: number,
  exited: () => boolean
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited()) throw new Error("Managed runtime exited before the bridge became ready.");
    if (await probeBridge(socketPath)) return;
    await delay(250);
  }
  throw new Error("Timed out waiting for the bridge companion channel.");
}

function bridgeRequest<T = unknown>(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5_000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("Bridge companion request timed out.")), timeoutMs);
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as T);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: `helper-${Date.now()}`,
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
          result?: T;
          error?: { message?: string };
        };
        if (response.error) finish(new Error(response.error.message || "Bridge companion request failed."));
        else finish(undefined, response.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
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

function runtimeEnvironment(envFile: string, bridgeSocketPath: string): NodeJS.ProcessEnv {
  const environment = commandEnvironment();
  const passthrough = [
    "CODEX_MCP_BRIDGE_ALLOWED_ROOTS",
    "CODEX_MCP_BRIDGE_ALLOW_WRITE",
    "CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS",
    "CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY",
    "CODEX_MCP_BRIDGE_DEFAULT_BACKEND",
    "CODEX_MCP_BRIDGE_DEFAULT_MODEL",
    "CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT",
    "CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS",
    "CODEX_MCP_BRIDGE_STATE_DB",
    "CODEX_MCP_BRIDGE_CODEX",
    "TUNNEL_CLIENT",
    "TUNNEL_CLIENT_PROFILE",
    "MCP_MAX_CONCURRENT_REQUESTS",
    "CONTROL_PLANE_MAX_INFLIGHT_REQUESTS",
    "LOG_LEVEL"
  ];
  for (const name of passthrough) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.CODEX_MCP_BRIDGE_ENV_FILE = envFile;
  environment.CODEX_MCP_BRIDGE_COMPANION_SOCKET = bridgeSocketPath;
  environment.CODEX_MCP_BRIDGE_MANAGED_BY_APP = "1";
  delete environment.CONTROL_PLANE_API_KEY;
  delete environment.CONTROL_PLANE_TUNNEL_ID;
  return environment;
}

function commandEnvironment(): NodeJS.ProcessEnv {
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
    "CODEX_HOME"
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
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

function resolveCommand(command: string): string {
  return process.env.CODEX_MCP_BRIDGE_CODEX && command === "codex"
    ? process.env.CODEX_MCP_BRIDGE_CODEX
    : command;
}

function redactRuntimeText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_API_KEY]")
    .replace(/tunnel_[A-Za-z0-9_-]{8,}/g, "[REDACTED_TUNNEL_ID]")
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
