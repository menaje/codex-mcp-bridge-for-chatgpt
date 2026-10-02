import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BridgeStateStore } from "./stateStore.js";
import { JOB_TERMINAL_EVENT, type EventJob } from "./mcpEventStore.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

const PREFIX = "mcp_event_access_v1/";
export const EVENT_ACCESS_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const SUBSCRIPTION_REF_PATTERN = /^esr_[A-Za-z0-9_-]{43}$/;
const MAX_GRANTS = 256;
const MAX_JOB_GRANTS = 8;

export const eventSubscriptionStateSchema = z.strictObject({
  state: z.enum(["pending", "active", "unavailable"])
});
export const eventAccessOutputSchema = z.strictObject({
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
  callbackHash?: string;
  subscriptionId?: string;
};

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
      this.maintain(now);
      const prior = this.list(job.jobId).find(record => record.revokedAt === undefined && record.expiresAt > now && this.matches(record, job, principal));
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
    });
  }

  /** Expired receipts cannot create access. Removing them cannot revive a late
   * challenge: its transaction requires the same still-present grant revision. */
  maintain(now = Date.now()): void {
    for (const record of this.list()) if (record.expiresAt + EVENT_ACCESS_LIFETIME_MS <= now) this.state.deleteMeta(PREFIX + record.referenceHash);
  }

  subscriptionState(job: EventJob, now = Date.now()): { state: "pending" | "active" | "unavailable" } {
    if (job.projectId && !this.state.isEventProjectAvailable(job.projectId)) return { state: "unavailable" };
    const grants = this.list(job.jobId);
    const subscriptions = this.state.mcpEvents.list(job.jobId);
    const active = subscriptions.some(subscription => !subscription.disabled && subscription.expiresAt > now &&
      subscription.accessReferenceHash && grants.some(grant => grant.referenceHash === subscription.accessReferenceHash &&
        grant.revokedAt === undefined && grant.expiresAt > now && grant.callbackHash && grant.subscriptionId === subscription.id &&
        this.matches(grant, job, subscription.principal)));
    const pending = grants.some(grant => grant.revokedAt === undefined && grant.expiresAt > now && !grant.callbackHash &&
      this.matches(grant, job, grant.principal));
    return { state: active ? "active" : pending || !grants.length && !subscriptions.length ? "pending" : "unavailable" };
  }
}
