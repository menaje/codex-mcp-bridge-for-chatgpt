import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BridgeStateStore } from "./stateStore.js";
import { JOB_TERMINAL_EVENT, JOB_LIFECYCLE_EVENT, type JobEventName, type EventJob, type EventSubscription } from "./mcpEventStore.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

const PREFIX = "mcp_event_access_v1/";
const STOP_PREFIX = "mcp_event_monitoring_stop_v1/";
export const EVENT_ACCESS_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const SUBSCRIPTION_REF_PATTERN = /^esr_[A-Za-z0-9_-]{43}$/;
const MAX_GRANTS = 256;
const MAX_JOB_GRANTS = 8;

export const eventSubscriptionStateSchema = z.strictObject({
  state: z.enum(["pending", "active", "unavailable"]),
  reason: z.enum(["revoked", "unsubscribed", "expired", "callback_gone", "job_unavailable", "project_unavailable", "runtime_unavailable", "goal_ended", "delivery_capacity"]).optional(),
  rootJobId: z.string().uuid().optional(),
  delivery: z.strictObject({
    state: z.enum(["waiting", "pending", "acknowledged", "failed"]),
    attempts: z.number().int().nonnegative(),
    lastHttpStatus: z.number().int().min(100).max(599).nullable(),
    failureReason: z.enum(["callback_rejected", "retry_exhausted"]).nullable()
  }).optional()
});
export type EventSubscriptionState = z.infer<typeof eventSubscriptionStateSchema>;
export const eventAccessOutputSchema = eventSubscriptionStateSchema.extend({
  jobId: z.string().uuid(),
  state: z.enum(["pending", "active", "unavailable", "revoked"]),
  event: z.enum([JOB_TERMINAL_EVENT, JOB_LIFECYCLE_EVENT]),
  arguments: z.strictObject({ jobId: z.string().uuid(), subscriptionRef: z.string().regex(SUBSCRIPTION_REF_PATTERN) }).optional(),
  expiresAt: z.string().optional()
});

export type EventAccessReceipt = {
  id: string;
  referenceHash: string;
  principal: string;
  jobId: string;
  activityId: string;
  agentId: string;
  projectId: string;
  scopeId: string;
  event: JobEventName;
  rootCreatedAt?: number;
  issuedAt: number;
  expiresAt: number;
  revision: number;
  revokedAt?: number;
  unsubscribedAt?: number;
  callbackHash?: string;
  subscriptionId?: string;
};

type MonitoringStop = { principal: string; scopeId: string; event: JobEventName;
  reason: "revoked" | "unsubscribed"; stoppedAt: number };

function deliveryState(subscription: EventSubscription): NonNullable<EventSubscriptionState["delivery"]> {
  const status = subscription.lastStatus;
  const transient = status === undefined || status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  return { state: subscription.delivery, attempts: subscription.attempts,
    lastHttpStatus: status !== undefined && status >= 100 && status <= 599 ? status : null,
    failureReason: subscription.delivery === "failed" ? transient ? "retry_exhausted" : "callback_rejected" : null };
}

function referenceHash(ref: string): string { return createHash("sha256").update(ref).digest("hex"); }
export function eventCallbackHash(url: string): string { return createHash("sha256").update(url).digest("hex"); }

/** Subscription-only delegation in the existing SQLite metadata/UoW. Neither
 * this receipt nor its opaque reference authorizes result reads or task admission.
 * No callback URL, signing key or raw reference is stored in this journal. */
export class McpEventAccessStore {
  constructor(private readonly state: BridgeStateStore) {}

  list(jobId?: string): EventAccessReceipt[] {
    return this.state.listMeta(PREFIX, MAX_GRANTS + 1)
      .map(({ value }) => parseJsonTextStrict(value, "MCP event access receipt") as EventAccessReceipt)
      .filter(record => jobId === undefined || record.jobId === jobId);
  }

