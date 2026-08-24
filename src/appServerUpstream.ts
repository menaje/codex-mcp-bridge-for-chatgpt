import { randomUUID } from "node:crypto";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_CODEX_VERSION_CHECK_TIMEOUT_MS,
  probeCodexCliVersion,
  verifySupportedCodexCli,
  type CodexCliVersionProbe
} from "./appServerCompatibility.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import {
  JsonRpcProcess,
  MAX_JSON_RPC_TIMEOUT_MS,
  type JsonRpcLateResponse,
  type JsonRpcProcessIdentity,
  type JsonRpcTerminationResult
} from "./jsonRpcProcess.js";
import { PRODUCT_INFO } from "./productInfo.js";
import type { BackendCapabilities, ModelSelection } from "./modelPolicy.js";
import type {
  CodexThreadContinueRequest,
  CodexThreadForkRequest,
  CodexThreadStartRequest,
  CodexBackgroundTerminal,
  CodexPendingInteraction,
  CodexProgress,
  CodexPublicEvent,
  CodexUpstream,
  ToolResult,
  UpstreamWorkerAssignment
} from "./upstream.js";

const REASONING_NOTIFICATIONS = [
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "rawResponseItem/completed",
  "rawResponse/completed"
];

const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5_000;

export const APP_SERVER_CLIENT_INFO = Object.freeze({
  name: PRODUCT_INFO.runtimeName,
  title: PRODUCT_INFO.displayName,
  version: BRIDGE_BUILD_INFO.version
});

export type CodexAppServerLateResponse = JsonRpcLateResponse & {
  workerId: string;
  workerGeneration: number;
};

export type CodexAppServerProtocolOptions = {
  /** Deadline for checking the configured executable before each worker admission. */
  versionCheckTimeoutMs?: number;
  /** Deadline for bounded control requests; completed turns remain timer-free. */
  requestTimeoutMs?: number;
  /** Defaults to requestTimeoutMs when omitted. */
  initializeTimeoutMs?: number;
  /** Per-stage deadline for the interrupt acknowledgement and completion confirmation. */
  interruptTimeoutMs?: number;
  /**
   * Receives exact responses for recently timed-out control requests. Raw
   * payloads must be sanitized before logging or persistence.
   */
  onLateResponse?: (response: CodexAppServerLateResponse) => void;
};

type ResolvedCodexAppServerProtocolOptions = {
  versionCheckTimeoutMs: number;
  requestTimeoutMs: number;
  initializeTimeoutMs: number;
  interruptTimeoutMs: number;
  onLateResponse?: (response: CodexAppServerLateResponse) => void;
};

export type CodexAppServerDependencies = {
  versionProbe?: CodexCliVersionProbe;
};

type TurnContext = {
  threadId: string;
  turnId: string;
  onProgress?: (progress: CodexProgress) => void;
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  done: Promise<ToolResult>;
  eventSequence: number;
  finalMessage: string;
  commandOutputTails: Map<string, string>;
  lastAgentMessageEventAt: number;
};

