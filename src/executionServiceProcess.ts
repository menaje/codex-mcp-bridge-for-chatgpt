import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { codexProcessEnvironment } from "../scripts/runtime-env.mjs";
import {
  CodexAppServerUpstreamPool,
  type CodexAppServerLateResponse,
  type CodexAppServerProtocolOptions
} from "./appServerUpstream.js";
import { UNVERIFIED_APP_SERVER_CAPABILITIES } from "./cliProtocol.js";
import { isCodexInputEvent } from "./codexInputs.js";
import type { BackendCapabilities } from "./modelPolicy.js";
import type {
  CodexBackgroundTerminal,
  CodexInteractionInput,
  CodexInteractionResponse,
  CodexProgress,
  CodexThreadContinueRequest,
  CodexThreadForkRequest,
  CodexThreadResumeProbe,
  CodexThreadStartRequest,
  CodexUpstream,
  CodexWeeklyUsage,
  ToolResult,
  UpstreamWorkerAssignment
} from "./upstream.js";
import type { ThreadReleaseOptions, ThreadReleaseResult } from "./threadConnections.js";
import {
  type JsonRpcProcessIdentity,
  type JsonRpcTerminationResult
} from "./jsonRpcProcess.js";
import type { WorkerTerminationCorrelation } from "./cancellation.js";
import {
  SupervisedProcessTreeRegistry,
  processObservationFailure,
  supervisedProcessKey,
  type ProcessObservationFailure,
  type SupervisedProcessIdentity,
  type SupervisedProcessTreeSnapshot
} from "./processTreeSupervisor.js";

const CHILD_FLAG = "--codex-execution-child";
const PROTOCOL = "bridge-codex-execution" as const;
const PROTOCOL_VERSION = 5 as const;
const HEARTBEAT_MS = 250;
const HEARTBEAT_STALE_MS = 2_000;
const STALE_RESTART_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 1_000;
const WATCHDOG_PAUSE_THRESHOLD_MS = 3_000;
const STARTUP_TIMEOUT_MS = 20_000;
const FORCE_CLOSE_MS = 5_000;
const WORKER_TREE_OBSERVATION_MS = 250;
const WORKER_OBSERVATION_RETRY_DELAY_MS = 100;
const ORPHAN_CLEANUP_GRACE_MS = 1_500;
const RESTART_BASE_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 10_000;
const RESTART_STABLE_MS = 60_000;
const MAX_PENDING_REQUESTS = 128;
const CONTROL_REQUEST_RESERVE = 16;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES_IN_FLIGHT = 32 * 1024 * 1024;
const CONTROL_REQUEST_BYTES_RESERVE = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_OUTBOUND_MESSAGE_BYTES = MAX_RESPONSE_BYTES + 64 * 1024;
const MAX_OUTBOUND_CRITICAL_MESSAGES = 256;
const MAX_OUTBOUND_CRITICAL_BYTES = 32 * 1024 * 1024;
const MAX_OUTBOUND_PROGRESS_MESSAGES = 128;
const MAX_OUTBOUND_PROGRESS_BYTES = 8 * 1024 * 1024;

const EXECUTION_OPERATIONS = [
  "listTools",
  "prepareExecution",
  "listModels",
  "readAccountSnapshot",
  "readAccountRateLimits",
  "startThread",
  "continueThread",
  "forkThread",
  "archiveThread",
  "restoreThread",
  "probeThread",
  "releaseThreadConnection",
  "listBackgroundTerminals",
  "listLoadedBackgroundTerminals",
  "terminateBackgroundTerminal",
  "callTool",
  "forceTerminateWorker",
  "respondToInteraction",
  "steerThread"
] as const;

type ExecutionOperation = (typeof EXECUTION_OPERATIONS)[number];

const THREAD_SUBJECT_OPERATIONS = new Set<ExecutionOperation>([
  "archiveThread",
  "restoreThread",
  "probeThread",
  "releaseThreadConnection",
  "listBackgroundTerminals",
  "listLoadedBackgroundTerminals",
  "terminateBackgroundTerminal",
  "steerThread"
]);

const TURN_EXECUTION_OPERATIONS = new Set<ExecutionOperation>([
  "startThread",
  "continueThread",
  "forkThread",
  "callTool"
]);

const CONTROL_EXECUTION_OPERATIONS = new Set<ExecutionOperation>([
  "releaseThreadConnection",
  "terminateBackgroundTerminal",
  "forceTerminateWorker",
  "respondToInteraction",
  "steerThread"
]);

export type CodexExecutionRequestLimits = {
  maxPendingRequests: number;
  controlRequestReserve: number;
  maxBytesInFlight: number;
  controlRequestBytesReserve: number;
};

type SerializableProtocolOptions = Pick<
  CodexAppServerProtocolOptions,
  | "versionCheckTimeoutMs"
  | "requestTimeoutMs"
  | "initializeTimeoutMs"
  | "interruptTimeoutMs"
>;

type ChildConfiguration = {
  protocol: typeof PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  command: string;
  poolSize: number;
  options: SerializableProtocolOptions;
};

type RequestMessage = {
  type: "request";
  generation: string;
  requestId: string;
  operation: ExecutionOperation;
  args: unknown[];
};

type ProtectMessage = {
  type: "protect";
  generation: string;
  threadId: string;
};

type ReleaseCheckResponseMessage = {
  type: "release-check-response";
  generation: string;
  requestId: string;
  checkId: string;
  allowed: boolean;
};

type WorkerRegistrationAckMessage = {
  type: "worker-registration-ack";
  generation: string;
  registrationId: string;
};

type WorkerCleanupAckMessage = {
  type: "worker-cleanup-ack";
  generation: string;
  cleanupId: string;
  ok: boolean;
};

type CloseMessage = { type: "close" };
type ParentMessage =
  | RequestMessage
  | ProtectMessage
  | ReleaseCheckResponseMessage
  | WorkerRegistrationAckMessage
  | WorkerCleanupAckMessage
  | CloseMessage;

type ReadyMessage = {
  type: "ready";
  protocol: typeof PROTOCOL;
  version: number;
  generation: string;
  heartbeatAt: number;
  capabilities: BackendCapabilities;
};

type HeartbeatMessage = {
  type: "heartbeat";
  generation: string;
  heartbeatAt: number;
  inFlight: number;
};

type ProgressMessage = {
  type: "progress";
  generation: string;
  requestId: string;
  progress: CodexProgress;
  interactionId?: string;
  interactionInput?: CodexInteractionInput;
};

type AssignmentMessage = {
  type: "assignment";
  generation: string;
  requestId: string;
  assignment: UpstreamWorkerAssignment;
  capabilities: BackendCapabilities;
};

type ResponseMessage = {
  type: "response";
  generation: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  capabilities?: BackendCapabilities;
};

type LateResponseMessage = {
  type: "late-response";
  generation: string;
  response: CodexAppServerLateResponse;
};

type ReleaseCheckMessage = {
  type: "release-check";
  generation: string;
  requestId: string;
  checkId: string;
  threadId: string;
};

type WorkerStartedMessage = {
  type: "worker-started";
  generation: string;
  registrationId: string;
  identity: JsonRpcProcessIdentity;
};

type WorkerExitedMessage = {
  type: "worker-exited";
  generation: string;
  cleanupId: string;
  identity: JsonRpcProcessIdentity;
};

type WorkerCleanupStartedMessage = {
  type: "worker-cleanup-started";
  generation: string;
  cleanupId: string;
  identity: JsonRpcProcessIdentity;
};

type WorkerObservedMessage = {
  type: "worker-observed";
  generation: string;
  trees: SupervisedProcessTreeSnapshot[];
};

export type WorkerObservationIncident = {
  side: "parent" | "child";
  phase: "refresh" | "registration" | "cleanup";
  state: "degraded" | "recovered" | "failed";
  failure: ProcessObservationFailure;
};

export type ExecutorExitReason =
  | "worker-observation-failed"
  | "worker-cleanup-unconfirmed"
  | "ipc-send-failed"
  | "ipc-serialization-failed"
  | "ipc-message-too-large"
  | "ipc-capacity-exceeded";

type ExecutorExitIntentMessage = {
  type: "executor-exit-intent";
  generation: string;
  reason: ExecutorExitReason;
};

type WorkerObservationStatusMessage = {
  type: "worker-observation-status";
  generation: string;
  incident: WorkerObservationIncident;
};

type FatalMessage = { type: "fatal"; message: string };
type ChildMessage =
  | ReadyMessage
  | HeartbeatMessage
  | ProgressMessage
  | AssignmentMessage
  | ResponseMessage
  | LateResponseMessage
  | ReleaseCheckMessage
  | WorkerStartedMessage
  | WorkerObservedMessage
  | WorkerObservationStatusMessage
  | ExecutorExitIntentMessage
  | WorkerCleanupStartedMessage
  | WorkerExitedMessage
  | FatalMessage;

type PendingRequest = {
  operation: ExecutionOperation;
  control: boolean;
  bytes: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (progress: CodexProgress) => void;
  onAssigned?: (assignment: UpstreamWorkerAssignment) => void;
  activeThreadIds: Set<string>;
  interactionId?: string;
  subjectThreadId?: string;
  canRelease?: ThreadReleaseOptions["canRelease"];
};

