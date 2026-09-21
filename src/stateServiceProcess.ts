import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  executeOperationalStateCommand,
  OPERATIONAL_STATE_PROTOCOL,
  OPERATIONAL_STATE_PROTOCOL_VERSION,
  type OperationalStateCommand,
  type OperationalStateExecuteOptions,
  type OperationalStateHealth,
  type OperationalStateRequestEnvelope,
  type OperationalStateResult,
  type OperationalStateService
} from "./stateService.js";
import { BridgeStateStore } from "./stateStore.js";

const CHILD_FLAG = "--operational-state-child";
const DEFAULT_DEADLINE_MS = 5_000;
const DEFAULT_CAPACITY = 64;
const DEFAULT_HEARTBEAT_MS = 250;
const HEARTBEAT_STALE_MS = 2_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

type ChildReadyMessage = {
  type: "ready";
  protocol: typeof OPERATIONAL_STATE_PROTOCOL;
  version: number;
  generation: string;
  heartbeatAt: number;
};

type ChildHeartbeatMessage = {
  type: "heartbeat";
  generation: string;
  heartbeatAt: number;
  inFlight: number;
};

type ChildResponseMessage = {
  type: "response";
  requestId: string;
  generation: string;
  ok: boolean;
  result?: OperationalStateResult;
  error?: { code: string; message: string };
};

type ChildFatalMessage = { type: "fatal"; message: string };
type StateChildMessage = ChildReadyMessage | ChildHeartbeatMessage | ChildResponseMessage | ChildFatalMessage;

type ParentRequestMessage = { type: "request"; envelope: OperationalStateRequestEnvelope };
type ParentCloseMessage = { type: "close" };
type StateParentMessage = ParentRequestMessage | ParentCloseMessage;

type PendingRequest = {
  resolve: (result: OperationalStateResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  commandId: string;
};

export class OperationalStateProcessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly commandId?: string
  ) {
    super(`${code}: ${message}`);
    this.name = "OperationalStateProcessError";
  }
}

export type ChildProcessOperationalStateServiceOptions = {
  file: string;
  capacity?: number;
  startupTimeoutMs?: number;
};

/**
 * Isolated operational-state transport. It is intentionally not selected by
 * createHttpServer until every state caller uses the semantic async contract;
 * doing so earlier would create two SQLite owners.
 */
export class ChildProcessOperationalStateService implements OperationalStateService {
  private generation?: string;
  private lastHeartbeatAt?: number;
  private protocolCompatible = false;
  private starting = true;
  private closed = false;
  private childInFlight = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly unconfirmed = new Set<string>();
  private readonly startup: Promise<void>;
  private startupResolve!: () => void;
  private startupReject!: (error: Error) => void;
  private stderr = "";
  private exitHandled = false;
  private closePromise?: Promise<void>;
  private readonly exited: Promise<OperationalStateProcessError>;
  private exitResolve!: (error: OperationalStateProcessError) => void;

