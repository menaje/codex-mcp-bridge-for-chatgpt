import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { BridgeConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { createExecutionRuntime } from "./executionRuntime.js";
import { AppServerLateResponseJournal } from "./appServerLateResponses.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  createHttpServer,
  type BridgeHttpServer,
  type BridgeReadinessSnapshot
} from "./server.js";
import type { OperationalStateOperationObservation } from "./stateService.js";
import { operationalStateErrorCode } from "./stateServiceProcess.js";
import { ChildProcessStateReadService } from "./stateReadProcess.js";
import { BridgeStateStore } from "./stateStore.js";
import {
  createStdioBridgeRuntime,
  type BridgeStdioRuntime
} from "./stdioServer.js";
import {
  ChildProcessTelemetryService,
  InMemoryTelemetryService,
  type BridgeTelemetryService
} from "./telemetryService.js";
import type {
  BridgeApplicationService,
  BridgeRuntimeAdmissionSnapshot
} from "./tools.js";

const CHILD_FLAG = "--isolated-bridge-runtime-child";
const CHILD_STDIO_FLAG = "--stdio";
const HEARTBEAT_INTERVAL_MS = 250;
const HEARTBEAT_STALE_MS = 2_000;
const STARTUP_TIMEOUT_MS = 20_000;
const FORCE_CLOSE_MS = 5_000;
const MAX_PENDING_REQUESTS = 128;
// HTTP/MCP traffic cannot consume the final slots used by native control,
// completion delivery, cancellation, and authoritative recovery reads.
const CRITICAL_RPC_RESERVE = 16;
const MAX_PROXY_REQUESTS = MAX_PENDING_REQUESTS - CRITICAL_RPC_RESERVE;
const MAX_RPC_BYTES = 8 * 1024 * 1024;
const MAX_PROXY_BYTES_IN_FLIGHT = 32 * 1024 * 1024;
const RESTART_BASE_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 10_000;
const RESTART_STABLE_MS = 60_000;

const APPLICATION_RPC_METHODS = [
  "problemAction",
  "historyAction",
  "threadHandoff",
  "dashboardSnapshot",
  "dashboardHistoryDetail",
  "settingsSnapshot",
  "updateSettings",
  "runtimeSnapshot",
  "beginDrain",
  "cancelDrain",
  "claimNativeCompletionNotifications",
  "markNativeCompletionNotificationsDelivered",
  "releaseNativeCompletionNotifications",
  "skillLibrarySnapshot",
  "readBridgeSkill",
  "readBridgeSkillFile",
  "listBridgeSkillVersions",
  "createBridgeSkill",
  "createBridgeSkillFromPackage",
  "updateBridgeSkill",
  "updateBridgeSkillFromPackage",
  "restoreBridgeSkill",
  "setBridgeSkillEnabled",
  "deleteBridgeSkill",
  "beginBridgeSkillPackageUpload",
  "appendBridgeSkillPackageUpload",
  "inspectBridgeSkillPackageUpload",
  "exportBridgeSkillPackage"
] as const;

type ApplicationRpcMethod = (typeof APPLICATION_RPC_METHODS)[number];

type RuntimeReadyMessage = {
  type: "ready";
  transport: RuntimeTransport;
  generation: string;
  port?: number;
  heartbeatAt: number;
  runtimeHealth: BridgeRuntimeAdmissionSnapshot;
  lastCommitAt?: number;
};

type RuntimeHeartbeatMessage = {
  type: "heartbeat";
  generation: string;
  heartbeatAt: number;
  runtimeHealth: BridgeRuntimeAdmissionSnapshot;
  lastCommitAt?: number;
};

type RuntimeOperationMessage = {
  type: "operation";
  generation: string;
  observation: OperationalStateOperationObservation;
};

type RuntimeOperationClearMessage = {
  type: "operation-clear";
  generation: string;
};

type RuntimeChangeMessage = {
  type: "change";
  generation: string;
  topic: "dashboard" | "settings" | "enrichment";
};

