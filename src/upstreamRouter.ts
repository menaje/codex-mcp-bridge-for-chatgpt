import type { CodexBackendKind } from "./config.js";
import type { JsonRpcTerminationResult } from "./jsonRpcProcess.js";
import type { BackendCapabilities, ModelSelection } from "./modelPolicy.js";
import type {
  CodexThreadContinueRequest,
  CodexThreadStartRequest,
  CodexPendingInteraction,
  CodexProgress,
  CodexUpstream,
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
  private readonly threadBackends = new Map<string, CodexBackendKind>();

  constructor(
    private readonly defaultBackend: CodexBackendKind,
    private readonly mcpBackend: CodexUpstream,
    private readonly appBackend: CodexUpstream
  ) {}

  bindThread(threadId: string, backendKind: CodexBackendKind): void {
    this.threadBackends.set(threadId, backendKind);
  }

  async listTools(): Promise<unknown> {
    const [mcp, app] = await Promise.allSettled([
      this.mcpBackend.listTools(),
      this.appBackend.listTools()
    ]);
    return {
      defaultBackend: this.defaultBackend,
      backends: {
        "mcp-server": settledValue(mcp),
        "app-server": settledValue(app)
      }
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

  startThread(
    input: CodexThreadStartRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.callTool(
      "codex",
      {
        prompt: input.prompt,
        cwd: input.cwd,
        sandbox: input.sandbox,
        "approval-policy": input.approvalPolicy,
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

  canResumeThread(threadId: string, backendKind?: CodexBackendKind): boolean | undefined {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind) return undefined;
    return this.backend(kind).canResumeThread?.(threadId, kind);
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
    graceMs?: number
  ): Promise<JsonRpcTerminationResult> {
    const backend = this.backend(assignment.backendKind);
    if (!backend.forceTerminateWorker) {
      throw new Error(`Codex backend ${assignment.backendKind} does not support supervised force-stop.`);
    }
    return backend.forceTerminateWorker(assignment, graceMs);
  }

  async respondToInteraction(
    interactionId: string,
    response: { decision?: "accept" | "decline" | "cancel"; answers?: Record<string, string[]> }
  ): Promise<void> {
    if (!this.appBackend.respondToInteraction) throw new Error("App Server interaction handling is unavailable.");
    await this.appBackend.respondToInteraction(interactionId, response);
  }

  async steerThread(threadId: string, prompt: string): Promise<{ turnId: string }> {
    const kind = this.threadBackends.get(threadId);
    if (kind !== "app-server" || !this.appBackend.steerThread) {
      throw new Error("Steering is available only for an active Codex App Server turn.");
    }
    return this.appBackend.steerThread(threadId, prompt);
  }

  async close(): Promise<void> {
    this.threadBackends.clear();
    await Promise.allSettled([this.mcpBackend.close(), this.appBackend.close()]);
  }

  private backend(kind: CodexBackendKind): CodexUpstream {
    return kind === "app-server" ? this.appBackend : this.mcpBackend;
  }
}

export function backendRoutingArgument(backendKind: CodexBackendKind): Record<string, unknown> {
  return { [INTERNAL_BACKEND_ARGUMENT]: backendKind };
}

function readBackendKind(value: unknown): CodexBackendKind | undefined {
  return value === "mcp-server" || value === "app-server" ? value : undefined;
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
    ...(backendKind === "app-server" && selection.serviceTier
      ? { serviceTier: selection.serviceTier }
      : {})
  };
}

function defaultCapabilities(kind: CodexBackendKind): BackendCapabilities {
  return kind === "app-server"
    ? {
        selectionScope: "turn",
        supportsModelOverrideOnContinue: true,
        supportsEffortOverrideOnContinue: true,
        supportsServiceTierOverrideOnContinue: true,
        supportsFork: false
      }
    : {
        selectionScope: "thread",
        supportsModelOverrideOnContinue: false,
        supportsEffortOverrideOnContinue: false,
        supportsServiceTierOverrideOnContinue: false,
        supportsFork: false
      };
}
