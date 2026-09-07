import type { CallToolResult, Progress } from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalPolicy, CodexBackendKind, SandboxMode } from "./config.js";
import type { BackendCapabilities, ModelSelection } from "./modelPolicy.js";
import type { WorkerTerminationCorrelation } from "./cancellation.js";
import type { JsonRpcTerminationResult } from "./jsonRpcProcess.js";

export const MAX_CODEX_INTERACTION_QUESTIONS = 3;

export type ToolResult = CallToolResult;

export type CodexPublicEvent = {
  eventId: string;
  type:
    | "agent-message"
    | "plan"
    | "command"
    | "file-change"
    | "error"
    | "warning"
    | "model"
    | "context"
    | "mcp"
    | "collaboration"
    | "usage"
    | "approval-required"
    | "input-required"
    | "turn";
  phase: "started" | "updated" | "completed" | "waiting";
  createdAt: number;
  summary: string;
  details?: Record<string, unknown>;
};

export type CodexProgress = Progress & { event?: CodexPublicEvent };

export type CodexInteractionDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type CodexPendingInteraction = {
  interactionId: string;
  kind: "command-approval" | "file-approval" | "permission-approval" | "user-input";
  threadId: string;
  turnId: string;
  itemId: string;
  summary: string;
  reason?: string;
  cwdLabel?: string;
  grantRootLabel?: string;
  availableDecisions?: CodexInteractionDecision[];
  autoResolutionMs?: number | null;
  expiresAt?: number | null;
  networkContext?: {
    host: string;
    protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
  };
  commandActions?: Array<{
    type: "read" | "listFiles" | "search" | "unknown";
    command: string;
    name?: string;
    pathLabel?: string;
    query?: string;
  }>;
  proposedAmendments?: {
    execPolicy?: string[];
    networkPolicy?: Array<{ host: string; action: "allow" | "deny" }>;
  };
  requestedPermissions?: {
    networkEnabled?: boolean | null;
    filesystemRead?: string[];
    filesystemWrite?: string[];
    filesystemEntries?: number;
  };
  questions?: Array<{
    id: string;
    header: string;
    question: string;
    isSecret: boolean;
    options?: Array<{ label: string; description: string }>;
  }>;
};

export type CodexThreadLineage = {
  /** App Server session-tree identity reported by the upstream protocol. */
  sessionId?: string;
  /** Direct source thread reported when this thread was created by fork. */
  forkedFromThreadId?: string;
};

export type CodexThreadResumeProbe = (
  | {
      state: "resumable";
      runtimeStatus: "notLoaded" | "idle";
      threadId: string;
    }
  | {
      state: "busy";
      runtimeStatus: "active";
      threadId: string;
      retryable: true;
    }
  | {
      state: "orphaned";
      reason: "missing" | "system-error";
      threadId: string;
      retryable: false;
    }
  | {
      state: "unknown";
      reason: "unsupported" | "transient";
      threadId: string;
      retryable: true;
    }
) & CodexThreadLineage;

export type UpstreamWorkerAssignment = {
  backendKind: CodexBackendKind;
  runtime?: { sdk?: string; python?: string; codex: string; channel?: "stable";
    requestedAuthMode?: "chatgpt" | "api-key"; resolvedAuthMode?: "chatgpt" | "api-key" };
  workerId: string;
  workerGeneration: number;
  workerPid?: number;
  processGroupId?: number;
  upstreamRequestId?: string;
  threadId?: string;
  /** App Server session-tree identity known as soon as the thread is admitted. */
  sessionId?: string;
  /** Direct source thread when the admitted App Server thread is a fork. */
  forkedFromThreadId?: string;
};

export type CodexBackgroundTerminal = {
  processId: string;
  itemId: string;
  command: string;
  cwd: string;
  osPid?: number;
  cpuPercent?: number;
  rssKb?: number;
};

export type CodexThreadStartRequest = {
  backendKind: CodexBackendKind;
  prompt: string;
  cwd: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  selection: ModelSelection;
  /** App Server only: keep the new thread in memory instead of materializing it on disk. */
  contextId?: string;
  ephemeral?: boolean;
};

export type CodexThreadContinueRequest = {
  backendKind: CodexBackendKind;
  threadId: string;
  prompt: string;
  selection?: ModelSelection;
};

export type CodexThreadForkRequest = {
  backendKind: CodexBackendKind;
  threadId: string;
  prompt: string;
  selection?: ModelSelection;
  /** App Server only: keep the fork in memory instead of materializing it on disk. */
  contextId?: string;
  ephemeral?: boolean;
};

export type CodexWeeklyUsage = {
  /** App Server account rate-limit bucket, normally `codex`. */
  limitId: string;
  usedPercent: number;
  remainingPercent: number;
  /** The selected rolling-window duration. Weekly Codex usage is 10,080 minutes. */
  windowDurationMins: number;
  /** Unix timestamp in seconds, or null when the upstream omits the reset time. */
  resetsAt: number | null;
  /** Local observation time in Unix milliseconds. */
  observedAt: number;
};

export type CodexUpstream = {
  listTools(): Promise<unknown>;
  capabilities?(backendKind?: CodexBackendKind): BackendCapabilities;
  listModels?(backendKind?: CodexBackendKind): Promise<unknown>;
  /** Account-wide Codex weekly rate-limit projection exposed by App Server. */
  accountRevision?(): string;
  readAccountSnapshot?(): Promise<import("./codexAccount.js").CodexAccountSnapshot | null>;
  readAccountRateLimits?(): Promise<CodexWeeklyUsage | null>;
  startThread?(
    input: CodexThreadStartRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult>;
  continueThread?(
    input: CodexThreadContinueRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult>;
  forkThread?(
    input: CodexThreadForkRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult>;
  archiveThread?(threadId: string, backendKind?: CodexBackendKind): Promise<void>;
  restoreThread?(threadId: string, backendKind?: CodexBackendKind): Promise<void>;
  listBackgroundTerminals?(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexBackgroundTerminal[]>;
  /**
   * Inspect background terminals only when the thread is already materialized
   * in the selected App Server worker. A null result means that inspection was
   * intentionally skipped; implementations must never resume a thread here.
   */
  listLoadedBackgroundTerminals?(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexBackgroundTerminal[] | null>;
  terminateBackgroundTerminal?(
    threadId: string,
    processId: string,
    backendKind?: CodexBackendKind
  ): Promise<{ terminated: boolean }>;
  canResumeThread?(threadId: string, backendKind?: CodexBackendKind): boolean | undefined;
  probeThread?(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexThreadResumeProbe>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult>;
  forceTerminateWorker?(
    assignment: UpstreamWorkerAssignment,
    correlation: WorkerTerminationCorrelation,
    graceMs?: number
  ): Promise<JsonRpcTerminationResult>;
  respondToInteraction?(
    interactionId: string,
    response: { decision?: CodexInteractionDecision; answers?: Record<string, string[]> }
  ): Promise<void>;
  /** Positive local evidence that this exact App Server thread has an in-flight turn. */
  canSteerThread?(threadId: string): boolean;
  steerThread?(threadId: string, prompt: string): Promise<{ turnId: string }>;
  close(): Promise<void>;
};
