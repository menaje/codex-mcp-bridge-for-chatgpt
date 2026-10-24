import { createHash } from "node:crypto";
import type { BridgeStateStore } from "./stateStore.js";
import { parseJsonTextStrict } from "./textIntegrity.js";
import type { ApprovedFollowup } from "./taskFollowups.js";
import type { CodexPendingInteraction } from "./upstream.js";

export const JOB_TERMINAL_EVENT = "codex.job.terminal";
export const JOB_LIFECYCLE_EVENT = "codex.job.lifecycle";
export type JobEventName = typeof JOB_TERMINAL_EVENT | typeof JOB_LIFECYCLE_EVENT;
const PREFIX = "mcp_events_v1/";
const ROOT_PREFIX = "mcp_event_lifecycle_roots_v1/";
const CHILD_PREFIX = "mcp_event_lifecycle_children_v1/";
export const MAX_EVENT_SUBSCRIPTIONS = 256;
export const MAX_JOB_EVENT_SUBSCRIPTIONS = 8;
export const EVENT_RESULT_RECOVERY_MS = 24 * 60 * 60 * 1_000;

export type EventJob = {
  approvedFollowups?: ApprovedFollowup[];
  jobId: string;
  scopeId: string;
  activityId?: string;
  agentId?: string;
  projectId?: string;
  mcpPrincipal?: string;
  completionDeliveryPolicy?: "live-card" | "direct-wait" | "relay-card" | "events";
  status: string;
  terminalVersion?: number;
  version?: number;
  workerId?: string;
  workerGeneration?: number;
  threadId?: string;
  trackingState?: string;
  updatedAt: number;
  createdAt?: number;
  pendingInteractions?: unknown[];
};

export type JobTerminalEvent = {
  eventId: string;
  name: typeof JOB_TERMINAL_EVENT;
  timestamp: string;
  data: {
    jobId: string;
    activityId: string | null;
    agentId: string | null;
    state: string;
    terminalVersion: number;
    availableFollowups?: Array<{ followupId: string }>;
    result: { tool: "codex_status"; query: { kind: "job"; id: string } };
  };
  cursor: null;
};

export type JobLifecycleEvent = {
  eventId: string;
  name: typeof JOB_LIFECYCLE_EVENT;
  timestamp: string;
  data: {
    rootJobId: string; jobId: string; activityId: string; agentId: string;
    kind: "input-required" | "terminal"; state: string; version: number;
    result: { tool: "codex_status"; query: { kind: "job"; id: string } | { kind: "input"; jobId: string } };
  };
  cursor: null;
};
export type LifecycleRoot = {
  jobId: string; activityId: string; agentId: string; projectId: string; createdAt: number;
};

/** An input notification identifies a current question, never its text or an
 * answer. Progress-only version changes cannot create new input notifications. */