export type CodexExecutionServiceHealth = {
  status: "idle" | "starting" | "ready" | "stale" | "recovering" | "capacity";
  generation?: string;
  heartbeatAgeMs?: number;
  inFlight: number;
  capacity: number;
  ordinaryInFlight?: number;
  ordinaryCapacity?: number;
  bytesInFlight?: number;
  byteCapacity?: number;
  ordinaryBytesInFlight?: number;
  ordinaryByteCapacity?: number;
  processId?: number;
  supervisedWorkers?: number;
  supervisedProcesses?: number;
};

export type ChildProcessCodexExecutionServiceOptions = {
  command: string;
  poolSize: number;
  environment?: NodeJS.ProcessEnv;
  protocolOptions?: CodexAppServerProtocolOptions;
  onLateResponse?: (response: CodexAppServerLateResponse) => void;
  /** Test/diagnostic hook. Process identity is never exposed over MCP. */
  onProcessSpawn?: (processId: number) => void;
  onObservationIncident?: (incident: WorkerObservationIncident) => void;
  onExitIntent?: (reason: ExecutorExitReason) => void;
  /** Test-only override for deterministic ordinary/control saturation coverage. */
  requestLimits?: Partial<CodexExecutionRequestLimits>;
};

/**
 * Codex execution lives outside the operational-state owner. The proxy keeps
 * only bounded callback correlation and presentation-safe transient state;
 * SQLite authority and durable Job state stay in the caller process.
 */
export class ChildProcessCodexExecutionService implements CodexUpstream {
  private child?: ChildProcess;
  private generation?: string;
  private lastHeartbeatAt?: number;
  private capabilitiesValue: BackendCapabilities = UNVERIFIED_APP_SERVER_CAPABILITIES;
  private readonly pending = new Map<string, PendingRequest>();
  private pendingBytes = 0;
  private ordinaryPending = 0;
  private ordinaryPendingBytes = 0;
  private readonly protectedThreads = new Set<string>();
  private readonly workerProcesses = new SupervisedProcessTreeRegistry();
  private readonly resumableThreads = new Map<string, boolean>();
  private readonly activeThreads = new Set<string>();
  private readonly interactionInputs = new Map<string, CodexInteractionInput>();
  private closed = false;
  private starting = false;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;
  private workerCleanupTimer?: NodeJS.Timeout;
  private workerObservationTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private lastWatchdogTickAt?: number;
  private watchdogResumeGraceUntil = 0;
  private closePromise?: Promise<void>;
  private workerCleanupPromise: Promise<boolean> = Promise.resolve(true);
  private workerObservationInFlight = false;
  private parentObservationFenced = false;
  private parentRefreshFailureReported = false;
  private childObservationFenced = false;
  private readonly activeObservationFailures = new Map<string, WorkerObservationIncident>();
  private childExitIntent?: ExecutorExitReason;
  private readonly supervisionKillReasons = new WeakMap<ChildProcess, string>();
  private readonly workerRegistrationsInFlight = new Set<string>();
  private readonly workerCleanupsInFlight = new Set<string>();
  private stderr = "";
  private readonly requestLimits: CodexExecutionRequestLimits;

  private constructor(private readonly options: ChildProcessCodexExecutionServiceOptions) {
    this.requestLimits = resolveExecutionRequestLimits(options.requestLimits);
  }

  static async start(
    options: ChildProcessCodexExecutionServiceOptions
  ): Promise<ChildProcessCodexExecutionService> {
    if (!Number.isInteger(options.poolSize) || options.poolSize < 1 || options.poolSize > 100) {
      throw new Error("EXECUTION_POOL_SIZE_INVALID: Codex execution pool size is invalid.");
    }
    const service = new ChildProcessCodexExecutionService(options);
    try {
      await service.spawnAndWait();
    } catch {
      // The child exit path schedules bounded restart. Keep the proxy alive in
      // a truthful recovering state so a temporary executable/startup failure
      // cannot require restarting the operational state owner.
    }
    service.startWatchdog();
    return service;
  }

  capabilities(): BackendCapabilities {
    return this.capabilitiesValue;
  }

  listTools(): Promise<unknown> {
    return this.request("listTools", []);
  }

  prepareExecution(input: {
    backendKind: "app-server";
    contextMode: "fresh" | "continue" | "fork";
  }): Promise<void> {
    return this.request("prepareExecution", [input]);
  }

  listModels(backendKind?: "app-server"): Promise<unknown> {
    return this.request("listModels", [backendKind]);
  }

  readAccountSnapshot(): Promise<import("./codexAccount.js").CodexAccountSnapshot | null> {
    return this.request("readAccountSnapshot", []);
  }

  readAccountRateLimits(): Promise<CodexWeeklyUsage | null> {
    return this.request("readAccountRateLimits", []);
  }

  startThread(
    input: CodexThreadStartRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.request("startThread", [input], onProgress, onAssigned);
  }

  continueThread(
    input: CodexThreadContinueRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.request("continueThread", [input], onProgress, onAssigned);
  }

  forkThread(
    input: CodexThreadForkRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.request("forkThread", [input], onProgress, onAssigned);
  }

  archiveThread(threadId: string, backendKind?: "app-server"): Promise<void> {
    return this.request("archiveThread", [threadId, backendKind]);
  }

  restoreThread(threadId: string, backendKind?: "app-server"): Promise<void> {
    return this.request("restoreThread", [threadId, backendKind]);
  }

  probeThread(threadId: string, backendKind?: "app-server"): Promise<CodexThreadResumeProbe> {
    return this.request("probeThread", [threadId, backendKind]);
  }

  releaseThreadConnection(
    threadId: string,
    options: ThreadReleaseOptions
  ): Promise<ThreadReleaseResult> {
    return this.request("releaseThreadConnection", [threadId, options]);
  }

  protectThreadFromImplicitResume(threadId: string): void {
    this.protectedThreads.add(threadId);
    this.resumableThreads.set(threadId, false);
    this.sendProtect(threadId);
  }

  listBackgroundTerminals(
    threadId: string,
    backendKind?: "app-server"
  ): Promise<CodexBackgroundTerminal[]> {
    return this.request("listBackgroundTerminals", [threadId, backendKind]);
  }

  listLoadedBackgroundTerminals(
    threadId: string,
    backendKind?: "app-server"
  ): Promise<CodexBackgroundTerminal[] | null> {
    return this.request("listLoadedBackgroundTerminals", [threadId, backendKind]);
  }

  terminateBackgroundTerminal(
    threadId: string,
    processId: string,
    backendKind?: "app-server"
  ): Promise<{ terminated: boolean }> {
    return this.request("terminateBackgroundTerminal", [threadId, processId, backendKind]);
  }

  canResumeThread(threadId: string): boolean | undefined {
    return this.resumableThreads.get(threadId);
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.request("callTool", [name, args], onProgress, onAssigned);
  }

  forceTerminateWorker(
    assignment: UpstreamWorkerAssignment,
    correlation: WorkerTerminationCorrelation,
    graceMs?: number,
    options?: { interruptOnly: true }
  ): Promise<JsonRpcTerminationResult> {
    return this.request("forceTerminateWorker", [assignment, correlation, graceMs, options]);
  }

  respondToInteraction(
    interactionId: string,
    response: CodexInteractionResponse
  ): Promise<void> {
    return this.request("respondToInteraction", [interactionId, response]);
  }

  interactionInput(interactionId: string): CodexInteractionInput | undefined {
    const input = this.interactionInputs.get(interactionId);
    return input ? structuredClone(input) : undefined;
  }

  canSteerThread(threadId: string): boolean {
    return this.activeThreads.has(threadId) && this.capabilitiesValue.supportsSteering === true;
  }

  steerThread(threadId: string, prompt: string): Promise<{ turnId: string }> {
    return this.request("steerThread", [threadId, prompt]);
  }

  health(now = Date.now()): CodexExecutionServiceHealth {
    const connected = Boolean(this.child?.connected && this.generation);
    const heartbeatAgeMs = this.lastHeartbeatAt === undefined
      ? undefined
      : Math.max(0, now - this.lastHeartbeatAt);
    const status = !connected
      ? this.starting ? "starting" : "recovering"
      : this.workerRegistrationsInFlight.size > 0 ||
          this.workerCleanupsInFlight.size > 0 ||
          this.parentObservationFenced || this.childObservationFenced
        ? "recovering"
        : heartbeatAgeMs === undefined || heartbeatAgeMs > HEARTBEAT_STALE_MS
        ? "stale"
        : this.pending.size >= this.requestLimits.maxPendingRequests ||
            this.pendingBytes >= this.requestLimits.maxBytesInFlight ||
            this.ordinaryPending >=
              this.requestLimits.maxPendingRequests - this.requestLimits.controlRequestReserve ||
            this.ordinaryPendingBytes >=
              this.requestLimits.maxBytesInFlight -
                this.requestLimits.controlRequestBytesReserve
          ? "capacity"
          : "ready";
    return {
      status,
      ...(this.generation ? { generation: this.generation } : {}),
      ...(heartbeatAgeMs !== undefined ? { heartbeatAgeMs } : {}),
      inFlight: this.pending.size,
      capacity: this.requestLimits.maxPendingRequests,
      ordinaryInFlight: this.ordinaryPending,
      ordinaryCapacity:
        this.requestLimits.maxPendingRequests - this.requestLimits.controlRequestReserve,
      bytesInFlight: this.pendingBytes,
      byteCapacity: this.requestLimits.maxBytesInFlight,
      ordinaryBytesInFlight: this.ordinaryPendingBytes,
      ordinaryByteCapacity:
        this.requestLimits.maxBytesInFlight -
          this.requestLimits.controlRequestBytesReserve,
      supervisedWorkers: this.workerProcesses.size,
      supervisedProcesses: this.workerProcesses.capturedProcessCount,
      ...(this.child?.pid !== undefined ? { processId: this.child.pid } : {})
    };
  }

