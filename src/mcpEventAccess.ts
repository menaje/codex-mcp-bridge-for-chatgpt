import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BridgeStateStore } from "./stateStore.js";
import { JOB_TERMINAL_EVENT, type EventJob, type EventSubscription } from "./mcpEventStore.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

const PREFIX = "mcp_event_access_v1/";
const STOP_PREFIX = "mcp_event_monitoring_stop_v1/";
export const EVENT_ACCESS_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const SUBSCRIPTION_REF_PATTERN = /^esr_[A-Za-z0-9_-]{43}$/;
const MAX_GRANTS = 256;
const MAX_JOB_GRANTS = 8;

export const eventSubscriptionStateSchema = z.strictObject({
  state: z.enum(["pending", "active", "unavailable"]),
  reason: z.enum(["revoked", "unsubscribed", "expired", "callback_gone", "job_unavailable", "project_unavailable", "runtime_unavailable"]).optional(),
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
  event: z.literal(JOB_TERMINAL_EVENT),
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
  event: typeof JOB_TERMINAL_EVENT;
  issuedAt: number;
  expiresAt: number;
  revision: number;
  revokedAt?: number;
  unsubscribedAt?: number;
  callbackHash?: string;
  subscriptionId?: string;
};

type MonitoringStop = { principal: string; scopeId: string; event: typeof JOB_TERMINAL_EVENT;
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
    return record.event === JOB_TERMINAL_EVENT && record.principal === principal &&
      record.jobId === job.jobId && record.scopeId === job.scopeId &&
      record.activityId === job.activityId && record.agentId === job.agentId &&
      record.projectId === job.projectId && job.mcpPrincipal === principal &&
      job.completionDeliveryPolicy === "events";
  }

  issue(job: EventJob, principal: string, secret: string, now = Date.now()): { record: EventAccessReceipt; subscriptionRef: string } {
    return this.state.transaction(() => {
      if (!this.state.isEventJobRetained(job.jobId)) throw new Error("EVENT_ACCESS_OWNER_REQUIRED: The exact Events Job is no longer retained.");
      this.maintain(now);
      const prior = this.list(job.jobId).find(record => record.revokedAt === undefined && record.unsubscribedAt === undefined && record.expiresAt > now && this.matches(record, job, principal) &&
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
        principal, scopeId: job.scopeId, event: JOB_TERMINAL_EVENT, issuedAt: now,
        expiresAt: now + EVENT_ACCESS_LIFETIME_MS, revision: 1 };
      const ref = this.reference(record, secret);
      record.referenceHash = referenceHash(ref);
      if (!this.save(record, 0)) throw new Error("EVENT_ACCESS_CHANGED: Delegation admission changed.");
      // Only this authenticated original-conversation issuance can resume a
      // stopped watch. Status and maintenance never clear the user's stop intent.
      this.forgetJob(job.jobId);
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
        }
      }
      this.rememberStop(jobId, { principal, scopeId, event: JOB_TERMINAL_EVENT, reason: "revoked", stoppedAt: now });
    });
  }

  unsubscribe(record: EventAccessReceipt, now = Date.now()): boolean {
    return this.state.transaction(() => {
      if (!this.save({ ...record, unsubscribedAt: record.unsubscribedAt ?? now, revision: record.revision + 1 }, record.revision)) return false;
      // An old reference can disable its own callback after a deliberate
      // reissue, but cannot stop the newer watch or alter its status guidance.
      if (!this.list(record.jobId).some(other => other.referenceHash !== record.referenceHash && other.issuedAt >= record.issuedAt &&
          other.revokedAt === undefined && other.unsubscribedAt === undefined)) {
        this.rememberStop(record.jobId, { principal: record.principal, scopeId: record.scopeId, event: record.event,
          reason: record.revokedAt !== undefined ? "revoked" : "unsubscribed", stoppedAt: now });
      }
      return true;
    });
  }

  private rememberStop(jobId: string, stopped: MonitoringStop): void {
    if (this.state.isEventJobRetained(jobId)) this.state.setMeta(STOP_PREFIX + jobId, JSON.stringify(stopped));
  }

  /** One small stop record per retained Job; removed with that Job/history. */
  forgetJob(jobId: string): void { this.state.deleteMeta(STOP_PREFIX + jobId); }

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
        if ((record.revokedAt !== undefined || unsubscribed) && !this.state.getMeta(STOP_PREFIX + record.jobId) &&
            !records.some(other => other.jobId === record.jobId && other.referenceHash !== record.referenceHash &&
              other.issuedAt >= record.issuedAt && other.revokedAt === undefined && other.unsubscribedAt === undefined)) {
          this.rememberStop(record.jobId, { principal: record.principal, scopeId: record.scopeId, event: record.event,
            reason: record.revokedAt !== undefined ? "revoked" : "unsubscribed", stoppedAt: record.revokedAt ?? record.unsubscribedAt ?? now });
        }
        if (record.expiresAt + EVENT_ACCESS_LIFETIME_MS <= now) this.state.deleteMeta(PREFIX + record.referenceHash);
      }
    });
  }

  subscriptionState(job: EventJob, now = Date.now()): EventSubscriptionState {
    if (!this.state.isEventJobRetained(job.jobId)) return { state: "unavailable", reason: "job_unavailable" };
    const grants = this.list(job.jobId);
    const subscriptions = this.state.mcpEvents.list(job.jobId);
    const active = subscriptions.find(subscription => !subscription.disabled && subscription.expiresAt > now &&
      subscription.accessReferenceHash && grants.some(grant => grant.referenceHash === subscription.accessReferenceHash &&
        grant.revokedAt === undefined && grant.unsubscribedAt === undefined && grant.expiresAt > now && grant.callbackHash && grant.subscriptionId === subscription.id &&
        this.matches(grant, job, subscription.principal)));
    const ownedGrants = grants.filter(grant => this.matches(grant, job, grant.principal));
    const latest = ownedGrants.find(grant => grant.revokedAt === undefined && grant.unsubscribedAt === undefined && grant.expiresAt > now) ||
      ownedGrants.sort((a, b) => b.issuedAt - a.issuedAt)[0];
    const subscription = active || subscriptions.find(sub => sub.accessReferenceHash === latest?.referenceHash && sub.id === latest?.subscriptionId);
    const delivery = subscription ? { delivery: deliveryState(subscription) } : {};
    const stoppedRaw = this.state.getMeta(STOP_PREFIX + job.jobId);
    const stopped = stoppedRaw ? parseJsonTextStrict(stoppedRaw, "MCP event monitoring stop") as MonitoringStop : undefined;
    if (stopped && stopped.principal === job.mcpPrincipal && stopped.scopeId === job.scopeId && stopped.event === JOB_TERMINAL_EVENT) {
      return { state: "unavailable", reason: stopped.reason, ...delivery };
    }
    if (job.projectId && !this.state.isEventProjectAvailable(job.projectId)) return { state: "unavailable", reason: "project_unavailable", ...delivery };
    if (active) return { state: "active", ...delivery };
    const pending = grants.some(grant => grant.revokedAt === undefined && grant.unsubscribedAt === undefined && grant.expiresAt > now && !grant.callbackHash &&
      this.matches(grant, job, grant.principal));
    if (latest?.revokedAt !== undefined || subscription?.disabled === "revoked") return { state: "unavailable", reason: "revoked", ...delivery };
    if (latest?.unsubscribedAt !== undefined || subscription?.disabled === "unsubscribed") return { state: "unavailable", reason: "unsubscribed", ...delivery };
    if (subscription?.disabled === "gone") return { state: "unavailable", reason: "callback_gone", ...delivery };
    if (pending || !grants.length && !subscriptions.length) return { state: "pending" };
    return { state: "unavailable", reason: "expired", ...delivery };
  }
}