type PendingInteraction = CodexPendingInteraction & {
  method: string;
  requestParams: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type AppWorker = {
  index: number;
  activeCalls: number;
  generation: number;
  connection?: AppServerConnection;
  startingConnection?: AppServerConnection;
  connecting?: Promise<AppServerConnection>;
};

export class CodexAppServerUpstreamPool implements CodexUpstream {
  private readonly workers: AppWorker[];
  private readonly threadWorkers = new Map<string, number>();
  private readonly protocolOptions: ResolvedCodexAppServerProtocolOptions;
  private readonly versionProbe: CodexCliVersionProbe;
  private compatibilityCheck?: Promise<string>;
  private compatibilityAbort?: AbortController;
  private closing = false;

  constructor(
    private readonly codexCommand: string,
    poolSize = 4,
    protocolOptions: CodexAppServerProtocolOptions = {},
    dependencies: CodexAppServerDependencies = {}
  ) {
    if (!Number.isInteger(poolSize) || poolSize <= 0) {
      throw new Error("Codex App Server pool size must be a positive integer.");
    }
    this.protocolOptions = resolveProtocolOptions(protocolOptions);
    this.versionProbe = dependencies.versionProbe || probeCodexCliVersion;
    this.workers = Array.from({ length: poolSize }, (_, index) => ({
      index,
      activeCalls: 0,
      generation: 0
    }));
  }

  async listTools(): Promise<unknown> {
    return {
      tools: [
        { name: "codex", description: "Start a Codex App Server thread and turn." },
        { name: "codex-reply", description: "Resume a Codex App Server thread and start a turn." },
        { name: "thread/fork", description: "Fork a persisted Codex thread and start a turn." },
        { name: "thread/archive", description: "Archive a persisted Codex thread." },
        { name: "thread/unarchive", description: "Restore an archived Codex thread." },
        { name: "turn/steer", description: "Steer an active Codex App Server turn." },
        { name: "turn/interrupt", description: "Interrupt an active Codex App Server turn." }
      ],
      backendKind: "app-server"
    };
  }

  capabilities(): BackendCapabilities {
    return APP_SERVER_CAPABILITIES;
  }

  startThread(
    input: CodexThreadStartRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.callTool(
      "codex",
      requestArguments(input.prompt, input.selection, {
        cwd: input.cwd,
        sandbox: input.sandbox,
        "approval-policy": input.approvalPolicy
      }),
      onProgress,
      onAssigned
    );
  }

  continueThread(
    input: CodexThreadContinueRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.callTool(
      "codex-reply",
      requestArguments(input.prompt, input.selection, { threadId: input.threadId }),
      onProgress,
      onAssigned
    );
  }

  async forkThread(
    input: CodexThreadForkRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const preferredIndex = this.threadWorkers.get(input.threadId);
    const worker = preferredIndex === undefined ? this.leastBusyWorker() : this.workers[preferredIndex];
    worker.activeCalls += 1;
    try {
      const connection = await this.connectionFor(worker);
      const result = await connection.forkThreadAndTurn(
        input.threadId,
        requestArguments(input.prompt, input.selection, {}),
        onProgress,
        (assignment) => {
          if (assignment.threadId) this.threadWorkers.set(assignment.threadId, worker.index);
          onAssigned?.(assignment);
        }
      );
      const threadId = structuredString(result, "threadId");
      if (threadId) this.threadWorkers.set(threadId, worker.index);
      return result;
    } finally {
      worker.activeCalls -= 1;
    }
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.withThreadWorker(threadId, (connection) => connection.archiveThread(threadId));
  }

  async restoreThread(threadId: string): Promise<void> {
    await this.withThreadWorker(threadId, (connection) => connection.restoreThread(threadId));
  }

  async listBackgroundTerminals(threadId: string): Promise<CodexBackgroundTerminal[]> {
    return this.withThreadWorker(threadId, (connection) => connection.listBackgroundTerminals(threadId));
  }

  async terminateBackgroundTerminal(
    threadId: string,
    processId: string
  ): Promise<{ terminated: boolean }> {
    return this.withThreadWorker(threadId, (connection) =>
      connection.terminateBackgroundTerminal(threadId, processId)
    );
  }

  async listModels(): Promise<unknown> {
    const worker = this.leastBusyWorker();
    worker.activeCalls += 1;
    try {
      return await (await this.connectionFor(worker)).listModels();
    } finally {
      worker.activeCalls -= 1;
    }
  }

  canResumeThread(_threadId: string): boolean {
    // App Server can load persisted Codex threads from disk by exact id.
    return true;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    if (name !== "codex" && name !== "codex-reply") {
      throw new Error(`Unsupported App Server compatibility tool: ${name}.`);
    }
    const requestedThreadId = name === "codex-reply" ? requiredString(args.threadId, "threadId") : undefined;
    const preferred = requestedThreadId === undefined
      ? undefined
      : this.workers[this.threadWorkers.get(requestedThreadId) ?? -1];
    const worker = preferred || this.leastBusyWorker();
    worker.activeCalls += 1;
    try {
      const connection = await this.connectionFor(worker);
      const assigned = (assignment: UpstreamWorkerAssignment) => {
        if (assignment.threadId) this.threadWorkers.set(assignment.threadId, worker.index);
        onAssigned?.(assignment);
      };
      const result = name === "codex"
        ? await connection.startThreadAndTurn(args, onProgress, assigned)
        : await connection.resumeThreadAndTurn(requestedThreadId as string, args, onProgress, assigned);
      const threadId = structuredString(result, "threadId");
      if (threadId) this.threadWorkers.set(threadId, worker.index);
      return result;
    } catch (error) {
      if (worker.connection?.exited) {
        worker.connection = undefined;
        this.forgetWorkerThreads(worker.index);
      }
      throw error;
    } finally {
      worker.activeCalls -= 1;
    }
  }

  async forceTerminateWorker(
    assignment: UpstreamWorkerAssignment,
    graceMs?: number
  ): Promise<JsonRpcTerminationResult> {
    const worker = this.workers.find((candidate) => `app-${candidate.index}` === assignment.workerId);
    if (!worker || !worker.connection || worker.generation !== assignment.workerGeneration) {
      throw new Error("The selected App Server worker generation is no longer active.");
    }
    const result = await worker.connection.interruptOrTerminate(assignment, graceMs);
    if (result.workerExited) {
      worker.connection = undefined;
      this.forgetWorkerThreads(worker.index);
    }
    return result;
  }

  async respondToInteraction(
    interactionId: string,
    response: { decision?: "accept" | "decline" | "cancel"; answers?: Record<string, string[]> }
  ): Promise<void> {
    for (const worker of this.workers) {
      if (worker.connection?.respondToInteraction(interactionId, response)) return;
    }
    throw new Error("Unknown or already resolved Codex interaction id.");
  }

  async steerThread(threadId: string, prompt: string): Promise<{ turnId: string }> {
    const workerIndex = this.threadWorkers.get(threadId);
    const worker = workerIndex === undefined ? undefined : this.workers[workerIndex];
    if (!worker?.connection) throw new Error("The requested Codex thread has no active App Server turn to steer.");
    return worker.connection.steerThread(threadId, prompt);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.threadWorkers.clear();
    const compatibilityCheck = this.compatibilityCheck;
    this.compatibilityAbort?.abort();
    if (compatibilityCheck) {
      try {
        await compatibilityCheck;
      } catch {
        // Closing intentionally cancels an in-flight executable admission check.
      }
    }
    await Promise.all(
      this.workers.map(async (worker) => {
        const connections = new Set(
          [worker.connection, worker.startingConnection].filter(
            (connection): connection is AppServerConnection => Boolean(connection)
          )
        );
        await Promise.all([...connections].map((connection) => connection.close()));
        if (!worker.connecting) return;
        try {
          await worker.connecting;
        } catch {
          // Failed and interrupted startup paths clean up their own process.
        }
      })
    );
  }

  private leastBusyWorker(): AppWorker {
    return this.workers.reduce((selected, candidate) =>
      candidate.activeCalls < selected.activeCalls ||
      (candidate.activeCalls === selected.activeCalls && candidate.index < selected.index)
        ? candidate
        : selected
    );
  }

  private async withThreadWorker<T>(
    threadId: string,
    operation: (connection: AppServerConnection) => Promise<T>
  ): Promise<T> {
    const preferredIndex = this.threadWorkers.get(threadId);
    const worker = preferredIndex === undefined ? this.leastBusyWorker() : this.workers[preferredIndex];
    worker.activeCalls += 1;
    try {
      const result = await operation(await this.connectionFor(worker));
      this.threadWorkers.set(threadId, worker.index);
      return result;
    } finally {
      worker.activeCalls -= 1;
    }
  }

  private async connectionFor(worker: AppWorker): Promise<AppServerConnection> {
    if (this.closing) throw new Error("Codex App Server upstream is closed.");
    if (worker.connection && !worker.connection.exited) return worker.connection;
    if (!worker.connecting) {
      await this.ensureCompatibleExecutable();
      if (this.closing) throw new Error("Codex App Server upstream is closed.");
      if (worker.connection && !worker.connection.exited) return worker.connection;
      if (!worker.connecting) {
        const generation = ++worker.generation;
        const connection = AppServerConnection.spawn(
          this.codexCommand,
          `app-${worker.index}`,
          generation,
          {
            ...this.protocolOptions,
            onLateResponse: (response) => this.onWorkerLateResponse(worker, response)
          }
        );
        worker.startingConnection = connection;
        worker.connecting = connection.initializeForAdmission().then(async (initialized) => {
          if (this.closing) {
            await initialized.close();
            throw new Error("Codex App Server upstream closed during worker startup.");
          }
          worker.connection = initialized;
          return initialized;
        });
      }
    }
    const pending = worker.connecting;
    const starting = worker.startingConnection;
    try {
      return await pending;
    } finally {
      if (worker.connecting === pending) worker.connecting = undefined;
      if (worker.startingConnection === starting) worker.startingConnection = undefined;
    }
  }

  private ensureCompatibleExecutable(): Promise<string> {
    if (this.compatibilityCheck) return this.compatibilityCheck;
    const controller = new AbortController();
    const check = verifySupportedCodexCli(
      this.codexCommand,
      this.protocolOptions.versionCheckTimeoutMs,
      this.versionProbe,
      controller.signal
    );
    this.compatibilityCheck = check;
    this.compatibilityAbort = controller;
    const clear = () => {
      if (this.compatibilityCheck === check) {
        this.compatibilityCheck = undefined;
        this.compatibilityAbort = undefined;
      }
    };
    void check.then(clear, clear);
    return check;
  }

  private onWorkerLateResponse(worker: AppWorker, response: CodexAppServerLateResponse): void {
    if (worker.generation === response.workerGeneration && lateResponseSucceeded(response)) {
      const threadId = lateResponseThreadId(response);
      if (threadId) this.threadWorkers.set(threadId, worker.index);
    }
    this.protocolOptions.onLateResponse?.(response);
  }

  private forgetWorkerThreads(workerIndex: number): void {
    for (const [threadId, index] of this.threadWorkers) {
      if (index === workerIndex) this.threadWorkers.delete(threadId);
    }
  }
}

class AppServerConnection {
  private readonly rpc: JsonRpcProcess;
  private readonly activeTurns = new Map<string, TurnContext>();
  private readonly threadTurns = new Map<string, string>();
  private readonly loadedThreads = new Set<string>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly terminalTurns = new Set<string>();

  private constructor(
    command: string,
    private readonly workerId: string,
    private readonly generation: number,
    private readonly protocolOptions: ResolvedCodexAppServerProtocolOptions
  ) {
    this.rpc = new JsonRpcProcess({
      command,
      args: ["app-server", "--stdio"],
      debugLabel: `codex-app:${workerId}:g${generation}`,
      omitJsonRpcHeader: true,
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params, requestId) => this.onServerRequest(method, params, requestId),
      onExit: (error) => this.onProcessExit(error),
      onLateResponse: (response) => {
        const appResponse = {
          ...response,
          workerId,
          workerGeneration: generation
        };
        this.reconcileLateProtocolState(appResponse);
        protocolOptions.onLateResponse?.(appResponse);
      }
    });
  }

  static spawn(
    command: string,
    workerId: string,
    generation: number,
    protocolOptions: ResolvedCodexAppServerProtocolOptions
  ): AppServerConnection {
    return new AppServerConnection(command, workerId, generation, protocolOptions);
  }

  async initializeForAdmission(): Promise<AppServerConnection> {
    try {
      await this.initialize();
      return this;
    } catch (error) {
      const identity = this.rpc.identity;
      const initializationError = appServerInitializationError(error, identity);
      try {
        await this.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [initializationError, cleanupError],
          `${initializationError.message} Worker cleanup also failed.`
        );
      }
      throw initializationError;
    }
  }

  get exited(): boolean {
    return this.rpc.exited;
  }

  private reconcileLateProtocolState(response: CodexAppServerLateResponse): void {
    if (!lateResponseSucceeded(response)) return;
    const threadId = lateResponseThreadId(response);
    if (!threadId) return;
    if (response.method === "thread/archive" || response.method === "thread/unarchive") {
      // Archive invalidates the materialized thread. Unarchive restores durable
      // persistence but still requires an explicit thread/resume on this worker.
      this.loadedThreads.delete(threadId);
      return;
    }
    if (
      response.method === "thread/start" ||
      response.method === "thread/fork" ||
      response.method === "thread/resume"
    ) {
      this.loadedThreads.add(threadId);
    }
  }

  async startThreadAndTurn(
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/start",
      {
        cwd: requiredString(args.cwd, "cwd"),
        sandbox: requiredString(args.sandbox, "sandbox"),
        approvalPolicy: requiredString(args["approval-policy"], "approval-policy"),
        model: optionalString(args.model) || null,
        serviceTier: optionalString(args.serviceTier) || null,
        config: isRecord(args.config) ? args.config : null,
        experimentalRawEvents: false,
        ephemeral: false
      },
      { timeoutMs: this.protocolOptions.requestTimeoutMs }
    );
    const thread = isRecord(response.thread) ? response.thread : undefined;
    const threadId = requiredString(thread?.id, "thread/start thread.id");
    this.loadedThreads.add(threadId);
    return this.startTurn(threadId, requiredString(args.prompt, "prompt"), args, onProgress, onAssigned);
  }

  async resumeThreadAndTurn(
    threadId: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    await this.ensureThreadLoaded(threadId);
    return this.startTurn(threadId, requiredString(args.prompt, "prompt"), args, onProgress, onAssigned);
  }

  async forkThreadAndTurn(
    sourceThreadId: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/fork",
      { threadId: sourceThreadId },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { sourceThreadId }
      }
    );
    const thread = isRecord(response.thread) ? response.thread : undefined;
    const threadId = requiredString(thread?.id, "thread/fork thread.id");
    this.loadedThreads.add(threadId);
    return this.startTurn(threadId, requiredString(args.prompt, "prompt"), args, onProgress, onAssigned);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.rpc.request(
      "thread/archive",
      { threadId },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId }
      }
    );
    this.loadedThreads.delete(threadId);
  }

  async restoreThread(threadId: string): Promise<void> {
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/unarchive",
      { threadId },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId }
      }
    );
    const restoredThread = isRecord(response.thread) ? response.thread : undefined;
    const restoredThreadId = typeof restoredThread?.id === "string" ? restoredThread.id : undefined;
    if (restoredThreadId && restoredThreadId !== threadId) {
      throw new Error("Codex App Server restored a different thread than requested.");
    }
    // Unarchive restores persistence but does not guarantee that this App
    // Server connection has materialized the thread. The next operation must
    // load it through thread/resume instead of trusting stale local state.
    this.loadedThreads.delete(threadId);
  }

  async listBackgroundTerminals(threadId: string): Promise<CodexBackgroundTerminal[]> {
    await this.ensureThreadLoaded(threadId);
    const terminals: CodexBackgroundTerminal[] = [];
    let cursor: string | null = null;
    do {
      const response: Record<string, unknown> = await this.rpc.request<Record<string, unknown>>(
        "thread/backgroundTerminals/list",
        { threadId, cursor, limit: 100 },
        { timeoutMs: this.protocolOptions.requestTimeoutMs }
      );
      if (!Array.isArray(response.data)) {
        throw new Error("Codex App Server returned an invalid background terminal list.");
      }
      for (const raw of response.data) {
        if (!isRecord(raw)) throw new Error("Codex App Server returned an invalid background terminal.");
        terminals.push({
          processId: requiredString(raw.processId, "background terminal processId"),
          itemId: requiredString(raw.itemId, "background terminal itemId"),
          command: requiredString(raw.command, "background terminal command"),
          cwd: requiredString(raw.cwd, "background terminal cwd"),
          ...(typeof raw.osPid === "number" ? { osPid: raw.osPid } : {}),
          ...(typeof raw.cpuPercent === "number" ? { cpuPercent: raw.cpuPercent } : {}),
          ...(typeof raw.rssKb === "number" ? { rssKb: raw.rssKb } : {})
        });
      }
      cursor = optionalString(response.nextCursor) || null;
    } while (cursor);
    return terminals;
  }

  async terminateBackgroundTerminal(
    threadId: string,
    processId: string
  ): Promise<{ terminated: boolean }> {
    await this.ensureThreadLoaded(threadId);
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/backgroundTerminals/terminate",
      { threadId, processId },
      { timeoutMs: this.protocolOptions.requestTimeoutMs }
    );
    if (typeof response.terminated !== "boolean") {
      throw new Error("Codex App Server returned an invalid background terminal termination result.");
    }
    return { terminated: response.terminated };
  }

  private async ensureThreadLoaded(threadId: string): Promise<void> {
    if (this.loadedThreads.has(threadId)) return;
    await this.rpc.request(
      "thread/resume",
      { threadId },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId }
      }
    );
    this.loadedThreads.add(threadId);
  }

  async listModels(): Promise<unknown> {
    const data: unknown[] = [];
    let cursor: string | null = null;
    do {
      const response: Record<string, unknown> = await this.rpc.request<Record<string, unknown>>(
        "model/list",
        { cursor, limit: 100, includeHidden: false },
        { timeoutMs: this.protocolOptions.requestTimeoutMs }
      );
      if (!Array.isArray(response.data)) {
        throw new Error("Codex App Server returned an invalid model/list response.");
      }
      data.push(...response.data);
      cursor = optionalString(response.nextCursor) || null;
    } while (cursor);
    return { data, nextCursor: null };
  }

  async steerThread(threadId: string, prompt: string): Promise<{ turnId: string }> {
    const turnId = this.threadTurns.get(threadId);
    if (!turnId) throw new Error("The requested Codex thread has no active turn to steer.");
    const result = await this.rpc.request<Record<string, unknown>>(
      "turn/steer",
      {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: prompt, text_elements: [] }]
      },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId, turnId }
      }
    );
    return { turnId: requiredString(result.turnId, "turn/steer turnId") };
  }

  respondToInteraction(
    interactionId: string,
    response: { decision?: "accept" | "decline" | "cancel"; answers?: Record<string, string[]> }
  ): boolean {
    const pending = this.pendingInteractions.get(interactionId);
    if (!pending) return false;
    if (pending.kind === "user-input") {
      if (!response.answers) throw new Error("User-input interaction requires answers.");
      this.pendingInteractions.delete(interactionId);
      pending.resolve({
        answers: Object.fromEntries(
          Object.entries(response.answers).map(([key, answers]) => [key, { answers }])
        )
      });
    } else {
      if (!response.decision) throw new Error("Approval interaction requires a decision.");
      this.pendingInteractions.delete(interactionId);
      if (pending.kind === "permission-approval") {
        const requested = isRecord(pending.requestParams.permissions)
          ? pending.requestParams.permissions
          : {};
        pending.resolve({
          permissions: response.decision === "accept" ? grantedPermissions(requested) : {},
          scope: "turn"
        });
      } else {
        pending.resolve({ decision: response.decision || "decline" });
      }
    }
    return true;
  }

  async interruptOrTerminate(
    assignment: UpstreamWorkerAssignment,
    graceMs = 1_500
  ): Promise<JsonRpcTerminationResult> {
    const identity = this.rpc.identity;
    if (!identity) throw new Error("App Server worker process identity is unavailable.");
    if (
      (assignment.workerPid !== undefined && assignment.workerPid !== identity.pid) ||
      (assignment.processGroupId !== undefined && assignment.processGroupId !== identity.processGroupId)
    ) {
      throw new Error("The selected App Server process identity changed; refresh status before force-stopping it.");
    }
    const turnId = assignment.upstreamRequestId;
    const context = turnId ? this.activeTurns.get(turnId) : undefined;
    if (turnId && context) {
      try {
        await this.rpc.request(
          "turn/interrupt",
          { threadId: context.threadId, turnId },
          {
            timeoutMs: this.protocolOptions.interruptTimeoutMs,
            lateResponseContext: { threadId: context.threadId, turnId }
          }
        );
        const confirmed = await Promise.race([
          context.done.then(() => true, () => true),
          delay(this.protocolOptions.interruptTimeoutMs).then(() => false)
        ]);
        if (confirmed || this.terminalTurns.has(turnId)) {
          return {
            ...identity,
            exited: true,
            escalated: false,
            signal: null,
            mode: "turn-interrupt",
            workerExited: false
          };
        }
      } catch {
        // One UI action automatically falls back to supervised process-group termination.
      }
    }
    return this.rpc.forceTerminate(graceMs);
  }

  async close(): Promise<void> {
    for (const pending of this.pendingInteractions.values()) {
      pending.reject(new Error("Codex App Server closed before the interaction was answered."));
    }
    this.pendingInteractions.clear();
    await this.rpc.close();
  }

  private async initialize(): Promise<void> {
    const result = await this.rpc.request(
      "initialize",
      {
        clientInfo: APP_SERVER_CLIENT_INFO,
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          optOutNotificationMethods: REASONING_NOTIFICATIONS
        }
      },
      { timeoutMs: this.protocolOptions.initializeTimeoutMs }
    );
    validateInitializeResponse(result);
    await this.rpc.notify("initialized");
  }

  private async startTurn(
    threadId: string,
    prompt: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    if (this.threadTurns.has(threadId)) throw new Error("A Codex App Server turn is already active for this thread.");
    const response = await this.rpc.request<Record<string, unknown>>(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        model: optionalString(args.model) || null,
        effort: modelReasoningEffort(args.config) || null,
        serviceTier: optionalString(args.serviceTier) || null
      },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId }
      }
    );
    const turn = isRecord(response.turn) ? response.turn : undefined;
    const turnId = requiredString(turn?.id, "turn/start turn.id");
    let resolve!: (result: ToolResult) => void;
    let reject!: (error: Error) => void;
    const done = new Promise<ToolResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const context: TurnContext = {
      threadId,
      turnId,
      onProgress,
      resolve,
      reject,
      done,
      eventSequence: 0,
      finalMessage: "",
      commandOutputTails: new Map(),
      lastAgentMessageEventAt: 0
    };
    this.activeTurns.set(turnId, context);
    this.threadTurns.set(threadId, turnId);
    const identity = this.rpc.identity;
    const assignment: UpstreamWorkerAssignment = {
      backendKind: "app-server",
      workerId: this.workerId,
      workerGeneration: this.generation,
      ...(identity ? { workerPid: identity.pid } : {}),
      ...(identity?.processGroupId !== null && identity?.processGroupId !== undefined
        ? { processGroupId: identity.processGroupId }
        : {}),
      upstreamRequestId: turnId,
      threadId
    };
    try {
      onAssigned?.(assignment);
    } catch (error) {
      try {
        // Keep the TurnContext and per-thread lock until terminal evidence is
        // observed. interruptOrTerminate waits for turn/completed and falls
        // back to terminating the worker process when confirmation is absent.
        await this.interruptOrTerminate(assignment);
      } catch {
        // A missing process identity is the only expected helper failure. Make
        // one direct containment attempt while preserving the originating
        // assignment-persistence error for the caller.
        try {
          await this.rpc.forceTerminate();
        } catch {
          // The retained TurnContext/thread lock still prevents overlapping work.
        }
      }
      throw error;
    }
    this.emit(context, {
      eventId: `turn:${turnId}`,
      type: "turn",
      phase: "started",
      createdAt: Date.now(),
      summary: "Codex turn started.",
      details: { threadId, turnId }
    });
    return done;
  }

  private onNotification(method: string, params: unknown): void {
    if (REASONING_NOTIFICATIONS.includes(method) || !isRecord(params)) return;
    const turnId = optionalString(params.turnId) || (isRecord(params.turn) ? optionalString(params.turn.id) : undefined);
    const context = turnId ? this.activeTurns.get(turnId) : undefined;
    if (!context) return;
    if (method === "turn/completed") {
      this.completeTurn(context, params);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = rawString(params.delta);
      if (delta) {
        context.finalMessage = boundedAppend(context.finalMessage, delta, 100_000);
        const now = Date.now();
        if (now - context.lastAgentMessageEventAt >= 500) {
          context.lastAgentMessageEventAt = now;
          this.emit(
            context,
            event(
              "agent-message",
              "updated",
              tail(context.finalMessage, 1_000),
              { itemId: optionalString(params.itemId) || null }
            )
          );
        }
      }
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      const itemId = optionalString(params.itemId);
      const delta = rawString(params.delta);
      if (itemId && delta) {
        context.commandOutputTails.set(itemId, tail(boundedAppend(context.commandOutputTails.get(itemId) || "", delta, 16_384), 8_192));
      }
      return;
    }
    if (method === "turn/plan/updated") {
      const plan = Array.isArray(params.plan)
        ? params.plan.filter(isRecord).slice(0, 30).map((step) => ({
            step: optionalString(step.step)?.slice(0, 500) || "",
            status: optionalString(step.status) || "unknown"
          }))
        : [];
      this.emit(context, event("plan", "updated", `Plan updated (${plan.length} steps).`, { plan }));
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = isRecord(params.item) ? params.item : undefined;
      if (!item || item.type === "reasoning") return;
      const publicEvent = publicItemEvent(item, method === "item/started" ? "started" : "completed", context);
      if (publicEvent) this.emit(context, publicEvent);
    }
  }

  private onServerRequest(method: string, params: unknown, requestId: number | string): Promise<unknown> {
    if (!isRecord(params)) throw new Error(`Invalid App Server request payload for ${method}.`);
    const kind = method === "item/commandExecution/requestApproval"
      ? "command-approval"
      : method === "item/fileChange/requestApproval"
        ? "file-approval"
        : method === "item/permissions/requestApproval"
          ? "permission-approval"
          : method === "item/tool/requestUserInput"
            ? "user-input"
            : undefined;
    if (!kind) throw Object.assign(new Error(`Unsupported App Server request: ${method}.`), { code: -32601 });
    const threadId = requiredString(params.threadId, "interaction threadId");
    const turnId = requiredString(params.turnId, "interaction turnId");
    const itemId = requiredString(params.itemId, "interaction itemId");
    const context = this.activeTurns.get(turnId);
    if (!context) throw new Error("App Server requested input for an unknown turn.");
    const interactionId = `${this.workerId}:${this.generation}:${String(requestId)}`;
    const questions = kind === "user-input" && Array.isArray(params.questions)
      ? params.questions.filter(isRecord).slice(0, 3).map((question) => ({
          id: requiredString(question.id, "question id"),
          header: optionalString(question.header)?.slice(0, 80) || "Input",
          question: optionalString(question.question)?.slice(0, 1_000) || "",
          isSecret: question.isSecret === true,
          options: Array.isArray(question.options)
            ? question.options.filter(isRecord).slice(0, 10).map((option) => ({
                label: optionalString(option.label)?.slice(0, 120) || "",
                description: optionalString(option.description)?.slice(0, 300) || ""
              }))
            : undefined
        }))
      : undefined;
    const summary = kind === "command-approval"
      ? `Command approval required: ${(optionalString(params.command) || "command").slice(0, 500)}`
      : kind === "file-approval"
        ? "File-change approval required."
        : kind === "permission-approval"
          ? `Additional permission approval required: ${(optionalString(params.reason) || "Codex requested additional access.").slice(0, 500)}`
          : "Codex requires user input.";
    const interaction: CodexPendingInteraction = {
      interactionId,
      kind,
      threadId,
      turnId,
      itemId,
      summary,
      ...(questions ? { questions } : {})
    };
    this.emit(
      context,
      event(
        kind === "user-input" ? "input-required" : "approval-required",
        "waiting",
        summary,
        { interaction }
      )
    );
    return new Promise((resolve, reject) => {
      this.pendingInteractions.set(interactionId, {
        ...interaction,
        method,
        requestParams: params,
        resolve,
        reject
      });
    });
  }

  private completeTurn(context: TurnContext, params: Record<string, unknown>): void {
    const turn = isRecord(params.turn) ? params.turn : {};
    const status = optionalString(turn.status) || "failed";
    if (!context.finalMessage && Array.isArray(turn.items)) {
      for (const item of turn.items.filter(isRecord)) {
        if (item.type === "agentMessage" && typeof item.text === "string") context.finalMessage = item.text;
      }
    }
    this.emit(context, event("turn", "completed", `Codex turn ${status}.`, { status }));
    this.activeTurns.delete(context.turnId);
    this.threadTurns.delete(context.threadId);
    this.terminalTurns.add(context.turnId);
    if (this.terminalTurns.size > 200) this.terminalTurns.delete(this.terminalTurns.values().next().value as string);
    for (const [interactionId, interaction] of this.pendingInteractions) {
      if (interaction.turnId !== context.turnId) continue;
      interaction.reject(new Error("Codex turn ended before the pending interaction was answered."));
      this.pendingInteractions.delete(interactionId);
    }
    const errorMessage = isRecord(turn.error)
      ? optionalString(turn.error.message) || JSON.stringify(turn.error).slice(0, 1_000)
      : undefined;
    context.resolve({
      ...(status === "failed" ? { isError: true } : {}),
      content: [
        {
          type: "text",
          text: context.finalMessage || errorMessage || `Codex turn ${status}.`
        }
      ],
      structuredContent: {
        threadId: context.threadId,
        turnId: context.turnId,
        turnStatus: status,
        backendKind: "app-server"
      }
    });
  }

  private onProcessExit(error: Error): void {
    for (const interaction of this.pendingInteractions.values()) interaction.reject(error);
    this.pendingInteractions.clear();
    for (const context of this.activeTurns.values()) context.reject(error);
    this.activeTurns.clear();
    this.threadTurns.clear();
  }

  private emit(context: TurnContext, publicEvent: CodexPublicEvent): void {
    context.eventSequence += 1;
    context.onProgress?.({
      progress: context.eventSequence,
      message: publicEvent.summary.slice(0, 500),
      event: publicEvent
    });
  }
}