  private constructor(
    private readonly child: ChildProcess,
    private readonly capacity: number,
    startupTimeoutMs: number
  ) {
    this.exited = new Promise(resolve => {
      this.exitResolve = resolve;
    });
    this.startup = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });
    const startupTimer = setTimeout(() => {
      this.failStartup(new OperationalStateProcessError(
        "STATE_START_TIMEOUT",
        `Operational state child did not become ready within ${startupTimeoutMs} ms.`
      ));
    }, startupTimeoutMs);
    startupTimer.unref();
    this.startup.finally(() => clearTimeout(startupTimer)).catch(() => undefined);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => {
      this.stderr = (this.stderr + String(chunk)).slice(-8_192);
    });
    child.on("message", message => this.onMessage(message));
    child.once("error", error => this.onExit(error));
    child.once("exit", (code, signal) => this.onExit(new OperationalStateProcessError(
      "STATE_PROCESS_EXITED",
      `Operational state child exited (code=${code}, signal=${signal}).${this.stderr ? ` ${this.stderr}` : ""}`
    )));
  }

  static async start(
    options: ChildProcessOperationalStateServiceOptions
  ): Promise<ChildProcessOperationalStateService> {
    const capacity = boundedPositiveInteger(options.capacity ?? DEFAULT_CAPACITY, 1, 4_096, "capacity");
    const startupTimeoutMs = boundedPositiveInteger(options.startupTimeoutMs ?? 10_000, 100, 60_000, "startupTimeoutMs");
    const modulePath = fileURLToPath(import.meta.url);
    const args = modulePath.endsWith(".ts")
      ? ["--import", "tsx", modulePath, CHILD_FLAG, options.file]
      : [modulePath, CHILD_FLAG, options.file];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: childEnvironment(),
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    const service = new ChildProcessOperationalStateService(child, capacity, startupTimeoutMs);
    try {
      await service.startup;
      return service;
    } catch (error) {
      await service.close().catch(() => undefined);
      throw error;
    }
  }

  execute(
    command: OperationalStateCommand,
    options: OperationalStateExecuteOptions = {}
  ): Promise<OperationalStateResult> {
    if (this.closed || !this.child.connected || !this.generation) {
      return Promise.reject(new OperationalStateProcessError(
        "STATE_UNAVAILABLE",
        "Operational state child is not connected."
      ));
    }
    if (!this.protocolCompatible) {
      return Promise.reject(new OperationalStateProcessError(
        "STATE_INCOMPATIBLE",
        "Operational state protocol is not compatible."
      ));
    }
    if (this.outstanding >= this.capacity) {
      return Promise.reject(new OperationalStateProcessError(
        "STATE_CAPACITY",
        "Operational state request capacity is exhausted."
      ));
    }
    const deadlineMs = boundedPositiveInteger(
      options.deadlineMs ?? DEFAULT_DEADLINE_MS,
      1,
      60_000,
      "deadlineMs"
    );
    const requestId = randomUUID();
    const commandId = options.commandId ?? randomUUID();
    if (!isUuid(commandId)) {
      return Promise.reject(new OperationalStateProcessError(
        "STATE_COMMAND_ID_INVALID",
        "Operational state commandId must be a UUID.",
        commandId
      ));
    }
    if (
      options.aggregateKey !== undefined &&
      (!options.aggregateKey || Buffer.byteLength(options.aggregateKey, "utf8") > 512)
    ) {
      return Promise.reject(new OperationalStateProcessError(
        "STATE_AGGREGATE_KEY_INVALID",
        "Operational state aggregateKey must contain at most 512 bytes.",
        commandId
      ));
    }
    const payloadSha256 = digest(command);
    const envelope: OperationalStateRequestEnvelope = {
      protocol: OPERATIONAL_STATE_PROTOCOL,
      version: OPERATIONAL_STATE_PROTOCOL_VERSION,
      requestId,
      commandId,
      kind: "command",
      operation: command.operation,
      ...(options.aggregateKey !== undefined ? { aggregateKey: options.aggregateKey } : {}),
      workerGeneration: this.generation,
      deadlineAt: Date.now() + deadlineMs,
      payloadSha256,
      payload: command
    };
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_REQUEST_BYTES) {
      return Promise.reject(new OperationalStateProcessError(
        "STATE_REQUEST_TOO_LARGE",
        `Operational state request exceeds ${MAX_REQUEST_BYTES} bytes.`
      ));
    }
    return new Promise<OperationalStateResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.unconfirmed.add(requestId);
        reject(new OperationalStateProcessError(
          "STATE_OUTCOME_UNKNOWN",
          "Operational state response missed its deadline; the command may still complete.",
          commandId
        ));
      }, deadlineMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer, commandId });
      this.child.send({ type: "request", envelope } satisfies ParentRequestMessage, error => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) {
          this.unconfirmed.delete(requestId);
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new OperationalStateProcessError("STATE_SEND_FAILED", error.message, commandId));
      });
    });
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  waitForExit(): Promise<OperationalStateProcessError> {
    return this.exited;
  }

  terminate(signal: NodeJS.Signals = "SIGTERM"): boolean {
    return this.child.kill(signal);
  }

  health(now = Date.now()): OperationalStateHealth {
    if (this.closed || !this.child.connected) {
      return {
        ready: false,
        reason: "state-recovering",
        protocolVersion: OPERATIONAL_STATE_PROTOCOL_VERSION,
        generation: this.generation,
        inFlight: this.outstanding,
        capacity: this.capacity
      };
    }
    if (this.starting || !this.lastHeartbeatAt) {
      return {
        ready: false,
        reason: "state-starting",
        protocolVersion: OPERATIONAL_STATE_PROTOCOL_VERSION,
        generation: this.generation,
        inFlight: this.outstanding,
        capacity: this.capacity
      };
    }
    if (!this.protocolCompatible) {
      return {
        ready: false,
        reason: "state-incompatible",
        protocolVersion: OPERATIONAL_STATE_PROTOCOL_VERSION,
        generation: this.generation,
        heartbeatAgeMs: Math.max(0, now - this.lastHeartbeatAt),
        inFlight: this.outstanding,
        capacity: this.capacity
      };
    }
    const heartbeatAgeMs = Math.max(0, now - this.lastHeartbeatAt);
    if (heartbeatAgeMs > HEARTBEAT_STALE_MS) {
      return {
        ready: false,
        reason: "state-stale",
        protocolVersion: OPERATIONAL_STATE_PROTOCOL_VERSION,
        generation: this.generation,
        heartbeatAgeMs,
        inFlight: this.outstanding,
        capacity: this.capacity
      };
    }
    if (this.outstanding >= this.capacity) {
      return {
        ready: false,
        reason: "state-capacity",
        protocolVersion: OPERATIONAL_STATE_PROTOCOL_VERSION,
        generation: this.generation,
        heartbeatAgeMs,
        inFlight: this.outstanding,
        capacity: this.capacity
      };
    }
    return {
      ready: true,
      reason: "ready",
      protocolVersion: OPERATIONAL_STATE_PROTOCOL_VERSION,
      generation: this.generation,
      heartbeatAgeMs,
      inFlight: Math.max(this.outstanding, this.childInFlight),
      capacity: this.capacity
    };
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeChild();
    return this.closePromise;
  }

  private async closeChild(): Promise<void> {
    this.closed = true;
    if (
      this.exitHandled ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    ) return;
    if (this.child.connected) this.child.send({ type: "close" } satisfies ParentCloseMessage);
    const forceTimer = setTimeout(() => this.child.kill("SIGTERM"), 2_000);
    forceTimer.unref();
    try {
      await this.exited;
    } finally {
      clearTimeout(forceTimer);
    }
  }

  private onMessage(message: unknown): void {
    if (!isChildMessage(message)) return;
    if (message.type === "ready") {
      this.generation = message.generation;
      this.lastHeartbeatAt = message.heartbeatAt;
      this.protocolCompatible = message.protocol === OPERATIONAL_STATE_PROTOCOL &&
        message.version === OPERATIONAL_STATE_PROTOCOL_VERSION;
      if (this.protocolCompatible) {
        this.starting = false;
        this.startupResolve();
      } else {
        this.failStartup(new OperationalStateProcessError(
          "STATE_INCOMPATIBLE",
          `Operational state child uses protocol version ${message.version}.`
        ));
      }
      return;
    }
    if (message.type === "heartbeat") {
      if (message.generation !== this.generation) return;
      this.lastHeartbeatAt = message.heartbeatAt;
      this.childInFlight = message.inFlight;
      return;
    }
    if (message.type === "fatal") {
      this.failStartup(new OperationalStateProcessError("STATE_START_FAILED", message.message));
      return;
    }
    if (message.generation !== this.generation) return;
    if (this.unconfirmed.delete(message.requestId)) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.ok && message.result) pending.resolve(message.result);
    else pending.reject(new OperationalStateProcessError(
      message.error?.code || "STATE_COMMAND_FAILED",
      message.error?.message || "Operational state command failed.",
      pending.commandId
    ));
  }

  private failStartup(error: Error): void {
    if (!this.starting) return;
    this.starting = false;
    this.startupReject(error);
  }

  private onExit(error: Error): void {
    if (this.exitHandled) return;
    this.exitHandled = true;
    const processError = error instanceof OperationalStateProcessError
      ? error
      : new OperationalStateProcessError("STATE_PROCESS_EXITED", error.message);
    this.failStartup(error);
    this.starting = false;
    this.lastHeartbeatAt = undefined;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new OperationalStateProcessError(
        "STATE_OUTCOME_UNKNOWN",
        `${error.message} Request ${requestId} may have committed.`,
        pending.commandId
      ));
    }
    this.pending.clear();
    this.unconfirmed.clear();
    this.exitResolve(processError);
  }

  private get outstanding(): number {
    return this.pending.size + this.unconfirmed.size;
  }
}

