import { createHash } from "node:crypto";
import { isActiveActivityJobStatus } from "./activity.js";
import type { BridgeStateStore } from "./stateStore.js";
import type { EventJob } from "./mcpEventStore.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

const GOAL = "relay_goal_v1/";
const JOB = "relay_job_v1/";
const HISTORY = "relay_event_history_v1/";
const MEMBER = "relay_member_v1/";
const READY = "relay_ready_v1/";
const DEFERRED = "relay_deferred_v1/";
export const DIRECT_WAIT_GRACE_MS = 10_000;
export const RESULT_REVIEW_GRACE_MS = 60_000;
export const RELAY_EVENT_PATTERN = /^rle_[a-f0-9]{96}$/;
export const RELAY_METADATA_KEY = "codex/relayOpen@1";
export const RELAY_RETRY_METADATA_KEY = "codex/relayRetry@1";
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
type Registration = Owner & {
  jobId: string; activityId: string; projectId?: string; event?: RelayEvent; paused?: boolean;
  directWaits?: Record<string, number>;
  resultOffer?: { eventId: string; version: number };
  resultReview?: { eventId: string; version: number; reviewedAt: number; until: number };
  deferredUntil?: number;
};
export type RelayOutcome = "accepted" | "unknown" | "rejected" | "retryable-rejection" | "not-sent";

/** This request cannot grant dispatch; the card can recover without new work. */
export class RelayEventUnavailableError extends Error {}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export function relayPresentationRef(requestId: string): string { return digest(`codex/relay-open/v1\0${requestId}`); }

/** One stable event per exact terminal generation or current input set. No
 * result, question text, approval, path or scope is copied into the event.
 * Owner reachability controls dispatch, not the identity or delivery history. */
export function relayEvent(job: EventJob): RelayEvent | undefined {
  const terminal = job.terminalVersion && ["completed", "failed", "interrupted", "cancelled"].includes(job.status);
  const inputs = (job.pendingInteractions || []).filter(input => input && typeof input === "object");
  if (!terminal && (job.status !== "running" || !inputs.length)) return;
  const identity = terminal ? `terminal/${job.terminalVersion}` : `input/${canonical({
    worker: job.workerId, generation: job.workerGeneration, thread: job.threadId,
    inputs: inputs.sort((a, b) => canonical(a).localeCompare(canonical(b)))
  })}`;
  return { eventId: "rle_" + job.jobId.replaceAll("-", "") + digest(`codex/relay-event/v1\0${identity}`),
    jobId: job.jobId, kind: terminal ? "terminal" : "input", version: job.version || 1, state: "pending", attempts: 0 };
}