export const APP_SERVER_CAPABILITIES: BackendCapabilities = {
  selectionScope: "turn",
  supportsModelOverrideOnContinue: true,
  supportsEffortOverrideOnContinue: true,
  supportsServiceTierOverrideOnContinue: true,
  supportsFork: true
};

function resolveProtocolOptions(
  options: CodexAppServerProtocolOptions
): ResolvedCodexAppServerProtocolOptions {
  const requestTimeoutMs = positiveTimeout(
    options.requestTimeoutMs ?? DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs"
  );
  return {
    versionCheckTimeoutMs: positiveTimeout(
      options.versionCheckTimeoutMs ?? DEFAULT_CODEX_VERSION_CHECK_TIMEOUT_MS,
      "versionCheckTimeoutMs"
    ),
    requestTimeoutMs,
    initializeTimeoutMs: positiveTimeout(
      options.initializeTimeoutMs ?? requestTimeoutMs,
      "initializeTimeoutMs"
    ),
    interruptTimeoutMs: positiveTimeout(
      options.interruptTimeoutMs ?? DEFAULT_APP_SERVER_INTERRUPT_TIMEOUT_MS,
      "interruptTimeoutMs"
    ),
    ...(options.onLateResponse ? { onLateResponse: options.onLateResponse } : {})
  };
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_JSON_RPC_TIMEOUT_MS) {
    throw new Error(
      `Codex App Server ${label} must be an integer between 1 and ${MAX_JSON_RPC_TIMEOUT_MS}ms.`
    );
  }
  return value;
}

