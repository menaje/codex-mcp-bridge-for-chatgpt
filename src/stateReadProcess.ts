import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { CodexService, type CodexSessionAuthBoundaryEvidence } from "./codexService.js";
import { ScopeResolver } from "./scopeResolver.js";
import { createModelCatalog } from "./server.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { BridgeStateStore } from "./stateStore.js";
import {
  CodexJobRegistry,
  createBridgeReadProjectionService,
  TaskProjectAvailabilityProjection,
  type BridgeApplicationService,
  type BridgeDashboardEnrichment,
  type BridgeDashboardHistoryDetailOptions,
  type BridgeDashboardRuntimePlan,
  type BridgeDashboardSnapshotOptions,
  type BridgeReadProjectionService,
  type BridgeSettingsSnapshotOptions,
  type DashboardHistoryDetail,
  type DashboardView,
  type SettingsView
} from "./tools.js";
import type { CodexUpstream, ToolResult } from "./upstream.js";
import { UserSettingsStore } from "./userSettings.js";

const CHILD_FLAG = "--bridge-state-read-child";
const PROTOCOL_VERSION = 2;
const HEARTBEAT_MS = 250;
const STALE_MS = 2_000;
const STARTUP_TIMEOUT_MS = 10_000;
const REQUEST_DEADLINE_MS = 10_000;
const CAPACITY = 16;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const FORCE_CLOSE_MS = 2_000;
const RESTART_BASE_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 10_000;

const READ_METHODS = [
  "dashboardSnapshot",
  "dashboardHistoryDetail",
  "settingsSnapshot",
  "dashboardRuntimePlan",
  "dashboardSnapshotWithEnrichment"
] as const;
type ReadMethod = (typeof READ_METHODS)[number];
type PublicReadMethod = "dashboardSnapshot" | "dashboardHistoryDetail" | "settingsSnapshot";

type ReadyMessage = {
  type: "ready";
  version: number;
  generation: string;
  heartbeatAt: number;
};
type HeartbeatMessage = {
  type: "heartbeat";
  generation: string;
  heartbeatAt: number;
  inFlight: number;
};
type OperationMessage = {
  type: "operation";
  generation: string;
  requestId: string;
  method: PublicReadMethod;
  phase: "queue-wait" | "read-snapshot" | "serializing" | "responding";
  startedAt: number;
  observedAt: number;
};
type ResponseMessage = {
  type: "response";
  generation: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  measurement?: StateReadMeasurement;
};

/** Opt-in, fixed-size fixture diagnostics. No SQL, arguments, paths or results. */
export type StateReadMeasurement = {
  method: ReadMethod;
  queueMs: number;
  configMs: number;
  databaseOpenMs: number;
  sessionsMs: number;
  jobsMs: number;
  settingsMs: number;
  facadeMs: number;
  projectionMs: number;
  cleanupMs: number;
  jsonPreflightMs: number;
  responseBytes: number;
  sqlStatements: number;
  selectStatements: number;
};
export type StateReadObservation = StateReadMeasurement & {
  requestId: string;
  endToEndMs: number;
  callerAbandoned: boolean;
};
type FatalMessage = { type: "fatal"; message: string };
type ChildMessage = ReadyMessage | HeartbeatMessage | OperationMessage | ResponseMessage | FatalMessage;

type RequestMessage = {
  type: "request";
  generation: string;
  requestId: string;
  method: ReadMethod;
  args: unknown[];
  authBoundary: CodexSessionAuthBoundaryEvidence | null;
  measure?: boolean;
};
type CloseMessage = { type: "close" };
type ParentMessage = RequestMessage | CloseMessage;

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  /** Caller deadline elapsed, but the child request still occupies capacity. */
  abandoned: boolean;
  started: number;
};

export type StateReadServiceHealth = {
  ready: boolean;
  reason: "ready" | "read-starting" | "read-stale" | "read-recovering" | "read-capacity";
  generation?: string;
  heartbeatAgeMs?: number;
  inFlight: number;
  capacity: number;
  lastSnapshotAt?: number;
  activeOperation?: {
    method: PublicReadMethod;
    phase: "queue-wait" | "read-snapshot" | "serializing" | "responding";
    startedAt: number;
    observedAt: number;
  };
};

export class ChildProcessStateReadService implements BridgeReadProjectionService {
  private child?: ChildProcess;
  private generation?: string;
  private lastHeartbeatAt?: number;
  private lastSnapshotAt?: number;
  private activeOperation?: StateReadServiceHealth["activeOperation"];
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private closePromise?: Promise<void>;
  private restartTimer?: NodeJS.Timeout;
  private restartAttempts = 0;

