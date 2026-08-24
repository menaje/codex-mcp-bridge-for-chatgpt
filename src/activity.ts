export const ACTIVITY_KINDS = [
  "discussion",
  "investigation",
  "review",
  "implementation",
  "other"
] as const;

export const ACTIVITY_EXECUTION_MODES = ["foreground", "background"] as const;
export const ACTIVITY_HANDOFF_POLICIES = ["none", "notify", "verify"] as const;
export const ACTIVITY_COMPLETION_TRIGGERS = ["manual", "sealed-jobs-terminal"] as const;
export const ACTIVITY_LIFECYCLES = [
  "open",
  "sealed",
  "terminating",
  "completed",
  "cancelled",
  "abandoned"
] as const;
export const ACTIVITY_WAITING_ON = [
  "none",
  "codex",
  "orchestrator",
  "user",
  "verification"
] as const;
export const ACTIVITY_VERIFICATION_STATES = [
  "not-required",
  "pending",
  "verifying",
  "verified",
  "failed"
] as const;
export const ACTIVITY_JOB_STATUSES = [
  "running",
  "terminating",
  "termination-failed",
  "completed",
  "failed",
  "interrupted",
  "cancelled"
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type ActivityExecutionMode = (typeof ACTIVITY_EXECUTION_MODES)[number];
export type ActivityHandoffPolicy = (typeof ACTIVITY_HANDOFF_POLICIES)[number];
export type ActivityCompletionTrigger = (typeof ACTIVITY_COMPLETION_TRIGGERS)[number];
export type ActivityLifecycle = (typeof ACTIVITY_LIFECYCLES)[number];
export type ActivityWaitingOn = (typeof ACTIVITY_WAITING_ON)[number];
export type ActivityVerificationState = (typeof ACTIVITY_VERIFICATION_STATES)[number];
export type ActivityJobStatus = (typeof ACTIVITY_JOB_STATUSES)[number];

export type ActivityJobCounts = {
  total: number;
  running: number;
  completed: number;
  failed: number;
  interrupted: number;
  cancelled: number;
  terminal: number;
};

export type ActivityVerificationEvidence = {
  summary: string;
  jobIds?: string[];
  tests?: string[];
  artifacts?: string[];
  references?: string[];
};

export type BridgeActivity = {
  activityId: string;
  scopeId: string;
  /** Stable project identity pinned when the Activity admits its first work. */
  projectId?: string;
  projectLabel?: string;
  continuationOfActivityId?: string;
  /** Presentation generation is independent from Agent/thread continuity. */
  cardGeneration: number;
  title: string;
  kind: ActivityKind;
  executionMode: ActivityExecutionMode;
  handoffPolicy: ActivityHandoffPolicy;
  completionTrigger: ActivityCompletionTrigger;
  lifecycle: ActivityLifecycle;
  waitingOn: ActivityWaitingOn;
  verification: ActivityVerificationState;
  version: number;
  completionVersion: number;
  legacy: boolean;
  createdAt: number;
  updatedAt: number;
  sealedAt?: number;
  completedAt?: number;
  counts: ActivityJobCounts;
};

export type ActivityBarrierDecision = {
  lifecycle: ActivityLifecycle;
  waitingOn: ActivityWaitingOn;
  verification: ActivityVerificationState;
  completionChannel?: "notify" | "verify";
  attentionRequired: boolean;
};

export const EMPTY_ACTIVITY_JOB_COUNTS: ActivityJobCounts = Object.freeze({
  total: 0,
  running: 0,
  completed: 0,
  failed: 0,
  interrupted: 0,
  cancelled: 0,
  terminal: 0
});

export function isActiveActivityJobStatus(
  status: string
): status is Extract<ActivityJobStatus, "running" | "terminating" | "termination-failed"> {
  return status === "running" || status === "terminating" || status === "termination-failed";
}

export function isTerminalActivityJobStatus(
  status: string
): status is Exclude<ActivityJobStatus, "running" | "terminating" | "termination-failed"> {
  return status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";
}

/**
 * Derive only the state that follows child-job changes. Explicit completion,
 * cancellation, abandonment, and verification actions are separate mutations.
 */
export function deriveActivityBarrier(
  activity: Pick<
    BridgeActivity,
    "lifecycle" | "waitingOn" | "verification" | "handoffPolicy" | "completionTrigger"
  >,
  counts: ActivityJobCounts
): ActivityBarrierDecision {
  if (activity.lifecycle === "completed" || activity.lifecycle === "cancelled" || activity.lifecycle === "abandoned") {
    return {
      lifecycle: activity.lifecycle,
      waitingOn: activity.waitingOn,
      verification: activity.verification,
      attentionRequired: false
    };
  }

  const attentionRequired = counts.failed + counts.interrupted + counts.cancelled > 0;
  if (counts.running > 0) {
    return {
      lifecycle: activity.lifecycle,
      waitingOn: "codex",
      verification: activity.verification,
      attentionRequired
    };
  }

  const barrierReached = counts.total > 0 && counts.terminal === counts.total;
  if (
    activity.lifecycle !== "sealed" ||
    activity.completionTrigger !== "sealed-jobs-terminal" ||
    !barrierReached ||
    attentionRequired
  ) {
    return {
      lifecycle: activity.lifecycle,
      waitingOn: counts.total > 0 ? "orchestrator" : "none",
      verification: activity.verification,
      attentionRequired
    };
  }

  if (activity.handoffPolicy === "notify") {
    return {
      lifecycle: "completed",
      waitingOn: "none",
      verification: "not-required",
      completionChannel: "notify",
      attentionRequired: false
    };
  }
  if (activity.handoffPolicy === "verify") {
    return {
      lifecycle: "sealed",
      waitingOn: "verification",
      verification: "pending",
      completionChannel: "verify",
      attentionRequired: false
    };
  }
  return {
    lifecycle: "sealed",
    waitingOn: "orchestrator",
    verification: activity.verification,
    attentionRequired: false
  };
}

export function valueIsOneOf<T extends readonly string[]>(
  values: T,
  value: unknown
): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
