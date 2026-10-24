import { readAppliedHistoryPolicy } from "./historyPolicy.js";
import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { tokenCounts } from "./tokenUsage.js";
import { parseJsonTextStrict } from "./textIntegrity.js";
import { retainedExecutionSummary } from "./executionAudit.js";

export const EVENT_RETENTION_LIMITS = { perJob: 256, rows: 50_000, bytes: 64 * 1024 * 1024, payloadBytes: 8192, metadataMs: 7 * 86400_000, batch: 64 };
/** Upgrade-only schema introduced at v14. Current databases use stateSchema.ts. */
export const V14_EVENT_RETENTION_MIGRATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS job_summaries(job_id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS result_holds(job_id TEXT PRIMARY KEY, reason TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS event_budget(id INTEGER PRIMARY KEY CHECK(id=1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT;
  INSERT OR IGNORE INTO event_budget SELECT 1,COUNT(*),COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM job_events;
  CREATE TRIGGER IF NOT EXISTS event_budget_insert AFTER INSERT ON job_events BEGIN
    UPDATE event_budget SET rows=rows+1,bytes=bytes+length(CAST(NEW.payload AS BLOB)) WHERE id=1; END;
  CREATE TRIGGER IF NOT EXISTS event_budget_delete AFTER DELETE ON job_events BEGIN
    UPDATE event_budget SET rows=rows-1,bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE id=1; END;
  CREATE TRIGGER IF NOT EXISTS event_budget_update AFTER UPDATE OF payload ON job_events BEGIN
    UPDATE event_budget SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE id=1; END;
`;

type EventInput = { jobId: string; eventType: string; payload: unknown };
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

export type EventRetentionJobRepository = {
  readSummary(jobId: string): Record<string, unknown>;
  saveSummary(jobId: string, summary: Record<string, unknown>): void;
};

export type EventRetentionMaintenanceRepository = {
  deleteActivityEvents(olderThan: number, batchSize: number, retainedLimit: number, now?: number): number;
  deleteExpiredResultHolds(now: number, limit: number): number;
};

/** Diagnostics are disposable; delivery, cancellation, question and replay authorities live elsewhere. */
export class EventRetention {
  constructor(
    private readonly db: Database.Database,
    private readonly jobs: EventRetentionJobRepository,
    private readonly maintenance: EventRetentionMaintenanceRepository,
    options: { readOnly?: boolean } = {}
  ) {
    const policy = this.db.prepare("SELECT policy_version FROM event_retention_state WHERE singleton=1")
      .get() as {policy_version:number};
    if (!options.readOnly && policy.policy_version !== 2) this.db.transaction(() => {
      // Revisit rows already passed by v14's original, first-Job-only sweep.
      this.db.prepare(`UPDATE event_retention_state SET cursor_event_id=0,policy_version=2
        WHERE singleton=1`).run();
    })();
  }

  summary(jobId: string): Record<string, unknown> {
    return this.jobs.readSummary(jobId);
  }

  acknowledgeUncertainResultReview(jobId: string, count: number, latestUpdateAt: number, reviewedAt: number): void {
    this.save(jobId, {...this.summary(jobId), uncertainResponseReview: {count, latestUpdateAt, reviewedAt}});
  }

  summarizeJob(job: Record<string, unknown>): void {
    const previous = this.summary(String(job.jobId));
    const execution = retainedExecutionSummary(job);
    const next = { ...previous, ...(execution ? { execution } : {}) };
    this.save(String(job.jobId), next);
  }

  prepare(input: EventInput, archived = false, coalesce = true): string {
    const payload = record(input.payload);
    const details = record(payload.details);
    if (input.eventType.startsWith("app-usage")) {
      const usage = record(details.jobUsage);
      const counts = tokenCounts(usage.tokens);
      const summary = this.summary(input.jobId);
      const observed = usage.basis === "cumulative-difference" && counts
        ? { basis: "cumulative-difference", tokens: counts }
        : { basis: "unknown", reason: typeof usage.reason === "string" ? usage.reason.slice(0, 100) : "legacy-thread-counter",
          lastRequestTokens: tokenCounts(details.last), threadCounterTokens: tokenCounts(details.total) };
      if (coalesce || !summary.usage) { summary.usage = observed; this.save(input.jobId, summary); }
    }
    if (payload.type === "model" && details.kind === "rerouted" && details.serverCorrelation === "explicit" && typeof details.toModel === "string") {
      const origin = this.db.prepare("SELECT thread_id,upstream_request_id FROM jobs WHERE job_id=?").get(input.jobId) as { thread_id: string | null; upstream_request_id: string | null } | undefined;
      const summary = this.summary(input.jobId);
      if (origin?.thread_id && origin.upstream_request_id && details.threadId === origin.thread_id && details.turnId === origin.upstream_request_id) {
        summary.execution = { ...record(summary.execution), reroutedModel: details.toModel.slice(0, 120) };
        this.save(input.jobId, summary);
      }
    }
    // Archiving does not change the lifetime or content of durable diagnostics.
    return JSON.stringify(input.payload ?? null);
  }

  /** Per-Job/global limits apply to presentation, never durable history. */
  enforce(_jobId: string): void {}

  sweep(now = Date.now()) {
    const policy=readAppliedHistoryPolicy(this.db,now);
    let expiredJobEventsRemoved=0,expiredActivityEventsRemoved=0;
    if (policy.cutoffAt !== null) {
      expiredJobEventsRemoved=this.db.prepare(`DELETE FROM job_events WHERE event_id IN (
        SELECT e.event_id FROM job_events e JOIN jobs j ON j.job_id=e.job_id
        WHERE j.ended_at<=? AND j.status IN ('completed','failed','interrupted','cancelled')
        ORDER BY e.event_id LIMIT ?)`).run(policy.cutoffAt,EVENT_RETENTION_LIMITS.batch).changes;
      expiredActivityEventsRemoved=this.maintenance.deleteActivityEvents(policy.cutoffAt,EVENT_RETENTION_LIMITS.batch,0,now);
    }
    const expiredResultHoldsRemoved=this.maintenance.deleteExpiredResultHolds(now,EVENT_RETENTION_LIMITS.batch);
    const budget=this.db.prepare("SELECT rows,bytes FROM event_budget WHERE id=1").get() as {rows:number;bytes:number};
    return {processed:0,...budget,freePages:Number(this.db.pragma("freelist_count",{simple:true})),
      expiredJobEventsRemoved,expiredActivityEventsRemoved,expiredResultHoldsRemoved,
      perJobEventsRemoved:0,budgetEventsRemoved:0};
  }

  private save(jobId: string, summary: Record<string, unknown>): void {
    this.jobs.saveSummary(jobId, sanitizeRetainedJobSummary(summary));
  }

  /** Event-domain command used by the state Unit of Work during history expiry. */
  deleteJobEventsForHistory(jobId: string): number {
    return this.db.prepare("DELETE FROM job_events WHERE job_id=?").run(jobId).changes;
  }
}

function parseStoredJson(value: string, label: string): unknown {
  try {
    return parseJsonTextStrict(value, `bridge state ${label}`);
  } catch (error) {
    throw new Error(`Invalid ${label} in the bridge state database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Keep only bounded projections that have a current reader. Job lifecycle fields live in columns. */
export function sanitizeRetainedJobSummary(value: unknown): Record<string, unknown> {
  const source = record(value);
  const summary: Record<string, unknown> = {};
  for (const key of ["execution", "usage", "uncertainResponseReview"] as const) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      summary[key] = source[key];
    }
  }
  return summary;
}