  private constructor(
    private readonly file: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly requestDeadlineMs: number,
    private readonly authBoundary: () => CodexSessionAuthBoundaryEvidence | null,
    private readonly onMeasurement?: (value: StateReadObservation) => void
  ) {}

  static async start(
    file: string,
    environment: NodeJS.ProcessEnv = process.env,
    options: {
      /** Test/diagnostic override. */ requestDeadlineMs?: number;
      /** Read-only ownership evidence from the operational service, never an execution grant. */
      authBoundary?: () => CodexSessionAuthBoundaryEvidence | null;
      /** Fixture diagnostics only; absent by default and never exposed on the wire. */
      onMeasurement?: (value: StateReadObservation) => void;
    } = {}
  ): Promise<ChildProcessStateReadService> {
    const requestDeadlineMs = options.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
    if (!Number.isSafeInteger(requestDeadlineMs) || requestDeadlineMs < 1) {
      throw new Error("STATE_READ_DEADLINE_INVALID: Read deadline must be a positive integer.");
    }
    const service = new ChildProcessStateReadService(file, environment, requestDeadlineMs,
      options.authBoundary || (() => null), options.onMeasurement);
    try {
      await service.spawnAndWait();
      return service;
    } catch (error) {
      await service.close().catch(() => undefined);
      throw error;
    }
  }

  dashboardSnapshot(options?: BridgeDashboardSnapshotOptions): Promise<DashboardView> {
    return this.rpc("dashboardSnapshot", [options || {}]) as Promise<DashboardView>;
  }

  dashboardHistoryDetail(
    options: BridgeDashboardHistoryDetailOptions
  ): Promise<DashboardHistoryDetail> {
    return this.rpc("dashboardHistoryDetail", [options]) as Promise<DashboardHistoryDetail>;
  }

  settingsSnapshot(options?: BridgeSettingsSnapshotOptions): Promise<SettingsView> {
    return this.rpc("settingsSnapshot", [options || {}]) as Promise<SettingsView>;
  }

  dashboardRuntimePlan(
    options?: BridgeDashboardSnapshotOptions
  ): Promise<BridgeDashboardRuntimePlan> {
    return this.rpc("dashboardRuntimePlan", [options || {}]) as Promise<BridgeDashboardRuntimePlan>;
  }

  dashboardSnapshotWithEnrichment(
    options: BridgeDashboardSnapshotOptions,
    enrichment: BridgeDashboardEnrichment
  ): Promise<DashboardView> {
    return this.rpc("dashboardSnapshotWithEnrichment", [options, enrichment]) as Promise<DashboardView>;
  }

  /** Test/supervisor visibility only; never exposed through the Bridge protocol. */
  get processId(): number | undefined {
    return this.child?.pid;
  }

  health(now = Date.now()): StateReadServiceHealth {
    const processConnected = Boolean(this.child?.connected && this.child.exitCode === null);
    const heartbeatAgeMs = this.lastHeartbeatAt === undefined
      ? undefined
      : Math.max(0, now - this.lastHeartbeatAt);
    const fresh = processConnected && Boolean(this.generation) &&
      heartbeatAgeMs !== undefined && heartbeatAgeMs <= STALE_MS;
    const reason = !processConnected
      ? "read-recovering"
      : !this.generation || heartbeatAgeMs === undefined
        ? "read-starting"
        : !fresh
          ? "read-stale"
          : this.pending.size >= CAPACITY
            ? "read-capacity"
            : "ready";
    return {
      ready: reason === "ready",
      reason,
      ...(this.generation ? { generation: this.generation } : {}),
      ...(heartbeatAgeMs !== undefined ? { heartbeatAgeMs } : {}),
      inFlight: this.pending.size,
      capacity: CAPACITY,
      ...(this.lastSnapshotAt !== undefined ? { lastSnapshotAt: this.lastSnapshotAt } : {}),
      ...(this.activeOperation ? { activeOperation: { ...this.activeOperation } } : {})
    };
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeChild();
    return this.closePromise;
  }