export type SupervisedOperationalStateServiceOptions =
  ChildProcessOperationalStateServiceOptions & {
    restartBaseDelayMs?: number;
    restartMaxDelayMs?: number;
    restartMaxAttempts?: number;
    restartStableMs?: number;
  };

type OperationalStateRestartPolicy = {
  capacity: number;
  restartBaseDelayMs: number;
  restartMaxDelayMs: number;
  restartMaxAttempts: number;
  restartStableMs: number;
};

/**
 * Restarts an unexpectedly exited state owner with bounded exponential backoff.
 * It never replays an uncertain command by itself: the caller must retry the
 * same command ID so the durable receipt can decide whether to apply or replay.
 */
export class SupervisedOperationalStateService implements OperationalStateService {
  private service?: ChildProcessOperationalStateService;
  private restartTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private restartAttempts = 0;
  private closed = false;
  private lastError?: OperationalStateProcessError;
  private readonly capacity: number;
  private readonly restartBaseDelayMs: number;
  private readonly restartMaxDelayMs: number;
  private readonly restartMaxAttempts: number;
  private readonly restartStableMs: number;

  private constructor(
    private readonly options: SupervisedOperationalStateServiceOptions,
    service: ChildProcessOperationalStateService,
    policy: OperationalStateRestartPolicy
  ) {
    this.capacity = policy.capacity;
    this.restartBaseDelayMs = policy.restartBaseDelayMs;
    this.restartMaxDelayMs = policy.restartMaxDelayMs;
    this.restartMaxAttempts = policy.restartMaxAttempts;
    this.restartStableMs = policy.restartStableMs;
    this.adopt(service);
  }