  get processId(): number | undefined {
    return this.child?.pid;
  }

  /** Test/supervisor control; never exposed through the Bridge protocol. */
  terminate(signal: NodeJS.Signals = "SIGTERM"): boolean {
    return this.child?.kill(signal) ?? false;
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private request<T>(
    operation: ExecutionOperation,
    args: unknown[],
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<T> {
    const child = this.child;
    const generation = this.generation;
    const health = this.health();
    const control = CONTROL_EXECUTION_OPERATIONS.has(operation);
    const controlDuringObservation = control && health.status === "recovering" &&
      health.heartbeatAgeMs !== undefined &&
      health.heartbeatAgeMs <= HEARTBEAT_STALE_MS &&
      (this.parentObservationFenced || this.childObservationFenced ||
        this.workerRegistrationsInFlight.size > 0 || this.workerCleanupsInFlight.size > 0);
    if (
      this.closed || !child?.connected || !generation ||
      (!["ready", "capacity"].includes(health.status) && !controlDuringObservation)
    ) {
      return Promise.reject(new Error(
        "EXECUTION_UNAVAILABLE: The isolated Codex execution service is not ready."
      ));
    }
    if (
      this.pending.size >= this.requestLimits.maxPendingRequests ||
      (!control && this.ordinaryPending >=
        this.requestLimits.maxPendingRequests - this.requestLimits.controlRequestReserve)
    ) {
      return Promise.reject(new Error(
        "EXECUTION_CAPACITY: The isolated Codex execution service is at capacity."
      ));
    }
    let wireArgs = args;
    let canRelease: ThreadReleaseOptions["canRelease"] | undefined;
    if (operation === "releaseThreadConnection") {
      const release = args[1] as ThreadReleaseOptions | undefined;
      if (!release || typeof release.canRelease !== "function" ||
          !Array.isArray(release.eligibleThreadIds)) {
        return Promise.reject(new Error(
          "EXECUTION_REQUEST_INVALID: Thread release requires an authoritative state check."
        ));
      }
      canRelease = release.canRelease;
      wireArgs = [args[0], {
        eligibleThreadIds: [...release.eligibleThreadIds],
        ...(release.previousWorkerPid !== undefined
          ? { previousWorkerPid: release.previousWorkerPid }
          : {})
      }];
    }
    const requestId = randomUUID();
    const message: RequestMessage = {
      type: "request",
      generation,
      requestId,
      operation,
      args: wireArgs
    };
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (bytes > MAX_REQUEST_BYTES) {
      return Promise.reject(new Error(
        "EXECUTION_REQUEST_TOO_LARGE: The Codex execution request exceeds its IPC limit."
      ));
    }
    if (
      this.pendingBytes + bytes > this.requestLimits.maxBytesInFlight ||
      (!control && this.ordinaryPendingBytes + bytes >
        this.requestLimits.maxBytesInFlight -
          this.requestLimits.controlRequestBytesReserve)
    ) {
      return Promise.reject(new Error(
        "EXECUTION_CAPACITY: The Codex execution byte capacity is exhausted."
      ));
    }
    return new Promise<T>((resolve, reject) => {
      this.pendingBytes += bytes;
      if (!control) {
        this.ordinaryPending += 1;
        this.ordinaryPendingBytes += bytes;
      }
      this.pending.set(requestId, {
        operation,
        control,
        bytes,
        resolve,
        reject,
        onProgress,
        onAssigned,
        activeThreadIds: new Set<string>(),
        ...(operation === "respondToInteraction" && typeof args[0] === "string"
          ? { interactionId: args[0] }
          : {}),
        ...(THREAD_SUBJECT_OPERATIONS.has(operation) && typeof args[0] === "string"
          ? { subjectThreadId: args[0] }
          : {}),
        ...(canRelease ? { canRelease } : {})
      });
      child.send(message, error => {
        if (!error) return;
        const pending = this.takePending(requestId);
        pending?.reject(new Error(`EXECUTION_SEND_FAILED: ${error.message}`));
      });
    });
  }

  private sendProtect(threadId: string): void {
    const child = this.child;
    if (!child?.connected || !this.generation) return;
    const message: ProtectMessage = {
      type: "protect",
      generation: this.generation,
      threadId
    };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_REQUEST_BYTES) {
      child.send(message, () => {});
    }
  }

  private async spawnAndWait(): Promise<void> {
    if (this.closed) throw new Error("EXECUTION_CLOSED: Codex execution service closed.");
    if (this.workerProcesses.size > 0) {
      throw new Error(
        "EXECUTION_ORPHAN_CLEANUP_PENDING: A previous worker generation is still alive."
      );
    }
    this.starting = true;
    const modulePath = fileURLToPath(import.meta.url);
    const configuration: ChildConfiguration = {
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      command: this.options.command,
      poolSize: this.options.poolSize,
      options: serializableOptions(this.options.protocolOptions || {})
    };
    const encoded = Buffer.from(JSON.stringify(configuration), "utf8").toString("base64url");
    const args = modulePath.endsWith(".ts")
      ? ["--import", "tsx", modulePath, CHILD_FLAG, encoded]
      : [modulePath, CHILD_FLAG, encoded];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: executionChildEnvironment(this.options.environment || process.env),
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    this.child = child;
    this.generation = undefined;
    this.lastHeartbeatAt = undefined;
    this.stderr = "";
    this.parentObservationFenced = false;
    this.parentRefreshFailureReported = false;
    this.childObservationFenced = false;
    this.activeObservationFailures.clear();
    this.childExitIntent = undefined;
    this.workerRegistrationsInFlight.clear();
    if (child.pid !== undefined) this.options.onProcessSpawn?.(child.pid);
    child.stderr?.on("data", chunk => {
      const value = String(chunk);
      this.stderr = (this.stderr + value).slice(-8_192);
      if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") process.stderr.write(value);
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.starting = false;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        const error = new Error(
          `EXECUTION_START_TIMEOUT: Codex execution child did not start within ${STARTUP_TIMEOUT_MS} ms.`
        );
        finish(error);
        child.kill("SIGKILL");
      }, STARTUP_TIMEOUT_MS);
      timer.unref();
      child.on("message", value => {
        if (this.child !== child || !isChildMessage(value)) return;
        if (value.type === "fatal") {
          finish(new Error(`EXECUTION_START_FAILED: ${value.message}`));
          return;
        }
        if (value.type === "ready") {
          if (value.protocol !== PROTOCOL || value.version !== PROTOCOL_VERSION) {
            finish(new Error("EXECUTION_INCOMPATIBLE: Codex execution protocol mismatch."));
            child.kill("SIGKILL");
            return;
          }
          this.generation = value.generation;
          this.lastHeartbeatAt = value.heartbeatAt;
          this.capabilitiesValue = value.capabilities;
          finish();
          for (const threadId of this.protectedThreads) this.sendProtect(threadId);
          if (this.stableTimer) clearTimeout(this.stableTimer);
          this.stableTimer = setTimeout(() => {
            if (!this.closed && this.child === child) this.restartAttempts = 0;
          }, RESTART_STABLE_MS);
          this.stableTimer.unref();
          return;
        }
        this.onMessage(value);
      });
      child.once("error", error => {
        finish(error);
        this.onExit(child, error);
      });
      child.once("exit", (code, signal) => {
        const supervisionReason = this.supervisionKillReasons.get(child);
        const unresolvedObservation = this.activeObservationFailures.values().next().value;
        const error = new Error(
          `EXECUTION_PROCESS_EXITED: code=${code}, signal=${signal}.` +
          (supervisionReason ? ` supervisor=${supervisionReason}.` : "") +
          (this.childExitIntent ? ` exit_intent=${this.childExitIntent}.` :
            !this.closed && (code !== 0 || signal !== null) ? " exit_intent=unconfirmed." : "") +
          (unresolvedObservation
            ? ` first_observation=${formatObservationIncident(unresolvedObservation)}.`
            : "") +
          (this.stderr ? ` ${this.stderr}` : "")
        );
        finish(error);
        this.onExit(child, error);
      });
    });
  }

  private onMessage(message: ChildMessage): void {
    if (message.type === "fatal" || message.type === "ready") return;
    if (message.generation !== this.generation) return;
    if (message.type === "heartbeat") {
      this.lastHeartbeatAt = message.heartbeatAt;
      return;
    }
    if (message.type === "late-response") {
      this.options.onLateResponse?.(message.response);
      return;
    }
    if (message.type === "worker-observation-status") {
      const incident = message.incident;
      this.recordObservationIncident(incident);
      this.childObservationFenced = [...this.activeObservationFailures.keys()]
        .some(key => key.startsWith("child."));
      return;
    }
    if (message.type === "executor-exit-intent") {
      this.childExitIntent = message.reason;
      try { this.options.onExitIntent?.(message.reason); } catch { /* Diagnostics are best effort. */ }
      return;
    }
    if (message.type === "worker-started") {
      void this.registerWorkerProcess(message);
      return;
    }
    if (message.type === "worker-observed") {
      for (const tree of message.trees) this.workerProcesses.merge(tree);
      return;
    }
    if (message.type === "worker-cleanup-started") {
      this.workerCleanupsInFlight.add(message.cleanupId);
      return;
    }
    if (message.type === "worker-exited") {
      void this.releaseWorkerProcess(message);
      return;
    }
    if (message.type === "release-check") {
      const pending = this.pending.get(message.requestId);
      const child = this.child;
      const generation = this.generation;
      if (!pending?.canRelease || pending.operation !== "releaseThreadConnection" ||
          !child?.connected || !generation) return;
      void Promise.resolve()
        .then(() => pending.canRelease!(message.threadId))
        .then(Boolean, () => false)
        .then(allowed => {
          if (this.child !== child || this.generation !== generation || !child.connected) return;
          child.send({
            type: "release-check-response",
            generation,
            requestId: message.requestId,
            checkId: message.checkId,
            allowed
          } satisfies ReleaseCheckResponseMessage, () => {});
        });
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === "progress") {
      this.observeWorkerProcesses();
      if (message.interactionId && message.interactionInput) {
        this.interactionInputs.set(message.interactionId, structuredClone(message.interactionInput));
      }
      const resolved = message.progress.event?.details?.resolvedInteractionId;
      if (typeof resolved === "string") this.interactionInputs.delete(resolved);
      try { pending.onProgress?.(message.progress); } catch { /* Caller owns callback errors. */ }
      return;
    }
    if (message.type === "assignment") {
      this.capabilitiesValue = message.capabilities;
      const threadId = message.assignment.threadId;
      if (threadId) {
        pending.activeThreadIds.add(threadId);
        this.activeThreads.add(threadId);
        this.resumableThreads.set(threadId, true);
      }
      try { pending.onAssigned?.(message.assignment); } catch { /* Caller owns callback errors. */ }
      return;
    }
    const completed = this.takePending(message.requestId);
    if (!completed) return;
    for (const threadId of completed.activeThreadIds) this.activeThreads.delete(threadId);
    if (message.ok) {
      if (message.capabilities) this.capabilitiesValue = message.capabilities;
      this.observeResult(
        completed.operation,
        message.result,
        completed.interactionId,
        completed.subjectThreadId
      );
      completed.resolve(message.result);
    } else {
      completed.reject(new Error(
        `${message.error?.code || "EXECUTION_REQUEST_FAILED"}: ` +
        (message.error?.message || "Codex execution request failed.")
      ));
    }
  }

  private observeResult(
    operation: ExecutionOperation,
    result: unknown,
    interactionId?: string,
    subjectThreadId?: string
  ): void {
    if (operation === "respondToInteraction" && interactionId) {
      this.interactionInputs.delete(interactionId);
    }
    if (operation === "archiveThread" && subjectThreadId) {
      this.resumableThreads.set(subjectThreadId, false);
    }
    if (operation === "restoreThread" && subjectThreadId) {
      this.resumableThreads.set(subjectThreadId, true);
    }
    if (operation === "probeThread" && isRecord(result)) {
      const threadId = typeof result.threadId === "string" ? result.threadId : subjectThreadId;
      if (threadId) this.resumableThreads.set(threadId, result.state === "resumable");
    }
    if (operation === "releaseThreadConnection" && isRecord(result) &&
        result.phase === "released") {
      if (subjectThreadId) this.resumableThreads.set(subjectThreadId, false);
      if (Array.isArray(result.releasedThreadIds)) {
        for (const threadId of result.releasedThreadIds) {
          if (typeof threadId === "string") this.resumableThreads.set(threadId, false);
        }
      }
    }
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    this.pendingBytes = Math.max(0, this.pendingBytes - pending.bytes);
    if (!pending.control) {
      this.ordinaryPending = Math.max(0, this.ordinaryPending - 1);
      this.ordinaryPendingBytes = Math.max(0, this.ordinaryPendingBytes - pending.bytes);
    }
    return pending;
  }

  private onExit(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.generation = undefined;
    this.lastHeartbeatAt = undefined;
    this.starting = false;
    this.activeThreads.clear();
    this.interactionInputs.clear();
    this.resumableThreads.clear();
    this.workerCleanupsInFlight.clear();
    this.workerRegistrationsInFlight.clear();
    this.parentObservationFenced = false;
    this.parentRefreshFailureReported = false;
    this.childObservationFenced = false;
    for (const [requestId] of this.pending) {
      const pending = this.takePending(requestId);
      pending?.reject(new Error(
        `${TURN_EXECUTION_OPERATIONS.has(pending.operation)
          ? "CODEX_WORKER_LOST"
          : "EXECUTION_OUTCOME_UNKNOWN"}: ${error.message}`
      ));
    }
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    this.queueWorkerCleanup(!this.closed);
  }

  private async registerWorkerProcess(message: WorkerStartedMessage): Promise<void> {
    const child = this.child;
    const generation = this.generation;
    if (!child?.connected || !generation) return;
    let firstFailure: ProcessObservationFailure | undefined;
    try {
      while (this.child === child && this.generation === generation && child.connected) {
        try {
          await this.workerProcesses.register(message.identity);
          if (firstFailure && this.child === child) {
            this.recordObservationIncident({
              side: "parent", phase: "registration", state: "recovered",
              failure: firstFailure
            });
          }
          break;
        } catch (error) {
          const failure = processObservationFailure(error);
          if (retriableObservationFailure(failure)) {
            if (!firstFailure) {
              firstFailure = failure;
              this.workerRegistrationsInFlight.add(message.registrationId);
              this.recordObservationIncident({
                side: "parent", phase: "registration", state: "degraded", failure
              });
            }
            await new Promise(resolve => setTimeout(resolve, WORKER_OBSERVATION_RETRY_DELAY_MS));
            continue;
          }
          this.recordObservationIncident({
            side: "parent", phase: "registration", state: "failed",
            failure
          });
          // An invalid or vanished root cannot be admitted or safely ignored.
          if (this.child === child) this.killForSupervision(child, "worker-registration-failed");
          return;
        }
      }
    } finally {
      this.workerRegistrationsInFlight.delete(message.registrationId);
    }
    if (this.child !== child || this.generation !== generation || !child.connected) return;
    child.send({
      type: "worker-registration-ack",
      generation,
      registrationId: message.registrationId
    } satisfies WorkerRegistrationAckMessage, () => {});
  }

  private async releaseWorkerProcess(message: WorkerExitedMessage): Promise<void> {
    const child = this.child;
    const generation = this.generation;
    if (!child?.connected || !generation) return;
    let ok = false;
    let firstFailure: ProcessObservationFailure | undefined;
    this.workerCleanupsInFlight.add(message.cleanupId);
    while (this.child === child && this.generation === generation && child.connected) {
      try {
        ok = await this.workerProcesses.release(message.identity, ORPHAN_CLEANUP_GRACE_MS);
        if (ok && firstFailure) this.recordObservationIncident({
          side: "parent", phase: "cleanup", state: "recovered", failure: firstFailure
        });
        if (!ok) this.recordObservationIncident({
          side: "parent", phase: "cleanup", state: "failed",
          failure: processObservationFailure(undefined)
        });
        break;
      } catch (error) {
        const failure = processObservationFailure(error);
        if (retriableObservationFailure(failure)) {
          if (!firstFailure) {
            firstFailure = failure;
            this.recordObservationIncident({
              side: "parent", phase: "cleanup", state: "degraded", failure
            });
          }
          await new Promise(resolve => setTimeout(resolve, WORKER_OBSERVATION_RETRY_DELAY_MS));
          continue;
        }
        this.recordObservationIncident({
          side: "parent", phase: "cleanup", state: "failed", failure
        });
        break;
      }
    }
    if (ok) this.workerCleanupsInFlight.delete(message.cleanupId);
    if (this.child !== child || this.generation !== generation || !child.connected) return;
    child.send({
      type: "worker-cleanup-ack",
      generation,
      cleanupId: message.cleanupId,
      ok
    } satisfies WorkerCleanupAckMessage, () => {});
  }

  private observeWorkerProcesses(): void {
    if (this.workerObservationInFlight) return;
    if (this.workerProcesses.size === 0) {
      const failure = this.activeObservationFailures.get("parent.refresh")?.failure;
      this.parentObservationFenced = false;
      this.parentRefreshFailureReported = false;
      if (failure) this.recordObservationIncident({
        side: "parent", phase: "refresh", state: "recovered", failure
      });
      return;
    }
    const child = this.child;
    this.workerObservationInFlight = true;
    void this.workerProcesses.refresh()
      .then(() => {
        if (this.child !== child || !this.parentObservationFenced) return;
        const failure = this.activeObservationFailures.get("parent.refresh")?.failure;
        this.parentObservationFenced = false;
        this.parentRefreshFailureReported = false;
        if (failure) this.recordObservationIncident({
          side: "parent", phase: "refresh", state: "recovered", failure
        });
      })
      .catch(async error => {
        if (this.workerProcesses.size === 0 || this.child !== child || !child) return;
        const wasFenced = this.parentObservationFenced;
        this.parentObservationFenced = true;
        const failure = processObservationFailure(error);
        if (!wasFenced || !retriableObservationFailure(failure)) {
          this.recordObservationIncident({
          side: "parent", phase: "refresh",
          state: retriableObservationFailure(failure) ? "degraded" : "failed", failure
          });
        }
        if (!retriableObservationFailure(failure)) {
          this.killForSupervision(child, "worker-observation-failed");
          return;
        }
        // A slow /bin/ps probe is not evidence that an active worker is unsafe.
        // Keep admission fenced and let the next independent probe recover it.
        await new Promise(resolve => setTimeout(resolve, WORKER_OBSERVATION_RETRY_DELAY_MS));
        if (this.child !== child) return;
        if (this.workerProcesses.size === 0) {
          this.parentObservationFenced = false;
          this.parentRefreshFailureReported = false;
          this.recordObservationIncident({
            side: "parent", phase: "refresh", state: "recovered", failure
          });
          return;
        }
        try {
          await this.workerProcesses.refresh();
          if (this.child === child) {
            this.parentObservationFenced = false;
            this.parentRefreshFailureReported = false;
            this.recordObservationIncident({
              side: "parent", phase: "refresh", state: "recovered", failure
            });
          }
        } catch (retryError) {
          const retryFailure = processObservationFailure(retryError);
          if (this.child === child &&
              (!this.parentRefreshFailureReported || !retriableObservationFailure(retryFailure))) {
            this.parentRefreshFailureReported = true;
            this.recordObservationIncident({
              side: "parent", phase: "refresh", state: "failed",
              failure: retryFailure
            });
          }
          if (this.child === child && !retriableObservationFailure(retryFailure)) {
            this.killForSupervision(child, "worker-observation-failed");
          }
        }
      })
      .finally(() => { this.workerObservationInFlight = false; });
  }

  private recordObservationIncident(incident: WorkerObservationIncident): void {
    const key = `${incident.side}.${incident.phase}`;
    if (incident.state === "recovered") {
      this.activeObservationFailures.delete(key);
    } else {
      if (!this.activeObservationFailures.has(key)) {
        this.activeObservationFailures.set(key, incident);
      }
    }
    try { this.options.onObservationIncident?.(incident); } catch { /* Diagnostics are best effort. */ }
  }

  private queueWorkerCleanup(restartWhenClean: boolean): void {
    this.workerCleanupPromise = this.workerCleanupPromise
      .catch(() => false)
      .then(() => this.cleanupRegisteredWorkers());
    void this.workerCleanupPromise.then(cleaned => {
      if (this.closed || !restartWhenClean) return;
      if (cleaned) this.scheduleRestart();
      else this.scheduleWorkerCleanupRetry();
    });
  }

  private async cleanupRegisteredWorkers(): Promise<boolean> {
    return this.workerProcesses.cleanupAll(ORPHAN_CLEANUP_GRACE_MS);
  }

  private scheduleWorkerCleanupRetry(): void {
    if (this.closed || this.workerCleanupTimer) return;
    this.workerCleanupTimer = setTimeout(() => {
      this.workerCleanupTimer = undefined;
      this.queueWorkerCleanup(true);
    }, RESTART_BASE_DELAY_MS);
    this.workerCleanupTimer.unref();
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** Math.min(this.restartAttempts, 16),
      RESTART_MAX_DELAY_MS
    );
    this.restartAttempts = Math.min(this.restartAttempts + 1, 16);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.spawnAndWait().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }

  private startWatchdog(): void {
    this.workerObservationTimer = setInterval(
      () => this.observeWorkerProcesses(),
      WORKER_TREE_OBSERVATION_MS
    );
    this.workerObservationTimer.unref();
    this.lastWatchdogTickAt = Date.now();
    this.staleTimer = setInterval(() => {
      const now = Date.now();
      const previousTickAt = this.lastWatchdogTickAt;
      this.lastWatchdogTickAt = now;
      if (previousTickAt !== undefined && now < previousTickAt) {
        this.watchdogResumeGraceUntil = 0;
      } else if (previousTickAt !== undefined &&
          now - previousTickAt > WATCHDOG_PAUSE_THRESHOLD_MS) {
        // A system sleep or owner event-loop pause makes the child's wall-clock
        // heartbeat appear stale before its own timers can run again. Give the
        // existing generation a bounded chance to report after both resume.
        this.watchdogResumeGraceUntil = now + STALE_RESTART_MS;
      }
      if (now < this.watchdogResumeGraceUntil) return;
      const child = this.child;
      const heartbeatAgeMs = this.health(now).heartbeatAgeMs;
      if (!child || heartbeatAgeMs === undefined || heartbeatAgeMs < STALE_RESTART_MS) return;
      this.killForSupervision(child, "heartbeat-stale");
    }, WATCHDOG_INTERVAL_MS);
    this.staleTimer.unref();
  }

  private killForSupervision(child: ChildProcess, reason: string): void {
    if (!this.supervisionKillReasons.has(child)) {
      this.supervisionKillReasons.set(child, reason);
    }
    child.kill("SIGKILL");
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.workerCleanupTimer) clearTimeout(this.workerCleanupTimer);
    if (this.workerObservationTimer) clearInterval(this.workerObservationTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    for (const [requestId] of this.pending) {
      this.takePending(requestId)?.reject(new Error(
        "EXECUTION_CLOSED: Codex execution service closed."
      ));
    }
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: "close" } satisfies CloseMessage);
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
    if (this.child === child) {
      this.child = undefined;
      this.generation = undefined;
    }
    await this.workerCleanupPromise.catch(() => false);
    const cleaned = await this.cleanupRegisteredWorkers();
    if (!cleaned) {
      throw new Error(
        "EXECUTION_ORPHAN_CLEANUP_FAILED: A supervised Codex worker did not exit."
      );
    }
  }
}

