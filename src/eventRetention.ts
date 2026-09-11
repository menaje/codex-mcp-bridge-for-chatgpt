import type Database from "better-sqlite3";
import { tokenCounts } from "./tokenUsage.js";

export const EVENT_RETENTION_LIMITS = { perJob: 256, rows: 50_000, bytes: 64 * 1024 * 1024, payloadBytes: 8192, metadataMs: 7 * 86400_000, batch: 500 };
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

/** Diagnostics are disposable; delivery, cancellation, question and replay authorities live elsewhere. */
export class EventRetention {
  constructor(private readonly db: Database.Database) {
    const policy = this.db.prepare("SELECT policy_version FROM event_retention_state WHERE singleton=1")
      .get() as {policy_version:number};
    if (policy.policy_version !== 2) this.db.transaction(() => {
      // Revisit rows already passed by v14's original, first-Job-only sweep.
      this.db.prepare(`UPDATE event_retention_state SET cursor_event_id=0,policy_version=2
        WHERE singleton=1`).run();
    })();
  }

  summary(jobId: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT summary FROM jobs WHERE job_id=?").get(jobId) as { summary: string } | undefined;
    return row ? sanitizeRetainedJobSummary(JSON.parse(row.summary)) : {};
  }

  acknowledgeUncertainResultReview(jobId: string, count: number, latestUpdateAt: number, reviewedAt: number): void {
    this.save(jobId, {...this.summary(jobId), uncertainResponseReview: {count, latestUpdateAt, reviewedAt}});
  }

  summarizeJob(job: Record<string, unknown>): void {
    const previous = this.summary(String(job.jobId));
    const execution = record(record(job.executionDecision).effectiveSelection);
    const reroute = (Array.isArray(job.publicEvents) ? [...job.publicEvents].reverse() : [])
      .map(record).find(event => event.type === "model" && record(event.details).kind === "rerouted");
    const reroutedModel = record(reroute?.details).toModel;
    const next = { ...previous,
      ...(execution.model ? { execution: { ...record(previous.execution), model: execution.model, reasoningEffort: execution.reasoningEffort, serviceTier: execution.serviceTier,
        ...(typeof reroutedModel === "string" ? {reroutedModel:reroutedModel.slice(0,120)} : {}) } } : {}) };
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
    if (payload.type === "model" && details.kind === "rerouted" && typeof details.toModel === "string") {
      const summary = this.summary(input.jobId);
      summary.execution = { ...record(summary.execution), reroutedModel: details.toModel.slice(0, 120) };
      this.save(input.jobId, summary);
    }
    if (archived) return JSON.stringify({ metadataOnly: true, type: input.eventType });
    if (coalesce && input.eventType.startsWith("app-")) {
      const itemId = typeof details.itemId === "string" ? details.itemId : "";
      const pattern = typeof payload.type === "string" ? `app-${payload.type}-%` : input.eventType;
      this.db.prepare(`DELETE FROM job_events WHERE job_id=? AND event_type LIKE ?
        AND COALESCE(json_extract(payload,'$.details.itemId'),'')=?`).run(input.jobId, pattern, itemId);
    }
    const encoded = JSON.stringify(input.payload ?? null);
    return Buffer.byteLength(encoded) <= EVENT_RETENTION_LIMITS.payloadBytes ? encoded
      : JSON.stringify({ type: payload.type, phase: payload.phase, summary: typeof payload.summary === "string" ? payload.summary.slice(0, 512) : undefined,
        details: { itemId: typeof details.itemId === "string" ? details.itemId.slice(0, 200) : undefined }, truncated: true });
  }

  enforce(jobId: string): void {
    this.enforcePerJob(jobId);
    this.enforceBudget();
  }

  private enforcePerJob(jobId: string): void {
    if (!this.summary(jobId).usage) {
      const usage = this.db.prepare("SELECT payload FROM job_events WHERE job_id=? AND event_type LIKE 'app-usage%' ORDER BY event_id DESC LIMIT 1").get(jobId) as {payload:string} | undefined;
      if (usage) this.prepare({jobId,eventType:"app-usage",payload:JSON.parse(usage.payload)}, true, false);
    }
    this.db.prepare(`DELETE FROM job_events WHERE job_id=? AND event_id NOT IN
      (SELECT event_id FROM job_events WHERE job_id=? ORDER BY event_id DESC LIMIT ?)`).run(jobId, jobId, EVENT_RETENTION_LIMITS.perJob);
  }

