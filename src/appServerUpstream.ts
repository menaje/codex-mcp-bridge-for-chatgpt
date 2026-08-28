import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
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
  JsonRpcServerRequestResolved,
  MAX_JSON_RPC_TIMEOUT_MS,
  type JsonRpcLateResponse,
  type JsonRpcProcessIdentity,
  type JsonRpcTerminationResult
} from "./jsonRpcProcess.js";
import { PRODUCT_INFO } from "./productInfo.js";
import type { BackendCapabilities, ModelSelection } from "./modelPolicy.js";
import {
  assertWorkerTerminationCorrelation,
  type WorkerTerminationCorrelation
} from "./cancellation.js";
import {
  MAX_CODEX_INTERACTION_QUESTIONS,
  type CodexThreadContinueRequest,
  type CodexThreadForkRequest,
  type CodexThreadStartRequest,
  type CodexBackgroundTerminal,
  type CodexInteractionDecision,
  type CodexPendingInteraction,
  type CodexProgress,
  type CodexPublicEvent,
  type CodexThreadLineage,
  type CodexThreadResumeProbe,
  type CodexUpstream,
  type ToolResult,
  type UpstreamWorkerAssignment
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
  workerMetricsProbe?: WorkerMetricsProbe;
};

export type WorkerProcessMetrics = {
  rssKb?: number;
  fdCount?: number;
};

export type WorkerMetricsProbe = (pid: number) => Promise<WorkerProcessMetrics>;

type TurnContext = {
  threadId: string;
  turnId: string;
  lineage: CodexThreadLineage;
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
  requestId: number | string;
  method: string;
  requestParams: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  answered: boolean;
  autoResolutionTimer?: NodeJS.Timeout;
};

type AppServerInitializationHealth = {
  protocol: "ready" | "starting";
  config: "ready" | "warning" | "starting";
  configWarningCount: number;
  mcpServers: {
    observed: number;
    starting: number;
    ready: number;
    failed: number;
    cancelled: number;
    unobserved: boolean;
  };
};

type WorkerExitObservation = {
  generation: number;
  expected: boolean;
};

type AppWorker = {
  index: number;
  activeCalls: number;
  generation: number;
  connection?: AppServerConnection;
  startingConnection?: AppServerConnection;
  connecting?: Promise<AppServerConnection>;
  spawnCount: number;
  startupFailureCount: number;
  crashCount: number;
  startupSamples: number;
  startupLatencyTotalMs: number;
  lastStartupLatencyMs?: number;
  lastStartupAt?: number;
  maxStartupLatencyMs: number;
  lastCrashAt?: number;
};