function validateInitializeResponse(value: unknown): void {
  // Initialize currently advertises platform/user-agent metadata, but no
  // protocol-version field. Validate the documented shape without parsing an
  // undocumented compatibility range out of userAgent.
  if (!isRecord(value)) {
    throw new Error(
      "Codex App Server returned an incompatible initialize response; expected an object. Check the installed Codex CLI version."
    );
  }
  const invalidFields = ["userAgent", "platformFamily", "platformOs"].filter(
    (field) => typeof value[field] !== "string"
  );
  if (invalidFields.length > 0) {
    throw new Error(
      `Codex App Server returned an incompatible initialize response; missing string field(s): ${invalidFields.join(", ")}. Check the installed Codex CLI version.`
    );
  }
}

function appServerInitializationError(
  error: unknown,
  processIdentity: JsonRpcProcessIdentity | undefined
): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  const metadata = isRecord(error)
    ? Object.fromEntries(
        ["code", "data", "requestId", "method", "timeoutMs"].flatMap((key) =>
          error[key] === undefined ? [] : [[key, error[key]]]
        )
      )
    : {};
  return Object.assign(
    new Error(`Codex App Server initialization failed: ${cause.message}`, { cause }),
    metadata,
    processIdentity ? { processIdentity } : {}
  );
}