  private enforceBudget(): void {
    // Fixed chunks amortize budget checks and avoid retaining a single oversized legacy row.
    for (let batch = 0; batch < 10; batch++) {
      const budget = this.db.prepare("SELECT rows,bytes FROM event_budget WHERE id=1").get() as { rows: number; bytes: number };
      if (budget.rows <= EVENT_RETENTION_LIMITS.rows && budget.bytes <= EVENT_RETENTION_LIMITS.bytes) break;
      const oldest = this.db.prepare("SELECT event_id,job_id,event_type,payload FROM job_events ORDER BY event_id LIMIT 500").all() as Array<{event_id:number;job_id:string;event_type:string;payload:string}>;
      for (const row of oldest) if (row.event_type.startsWith("app-usage")) this.prepare({ jobId: row.job_id, eventType: row.event_type, payload: JSON.parse(row.payload) }, true, false);
      this.db.prepare("DELETE FROM job_events WHERE event_id IN (SELECT event_id FROM job_events ORDER BY event_id LIMIT 500)").run();
    }
  }

  /** One restartable migration slice; no VACUUM or long write lock during live work. */
  sweep(now = Date.now()): { processed: number; rows: number; bytes: number; freePages: number } {
    const saved = this.db.prepare("SELECT cursor_event_id FROM event_retention_state WHERE singleton=1")
      .get() as {cursor_event_id:number};
    const cursor = saved.cursor_event_id;
    const rows = this.db.prepare(`SELECT e.event_id,e.job_id,e.event_type,e.payload,j.archived_at FROM job_events e
      JOIN jobs j ON j.job_id=e.job_id WHERE e.event_id>? ORDER BY e.event_id LIMIT ?`).all(cursor, EVENT_RETENTION_LIMITS.batch) as Array<{event_id:number;job_id:string;event_type:string;payload:string;archived_at:number|null}>;
    for (const row of rows) {
      const payload = this.prepare({ jobId: row.job_id, eventType: row.event_type, payload: JSON.parse(row.payload) }, row.archived_at !== null, false);
      this.db.prepare("UPDATE job_events SET payload=? WHERE event_id=?").run(payload, row.event_id);
    }
    this.db.prepare("UPDATE event_retention_state SET cursor_event_id=? WHERE singleton=1")
      .run(rows.at(-1)?.event_id || cursor);
    const expired = this.db.prepare("SELECT event_id,job_id,event_type,payload FROM job_events WHERE created_at<? ORDER BY event_id LIMIT 500").all(now - EVENT_RETENTION_LIMITS.metadataMs) as Array<{event_id:number;job_id:string;event_type:string;payload:string}>;
    for (const row of expired) {
      if (row.event_type.startsWith("app-usage")) this.prepare({jobId:row.job_id,eventType:row.event_type,payload:JSON.parse(row.payload)}, true, false);
      this.db.prepare("DELETE FROM job_events WHERE event_id=?").run(row.event_id);
    }
    // Activity events contain control metadata, never model output. They are also bounded.
    this.db.prepare("DELETE FROM activity_events WHERE event_id IN (SELECT event_id FROM activity_events ORDER BY event_id DESC LIMIT 500 OFFSET 50000)").run();
    this.db.prepare("DELETE FROM activity_events WHERE event_id IN (SELECT event_id FROM activity_events WHERE created_at<? ORDER BY event_id LIMIT 500)").run(now - EVENT_RETENTION_LIMITS.metadataMs);
    this.db.prepare("DELETE FROM result_holds WHERE job_id IN (SELECT job_id FROM result_holds WHERE expires_at<=? LIMIT 500)").run(now);
    for (const jobId of new Set(rows.map(row => row.job_id))) this.enforcePerJob(jobId);
    this.enforceBudget();
    const budget = this.db.prepare("SELECT rows,bytes FROM event_budget WHERE id=1").get() as {rows:number;bytes:number};
    return { processed: rows.length, ...budget, freePages: Number(this.db.pragma("freelist_count", { simple: true })) };
  }

  private save(jobId: string, summary: Record<string, unknown>): void {
    this.db.prepare("UPDATE jobs SET summary=? WHERE job_id=?")
      .run(JSON.stringify(sanitizeRetainedJobSummary(summary)), jobId);
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
