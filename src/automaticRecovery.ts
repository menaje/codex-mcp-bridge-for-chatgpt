import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type AutomaticRecoveryKind = "recheck" | "retry-stop" | "release";
export type AutomaticRecoveryState = "retrying" | "resolved" | "blocked";
export type AutomaticRecoveryRecord = {
  key: string; scopeId: string; agentId: string; jobId?: string;
  kind: AutomaticRecoveryKind; state: AutomaticRecoveryState;
  attempts: number; createdAt: number; updatedAt: number; nextAttemptAt: number;
  reason: string; evidence?: string;
};
export type AutomaticRecoveryCandidate = Pick<AutomaticRecoveryRecord, "key" | "scopeId" | "agentId" | "jobId" | "kind">;
export type AutomaticRecoveryResult = { resolved: boolean; reason: string; evidence?: string; retryable?: boolean };
export const AUTOMATIC_RECOVERY_ATTEMPTS = 3;
const RETRY_DELAYS = [5_000, 30_000, 120_000];

export const AUTOMATIC_RECOVERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS automatic_recovery (
    recovery_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    job_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('recheck','retry-stop','release')),
    state TEXT NOT NULL CHECK(state IN ('retrying','resolved','blocked')),
    attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL, reason TEXT NOT NULL, evidence TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS automatic_recovery_scope ON automatic_recovery(scope_id,updated_at);
  CREATE INDEX IF NOT EXISTS automatic_recovery_job ON automatic_recovery(job_id);