export class CodexAppServerUpstreamPool implements CodexUpstream {
  private readonly workers: AppWorker[];
  private readonly threadWorkers = new Map<string, number>();
  private readonly threadResumeEvidence = new Map<string, boolean>();
  private readonly protocolOptions: ResolvedCodexAppServerProtocolOptions;
  private readonly versionProbe: CodexCliVersionProbe;
  private readonly workerMetricsProbe: WorkerMetricsProbe;
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
    this.workerMetricsProbe = dependencies.workerMetricsProbe || defaultWorkerMetricsProbe;
    this.workers = Array.from({ length: poolSize }, (_, index) => ({
      index,
      activeCalls: 0,
      generation: 0,
      spawnCount: 0,
      startupFailureCount: 0,
      crashCount: 0,
      startupSamples: 0,
      startupLatencyTotalMs: 0,
      maxStartupLatencyMs: 0
    }));
  }

  async listTools(): Promise<unknown> {
    const resumableEvidence = [...this.threadResumeEvidence.values()];
    const liveWorkers = this.workers.filter(
      (worker): worker is AppWorker & { connection: AppServerConnection } =>
        Boolean(worker.connection && !worker.connection.exited)
    );
    const metricSamples = await Promise.all(
      liveWorkers.map(async (worker) => {
        const pid = worker.connection.identity?.pid;
        if (!pid) return undefined;
        try {
          return await this.workerMetricsProbe(pid);
        } catch {
          return undefined;
        }
      })
    );
    const observedMetrics = metricSamples.filter(
      (sample): sample is WorkerProcessMetrics => Boolean(sample)
    );
    const rssSamples = observedMetrics.flatMap((sample) =>
      sample.rssKb === undefined ? [] : [sample.rssKb]
    );
    const fdSamples = observedMetrics.flatMap((sample) =>
      sample.fdCount === undefined ? [] : [sample.fdCount]
    );
    const startupSamples = this.workers.reduce((total, worker) => total + worker.startupSamples, 0);
    const startupLatencyTotalMs = this.workers.reduce(
      (total, worker) => total + worker.startupLatencyTotalMs,
      0
    );
    const initialization = aggregateInitializationHealth(liveWorkers.map((worker) =>
      worker.connection.initializationHealth
    ));
    const totalSpawns = this.workers.reduce((total, worker) => total + worker.spawnCount, 0);
    const totalCrashes = this.workers.reduce((total, worker) => total + worker.crashCount, 0);
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
      backendKind: "app-server",
      experimental: true,
      workerHealth: {
        configured: this.workers.length,
        live: liveWorkers.length,
        starting: this.workers.filter((worker) => Boolean(worker.connecting)).length,
        activeCalls: this.workers.reduce((total, worker) => total + worker.activeCalls, 0),
        stickyThreads: this.threadWorkers.size,
        resources: {
          observedWorkers: observedMetrics.length,
          unavailableWorkers: Math.max(0, liveWorkers.length - observedMetrics.length),
          rssKb: metricAggregate(rssSamples),
          fdCount: metricAggregate(fdSamples)
        },
        startup: {
          spawnCount: totalSpawns,
          failureCount: this.workers.reduce(
            (total, worker) => total + worker.startupFailureCount,
            0
          ),
          latencyMs: {
            samples: startupSamples,
            average: startupSamples > 0
              ? Math.round(startupLatencyTotalMs / startupSamples)
              : null,
            latest: latestStartupLatency(this.workers),
            max: Math.max(0, ...this.workers.map((worker) => worker.maxStartupLatencyMs)) || null
          }
        },
        crashes: {
          count: totalCrashes,
          ratePerSpawn: totalSpawns > 0 ? totalCrashes / totalSpawns : 0,
          lastObservedAt: latestWorkerValue(this.workers, "lastCrashAt")
            ? new Date(latestWorkerValue(this.workers, "lastCrashAt") as number).toISOString()
            : null
        },
        initialization
      },
      resumeEvidence: {
        available: resumableEvidence.filter(Boolean).length,
        unavailable: resumableEvidence.filter((value) => !value).length
      }
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
        "approval-policy": input.approvalPolicy,
        ephemeral: input.ephemeral === true
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
        requestArguments(input.prompt, input.selection, {
          ephemeral: input.ephemeral === true
        }),
        onProgress,
        (assignment) => {
          if (assignment.threadId) {
            this.threadWorkers.set(assignment.threadId, worker.index);
            this.threadResumeEvidence.set(assignment.threadId, true);
          }
          onAssigned?.(assignment);
        }
      );
      const threadId = structuredString(result, "threadId");
      if (threadId) {
        this.threadWorkers.set(threadId, worker.index);
        this.threadResumeEvidence.set(threadId, true);
      }
      return result;
    } finally {
      worker.activeCalls -= 1;
    }
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.withThreadWorker(threadId, (connection) => connection.archiveThread(threadId));
    this.threadWorkers.delete(threadId);
    this.threadResumeEvidence.set(threadId, false);
  }

  async restoreThread(threadId: string): Promise<void> {
    await this.withThreadWorker(threadId, (connection) => connection.restoreThread(threadId));
    this.threadResumeEvidence.set(threadId, true);
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

  canResumeThread(threadId: string): boolean | undefined {
    return this.threadResumeEvidence.get(threadId) ??
      (this.threadWorkers.has(threadId) ? true : undefined);
  }

  async probeThread(threadId: string): Promise<CodexThreadResumeProbe> {
    const preferredIndex = this.threadWorkers.get(threadId);
    const worker = preferredIndex === undefined ? this.leastBusyWorker() : this.workers[preferredIndex];
    worker.activeCalls += 1;
    try {
      const connection = await this.connectionFor(worker);
      const probe = await connection.probeThread(threadId);
      if (probe.state === "resumable" || probe.state === "busy") {
        this.threadWorkers.set(threadId, worker.index);
        this.threadResumeEvidence.set(threadId, true);
      } else if (probe.state === "orphaned") {
        this.threadWorkers.delete(threadId);
        this.threadResumeEvidence.set(threadId, false);
      }
      return probe;
    } catch {
      if (worker.connection?.exited) {
        worker.connection = undefined;
        this.forgetWorkerThreads(worker.index);
      }
      return { state: "unknown", reason: "transient", threadId, retryable: true };
    } finally {
      worker.activeCalls -= 1;
    }
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
        if (assignment.threadId) {
          this.threadWorkers.set(assignment.threadId, worker.index);
          this.threadResumeEvidence.set(assignment.threadId, true);
        }
        onAssigned?.(assignment);
      };
      const result = name === "codex"
        ? await connection.startThreadAndTurn(args, onProgress, assigned)
        : await connection.resumeThreadAndTurn(requestedThreadId as string, args, onProgress, assigned);
      const threadId = structuredString(result, "threadId");
      if (threadId) {
        this.threadWorkers.set(threadId, worker.index);
        this.threadResumeEvidence.set(threadId, true);
      }
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
    correlation: WorkerTerminationCorrelation,
    graceMs?: number
  ): Promise<JsonRpcTerminationResult> {
    assertWorkerTerminationCorrelation(correlation);
    const worker = this.workers.find((candidate) => `app-${candidate.index}` === assignment.workerId);
    if (!worker || !worker.connection || worker.generation !== assignment.workerGeneration) {
      throw new Error("The selected App Server worker generation is no longer active.");
    }
    const result = await worker.connection.interruptOrTerminate(assignment, correlation, graceMs);
    if (result.workerExited) {
      worker.connection = undefined;
      this.forgetWorkerThreads(worker.index);
    }
    return result;
  }

  async respondToInteraction(
    interactionId: string,
    response: { decision?: CodexInteractionDecision; answers?: Record<string, string[]> }
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
    this.threadResumeEvidence.clear();
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
        const startupStartedAt = Date.now();
        worker.spawnCount += 1;
        const connection = AppServerConnection.spawn(
          this.codexCommand,
          `app-${worker.index}`,
          generation,
          {
            ...this.protocolOptions,
            onLateResponse: (response) => this.onWorkerLateResponse(worker, response)
          },
          (observation) => this.onWorkerExit(worker, observation)
        );
        worker.startingConnection = connection;
        worker.connecting = connection.initializeForAdmission().then(async (initialized) => {
          if (this.closing) {
            await initialized.close();
            throw new Error("Codex App Server upstream closed during worker startup.");
          }
          const startupLatencyMs = Math.max(0, Date.now() - startupStartedAt);
          worker.startupSamples += 1;
          worker.startupLatencyTotalMs += startupLatencyMs;
          worker.lastStartupLatencyMs = startupLatencyMs;
          worker.lastStartupAt = Date.now();
          worker.maxStartupLatencyMs = Math.max(worker.maxStartupLatencyMs, startupLatencyMs);
          worker.connection = initialized;
          return initialized;
        }).catch((error) => {
          if (!this.closing) worker.startupFailureCount += 1;
          throw error;
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
      if (threadId) {
        this.threadWorkers.set(threadId, worker.index);
        this.threadResumeEvidence.set(threadId, true);
      }
    }
    this.protocolOptions.onLateResponse?.(response);
  }

  private onWorkerExit(worker: AppWorker, observation: WorkerExitObservation): void {
    if (worker.generation !== observation.generation) return;
    if (!observation.expected && !this.closing) {
      worker.crashCount += 1;
      worker.lastCrashAt = Date.now();
    }
    if (worker.connection?.exited) worker.connection = undefined;
    this.forgetWorkerThreads(worker.index);
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
  private readonly threadLineage = new Map<string, CodexThreadLineage>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly terminalTurns = new Set<string>();
  private readonly mcpStartupStates = new Map<string, "starting" | "ready" | "failed" | "cancelled">();
  private initializedAt?: number;
  private configWarningCount = 0;
  private closeRequested = false;
  private terminationRequested = false;

  private constructor(
    command: string,
    private readonly workerId: string,
    private readonly generation: number,
    private readonly protocolOptions: ResolvedCodexAppServerProtocolOptions,
    private readonly onExitObserved: (observation: WorkerExitObservation) => void
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
    protocolOptions: ResolvedCodexAppServerProtocolOptions,
    onExitObserved: (observation: WorkerExitObservation) => void
  ): AppServerConnection {
    return new AppServerConnection(
      command,
      workerId,
      generation,
      protocolOptions,
      onExitObserved
    );
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

  get identity(): JsonRpcProcessIdentity | undefined {
    return this.rpc.identity;
  }

  get initializationHealth(): AppServerInitializationHealth {
    const statuses = [...this.mcpStartupStates.values()];
    return {
      protocol: this.initializedAt ? "ready" : "starting",
      config: this.initializedAt
        ? this.configWarningCount > 0 ? "warning" : "ready"
        : "starting",
      configWarningCount: this.configWarningCount,
      mcpServers: {
        observed: statuses.length,
        starting: statuses.filter((status) => status === "starting").length,
        ready: statuses.filter((status) => status === "ready").length,
        failed: statuses.filter((status) => status === "failed").length,
        cancelled: statuses.filter((status) => status === "cancelled").length,
        unobserved: statuses.length === 0
      }
    };
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
        ephemeral: args.ephemeral === true
      },
      { timeoutMs: this.protocolOptions.requestTimeoutMs }
    );
    const thread = isRecord(response.thread) ? response.thread : undefined;
    const threadId = requiredString(thread?.id, "thread/start thread.id");
    const lineage = threadLineage(thread);
    this.loadedThreads.add(threadId);
    this.threadLineage.set(threadId, lineage);
    // Record the thread identity before turn/start. Durable threads can be
    // resumed after a worker exit; ephemeral threads remain correlated for
    // diagnostics but may become orphaned when their worker disappears.
    onAssigned?.(this.workerAssignment(threadId));
    return this.startTurn(
      threadId,
      requiredString(args.prompt, "prompt"),
      args,
      onProgress,
      onAssigned,
      lineage
    );
  }

  async resumeThreadAndTurn(
    threadId: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const lineage = await this.ensureThreadLoaded(threadId);
    return this.startTurn(
      threadId,
      requiredString(args.prompt, "prompt"),
      args,
      onProgress,
      onAssigned,
      lineage
    );
  }

  async forkThreadAndTurn(
    sourceThreadId: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/fork",
      { threadId: sourceThreadId, ephemeral: args.ephemeral === true },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { sourceThreadId }
      }
    );
    const thread = isRecord(response.thread) ? response.thread : undefined;
    const threadId = requiredString(thread?.id, "thread/fork thread.id");
    const lineage = threadLineage(thread, sourceThreadId);
    this.loadedThreads.add(threadId);
    this.threadLineage.set(threadId, lineage);
    onAssigned?.(this.workerAssignment(threadId));
    return this.startTurn(
      threadId,
      requiredString(args.prompt, "prompt"),
      args,
      onProgress,
      onAssigned,
      lineage
    );
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

  async probeThread(threadId: string): Promise<CodexThreadResumeProbe> {
    try {
      const response = await this.rpc.request<Record<string, unknown>>(
        "thread/read",
        { threadId, includeTurns: false },
        {
          timeoutMs: this.protocolOptions.requestTimeoutMs,
          lateResponseContext: { threadId }
        }
      );
      const thread = isRecord(response.thread) ? response.thread : undefined;
      if (!thread || thread.id !== threadId || !isRecord(thread.status)) {
        return { state: "unknown", reason: "unsupported", threadId, retryable: true };
      }
      const runtimeStatus = thread.status.type;
      if (runtimeStatus === "notLoaded" || runtimeStatus === "idle") {
        return { state: "resumable", runtimeStatus, threadId, ...threadLineage(thread) };
      }
      if (runtimeStatus === "active") {
        return { state: "busy", runtimeStatus, threadId, retryable: true, ...threadLineage(thread) };
      }
      if (runtimeStatus === "systemError") {
        return { state: "orphaned", reason: "system-error", threadId, retryable: false };
      }
      return { state: "unknown", reason: "unsupported", threadId, retryable: true };
    } catch (error) {
      if (isMissingThreadError(error)) {
        return { state: "orphaned", reason: "missing", threadId, retryable: false };
      }
      if (isUnsupportedThreadReadError(error)) {
        return { state: "unknown", reason: "unsupported", threadId, retryable: true };
      }
      return { state: "unknown", reason: "transient", threadId, retryable: true };
    }
  }

  private async ensureThreadLoaded(threadId: string): Promise<CodexThreadLineage> {
    if (this.loadedThreads.has(threadId)) return this.threadLineage.get(threadId) || {};
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/resume",
      { threadId },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId }
      }
    );
    const thread = isRecord(response.thread) ? response.thread : undefined;
    if (!thread || thread.id !== threadId) {
      throw new Error("Codex App Server resumed a different thread than requested.");
    }
    const lineage = threadLineage(thread);
    this.loadedThreads.add(threadId);
    this.threadLineage.set(threadId, lineage);
    return lineage;
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
    response: { decision?: CodexInteractionDecision; answers?: Record<string, string[]> }
  ): boolean {
    const pending = this.pendingInteractions.get(interactionId);
    if (!pending) return false;
    if (pending.answered) throw new Error("This Codex interaction response was already submitted.");
    if (pending.kind === "user-input") {
      if (!response.answers) throw new Error("User-input interaction requires answers.");
      pending.answered = true;
      if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
      pending.resolve({
        answers: Object.fromEntries(
          Object.entries(response.answers).map(([key, answers]) => [key, { answers }])
        )
      });
    } else {
      if (!response.decision) throw new Error("Approval interaction requires a decision.");
      if (
        pending.availableDecisions &&
        !pending.availableDecisions.includes(response.decision)
      ) {
        throw new Error("The selected decision is not available for this Codex approval request.");
      }
      pending.answered = true;
      if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
      if (pending.kind === "permission-approval") {
        const requested = isRecord(pending.requestParams.permissions)
          ? pending.requestParams.permissions
          : {};
        pending.resolve({
          permissions:
            response.decision === "accept" || response.decision === "acceptForSession"
              ? grantedPermissions(requested)
              : {},
          scope: response.decision === "acceptForSession" ? "session" : "turn"
        });
      } else {
        pending.resolve({ decision: response.decision || "decline" });
      }
    }
    return true;
  }

  async interruptOrTerminate(
    assignment: UpstreamWorkerAssignment,
    correlation: WorkerTerminationCorrelation,
    graceMs = 1_500
  ): Promise<JsonRpcTerminationResult> {
    assertWorkerTerminationCorrelation(correlation);
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
        this.emit(context, {
          eventId: `turn-interrupt:${turnId}:${correlation.kind}`,
          type: "turn",
          phase: "updated",
          createdAt: Date.now(),
          summary: "A correlated bridge interruption was dispatched.",
          details: correlation.kind === "cancellation-intent"
            ? {
                evidence: "bridge-turn-interrupt",
                cause: correlation.kind,
                cancellationIntentId: correlation.intentId,
                cancellationRequestId: correlation.requestId,
                cancellationSource: correlation.source,
                reasonCode: correlation.reasonCode
              }
            : {
                evidence: "bridge-turn-interrupt",
                cause: correlation.kind,
                correlationId: correlation.correlationId,
                reasonCode: correlation.reasonCode
              }
        });
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
    this.terminationRequested = true;
    return this.rpc.forceTerminate(graceMs);
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    for (const pending of this.pendingInteractions.values()) {
      if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
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
    this.initializedAt = Date.now();
  }

  private async startTurn(
    threadId: string,
    prompt: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void,
    lineage: CodexThreadLineage = this.threadLineage.get(threadId) || {}
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
      lineage,
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
    const assignment = this.workerAssignment(threadId, turnId);
    try {
      onAssigned?.(assignment);
    } catch (error) {
      const containmentCorrelation = {
        kind: "assignment-containment" as const,
        correlationId: randomUUID(),
        reasonCode: "assignment-persistence-failed" as const
      };
      try {
        // Keep the TurnContext and per-thread lock until terminal evidence is
        // observed. interruptOrTerminate waits for turn/completed and falls
        // back to terminating the worker process when confirmation is absent.
        await this.interruptOrTerminate(assignment, containmentCorrelation);
      } catch {
        // A missing process identity is the only expected helper failure. Make
        // one direct containment attempt while preserving the originating
        // assignment-persistence error for the caller.
        try {
          this.terminationRequested = true;
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
      details: {
        threadId,
        turnId,
        selection: {
          model: optionalString(args.model) || null,
          reasoningEffort: modelReasoningEffort(args.config) || null,
          serviceTier: optionalString(args.serviceTier) || null
        },
        evidence: "turn/start-accepted"
      }
    });
    return done;
  }

  private workerAssignment(
    threadId: string,
    upstreamRequestId?: string
  ): UpstreamWorkerAssignment {
    const identity = this.rpc.identity;
    return {
      backendKind: "app-server",
      workerId: this.workerId,
      workerGeneration: this.generation,
      ...(identity ? { workerPid: identity.pid } : {}),
      ...(identity?.processGroupId !== null && identity?.processGroupId !== undefined
        ? { processGroupId: identity.processGroupId }
        : {}),
      ...(upstreamRequestId ? { upstreamRequestId } : {}),
      threadId
    };
  }

  private onNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    if (method === "configWarning") this.configWarningCount += 1;
    if (method === "mcpServer/startupStatus/updated") {
      const name = optionalString(params.name)?.slice(0, 200);
      const status = params.status;
      if (
        name &&
        (status === "starting" || status === "ready" || status === "failed" || status === "cancelled")
      ) {
        this.mcpStartupStates.set(name, status);
      }
    }
    if (method === "serverRequest/resolved") {
      this.resolvePendingServerRequest(params, "server-resolved");
      return;
    }
    if (REASONING_NOTIFICATIONS.includes(method)) return;
    const threadId = optionalString(params.threadId);
    const turnId = optionalString(params.turnId) ||
      (isRecord(params.turn) ? optionalString(params.turn.id) : undefined) ||
      (threadId ? this.threadTurns.get(threadId) : undefined);
    const context = turnId ? this.activeTurns.get(turnId) : undefined;
    const protocolEvent = publicNotificationEvent(method, params);
    if (!context && protocolEvent && isGlobalProtocolNotice(method)) {
      for (const active of this.activeTurns.values()) {
        const globalEvent = publicNotificationEvent(method, params);
        if (globalEvent) this.emit(active, globalEvent);
      }
      return;
    }
    if (!context) return;
    if (protocolEvent) {
      this.emit(context, protocolEvent);
      return;
    }
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

  private resolvePendingServerRequest(
    params: Record<string, unknown>,
    resolution: "server-resolved" | "expired"
  ): void {
    const requestId = params.requestId;
    const threadId = optionalString(params.threadId);
    if ((typeof requestId !== "string" && typeof requestId !== "number") || !threadId) return;
    const match = [...this.pendingInteractions.entries()].find(([, pending]) =>
      String(pending.requestId) === String(requestId) && pending.threadId === threadId
    );
    if (!match) return;
    const [interactionId, pending] = match;
    this.pendingInteractions.delete(interactionId);
    if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
    if (!pending.answered) pending.reject(new JsonRpcServerRequestResolved());
    const context = this.activeTurns.get(pending.turnId);
    if (!context) return;
    const summary = resolution === "expired"
      ? `${pending.kind} expired before a response was submitted.`
      : `${pending.kind} was resolved by the App Server.`;
    this.emit(
      context,
      event(
        pending.kind === "user-input" ? "input-required" : "approval-required",
        "completed",
        summary,
        { resolvedInteractionId: interactionId, resolution }
      )
    );
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
      ? params.questions.filter(isRecord).slice(0, MAX_CODEX_INTERACTION_QUESTIONS).map((question) => ({
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
      ? `Command approval required: ${(optionalString(params.command) || "command").slice(0, 500)}${
          optionalString(params.reason) ? ` — ${optionalString(params.reason)!.slice(0, 300)}` : ""
        }`
      : kind === "file-approval"
        ? `File-change approval required.${
            optionalString(params.reason) ? ` ${optionalString(params.reason)!.slice(0, 300)}` : ""
          }`
        : kind === "permission-approval"
          ? `Additional permission approval required: ${(optionalString(params.reason) || "Codex requested additional access.").slice(0, 500)}`
          : "Codex requires user input.";
    const reason = optionalString(params.reason)?.slice(0, 500);
    const cwdLabel = safePathLabel(params.cwd);
    const grantRootLabel = safePathLabel(params.grantRoot);
    const availableDecisions = interactionDecisions(kind, params);
    const autoResolutionMs = readAutoResolutionMs(params.autoResolutionMs);
    const expiresAt = typeof autoResolutionMs === "number"
      ? Date.now() + autoResolutionMs
      : autoResolutionMs === null
        ? null
        : undefined;
    const networkContext = readNetworkContext(params.networkApprovalContext);
    const commandActions = readCommandActions(params.commandActions);
    const proposedAmendments = readProposedAmendments(params);
    const requestedPermissions = readRequestedPermissions(
      kind === "command-approval" ? params.additionalPermissions : params.permissions
    );
    const interaction: CodexPendingInteraction = {
      interactionId,
      kind,
      threadId,
      turnId,
      itemId,
      summary,
      ...(reason ? { reason } : {}),
      ...(cwdLabel ? { cwdLabel } : {}),
      ...(grantRootLabel ? { grantRootLabel } : {}),
      ...(availableDecisions ? { availableDecisions } : {}),
      ...(autoResolutionMs !== undefined ? { autoResolutionMs } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(networkContext ? { networkContext } : {}),
      ...(commandActions ? { commandActions } : {}),
      ...(proposedAmendments ? { proposedAmendments } : {}),
      ...(requestedPermissions ? { requestedPermissions } : {}),
      ...(questions ? { questions } : {})
    };
    let resolveInteraction!: (result: unknown) => void;
    let rejectInteraction!: (error: Error) => void;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      resolveInteraction = resolve;
      rejectInteraction = reject;
    });
    const pending: PendingInteraction = {
      ...interaction,
      requestId,
      method,
      requestParams: params,
      resolve: resolveInteraction,
      reject: rejectInteraction,
      answered: false
    };
    if (typeof autoResolutionMs === "number") {
      pending.autoResolutionTimer = setTimeout(() => {
        this.resolvePendingServerRequest(
          { requestId, threadId },
          "expired"
        );
      }, autoResolutionMs);
      pending.autoResolutionTimer.unref?.();
    }
    this.pendingInteractions.set(interactionId, pending);
    try {
      this.emit(
        context,
        event(
          kind === "user-input" ? "input-required" : "approval-required",
          "waiting",
          summary,
          { interaction }
        )
      );
    } catch (error) {
      this.pendingInteractions.delete(interactionId);
      if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
      rejectInteraction(error instanceof Error ? error : new Error(String(error)));
    }
    return responsePromise;
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
      if (interaction.autoResolutionTimer) clearTimeout(interaction.autoResolutionTimer);
      interaction.reject(new Error("Codex turn ended before the pending interaction was answered."));
      this.pendingInteractions.delete(interactionId);
    }
    const errorMessage = isRecord(turn.error)
      ? optionalString(turn.error.message) || JSON.stringify(turn.error).slice(0, 1_000)
      : undefined;
    const failure = status === "failed" ? classifyTurnFailure(turn.error, errorMessage) : undefined;
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
        backendKind: "app-server",
        ...context.lineage,
        ...(failure ? { error: failure } : {})
      }
    });
  }

  private onProcessExit(error: Error): void {
    const expected = this.closeRequested || this.terminationRequested;
    const terminalError = expected
      ? error
      : new Error("CODEX_WORKER_LOST: The Codex App Server worker exited during an active turn.");
    for (const interaction of this.pendingInteractions.values()) {
      if (interaction.autoResolutionTimer) clearTimeout(interaction.autoResolutionTimer);
      interaction.reject(terminalError);
    }
    this.pendingInteractions.clear();
    for (const context of this.activeTurns.values()) context.reject(terminalError);
    this.activeTurns.clear();
    this.threadTurns.clear();
    this.onExitObserved({
      generation: this.generation,
      expected
    });
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

function metricAggregate(values: number[]): {
  samples: number;
  total: number | null;
  average: number | null;
  max: number | null;
} {
  if (values.length === 0) return { samples: 0, total: null, average: null, max: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    total,
    average: Math.round(total / values.length),
    max: Math.max(...values)
  };
}

function latestWorkerValue(
  workers: AppWorker[],
  key: "lastCrashAt"
): number | null {
  const values = workers.flatMap((worker) => worker[key] === undefined ? [] : [worker[key] as number]);
  return values.length > 0 ? Math.max(...values) : null;
}

function latestStartupLatency(workers: AppWorker[]): number | null {
  const latest = workers
    .filter((worker) => worker.lastStartupAt !== undefined && worker.lastStartupLatencyMs !== undefined)
    .sort((left, right) => (right.lastStartupAt as number) - (left.lastStartupAt as number))[0];
  return latest?.lastStartupLatencyMs ?? null;
}

function aggregateInitializationHealth(
  workers: AppServerInitializationHealth[]
): Record<string, unknown> {
  return {
    protocol: {
      ready: workers.filter((worker) => worker.protocol === "ready").length,
      starting: workers.filter((worker) => worker.protocol === "starting").length
    },
    config: {
      ready: workers.filter((worker) => worker.config === "ready").length,
      warning: workers.filter((worker) => worker.config === "warning").length,
      starting: workers.filter((worker) => worker.config === "starting").length,
      warningCount: workers.reduce((total, worker) => total + worker.configWarningCount, 0)
    },
    mcpServers: {
      observed: workers.reduce((total, worker) => total + worker.mcpServers.observed, 0),
      starting: workers.reduce((total, worker) => total + worker.mcpServers.starting, 0),
      ready: workers.reduce((total, worker) => total + worker.mcpServers.ready, 0),
      failed: workers.reduce((total, worker) => total + worker.mcpServers.failed, 0),
      cancelled: workers.reduce((total, worker) => total + worker.mcpServers.cancelled, 0),
      unobservedWorkers: workers.filter((worker) => worker.mcpServers.unobserved).length
    }
  };
}

async function defaultWorkerMetricsProbe(pid: number): Promise<WorkerProcessMetrics> {
  const rss = readWorkerRssKb(pid);
  const fds = readWorkerFdCount(pid);
  const [rssResult, fdResult] = await Promise.allSettled([rss, fds]);
  const metrics: WorkerProcessMetrics = {
    ...(rssResult.status === "fulfilled" ? { rssKb: rssResult.value } : {}),
    ...(fdResult.status === "fulfilled" ? { fdCount: fdResult.value } : {})
  };
  if (metrics.rssKb === undefined && metrics.fdCount === undefined) {
    throw new Error("Worker process metrics are unavailable on this platform.");
  }
  return metrics;
}

async function readWorkerRssKb(pid: number): Promise<number> {
  if (process.platform === "win32") throw new Error("RSS probing is unavailable on Windows.");
  const output = await execFileText("ps", ["-o", "rss=", "-p", String(pid)]);
  const value = Number.parseInt(output.trim(), 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid worker RSS sample.");
  return value;
}

async function readWorkerFdCount(pid: number): Promise<number> {
  if (process.platform === "linux") {
    return (await readdir(`/proc/${pid}/fd`)).length;
  }
  if (process.platform === "win32") throw new Error("FD probing is unavailable on Windows.");
  const output = await execFileText("lsof", ["-a", "-p", String(pid), "-Fn"]);
  return output.split(/\r?\n/).filter((line) => /^f\d/.test(line)).length;
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 1_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

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

function threadLineage(
  thread: Record<string, unknown> | undefined,
  fallbackForkedFromThreadId?: string
): CodexThreadLineage {
  const sessionId = optionalString(thread?.sessionId)?.slice(0, 200);
  const forkedFromThreadId = (
    optionalString(thread?.forkedFromId) ||
    // Accept the early fixture/preview spelling while the supported official
    // protocol remains forkedFromId.
    optionalString(thread?.forkedFromThreadId) ||
    fallbackForkedFromThreadId
  )?.slice(0, 200);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(forkedFromThreadId ? { forkedFromThreadId } : {})
  };
}

function classifyTurnFailure(
  value: unknown,
  fallbackMessage?: string
): {
  code: string;
  message: string;
  retryable: boolean;
  upstreamKind: string;
  nextActions: string[];
} {
  const error = isRecord(value) ? value : {};
  const info = error.codexErrorInfo;
  const upstreamKind = typeof info === "string"
    ? info
    : isRecord(info)
      ? Object.keys(info)[0] || "other"
      : "other";
  const message = (
    optionalString(error.message) ||
    fallbackMessage ||
    "Codex App Server reported a failed turn."
  ).slice(0, 1_000);
  if (upstreamKind === "contextWindowExceeded") {
    return {
      code: "CONTEXT_WINDOW_EXCEEDED",
      message,
      retryable: true,
      upstreamKind,
      nextActions: [
        "Retry with a smaller task or less attached context.",
        "Start context='fresh' and provide an explicit concise handoffSummary; prior transcript context is not copied.",
        "If policy permits, explicitly select a model with a larger context window. The bridge will not downgrade or reroute silently."
      ]
    };
  }
  const transient = new Set([
    "serverOverloaded",
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
    "internalServerError"
  ]).has(upstreamKind);
  return {
    code: transient ? "UPSTREAM_TEMPORARILY_UNAVAILABLE" : "UPSTREAM_TURN_FAILED",
    message,
    retryable: transient,
    upstreamKind,
    nextActions: transient
      ? ["Retry the same idempotent request after upstream service recovery."]
      : ["Inspect the public error metadata, correct the request or credentials, and retry with a new requestId."]
  };
}

function publicNotificationEvent(
  method: string,
  params: Record<string, unknown>
): CodexPublicEvent | undefined {
  if (method === "error") {
    const error = isRecord(params.error) ? params.error : undefined;
    const message = optionalString(error?.message)?.slice(0, 1_000) || "Codex reported a turn error.";
    return event("error", "updated", message, {
      willRetry: params.willRetry === true,
      hasAdditionalDetails: Boolean(optionalString(error?.additionalDetails))
    });
  }
  if (method === "warning" || method === "guardianWarning") {
    return event(
      "warning",
      "updated",
      (optionalString(params.message) || "Codex reported a warning.").slice(0, 1_000),
      { source: method }
    );
  }
  if (method === "configWarning" || method === "deprecationNotice") {
    const summary = (optionalString(params.summary) || "Codex reported a configuration notice.").slice(0, 1_000);
    return event("warning", "updated", summary, {
      source: method,
      details: optionalString(params.details)?.slice(0, 1_000) || null,
      ...(method === "configWarning" && params.path ? { pathLabel: safePathLabel(params.path) || null } : {})
    });
  }
  if (method === "model/rerouted") {
    const fromModel = optionalString(params.fromModel)?.slice(0, 120) || "unknown";
    const toModel = optionalString(params.toModel)?.slice(0, 120) || "unknown";
    const reason = optionalString(params.reason)?.slice(0, 200) || "unspecified";
    return event("model", "updated", `Model rerouted from ${fromModel} to ${toModel}.`, {
      kind: "rerouted",
      fromModel,
      toModel,
      reason
    });
  }
  if (method === "model/verification") {
    const verifications = Array.isArray(params.verifications)
      ? params.verifications
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 20)
          .map((entry) => entry.slice(0, 200))
      : [];
    return event("model", "updated", "Model verification state changed.", {
      kind: "verification",
      verifications
    });
  }
  if (method === "model/safetyBuffering/updated") {
    const model = optionalString(params.model)?.slice(0, 120) || "unknown";
    return event("model", "updated", `Safety buffering state changed for ${model}.`, {
      kind: "safety-buffering",
      model,
      showBufferingUi: params.showBufferingUi === true,
      fasterModel: optionalString(params.fasterModel)?.slice(0, 120) || null,
      useCases: boundedStringArray(params.useCases, 20, 200),
      reasons: boundedStringArray(params.reasons, 20, 300)
    });
  }
  if (method === "thread/compacted") {
    return event("context", "completed", "Codex compacted the thread context.", {
      kind: "compaction"
    });
  }
  if (method === "item/mcpToolCall/progress") {
    return event(
      "mcp",
      "updated",
      "MCP tool call progressed.",
      { itemId: optionalString(params.itemId)?.slice(0, 200) || null }
    );
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = isRecord(params.tokenUsage) ? params.tokenUsage : {};
    return event("usage", "updated", "Codex token usage updated.", {
      total: readTokenUsageBreakdown(usage.total),
      last: readTokenUsageBreakdown(usage.last),
      modelContextWindow:
        typeof usage.modelContextWindow === "number" && Number.isFinite(usage.modelContextWindow)
          ? Math.max(0, Math.trunc(usage.modelContextWindow))
          : null
    });
  }
  return undefined;
}

function isGlobalProtocolNotice(method: string): boolean {
  return method === "warning" || method === "configWarning" || method === "deprecationNotice";
}

function boundedStringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, maxItems)
        .map((entry) => entry.slice(0, maxChars))
    : [];
}