  static async start(
    options: SupervisedOperationalStateServiceOptions
  ): Promise<SupervisedOperationalStateService> {
    const policy = operationalStateRestartPolicy(options);
    const service = await ChildProcessOperationalStateService.start(options);
    return new SupervisedOperationalStateService(options, service, policy);
  }

  execute(
    command: OperationalStateCommand,
    options: OperationalStateExecuteOptions = {}
  ): Promise<OperationalStateResult> {
    if (!this.service || this.closed) {
      return Promise.reject(new OperationalStateProcessError(
        "STATE_RECOVERING",
        this.lastError?.message || "Operational state owner is recovering.",
        options.commandId
      ));
    }
    return this.service.execute(command, options);
  }

  health(now = Date.now()): OperationalStateHealth {
    if (this.service && !this.closed) return this.service.health(now);
    return {
      ready: false,
      reason: "state-recovering",
      protocolVersion: OPERATIONAL_STATE_PROTOCOL_VERSION,
      inFlight: 0,
      capacity: this.capacity
    };
  }

  get processId(): number | undefined {
    return this.service?.processId;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.restartTimer = undefined;
    this.stableTimer = undefined;
    const service = this.service;
    this.service = undefined;
    if (service) await service.close();
  }

  private adopt(service: ChildProcessOperationalStateService): void {
    this.service = service;
    this.lastError = undefined;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      if (!this.closed && this.service === service) this.restartAttempts = 0;
    }, this.restartStableMs);
    this.stableTimer.unref();
    void service.waitForExit().then(error => {
      if (this.closed || this.service !== service) return;
      this.service = undefined;
      this.lastError = error;
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer || this.restartAttempts >= this.restartMaxAttempts) return;
    const delayMs = Math.min(
      this.restartBaseDelayMs * 2 ** this.restartAttempts,
      this.restartMaxDelayMs
    );
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.restart();
    }, delayMs);
    this.restartTimer.unref();
  }

  private async restart(): Promise<void> {
    if (this.closed) return;
    try {
      const service = await ChildProcessOperationalStateService.start(this.options);
      if (this.closed) {
        await service.close();
        return;
      }
      this.adopt(service);
    } catch (error) {
      this.lastError = error instanceof OperationalStateProcessError
        ? error
        : new OperationalStateProcessError(
          "STATE_RESTART_FAILED",
          error instanceof Error ? error.message : String(error)
        );
      this.scheduleRestart();
    }
  }
}