  getByHash(hash: string): EventAccessReceipt | undefined {
    const raw = this.state.getMeta(PREFIX + hash);
    return raw === undefined ? undefined : parseJsonTextStrict(raw, "MCP event access receipt") as EventAccessReceipt;
  }

  get(ref: string, installationSecret: string): EventAccessReceipt | undefined {
    if (!SUBSCRIPTION_REF_PATTERN.test(ref)) return undefined;
    const record = this.getByHash(referenceHash(ref));
    if (!record) return undefined;
    const expected = Buffer.from(this.reference(record, installationSecret));
    const actual = Buffer.from(ref);
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? record : undefined;
  }

  reference(record: EventAccessReceipt, installationSecret: string): string {
    return "esr_" + createHmac("sha256", installationSecret)
      .update("codex-mcp-bridge/event-access/v1\0").update(record.id).digest("base64url");
  }

  matches(record: EventAccessReceipt, job: EventJob, principal: string): boolean {
    return [JOB_TERMINAL_EVENT, JOB_LIFECYCLE_EVENT].includes(record.event) && record.principal === principal &&
      record.jobId === job.jobId && record.scopeId === job.scopeId &&
      record.activityId === job.activityId && record.agentId === job.agentId &&
      record.projectId === job.projectId && job.mcpPrincipal === principal &&
      job.completionDeliveryPolicy === "events";
  }

  issue(job: EventJob, principal: string, secret: string, now = Date.now(), event: JobEventName = JOB_TERMINAL_EVENT): { record: EventAccessReceipt; subscriptionRef: string } {
    return this.state.transaction(() => {
      if (!this.state.isEventJobRetained(job.jobId)) throw new Error("EVENT_ACCESS_OWNER_REQUIRED: The exact Events Job is no longer retained.");
      this.maintain(now);
      if (event === JOB_LIFECYCLE_EVENT && (!job.activityId || this.state.isEventActivityEnded(job.activityId))) {
        throw new Error("EVENT_ACCESS_GOAL_ENDED: A completed or stopped goal cannot start monitoring again.");
      }
      const prior = this.list(job.jobId).find(record => record.event === event && record.revokedAt === undefined && record.unsubscribedAt === undefined && record.expiresAt > now && this.matches(record, job, principal) &&
        (!record.subscriptionId || this.state.mcpEvents.get(job.jobId, record.subscriptionId)?.disabled !== "unsubscribed"));
      if (prior) {
        const ref = this.reference(prior, secret);
        if (referenceHash(ref) !== prior.referenceHash) throw new Error("EVENT_ACCESS_KEY_CHANGED: Explicitly revoke and issue a new delegation after installation-key rotation.");
        return { record: prior, subscriptionRef: ref };
      }
      if (!job.activityId || !job.agentId || !job.projectId || job.completionDeliveryPolicy !== "events" || job.mcpPrincipal !== principal) {
        throw new Error("EVENT_ACCESS_OWNER_REQUIRED: An exact Events Job, Activity, Agent and project are required.");
      }
      if (this.list().length >= MAX_GRANTS || this.list(job.jobId).length >= MAX_JOB_GRANTS) {
        throw new Error("EVENT_ACCESS_CAPACITY: Subscription delegation capacity is full.");
      }
      const record: EventAccessReceipt = { id: randomUUID(), referenceHash: "", jobId: job.jobId,
        activityId: job.activityId, agentId: job.agentId, projectId: job.projectId,
        principal, scopeId: job.scopeId, event, issuedAt: now,
        ...(event === JOB_LIFECYCLE_EVENT ? { rootCreatedAt: job.createdAt || job.updatedAt } : {}),
        expiresAt: now + EVENT_ACCESS_LIFETIME_MS, revision: 1 };
      const ref = this.reference(record, secret);
      record.referenceHash = referenceHash(ref);
      if (!this.save(record, 0)) throw new Error("EVENT_ACCESS_CHANGED: Delegation admission changed.");
      // Only this authenticated original-conversation issuance can resume a
      // stopped watch. Status and maintenance never clear the user's stop intent.
      this.forgetJob(job.jobId, event);
      return { record, subscriptionRef: ref };
    });
  }

