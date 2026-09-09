import * as z from "zod/v4";
import type Database from "better-sqlite3";
import { problemKey, problemRevision } from "./problemReview.js";

export const HISTORY_RETENTION_DAYS = [7, 30, 90, 0] as const;
export type HistoryRetentionDays = (typeof HISTORY_RETENTION_DAYS)[number];
export const dashboardHistoryActionInput = z.strictObject({
  rowKey: z.string().regex(/^[a-f0-9]{32}$/), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(["acknowledge", "archive", "restore"]), requestId: z.string().uuid()
});
export type DashboardHistoryActionInput = z.infer<typeof dashboardHistoryActionInput>;
export type HistoryJobIdentity = {jobId:string;activityId:string;status:string;updatedAt:number};
export const DEFAULT_HISTORY_RETENTION_DAYS: HistoryRetentionDays = 30;
export const ISSUE_ATTENTION_DAYS = 7;
export const WORK_HISTORY_SCHEMA = `
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
      ORDER BY COALESCE(json_extract(payload,'$.createdAt'),updated_at) DESC,updated_at DESC,job_id DESC LIMIT 1`)
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
    this.db.prepare(`INSERT INTO work_history_state(job_id,acknowledged_at) VALUES (?,?)
      ON CONFLICT(job_id) DO UPDATE SET acknowledged_at=excluded.acknowledged_at`).run(jobId, acknowledged ? now : null);
    this.db.prepare("INSERT OR REPLACE INTO bridge_meta(key,value) VALUES ('work_history_review_revision',?)")
      .run(String(this.reviewRevision() + 1));
    this.db.prepare("INSERT OR REPLACE INTO bridge_meta(key,value) VALUES (?,?)")
      .run(`work_history_review_seq:${jobId}`,String(this.reviewRevision()));
  }

  reviewRevision(): number {
    const row = this.db.prepare("SELECT value FROM bridge_meta WHERE key='work_history_review_revision'").get() as {value:string} | undefined;
    return Number(row?.value || 0);
  }

  runtimeResolution(agentId: string, revision: string): number | null {
    const row = this.db.prepare("SELECT value FROM bridge_meta WHERE key=?")
      .get(`runtime_problem_resolved:${agentId}`) as {value:string} | undefined;
    if (!row) return null;
    const value = JSON.parse(row.value) as {revision:string;at:number};
    return value.revision === revision ? value.at : null;
  }

  resolveRuntimeProblem(agentId: string, revision: string, now = Date.now()): void {
    if (this.runtimeResolution(agentId,revision)) return;
    this.db.prepare("INSERT OR REPLACE INTO bridge_meta(key,value) VALUES (?,?)")
      .run(`runtime_problem_resolved:${agentId}`,JSON.stringify({revision,at:now}));
    this.db.prepare("INSERT OR REPLACE INTO bridge_meta(key,value) VALUES ('work_history_review_revision',?)")
      .run(String(this.reviewRevision() + 1));
  }

  problemJobs(scopeId?: string): HistoryProblemJob[] {
    const rows = this.db.prepare(`SELECT j.job_id,j.scope_id,j.agent_id,j.activity_id,j.status,j.updated_at,h.acknowledged_at,r.value AS review_seq
      FROM jobs j LEFT JOIN work_history_state h ON h.job_id=j.job_id
      LEFT JOIN bridge_meta r ON r.key='work_history_review_seq:' || j.job_id
      WHERE j.status IN ('failed','interrupted') AND h.expired_at IS NULL ${scopeId ? "AND j.scope_id=?" : ""}
      ORDER BY j.updated_at DESC,j.job_id`).all(...(scopeId ? [scopeId] : [])) as Array<{
        job_id:string;scope_id:string;agent_id:string|null;activity_id:string;status:string;updated_at:number;acknowledged_at:number|null;review_seq:string|null;
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
    const row = this.db.prepare("SELECT value FROM bridge_meta WHERE key='work_history_cleanup'").get() as {value:string} | undefined;
    const cleanup = row ? JSON.parse(row.value) as {at:number;count:number;total:number} : undefined;
    return { retentionDays: days, issueAttentionDays: ISSUE_ATTENTION_DAYS,
      lastCleanupAt: cleanup ? new Date(cleanup.at).toISOString() : null,
      lastCleanupCount: cleanup?.count || 0, totalRemoved: cleanup?.total || 0, reviewUntilRetention: true };
  }

  /** Bounded maintenance. Protected results and live work remain intact. */
  sweep(days: HistoryRetentionDays, isProtected: (jobId: string) => boolean, now = Date.now()): number {
    if (days === 0) return 0;
    const saved = this.db.prepare("SELECT value FROM bridge_meta WHERE key='work_history_cursor'").get() as {value:string} | undefined;
    const cursor = saved ? JSON.parse(saved.value) as {at:number;id:string} : {at:0,id:""};
    const candidates = this.db.prepare(`SELECT j.job_id,j.scope_id,j.request_id,j.activity_id,j.status,
      j.updated_at,j.archived_at,j.terminal_version FROM jobs j
      WHERE j.archived_at IS NOT NULL AND j.status IN ('completed','failed','interrupted','cancelled')
      AND j.updated_at<? AND (j.updated_at>? OR (j.updated_at=? AND j.job_id>?))
      AND NOT EXISTS (SELECT 1 FROM work_history_state h WHERE h.job_id=j.job_id AND h.expired_at IS NOT NULL)
      ORDER BY j.updated_at,j.job_id LIMIT 500`).all(now - days * 86400_000,cursor.at,cursor.at,cursor.id) as Array<{
        job_id:string;scope_id:string;request_id:string;activity_id:string;status:string;updated_at:number;archived_at:number;terminal_version:number|null;
      }>;
    const last = candidates.length === 500 ? candidates[candidates.length-1] : undefined;
    this.db.prepare("INSERT OR REPLACE INTO bridge_meta(key,value) VALUES ('work_history_cursor',?)")
      .run(JSON.stringify(last ? {at:last.updated_at,id:last.job_id} : {at:0,id:""}));
    let removed = 0;
    for (const row of candidates) {
      if (isProtected(row.job_id)) continue;
      // Keep the exact request reservation and terminal outcome required for
      // replay prevention. Remove display details and all disposable events.
      const receipt = {jobId:row.job_id,scopeId:row.scope_id,requestId:row.request_id,activityId:row.activity_id,
        status:row.status,updatedAt:row.updated_at,archivedAt:row.archived_at,terminalVersion:row.terminal_version,
        resultOmitted:true,historyExpired:true};
      this.db.prepare("UPDATE jobs SET payload=? WHERE job_id=?").run(JSON.stringify(receipt),row.job_id);
      this.db.prepare("DELETE FROM job_summaries WHERE job_id=?").run(row.job_id);
      this.db.prepare("DELETE FROM job_events WHERE job_id=?").run(row.job_id);
      this.db.prepare("DELETE FROM bridge_meta WHERE key=?").run(`work_history_review_seq:${row.job_id}`);
      this.db.prepare(`INSERT INTO work_history_state(job_id,expired_at) VALUES (?,?)
        ON CONFLICT(job_id) DO UPDATE SET expired_at=excluded.expired_at`).run(row.job_id,now);
      removed++;
    }
    if (removed) {
      const previous = this.policy(days);
      this.db.prepare("INSERT OR REPLACE INTO bridge_meta(key,value) VALUES ('work_history_cleanup',?)")
        .run(JSON.stringify({at:now,count:removed,total:previous.totalRemoved+removed}));
    }
    return removed;
  }
}
