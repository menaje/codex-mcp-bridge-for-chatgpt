import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

type JsonRpcId = number;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId | string;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (value: unknown) => void;
  timer?: NodeJS.Timeout;
};

export type JsonRpcProcessIdentity = {
  pid: number;
  processGroupId: number | null;
};

export type JsonRpcTerminationResult = JsonRpcProcessIdentity & {
  exited: boolean;
  escalated: boolean;
  signal: "SIGTERM" | "SIGKILL" | null;
  mode: "process-group" | "turn-interrupt";
  workerExited: boolean;
};

export type JsonRpcRequestOptions = {
  /** Omit for a deliberately timer-free request. */
  timeoutMs?: number;
  progress?: boolean;
  onProgress?: (value: unknown) => void;
};

export type JsonRpcServerRequestHandler = (
  method: string,
  params: unknown,
  requestId: number | string
) => Promise<unknown> | unknown;

export type JsonRpcNotificationHandler = (method: string, params: unknown) => void;

export type JsonRpcProcessOptions = {
  command: string;
  args: string[];
  debugLabel: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onNotification?: JsonRpcNotificationHandler;
  onRequest?: JsonRpcServerRequestHandler;
  onExit?: (error: Error) => void;
  /** Codex App Server uses JSON-RPC semantics but omits the jsonrpc header on the wire. */
  omitJsonRpcHeader?: boolean;
};

/**
 * Minimal newline-delimited JSON-RPC process transport.
 *
 * The MCP SDK deliberately installs a default request timer when no timeout is
 * supplied, and treats timeout=0 as an immediate timeout. Long-running Codex
 * turns need a different contract: no request deadline, while process lifetime
 * remains explicitly supervised. This transport creates a dedicated Unix
 * process group so force-stop can target the exact backend generation and all
 * descendants rather than only rejecting a local Promise.
 */
export class JsonRpcProcess {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: ReadLineInterface;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly inboundQueue: unknown[] = [];
  private inboundDrainScheduled = false;
  private pendingExitError?: Error;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;
  private closing = false;
  private exitNotified = false;

  constructor(private readonly options: JsonRpcProcessOptions) {}

  get identity(): JsonRpcProcessIdentity | undefined {
    const pid = this.child?.pid;
    if (!pid) return undefined;
    return {
      pid,
      processGroupId: process.platform === "win32" ? null : pid
    };
  }

  get exited(): boolean {
    return Boolean(
      this.exitNotified ||
      (this.child && (this.child.exitCode !== null || this.child.signalCode !== null))
    );
  }