  save(record: EventAccessReceipt, expectedRevision: number): boolean {
    return this.state.transaction(() => {
      const old = this.getByHash(record.referenceHash);
      if (expectedRevision === 0 ? old !== undefined : old?.revision !== expectedRevision) return false;
      if (record.revision !== expectedRevision + 1) throw new Error("EVENT_ACCESS_REVISION: Delegation revision must advance once.");
      this.state.setMeta(PREFIX + record.referenceHash, JSON.stringify(record));
      return true;
    });
  }

  revoke(jobId: string, principal: string, scopeId: string, now = Date.now()): void {
    this.state.transaction(() => {
      for (const record of this.list(jobId)) {
        if (record.principal !== principal || record.scopeId !== scopeId || record.revokedAt !== undefined) continue;
        if (!this.save({ ...record, revokedAt: now, revision: record.revision + 1 }, record.revision)) {
          throw new Error("EVENT_ACCESS_CHANGED: Delegation changed during revocation.");
        }
        for (const subscription of this.state.mcpEvents.list(jobId)) {
          if (subscription.accessReferenceHash !== record.referenceHash || subscription.disabled === "revoked") continue;
          if (!this.state.mcpEvents.save({ ...subscription, disabled: "revoked", revision: subscription.revision + 1 }, subscription.revision)) {
            throw new Error("EVENT_SUBSCRIPTION_CHANGED: Subscription changed during revocation.");
          }
          if (subscription.name === JOB_LIFECYCLE_EVENT && subscription.lifecycleRoot?.jobId === jobId) {
            this.state.mcpEvents.stopLifecycleChildren(subscription, "revoked");
          }
        }
      }
      this.rememberStop(jobId, { principal, scopeId, event: JOB_TERMINAL_EVENT, reason: "revoked", stoppedAt: now });
      // A derived delivery has no independent grant. An explicit exact-child
      // stop still fences that child without revoking the rest of the goal.
      for (const subscription of this.state.mcpEvents.list(jobId).filter(record => record.name === JOB_LIFECYCLE_EVENT && record.scopeId === scopeId && record.principal === principal)) {
        if (subscription.disabled !== "revoked") this.state.mcpEvents.save({ ...subscription, disabled: "revoked", revision: subscription.revision + 1 }, subscription.revision);
        if (subscription.lifecycleRoot?.jobId === jobId) this.state.mcpEvents.stopLifecycleChildren(subscription, "revoked");
      }
      // Consent can exist before native registration. Preserve the exact Job's
      // stop even when no child delivery/grant exists yet, so late root
      // registration and source reconciliation cannot create that delivery.
      this.rememberStop(jobId, { principal, scopeId, event: JOB_LIFECYCLE_EVENT, reason: "revoked", stoppedAt: now });
    });
  }

  unsubscribe(record: EventAccessReceipt, now = Date.now()): boolean {
    return this.state.transaction(() => {
      if (!this.save({ ...record, unsubscribedAt: record.unsubscribedAt ?? now, revision: record.revision + 1 }, record.revision)) return false;
      // An old reference can disable its own callback after a deliberate
      // reissue, but cannot stop the newer watch or alter its status guidance.
      if (!this.list(record.jobId).some(other => other.event === record.event && other.referenceHash !== record.referenceHash && other.issuedAt >= record.issuedAt &&
          other.revokedAt === undefined && other.unsubscribedAt === undefined)) {
        this.rememberStop(record.jobId, { principal: record.principal, scopeId: record.scopeId, event: record.event,
          reason: record.revokedAt !== undefined ? "revoked" : "unsubscribed", stoppedAt: now });
      }
      return true;
    });
  }