function dispatchable(job: EventJob, event: RelayEvent): boolean {
  return event.kind === "terminal" || !job.trackingState || job.trackingState === "connected";
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
    const sameEvent = record.event?.eventId === next?.eventId;
    const paused = Boolean(next && !dispatchable(job, next));
    if (sameEvent && Boolean(record.paused) === paused) return;
    this.clearIndex(record);
    if (!sameEvent) {
      // A resolved/replaced input loses current eligibility, not its receipt.
      // Archive only on identity changes; progress and liveness do not append.
      if (record.event) this.save(this.historyKey(job.jobId, record.event.eventId), record.event);
      record.event = next ? this.read<RelayEvent>(this.historyKey(job.jobId, next.eventId)) || next : undefined;
      if (next) this.state.deleteMeta(this.historyKey(job.jobId, next.eventId));
    }
    if (paused) record.paused = true;
    else delete record.paused;
    this.index(record);
    this.save(JOB + job.jobId, record);
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
      if (job && this.state.retainedJobVisible(jobId)) {
        const next = relayEvent(job), record = this.registration(jobId);
        if (next?.eventId !== record?.event?.eventId ||
            Boolean(record?.paused) !== Boolean(next && !dispatchable(job, next))) changes.push(job);
      }
    }
    if (changes.length) this.state.transaction(() => { for (const job of changes) this.reconcileJob(job); });
    return rows.length === 32 ? rows[rows.length - 1]!.key.slice(prefix.length) : null;
  }

  pending(activityId: string, now = Date.now()): RelayEvent[] {
    const goal = this.goal(activityId);
    if (!goal || goal.ended || goal.monitoringStopped || this.state.isEventActivityEnded(activityId)) return [];
    const result: RelayEvent[] = [];
    // Held events have their own deadline-ordered index, so a block of held
    // Jobs cannot hide unrelated ready events behind the first page.
    const rows = [...this.state.listMeta(`${READY}${activityId}/`, 64),
      ...this.state.listMeta(`${DEFERRED}${activityId}/`, 64).filter(row =>
        Number(row.key.slice(`${DEFERRED}${activityId}/`.length, `${DEFERRED}${activityId}/`.length + 16)) <= now)];
    for (const row of rows) {
      const { jobId } = parseJsonTextStrict(row.value, "Relay readiness") as { jobId: string };
      const record = this.registration(jobId), event = record?.event;
      const current = this.state.getRelayJobSnapshot(jobId);
      if (!event || !current || !this.state.retainedJobVisible(jobId) || relayEvent(current)?.eventId !== event.eventId || !dispatchable(current, event)) continue;
      if (this.heldUntil(record, now) > now) continue;
      if (event.state === "pending" && (event.retryAt || 0) <= now || event.state === "leased" &&
          ((event.leaseUntil || 0) <= now || event.cardId !== goal.cardId)) result.push(event);
      if (result.length === 64) break;
    }
    return result;
  }

  claim(activityId: string, owner: Owner, cardId: string, eventId: string, attemptId: string): RelayEvent | undefined {
    return this.state.transaction(() => {
      const goal = this.requireGoal(activityId, owner);
      const record = this.requireCurrentEvent(activityId, eventId), event = record.event!;
      if (goal.cardId !== cardId || goal.ended || goal.monitoringStopped) return;
      if (this.heldUntil(record, Date.now()) > Date.now()) return;
      if (event.attemptId === attemptId) return event.cardId === cardId ? event : undefined;
      if (!this.pending(activityId).some(item => item.eventId === eventId)) return;
      if (record.deferredUntil !== undefined) this.diagnoseDecision(record, "release", "priority-expired");
      this.clearIndex(record);
      Object.assign(event, { state: "leased", cardId, attemptId, leaseUntil: Date.now() + 30_000, attempts: event.attempts + 1 });
      this.index(record);
      this.save(JOB + record.jobId, record);
      this.diagnoseDecision(record, "claim", "eligible");
      return event;
    });
  }

  enter(activityId: string, owner: Owner, cardId: string, eventId: string, attemptId: string): boolean {
    return this.state.transaction(() => {
      const goal = this.requireGoal(activityId, owner);
      const record = this.requireCurrentEvent(activityId, eventId), event = record.event!;
      if (goal.ended || goal.monitoringStopped || goal.cardId !== cardId || event.cardId !== cardId ||
          event.attemptId !== attemptId || event.state !== "leased" || (event.leaseUntil || 0) <= Date.now()) return false;
      if (this.heldUntil(record, Date.now()) > Date.now()) {
        this.diagnoseDecision(record, "defer", "direct-priority");
        return false;
      }
      event.state = "sending";
      this.clearIndex(record);
      this.save(JOB + record.jobId, record);
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
      this.clearIndex(record);
      if (event.state === "pending") {
        event.retryAt = Date.now() + 2_000 * event.attempts;
      }
      this.index(record);
      this.save(JOB + record.jobId, record);
      this.diagnose(record);
      return event;
    });
  }

  /** Only an actual, authenticated model status wait creates this bounded
   * preference. Card reads, connections and visibility never call it. */
  beginDirectWait(jobId: string, owner: Owner, waitId: string, waitMs: number, now = Date.now()): boolean {
    return this.state.transaction(() => {
      const record = this.registration(jobId), current = this.state.getRelayJobSnapshot(jobId);
      if (!record || !current || !isActiveActivityJobStatus(current.status) || !this.state.retainedJobVisible(jobId)) return false;
      const goal = this.requireGoal(record.activityId, owner);
      if (goal.ended || goal.monitoringStopped || this.state.isEventActivityEnded(record.activityId)) return false;
      const waits = Object.fromEntries(Object.entries(record.directWaits || {}).filter(([, until]) => until > now));
      if (Object.keys(waits).length >= 16) return false;
      waits[waitId] = now + waitMs + DIRECT_WAIT_GRACE_MS;
      record.directWaits = waits;
      this.clearIndex(record); this.index(record, now); this.save(JOB + jobId, record);
      this.diagnoseDecision(record, "hold", "direct-wait");
      return true;
    });
  }

  endDirectWait(jobId: string, waitId: string, now = Date.now()): void {
    this.state.transaction(() => {
      const record = this.registration(jobId), until = record?.directWaits?.[waitId];
      if (!record || until === undefined) return;
      record.directWaits![waitId] = Math.min(until, now + DIRECT_WAIT_GRACE_MS);
      this.clearIndex(record); this.index(record, now); this.save(JOB + jobId, record);
      this.diagnoseDecision(record, "hold", "wait-ended-grace");
    });
  }

  /** A server offer binds the exact event, but is never a model review. */
  offerResult(jobId: string, owner: Owner, eventId: string, version: number): boolean {
    return this.state.transaction(() => {
      const record = this.registration(jobId), source = this.state.getRelayJobSnapshot(jobId);
      if (!record || !source || source.status !== "completed" || !this.state.retainedJobVisible(jobId)) return false;
      const goal = this.requireGoal(record.activityId, owner);
      if (goal.ended || goal.monitoringStopped || this.state.isEventActivityEnded(record.activityId) ||
          record.event?.kind !== "terminal" || record.event.eventId !== eventId || record.event.version !== version ||
          relayEvent(source)?.eventId !== eventId) return false;
      record.resultOffer = { eventId, version };
      this.save(JOB + jobId, record);
      return true;
    });
  }

  reviewResult(owner: Owner, eventId: string, version: number, now = Date.now()): { until: number; alreadyReviewed: boolean; dispatchEntered: boolean } {
    return this.state.transaction(() => {
      const record = this.registration(relayEventJobId(eventId));
      if (!record) throw new RelayEventUnavailableError("RELAY_EVENT_STALE: Read the exact current Job.");
      const goal = this.requireGoal(record.activityId, owner);
      const current = this.requireCurrentEvent(record.activityId, eventId), event = current.event!;
      if (goal.ended || goal.monitoringStopped || this.state.getRelayJobSnapshot(record.jobId)?.status !== "completed" ||
          event.kind !== "terminal" || event.version !== version ||
          current.resultOffer?.eventId !== eventId || current.resultOffer.version !== version) {
        throw new RelayEventUnavailableError("RESULT_REVIEW_UNAVAILABLE: Retrieve the exact retained result in this conversation and honor relay stops.");
      }
      const existing = current.resultReview;
      if (existing?.eventId === eventId && existing.version === version) {
        return { until: existing.until, alreadyReviewed: true, dispatchEntered: ["sending", "unknown", "accepted"].includes(event.state) };
      }
      current.resultReview = { eventId, version, reviewedAt: now, until: now + RESULT_REVIEW_GRACE_MS };
      this.clearIndex(current); this.index(current, now); this.save(JOB + current.jobId, current);
      this.diagnoseDecision(current, "hold", "model-review");
      return { until: current.resultReview.until, alreadyReviewed: false, dispatchEntered: ["sending", "unknown", "accepted"].includes(event.state) };
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
    this.state.deleteMetaPrefix(`${HISTORY}${jobId}/`);
    const record = this.registration(jobId);
    if (!record) return;
    this.clearIndex(record);
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
        relayEvent(current)?.eventId !== eventId) throw new RelayEventUnavailableError("RELAY_EVENT_STALE: Read the exact current Job.");
    if (!dispatchable(current, record.event)) throw new RelayEventUnavailableError("RELAY_EVENT_PAUSED: The original input owner is not currently connected; preserve this event and attempt.");
    return record;
  }

  private diagnose(record: Registration): void {
    this.state.recordHistoryDiagnostic(record.jobId, "completion-delivery", {
      route: "relay-card", state: record.event!.state, attempts: record.event!.attempts
    });
  }
  private diagnoseDecision(record: Registration, decision: string, reason: string): void {
    this.state.recordHistoryDiagnostic(record.jobId, "completion-delivery", { route: "relay-card", decision, reason });
  }
  private heldUntil(record: Registration, now: number): number {
    if (record.event?.kind !== "terminal") return 0;
    const review = record.resultReview;
    const reviewUntil = review?.eventId === record.event.eventId && review.version === record.event.version ? review.until : 0;
    return Math.max(reviewUntil, ...Object.values(record.directWaits || {}).filter(until => until > now), 0);
  }
  private clearIndex(record: Registration): void {
    if (!record.event) return;
    this.state.deleteMeta(this.readyKey(record.activityId, record.event.eventId));
    if (record.deferredUntil !== undefined) this.state.deleteMeta(this.deferredKey(record.activityId, record.event.eventId, record.deferredUntil));
    delete record.deferredUntil;
  }
  private index(record: Registration, now = Date.now()): void {
    const event = record.event;
    if (!event || record.paused || !["pending", "leased"].includes(event.state)) return;
    const until = this.heldUntil(record, now);
    if (until > now) {
      // A live pre-entry lease remains recoverable, but cannot be entered.
      record.deferredUntil = Math.max(until, event.state === "leased" ? event.leaseUntil || 0 : 0);
      this.save(this.deferredKey(record.activityId, event.eventId, record.deferredUntil), { jobId: record.jobId });
    } else {
      this.save(this.readyKey(record.activityId, event.eventId), { jobId: record.jobId });
      this.state.markRelayReady(record.activityId, record.jobId);
    }
  }
  private readyKey(activityId: string, eventId: string): string { return `${READY}${activityId}/${eventId}`; }
  private deferredKey(activityId: string, eventId: string, until: number): string { return `${DEFERRED}${activityId}/${String(until).padStart(16, "0")}/${eventId}`; }
  private historyKey(jobId: string, eventId: string): string { return `${HISTORY}${jobId}/${eventId}`; }
  private read<T>(key: string): T | undefined {
    const raw = this.state.getMeta(key);
    return raw === undefined ? undefined : parseJsonTextStrict(raw, "Relay journal") as T;
  }
  private save(key: string, value: unknown): void { this.state.setMeta(key, JSON.stringify(value)); }
}