  async start(): Promise<JsonRpcProcessIdentity> {
    if (this.child) {
      const identity = this.identity;
      if (!identity || this.exited) throw new Error(`${this.options.debugLabel} process is not running.`);
      return identity;
    }
    if (this.closing) throw new Error(`${this.options.debugLabel} process is closed.`);

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env || inheritedChildEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
        process.stderr.write(`[${this.options.debugLabel}] ${chunk.toString()}`);
      }
    });

    const started = new Promise<JsonRpcProcessIdentity>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        const identity = this.identity;
        if (identity) resolve(identity);
        else reject(new Error(`${this.options.debugLabel} did not expose a process id.`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    child.once("exit", (code, signal) => {
      this.lines?.close();
      this.lines = undefined;
      const suffix = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      this.notifyProcessExit(new Error(`${this.options.debugLabel} exited (${suffix}).`));
    });
    child.once("error", (error) => {
      this.notifyProcessExit(error);
    });

    return started;
  }

  async request<T = unknown>(method: string, params?: unknown, options: JsonRpcRequestOptions = {}): Promise<T> {
    await this.start();
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("JSON-RPC timeout must be a positive integer when supplied.");
    }
    const id = this.nextRequestId++;
    const requestParams = options.progress ? addProgressToken(params, id) : params;
    const promise = new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        onProgress: options.onProgress
      };
      if (options.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(Object.assign(new Error(`${method} timed out after ${options.timeoutMs}ms.`), { code: -32001 }));
        }, options.timeoutMs);
      }
      this.pending.set(id, pending);
    });
    try {
      this.write({ jsonrpc: "2.0", id, method, ...(requestParams === undefined ? {} : { params: requestParams }) });
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (pending?.timer) clearTimeout(pending.timer);
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.start();
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async close(graceMs = 1_500): Promise<void> {
    if (this.closing) {
      await this.exitPromise;
      return;
    }
    this.closing = true;
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      // A closed stdin is already on the way out.
    }
    if (await this.waitForExit(graceMs)) return;
    await this.forceTerminate(graceMs);
  }

  async forceTerminate(graceMs = 1_500): Promise<JsonRpcTerminationResult> {
    const identity = this.identity;
    if (!identity || this.exited) {
      return {
        pid: identity?.pid || 0,
        processGroupId: identity?.processGroupId ?? null,
        exited: true,
        escalated: false,
        signal: null,
        mode: "process-group",
        workerExited: true
      };
    }

    this.closing = true;
    signalExactProcess(identity, "SIGTERM");
    if (await this.waitForGroupExit(identity, graceMs)) {
      return { ...identity, exited: true, escalated: false, signal: "SIGTERM", mode: "process-group", workerExited: true };
    }
    signalExactProcess(identity, "SIGKILL");
    const exited = await this.waitForGroupExit(identity, graceMs);
    return { ...identity, exited, escalated: true, signal: "SIGKILL", mode: "process-group", workerExited: exited };
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.child || this.exited) return true;
    return Promise.race([
      (this.exitPromise || Promise.resolve()).then(() => true),
      delay(timeoutMs).then(() => false)
    ]);
  }

  private async waitForGroupExit(identity: JsonRpcProcessIdentity, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (!processIdentityAlive(identity)) return true;
      await delay(25);
    } while (Date.now() < deadline);
    return !processIdentityAlive(identity);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
        process.stderr.write(`[${this.options.debugLabel}] ignored non-JSON stdout line\n`);
      }
      return;
    }
    if (Array.isArray(message)) this.inboundQueue.push(...message);
    else this.inboundQueue.push(message);
    this.scheduleInboundDrain();
  }

  /**
   * Process one wire message per microtask. Resolving an RPC response schedules
   * the awaiting caller before the next notification is consumed, so a server
   * may safely emit `turn/start`'s response and the first turn notifications in
   * one stdout chunk. Without this boundary, readline can synchronously deliver
   * every line before the caller has registered the returned turn id.
   */
  private scheduleInboundDrain(): void {
    if (this.inboundDrainScheduled) return;
    this.inboundDrainScheduled = true;
    queueMicrotask(() => this.drainInboundMessage());
  }

  private drainInboundMessage(): void {
    const message = this.inboundQueue.shift();
    if (message !== undefined) this.handleMessage(message);
    if (this.inboundQueue.length > 0) {
      queueMicrotask(() => this.drainInboundMessage());
      return;
    }
    this.inboundDrainScheduled = false;
    if (this.pendingExitError) {
      const error = this.pendingExitError;
      this.pendingExitError = undefined;
      this.finalizeProcessExit(error);
    }
  }

  private handleMessage(message: unknown): void {
    if (
      !isRecord(message) ||
      (message.jsonrpc !== "2.0" && !(this.options.omitJsonRpcHeader && message.jsonrpc === undefined))
    ) return;
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      void this.handleServerRequest(message as JsonRpcRequest);
      return;
    }
    if (typeof message.method === "string") {
      const notification = message as JsonRpcNotification;
      if (notification.method === "notifications/progress" && isRecord(notification.params)) {
        const token = notification.params.progressToken;
        if (typeof token === "number") this.pending.get(token)?.onProgress?.(notification.params);
      }
      this.options.onNotification?.(notification.method, notification.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      const rpcError = message.error as JsonRpcError;
      pending.reject(Object.assign(new Error(rpcError.message || "JSON-RPC request failed."), {
        code: rpcError.code,
        data: rpcError.data
      }));
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    try {
      if (!this.options.onRequest) {
        throw Object.assign(new Error(`Unsupported server request: ${request.method}`), { code: -32601 });
      }
      const result = await this.options.onRequest(request.method, request.params, request.id);
      this.write({ jsonrpc: "2.0", id: request.id, result: result ?? {} });
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "number" ? error.code : -32603;
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private write(message: unknown): void {
    if (!this.child || this.exited || !this.child.stdin.writable) {
      throw new Error(`${this.options.debugLabel} process stdin is unavailable.`);
    }
    const framed = this.options.omitJsonRpcHeader && isRecord(message)
      ? Object.fromEntries(Object.entries(message).filter(([key]) => key !== "jsonrpc"))
      : message;
    this.child.stdin.write(`${JSON.stringify(framed)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private notifyProcessExit(error: Error): void {
    if (this.exitNotified || this.pendingExitError) return;
    if (this.inboundDrainScheduled || this.inboundQueue.length > 0) {
      this.pendingExitError = error;
      return;
    }
    this.finalizeProcessExit(error);
  }

  private finalizeProcessExit(error: Error): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.rejectPending(error);
    this.resolveExit?.();
    this.resolveExit = undefined;
    this.options.onExit?.(error);
  }
}

function addProgressToken(params: unknown, requestId: number): Record<string, unknown> {
  const base = isRecord(params) ? { ...params } : {};
  const meta = isRecord(base._meta) ? { ...base._meta } : {};
  meta.progressToken = requestId;
  base._meta = meta;
  return base;
}

function inheritedChildEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "CODEX_HOME", "TMPDIR",
    "LANG", "LC_ALL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"
  ];
  return Object.fromEntries(
    keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])
  );
}

function signalExactProcess(identity: JsonRpcProcessIdentity, signal: NodeJS.Signals): void {
  try {
    if (identity.processGroupId !== null) process.kill(-identity.processGroupId, signal);
    else process.kill(identity.pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error) && !isPermissionDenied(error)) throw error;
  }
}

function processIdentityAlive(identity: JsonRpcProcessIdentity): boolean {
  try {
    if (identity.processGroupId !== null) process.kill(-identity.processGroupId, 0);
    else process.kill(identity.pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    if (isPermissionDenied(error)) return true;
    throw error;
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return isRecord(error) && error.code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
  return isRecord(error) && error.code === "EPERM";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