function readTokenUsageBreakdown(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const keys = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens"
  ];
  const entries = keys.flatMap((key) =>
    typeof value[key] === "number" && Number.isFinite(value[key])
      ? [[key, Math.max(0, Math.trunc(value[key]))] as const]
      : []
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
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
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const server = item.type === "mcpToolCall"
      ? optionalString(item.server)?.slice(0, 120) || "MCP"
      : optionalString(item.namespace)?.slice(0, 120) || "dynamic";
    const tool = optionalString(item.tool)?.slice(0, 160) || "tool";
    const errorMessage = isRecord(item.error)
      ? optionalString(item.error.message)?.slice(0, 1_000) || null
      : null;
    return event("mcp", phase, `${server}.${tool} ${phase}.`, {
      itemId,
      server,
      tool,
      status: optionalString(item.status)?.slice(0, 80) || null,
      durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
      error: errorMessage
    });
  }
  if (item.type === "collabAgentToolCall") {
    const tool = optionalString(item.tool)?.slice(0, 80) || "collaboration";
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 30)
          .map((entry) => entry.slice(0, 200))
      : [];
    return event("collaboration", phase, `Collaboration ${tool} ${phase}.`, {
      itemId,
      tool,
      status: optionalString(item.status)?.slice(0, 80) || null,
      receiverThreadIds: receivers,
      model: optionalString(item.model)?.slice(0, 120) || null,
      reasoningEffort: optionalString(item.reasoningEffort)?.slice(0, 80) || null
    });
  }
  if (item.type === "subAgentActivity") {
    return event("collaboration", phase, `Sub-agent activity ${phase}.`, {
      itemId,
      kind: optionalString(item.kind)?.slice(0, 120) || "unknown",
      agentThreadId: optionalString(item.agentThreadId)?.slice(0, 200) || null
    });
  }
  if (item.type === "contextCompaction") {
    return event("context", phase, `Context compaction ${phase}.`, { itemId });
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

function interactionDecisions(
  kind: CodexPendingInteraction["kind"],
  params: Record<string, unknown>
): CodexInteractionDecision[] | undefined {
  if (kind === "user-input") return undefined;
  if (kind === "command-approval" && Array.isArray(params.availableDecisions)) {
    return [...new Set(params.availableDecisions.filter(isInteractionDecision))];
  }
  return ["accept", "acceptForSession", "decline", "cancel"];
}

function isInteractionDecision(value: unknown): value is CodexInteractionDecision {
  return value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel";
}

function readAutoResolutionMs(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_JSON_RPC_TIMEOUT_MS
    ? value
    : undefined;
}

function safePathLabel(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  const label = path.basename(raw).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (label || path.parse(raw).root || "filesystem root").slice(0, 200);
}

function readNetworkContext(
  value: unknown
): CodexPendingInteraction["networkContext"] | undefined {
  if (!isRecord(value)) return undefined;
  const host = optionalString(value.host)?.slice(0, 253);
  const protocol = value.protocol;
  if (
    !host ||
    (protocol !== "http" &&
      protocol !== "https" &&
      protocol !== "socks5Tcp" &&
      protocol !== "socks5Udp")
  ) {
    return undefined;
  }
  return { host, protocol };
}

function readCommandActions(
  value: unknown
): CodexPendingInteraction["commandActions"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.filter(isRecord).slice(0, 20).flatMap((action) => {
    const type = action.type;
    if (type !== "read" && type !== "listFiles" && type !== "search" && type !== "unknown") {
      return [];
    }
    const command = optionalString(action.command)?.slice(0, 500);
    if (!command) return [];
    const pathLabel = safePathLabel(action.path);
    const name = optionalString(action.name)?.slice(0, 120);
    const query = optionalString(action.query)?.slice(0, 300);
    return [{
      type,
      command,
      ...(name ? { name } : {}),
      ...(pathLabel ? { pathLabel } : {}),
      ...(query ? { query } : {})
    }];
  });
  return actions.length > 0 ? actions : undefined;
}

function readProposedAmendments(
  params: Record<string, unknown>
): CodexPendingInteraction["proposedAmendments"] | undefined {
  const execPolicy = Array.isArray(params.proposedExecpolicyAmendment)
    ? params.proposedExecpolicyAmendment
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 30)
        .map((entry) => entry.slice(0, 300))
    : undefined;
  const networkPolicy = Array.isArray(params.proposedNetworkPolicyAmendments)
    ? params.proposedNetworkPolicyAmendments.filter(isRecord).slice(0, 20).flatMap((entry) => {
        const host = optionalString(entry.host)?.slice(0, 253);
        const action = entry.action;
        return host && (action === "allow" || action === "deny") ? [{ host, action }] : [];
      })
    : undefined;
  return execPolicy?.length || networkPolicy?.length
    ? {
        ...(execPolicy?.length ? { execPolicy } : {}),
        ...(networkPolicy?.length ? { networkPolicy } : {})
      }
    : undefined;
}