function requestArguments(
  prompt: string,
  selection: ModelSelection | undefined,
  base: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...base,
    prompt,
    ...(selection
      ? {
          model: selection.model,
          config: { model_reasoning_effort: selection.reasoningEffort },
          ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {})
        }
      : {})
  };
}

function publicItemEvent(
  item: Record<string, unknown>,
  phase: "started" | "completed",
  context: TurnContext
): CodexPublicEvent | undefined {
  const itemId = optionalString(item.id) || randomUUID();
  if (item.type === "agentMessage") {
    const text = optionalString(item.text);
    if (text) context.finalMessage = text;
    return event("agent-message", phase, text?.slice(0, 1_000) || `Agent message ${phase}.`, { itemId });
  }
  if (item.type === "plan") {
    return event("plan", phase, (optionalString(item.text) || `Plan ${phase}.`).slice(0, 1_000), { itemId });
  }
  if (item.type === "commandExecution") {
    return event(
      "command",
      phase,
      `Command ${phase}: ${(optionalString(item.command) || "command").slice(0, 500)}`,
      {
        itemId,
        status: optionalString(item.status) || null,
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
        outputTail: phase === "completed" ? context.commandOutputTails.get(itemId) || null : null
      }
    );
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes)
      ? item.changes.filter(isRecord).slice(0, 100).map((change) => ({
          path: optionalString(change.path)?.slice(0, 500) || "",
          kind: optionalString(change.kind) || "unknown"
        }))
      : [];
    return event("file-change", phase, `File changes ${phase} (${changes.length}).`, { itemId, changes });
  }
  return undefined;
}

