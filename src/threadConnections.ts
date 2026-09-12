import type Database from "better-sqlite3";
import type { CodexUpstream } from "./upstream.js";

export type ThreadPersistence = "persistent" | "ephemeral" | "unknown";
export type ThreadConnectionPhase = "connected" | "waiting" | "releasing" | "unsubscribed" | "released" | "blocked";
export type ThreadReleaseEvidence = "thread-unloaded" | "worker-exited";
export type ThreadConnectionRecord = {
  threadId: string;
  agentId?: string;
  scopeId: string;
  persistence: ThreadPersistence;
  phase: ThreadConnectionPhase;
  handoffRequested: boolean;
  lastFinishedAt?: number;
  lastJobId?: string;
  workerPid?: number;
  revision: number;
  updatedAt: number;
  reason?: string;
  evidence?: ThreadReleaseEvidence;
};

export type ThreadReleaseResult = {
  phase: "blocked" | "unsubscribed" | "released";
  reason?: string;
  evidence?: ThreadReleaseEvidence;
  releasedThreadIds?: string[];
};

export type ThreadReleaseOptions = {
  /** Rechecked synchronously immediately before each unsubscribe or process close. */
  canRelease: (threadId: string) => boolean;
  eligibleThreadIds: readonly string[];
  previousWorkerPid?: number;
};