  private rememberStop(jobId: string, stopped: MonitoringStop): void {
    if (this.state.isEventJobRetained(jobId)) this.state.setMeta(this.stopKey(jobId, stopped.event), JSON.stringify(stopped));
  }

  /** One small stop record per retained Job; removed with that Job/history. */
  forgetJob(jobId: string, event?: JobEventName): void {
    const names: JobEventName[] = event ? [event] : [JOB_TERMINAL_EVENT, JOB_LIFECYCLE_EVENT];
    for (const name of names) this.state.deleteMeta(this.stopKey(jobId, name));
  }
  private stopKey(jobId: string, event: JobEventName): string { return STOP_PREFIX + jobId + (event === JOB_LIFECYCLE_EVENT ? "/lifecycle" : ""); }
  monitoringStopped(job: EventJob, event: JobEventName): MonitoringStop["reason"] | undefined {
    const raw = this.state.getMeta(this.stopKey(job.jobId, event));
    const stopped = raw ? parseJsonTextStrict(raw, "MCP monitoring stop") as MonitoringStop : undefined;
    return stopped?.principal === job.mcpPrincipal && stopped?.scopeId === job.scopeId ? stopped.reason : undefined;
  }

  preferredEvent(job: EventJob): JobEventName {
    return this.list(job.jobId).filter(record => this.matches(record, job, record.principal))
      .sort((a, b) => b.issuedAt - a.issuedAt)[0]?.event || JOB_LIFECYCLE_EVENT;
  }

  /** Expired receipts cannot create access. Removing them cannot revive a late
   * challenge: its transaction requires the same still-present grant revision. */
  maintain(now = Date.now()): void {
    this.state.transaction(() => {
      const records = this.list().map(record => {
        if (record.unsubscribedAt === undefined && record.subscriptionId &&
            this.state.mcpEvents.get(record.jobId, record.subscriptionId)?.disabled === "unsubscribed") {
          const stopped = { ...record, unsubscribedAt: now, revision: record.revision + 1 };
          if (!this.save(stopped, record.revision)) throw new Error("EVENT_ACCESS_CHANGED: Delegation changed during maintenance.");
          return stopped;
        }
        return record;
      }).sort((a, b) => b.issuedAt - a.issuedAt || (b.revokedAt ?? b.unsubscribedAt ?? 0) - (a.revokedAt ?? a.unsubscribedAt ?? 0));
      // Preserve explicit stops in receipts written before stop records existed.
      // Expiry alone never creates a stop, and an older receipt cannot stop a
      // newer delegation. No credential is retained in the stop record.
      for (const record of records) {
        const unsubscribed = record.unsubscribedAt !== undefined || record.subscriptionId &&
          this.state.mcpEvents.get(record.jobId, record.subscriptionId)?.disabled === "unsubscribed";
        if ((record.revokedAt !== undefined || unsubscribed) && !this.state.getMeta(this.stopKey(record.jobId, record.event)) &&
            !records.some(other => other.event === record.event && other.jobId === record.jobId && other.referenceHash !== record.referenceHash &&
              other.issuedAt >= record.issuedAt && other.revokedAt === undefined && other.unsubscribedAt === undefined)) {
          this.rememberStop(record.jobId, { principal: record.principal, scopeId: record.scopeId, event: record.event,
            reason: record.revokedAt !== undefined ? "revoked" : "unsubscribed", stoppedAt: record.revokedAt ?? record.unsubscribedAt ?? now });
        }
        if (record.expiresAt + EVENT_ACCESS_LIFETIME_MS <= now) this.state.deleteMeta(PREFIX + record.referenceHash);
      }
    });
  }