function readRequestedPermissions(
  value: unknown
): CodexPendingInteraction["requestedPermissions"] | undefined {
  if (!isRecord(value)) return undefined;
  const network = isRecord(value.network) ? value.network : undefined;
  const fileSystem = isRecord(value.fileSystem) ? value.fileSystem : undefined;
  const filesystemRead = Array.isArray(fileSystem?.read)
    ? fileSystem.read.map(safePathLabel).filter((entry): entry is string => Boolean(entry)).slice(0, 50)
    : undefined;
  const filesystemWrite = Array.isArray(fileSystem?.write)
    ? fileSystem.write.map(safePathLabel).filter((entry): entry is string => Boolean(entry)).slice(0, 50)
    : undefined;
  const networkEnabled = network?.enabled;
  const filesystemEntries = Array.isArray(fileSystem?.entries)
    ? Math.min(fileSystem.entries.length, 1_000)
    : undefined;
  if (
    networkEnabled !== true &&
    networkEnabled !== false &&
    networkEnabled !== null &&
    filesystemRead === undefined &&
    filesystemWrite === undefined &&
    filesystemEntries === undefined
  ) {
    return undefined;
  }
  return {
    ...(networkEnabled === true || networkEnabled === false || networkEnabled === null
      ? { networkEnabled }
      : {}),
    ...(filesystemRead !== undefined ? { filesystemRead } : {}),
    ...(filesystemWrite !== undefined ? { filesystemWrite } : {}),
    ...(filesystemEntries !== undefined ? { filesystemEntries } : {})
  };
}

function isMissingThreadError(error: unknown): boolean {
  if (!isRecord(error) || error.code !== -32000) return false;
  const message = typeof error.message === "string" ? error.message : "";
  return /\bthread\b.*\b(?:not found|missing|archived)\b/i.test(message);
}

function isUnsupportedThreadReadError(error: unknown): boolean {
  return isRecord(error) && error.code === -32601;
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