function event(
  type: CodexPublicEvent["type"],
  phase: CodexPublicEvent["phase"],
  summary: string,
  details?: Record<string, unknown>
): CodexPublicEvent {
  return { eventId: randomUUID(), type, phase, createdAt: Date.now(), summary, ...(details ? { details } : {}) };
}

function structuredString(result: ToolResult, key: string): string | undefined {
  return isRecord(result.structuredContent) ? optionalString(result.structuredContent[key]) : undefined;
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`Missing ${label}.`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lateResponseSucceeded(response: CodexAppServerLateResponse): boolean {
  return !isRecord(response.response.error) &&
    Object.prototype.hasOwnProperty.call(response.response, "result");
}

function lateResponseThreadId(response: CodexAppServerLateResponse): string | undefined {
  const context = response.lateResponseContext;
  const contextualThreadId = safeLateIdentifier(context?.threadId);
  const result = isRecord(response.response.result) ? response.response.result : undefined;
  const returnedThread = result && isRecord(result.thread) ? result.thread : undefined;
  const returnedThreadId = safeLateIdentifier(returnedThread?.id);

  if (response.method === "thread/start" || response.method === "thread/fork") {
    return returnedThreadId;
  }
  if (response.method === "thread/resume" || response.method === "thread/unarchive") {
    if (returnedThreadId && contextualThreadId && returnedThreadId !== contextualThreadId) return undefined;
    return returnedThreadId || contextualThreadId;
  }
  if (
    response.method === "thread/archive" ||
    response.method === "turn/start" ||
    response.method === "turn/steer" ||
    response.method === "turn/interrupt"
  ) {
    return contextualThreadId;
  }
  return undefined;
}

function safeLateIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

function rawString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function modelReasoningEffort(value: unknown): string | undefined {
  return isRecord(value) ? optionalString(value.model_reasoning_effort) : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function boundedAppend(current: string, delta: string, max: number): string {
  const combined = current + delta;
  return combined.length <= max ? combined : combined.slice(combined.length - max);
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function grantedPermissions(requested: Record<string, unknown>): Record<string, unknown> {
  const granted: Record<string, unknown> = {};
  if (isRecord(requested.network)) granted.network = requested.network;
  if (isRecord(requested.fileSystem)) granted.fileSystem = requested.fileSystem;
  return granted;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
