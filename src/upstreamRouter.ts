import type { CodexBackendKind } from "./config.js";
import type { JsonRpcTerminationResult } from "./jsonRpcProcess.js";
import type { BackendCapabilities, ModelSelection } from "./modelPolicy.js";
import { backendSupports } from "./modelPolicy.js";
import type { WorkerTerminationCorrelation } from "./cancellation.js";
import type {
  CodexThreadContinueRequest,
  CodexThreadForkRequest,
  CodexThreadStartRequest,
  CodexBackgroundTerminal,
  CodexPendingInteraction,
  CodexInteractionDecision,
  CodexProgress,
  CodexThreadResumeProbe,
  CodexUpstream,
  CodexWeeklyUsage,
  ToolResult,
  UpstreamWorkerAssignment
} from "./upstream.js";

const INTERNAL_BACKEND_ARGUMENT = "_bridgeBackendKind";

/**
 * Keeps both Codex protocols available during migration. New threads use the
 * configured default, while every continuation is pinned to the backend that
 * created its thread. The routing hint is stripped before the request reaches
 * Codex.
 */
export class CodexBackendRouter implements CodexUpstream {
  accountRevision?: () => string;
  private readonly threadBackends = new Map<string, CodexBackendKind>();
  private readonly workerBackends = new Map<string, CodexBackendKind>();
  private readonly backends: ReadonlyMap<CodexBackendKind, CodexUpstream>;

  constructor(
    private readonly defaultBackend: CodexBackendKind,
    mcpOrRegistry: CodexUpstream | ReadonlyMap<CodexBackendKind, CodexUpstream>,
    appBackend?: CodexUpstream,
    sdkBackend?: CodexUpstream
  ) {
    this.backends = "callTool" in mcpOrRegistry
      ? new Map<CodexBackendKind, CodexUpstream>([["mcp-server", mcpOrRegistry],
          ...(appBackend ? [["app-server", appBackend] as const] : []),
          ...(sdkBackend ? [["codex-sdk", sdkBackend] as const] : [])])
      : new Map(mcpOrRegistry);
    if (!this.backends.has(defaultBackend)) throw new Error(`Codex backend ${defaultBackend} is not installed or enabled.`);
  }

  bindThread(threadId: string, backendKind: CodexBackendKind): void {
    this.threadBackends.set(threadId, backendKind);
  }

  async listTools(): Promise<unknown> {
    const entries = [...this.backends];
    const results = await Promise.allSettled(entries.map(([, backend]) => backend.listTools()));
    return {
      defaultBackend: this.defaultBackend,
      backends: Object.fromEntries(entries.map(([kind], index) => [kind, settledValue(results[index])]))
    };
  }

  capabilities(backendKind = this.defaultBackend): BackendCapabilities {
    return this.backend(backendKind).capabilities?.(backendKind) || defaultCapabilities(backendKind);
  }

  async listModels(backendKind = this.defaultBackend): Promise<unknown> {
    const backend = this.backend(backendKind);
    if (!backend.listModels) {
      throw new Error(`Codex backend ${backendKind} does not expose model/list.`);
    }
    return backend.listModels(backendKind);
  }

  async readAccountSnapshot() {
    return this.backend(this.defaultBackend === "mcp-server" ? "app-server" : this.defaultBackend).readAccountSnapshot?.() ?? null;
  }

  async readAccountRateLimits(): Promise<CodexWeeklyUsage | null> {
    // Account usage is exposed only by App Server and is independent of the
    // protocol selected for task execution.
    const backend = this.backend(this.defaultBackend === "mcp-server" ? "app-server" : this.defaultBackend);
    return backend.readAccountRateLimits?.() ?? null;
  }

  startThread(
    input: CodexThreadStartRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.callTool(
      "codex",
      {
        prompt: input.prompt,
        ...(input.backendKind === "codex-sdk" && input.contextId ? { _bridgeCodexContext: input.contextId } : {}),
        cwd: input.cwd,
        sandbox: input.sandbox,
        "approval-policy": input.approvalPolicy,
        ...(backendSupports(input.backendKind, "supportsEphemeralThreads")
          ? { ephemeral: input.ephemeral === true }
          : {}),
        ...selectionArguments(input.selection, input.backendKind),
        ...backendRoutingArgument(input.backendKind)
      },
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
      {
        threadId: input.threadId,
        prompt: input.prompt,
        ...(input.selection ? selectionArguments(input.selection, input.backendKind) : {}),
        ...backendRoutingArgument(input.backendKind)
      },
      onProgress,
      onAssigned
    );
  }