`;

export function automaticRecoveryKey(kind: AutomaticRecoveryKind, identity: unknown): string {
  return createHash("sha256").update(JSON.stringify(["automatic-recovery-v1", kind, identity])).digest("hex");
}

/** Attempts are committed before dispatch, so restarting cannot reset a limit
 * or interpret an interrupted dispatch as evidence of successful cleanup. */
export class AutomaticRecoveryStore {
  constructor(private readonly db: Database.Database) { db.exec(AUTOMATIC_RECOVERY_SCHEMA); }

  get(key: string): AutomaticRecoveryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM automatic_recovery WHERE recovery_key=?").get(key);
    return row ? this.decode(row as Record<string, unknown>) : undefined;
  }

  list(scopeId?: string): AutomaticRecoveryRecord[] {
    return this.db.prepare(`SELECT * FROM automatic_recovery ${scopeId ? "WHERE scope_id=?" : ""}
      ORDER BY updated_at DESC,recovery_key`).all(...(scopeId ? [scopeId] : []))
      .map(row => this.decode(row as Record<string, unknown>));
  }

  begin(candidate: AutomaticRecoveryCandidate, now: number): AutomaticRecoveryRecord | undefined {
    const previous = this.get(candidate.key);
    if (previous && (previous.state !== "retrying" || previous.attempts >= AUTOMATIC_RECOVERY_ATTEMPTS || previous.nextAttemptAt > now)) return;
    const attempts = (previous?.attempts || 0) + 1;
    this.db.prepare(`INSERT INTO automatic_recovery
      (recovery_key,scope_id,agent_id,job_id,kind,state,attempts,created_at,updated_at,next_attempt_at,reason)
      VALUES (?,?,?,?,?,'retrying',?,?,?,?, 'inspection-pending')
      ON CONFLICT(recovery_key) DO UPDATE SET state='retrying',attempts=excluded.attempts,
        updated_at=excluded.updated_at,next_attempt_at=excluded.next_attempt_at,reason=excluded.reason,evidence=NULL`)
      .run(candidate.key,candidate.scopeId,candidate.agentId,candidate.jobId || null,candidate.kind,
        attempts,previous?.createdAt || now,now,now + RETRY_DELAYS[attempts - 1]!);
    return this.get(candidate.key);
  }

  finish(key: string, attempt: number, result: AutomaticRecoveryResult, now: number): void {
    const confirmed = result.resolved && Boolean(result.evidence);
    this.db.prepare(`UPDATE automatic_recovery SET state=?,updated_at=?,reason=?,evidence=?
      WHERE recovery_key=? AND attempts=? AND state='retrying'`).run(
      confirmed ? "resolved" : result.retryable === false || attempt >= AUTOMATIC_RECOVERY_ATTEMPTS ? "blocked" : "retrying",
      now,result.resolved && !confirmed ? "recovery-unconfirmed" : result.reason,confirmed ? result.evidence! : null,key,attempt);
  }

  reconcileInterrupted(now: number): void {
    this.db.prepare(`UPDATE automatic_recovery SET state='blocked',updated_at=?,reason='recovery-interrupted',evidence=NULL
      WHERE state='retrying' AND attempts>=?`).run(now,AUTOMATIC_RECOVERY_ATTEMPTS);
  }

  confirm(key: string, reason: string, evidence: string, now: number): void {
    if (!evidence) throw new Error("Recovery confirmation requires observed evidence.");
    this.db.prepare("UPDATE automatic_recovery SET state='resolved',reason=?,evidence=?,updated_at=? WHERE recovery_key=?")
      .run(reason,evidence,now,key);
  }

  prune(retentionDays: number, now = Date.now()): void {
    if (retentionDays === 0) return;
    // Keep every unresolved attempt budget while its original work still exists.
    this.db.prepare(`DELETE FROM automatic_recovery WHERE updated_at<? AND
      (state='resolved' OR NOT EXISTS (SELECT 1 FROM agents WHERE agent_id=automatic_recovery.agent_id)
       OR job_id IS NOT NULL AND EXISTS (SELECT 1 FROM work_history_state WHERE job_id=automatic_recovery.job_id AND expired_at IS NOT NULL))`)
      .run(now - retentionDays * 86_400_000);
  }

  private decode(row: Record<string, unknown>): AutomaticRecoveryRecord {
    return {key:String(row.recovery_key),scopeId:String(row.scope_id),agentId:String(row.agent_id),
      ...(row.job_id ? {jobId:String(row.job_id)} : {}),kind:row.kind as AutomaticRecoveryKind,state:row.state as AutomaticRecoveryState,
      attempts:Number(row.attempts),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),nextAttemptAt:Number(row.next_attempt_at),
      reason:String(row.reason),...(row.evidence ? {evidence:String(row.evidence)} : {})};
  }
}

export class AutomaticRecoveryController {
  lastError?: string;
  private timer?: NodeJS.Timeout;
  private scheduled?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private closed = false;
  private cursor = "";
  readonly now: () => number;
  constructor(private readonly store: AutomaticRecoveryStore, private readonly options: {
    candidates: () => AutomaticRecoveryCandidate[];
    attempt: (candidate: AutomaticRecoveryCandidate) => Promise<AutomaticRecoveryResult>;
    changed?: () => void; enabled?: () => boolean; now?: () => number; intervalMs?: number;
  }) { this.now = options.now || (() => Date.now()); }

  start(): void {
    if (this.closed || this.timer) return;
    this.store.reconcileInterrupted(this.now());
    this.timer = setInterval(() => { void this.sweep(); }, this.options.intervalMs ?? 5_000);
    this.timer.unref();
    this.schedule();
  }

  schedule(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.sweep(); }, 100);
    this.scheduled.unref();
  }

  sweep(jobId?: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.pending ||= this.runSweep(jobId).catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error);
    }).finally(() => { this.pending = undefined; });
  }

  async recoverJob(jobId: string): Promise<void> {
    await this.pending;
    await this.sweep(jobId);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearTimeout(this.scheduled);
    await this.pending;
  }

  private async runSweep(jobId?: string): Promise<void> {
    if (this.options.enabled?.() === false) return;
    const available = this.options.candidates();
    let keys = new Set(available.map(candidate => candidate.key));
    for (const record of this.store.list()) {
      if (record.state === "retrying" && !keys.has(record.key)) {
        this.store.finish(record.key,record.attempts,{resolved:false,reason:"work-changed",retryable:false},this.now());
        this.options.changed?.();
      }
    }
    const candidates = available.filter(candidate => !jobId || candidate.jobId === jobId).sort((a,b) => a.key.localeCompare(b.key));
    const after = candidates.filter(candidate => candidate.key > this.cursor);
    const before = candidates.filter(candidate => candidate.key <= this.cursor);
    let dispatched = 0;
    for (const candidate of [...after,...before]) {
      if (this.closed || dispatched >= 4) break;
      this.cursor = candidate.key;
      if (!keys.has(candidate.key)) continue;
      const attempt = this.store.begin(candidate,this.now());
      if (!attempt) continue;
      dispatched += 1;
      this.options.changed?.();
      let result: AutomaticRecoveryResult;
      try { result = await this.options.attempt(candidate); }
      catch { result = {resolved:false,reason:"recovery-unconfirmed"}; }
      this.store.finish(candidate.key,attempt.attempts,result,this.now());
      this.options.changed?.();
      // One verified shared-worker release can settle several initial
      // candidates. Do not invent another attempt for a peer already released.
      keys = new Set(this.options.candidates().map(current => current.key));
    }
  }
}