async function runChild(file: string): Promise<void> {
  let store: BridgeStateStore | undefined;
  let closing = false;
  const generation = randomUUID();
  const active = new Set<Promise<unknown>>();
  try {
    store = new BridgeStateStore({ file });
    const heartbeat = () => sendToParent({
      type: "heartbeat",
      generation,
      heartbeatAt: Date.now(),
      inFlight: active.size
    });
    const timer = setInterval(heartbeat, DEFAULT_HEARTBEAT_MS);
    timer.unref();
    sendToParent({
      type: "ready",
      protocol: OPERATIONAL_STATE_PROTOCOL,
      version: OPERATIONAL_STATE_PROTOCOL_VERSION,
      generation,
      heartbeatAt: Date.now()
    });
    process.on("message", message => {
      if (!isParentMessage(message) || closing) return;
      if (message.type === "close") {
        closing = true;
        clearInterval(timer);
        void Promise.allSettled([...active]).then(() => {
          store?.close();
          store = undefined;
          process.disconnect();
        });
        return;
      }
      const operation = executeChildRequest(store as BridgeStateStore, generation, message.envelope);
      active.add(operation);
      void operation.finally(() => active.delete(operation));
    });
    process.once("disconnect", () => {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      void Promise.allSettled([...active]).then(() => {
        store?.close();
        store = undefined;
      });
    });
  } catch (error) {
    const fatal: ChildFatalMessage = {
      type: "fatal",
      message: error instanceof Error ? error.message : String(error)
    };
    store?.close();
    if (process.send) {
      process.send(fatal, () => {
        process.disconnect();
        process.exitCode = 1;
      });
    } else {
      process.exitCode = 1;
    }
  }
}

