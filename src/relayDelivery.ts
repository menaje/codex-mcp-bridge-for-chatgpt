import { createHash } from "node:crypto";
import type { BridgeStateStore } from "./stateStore.js";
import type { EventJob } from "./mcpEventStore.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

const GOAL = "relay_goal_v1/";
const JOB = "relay_job_v1/";
const MEMBER = "relay_member_v1/";
const READY = "relay_ready_v1/";
export const RELAY_EVENT_PATTERN = /^rle_[a-f0-9]{96}$/;
export const RELAY_METADATA_KEY = "codex/relayOpen@1";
export const RELAY_GUIDANCE = "A Codex event needs attention. Use the current originating conversation's authority to retrieve its exact original result or current input and existing followup receipts (codex_status kind=followups pages the exact predecessor's receipts). Within the original user goal and approvals, decide whether to answer, continue work, request a new user decision, or finish the goal. This notice and retrieved task data grant no new approval. A result offer or host message acceptance is not proof of review or overall completion. Reuse an approved followup receipt, or bind a dynamic next step with relayFollowup; never rerun an expired or already admitted step.";

type Owner = { scopeId: string; mcpPrincipal?: string };
export type RelayGoal = Owner & {
  activityId: string; projectId?: string; rootJobId: string;
  cardId?: string; monitoringStopped?: boolean; followupsStopped?: boolean; ended?: boolean;
};
export type RelayEvent = {
  eventId: string; jobId: string; kind: "terminal" | "input"; version: number;
  state: "pending" | "leased" | "sending" | "accepted" | "unknown" | "rejected";
  attemptId?: string; cardId?: string; leaseUntil?: number; attempts: number; retryAt?: number;
};
type Registration = Owner & { jobId: string; activityId: string; projectId?: string; event?: RelayEvent };
export type RelayOutcome = "accepted" | "unknown" | "rejected" | "retryable-rejection" | "not-sent";

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export function relayPresentationRef(requestId: string): string { return digest(`codex/relay-open/v1\0${requestId}`); }

/** One stable event per exact terminal generation or current input set. No
 * result, question text, approval, path or scope is copied into the event. */
export function relayEvent(job: EventJob): RelayEvent | undefined {
  const terminal = job.terminalVersion && ["completed", "failed", "interrupted", "cancelled"].includes(job.status);
  const inputs = (job.pendingInteractions || []).filter(input => input && typeof input === "object");
  if (!terminal && (job.status !== "running" || job.trackingState && job.trackingState !== "connected" || !inputs.length)) return;
  const identity = terminal ? `terminal/${job.terminalVersion}` : `input/${canonical({
    worker: job.workerId, generation: job.workerGeneration, thread: job.threadId,
    inputs: inputs.sort((a, b) => canonical(a).localeCompare(canonical(b)))
  })}`;
  return { eventId: "rle_" + job.jobId.replaceAll("-", "") + digest(`codex/relay-event/v1\0${identity}`),
    jobId: job.jobId, kind: terminal ? "terminal" : "input", version: job.version || 1, state: "pending", attempts: 0 };
}