type RuntimeRpcResponseMessage = {
  type: "rpc-response";
  generation: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

type RuntimeFatalMessage = { type: "fatal"; message: string };

type RuntimeChildMessage =
  | RuntimeReadyMessage
  | RuntimeHeartbeatMessage
  | RuntimeOperationMessage
  | RuntimeOperationClearMessage
  | RuntimeChangeMessage
  | RuntimeRpcResponseMessage
  | RuntimeFatalMessage;

type RuntimeRpcRequestMessage = {
  type: "rpc";
  generation: string;
  requestId: string;
  method: ApplicationRpcMethod;
  args: unknown[];
};

type RuntimeCloseMessage = { type: "close" };
type RuntimeParentMessage = RuntimeRpcRequestMessage | RuntimeCloseMessage;

type PendingRpc = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type RuntimeTransport = "http" | "stdio";

export type IsolatedStdioRuntime = {
  readonly applicationService: BridgeApplicationService;
  close(): Promise<void>;
};

/**
 * Production ingress boundary. The public HTTP and native companion listeners
 * stay in this process; every SQLite connection and the existing application
 * runtime live in one supervised child. A synchronous database stall can make
 * readiness stale, but cannot occupy the public liveness event loop.
 */
export async function createIsolatedHttpServer(
  config: BridgeConfig,
  options: {
    childEnvironment?: NodeJS.ProcessEnv;
    conformanceFixtures?: boolean;
    /** Test/diagnostic hook; process identity is never exposed over MCP or HTTP. */
    onRuntimeProcessSpawn?: (processId: number) => void;
    /** Test-only override for deterministic replacement-timeout coverage. */
    restartStartupTimeoutMs?: number;
  } = {}
): Promise<BridgeHttpServer> {
  const childEnvironment = {
    ...(options.childEnvironment || process.env),
    // Keep the child pinned to the exact durable paths selected by the parent.
    // This also makes programmatic/test configurations deterministic instead
    // of silently reopening defaults from the ambient environment.
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: config.stateDatabaseFile,
    CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: config.telemetryDatabaseFile,
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: config.modelCatalogStateFile,
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: config.bridgeSkillsDirectory
  };
  const runtime = await IsolatedRuntimeController.start(
    "http",
    childEnvironment,
    options.conformanceFixtures === true,
    undefined,
    undefined,
    options.onRuntimeProcessSpawn,
    options.restartStartupTimeoutMs
  );
  const applicationService = runtime.applicationService();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://bridge.invalid").pathname;
    if (pathname === "/healthz" && request.method === "GET") {
      writeJson(response, 200, {
        ok: true,
        name: PRODUCT_INFO.runtimeName,
        title: PRODUCT_INFO.displayName
      });
      return;
    }
    if (pathname === "/readyz" && request.method === "GET") {
      const snapshot = runtime.readiness();
      writeJson(response, snapshot.ready ? 200 : 503, {
        ok: snapshot.ready,
        name: PRODUCT_INFO.runtimeName,
        reason: snapshot.reason,
        limitations: snapshot.limitations,
        ...(snapshot.stateService ? { stateService: snapshot.stateService } : {})
      });
      return;
    }
    runtime.proxy(request, response);
  }) as BridgeHttpServer;

  Object.defineProperty(server, "applicationService", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: applicationService
  });

  const closeHttp = server.close.bind(server);
  let closePromise: Promise<void> | undefined;
  server.close = ((callback?: (error?: Error) => void) => {
    if (!closePromise) {
      closePromise = new Promise<void>((resolve, reject) => {
        closeHttp(error => error ? reject(error) : resolve());
      }).catch(error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ERR_SERVER_NOT_RUNNING") throw error;
      }).then(() => runtime.close());
    }
    void closePromise.then(() => callback?.(), error => callback?.(
      error instanceof Error ? error : new Error(String(error))
    ));
    return server;
  }) as BridgeHttpServer["close"];

  return server;
}

/**
 * Persistent stdio transport with the same process boundary as HTTP. The
 * parent owns the tunnel pipe and native companion sockets; the child owns
 * Codex and every SQLite connection.
 */
export async function createIsolatedStdioRuntime(
  config: BridgeConfig,
  options: {
    childEnvironment?: NodeJS.ProcessEnv;
    input?: Readable;
    output?: Writable;
    /** Test/diagnostic hook; process identity is never exposed to stdio clients. */
    onRuntimeProcessSpawn?: (processId: number) => void;
    /** Test-only override for deterministic replacement-timeout coverage. */
    restartStartupTimeoutMs?: number;
  } = {}
): Promise<IsolatedStdioRuntime> {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const childEnvironment = {
    ...(options.childEnvironment || process.env),
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: config.stateDatabaseFile,
    CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: config.telemetryDatabaseFile,
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: config.modelCatalogStateFile,
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: config.bridgeSkillsDirectory
  };
  const runtime = await IsolatedRuntimeController.start(
    "stdio",
    childEnvironment,
    false,
    input,
    output,
    options.onRuntimeProcessSpawn,
    options.restartStartupTimeoutMs
  );
  return {
    applicationService: runtime.applicationService(),
    close: () => runtime.close()
  };
}

class IsolatedRuntimeController {
  private child?: ChildProcess;
  private generation?: string;
  private port?: number;
  private lastHeartbeatAt?: number;
  private lastRuntimeHealth?: BridgeRuntimeAdmissionSnapshot;
  private lastCommitAt?: number;
  private activeOperation?: OperationalStateOperationObservation;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly abandoned = new Set<string>();
  private readonly changeListeners = new Set<
    (topic: "dashboard" | "settings" | "enrichment") => void
  >();
  private activeProxyRequests = 0;
  private activeProxyBytes = 0;
  private closed = false;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private startupResolve?: () => void;
  private startupReject?: (error: Error) => void;
  private startupTimer?: NodeJS.Timeout;
  private staleRpcWatchdog?: NodeJS.Timeout;
  private stderr = "";

  private constructor(
    private readonly transport: RuntimeTransport,
    private readonly childEnvironment: NodeJS.ProcessEnv,
    private readonly conformanceFixtures: boolean,
    private readonly input?: Readable,
    private readonly output?: Writable,
    private readonly onRuntimeProcessSpawn?: (processId: number) => void,
    private readonly restartStartupTimeoutMs = STARTUP_TIMEOUT_MS
  ) {}

