import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type RetentionDays = 0 | 7 | 30 | 90;
export type AppliedHistoryPolicy = {
  retentionDays: RetentionDays; policyRevision: string; settingsRevision: number;
  evaluatedAt: number; cutoffAt: number | null;
};
export function strictRetentionDays(value: unknown): RetentionDays {
  if (value === 0 || value === 7 || value === 30 || value === 90) return value;
  throw new Error("HISTORY_POLICY_UNAVAILABLE: Invalid saved history retention; no records were deleted.");
}
/** Only an absent installation record has a default. Existing rows must have
 * the policy field, including numeric zero. Legacy defaults are migrated once. */
export function readAppliedHistoryPolicy(db: Database.Database, now = Date.now()): AppliedHistoryPolicy {
  const row = db.prepare("SELECT payload,settings_revision FROM user_settings WHERE singleton=1")
    .get() as {payload:string;settings_revision:number} | undefined;
  const value = row ? JSON.parse(row.payload) : undefined;
  const days = row ? strictRetentionDays(value && !Object.hasOwn(value,"historyRetentionDays") && value.schemaVersion===2 ? 30 : value?.historyRetentionDays) : 30;
  return { retentionDays:days, settingsRevision:row?.settings_revision ?? 0,
    policyRevision:createHash("sha256").update(JSON.stringify(["history-policy-v1",days])).digest("hex"),
    evaluatedAt:now, cutoffAt:days === 0 ? null : now-days*86_400_000 };
}
export function historyExpired(basis: number | null | undefined, policy: AppliedHistoryPolicy): boolean {
  return basis != null && policy.cutoffAt !== null && basis <= policy.cutoffAt;
}
/** All inputs originate in the validated policy/clock, never user SQL. */
export function retainedJobSql(policy: AppliedHistoryPolicy, alias = "jobs"): string {
  return `NOT EXISTS (SELECT 1 FROM work_history_state h WHERE h.job_id=${alias}.job_id AND h.expired_at IS NOT NULL)`+
    (policy.cutoffAt === null ? "" : ` AND (${alias}.ended_at IS NULL OR ${alias}.ended_at>${Math.floor(policy.cutoffAt)})`);
}