async function runChild(configuration: ChildConfiguration): Promise<void> {
  if (process.platform === "darwin") process.title = "Codex MCP Bridge Execution";
  const generation = randomUUID();
  let closing = false;
  const active = new Set<Promise<void>>();
  const releaseChecks = new Map<string, {
    resolve: (allowed: boolean) => void;
    timer: NodeJS.Timeout;
  }>();
  const workerRegistrations = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  const workerCleanups = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  const reportExitIntent = (reason: ExecutorExitReason): Promise<void> =>
    new Promise(resolve => {
      if (!process.connected || !process.send) { resolve(); return; }
      const timer = setTimeout(resolve, 250);
      timer.unref();
      try {
        process.send({ type: "executor-exit-intent", generation, reason }, () => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  const outbound = createExecutionChildSender(reportExitIntent);
  const send = outbound.send;
  const workerObserver = new SupervisedProcessTreeRegistry();
  const lastWorkerObservations = new Map<string, string>();
  let periodicObservationInFlight = false;
  let observationRefreshInFlight: Promise<void> | undefined;
  const observationFences = new Set<"refresh">();
  const registrationFences = new Map<string, ProcessObservationFailure>();
  let refreshFailure: ProcessObservationFailure | undefined;
  let refreshFailureReported = false;
  let observationExitScheduled = false;
  const reportObservation = (
    phase: WorkerObservationIncident["phase"],
    state: WorkerObservationIncident["state"],
    failure: ProcessObservationFailure
  ) => send({
    type: "worker-observation-status", generation,
    incident: { side: "child", phase, state, failure }
  });
  const exitAfterObservationFailure = () => {
    if (closing || observationExitScheduled) return;
    observationExitScheduled = true;
    void Promise.all([
      outbound.drain(250),
      reportExitIntent("worker-observation-failed")
    ]).finally(() => process.exit(1));
  };
  const sendWorkerObservation = () => {
    const trees = workerObserver.snapshots()
      .sort((left, right) => left.root.pid - right.root.pid)
      .map((tree) => ({
        root: tree.root,
        processes: [...tree.processes].sort((left, right) => left.pid - right.pid)
      }));
    const currentKeys = new Set<string>();
    for (const tree of trees) {
      const key = supervisedProcessKey(tree.root);
      currentKeys.add(key);
      const encoded = JSON.stringify(tree);
      if (lastWorkerObservations.get(key) === encoded) continue;
      lastWorkerObservations.set(key, encoded);
      send({ type: "worker-observed", generation, trees: [tree] });
    }
    for (const key of lastWorkerObservations.keys()) {
      if (!currentKeys.has(key)) lastWorkerObservations.delete(key);
    }
  };
  const refreshWorkerObservation = (): Promise<void> => {
    if (observationRefreshInFlight) return observationRefreshInFlight;
    const pending = (async () => {
      try {
        await workerObserver.refresh();
        sendWorkerObservation();
        if (observationFences.delete("refresh") && refreshFailure) {
          reportObservation("refresh", "recovered", refreshFailure);
        }
        refreshFailure = undefined;
        refreshFailureReported = false;
      } catch (error) {
        const firstFailure = processObservationFailure(error);
        if (!observationFences.has("refresh")) {
          observationFences.add("refresh");
          refreshFailure = firstFailure;
          reportObservation("refresh",
            retriableObservationFailure(firstFailure) ? "degraded" : "failed",
            firstFailure);
        }
        if (!retriableObservationFailure(firstFailure)) {
          if (observationFences.has("refresh") && refreshFailure !== firstFailure) {
            reportObservation("refresh", "failed", firstFailure);
          }
          exitAfterObservationFailure();
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, WORKER_OBSERVATION_RETRY_DELAY_MS));
        try {
          await workerObserver.refresh();
          sendWorkerObservation();
          observationFences.delete("refresh");
          reportObservation("refresh", "recovered", refreshFailure || firstFailure);
          refreshFailure = undefined;
          refreshFailureReported = false;
        } catch (retryError) {
          const retryFailure = processObservationFailure(retryError);
          if (!refreshFailureReported || !retriableObservationFailure(retryFailure)) {
            refreshFailureReported = true;
            reportObservation("refresh", "failed", retryFailure);
          }
          if (!retriableObservationFailure(retryFailure)) {
            exitAfterObservationFailure();
            throw retryError;
          }
          // The parent maintains an independent tree ledger. Keep active turns
          // running while both sides keep admission fenced until observation
          // recovers; a probe deadline alone cannot establish worker loss.
        }
      }
    })();
    observationRefreshInFlight = pending;
    void pending.finally(() => { observationRefreshInFlight = undefined; }).catch(() => {});
    return pending;
  };
  const pool = new CodexAppServerUpstreamPool(
    configuration.command,
    configuration.poolSize,
    {
      ...configuration.options,
      environment: process.env,
      onLateResponse: response => send({
        type: "late-response",
        generation,
        response
      }),
      onWorkerProcessStarted: async identity => {
        const key = supervisedProcessKey(identity);
        while (!closing && process.connected) {
          try {
            await workerObserver.register(identity);
            const failure = registrationFences.get(key);
            registrationFences.delete(key);
            if (failure && registrationFences.size === 0) {
              reportObservation("registration", "recovered", failure);
            }
            break;
          } catch (error) {
            const failure = processObservationFailure(error);
            if (retriableObservationFailure(failure)) {
              if (!registrationFences.has(key)) {
                const firstFailure = registrationFences.size === 0;
                registrationFences.set(key, failure);
                if (firstFailure) {
                  reportObservation("registration", "degraded", failure);
                }
              }
              await new Promise(resolve => setTimeout(resolve, WORKER_OBSERVATION_RETRY_DELAY_MS));
              continue;
            }
            registrationFences.set(key, failure);
            reportObservation("registration", "failed", failure);
            let cleaned = false;
            while (!closing && process.connected) {
              try {
                cleaned = await workerObserver.release(identity, ORPHAN_CLEANUP_GRACE_MS);
                break;
              } catch (releaseError) {
                const cleanupFailure = processObservationFailure(releaseError);
                if (!retriableObservationFailure(cleanupFailure)) break;
                await new Promise(resolve => setTimeout(resolve, WORKER_OBSERVATION_RETRY_DELAY_MS));
              }
            }
            if (cleaned) {
              registrationFences.delete(key);
              if (registrationFences.size === 0) {
                reportObservation("registration", "recovered", failure);
              }
            } else {
              exitAfterObservationFailure();
            }
            throw error;
          }
        }
        if (closing || !process.connected) throw new Error("EXECUTION_CLOSED");
        await new Promise<void>((resolve, reject) => {
          const registrationId = randomUUID();
          workerRegistrations.set(registrationId, { resolve, reject });
          send({
            type: "worker-started",
            generation,
            registrationId,
            identity
          });
        });
        sendWorkerObservation();
      },
      onWorkerProcessExited: async identity => {
        const cleanupId = randomUUID();
        if (process.connected) {
          send({
            type: "worker-cleanup-started",
            generation,
            cleanupId,
            identity
          });
        }
        await refreshWorkerObservation();
        if (!process.connected) {
          const cleaned = await workerObserver.release(identity, ORPHAN_CLEANUP_GRACE_MS);
          if (!cleaned) {
            throw new Error(
              "EXECUTION_ORPHAN_CLEANUP_FAILED: The disconnected executor retained a worker tree."
            );
          }
          return;
        }
        const cleanup = new Promise<void>((resolve, reject) => {
          // The parent keeps admission fenced until it can verify cleanup.
          // Elapsed time alone must not turn this into a worker-loss event.
          workerCleanups.set(cleanupId, { resolve, reject });
          send({
            type: "worker-exited",
            generation,
            cleanupId,
            identity
          });
        });
        void cleanup.catch(() => {
          if (!closing) {
            void reportExitIntent("worker-cleanup-unconfirmed")
              .finally(() => process.exit(1));
          }
        });
        await cleanup;
        workerObserver.forget(identity);
        if (workerObserver.size === 0 && observationFences.has("refresh")) {
          await refreshWorkerObservation();
        }
      }
    }
  );
  const workerObservationTimer = setInterval(() => {
    if (periodicObservationInFlight || workerObserver.size === 0) return;
    periodicObservationInFlight = true;
    void refreshWorkerObservation()
      .catch(() => {})
      .finally(() => { periodicObservationInFlight = false; });
  }, WORKER_TREE_OBSERVATION_MS);
  workerObservationTimer.unref();
  const timer = setInterval(() => send({
    type: "heartbeat",
    generation,
    heartbeatAt: Date.now(),
    inFlight: active.size
  }), HEARTBEAT_MS);
  timer.unref();
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    clearInterval(workerObservationTimer);
    for (const { resolve, timer: checkTimer } of releaseChecks.values()) {
      clearTimeout(checkTimer);
      resolve(false);
    }
    releaseChecks.clear();
    for (const { reject } of workerRegistrations.values()) {
      reject(new Error("EXECUTION_CLOSED: Worker registration was interrupted."));
    }
    workerRegistrations.clear();
    if (!process.connected) {
      for (const { reject } of workerCleanups.values()) {
        reject(new Error("EXECUTION_CLOSED: The state-owner connection was lost."));
      }
      workerCleanups.clear();
    }
    await pool.close().catch(() => undefined);
    for (const { reject } of workerCleanups.values()) {
      reject(new Error("EXECUTION_CLOSED: Worker cleanup confirmation was interrupted."));
    }
    workerCleanups.clear();
    await workerObserver.cleanupAll(ORPHAN_CLEANUP_GRACE_MS).catch(() => false);
    await Promise.allSettled([...active]);
    await outbound.drain(1_000);
    if (process.connected) process.disconnect();
  };
  try {
    send({
      type: "ready",
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      generation,
      heartbeatAt: Date.now(),
      capabilities: pool.capabilities()
    });
    process.on("message", value => {
      if (!isParentMessage(value)) return;
      if (value.type === "close") {
        if (!closing) void close();
        return;
      }
      if (value.generation !== generation) return;
      if (value.type === "worker-registration-ack") {
        const pending = workerRegistrations.get(value.registrationId);
        if (!pending) return;
        workerRegistrations.delete(value.registrationId);
        pending.resolve();
        return;
      }
      if (value.type === "worker-cleanup-ack") {
        const pending = workerCleanups.get(value.cleanupId);
        if (!pending) return;
        workerCleanups.delete(value.cleanupId);
        if (value.ok) pending.resolve();
        else pending.reject(new Error(
          "EXECUTION_ORPHAN_CLEANUP_FAILED: The state owner could not clean the worker tree."
        ));
        return;
      }
      if (closing) return;
      if (value.type === "release-check-response") {
        const pending = releaseChecks.get(value.checkId);
        if (!pending) return;
        releaseChecks.delete(value.checkId);
        clearTimeout(pending.timer);
        pending.resolve(value.allowed);
        return;
      }
      if (value.type === "protect") {
        pool.protectThreadFromImplicitResume(value.threadId);
        return;
      }
      if ((observationFences.size > 0 || registrationFences.size > 0) &&
          !CONTROL_EXECUTION_OPERATIONS.has(value.operation)) {
        send({
          type: "response", generation, requestId: value.requestId, ok: false,
          error: {
            code: "EXECUTION_UNAVAILABLE",
            message: "Worker observation is recovering."
          }
        });
        return;
      }
      const operation = executeChildRequest(
        pool,
        generation,
        value,
        send,
        () => refreshWorkerObservation(),
        threadId => new Promise<boolean>(resolve => {
          const checkId = randomUUID();
          const checkTimer = setTimeout(() => {
            releaseChecks.delete(checkId);
            resolve(false);
          }, 10_000);
          checkTimer.unref();
          releaseChecks.set(checkId, { resolve, timer: checkTimer });
          send({
            type: "release-check",
            generation,
            requestId: value.requestId,
            checkId,
            threadId
          });
        })
      )
        .catch(error => send({
          type: "response",
          generation,
          requestId: value.requestId,
          ok: false,
          error: executionError(error)
        }))
        .finally(() => active.delete(operation));
      active.add(operation);
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

type OutboundEntry = {
  message: ChildMessage;
  bytes: number;
};

/**
 * Keep a blocked state-owner event loop from becoming an unbounded Node IPC
 * buffer. Semantic milestones and results retain order in the critical lane;
 * ordinary updated progress is latest-value coalesced per execution request.
 */
function createExecutionChildSender(
  reportExitIntent: (reason: ExecutorExitReason) => Promise<void>
): {
  send(message: ChildMessage): void;
  drain(timeoutMs: number): Promise<void>;
} {
  const critical: OutboundEntry[] = [];
  const progress = new Map<string, OutboundEntry>();
  let criticalBytes = 0;
  let progressBytes = 0;
  let heartbeat: OutboundEntry | undefined;
  let inFlight = false;
  let failedClosed = false;

  const failClosed = (reason: ExecutorExitReason) => {
    if (failedClosed) return;
    failedClosed = true;
    void reportExitIntent(reason).finally(() => process.exit(1));
  };
  const removeProgress = (key: string) => {
    const previous = progress.get(key);
    if (!previous) return;
    progress.delete(key);
    progressBytes = Math.max(0, progressBytes - previous.bytes);
  };
  const pump = () => {
    if (inFlight || failedClosed || !process.connected || !process.send) return;
    let entry: OutboundEntry | undefined;
    if (heartbeat) {
      entry = heartbeat;
      heartbeat = undefined;
    } else if (critical.length > 0) {
      entry = critical.shift();
      if (entry) criticalBytes = Math.max(0, criticalBytes - entry.bytes);
    } else {
      const next = progress.entries().next().value as
        | [string, OutboundEntry]
        | undefined;
      if (next) {
        progress.delete(next[0]);
        progressBytes = Math.max(0, progressBytes - next[1].bytes);
        entry = next[1];
      }
    }
    if (!entry) return;
    inFlight = true;
    try {
      process.send(entry.message, error => {
        inFlight = false;
        if (error && process.connected) {
          failClosed("ipc-send-failed");
          return;
        }
        pump();
      });
    } catch {
      inFlight = false;
      if (process.connected) failClosed("ipc-send-failed");
    }
  };
  const send = (message: ChildMessage) => {
    if (failedClosed || !process.connected || !process.send) return;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    } catch {
      failClosed("ipc-serialization-failed");
      return;
    }
    if (bytes > MAX_OUTBOUND_MESSAGE_BYTES) {
      if (message.type !== "progress" || isCriticalExecutionProgress(message)) {
        failClosed("ipc-message-too-large");
      }
      return;
    }
    const entry = { message, bytes };
    if (message.type === "heartbeat") {
      heartbeat = entry;
    } else if (message.type === "progress" && !isCriticalExecutionProgress(message)) {
      const key = message.requestId;
      removeProgress(key);
      progress.set(key, entry);
      progressBytes += bytes;
      while (
        progress.size > MAX_OUTBOUND_PROGRESS_MESSAGES ||
        progressBytes > MAX_OUTBOUND_PROGRESS_BYTES
      ) {
        const oldest = progress.keys().next().value as string | undefined;
        if (!oldest) break;
        removeProgress(oldest);
      }
    } else {
      if (message.type === "response") removeProgress(message.requestId);
      critical.push(entry);
      criticalBytes += bytes;
      if (
        critical.length > MAX_OUTBOUND_CRITICAL_MESSAGES ||
        criticalBytes > MAX_OUTBOUND_CRITICAL_BYTES
      ) {
        failClosed("ipc-capacity-exceeded");
        return;
      }
    }
    pump();
  };
  return {
    send,
    async drain(timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (
        process.connected &&
        (inFlight || heartbeat || critical.length > 0 || progress.size > 0) &&
        Date.now() < deadline
      ) {
        await new Promise(resolve => setTimeout(resolve, 10));
        pump();
      }
    }
  };
}

function isCriticalExecutionProgress(message: ProgressMessage): boolean {
  if (message.interactionId || message.interactionInput) return true;
  const event = message.progress.event;
  if (!event) return false;
  return isCodexInputEvent(event) ||
    event.phase !== "updated" ||
    event.type === "error" ||
    event.type === "warning" ||
    event.type === "usage" ||
    typeof event.details?.resolvedInteractionId === "string";
}

async function executeChildRequest(
  pool: CodexAppServerUpstreamPool,
  generation: string,
  request: RequestMessage,
  send: (message: ChildMessage) => void,
  observeWorkers: () => Promise<void>,
  canRelease: (threadId: string) => Promise<boolean>
): Promise<void> {
  const progress = (value: CodexProgress) => {
    if (value.event?.type === "command" && value.event.phase === "started") {
      void observeWorkers().catch(() => {});
    }
    const interaction = isRecord(value.event?.details?.interaction)
      ? value.event?.details?.interaction as Record<string, unknown>
      : undefined;
    const interactionId = typeof interaction?.interactionId === "string"
      ? interaction.interactionId
      : undefined;
    const interactionInput = interactionId ? pool.interactionInput(interactionId) : undefined;
    send({
      type: "progress",
      generation,
      requestId: request.requestId,
      progress: value,
      ...(interactionId ? { interactionId } : {}),
      ...(interactionInput ? { interactionInput } : {})
    });
  };
  const assigned = (assignment: UpstreamWorkerAssignment) => send({
    type: "assignment",
    generation,
    requestId: request.requestId,
    assignment,
    capabilities: pool.capabilities()
  });
  let result: unknown;
  switch (request.operation) {
    case "listTools":
      result = await pool.listTools();
      break;
    case "prepareExecution":
      result = await pool.prepareExecution?.(request.args[0] as {
        backendKind: "app-server";
        contextMode: "fresh" | "continue" | "fork";
      });
      break;
    case "listModels":
      result = await pool.listModels?.();
      break;
    case "readAccountSnapshot":
      result = await pool.readAccountSnapshot();
      break;
    case "readAccountRateLimits":
      result = await pool.readAccountRateLimits();
      break;
    case "startThread":
      result = await pool.startThread?.(
        request.args[0] as CodexThreadStartRequest,
        progress,
        assigned
      );
      break;
    case "continueThread":
      result = await pool.continueThread?.(
        request.args[0] as CodexThreadContinueRequest,
        progress,
        assigned
      );
      break;
    case "forkThread":
      result = await pool.forkThread?.(
        request.args[0] as CodexThreadForkRequest,
        progress,
        assigned
      );
      break;
    case "archiveThread":
      result = await pool.archiveThread?.(String(request.args[0]));
      break;
    case "restoreThread":
      result = await pool.restoreThread?.(String(request.args[0]));
      break;
    case "probeThread":
      result = await pool.probeThread?.(String(request.args[0]));
      break;
    case "releaseThreadConnection":
      {
        const options = request.args[1] as Omit<ThreadReleaseOptions, "canRelease">;
      result = await pool.releaseThreadConnection?.(
        String(request.args[0]),
        { ...options, canRelease }
      );
      break;
      }
    case "listBackgroundTerminals":
      result = await pool.listBackgroundTerminals?.(String(request.args[0]));
      break;
    case "listLoadedBackgroundTerminals":
      result = await pool.listLoadedBackgroundTerminals?.(String(request.args[0]));
      break;
    case "terminateBackgroundTerminal":
      result = await pool.terminateBackgroundTerminal?.(
        String(request.args[0]),
        String(request.args[1])
      );
      break;
    case "callTool":
      result = await pool.callTool(
        String(request.args[0]),
        request.args[1] as Record<string, unknown>,
        progress,
        assigned
      );
      break;
    case "forceTerminateWorker":
      result = await pool.forceTerminateWorker?.(
        request.args[0] as UpstreamWorkerAssignment,
        request.args[1] as WorkerTerminationCorrelation,
        request.args[2] as number | undefined,
        request.args[3] as { interruptOnly: true } | undefined
      );
      break;
    case "respondToInteraction":
      result = await pool.respondToInteraction?.(
        String(request.args[0]),
        request.args[1] as CodexInteractionResponse
      );
      break;
    case "steerThread":
      result = await pool.steerThread?.(String(request.args[0]), String(request.args[1]));
      break;
  }
  const encoded = JSON.stringify(result === undefined ? null : result);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(
      "EXECUTION_RESPONSE_TOO_LARGE: Codex execution response exceeds its IPC limit."
    );
  }
  send({
    type: "response",
    generation,
    requestId: request.requestId,
    ok: true,
    result: result === undefined ? null : result,
    capabilities: pool.capabilities()
  });
}

function resolveExecutionRequestLimits(
  overrides: Partial<CodexExecutionRequestLimits> | undefined
): CodexExecutionRequestLimits {
  const limits = {
    maxPendingRequests: overrides?.maxPendingRequests ?? MAX_PENDING_REQUESTS,
    controlRequestReserve: overrides?.controlRequestReserve ?? CONTROL_REQUEST_RESERVE,
    maxBytesInFlight: overrides?.maxBytesInFlight ?? MAX_REQUEST_BYTES_IN_FLIGHT,
    controlRequestBytesReserve:
      overrides?.controlRequestBytesReserve ?? CONTROL_REQUEST_BYTES_RESERVE
  };
  if (
    !Number.isSafeInteger(limits.maxPendingRequests) ||
    !Number.isSafeInteger(limits.controlRequestReserve) ||
    limits.maxPendingRequests < 2 ||
    limits.controlRequestReserve < 1 ||
    limits.controlRequestReserve >= limits.maxPendingRequests
  ) {
    throw new Error(
      "EXECUTION_CAPACITY_INVALID: Control request slots must be a strict subset of capacity."
    );
  }
  if (
    !Number.isSafeInteger(limits.maxBytesInFlight) ||
    !Number.isSafeInteger(limits.controlRequestBytesReserve) ||
    limits.maxBytesInFlight < 2 ||
    limits.controlRequestBytesReserve < 1 ||
    limits.controlRequestBytesReserve >= limits.maxBytesInFlight
  ) {
    throw new Error(
      "EXECUTION_CAPACITY_INVALID: Control request bytes must be a strict subset of capacity."
    );
  }
  return limits;
}

function serializableOptions(
  options: CodexAppServerProtocolOptions
): SerializableProtocolOptions {
  return {
    ...(options.versionCheckTimeoutMs !== undefined
      ? { versionCheckTimeoutMs: options.versionCheckTimeoutMs }
      : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
    ...(options.initializeTimeoutMs !== undefined
      ? { initializeTimeoutMs: options.initializeTimeoutMs }
      : {}),
    ...(options.interruptTimeoutMs !== undefined
      ? { interruptTimeoutMs: options.interruptTimeoutMs }
      : {})
  };
}

function executionError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1] || "EXECUTION_REQUEST_FAILED",
    message
  };
}

function executionChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = codexProcessEnvironment(source);
  // The executor needs the Codex CLI environment, but it has no authority to
  // open Bridge state, diagnostics, configuration, listener or companion
  // resources. Pass the selected executable in the private child envelope and
  // strip every Bridge configuration variable instead of maintaining a path
  // blacklist that could become incomplete when configuration grows.
  for (const name of Object.keys(environment)) {
    if (name.startsWith("CODEX_MCP_BRIDGE_") || name.startsWith("CODEX_GPT_BRIDGE_")) {
      delete environment[name];
    }
  }
  return environment;
}

function isParentMessage(value: unknown): value is ParentMessage {
  if (!isRecord(value)) return false;
  if (value.type === "close") return true;
  if (value.type === "release-check-response") {
    return typeof value.generation === "string" &&
      typeof value.requestId === "string" &&
      typeof value.checkId === "string" &&
      typeof value.allowed === "boolean";
  }
  if (value.type === "worker-registration-ack") {
    return typeof value.generation === "string" &&
      typeof value.registrationId === "string";
  }
  if (value.type === "worker-cleanup-ack") {
    return typeof value.generation === "string" &&
      typeof value.cleanupId === "string" &&
      typeof value.ok === "boolean";
  }
  if (value.type === "protect") {
    return typeof value.generation === "string" &&
      typeof value.threadId === "string" && value.threadId.length <= 512;
  }
  return value.type === "request" &&
    typeof value.generation === "string" &&
    typeof value.requestId === "string" &&
    EXECUTION_OPERATIONS.includes(value.operation as ExecutionOperation) &&
    Array.isArray(value.args) &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_REQUEST_BYTES;
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (!isRecord(value)) return false;
  if (value.type === "fatal") return typeof value.message === "string";
  if (value.type === "ready") {
    return value.protocol === PROTOCOL && Number.isSafeInteger(value.version) &&
      typeof value.generation === "string" && Number.isSafeInteger(value.heartbeatAt) &&
      isRecord(value.capabilities);
  }
  if (value.type === "heartbeat") {
    return typeof value.generation === "string" && Number.isSafeInteger(value.heartbeatAt) &&
      Number.isSafeInteger(value.inFlight);
  }
  if (value.type === "late-response") {
    return typeof value.generation === "string" && isRecord(value.response);
  }
  if (value.type === "release-check") {
    return typeof value.generation === "string" &&
      typeof value.requestId === "string" &&
      typeof value.checkId === "string" &&
      typeof value.threadId === "string" && value.threadId.length <= 512;
  }
  if (value.type === "worker-started") {
    return typeof value.generation === "string" &&
      typeof value.registrationId === "string" &&
      isJsonRpcProcessIdentity(value.identity);
  }
  if (value.type === "worker-observed") {
    return typeof value.generation === "string" &&
      Array.isArray(value.trees) && value.trees.length <= 100 &&
      value.trees.every((tree: unknown) => isSupervisedProcessTreeSnapshot(tree));
  }
  if (value.type === "worker-observation-status") {
    const incident = value.incident;
    const failure = isRecord(incident) ? incident.failure : undefined;
    return typeof value.generation === "string" &&
      isRecord(incident) && incident.side === "child" &&
      ["refresh", "registration", "cleanup"].includes(incident.phase) &&
      ["degraded", "recovered", "failed"].includes(incident.state) &&
      isProcessObservationFailure(failure);
  }
  if (value.type === "executor-exit-intent") {
    return typeof value.generation === "string" &&
      ["worker-observation-failed", "worker-cleanup-unconfirmed",
        "ipc-send-failed", "ipc-serialization-failed",
        "ipc-message-too-large", "ipc-capacity-exceeded"].includes(value.reason);
  }
  if (value.type === "worker-cleanup-started") {
    return typeof value.generation === "string" &&
      typeof value.cleanupId === "string" &&
      isJsonRpcProcessIdentity(value.identity);
  }
  if (value.type === "worker-exited") {
    return typeof value.generation === "string" &&
      typeof value.cleanupId === "string" &&
      isJsonRpcProcessIdentity(value.identity);
  }
  if (!["progress", "assignment", "response"].includes(String(value.type))) return false;
  return typeof value.generation === "string" && typeof value.requestId === "string";
}

function isProcessObservationFailure(value: unknown): value is ProcessObservationFailure {
  return isRecord(value) &&
    ["ps-timeout", "ps-spawn", "ps-exit", "ps-output-limit",
      "ps-output-invalid", "ledger-limit", "registration-lost", "unknown"]
      .includes(value.kind) &&
    Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 &&
    value.durationMs <= 86_400_000 &&
    Number.isSafeInteger(value.timerLatenessMs) && value.timerLatenessMs >= 0 &&
    value.timerLatenessMs <= 86_400_000 &&
    (value.psExitCode === null ||
      (Number.isSafeInteger(value.psExitCode) && value.psExitCode >= 0 &&
        value.psExitCode <= 255)) &&
    (value.osCode === null ||
      (typeof value.osCode === "string" && /^[A-Z0-9_]{1,24}$/u.test(value.osCode)));
}

function formatObservationIncident(incident: WorkerObservationIncident): string {
  const failure = incident.failure;
  return [
    incident.side,
    incident.phase,
    failure.kind,
    `duration_ms=${failure.durationMs}`,
    `timer_late_ms=${failure.timerLatenessMs}`,
    `ps_exit=${failure.psExitCode ?? "none"}`,
    `os_code=${failure.osCode ?? "none"}`
  ].join(",");
}

function retriableObservationFailure(failure: ProcessObservationFailure): boolean {
  return ["ps-timeout", "ps-spawn", "ps-exit", "ps-output-invalid"]
    .includes(failure.kind);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcProcessIdentity(value: unknown): value is JsonRpcProcessIdentity {
  return isRecord(value) && Number.isSafeInteger(value.pid) && value.pid >= 2 &&
    (value.processGroupId === null ||
      (Number.isSafeInteger(value.processGroupId) && value.processGroupId >= 2));
}

function isSupervisedProcessTreeSnapshot(
  value: unknown
): value is SupervisedProcessTreeSnapshot {
  return isRecord(value) && isJsonRpcProcessIdentity(value.root) &&
    Array.isArray(value.processes) && value.processes.length <= 4_096 &&
    value.processes.every((entry: unknown): entry is SupervisedProcessIdentity =>
      isRecord(entry) && Number.isSafeInteger(entry.pid) && entry.pid >= 2 &&
      Number.isSafeInteger(entry.parentPid) && entry.parentPid >= 0 &&
      Number.isSafeInteger(entry.processGroupId) && entry.processGroupId >= 2
    );
}

function readChildConfiguration(encoded: string | undefined): ChildConfiguration {
  if (!encoded) throw new Error("Codex execution child configuration is missing.");
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  if (!isRecord(parsed) || parsed.protocol !== PROTOCOL || parsed.version !== PROTOCOL_VERSION ||
      typeof parsed.command !== "string" || !parsed.command ||
      !Number.isInteger(parsed.poolSize) || parsed.poolSize < 1 || parsed.poolSize > 100 ||
      !isRecord(parsed.options)) {
    throw new Error("Codex execution child configuration is invalid.");
  }
  return parsed as ChildConfiguration;
}

const childConfiguration = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
if (process.argv.includes(CHILD_FLAG)) {
  await runChild(readChildConfiguration(childConfiguration));
}