export function lifecycleEvent(job: EventJob, root: LifecycleRoot): JobLifecycleEvent | undefined {
  const terminal = Boolean(job.terminalVersion && ["completed", "failed", "interrupted", "cancelled"].includes(job.status));
  const pending = (job.pendingInteractions || []).filter((input): input is CodexPendingInteraction =>
    Boolean(input && typeof input === "object" && typeof (input as CodexPendingInteraction).interactionId === "string" &&
      (input as CodexPendingInteraction).isBlocking !== false));
  if (!terminal && !pending.length) return undefined;
  const kind = terminal ? "terminal" : "input-required";
  const identity = terminal ? String(job.terminalVersion) : JSON.stringify(pending.map(input => ({ ...input, isBlocking: true })),
    (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return {
    eventId: "evt_" + createHash("sha256").update(`${JOB_LIFECYCLE_EVENT}\0${job.scopeId}\0${job.jobId}\0${kind}\0${identity}`).digest("hex"),
    name: JOB_LIFECYCLE_EVENT, timestamp: new Date(job.updatedAt).toISOString(), cursor: null,
    data: { rootJobId: root.jobId, jobId: job.jobId, activityId: root.activityId, agentId: root.agentId,
      kind, state: job.status, version: job.version || 1,
      result: { tool: "codex_status", query: terminal ? { kind: "job", id: job.jobId } : { kind: "input", jobId: job.jobId } } }
  };
}

export type EventSubscription = {
  id: string;
  jobId: string;
  scopeId: string;
  principal: string;
  /** Hash of a persisted subscription-only delegation; absent for legacy scoped grants. */
  accessReferenceHash?: string;
  /** AES-GCM protected callback URL and signing keys; never a tool result. */
  destination: string;
  revision: number;
  expiresAt: number;
  verifiedAt: number;
  disabled?: "unsubscribed" | "revoked" | "gone" | "goal-ended";
  name?: JobEventName;
  /** Explicit root subscription covers only later Events Jobs in this same
   * scope/Activity/Agent/project. Derived records are delivery intents, not grants. */
  lifecycleRoot?: LifecycleRoot;
  rootRevision?: number;
  recoveryPending?: boolean;
  event?: JobTerminalEvent | JobLifecycleEvent;
  delivery: "waiting" | "pending" | "acknowledged" | "failed";
  attempts: number;
  nextAttemptAt: number;
  acknowledgedAt?: number;
  lastStatus?: number;
  /** Receipt is not review: keep the result through this recovery boundary. */
  recoverUntil?: number;
};

/** Small bounded subscription journal owned by the existing State UoW. It is
 * independent of diagnostic events, native notifications and card ACKs. No new
 * SQLite connection, writer, schema inference or execution loop is involved. */
export class McpEventStore {
  constructor(private readonly state: BridgeStateStore) {}

  list(jobId?: string): EventSubscription[] {
    return this.state.listMeta(PREFIX + (jobId ? `${jobId}/` : ""), MAX_EVENT_SUBSCRIPTIONS + 1)
      .map(({ value }) => parseJsonTextStrict(value, "MCP event subscription") as EventSubscription);
  }

  get(jobId: string, id: string): EventSubscription | undefined {
    const raw = this.state.getMeta(this.key(jobId, id));
    return raw === undefined ? undefined : parseJsonTextStrict(raw, "MCP event subscription") as EventSubscription;
  }

  /** Compare the grant revision inside the existing writer transaction. Zero
   * means creation only. Delivery updates retain the grant revision; callers
   * must merge them from a fresh exact read, never a list/verification snapshot. */
  save(record: EventSubscription, expectedRevision: number): boolean {
    return this.state.transaction(() => {
      if (this.state.projectLifecycle.jobReceipt(record.jobId)) return false;
      const existing = this.get(record.jobId, record.id);
      if (expectedRevision === 0 ? existing !== undefined : existing?.revision !== expectedRevision) return false;
      if (record.revision < 1 || (record.revision !== expectedRevision && record.revision !== expectedRevision + 1)) {
        throw new Error("EVENT_SUBSCRIPTION_REVISION: Grant revision cannot move backwards or skip a revision.");
      }
      if (!existing && (this.list().length >= MAX_EVENT_SUBSCRIPTIONS ||
          this.list(record.jobId).length >= MAX_JOB_EVENT_SUBSCRIPTIONS)) {
        throw new Error("EVENT_SUBSCRIPTION_CAPACITY: Subscription capacity is full.");
      }
      const diagnostic=(value:EventSubscription|undefined)=>value ? {delivery:value.delivery,attempts:value.attempts,
        disabled:value.disabled || null,lastStatus:value.lastStatus || null} : null;
      if(JSON.stringify(diagnostic(existing))!==JSON.stringify(diagnostic(record))) this.state.recordHistoryDiagnostic(
        record.jobId,"completion-delivery",diagnostic(record)!);
      this.state.setMeta(this.key(record.jobId, record.id), JSON.stringify(record));
      if (!existing && record.name === JOB_LIFECYCLE_EVENT && record.lifecycleRoot) {
        const root = record.lifecycleRoot;
        const index = record.jobId === root.jobId
          ? `${ROOT_PREFIX}${record.scopeId}/${root.activityId}/${root.agentId}/${root.jobId}/${record.id}`
          : `${CHILD_PREFIX}${root.jobId}/${record.id}/${record.jobId}`;
        this.state.setMeta(index, JSON.stringify({ jobId: record.jobId, id: record.id }));
      }
      return true;
    });
  }

  /** Called inside the exact Job terminal transaction, and during late subscribe.
   * A process failure cannot commit a result without its active delivery intent. */
  enqueue(job: EventJob): void {
    if (!job.terminalVersion || !["completed", "failed", "interrupted", "cancelled"].includes(job.status)) return;
    for (const record of this.list(job.jobId)) {
      if (record.name === JOB_LIFECYCLE_EVENT) continue;
      if (record.disabled || record.expiresAt <= Date.now() || record.event) continue;
      record.event = {
        eventId: "evt_" + createHash("sha256").update(`${JOB_TERMINAL_EVENT}\0${job.scopeId}\0${job.jobId}\0${job.terminalVersion}`).digest("hex"),
        name: JOB_TERMINAL_EVENT,
        timestamp: new Date(job.updatedAt).toISOString(),
        data: {
          jobId: job.jobId,
          activityId: job.activityId || null,
          agentId: job.agentId || null,
          state: job.status,
          terminalVersion: job.terminalVersion,
          availableFollowups: job.status === "completed"
            ? this.state.taskFollowups.references(job).filter(step => step.status === "approved-pending")
              .map(({ followupId }) => ({ followupId })) : [],
          result: { tool: "codex_status", query: { kind: "job", id: job.jobId } }
        },
        cursor: null
      };
      record.delivery = "pending";
      record.nextAttemptAt = 0;
      record.recoverUntil = Math.max(record.expiresAt, Date.now() + EVENT_RESULT_RECOVERY_MS);
      if (!this.save(record, record.revision)) throw new Error("EVENT_SUBSCRIPTION_CHANGED: Terminal delivery intent was not saved.");
      this.state.markMcpEventReady(record.jobId, record.id);
    }
  }

  lifecycleRoots(job?: Pick<EventJob, "scopeId" | "activityId" | "agentId">): EventSubscription[] {
    if (job && (!job.activityId || !job.agentId)) return [];
    return this.state.listMeta(ROOT_PREFIX + (job ? `${job.scopeId}/${job.activityId}/${job.agentId}/` : ""), MAX_EVENT_SUBSCRIPTIONS)
      .map(({ value }) => parseJsonTextStrict(value, "Lifecycle root index") as { jobId: string; id: string })
      .map(key => this.get(key.jobId, key.id))
      .filter((record): record is EventSubscription => Boolean(record?.name === JOB_LIFECYCLE_EVENT && record.lifecycleRoot));
  }

  lifecycleChildren(root: EventSubscription): EventSubscription[] {
    return this.state.listMeta(`${CHILD_PREFIX}${root.jobId}/${root.id}/`, MAX_EVENT_SUBSCRIPTIONS)
      .map(({ value }) => parseJsonTextStrict(value, "Lifecycle child index") as { jobId: string; id: string })
      .map(key => this.get(key.jobId, key.id))
      .filter((record): record is EventSubscription => Boolean(record));
  }

  matchesLifecycle(root: EventSubscription, job: EventJob): boolean {
    const goal = root.lifecycleRoot;
    return root.name === JOB_LIFECYCLE_EVENT && Boolean(goal &&
      job.scopeId === root.scopeId && job.mcpPrincipal === root.principal &&
      job.activityId === goal.activityId && job.agentId === goal.agentId && job.projectId === goal.projectId &&
      job.completionDeliveryPolicy === "events" && (job.jobId === goal.jobId || (job.createdAt || 0) >= goal.createdAt));
  }

  /** Called in the source Job/input transaction. No Codex execution or new
   * subscription grant is created. The root's finite verified receiver remains
   * the sole authority for every derived delivery record. */
  enqueueLifecycle(job: EventJob, onlyRoot?: EventSubscription): void {
    if (job.completionDeliveryPolicy !== "events" || this.state.mcpEventAccess.monitoringStopped(job, JOB_LIFECYCLE_EVENT)) return;
    for (const root of onlyRoot ? [onlyRoot] : this.lifecycleRoots(job)) {
      if (root.disabled || root.expiresAt <= Date.now() || !this.matchesLifecycle(root, job) ||
          this.state.isEventActivityEnded(root.lifecycleRoot!.activityId)) continue;
      const old = this.get(job.jobId, root.id);
      if (old?.disabled) continue;
      const event = lifecycleEvent(job, root.lifecycleRoot!);
      if (old && old.event?.eventId === event?.eventId) continue;
      // An answered/superseded input never remains a pending notification.
      const record: EventSubscription = { ...(old || root), jobId: job.jobId,
        rootRevision: root.revision, revision: old?.revision || 1,
        expiresAt: root.expiresAt, destination: root.destination, disabled: undefined,
        event, delivery: event ? "pending" : "waiting", attempts: 0, nextAttemptAt: 0,
        acknowledgedAt: undefined, lastStatus: undefined,
        recoverUntil: event ? Math.max(root.expiresAt, Date.now() + EVENT_RESULT_RECOVERY_MS) : old?.recoverUntil };
      try {
        if (!this.save(record, old?.revision || 0)) throw new Error("EVENT_SUBSCRIPTION_CHANGED: Lifecycle delivery intent changed.");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("EVENT_SUBSCRIPTION_CAPACITY:")) throw error;
        // Capacity cannot roll back a real Job/result. Keep an explicit recovery
        // marker; subscribe/refresh/restart requery the same retained Jobs.
        const latestRoot = this.get(root.jobId, root.id);
        if (latestRoot && !latestRoot.recoveryPending) this.save({ ...latestRoot, recoveryPending: true }, latestRoot.revision);
        continue;
      }
      if (event) this.state.markMcpEventReady(record.jobId, record.id);
    }
  }

  reconcileLifecycle(root: EventSubscription): void {
    if (!root.lifecycleRoot || root.jobId !== root.lifecycleRoot.jobId || root.disabled || root.expiresAt <= Date.now()) return;
    this.state.transaction(() => {
      if (root.recoveryPending) this.save({ ...root, recoveryPending: undefined }, root.revision);
      const current = this.get(root.jobId, root.id)!;
      for (const job of this.state.listEventLifecycleJobs(root.lifecycleRoot!, root.scopeId)) this.enqueueLifecycle(job, current);
    });
  }

  refreshLifecycleChildren(root: EventSubscription): void {
    for (const child of this.lifecycleChildren(root)) {
      if (child.disabled) continue;
      if (!this.save({ ...child, destination: root.destination, expiresAt: root.expiresAt,
        rootRevision: root.revision, revision: child.revision + 1 }, child.revision)) {
        throw new Error("EVENT_SUBSCRIPTION_CHANGED: Lifecycle child changed during renewal.");
      }
    }
  }

  stopLifecycleChildren(root: EventSubscription, reason: NonNullable<EventSubscription["disabled"]>): void {
    for (const child of this.lifecycleChildren(root)) {
      if (child.disabled === reason) continue;
      if (!this.save({ ...child, disabled: reason, revision: child.revision + 1 }, child.revision)) {
        throw new Error("EVENT_SUBSCRIPTION_CHANGED: Lifecycle child changed during stop.");
      }
    }
  }

  stopActivity(activityId: string): void {
    for (const root of this.lifecycleRoots().filter(record => record.lifecycleRoot?.activityId === activityId && !record.disabled)) {
      if (!this.save({ ...root, disabled: "goal-ended", revision: root.revision + 1 }, root.revision)) {
        throw new Error("EVENT_SUBSCRIPTION_CHANGED: Lifecycle root changed at goal completion.");
      }
      this.stopLifecycleChildren(root, "goal-ended");
    }
  }

  protectsResult(jobId: string, now: number): boolean {
    return this.list(jobId).some(record => (record.recoverUntil || 0) > now ||
      !record.disabled && record.expiresAt > now);
  }

  /** No ACK releases a result. Finite recovery and subscription lifetimes bound
   * retention; unsubscribe/revocation never cancels or deletes the original Job. */
  maintain(now = Date.now()): void {
    for (const record of this.list()) {
      if (record.expiresAt <= now && (record.recoverUntil || 0) <= now) {
        this.state.deleteMeta(this.key(record.jobId, record.id));
        if (record.lifecycleRoot) {
          const root = record.lifecycleRoot;
          this.state.deleteMeta(record.jobId === root.jobId
            ? `${ROOT_PREFIX}${record.scopeId}/${root.activityId}/${root.agentId}/${root.jobId}/${record.id}`
            : `${CHILD_PREFIX}${root.jobId}/${record.id}/${record.jobId}`);
        }
      }
    }
  }

  private key(jobId: string, id: string): string { return `${PREFIX}${jobId}/${id}`; }
}
