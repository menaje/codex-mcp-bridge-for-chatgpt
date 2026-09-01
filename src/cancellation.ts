export const CANCELLATION_SOURCES = [
  "model-tool",
  "widget-control",
  "activity-cascade",
  "operator",
  "assignment-containment"
] as const;

export const CANCELLATION_REASON_MAX_LENGTH = 500;

export type CancellationSource = (typeof CANCELLATION_SOURCES)[number];
export type CancellationTargetKind = "job" | "activity";
export type CancellationIntentStatus =
  | "recorded"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "no-op";
export type CancellationOperationStatus = "recorded" | "completed" | "failed";

export const JOB_TERMINAL_ORIGINS = [
  "normal-completion",
  "upstream-failure",
  "app-server-interrupted",
  "explicit-cancellation",
  "assignment-containment",
  "bridge-restart",
  "worker-loss",
  "legacy-unattributed-cancellation"
] as const;

export type JobTerminalOrigin = (typeof JOB_TERMINAL_ORIGINS)[number];

export type CancellationPresentation = {
  kind: "automatic" | "explicit";
  activityPresentationId?: string;
};

export type CancellationWidgetProof = {
  instanceDigest: string;
  cardGeneration: number;
};

export type CancellationTarget = {
  kind: CancellationTargetKind;
  jobId?: string;
  activityId: string;
  agentId?: string;
  threadId?: string;
  turnId?: string;
  presentationId?: string;
};

export type BeginCancellationOperationInput = {
  scopeId: string;
  requestId: string;
  actionHash: string;
  source: CancellationSource;
  toolName: string;
  actionName: string;
  target: CancellationTarget;
  expectedVersion: number;
  callerPresentation?: CancellationPresentation;
  widgetProof?: CancellationWidgetProof;
  callerRequestDigest?: string;
  reasonCode: string;
  /** Bounded, user-facing rationale. Required by model-visible cancellation tools. */
  reason?: string;
  now?: number;
};

export type CancellationOperationRecord = {
  scopeId: string;
  requestId: string;
  rootIntentId: string;
  actionHash: string;
  source: CancellationSource;
  toolName: string;
  actionName: string;
  targetKind: CancellationTargetKind;
  targetJobId?: string;
  targetActivityId: string;
  targetAgentId?: string;
  targetThreadId?: string;
  targetTurnId?: string;
  targetPresentationId?: string;
  expectedVersion: number;
  callerPresentation?: CancellationPresentation;
  widgetInstancePresent: boolean;
  widgetInstanceDigest?: string;
  cardGeneration?: number;
  callerRequestDigest?: string;
  bridgeInstanceId: string;
  reasonCode: string;
  reason?: string;
  status: CancellationOperationStatus;
  result?: unknown;
  createdAt: number;
  completedAt?: number;
};

export type CreateCancellationIntentInput = {
  scopeId: string;
  requestId: string;
  parentIntentId: string;
  cascadeId: string;
  source: CancellationSource;
  toolName: string;
  actionName: string;
  target: CancellationTarget;
  expectedVersion: number;
  callerPresentation?: CancellationPresentation;
  widgetProof?: CancellationWidgetProof;
  callerRequestDigest?: string;
  reasonCode: string;
  now?: number;
};

export type CancellationIntentRecord = {
  intentId: string;
  scopeId: string;
  requestId: string;
  parentIntentId?: string;
  cascadeId: string;
  source: CancellationSource;
  toolName: string;
  actionName: string;
  targetKind: CancellationTargetKind;
  targetJobId?: string;
  targetActivityId: string;
  targetAgentId?: string;
  targetThreadId?: string;
  targetTurnId?: string;
  targetPresentationId?: string;
  expectedVersion: number;
  callerPresentation?: CancellationPresentation;
  widgetInstancePresent: boolean;
  widgetInstanceDigest?: string;
  cardGeneration?: number;
  callerRequestDigest?: string;
  bridgeInstanceId: string;
  reasonCode: string;
  status: CancellationIntentStatus;
  createdAt: number;
  dispatchedAt?: number;
  completedAt?: number;
};

export type CancellationTerminationCorrelation = {
  kind: "cancellation-intent";
  intentId: string;
  requestId: string;
  source: CancellationSource;
  reasonCode: string;
};

export type AssignmentContainmentCorrelation = {
  kind: "assignment-containment";
  correlationId: string;
  reasonCode: "assignment-persistence-failed";
};

export type WorkerTerminationCorrelation =
  | CancellationTerminationCorrelation
  | AssignmentContainmentCorrelation;

export function cancellationTerminationCorrelation(
  intent: CancellationIntentRecord
): CancellationTerminationCorrelation {
  return {
    kind: "cancellation-intent",
    intentId: intent.intentId,
    requestId: intent.requestId,
    source: intent.source,
    reasonCode: intent.reasonCode
  };
}

export function assertWorkerTerminationCorrelation(
  value: unknown
): asserts value is WorkerTerminationCorrelation {
  if (!value || typeof value !== "object") {
    throw new Error(
      "TERMINATION_PROVENANCE_REQUIRED: App Server interruption and worker termination require a typed correlation."
    );
  }
  const correlation = value as Partial<WorkerTerminationCorrelation>;
  if (
    correlation.kind === "cancellation-intent" &&
    boundedIdentifier(correlation.intentId) &&
    boundedIdentifier(correlation.requestId) &&
    CANCELLATION_SOURCES.includes(correlation.source as CancellationSource) &&
    boundedReasonCode(correlation.reasonCode)
  ) {
    return;
  }
  if (
    correlation.kind === "assignment-containment" &&
    boundedIdentifier(correlation.correlationId) &&
    correlation.reasonCode === "assignment-persistence-failed"
  ) {
    return;
  }
  throw new Error(
    "TERMINATION_PROVENANCE_REQUIRED: Invalid or incomplete worker termination correlation."
  );
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function boundedReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value);
}