  async forkThread(
    input: CodexThreadForkRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const recorded = this.threadBackends.get(input.threadId);
    const kind = recorded || input.backendKind;
    if (recorded && recorded !== input.backendKind) {
      throw new Error(`Codex thread ${input.threadId} is pinned to backend ${recorded}, not ${input.backendKind}.`);
    }
    const backend = this.backend(kind);
    if (!backend.forkThread) throw new Error(`Codex backend ${kind} does not support thread fork.`);
    const result = await backend.forkThread(
      { ...input, backendKind: kind },
      onProgress,
      (assignment) => {
        this.workerBackends.set(assignment.workerId, kind);
        if (assignment.threadId) this.threadBackends.set(assignment.threadId, kind);
        onAssigned?.(assignment);
      }
    );
    const threadId = resultThreadId(result);
    if (threadId) this.threadBackends.set(threadId, kind);
    return result;
  }

  async archiveThread(threadId: string, backendKind?: CodexBackendKind): Promise<void> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind) throw new Error("The Agent thread backend is unknown.");
    const backend = this.backend(kind);
    if (!backend.archiveThread) return;
    await backend.archiveThread(threadId, kind);
  }

  async restoreThread(threadId: string, backendKind?: CodexBackendKind): Promise<void> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind) throw new Error("The Agent thread backend is unknown.");
    const backend = this.backend(kind);
    if (!backend.restoreThread) return;
    await backend.restoreThread(threadId, kind);
  }

  async listBackgroundTerminals(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexBackgroundTerminal[]> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind || !this.supports(kind, "supportsBackgroundTerminals")) return [];
    const backend = this.backend(kind);
    return backend.listBackgroundTerminals
      ? backend.listBackgroundTerminals(threadId, kind)
      : [];
  }

  async listLoadedBackgroundTerminals(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexBackgroundTerminal[] | null> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind || !this.supports(kind, "supportsBackgroundTerminals")) return null;
    const backend = this.backend(kind);
    return backend.listLoadedBackgroundTerminals
      ? backend.listLoadedBackgroundTerminals(threadId, kind)
      : null;
  }

  async terminateBackgroundTerminal(
    threadId: string,
    processId: string,
    backendKind?: CodexBackendKind
  ): Promise<{ terminated: boolean }> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind || !this.supports(kind, "supportsBackgroundTerminals")) {
      throw new Error("Background terminal control is available only for Codex App Server threads.");
    }
    const backend = this.backend(kind);
    if (!backend.terminateBackgroundTerminal) {
      throw new Error("The Codex App Server does not support background terminal control.");
    }
    return backend.terminateBackgroundTerminal(threadId, processId, kind);
  }

  canResumeThread(threadId: string, backendKind?: CodexBackendKind): boolean | undefined {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind) return undefined;
    return this.backend(kind).canResumeThread?.(threadId, kind);
  }

  async probeThread(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexThreadResumeProbe> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind) {
      return { state: "unknown", reason: "transient", threadId, retryable: true };
    }
    const backend = this.backend(kind);
    if (backend.probeThread) return backend.probeThread(threadId, kind);
    const resumable = backend.canResumeThread?.(threadId, kind);
    if (resumable === true) {
      return { state: "resumable", runtimeStatus: "idle", threadId };
    }
    if (resumable === false) {
      return { state: "orphaned", reason: "missing", threadId, retryable: false };
    }
    return { state: "unknown", reason: "transient", threadId, retryable: true };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const explicitKind = readBackendKind(args[INTERNAL_BACKEND_ARGUMENT]);
    const requestedThreadId = name === "codex-reply" && typeof args.threadId === "string"
      ? args.threadId
      : undefined;
    const kind = explicitKind || (requestedThreadId ? this.threadBackends.get(requestedThreadId) : undefined) || this.defaultBackend;
    if (requestedThreadId) {
      const recorded = this.threadBackends.get(requestedThreadId);
      if (recorded && recorded !== kind) {
        throw new Error(`Codex thread ${requestedThreadId} is pinned to backend ${recorded}, not ${kind}.`);
      }
    }
    const forwarded = { ...args };
    delete forwarded[INTERNAL_BACKEND_ARGUMENT];
    const result = await this.backend(kind).callTool(
      name,
      forwarded,
      onProgress,
      (assignment) => {
        this.workerBackends.set(assignment.workerId, kind);
        if (assignment.threadId) this.threadBackends.set(assignment.threadId, assignment.backendKind);
        onAssigned?.(assignment);
      }
    );
    const threadId = resultThreadId(result);
    if (threadId) this.threadBackends.set(threadId, kind);
    return result;
  }

  forceTerminateWorker(
    assignment: UpstreamWorkerAssignment,
    correlation: WorkerTerminationCorrelation,
    graceMs?: number
  ): Promise<JsonRpcTerminationResult> {
    const backend = this.backend(assignment.backendKind);
    if (!backend.forceTerminateWorker) {
      throw new Error(`Codex backend ${assignment.backendKind} does not support supervised force-stop.`);
    }
    return backend.forceTerminateWorker(assignment, correlation, graceMs);
  }

  async respondToInteraction(
    interactionId: string,
    response: { decision?: CodexInteractionDecision; answers?: Record<string, string[]> }
  ): Promise<void> {
    const workerId = interactionId.split(":")[0];
    const kind = this.workerBackends.get(workerId);
    if (!kind) throw new Error("The interaction's exact worker is no longer available.");
    const backend = this.backend(kind);
    if (!backend.respondToInteraction) throw new Error("Interaction handling is unavailable for this backend.");
    await backend.respondToInteraction(interactionId, response);
  }

  async steerThread(threadId: string, prompt: string): Promise<{ turnId: string }> {
    const kind = this.threadBackends.get(threadId);
    if (!kind || !this.supports(kind, "supportsSteering") || !this.backend(kind).steerThread) {
      throw new Error("Steering is available only for an active Codex App Server turn.");
    }
    return this.backend(kind).steerThread!(threadId, prompt);
  }

  canSteerThread(threadId: string): boolean {
    const kind = this.threadBackends.get(threadId);
    return !!kind && this.supports(kind, "supportsSteering") && this.backend(kind).canSteerThread?.(threadId) === true;
  }

  async close(): Promise<void> {
    this.threadBackends.clear();
    this.workerBackends.clear();
    await Promise.allSettled([...this.backends.values()].map(backend => backend.close()));
  }

  private backend(kind: CodexBackendKind): CodexUpstream {
    const backend = this.backends.get(kind);
    if (!backend) throw new Error(`Codex backend ${kind} is not installed or enabled. The thread was not moved to another backend.`);
    return backend;
  }

  private supports(kind: CodexBackendKind, feature: Parameters<typeof backendSupports>[1]): boolean {
    return this.capabilities(kind)[feature] ?? backendSupports(kind, feature);
  }
}