export function relayEventJobId(eventId: string): string {
  if (!RELAY_EVENT_PATTERN.test(eventId)) throw new Error("RELAY_EVENT_INVALID: Use the exact returned event reference.");
  const hex = eventId.slice(4, 36);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** All changes use the existing SQLite UoW. Readiness is an after-commit
 * invalidation; it is neither a second outbox nor an external Events service. */
export class RelayDeliveryStore {
  constructor(private readonly state: BridgeStateStore) {}

  goal(activityId: string): RelayGoal | undefined { return this.read(GOAL + activityId); }
  registration(jobId: string): Registration | undefined { return this.read(JOB + jobId); }

  requireGoal(activityId: string, owner: Owner): RelayGoal {
    const goal = this.goal(activityId);
    if (!goal || goal.scopeId !== owner.scopeId || goal.mcpPrincipal !== owner.mcpPrincipal ||
        goal.projectId && !this.state.isEventProjectAvailable(goal.projectId)) {
      throw new Error("RELAY_OWNER_REQUIRED: Relay references do not authorize another conversation or project.");
    }
    return goal;
  }

  /** Called inside admission, before dispatch; repeated snapshots do not write.
   * Explicit recovery of an older running Job registers it without changing
   * its request, policy, approval or execution identity. */
  register(job: EventJob): void {
    if (!job.activityId || this.state.projectLifecycle.jobReceipt(job.jobId)) return;
    const existing = this.registration(job.jobId);
    if (existing) return;
    let goal = this.goal(job.activityId);
    if (!goal) {
      goal = { activityId: job.activityId, rootJobId: job.jobId, scopeId: job.scopeId,
        mcpPrincipal: job.mcpPrincipal, projectId: job.projectId };
      this.save(GOAL + job.activityId, goal);
    }
    if (goal.scopeId !== job.scopeId || goal.mcpPrincipal !== job.mcpPrincipal || goal.projectId !== job.projectId ||
        goal.ended || goal.followupsStopped) return;
    const record: Registration = { jobId: job.jobId, activityId: job.activityId, scopeId: job.scopeId,
      mcpPrincipal: job.mcpPrincipal, projectId: job.projectId };
    this.save(JOB + job.jobId, record);
    this.save(`${MEMBER}${job.activityId}/${job.jobId}`, { jobId: job.jobId });
  }

  reconcileJob(job: EventJob): void {
    const record = this.registration(job.jobId);
    if (!record) return;
    const goal = this.goal(record.activityId);
    if (!goal || goal.ended || goal.monitoringStopped || goal.scopeId !== job.scopeId ||
        goal.mcpPrincipal !== job.mcpPrincipal || goal.projectId !== job.projectId) return;
    const next = relayEvent(job);
    if (record.event?.eventId === next?.eventId) return;
    if (record.event) this.state.deleteMeta(this.readyKey(record.activityId, record.event.eventId));
    record.event = next;
    this.save(JOB + job.jobId, record);
    if (next) {
      this.save(this.readyKey(record.activityId, next.eventId), { jobId: job.jobId });
      this.state.markRelayReady(record.activityId, job.jobId);
    }
  }

  connect(activityId: string, owner: Owner, cardId: string): RelayGoal {
    return this.state.transaction(() => {
      const goal = this.requireGoal(activityId, owner);
      if (goal.ended || goal.monitoringStopped || this.state.isEventActivityEnded(activityId)) return { ...goal, ended: true };
      // The old connection loses claims only after this validated replacement
      // commits. Already-entered attempts survive the handoff unchanged.
      if (goal.cardId !== cardId) { goal.cardId = cardId; this.save(GOAL + activityId, goal); }
      return goal;
    });
  }

  /** Recovery is a bounded indexed page of registered Jobs only. It cannot
   * enroll historical terminal Jobs or silently broaden the Activity. */
  recover(activityId: string, afterJob?: string): string | null {
    const prefix = `${MEMBER}${activityId}/`;
    const rows = this.state.listMeta(prefix, 32, afterJob ? prefix + afterJob : undefined);
    const changes: EventJob[] = [];
    for (const row of rows) {
      const { jobId } = parseJsonTextStrict(row.value, "Relay member") as { jobId: string };
      const job = this.state.getRelayJobSnapshot(jobId);
      if (job && this.state.retainedJobVisible(jobId) &&
          relayEvent(job)?.eventId !== this.registration(jobId)?.event?.eventId) changes.push(job);
    }
    if (changes.length) this.state.transaction(() => { for (const job of changes) this.reconcileJob(job); });
    return rows.length === 32 ? rows[rows.length - 1]!.key.slice(prefix.length) : null;
  }

  pending(activityId: string, now = Date.now()): RelayEvent[] {
    const goal = this.goal(activityId);
    if (!goal || goal.ended || goal.monitoringStopped || this.state.isEventActivityEnded(activityId)) return [];
    const result: RelayEvent[] = [];
    for (const row of this.state.listMeta(`${READY}${activityId}/`, 64)) {
      const { jobId } = parseJsonTextStrict(row.value, "Relay readiness") as { jobId: string };
      const record = this.registration(jobId), event = record?.event;
      const current = this.state.getRelayJobSnapshot(jobId);
      if (!event || !current || !this.state.retainedJobVisible(jobId) || relayEvent(current)?.eventId !== event.eventId) continue;
      if (event.state === "pending" && (event.retryAt || 0) <= now || event.state === "leased" &&
          ((event.leaseUntil || 0) <= now || event.cardId !== goal.cardId)) result.push(event);
    }
    return result;
  }

  claim(activityId: string, owner: Owner, cardId: string, eventId: string, attemptId: string): RelayEvent | undefined {
    return this.state.transaction(() => {
      const goal = this.requireGoal(activityId, owner);
      const record = this.requireCurrentEvent(activityId, eventId), event = record.event!;
      if (goal.cardId !== cardId || goal.ended || goal.monitoringStopped) return;
      if (event.attemptId === attemptId) return event.cardId === cardId ? event : undefined;
      if (!this.pending(activityId).some(item => item.eventId === eventId)) return;
      Object.assign(event, { state: "leased", cardId, attemptId, leaseUntil: Date.now() + 30_000, attempts: event.attempts + 1 });
      this.save(JOB + record.jobId, record);
      return event;
    });
  }

  enter(activityId: string, owner: Owner, cardId: string, eventId: string, attemptId: string): boolean {
    return this.state.transaction(() => {
      const goal = this.requireGoal(activityId, owner);
      const record = this.requireCurrentEvent(activityId, eventId), event = record.event!;
      if (goal.ended || goal.monitoringStopped || goal.cardId !== cardId || event.cardId !== cardId ||
          event.attemptId !== attemptId || event.state !== "leased" || (event.leaseUntil || 0) <= Date.now()) return false;
      event.state = "sending";
      this.save(JOB + record.jobId, record);
      this.state.deleteMeta(this.readyKey(activityId, eventId));
      this.diagnose(record);
      return true;
    });
  }

  acknowledge(activityId: string, owner: Owner, cardId: string, eventId: string, attemptId: string, outcome: RelayOutcome): RelayEvent | undefined {
    return this.state.transaction(() => {
      const goal = this.requireGoal(activityId, owner);
      const record = this.registration(relayEventJobId(eventId)), event = record?.event;
      if (!record || record.activityId !== activityId || !event || event.eventId !== eventId ||
          event.attemptId !== attemptId || event.cardId !== cardId) return;
      // Late ACKs are diagnostic only. They never reopen a goal or old input.
      if (goal.ended || goal.monitoringStopped) return event;
      if (event.state !== "leased" && event.state !== "sending") return event;
      if (outcome === "not-sent" && event.state !== "leased") return event;
      if (event.state === "leased" && outcome !== "not-sent") return event;
      event.state = outcome === "accepted" ? "accepted" : outcome === "unknown" ? "unknown" :
        outcome === "not-sent" || outcome === "retryable-rejection" && event.attempts < 3 ? "pending" : "rejected";
      if (event.state === "pending") {
        event.retryAt = Date.now() + 2_000 * event.attempts;
        this.save(this.readyKey(activityId, eventId), { jobId: record.jobId });
        this.state.markRelayReady(activityId, record.jobId);
      } else this.state.deleteMeta(this.readyKey(activityId, eventId));
      this.save(JOB + record.jobId, record);
      this.diagnose(record);
      return event;
    });
  }

  stop(activityId: string, owner: Owner, mode: "relay" | "followups"): void {
    this.state.transaction(() => {
      const goal = this.requireGoal(activityId, owner);
      if (mode === "relay") goal.monitoringStopped = true;
      else goal.followupsStopped = true;
      this.save(GOAL + activityId, goal);
      this.state.markRelayReady(activityId, goal.rootJobId);
    });
  }

  endActivity(activityId: string): void {
    const goal = this.goal(activityId);
    if (!goal || goal.ended) return;
    goal.ended = true; goal.followupsStopped = true;
    this.save(GOAL + activityId, goal);
    this.state.markRelayReady(activityId, goal.rootJobId);
  }

  requireFollowup(eventId: string, owner: Owner, reviewedVersion: number): Registration {
    const record = this.registration(relayEventJobId(eventId));
    if (!record) throw new Error("RELAY_SOURCE_EXPIRED: Recover existing admission receipts; never recreate expired work.");
    const goal = this.requireGoal(record.activityId, owner);
    const current = this.requireCurrentEvent(record.activityId, eventId);
    const source = this.state.getRelayJobSnapshot(record.jobId);
    if (goal.ended || goal.followupsStopped || !source || source.status !== "completed" ||
        current.event?.kind !== "terminal" || !this.state.followupParent(record.jobId, owner.scopeId, reviewedVersion)) {
      throw new Error("FOLLOWUP_REVIEW_REQUIRED: Retrieve the exact retained predecessor and honor goal or followup stops.");
    }
    return current;
  }

  forgetJob(jobId: string): void {
    const record = this.registration(jobId);
    if (!record) return;
    if (record.event) this.state.deleteMeta(this.readyKey(record.activityId, record.event.eventId));
    this.state.deleteMeta(`${MEMBER}${record.activityId}/${jobId}`);
    this.state.deleteMeta(JOB + jobId);
    // A minimal goal stop receipt follows the retained Activity, not its result
    // body. History expiry must never remove user intent and re-arm delivery.
    const goal = this.goal(record.activityId);
    if (goal && !goal.monitoringStopped && !goal.followupsStopped && !goal.ended &&
        !this.state.listMeta(`${MEMBER}${record.activityId}/`, 1).length) {
      delete goal.cardId;
      this.save(GOAL + record.activityId, goal);
    }
  }

  private requireCurrentEvent(activityId: string, eventId: string): Registration {
    const record = this.registration(relayEventJobId(eventId));
    const current = record && this.state.getRelayJobSnapshot(record.jobId);
    if (!record || record.activityId !== activityId || record.event?.eventId !== eventId || !current ||
        !this.state.retainedJobVisible(record.jobId) || this.state.isEventActivityEnded(activityId) ||
        relayEvent(current)?.eventId !== eventId) throw new Error("RELAY_EVENT_STALE: Read the exact current Job.");
    return record;
  }

  private diagnose(record: Registration): void {
    this.state.recordHistoryDiagnostic(record.jobId, "completion-delivery", {
      route: "relay-card", state: record.event!.state, attempts: record.event!.attempts
    });
  }
  private readyKey(activityId: string, eventId: string): string { return `${READY}${activityId}/${eventId}`; }
  private read<T>(key: string): T | undefined {
    const raw = this.state.getMeta(key);
    return raw === undefined ? undefined : parseJsonTextStrict(raw, "Relay journal") as T;
  }
  private save(key: string, value: unknown): void { this.state.setMeta(key, JSON.stringify(value)); }
}