async function executeChildRequest(
  store: BridgeStateStore,
  generation: string,
  envelope: OperationalStateRequestEnvelope
): Promise<void> {
  const fail = (code: string, message: string) => sendToParent({
    type: "response",
    requestId: typeof envelope?.requestId === "string" ? envelope.requestId : "invalid",
    generation,
    ok: false,
    error: { code, message }
  });
  if (!validEnvelope(envelope, generation)) {
    fail("STATE_REQUEST_INVALID", "Operational state request envelope is invalid.");
    return;
  }
  if (Date.now() > envelope.deadlineAt) {
    fail("STATE_DEADLINE", "Operational state request expired before execution.");
    return;
  }
  try {
    const execution = store.executeOperationalCommand({
      commandId: envelope.commandId,
      operation: envelope.operation,
      payloadSha256: envelope.payloadSha256,
      ...(envelope.aggregateKey !== undefined ? { aggregateKey: envelope.aggregateKey } : {}),
      workerGeneration: generation
    }, () => ({ result: executeOperationalStateCommand(store, envelope.payload) }));
    const result: OperationalStateResult = {
      ...execution.receipt.result,
      certainty: "committed",
      commandId: envelope.commandId,
      replayed: execution.replayed
    };
    sendToParent({ type: "response", requestId: envelope.requestId, generation, ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = stateErrorCode(message);
    fail(code, message.replace(new RegExp(`^${code}:\\s*`), ""));
  }
}

function validEnvelope(envelope: OperationalStateRequestEnvelope, generation: string): boolean {
  if (!envelope || typeof envelope !== "object") return false;
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_REQUEST_BYTES) return false;
  return envelope.protocol === OPERATIONAL_STATE_PROTOCOL &&
    envelope.version === OPERATIONAL_STATE_PROTOCOL_VERSION &&
    envelope.kind === "command" &&
    envelope.operation === "maintain" &&
    envelope.workerGeneration === generation &&
    typeof envelope.requestId === "string" &&
    isUuid(envelope.commandId) &&
    (envelope.aggregateKey === undefined ||
      typeof envelope.aggregateKey === "string" &&
      envelope.aggregateKey.length > 0 &&
      Buffer.byteLength(envelope.aggregateKey, "utf8") <= 512) &&
    Number.isSafeInteger(envelope.deadlineAt) &&
    envelope.payload?.operation === envelope.operation &&
    digest(envelope.payload) === envelope.payloadSha256;
}

function isChildMessage(value: unknown): value is StateChildMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "fatal") return typeof message.message === "string";
  if (message.type === "ready") {
    return message.protocol === OPERATIONAL_STATE_PROTOCOL &&
      typeof message.version === "number" &&
      isUuid(message.generation) &&
      Number.isSafeInteger(message.heartbeatAt);
  }
  if (message.type === "heartbeat") {
    return isUuid(message.generation) && Number.isSafeInteger(message.heartbeatAt) &&
      Number.isSafeInteger(message.inFlight) && Number(message.inFlight) >= 0;
  }
  if (message.type === "response") {
    return isUuid(message.requestId) && isUuid(message.generation) &&
      typeof message.ok === "boolean";
  }
  return false;
}

function isParentMessage(value: unknown): value is StateParentMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "request" || type === "close";
}

function sendToParent(message: StateChildMessage): void {
  if (process.send) process.send(message);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedPositiveInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function operationalStateRestartPolicy(
  options: SupervisedOperationalStateServiceOptions
): OperationalStateRestartPolicy {
  const capacity = boundedPositiveInteger(options.capacity ?? DEFAULT_CAPACITY, 1, 4_096, "capacity");
  const restartBaseDelayMs = boundedPositiveInteger(
    options.restartBaseDelayMs ?? 100,
    10,
    60_000,
    "restartBaseDelayMs"
  );
  return {
    capacity,
    restartBaseDelayMs,
    restartMaxDelayMs: boundedPositiveInteger(
      options.restartMaxDelayMs ?? 5_000,
      restartBaseDelayMs,
      300_000,
      "restartMaxDelayMs"
    ),
    restartMaxAttempts: boundedPositiveInteger(
      options.restartMaxAttempts ?? 5,
      1,
      100,
      "restartMaxAttempts"
    ),
    restartStableMs: boundedPositiveInteger(
      options.restartStableMs ?? 60_000,
      100,
      3_600_000,
      "restartStableMs"
    )
  };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function stateErrorCode(message: string): string {
  const match = /^([A-Z][A-Z0-9_]+):/.exec(message);
  return match?.[1] ?? "STATE_COMMAND_FAILED";
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

const childFile = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
if (process.argv.includes(CHILD_FLAG)) {
  if (!childFile) throw new Error("Operational state child database path is required.");
  await runChild(childFile);
}