  private rpc(method: ReadMethod, args: unknown[]): Promise<unknown> {
    const child = this.child;
    if (this.closed || !child?.connected || !this.generation) {
      return Promise.reject(new Error("STATE_READ_UNAVAILABLE: Read projection is recovering."));
    }
    if (this.pending.size >= CAPACITY) {
      return Promise.reject(new Error("STATE_READ_CAPACITY: Read projection capacity is exhausted."));
    }
    const requestId = randomUUID();
    let authBoundary: CodexSessionAuthBoundaryEvidence | null;
    try { authBoundary = this.authBoundary(); }
    catch { authBoundary = null; }
    const message: RequestMessage = {
      type: "request",
      generation: this.generation,
      requestId,
      method,
      args,
      authBoundary,
      ...(this.onMeasurement ? { measure: true } : {})
    };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_MESSAGE_BYTES) {
      return Promise.reject(new Error("STATE_READ_REQUEST_TOO_LARGE: Read request exceeds its IPC limit."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending || pending.abandoned) return;
        pending.abandoned = true;
        reject(new Error(
          "STATE_READ_STALE: The read projection missed its observation deadline; retain the last confirmed view."
        ));
      }, this.requestDeadlineMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer, abandoned: false, started: performance.now() });
      child.send(message, error => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        if (!pending.abandoned) {
          pending.reject(new Error(`STATE_READ_SEND_FAILED: ${error.message}`));
        }
      });
    });
  }

  private spawnAndWait(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("STATE_READ_CLOSED: Read projection closed."));
    }
    const modulePath = fileURLToPath(import.meta.url);
    const args = modulePath.endsWith(".ts")
      ? ["--import", "tsx", modulePath, CHILD_FLAG, this.file]
      : [modulePath, CHILD_FLAG, this.file];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...this.environment,
        CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: this.file
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    this.child = child;
    this.generation = undefined;
    this.lastHeartbeatAt = undefined;
    this.activeOperation = undefined;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        const error = new Error("STATE_READ_START_TIMEOUT: Read projection did not become ready.");
        finish(error);
        child.kill("SIGKILL");
      }, STARTUP_TIMEOUT_MS);
      timer.unref();
      child.stderr?.on("data", chunk => {
        if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") process.stderr.write(chunk);
      });
      child.once("error", error => {
        finish(error);
        this.onExit(child, error);
      });
      child.once("exit", (code, signal) => {
        const error = new Error(`STATE_READ_PROCESS_EXITED: code=${code}, signal=${signal}`);
        finish(error);
        this.onExit(child, error);
      });
      child.on("message", value => {
        if (this.child !== child || !isChildMessage(value)) return;
        if (value.type === "fatal") {
          finish(new Error(`STATE_READ_START_FAILED: ${value.message}`));
          return;
        }
        if (value.type === "ready") {
          if (value.version !== PROTOCOL_VERSION) {
            finish(new Error(`STATE_READ_INCOMPATIBLE: version ${value.version}`));
            return;
          }
          this.generation = value.generation;
          this.lastHeartbeatAt = value.heartbeatAt;
          finish();
          return;
        }
        if (value.generation !== this.generation) return;
        if (value.type === "heartbeat") {
          this.lastHeartbeatAt = value.heartbeatAt;
          return;
        }
        if (value.type === "operation") {
          this.activeOperation = {
            method: value.method,
            phase: value.phase,
            startedAt: value.startedAt,
            observedAt: value.observedAt
          };
          return;
        }
        this.activeOperation = undefined;
        const pending = this.pending.get(value.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(value.requestId);
        if (value.measurement) {
          try { this.onMeasurement?.({ ...value.measurement, requestId: value.requestId,
            endToEndMs: performance.now() - pending.started, callerAbandoned: pending.abandoned }); }
          catch { /* Diagnostics cannot change read settlement or capacity. */ }
        }
        if (pending.abandoned) return;
        if (value.ok) {
          this.lastSnapshotAt = Date.now();
          pending.resolve(value.result);
        } else {
          pending.reject(new Error(`STATE_READ_FAILED: ${value.error || "Read projection failed."}`));
        }
      });
    });
  }

  private onExit(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.generation = undefined;
    this.lastHeartbeatAt = undefined;
    this.activeOperation = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (!pending.abandoned) {
        pending.reject(new Error(`STATE_READ_UNAVAILABLE: ${error.message}`));
      }
    }
    this.pending.clear();
    if (!this.closed) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** this.restartAttempts,
      RESTART_MAX_DELAY_MS
    );
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.spawnAndWait().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }

  private async closeChild(): Promise<void> {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (!pending.abandoned) {
        pending.reject(new Error("STATE_READ_CLOSED: Read projection closed."));
      }
    }
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: "close" } satisfies CloseMessage);
    await new Promise<void>(resolve => {
      let settled = false;
      const force = setTimeout(() => child.kill("SIGKILL"), FORCE_CLOSE_MS);
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
}

class ProjectionUpstream implements CodexUpstream {
  async listTools(): Promise<unknown> { return { tools: [] }; }
  async callTool(): Promise<ToolResult> {
    throw new Error("STATE_READ_UPSTREAM_UNAVAILABLE: Runtime inspection stays in the operational process.");
  }
  async close(): Promise<void> {}
}

async function runChild(file: string): Promise<void> {
  const generation = randomUUID();
  const codexService = new CodexService(process.env);
  let closing = false;
  let inFlight = 0;
  let tail: Promise<void> = Promise.resolve();
  const send = (message: ChildMessage) => {
    if (!process.connected || !process.send) return;
    try { process.send(message, () => {}); } catch { /* Parent owns recovery. */ }
  };
  const heartbeat = setInterval(() => send({
    type: "heartbeat",
    generation,
    heartbeatAt: Date.now(),
    inFlight
  }), HEARTBEAT_MS);
  heartbeat.unref();
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    await tail.catch(() => undefined);
    if (process.connected) process.disconnect();
  };
  try {
    // Validate the query-only connection before advertising readiness.
    const validation = new BridgeStateStore({ file, readOnly: true });
    validation.close();
    send({
      type: "ready",
      version: PROTOCOL_VERSION,
      generation,
      heartbeatAt: Date.now()
    });
    process.on("message", value => {
      if (!isParentMessage(value) || closing) return;
      if (value.type === "close") {
        void close();
        return;
      }
      if (value.generation !== generation) return;
      inFlight += 1;
      const startedAt = Date.now();
      const queuedAt = performance.now();
      const measurement: StateReadMeasurement | undefined = value.measure ? {
        method: value.method, queueMs: 0, configMs: 0, databaseOpenMs: 0,
        sessionsMs: 0, jobsMs: 0, settingsMs: 0, facadeMs: 0, projectionMs: 0,
        cleanupMs: 0, jsonPreflightMs: 0, responseBytes: 0, sqlStatements: 0, selectStatements: 0
      } : undefined;
      const observe = (phase: OperationMessage["phase"]) => send({
        type: "operation",
        generation,
        requestId: value.requestId,
        method: publicReadMethod(value.method),
        phase,
        startedAt,
        observedAt: Date.now()
      });
      observe(inFlight > 1 ? "queue-wait" : "read-snapshot");
      const run = tail.then(async () => {
        if (measurement) measurement.queueMs = performance.now() - queuedAt;
        observe("read-snapshot");
        // Bridge read permissions do not depend on an execution login snapshot.
        const result = await executeProjection(file, value.method, value.args, codexService, measurement);
        observe("serializing");
        const encodingAt = measurement ? performance.now() : 0;
        const encoded = JSON.stringify(result === undefined ? null : result);
        const responseBytes = Buffer.byteLength(encoded, "utf8");
        if (measurement) {
          measurement.jsonPreflightMs = performance.now() - encodingAt;
          measurement.responseBytes = responseBytes;
        }
        if (responseBytes > MAX_MESSAGE_BYTES) {
          throw new Error("Read projection response exceeds its IPC limit.");
        }
        observe("responding");
        send({
          type: "response",
          generation,
          requestId: value.requestId,
          ok: true,
          result: result === undefined ? null : result,
          ...(measurement ? { measurement } : {})
        });
      }).catch(error => send({
        type: "response",
        generation,
        requestId: value.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(measurement ? { measurement } : {})
      })).finally(() => { inFlight = Math.max(0, inFlight - 1); });
      tail = run;
    });
    process.once("disconnect", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
    process.once("SIGINT", () => { void close(); });
  } catch (error) {
    send({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
    await close();
    process.exitCode = 1;
  }
}

async function executeProjection(
  file: string,
  method: ReadMethod,
  args: unknown[],
  codexService: CodexService,
  measurement?: StateReadMeasurement
): Promise<unknown> {
  let stageAt = measurement ? performance.now() : 0;
  const mark = (key: "configMs" | "databaseOpenMs" | "sessionsMs" | "jobsMs" |
    "settingsMs" | "facadeMs" | "projectionMs" | "cleanupMs") => {
    if (!measurement) return;
    const now = performance.now();
    measurement[key] = now - stageAt;
    stageAt = now;
  };
  const config = loadConfig({
    ...process.env,
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file
  });
  // Settings are read in a separate process. They still need the applied CLI
  // selection for model discovery, even though no task worker runs here.
  config.codexService = codexService;
  mark("configMs");
  const stateStore = new BridgeStateStore({ file, readOnly: true,
    ...(measurement ? { traceSql: (sql: string) => {
      measurement.sqlStatements += 1;
      if (/^\s*SELECT\b/i.test(sql)) measurement.selectStatements += 1;
    } } : {}) });
  mark("databaseOpenMs");
  const upstream = new ProjectionUpstream();
  const sessions = new SessionRegistry({
    stateStore,
    allowedRoots: config.allowedRoots,
    maxSessions: 1_000_000,
    projectionOnly: true,
  });
  mark("sessionsMs");
  const jobs = new CodexJobRegistry({
    maxConcurrentJobs: config.maxConcurrentJobs,
    ttlMs: config.jobTtlMs,
    maxJobs: Math.max(config.maxRetainedJobs, config.maxConcurrentJobs),
    maxResultBytes: config.maxJobResultBytes,
    staleAfterMs: config.jobStaleAfterMs,
    stateStore,
    allowedRoots: config.allowedRoots,
    projectionOnly: true
  });
  mark("jobsMs");
  const userSettings = new UserSettingsStore(config, {
    stateStore,
    projectionOnly: true
  });
  mark("settingsMs");
  const scopeResolver = new ScopeResolver({ stateStore });
  const projectAvailability = new TaskProjectAvailabilityProjection(config);
  const applicationService = createBridgeReadProjectionService(
    config,
    upstream,
    sessions,
    jobs,
    createModelCatalog(config, upstream),
    userSettings,
    scopeResolver,
    projectAvailability
  );
  mark("facadeMs");
  try {
    const operation = applicationService[method];
    if (typeof operation !== "function") {
      throw new Error(`Unsupported read projection method: ${method}`);
    }
    const result = await (operation as (...values: unknown[]) => unknown).apply(
      applicationService,
      args
    );
    mark("projectionMs");
    return result;
  } finally {
    await jobs.closeThreadConnections();
    await upstream.close();
    stateStore.close();
    mark("cleanupMs");
  }
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "fatal") return typeof message.message === "string";
  if (message.type === "ready") {
    return Number.isSafeInteger(message.version) && typeof message.generation === "string" &&
      Number.isSafeInteger(message.heartbeatAt);
  }
  if (message.type === "heartbeat") {
    return typeof message.generation === "string" && Number.isSafeInteger(message.heartbeatAt) &&
      Number.isSafeInteger(message.inFlight);
  }
  if (message.type === "operation") {
    return typeof message.generation === "string" && typeof message.requestId === "string" &&
      READ_METHODS.includes(message.method as ReadMethod) &&
      ["queue-wait", "read-snapshot", "serializing", "responding"].includes(String(message.phase)) &&
      Number.isSafeInteger(message.startedAt) && Number.isSafeInteger(message.observedAt);
  }
  return message.type === "response" && typeof message.generation === "string" &&
    typeof message.requestId === "string" && typeof message.ok === "boolean";
}

function publicReadMethod(method: ReadMethod): PublicReadMethod {
  return method === "settingsSnapshot"
    ? "settingsSnapshot"
    : method === "dashboardHistoryDetail"
      ? "dashboardHistoryDetail"
      : "dashboardSnapshot";
}

function isParentMessage(value: unknown): value is ParentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "close") return true;
  return message.type === "request" && typeof message.generation === "string" &&
    typeof message.requestId === "string" && READ_METHODS.includes(message.method as ReadMethod) &&
    Array.isArray(message.args) && isReadBoundaryEvidence(message.authBoundary) &&
    Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_MESSAGE_BYTES;
}

function isReadBoundaryEvidence(value: unknown): value is CodexSessionAuthBoundaryEvidence | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const evidence = value as Record<string, unknown>;
  return typeof evidence.key === "string" && /^[a-f0-9]{64}$/.test(evidence.key) &&
    evidence.allowLegacyShared === false &&
    ["observed", "last-confirmed", "unverified"].includes(String(evidence.ownerStatus)) &&
    (evidence.ownerConfirmedAt === null || Number.isSafeInteger(evidence.ownerConfirmedAt)) &&
    Number.isSafeInteger(evidence.snapshotAt) &&
    (evidence.ownerStatus === "unverified" ? evidence.ownerConfirmedAt === null
      : typeof evidence.ownerConfirmedAt === "number" && evidence.ownerConfirmedAt <= (evidence.snapshotAt as number));
}

const childFile = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
if (process.argv.includes(CHILD_FLAG)) {
  if (!childFile) throw new Error("State read database path is required.");
  await runChild(childFile);
}