  subscriptionState(job: EventJob, now = Date.now(), event?: JobEventName): EventSubscriptionState {
    if (!this.state.isEventJobRetained(job.jobId)) return { state: "unavailable", reason: "job_unavailable" };
    const subscriptions = this.state.mcpEvents.list(job.jobId).filter(record => !event || (record.name || JOB_TERMINAL_EVENT) === event);
    const grants = this.list(job.jobId).filter(record => (!event || record.event === event) && this.matches(record, job, record.principal));
    const active = subscriptions.find(subscription => {
      if (subscription.disabled || subscription.expiresAt <= now || !subscription.accessReferenceHash) return false;
      const grant = this.getByHash(subscription.accessReferenceHash);
      if (!grant || grant.revokedAt !== undefined || grant.unsubscribedAt !== undefined || grant.expiresAt <= now ||
          !grant.callbackHash || grant.subscriptionId !== subscription.id) return false;
      const rootJob = subscription.lifecycleRoot ? this.state.getEventJobSnapshot(subscription.lifecycleRoot.jobId) : job;
      const rootRecord = subscription.lifecycleRoot ? this.state.mcpEvents.get(subscription.lifecycleRoot.jobId, subscription.id) : subscription;
      return Boolean(rootJob && rootRecord && !rootRecord.disabled && rootRecord.expiresAt > now &&
        this.matches(grant, rootJob, subscription.principal) &&
        (!subscription.lifecycleRoot || !this.state.isEventActivityEnded(subscription.lifecycleRoot.activityId) && this.state.mcpEvents.matchesLifecycle(subscription, job)));
    });
    const latest = grants.find(grant => grant.revokedAt === undefined && grant.unsubscribedAt === undefined && grant.expiresAt > now) ||
      grants.sort((a, b) => b.issuedAt - a.issuedAt)[0];
    const subscription = active || subscriptions.find(sub => sub.accessReferenceHash === latest?.referenceHash && sub.id === latest?.subscriptionId) ||
      subscriptions.find(sub => sub.lifecycleRoot);
    const delivery = subscription ? { delivery: deliveryState(subscription) } : {};
    const root = subscription?.lifecycleRoot;
    const rootJobId = root?.jobId || (latest?.event === JOB_LIFECYCLE_EVENT ? latest.jobId : undefined);
    const projection = rootJobId ? { rootJobId } : {};
    const stopped = this.monitoringStopped(job, event || (root ? JOB_LIFECYCLE_EVENT : JOB_TERMINAL_EVENT));
    if (stopped) return { state: "unavailable", reason: stopped, ...delivery, ...projection };
    if (job.projectId && !this.state.isEventProjectAvailable(job.projectId)) return { state: "unavailable", reason: "project_unavailable", ...delivery, ...projection };
    if (root && this.state.isEventActivityEnded(root.activityId)) return { state: "unavailable", reason: "goal_ended", ...delivery, ...projection };
    if (active) return { state: "active", ...delivery, ...projection };
    const pending = grants.some(grant => grant.revokedAt === undefined && grant.unsubscribedAt === undefined && grant.expiresAt > now && !grant.callbackHash);
    if (latest?.revokedAt !== undefined || subscription?.disabled === "revoked") return { state: "unavailable", reason: "revoked", ...delivery, ...projection };
    if (latest?.unsubscribedAt !== undefined || subscription?.disabled === "unsubscribed") return { state: "unavailable", reason: "unsubscribed", ...delivery, ...projection };
    if (subscription?.disabled === "gone") return { state: "unavailable", reason: "callback_gone", ...delivery, ...projection };
    const matchingRoot = this.state.mcpEvents.lifecycleRoots(job).find(record => !record.disabled && record.expiresAt > now && this.state.mcpEvents.matchesLifecycle(record, job));
    if (matchingRoot?.recoveryPending) return { state: "unavailable", reason: "delivery_capacity", rootJobId: matchingRoot.jobId, ...delivery };
    if (pending || !grants.length && !subscriptions.length) return { state: "pending", ...projection };
    return { state: "unavailable", reason: "expired", ...delivery, ...projection };
  }
}