  static async start(
    transport: RuntimeTransport,
    childEnvironment: NodeJS.ProcessEnv = process.env,
    conformanceFixtures = false,
    input?: Readable,
    output?: Writable,
    onRuntimeProcessSpawn?: (processId: number) => void,
    restartStartupTimeoutMs?: number
  ): Promise<IsolatedRuntimeController> {
    const runtime = new IsolatedRuntimeController(
      transport,
      childEnvironment,
      conformanceFixtures,
      input,
      output,
      onRuntimeProcessSpawn,
      restartStartupTimeoutMs
    );
    try {
      await runtime.spawnAndWait();
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
    runtime.staleRpcWatchdog = setInterval(() => {
      if (runtime.isFresh() || runtime.pending.size === 0) return;
      for (const [requestId, pending] of runtime.pending) {
        runtime.pending.delete(requestId);
        runtime.abandoned.add(requestId);
        pending.reject(new Error(
          "RUNTIME_RESPONSE_UNCONFIRMED: The isolated Bridge runtime stopped responding; the operation outcome is unknown."
        ));
      }
    }, HEARTBEAT_INTERVAL_MS);
    runtime.staleRpcWatchdog.unref();
    return runtime;
  }

  applicationService(): BridgeApplicationService {
    const rpc = <T>(method: ApplicationRpcMethod, ...args: unknown[]) =>
      this.rpc(method, args) as Promise<T>;
    return {
      problemAction: (...args) => rpc("problemAction", ...args),
      historyAction: (...args) => rpc("historyAction", ...args),
      threadHandoff: (...args) => rpc("threadHandoff", ...args),
      dashboardSnapshot: (...args) => rpc("dashboardSnapshot", ...args),
      dashboardHistoryDetail: (...args) => rpc("dashboardHistoryDetail", ...args),
      settingsSnapshot: (...args) => rpc("settingsSnapshot", ...args),
      updateSettings: (...args) => rpc("updateSettings", ...args),
      runtimeSnapshot: (...args) => rpc("runtimeSnapshot", ...args),
      runtimeHealth: () => this.runtimeHealth(),
      beginDrain: (...args) => rpc("beginDrain", ...args),
      cancelDrain: (...args) => rpc("cancelDrain", ...args),
      claimNativeCompletionNotifications: (...args) =>
        rpc("claimNativeCompletionNotifications", ...args),
      markNativeCompletionNotificationsDelivered: (...args) =>
        rpc("markNativeCompletionNotificationsDelivered", ...args),
      releaseNativeCompletionNotifications: (...args) =>
        rpc("releaseNativeCompletionNotifications", ...args),
      skillLibrarySnapshot: (...args) => rpc("skillLibrarySnapshot", ...args),
      readBridgeSkill: (...args) => rpc("readBridgeSkill", ...args),
      readBridgeSkillFile: (...args) => rpc("readBridgeSkillFile", ...args),
      listBridgeSkillVersions: (...args) => rpc("listBridgeSkillVersions", ...args),
      createBridgeSkill: (...args) => rpc("createBridgeSkill", ...args),
      createBridgeSkillFromPackage: (...args) => rpc("createBridgeSkillFromPackage", ...args),
      updateBridgeSkill: (...args) => rpc("updateBridgeSkill", ...args),
      updateBridgeSkillFromPackage: (...args) => rpc("updateBridgeSkillFromPackage", ...args),
      restoreBridgeSkill: (...args) => rpc("restoreBridgeSkill", ...args),
      setBridgeSkillEnabled: (...args) => rpc("setBridgeSkillEnabled", ...args),
      deleteBridgeSkill: (...args) => rpc("deleteBridgeSkill", ...args),
      beginBridgeSkillPackageUpload: (...args) =>
        rpc("beginBridgeSkillPackageUpload", ...args),
      appendBridgeSkillPackageUpload: (...args) =>
        rpc("appendBridgeSkillPackageUpload", ...args),
      inspectBridgeSkillPackageUpload: (...args) =>
        rpc("inspectBridgeSkillPackageUpload", ...args),
      exportBridgeSkillPackage: (...args) => rpc("exportBridgeSkillPackage", ...args),
      subscribeChanges: listener => {
        this.changeListeners.add(listener);
        return () => { this.changeListeners.delete(listener); };
      }
    } as BridgeApplicationService;
  }

  readiness(now = Date.now()): BridgeReadinessSnapshot {
    const heartbeatAgeMs = this.lastHeartbeatAt === undefined
      ? undefined
      : Math.max(0, now - this.lastHeartbeatAt);
    const connected = Boolean(
      this.child?.connected &&
      (this.transport === "stdio" || this.port !== undefined) &&
      this.generation
    );
    const fresh = connected && heartbeatAgeMs !== undefined && heartbeatAgeMs <= HEARTBEAT_STALE_MS;
    const accepting = fresh && this.lastRuntimeHealth?.acceptingNewJobs === true;
    const reason = !connected
      ? "state-recovering"
      : !fresh
        ? "state-stale"
        : !accepting
          ? "admission-draining"
          : this.outstanding >= MAX_PENDING_REQUESTS ||
              this.activeProxyRequests >= MAX_PROXY_REQUESTS ||
              this.activeProxyBytes >= MAX_PROXY_BYTES_IN_FLIGHT
            ? "state-capacity"
            : "ready";
    return {
      ready: reason === "ready",
      reason,
      limitations: reason === "ready" ? [] : [
        reason === "state-stale"
          ? this.activeOperation?.access === "read"
            ? "state-read-unconfirmed"
            : this.activeOperation?.access === "write"
              ? "state-write-unconfirmed"
              : "state-response-unconfirmed"
          : reason
      ],
      ...(this.generation ? {
        stateService: {
          protocolVersion: 1,
          generation: this.generation,
          heartbeatAgeMs: heartbeatAgeMs ?? Number.MAX_SAFE_INTEGER,
          inFlight: this.outstanding,
          queueDepth: Math.max(0, this.outstanding - 1),
          capacity: MAX_PENDING_REQUESTS,
          ...(!fresh && this.activeOperation ? { activeOperation: this.activeOperation } : {}),
          ...(this.lastCommitAt !== undefined ? { lastCommitAt: this.lastCommitAt } : {})
        }
      } : {})
    };
  }

  runtimeHealth(): BridgeRuntimeAdmissionSnapshot {
    const current = this.lastRuntimeHealth || emptyRuntimeHealth();
    const fresh = this.isFresh();
    const readiness = this.readiness();
    const observationAgeMs = readiness.stateService?.heartbeatAgeMs ?? 0;
    return {
      ...current,
      acceptingNewJobs: fresh && current.acceptingNewJobs,
      backgroundProcessState: fresh ? current.backgroundProcessState : "unknown",
      ...(current.readService ? {
        readService: fresh ? current.readService : {
          ...current.readService,
          status: "read-stale",
          heartbeatAgeMs: (current.readService.heartbeatAgeMs ?? 0) + observationAgeMs
        }
      } : {}),
      ...(current.telemetryService ? {
        telemetryService: fresh ? current.telemetryService : {
          ...current.telemetryService,
          status: "stale"
        }
      } : {}),
      stateService: {
        // Admission draining is an execution policy state, not evidence that
        // SQLite or the runtime response boundary is unavailable.
        status: readiness.reason === "admission-draining" ? "ready" : readiness.reason,
        ...(readiness.stateService ? {
          generation: readiness.stateService.generation,
          heartbeatAgeMs: readiness.stateService.heartbeatAgeMs,
          ...(readiness.stateService.activeOperation
            ? { activeOperation: readiness.stateService.activeOperation }
            : {}),
          ...(readiness.stateService.lastCommitAt !== undefined
            ? { lastCommitAt: readiness.stateService.lastCommitAt }
            : {})
        } : {})
      }
    };
  }

  proxy(
    incoming: import("node:http").IncomingMessage,
    outgoing: import("node:http").ServerResponse
  ): void {
    if (!this.isFresh() || this.port === undefined || !this.child?.connected) {
      writeUnavailable(outgoing, this.readiness().reason);
      return;
    }
    if (
      this.outstanding >= MAX_PENDING_REQUESTS ||
      this.activeProxyRequests >= MAX_PROXY_REQUESTS
    ) {
      writeUnavailable(outgoing, "state-capacity");
      return;
    }
    const declaredLength = requestContentLength(incoming.headers);
    if (declaredLength !== undefined && declaredLength > MAX_RPC_BYTES) {
      writeJson(outgoing, 413, {
        ok: false,
        code: "RUNTIME_REQUEST_TOO_LARGE",
        reason: "request-bytes"
      });
      return;
    }
    if (
      declaredLength !== undefined &&
      this.activeProxyBytes + declaredLength > MAX_PROXY_BYTES_IN_FLIGHT
    ) {
      writeUnavailable(outgoing, "state-capacity");
      return;
    }
    const port = this.port;
    this.activeProxyRequests += 1;
    let requestBytes = declaredLength ?? 0;
    this.activeProxyBytes += requestBytes;
    let responseStarted = false;
    let settled = false;
    let staleWatchdog: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.activeProxyRequests = Math.max(0, this.activeProxyRequests - 1);
      this.activeProxyBytes = Math.max(0, this.activeProxyBytes - requestBytes);
      if (staleWatchdog) clearInterval(staleWatchdog);
    };
    const rejectBody = (reason: "request-bytes" | "state-capacity") => {
      proxied.destroy(new Error(
        reason === "request-bytes" ? "RUNTIME_REQUEST_TOO_LARGE" : "RUNTIME_CAPACITY"
      ));
      if (!responseStarted && !outgoing.headersSent) {
        if (reason === "request-bytes") {
          writeJson(outgoing, 413, {
            ok: false,
            code: "RUNTIME_REQUEST_TOO_LARGE",
            reason
          });
        } else {
          writeUnavailable(outgoing, reason);
        }
      } else if (!outgoing.destroyed) {
        outgoing.destroy();
      }
      finish();
    };
    const proxied = httpRequest({
      host: "127.0.0.1",
      port,
      method: incoming.method,
      path: incoming.url,
      headers: requestHeaders(incoming.headers)
    }, response => {
      responseStarted = true;
      outgoing.writeHead(response.statusCode || 502, responseHeaders(response.headers));
      response.pipe(outgoing);
      response.once("end", finish);
      response.once("error", error => {
        if (!outgoing.destroyed) outgoing.destroy(error);
        finish();
      });
    });
    staleWatchdog = setInterval(() => {
      if (this.isFresh()) return;
      proxied.destroy(new Error("RUNTIME_RESPONSE_UNCONFIRMED"));
      if (!responseStarted && !outgoing.headersSent) {
        writeUnavailable(outgoing, "state-stale");
      } else if (!outgoing.destroyed) {
        outgoing.destroy();
      }
      finish();
    }, HEARTBEAT_INTERVAL_MS);
    staleWatchdog.unref();
    proxied.once("error", error => {
      if (!outgoing.headersSent) {
        writeUnavailable(outgoing, this.isFresh() ? "state-recovering" : "state-stale");
      } else if (!outgoing.destroyed) {
        outgoing.destroy(error);
      }
      finish();
    });
    incoming.once("aborted", () => {
      proxied.destroy();
      finish();
    });
    if (declaredLength === undefined) {
      incoming.on("data", chunk => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        requestBytes += bytes;
        this.activeProxyBytes += bytes;
        if (requestBytes > MAX_RPC_BYTES) rejectBody("request-bytes");
        else if (this.activeProxyBytes > MAX_PROXY_BYTES_IN_FLIGHT) {
          rejectBody("state-capacity");
        }
      });
    }
    incoming.pipe(proxied);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.staleRpcWatchdog) clearInterval(this.staleRpcWatchdog);
    this.rejectPending(new Error("RUNTIME_CLOSED: Isolated Bridge runtime closed."));
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: "close" } satisfies RuntimeCloseMessage);
    await new Promise<void>(resolve => {
      let settled = false;
      const force = setTimeout(() => child.kill("SIGKILL"), FORCE_CLOSE_MS);
      force.unref();
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(force);
        resolve();
      };
      child.once("exit", finish);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
  }

  private get outstanding(): number {
    return this.pending.size + this.activeProxyRequests;
  }

  private isFresh(now = Date.now()): boolean {
    return Boolean(
      this.child?.connected &&
      (this.transport === "stdio" || this.port !== undefined) &&
      this.lastHeartbeatAt !== undefined &&
      now - this.lastHeartbeatAt <= HEARTBEAT_STALE_MS
    );
  }

  private rpc(method: ApplicationRpcMethod, args: unknown[]): Promise<unknown> {
    if (!this.isFresh() || !this.child?.connected || !this.generation) {
      return Promise.reject(new Error(
        "RUNTIME_RESPONSE_UNCONFIRMED: The isolated Bridge runtime is not currently responsive."
      ));
    }
    if (this.outstanding >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("RUNTIME_CAPACITY: Isolated Bridge runtime capacity is exhausted."));
    }
    const requestId = randomUUID();
    const message: RuntimeRpcRequestMessage = {
      type: "rpc",
      generation: this.generation,
      requestId,
      method,
      args
    };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_RPC_BYTES) {
      return Promise.reject(new Error("RUNTIME_REQUEST_TOO_LARGE: Runtime request exceeds its IPC limit."));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.child?.send(message, error => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.reject(new Error(`RUNTIME_SEND_FAILED: ${error.message}`));
      });
    });
  }

  private async spawnAndWait(): Promise<void> {
    if (this.closed) throw new Error("RUNTIME_CLOSED: Isolated Bridge runtime closed.");
    const ready = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });
    const modulePath = fileURLToPath(import.meta.url);
    const args = modulePath.endsWith(".ts")
      ? ["--import", "tsx", modulePath, CHILD_FLAG]
      : [modulePath, CHILD_FLAG];
    if (this.transport === "stdio") args.push(CHILD_STDIO_FLAG);
    if (this.conformanceFixtures) args.push("--conformance-fixtures");
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: this.childEnvironment,
      stdio: [this.transport === "stdio" ? "pipe" : "ignore", "pipe", "pipe", "ipc"]
    });
    this.child = child;
    if (child.pid !== undefined) this.onRuntimeProcessSpawn?.(child.pid);
    this.stderr = "";
    child.stdout?.pipe(this.transport === "stdio" ? this.output || process.stdout : process.stdout);
    if (this.transport === "stdio" && child.stdin && this.input) this.input.pipe(child.stdin);
    child.stderr?.on("data", chunk => {
      const text = String(chunk);
      this.stderr = (this.stderr + text).slice(-8_192);
      process.stderr.write(text);
    });
    child.on("message", message => {
      if (this.child === child) this.onMessage(message);
    });
    child.once("error", error => this.onExit(child, error));
    child.once("exit", (code, signal) => this.onExit(
      child,
      new Error(
        `Isolated Bridge runtime exited (code=${code}, signal=${signal}).` +
        (this.stderr ? ` ${this.stderr}` : "")
      )
    ));
    const startupTimeoutMs = this.restartAttempts === 0
      ? STARTUP_TIMEOUT_MS
      : this.restartStartupTimeoutMs;
    this.startupTimer = setTimeout(() => {
      if (this.child !== child || this.generation !== undefined) return;
      child.kill("SIGKILL");
      this.startupReject?.(new Error(
        `RUNTIME_START_TIMEOUT: Isolated Bridge runtime did not start within ` +
        `${startupTimeoutMs} ms.`
      ));
    }, startupTimeoutMs);
    this.startupTimer.unref();
    await ready;
  }

  private onMessage(value: unknown): void {
    if (!isRuntimeChildMessage(value)) return;
    if (value.type === "fatal") {
      this.startupReject?.(new Error(`RUNTIME_START_FAILED: ${value.message}`));
      return;
    }
    if (value.type === "ready") {
      if (value.transport !== this.transport) {
        this.startupReject?.(new Error(
          `RUNTIME_TRANSPORT_MISMATCH: Expected ${this.transport}, received ${value.transport}.`
        ));
        return;
      }
      this.generation = value.generation;
      this.port = value.port;
      this.lastHeartbeatAt = value.heartbeatAt;
      this.lastRuntimeHealth = value.runtimeHealth;
      if (value.lastCommitAt !== undefined) this.lastCommitAt = value.lastCommitAt;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
      this.startupResolve?.();
      this.startupResolve = undefined;
      this.startupReject = undefined;
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => { this.restartAttempts = 0; }, RESTART_STABLE_MS);
      this.stableTimer.unref();
      return;
    }
    if (value.generation !== this.generation) return;
    if (value.type === "heartbeat") {
      this.lastHeartbeatAt = value.heartbeatAt;
      this.lastRuntimeHealth = value.runtimeHealth;
      if (value.lastCommitAt !== undefined) this.lastCommitAt = value.lastCommitAt;
      return;
    }
    if (value.type === "operation") {
      this.activeOperation = Object.freeze({ ...value.observation });
      return;
    }
    if (value.type === "operation-clear") {
      this.activeOperation = undefined;
      return;
    }
    if (value.type === "change") {
      for (const listener of this.changeListeners) listener(value.topic);
      return;
    }
    if (value.type === "rpc-response") {
      if (this.abandoned.delete(value.requestId)) return;
      const pending = this.pending.get(value.requestId);
      if (!pending) return;
      this.pending.delete(value.requestId);
      if (value.ok) pending.resolve(value.result);
      else pending.reject(new Error(
        `${value.error?.code || "RUNTIME_REQUEST_FAILED"}: ` +
        (value.error?.message || "Isolated Bridge runtime request failed.")
      ));
    }
  }

  private onExit(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    if (this.transport === "stdio" && child.stdin && this.input) {
      this.input.unpipe(child.stdin);
    }
    this.child = undefined;
    this.generation = undefined;
    this.port = undefined;
    this.lastHeartbeatAt = undefined;
    this.activeOperation = undefined;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    this.startupReject?.(error);
    this.startupResolve = undefined;
    this.startupReject = undefined;
    this.rejectPending(new Error(`RUNTIME_OUTCOME_UNKNOWN: ${error.message}`));
    if (!this.closed) this.scheduleRestart();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.abandoned.clear();
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** Math.min(this.restartAttempts, 16),
      RESTART_MAX_DELAY_MS
    );
    // Recovery remains available through arbitrarily long storage/runtime
    // outages. The counter is capped only to keep backoff arithmetic bounded.
    this.restartAttempts = Math.min(this.restartAttempts + 1, 16);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.spawnAndWait().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }
}