/** Upgrade-only schema introduced at v14. Current databases use stateSchema.ts. */
export const V14_THREAD_CONNECTION_MIGRATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS thread_connections (
    thread_id TEXT PRIMARY KEY, agent_id TEXT, scope_id TEXT NOT NULL,
    persistence TEXT NOT NULL CHECK(persistence IN ('persistent','ephemeral','unknown')),
    phase TEXT NOT NULL, handoff_requested INTEGER NOT NULL DEFAULT 0,
    last_finished_at INTEGER, last_job_id TEXT, worker_pid INTEGER,
    revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
    reason TEXT, evidence TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS thread_connections_idle ON thread_connections(phase, last_finished_at);
  CREATE INDEX IF NOT EXISTS thread_connections_agent ON thread_connections(agent_id);
`;

/** Durable connection intent is independent of Agent/Job outcome and UI reads. */
export class ThreadConnectionStore {
  constructor(private readonly db: Database.Database) {}

  get(threadId: string): ThreadConnectionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM thread_connections WHERE thread_id = ?").get(threadId);
    return row ? this.decode(row as Record<string, unknown>) : undefined;
  }

  list(): ThreadConnectionRecord[] {
    return this.db.prepare("SELECT * FROM thread_connections ORDER BY updated_at, thread_id").all()
      .map(row => this.decode(row as Record<string, unknown>));
  }

  register(input: { threadId: string; agentId?: string; scopeId: string; persistence?: ThreadPersistence; workerPid?: number }, now = Date.now()): void {
    const previous = this.get(input.threadId);
    const persistence = input.persistence === "unknown" || !input.persistence
      ? previous?.persistence || "unknown" : input.persistence;
    if (previous && previous.persistence !== "unknown" && persistence !== previous.persistence) {
      throw new Error("THREAD_PERSISTENCE_CONFLICT: Existing conversation storage cannot be changed in place.");
    }
    this.db.prepare(`INSERT INTO thread_connections(thread_id,agent_id,scope_id,persistence,phase,worker_pid,updated_at)
      VALUES (?,?,?,?,'connected',?,?) ON CONFLICT(thread_id) DO UPDATE SET
      agent_id=COALESCE(excluded.agent_id,thread_connections.agent_id),scope_id=excluded.scope_id,
      persistence=excluded.persistence,worker_pid=COALESCE(excluded.worker_pid,thread_connections.worker_pid)`).run(
      input.threadId, input.agentId || null, input.scopeId, persistence, input.workerPid || null, now);
  }

  assertAdmission(agentId?: string, threadId?: string): void {
    const blocked = this.db.prepare(`SELECT 1 FROM thread_connections
      WHERE (thread_id = ? OR agent_id = ?) AND (phase = 'releasing' OR (handoff_requested = 1 AND phase != 'released')) LIMIT 1`)
      .get(threadId || null, agentId || null);
    if (blocked) throw new Error("AGENT_HANDOFF_PENDING: Conversation release is pending. Wait for it or cancel the handoff before starting another turn.");
  }

  supersedeHandoffs(agentId: string, currentThreadId: string, now: number): void {
    this.db.prepare(`UPDATE thread_connections SET handoff_requested=0,phase='blocked',reason='target-changed',evidence=NULL,
      revision=revision+1,updated_at=? WHERE agent_id=? AND thread_id!=? AND handoff_requested=1 AND phase!='releasing'`)
      .run(now,agentId,currentThreadId);
  }

  /** Called in the same transaction that commits the actual Job transition. */
  recordJob(job: {
    jobId: string; agentId?: string; scopeId: string; backendKind?: string; threadId?: string;
    sessionDecision?: { threadId?: string }; status: string; updatedAt: number;
    workerPid?: number; upstreamRequestId?: string; threadPersistence?: ThreadPersistence;
    terminalOrigin?: string;
    error?: string;
  }, previousStatus?: string): void {
    const threadId = job.threadId || job.sessionDecision?.threadId;
    if (!threadId || job.backendKind !== "app-server") return;
    this.register({ threadId, agentId: job.agentId, scopeId: job.scopeId,
      persistence: job.threadPersistence, workerPid: job.workerPid }, job.updatedAt);
    if (job.status === "failed" && job.error?.startsWith("THREAD_EXTERNALLY_OWNED")) {
      this.update(threadId, {phase:"blocked",reason:"external-owner"}, job.updatedAt);
    }
    if (job.status === "running" && previousStatus === undefined) {
      this.db.prepare(`UPDATE thread_connections SET phase='connected',handoff_requested=0,reason=NULL,evidence=NULL,
        revision=revision+1,updated_at=? WHERE thread_id=?`).run(job.updatedAt, threadId);
    }
    if (["completed", "failed", "interrupted", "cancelled"].includes(job.status) &&
      previousStatus !== undefined && !["completed", "failed", "interrupted", "cancelled"].includes(previousStatus) && job.upstreamRequestId && job.terminalOrigin !== "bridge-restart") {
      this.db.prepare(`UPDATE thread_connections SET last_finished_at=?,last_job_id=?,revision=revision+1,updated_at=?
        WHERE thread_id=?`).run(job.updatedAt, job.jobId, job.updatedAt, threadId);
    }
  }

  hasUnfinishedWork(threadId: string): boolean {
    return Boolean(this.db.prepare(THREAD_UNFINISHED_WORK_SQL).get(threadId, threadId, threadId));
  }

  update(threadId: string, patch: Pick<ThreadConnectionRecord, "phase"> & Partial<Pick<ThreadConnectionRecord, "handoffRequested" | "reason" | "evidence">>, now = Date.now(), expectedRevision?: number): ThreadConnectionRecord | undefined {
    const previous = this.get(threadId);
    if (!previous || expectedRevision !== undefined && previous.revision !== expectedRevision) return undefined;
    this.db.prepare(`UPDATE thread_connections SET phase=?,handoff_requested=?,reason=?,evidence=?,revision=revision+1,updated_at=?
      WHERE thread_id=? AND revision=?`).run(patch.phase, Number(patch.handoffRequested ?? previous.handoffRequested),
      patch.reason || null, patch.evidence || null, now, threadId, previous.revision);
    return this.get(threadId);
  }

  requestHandoff(threadId: string, now = Date.now()): ThreadConnectionRecord {
    const current = this.get(threadId);
    if (!current) throw new Error("THREAD_CONNECTION_UNKNOWN: This conversation has no retained connection evidence.");
    if (current.handoffRequested) return current;
    return this.update(threadId, { phase: current.phase === "released" ? "released" : "waiting", handoffRequested: true,
      evidence: current.evidence }, now)!;
  }

  cancelHandoff(threadId: string, now = Date.now()): ThreadConnectionRecord {
    const current = this.get(threadId);
    if (!current) throw new Error("THREAD_CONNECTION_UNKNOWN");
    if (current.phase === "releasing") throw new Error("THREAD_RELEASE_IN_PROGRESS: Release is already being checked; retry shortly.");
    return this.update(threadId, { phase: ["unsubscribed", "released"].includes(current.phase) ? current.phase : "connected",
      handoffRequested: false, evidence: current.evidence }, now)!;
  }

  private decode(row: Record<string, unknown>): ThreadConnectionRecord {
    return { threadId: String(row.thread_id), scopeId: String(row.scope_id),
      ...(row.agent_id ? { agentId: String(row.agent_id) } : {}),
      persistence: row.persistence as ThreadPersistence, phase: row.phase as ThreadConnectionPhase,
      handoffRequested: row.handoff_requested === 1, revision: Number(row.revision), updatedAt: Number(row.updated_at),
      ...(row.last_finished_at !== null ? { lastFinishedAt: Number(row.last_finished_at) } : {}),
      ...(row.last_job_id ? { lastJobId: String(row.last_job_id) } : {}),
      ...(row.worker_pid ? { workerPid: Number(row.worker_pid) } : {}),
      ...(row.reason ? { reason: String(row.reason) } : {}),
      ...(row.evidence ? { evidence: row.evidence as ThreadReleaseEvidence } : {}) };
  }
}

export const DEFAULT_THREAD_IDLE_MS = 6 * 60 * 60_000;

export const THREAD_UNFINISHED_WORK_SQL = `WITH candidate_jobs AS (
  SELECT job_id,activity_id,status FROM jobs
   WHERE thread_id=? AND archived_at IS NULL
  UNION ALL
  SELECT job_id,activity_id,status FROM jobs
   WHERE source_thread_id=? AND archived_at IS NULL
  UNION ALL
  SELECT job_id,activity_id,status FROM jobs
   WHERE agent_id=(SELECT agent_id FROM thread_connections WHERE thread_id=?)
     AND archived_at IS NULL
)
SELECT 1 FROM candidate_jobs j
 WHERE j.status IN ('running','terminating','termination-failed')
    OR EXISTS (SELECT 1 FROM job_interactions interaction
      WHERE interaction.job_id=j.job_id AND interaction.is_blocking=1)
    OR EXISTS (SELECT 1 FROM cancellation_intents cancellation
      WHERE (cancellation.target_job_id=j.job_id OR
        (cancellation.target_kind='activity' AND cancellation.target_activity_id=j.activity_id))
      AND cancellation.status IN ('recorded','dispatched'))
 LIMIT 1`;

export class ThreadConnectionController {
  lastError?: string;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private sweepCursor = "";
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly store: ThreadConnectionStore, private readonly upstream: CodexUpstream,
    private readonly options: { idleMs?: number; intervalMs?: number; now?: () => number; changed?: () => void; maintain?: () => void } = {}) {
    this.now = options.now || Date.now;
  }

  start(): void {
    if (this.timer || this.closed) return;
    for (const connection of this.store.list()) {
      if (connection.handoffRequested || connection.phase !== "connected") this.upstream.protectThreadFromImplicitResume?.(connection.threadId);
    }
    this.timer = setInterval(() => { void this.sweep(); }, this.options.intervalMs ?? 30_000);
    this.timer.unref();
    void this.sweep();
  }

  request(threadId: string): ThreadConnectionRecord {
    const current = this.store.requestHandoff(threadId, this.now());
    this.options.changed?.();
    void this.sweep();
    return current;
  }

  cancel(threadId: string): ThreadConnectionRecord {
    const current = this.store.cancelHandoff(threadId, this.now());
    this.options.changed?.();
    return current;
  }

  sweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.pending ||= this.runSweep().catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error);
    }).finally(() => { this.pending = undefined; });
  }

  private eligible(record: ThreadConnectionRecord): boolean {
    const idleMs = this.options.idleMs ?? DEFAULT_THREAD_IDLE_MS;
    return record.persistence === "persistent" && !this.store.hasUnfinishedWork(record.threadId) &&
      (record.handoffRequested || idleMs > 0 && record.lastFinishedAt !== undefined && this.now() - record.lastFinishedAt >= idleMs);
  }

  private async runSweep(): Promise<void> {
    this.options.maintain?.();
    const records = this.store.list();
    const eligible = records.filter(record => record.phase !== "released" && this.eligible(record)).map(record => record.threadId);
    const candidates = records.filter(record => record.phase !== "released" && (record.handoffRequested || eligible.includes(record.threadId)))
      .sort((a, b) => a.threadId.localeCompare(b.threadId));
    // Persistently blocked requests must not starve later eligible conversations.
    const after = candidates.filter(record => record.threadId.localeCompare(this.sweepCursor) > 0);
    const before = candidates.filter(record => record.threadId.localeCompare(this.sweepCursor) <= 0);
    for (const initial of [...after, ...before].slice(0, 100)) {
      if (this.closed) return;
      this.sweepCursor = initial.threadId;
      const current = this.store.get(initial.threadId)!;
      if (current.phase === "released") continue;
      const reason = current.persistence !== "persistent" ? current.persistence === "ephemeral" ? "ephemeral" : "persistence-unknown"
        : this.store.hasUnfinishedWork(current.threadId) ? "active-work" : !this.upstream.releaseThreadConnection ? "unsupported" : undefined;
      if (reason) {
        if (current.phase !== "blocked" || current.reason !== reason) {
          this.store.update(current.threadId, { phase: "blocked", reason }, this.now());
          this.options.changed?.();
        }
        continue;
      }
      if (!this.eligible(current)) continue;
      const releasing = this.store.update(current.threadId, { phase: "releasing" }, this.now(), current.revision);
      if (!releasing) continue;
      const canRelease = (threadId: string) => {
        if (this.closed) return false;
        const row = this.store.get(threadId);
        return Boolean(row && this.eligible(row));
      };
      let result: ThreadReleaseResult;
      try {
        result = await this.upstream.releaseThreadConnection!(current.threadId, { eligibleThreadIds: eligible, canRelease, previousWorkerPid: current.workerPid });
      } catch { result = { phase: "blocked", reason: "release-unconfirmed" }; }
      if (this.closed) return;
      // An acknowledgement alone never becomes proof of unload or relinquished writing.
      if (result.phase === "released" && !result.evidence) result = { phase: "blocked", reason: "release-unconfirmed" };
      this.store.update(current.threadId, result, this.now(), releasing.revision);
      if (result.evidence) for (const threadId of result.releasedThreadIds || []) {
        if (threadId !== current.threadId && canRelease(threadId)) this.store.update(threadId, { phase: "released", evidence: result.evidence }, this.now());
      }
      this.options.changed?.();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
