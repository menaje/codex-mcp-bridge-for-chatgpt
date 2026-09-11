import * as z from "zod/v4";
import type Database from "better-sqlite3";
import { problemKey, problemRevision } from "./problemReview.js";

export const HISTORY_RETENTION_DAYS = [7, 30, 90, 0] as const;
export type HistoryRetentionDays = (typeof HISTORY_RETENTION_DAYS)[number];
const dashboardHistoryActionBase = {
  rowKey: z.string().regex(/^[a-f0-9]{32}$/), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid()
} as const;
/** Current public history mutation contract. */
export const dashboardHistoryActionInput = z.strictObject({
  ...dashboardHistoryActionBase,
  action: z.literal("acknowledge")
});
/** Runtime compatibility parser for already-mounted cards and older native clients. */
export const dashboardHistoryRuntimeInput = z.strictObject({
  ...dashboardHistoryActionBase,
  action: z.enum(["acknowledge", "archive", "restore"])
});
export type DashboardHistoryActionInput = z.infer<typeof dashboardHistoryRuntimeInput>;
export type HistoryJobIdentity = {jobId:string;activityId:string;status:string;updatedAt:number};
export const DEFAULT_HISTORY_RETENTION_DAYS: HistoryRetentionDays = 30;
export const ISSUE_ATTENTION_DAYS = 7;
/** Upgrade-only schema introduced at v15. Current databases use stateSchema.ts. */
export const V15_WORK_HISTORY_MIGRATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS work_history_state (
    job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
    acknowledged_at INTEGER,
    expired_at INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS work_history_expired ON work_history_state(expired_at);
`;

export function historyRetentionDays(value: unknown): HistoryRetentionDays {
  return HISTORY_RETENTION_DAYS.includes(value as HistoryRetentionDays)
    ? value as HistoryRetentionDays : DEFAULT_HISTORY_RETENTION_DAYS;
}

export type WorkHistoryPolicy = {
  retentionDays: HistoryRetentionDays;
  issueAttentionDays: number;
  lastCleanupAt: string | null;
  lastCleanupCount: number;
  totalRemoved: number;
  reviewUntilRetention: boolean;
  automaticRecovery: boolean;
};

export type HistoryProblemJob = HistoryJobIdentity & {
  scopeId: string; agentId: string | null; acknowledgedAt: number | null;
  problemKey: string; revision: string;
};

/** Presentation/outcome retention never removes the authoritative replay receipt,
 * Agent, thread identity, project pins, or cancellation/delivery journals. */
export class WorkHistoryStore {
  constructor(private readonly db: Database.Database) {}

  latestJob(agentId: string): HistoryJobIdentity | undefined {
    const row = this.db.prepare(`SELECT job_id,activity_id,status,updated_at FROM jobs j WHERE agent_id=?
      AND NOT EXISTS (SELECT 1 FROM work_history_state h WHERE h.job_id=j.job_id AND h.expired_at IS NOT NULL)
      ORDER BY created_at DESC,updated_at DESC,job_id DESC LIMIT 1`)
      .get(agentId) as {job_id:string;activity_id:string;status:string;updated_at:number} | undefined;
    return row ? {jobId:row.job_id,activityId:row.activity_id,status:row.status,updatedAt:row.updated_at} : undefined;
  }

  acknowledgedJobIds(scopeId?: string): Set<string> {
    return new Set((this.db.prepare(`SELECT h.job_id FROM work_history_state h
      JOIN jobs j ON j.job_id=h.job_id WHERE h.acknowledged_at IS NOT NULL
      ${scopeId ? "AND j.scope_id=?" : ""}`).all(...(scopeId ? [scopeId] : [])) as Array<{job_id:string}>).map(row => row.job_id));
  }

  acknowledge(jobId: string, now = Date.now()): void {
    this.setAcknowledged(jobId, true, now);
  }

  setAcknowledged(jobId: string, acknowledged: boolean, now = Date.now()): void {
    const job = this.db.prepare("SELECT status FROM jobs WHERE job_id=?").get(jobId) as {status:string} | undefined;
    if (!job || !["failed", "interrupted"].includes(job.status) || this.expired(jobId)) {
      throw new Error("HISTORY_TARGET_CHANGED: Refresh this execution before acknowledging it.");
    }
    const previous = this.db.prepare("SELECT acknowledged_at FROM work_history_state WHERE job_id=?").get(jobId) as {acknowledged_at:number|null} | undefined;
    if (Boolean(previous?.acknowledged_at) === acknowledged) return;
    const nextRevision = this.reviewRevision() + 1;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO work_history_state(job_id,acknowledged_at,review_sequence) VALUES (?,?,?)
        ON CONFLICT(job_id) DO UPDATE SET acknowledged_at=excluded.acknowledged_at,
          review_sequence=excluded.review_sequence`).run(jobId, acknowledged ? now : null, nextRevision);
      this.db.prepare("UPDATE work_history_control SET review_revision=? WHERE singleton=1")
        .run(nextRevision);
    })();
  }

  reviewRevision(): number {
    const row = this.db.prepare("SELECT review_revision FROM work_history_control WHERE singleton=1")
      .get() as {review_revision:number};
    return row.review_revision;
  }

  runtimeResolution(agentId: string, revision: string): number | null {
    const row = this.db.prepare("SELECT revision,resolved_at FROM runtime_problem_resolutions WHERE agent_id=?")
      .get(agentId) as {revision:string;resolved_at:number} | undefined;
    if (!row) return null;
    return row.revision === revision ? row.resolved_at : null;
  }

  resolveRuntimeProblem(agentId: string, revision: string, now = Date.now()): void {
    if (this.runtimeResolution(agentId,revision)) return;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO runtime_problem_resolutions(agent_id,revision,resolved_at) VALUES (?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET revision=excluded.revision,resolved_at=excluded.resolved_at`)
        .run(agentId,revision,now);
      this.db.prepare("UPDATE work_history_control SET review_revision=review_revision+1 WHERE singleton=1").run();
    })();
  }

  problemJobs(scopeId?: string): HistoryProblemJob[] {
    const rows = this.db.prepare(`SELECT j.job_id,j.scope_id,j.agent_id,j.activity_id,j.status,j.updated_at,h.acknowledged_at,h.review_sequence AS review_seq
      FROM jobs j LEFT JOIN work_history_state h ON h.job_id=j.job_id
      WHERE j.status IN ('failed','interrupted') AND h.expired_at IS NULL ${scopeId ? "AND j.scope_id=?" : ""}
      ORDER BY j.updated_at DESC,j.job_id`).all(...(scopeId ? [scopeId] : [])) as Array<{
        job_id:string;scope_id:string;agent_id:string|null;activity_id:string;status:string;updated_at:number;acknowledged_at:number|null;review_seq:number|null;
      }>;
    return rows.map(row => ({jobId:row.job_id,scopeId:row.scope_id,agentId:row.agent_id,activityId:row.activity_id,
      status:row.status,updatedAt:row.updated_at,acknowledgedAt:row.acknowledged_at,
      problemKey:problemKey("execution",row.job_id),
      revision:problemRevision(["execution",row.job_id,row.status,row.updated_at,row.acknowledged_at,row.review_seq || "0"])}));
  }

  expired(jobId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM work_history_state WHERE job_id=? AND expired_at IS NOT NULL").get(jobId));
  }

  policy(days: HistoryRetentionDays): WorkHistoryPolicy {
    const cleanup = this.db.prepare(`SELECT last_cleanup_at,last_cleanup_count,total_removed
      FROM work_history_control WHERE singleton=1`).get() as {
        last_cleanup_at:number|null;last_cleanup_count:number;total_removed:number;
      };
    return { retentionDays: days, issueAttentionDays: ISSUE_ATTENTION_DAYS,
      lastCleanupAt: cleanup.last_cleanup_at === null ? null : new Date(cleanup.last_cleanup_at).toISOString(),
      lastCleanupCount: cleanup.last_cleanup_count, totalRemoved: cleanup.total_removed,
      reviewUntilRetention: true, automaticRecovery:true };
  }

  /** Bounded maintenance. Protected results and live work remain intact. */
  sweep(days: HistoryRetentionDays, isProtected: (jobId: string) => boolean, now = Date.now()): number {
    if (days === 0) return 0;
    const cursor = this.db.prepare(`SELECT cursor_updated_at AS at,cursor_job_id AS id
      FROM work_history_control WHERE singleton=1`).get() as {at:number;id:string};
    const candidates = this.db.prepare(`SELECT j.job_id,j.scope_id,j.request_id,j.activity_id,j.status,
      j.updated_at,j.archived_at,j.terminal_version FROM jobs j
      WHERE j.archived_at IS NOT NULL AND j.status IN ('completed','failed','interrupted','cancelled')
      AND j.updated_at<? AND (j.updated_at>? OR (j.updated_at=? AND j.job_id>?))
      AND NOT EXISTS (SELECT 1 FROM work_history_state h WHERE h.job_id=j.job_id AND h.expired_at IS NOT NULL)
      ORDER BY j.updated_at,j.job_id LIMIT 500`).all(now - days * 86400_000,cursor.at,cursor.at,cursor.id) as Array<{
        job_id:string;scope_id:string;request_id:string;activity_id:string;status:string;updated_at:number;archived_at:number;terminal_version:number|null;
      }>;
    const last = candidates.length === 500 ? candidates[candidates.length-1] : undefined;
    this.db.prepare(`UPDATE work_history_control SET cursor_updated_at=?,cursor_job_id=?
      WHERE singleton=1`).run(last?.updated_at || 0,last?.job_id || "");
    let removed = 0;
    for (const row of candidates) {
      if (isProtected(row.job_id)) continue;
      // Keep the exact request reservation and terminal outcome required for
      // replay prevention. Remove display details and all disposable events.
      const receipt = {resultOmitted:true,historyExpired:true};
      this.db.prepare("UPDATE jobs SET payload=? WHERE job_id=?").run(JSON.stringify(receipt),row.job_id);
      this.db.prepare("UPDATE jobs SET summary='{}' WHERE job_id=?").run(row.job_id);
      this.db.prepare("DELETE FROM job_events WHERE job_id=?").run(row.job_id);
      this.db.prepare(`INSERT INTO work_history_state(job_id,expired_at) VALUES (?,?)
        ON CONFLICT(job_id) DO UPDATE SET expired_at=excluded.expired_at`).run(row.job_id,now);
      removed++;
    }
    if (removed) {
      this.db.prepare(`UPDATE work_history_control SET last_cleanup_at=?,last_cleanup_count=?,
        total_removed=total_removed+? WHERE singleton=1`).run(now,removed,removed);
    }
    return removed;
  }
}