async function runRuntimeChild(transport: RuntimeTransport): Promise<void> {
  if (process.platform === "darwin") process.title = "Codex MCP Bridge Runtime";
  const generation = randomUUID();
  let activeOperation: OperationalStateOperationObservation | undefined;
  let operationStartedAt = 0;
  let observationToken = 0;
  let lastCommitAt: number | undefined;
  let closing = false;
  let store: BridgeStateStore | undefined;
  let upstream: ReturnType<typeof createExecutionRuntime> | undefined;
  let telemetry: BridgeTelemetryService | undefined;
  let readProjection: ChildProcessStateReadService | undefined;
  let httpServer: BridgeHttpServer | undefined;
  let stdioRuntime: BridgeStdioRuntime | undefined;
  let applicationService: BridgeApplicationService | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  const send = (message: RuntimeChildMessage) => {
    if (!process.connected || !process.send) return;
    try {
      process.send(message, () => {
        // A parent may close the IPC channel while an already-started state
        // operation is completing. Losing this observation must not crash the
        // child or change the operation's durable result.
      });
    } catch {
      // The supervisor owns recovery after IPC disconnect.
    }
  };
  const observeTransaction = (phase: OperationalStateOperationObservation["phase"]) => {
    const token = ++observationToken;
    if (phase === "write-lock-wait" || operationStartedAt === 0) {
      operationStartedAt = Date.now();
    }
    activeOperation = {
      access: "write",
      operation: "state-transaction",
      phase,
      startedAt: operationStartedAt,
      observedAt: Date.now()
    };
    send({ type: "operation", generation, observation: activeOperation });
    if (phase === "responding") {
      lastCommitAt = Date.now();
      queueMicrotask(() => {
        if (token !== observationToken || activeOperation?.access !== "write") return;
        activeOperation = undefined;
        operationStartedAt = 0;
        send({ type: "operation-clear", generation });
      });
    }
  };
  const observeSql = (sql: string) => {
    if (activeOperation?.access === "write") return;
    const statement = sql.trimStart().toUpperCase();
    if (!/^(SELECT|WITH|PRAGMA|EXPLAIN)\b/u.test(statement)) return;
    const token = ++observationToken;
    const startedAt = Date.now();
    activeOperation = {
      access: "read",
      operation: "state-query",
      phase: "read-snapshot",
      startedAt,
      observedAt: startedAt
    };
    send({ type: "operation", generation, observation: activeOperation });
    // better-sqlite3's trace callback runs immediately before the synchronous
    // statement. This microtask therefore cannot run until the read (and its
    // current synchronous projection stack) has yielded back to the loop.
    queueMicrotask(() => {
      if (token !== observationToken || activeOperation?.access !== "read") return;
      activeOperation = {
        ...activeOperation,
        phase: "serializing",
        observedAt: Date.now()
      };
      send({ type: "operation", generation, observation: activeOperation });
      queueMicrotask(() => {
        if (token !== observationToken || activeOperation?.access !== "read") return;
        activeOperation = undefined;
        send({ type: "operation-clear", generation });
      });
    });
  };

  const close = async (code = 0) => {
    if (closing) return;
    closing = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    const closeStep = async (step: () => void | Promise<void>) => {
      try {
        await step();
      } catch (error) {
        code = 1;
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    };
    await closeStep(async () => {
      if (!httpServer) return;
      await new Promise<void>((resolve, reject) => httpServer?.close(error =>
        error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
          ? reject(error)
          : resolve()
      ));
    });
    await closeStep(() => stdioRuntime?.close());
    await closeStep(() => upstream?.close());
    await closeStep(() => readProjection?.close());
    await closeStep(() => store?.close());
    await closeStep(() => telemetry?.close());
    if (process.connected) process.disconnect();
    process.exitCode = code;
  };

  try {
    const config = loadConfig();
    try {
      telemetry = await ChildProcessTelemetryService.start(config.telemetryDatabaseFile);
    } catch (error) {
      telemetry = new InMemoryTelemetryService();
      process.stderr.write(
        `Telemetry persistence unavailable; using bounded memory only: ` +
        `${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    store = new BridgeStateStore({
      file: config.stateDatabaseFile,
      traceSql: observeSql,
      onTransactionPhase: observeTransaction
    });
    readProjection = await ChildProcessStateReadService.start(
      config.stateDatabaseFile,
      process.env
    );
    const appServerLateResponses = new AppServerLateResponseJournal(store);
    upstream = createExecutionRuntime(config, {
      onLateResponse: response => appServerLateResponses.observe(response)
    });
    if (transport === "http") {
      httpServer = createHttpServer(config, upstream, undefined, {
        stateStore: store,
        telemetry,
        readProjection,
        healthDiagnostics: () => ({ appServerLateResponses: appServerLateResponses.status() }),
        conformanceFixtures: process.argv.slice(2).includes("--conformance-fixtures")
      });
      await new Promise<void>((resolve, reject) => {
        httpServer?.once("error", reject);
        httpServer?.listen(0, "127.0.0.1", () => {
          httpServer?.removeListener("error", reject);
          resolve();
        });
      });
      applicationService = httpServer.applicationService;
    } else {
      stdioRuntime = createStdioBridgeRuntime(config, upstream, {
        stateStore: store,
        telemetry,
        readProjection
      });
      await stdioRuntime.start();
      applicationService = stdioRuntime.applicationService;
    }
    unsubscribe = applicationService.subscribeChanges?.(topic => {
      send({ type: "change", generation, topic });
    });
    const address = httpServer?.address() as AddressInfo | null | undefined;
    if (transport === "http" && !address) {
      throw new Error("Isolated Bridge runtime address is unavailable.");
    }
    const health = (): BridgeRuntimeAdmissionSnapshot => {
      const operational = applicationService?.runtimeHealth?.() || emptyRuntimeHealth();
      const read = readProjection?.health();
      const diagnostic = telemetry?.status();
      return {
        ...operational,
        ...(read ? {
          readService: {
            status: read.reason,
            ...(read.generation ? { generation: read.generation } : {}),
            ...(read.heartbeatAgeMs !== undefined
              ? { heartbeatAgeMs: read.heartbeatAgeMs }
              : {}),
            inFlight: read.inFlight,
            capacity: read.capacity,
            ...(read.lastSnapshotAt !== undefined
              ? { lastSnapshotAt: read.lastSnapshotAt }
              : {}),
            ...(read.activeOperation ? { activeOperation: read.activeOperation } : {})
          }
        } : {}),
        ...(diagnostic ? {
          telemetryService: {
            status: telemetry instanceof InMemoryTelemetryService
              ? "memory-only"
              : diagnostic.connected ? "ready" : "recovering",
            queued: diagnostic.queued,
            inFlight: diagnostic.inFlight,
            retained: diagnostic.retained,
            dropped: diagnostic.dropped,
            failed: diagnostic.failed,
            ...(diagnostic.lastPersistedAt !== undefined
              ? { lastPersistedAt: diagnostic.lastPersistedAt }
              : {})
          }
        } : {})
      };
    };
    send({
      type: "ready",
      transport,
      generation,
      ...(address ? { port: address.port } : {}),
      heartbeatAt: Date.now(),
      runtimeHealth: health(),
      ...(lastCommitAt !== undefined ? { lastCommitAt } : {})
    });
    heartbeat = setInterval(() => send({
      type: "heartbeat",
      generation,
      heartbeatAt: Date.now(),
      runtimeHealth: health(),
      ...(lastCommitAt !== undefined ? { lastCommitAt } : {})
    }), HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    process.on("message", value => {
      if (!isRuntimeParentMessage(value) || closing) return;
      if (value.type === "close") {
        void close();
        return;
      }
      if (value.generation !== generation) return;
      void dispatchApplicationRpc(applicationService as BridgeApplicationService, value).then(
        result => send({
          type: "rpc-response",
          generation,
          requestId: value.requestId,
          ok: true,
          result: result === undefined ? null : result
        }),
        error => send({
          type: "rpc-response",
          generation,
          requestId: value.requestId,
          ok: false,
          error: {
            code: runtimeErrorCode(error),
            message: error instanceof Error ? error.message : String(error)
          }
        })
      );
    });
    if (transport === "stdio") process.stdin.once("end", () => { void close(); });
    process.once("disconnect", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
    process.once("SIGINT", () => { void close(); });
  } catch (error) {
    send({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
    await close(1);
  }
}

async function dispatchApplicationRpc(
  applicationService: BridgeApplicationService,
  request: RuntimeRpcRequestMessage
): Promise<unknown> {
  const operation = applicationService[request.method];
  if (typeof operation !== "function") {
    throw new Error(`RUNTIME_OPERATION_UNAVAILABLE: ${request.method} is unavailable.`);
  }
  const result = await (operation as (...args: unknown[]) => unknown).apply(
    applicationService,
    request.args
  );
  const encoded = JSON.stringify(result === undefined ? null : result);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RPC_BYTES) {
    throw new Error("RUNTIME_RESPONSE_TOO_LARGE: Runtime response exceeds its IPC limit.");
  }
  return result;
}

function emptyRuntimeHealth(): BridgeRuntimeAdmissionSnapshot {
  return {
    acceptingNewJobs: false,
    activeJobs: 0,
    pendingAdmissions: 0,
    backgroundProcessState: "unknown",
    backgroundProcesses: 0,
    backgroundProcessAgents: 0,
    backgroundProcessUnknownAgents: 0
  };
}

function runtimeErrorCode(error: unknown): string {
  const stateCode = operationalStateErrorCode(error);
  if (stateCode !== "STATE_COMMAND_FAILED") return stateCode;
  const message = error instanceof Error ? error.message : String(error);
  return /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] || "RUNTIME_REQUEST_FAILED";
}

function isRuntimeChildMessage(value: unknown): value is RuntimeChildMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "fatal") return typeof message.message === "string";
  if (message.type === "ready") {
    const transport = message.transport === "http" || message.transport === "stdio"
      ? message.transport
      : undefined;
    return transport !== undefined && typeof message.generation === "string" &&
      (transport === "stdio" || Number.isInteger(message.port) && Number(message.port) > 0) &&
      Number.isSafeInteger(message.heartbeatAt) && isRuntimeHealth(message.runtimeHealth);
  }
  if (message.type === "heartbeat") {
    return typeof message.generation === "string" &&
      Number.isSafeInteger(message.heartbeatAt) && isRuntimeHealth(message.runtimeHealth);
  }
  if (message.type === "operation") {
    return typeof message.generation === "string" && isOperation(message.observation);
  }
  if (message.type === "operation-clear") return typeof message.generation === "string";
  if (message.type === "change") {
    return typeof message.generation === "string" &&
      ["dashboard", "settings", "enrichment"].includes(String(message.topic));
  }
  if (message.type === "rpc-response") {
    return typeof message.generation === "string" &&
      typeof message.requestId === "string" && typeof message.ok === "boolean";
  }
  return false;
}

function isRuntimeParentMessage(value: unknown): value is RuntimeParentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "close") return true;
  return message.type === "rpc" &&
    typeof message.generation === "string" &&
    typeof message.requestId === "string" &&
    typeof message.method === "string" &&
    APPLICATION_RPC_METHODS.includes(message.method as ApplicationRpcMethod) &&
    Array.isArray(message.args) &&
    Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_RPC_BYTES;
}

function isRuntimeHealth(value: unknown): value is BridgeRuntimeAdmissionSnapshot {
  if (!value || typeof value !== "object") return false;
  const health = value as Record<string, unknown>;
  return typeof health.acceptingNewJobs === "boolean" &&
    Number.isSafeInteger(health.activeJobs) && Number(health.activeJobs) >= 0 &&
    Number.isSafeInteger(health.pendingAdmissions) && Number(health.pendingAdmissions) >= 0 &&
    (health.backgroundProcessState === "confirmed" || health.backgroundProcessState === "unknown");
}

function isOperation(value: unknown): value is OperationalStateOperationObservation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Record<string, unknown>;
  return (operation.access === "read" || operation.access === "write") &&
    typeof operation.operation === "string" && operation.operation.length <= 80 &&
    [
      "queue-wait",
      "write-lock-wait",
      "read-snapshot",
      "executing",
      "committing",
      "serializing",
      "responding"
    ].includes(
      String(operation.phase)
    ) &&
    Number.isSafeInteger(operation.startedAt) && Number(operation.startedAt) >= 0 &&
    Number.isSafeInteger(operation.observedAt) &&
    Number(operation.observedAt) >= Number(operation.startedAt);
}

function requestHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  for (const name of HOP_BY_HOP_HEADERS) delete result[name];
  return result;
}

function requestContentLength(headers: IncomingHttpHeaders): number | undefined {
  const raw = headers["content-length"];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (value === undefined || !/^\d+$/u.test(value)) return MAX_RPC_BYTES + 1;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : MAX_RPC_BYTES + 1;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  for (const name of HOP_BY_HOP_HEADERS) delete result[name];
  return result;
}

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
] as const;

function writeUnavailable(
  response: import("node:http").ServerResponse,
  reason: string
): void {
  if (response.headersSent || response.destroyed) return;
  response.setHeader("retry-after", "1");
  writeJson(response, 503, {
    ok: false,
    code: "RUNTIME_RESPONSE_UNCONFIRMED",
    reason
  });
}

function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown
): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

if (process.argv.includes(CHILD_FLAG)) {
  await runRuntimeChild(process.argv.includes(CHILD_STDIO_FLAG) ? "stdio" : "http");
}