export function backendRoutingArgument(backendKind: CodexBackendKind): Record<string, unknown> {
  return { [INTERNAL_BACKEND_ARGUMENT]: backendKind };
}

function readBackendKind(value: unknown): CodexBackendKind | undefined {
  return value === "mcp-server" || value === "app-server" || value === "codex-sdk" ? value : undefined;
}

function resultThreadId(result: ToolResult): string | undefined {
  if (!result.structuredContent || typeof result.structuredContent !== "object") return undefined;
  const threadId = (result.structuredContent as Record<string, unknown>).threadId;
  return typeof threadId === "string" && threadId ? threadId : undefined;
}

function settledValue(result: PromiseSettledResult<unknown>): unknown {
  return result.status === "fulfilled"
    ? { available: true, tools: result.value }
    : { available: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}

function selectionArguments(
  selection: ModelSelection,
  backendKind: CodexBackendKind
): Record<string, unknown> {
  return {
    model: selection.model,
    config: {
      model_reasoning_effort: selection.reasoningEffort,
      ...(backendKind === "mcp-server" && selection.serviceTier
        ? { service_tier: selection.serviceTier }
        : {})
    },
    ...(backendKind !== "mcp-server" && selection.serviceTier
      ? { serviceTier: selection.serviceTier }
      : {})
  };
}

function defaultCapabilities(kind: CodexBackendKind): BackendCapabilities {
  return kind !== "mcp-server"
    ? {
        selectionScope: "turn",
        supportsModelOverrideOnContinue: true,
        supportsEffortOverrideOnContinue: true,
        supportsServiceTierOverrideOnContinue: true,
        supportsFork: true
      }
    : {
        selectionScope: "thread",
        supportsModelOverrideOnContinue: false,
        supportsEffortOverrideOnContinue: false,
        supportsServiceTierOverrideOnContinue: false,
        supportsFork: false
      };
}
