import { readAppliedHistoryPolicy, type AppliedHistoryPolicy } from "./historyPolicy.js";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { BackgroundWorkSlice, RECOVERY_WORK_LIMITS } from "./backgroundWorkBudget.js";

export type AutomaticRecoveryKind = "recheck" | "retry-stop" | "release";
export type AutomaticRecoveryState = "retrying" | "resolved" | "blocked";
export type AutomaticRecoveryRecord = {
  key: string; scopeId: string; agentId: string; jobId?: string;
  projectId?: string; activityId?: string; threadId?: string;
  /** Exact initial incident/direct execution-recovery origin, never recurrence. */
  executionFailureJobId?: string;
  kind: AutomaticRecoveryKind; state: AutomaticRecoveryState;
  attempts: number; occurredAt: number; createdAt: number; updatedAt: number; nextAttemptAt: number;
  reason: string; evidence?: string;
};
export type AutomaticRecoveryCandidate = Pick<AutomaticRecoveryRecord, "key" | "scopeId" | "agentId" | "jobId" | "kind">;
export type AutomaticRecoveryResult = { resolved: boolean; reason: string; evidence?: string; retryable?: boolean };
export const AUTOMATIC_RECOVERY_ATTEMPTS = 3;
const RETRY_DELAYS = [5_000, 30_000, 120_000];

/** Upgrade-only schema introduced at v17. Current databases use stateSchema.ts. */
export const V17_AUTOMATIC_RECOVERY_MIGRATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS automatic_recovery (
    recovery_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    job_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('recheck','retry-stop','release')),
    state TEXT NOT NULL CHECK(state IN ('retrying','resolved','blocked')),
    attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL, reason TEXT NOT NULL, evidence TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS automatic_recovery_scope ON automatic_recovery(scope_id,updated_at);
  CREATE INDEX IF NOT EXISTS automatic_recovery_job ON automatic_recovery(job_id);
  CREATE TABLE IF NOT EXISTS automatic_recovery_incidents (
    identity_key TEXT PRIMARY KEY, recovery_key TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), updated_at INTEGER NOT NULL
  ) STRICT;
`;

export function automaticRecoveryKey(kind: AutomaticRecoveryKind, identity: unknown): string {
  return createHash("sha256").update(JSON.stringify(["automatic-recovery-v1", kind, identity])).digest("hex");
}

/** Attempts are committed before dispatch, so restarting cannot reset a limit
 * or interpret an interrupted dispatch as evidence of successful cleanup. */
export class AutomaticRecoveryStore {
  constructor(private readonly db: Database.Database, private readonly policy: () => AppliedHistoryPolicy = () => readAppliedHistoryPolicy(db)) {}

  blockedKeys(): Set<string> {
    return new Set((this.db.prepare(
      "SELECT recovery_key FROM automatic_recovery WHERE state='blocked'"
    ).all() as Array<{ recovery_key: string }>).map(row => row.recovery_key));
  }

  isBlocked(key: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM automatic_recovery WHERE recovery_key=? AND state='blocked'").get(key));
  }

  isBlockedRecheckIdentity(identityKey: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM automatic_recovery_incidents incident
      JOIN automatic_recovery recovery ON recovery.recovery_key=incident.recovery_key
      WHERE incident.identity_key=? AND incident.active=1 AND recovery.state='blocked'`).get(identityKey));
  }

  pendingForAgent(agentId: string, afterKey = "", limit = 32): AutomaticRecoveryRecord[] {
    return this.db.prepare(`SELECT * FROM automatic_recovery WHERE agent_id=? AND state='retrying'
      AND recovery_key>? ORDER BY recovery_key LIMIT ?`)
      .all(agentId,afterKey,Math.max(1,Math.min(32,Math.floor(limit))))
      .map(row => this.decode(row as Record<string, unknown>));
  }

  dueAgentIds(now: number, limit = 4): string[] {
    const rows = this.db.prepare(`SELECT agent_id FROM automatic_recovery
      WHERE state='retrying' AND next_attempt_at<=? AND attempts<?
      ORDER BY next_attempt_at,recovery_key LIMIT ?`).all(
        now,AUTOMATIC_RECOVERY_ATTEMPTS,Math.max(1,Math.min(4,Math.floor(limit)))) as Array<{agent_id:string}>;
    return [...new Set(rows.map(row => row.agent_id))];
  }

  blockedRecheckIdentityKeys(): Set<string> {
    return new Set((this.db.prepare(`SELECT incident.identity_key FROM automatic_recovery_incidents incident
      JOIN automatic_recovery recovery ON recovery.recovery_key=incident.recovery_key
      WHERE incident.active=1 AND recovery.state='blocked'`)
      .all() as Array<{ identity_key: string }>).map(row => row.identity_key));
  }

  get(key: string): AutomaticRecoveryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM automatic_recovery WHERE recovery_key=?").get(key);
    return row ? this.decode(row as Record<string, unknown>) : undefined;
  }

  list(scopeId?: string): AutomaticRecoveryRecord[] {
    return this.db.prepare(`SELECT * FROM automatic_recovery ${scopeId ? "WHERE scope_id=?" : ""}
      ORDER BY updated_at DESC,recovery_key`).all(...(scopeId ? [scopeId] : []))
      .map(row => this.decode(row as Record<string, unknown>));
  }

  /** Dashboard projection excludes references whose retained Job history has
   * expired, so the selected page can hydrate exact Job IDs after pagination. */
  listForDashboard(scopeId?: string): AutomaticRecoveryRecord[] {
    const policy=this.policy();
    return this.db.prepare(`SELECT recovery.*,
      CASE WHEN recovery.kind IN ('release','retry-stop') OR EXISTS (
        SELECT 1 FROM automatic_recovery_incidents i WHERE i.identity_key=recovery.recovery_key
          AND i.agent_id=recovery.agent_id)
        THEN recovery.job_id ELSE NULL END AS execution_failure_job_id
      FROM automatic_recovery recovery
      WHERE ${scopeId ? "recovery.scope_id=? AND" : ""}
      ${policy.cutoffAt===null ? "1" : "recovery.occurred_at>?"}
      ORDER BY recovery.occurred_at DESC,recovery.recovery_key`)
      .all(...(scopeId ? [scopeId] : []),...(policy.cutoffAt===null ? [] : [policy.cutoffAt]))
      .map(row=>this.decode(row as Record<string,unknown>));
  }

  /** Fresh inspection transitions define incidents; retries and cached reads
   * do not. Keep each incident's journal and retry budget across restarts. */
  observeRecheck(candidate: AutomaticRecoveryCandidate, problem: boolean, now: number, evidence?: string): void {
    if (candidate.kind !== "recheck") throw new Error("Only runtime rechecks have inspection incidents.");
    if (!problem && !evidence) throw new Error("A confirmed runtime observation requires evidence.");
    this.db.transaction(() => {
      const incident = this.incident(candidate.key);
      const previous = this.get(incident?.recovery_key || candidate.key);
      if (!problem && !incident && !previous) return;
      const active = incident ? Boolean(incident.active) : previous?.state !== "resolved";
      const key = problem && !active
        ? automaticRecoveryKey("recheck",[candidate.key,previous?.key || incident!.recovery_key,randomUUID()])
        : incident?.recovery_key || candidate.key;
      if (problem && !this.control(key)) {
        const source=this.sourceIdentity(candidate);
        this.db.prepare(`INSERT OR IGNORE INTO automatic_recovery
          (recovery_key,scope_id,agent_id,job_id,kind,state,attempts,created_at,updated_at,next_attempt_at,reason,occurred_at,project_id,activity_id,thread_id)
          VALUES (?,?,?,?,?,'retrying',0,?,?,?,'inspection-pending',?,
          ?,?,?)`)
          .run(key,candidate.scopeId,candidate.agentId,candidate.jobId || null,candidate.kind,now,now,now,now,source.project_id,source.activity_id,source.thread_id);
        this.db.prepare(`INSERT OR IGNORE INTO recovery_controls(recovery_key,agent_id,job_id,attempts,state,history_expired)
          VALUES (?,?,?,0,'retrying',0)`).run(key,candidate.agentId,candidate.jobId || null);
        this.step(key,"observed",{reason:"inspection-pending"},now);
      }
      this.db.prepare(`INSERT INTO automatic_recovery_incidents(identity_key,recovery_key,agent_id,active,updated_at)
        VALUES (?,?,?,?,?) ON CONFLICT(identity_key) DO UPDATE SET recovery_key=excluded.recovery_key,
          active=excluded.active,updated_at=excluded.updated_at`)
        .run(candidate.key,key,candidate.agentId,problem ? 1 : 0,now);
      if(!problem && incident) this.db.prepare("UPDATE recovery_controls SET state='resolved' WHERE recovery_key=?").run(incident.recovery_key);
      if (!problem && previous && previous.state !== "resolved") this.confirm(previous.key,"runtime-confirmed",evidence!,now);
    })();
  }

  recheckCandidate(candidate: AutomaticRecoveryCandidate, discover = false): AutomaticRecoveryCandidate | undefined {
    const incident = this.incident(candidate.key);
    if (incident) return incident.active ? {...candidate,key:incident.recovery_key} : undefined;
    // Version 16 journals used the work identity itself as the incident key.
    const legacy = this.get(candidate.key);
    if (legacy) return legacy.state !== "resolved" ? candidate : undefined;
    if (!discover) return;
    this.observeRecheck(candidate,true,Date.now());
    return candidate;
  }

  /** Reuse only a provably continuous, still-active legacy control. The
   * journal, original clock and exhausted/expired budget remain untouched.
   * One current alias per Agent contains control IDs only, not history.
   * Durable Job/Thread linkage proves continuity independently of names and
   * other Agent metadata. A newer Job starts a new context. */
  handoffRecheckIdentity(candidate: AutomaticRecoveryCandidate, allowHandoff=true): AutomaticRecoveryCandidate | undefined {
    if (candidate.kind!=="recheck") return candidate;
    return this.db.transaction(()=>{
      if (this.incident(candidate.key)) return candidate;
      const aliasKey=`recheck_identity/${candidate.agentId}`;
      const saved=this.db.prepare("SELECT value FROM bridge_meta WHERE key=?").get(aliasKey) as {value:string}|undefined;
      if(saved) {
        const alias=JSON.parse(saved.value) as {key:string;identityKey:string};
        if(alias.key===candidate.key && this.incident(alias.identityKey)) return {...candidate,key:alias.identityKey};
      }
      if(!allowHandoff) return candidate;
      const agent=this.db.prepare("SELECT version,updated_at,current_thread_id FROM agents WHERE agent_id=? AND scope_id=?")
        .get(candidate.agentId,candidate.scopeId) as {version:number;updated_at:number;current_thread_id:string|null}|undefined;
      if (!agent?.current_thread_id) return candidate;
      const latest=this.db.prepare("SELECT job_id,thread_id,created_at FROM jobs WHERE agent_id=? ORDER BY created_at DESC,job_id DESC LIMIT 1")
        .get(candidate.agentId) as {job_id:string;thread_id:string|null;created_at:number}|undefined;
      const job=latest?.thread_id===agent.current_thread_id ? latest : undefined;
      if (candidate.key!==automaticRecoveryKey("recheck",[candidate.agentId,job?.job_id,agent.current_thread_id])) return candidate;
      const legacyKeys=[...new Set([job?.job_id,undefined].map(id=>automaticRecoveryKey("recheck",[candidate.agentId,agent.version,id])))];
      const compatible=this.db.prepare(`SELECT i.identity_key,i.updated_at,c.job_id,r.scope_id,r.thread_id,r.occurred_at
        FROM automatic_recovery_incidents i JOIN recovery_controls c ON c.recovery_key=i.recovery_key
        LEFT JOIN automatic_recovery r ON r.recovery_key=i.recovery_key
        WHERE i.agent_id=? AND i.active=1 AND c.state IN ('retrying','blocked')
          AND (c.job_id=? OR (c.job_id IS NULL AND r.scope_id=? AND r.thread_id=?)
            OR i.identity_key IN (${legacyKeys.map(()=>"?").join(",")}))
        ORDER BY i.identity_key LIMIT 33`)
        .all(candidate.agentId,job?.job_id || null,candidate.scopeId,agent.current_thread_id,...legacyKeys) as
        Array<{identity_key:string;updated_at:number;job_id:string|null;scope_id:string|null;thread_id:string|null;occurred_at:number|null}>;
      if(compatible.length===33) return;
      const matches=compatible.filter(row=>{
        if(row.scope_id && row.scope_id!==candidate.scopeId || row.thread_id && row.thread_id!==agent.current_thread_id) return false;
        if(row.job_id) return row.job_id===job?.job_id && row.job_id===candidate.jobId;
        if(row.thread_id) return !job || row.occurred_at!==null && job.created_at<=row.occurred_at;
        // Missing legacy linkage is not inferred from a rename. Only an
        // unchanged legacy fingerprint can supply that otherwise absent proof.
        return legacyKeys.includes(row.identity_key) && agent.updated_at<=row.updated_at &&
          (!job || job.created_at<=(row.occurred_at ?? agent.updated_at));
      });
      // Ambiguous old origins are history, not permission to merge incidents.
      if(matches.length>1) return;
      if(matches.length===0) return candidate;
      const identityKey=matches[0]!.identity_key;
      this.db.prepare("INSERT INTO bridge_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(aliasKey,JSON.stringify({key:candidate.key,identityKey}));
      return {...candidate,key:identityKey};
    })();
  }

  private incident(identityKey: string): {recovery_key:string;active:number} | undefined {
    return this.db.prepare("SELECT recovery_key,active FROM automatic_recovery_incidents WHERE identity_key=?")
      .get(identityKey) as {recovery_key:string;active:number} | undefined;
  }

  private projectAvailable(candidate: AutomaticRecoveryCandidate): boolean {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='retired_requests'").get()) return true;
    if (candidate.jobId) {
      if (this.db.prepare("SELECT 1 FROM retired_requests WHERE namespace='task' AND subject_id=?").get(candidate.jobId)) return false;
      const job=this.db.prepare("SELECT a.project_id FROM jobs j JOIN activities a ON a.activity_id=j.activity_id WHERE j.job_id=?").get(candidate.jobId) as {project_id:string|null}|undefined;
      if (job?.project_id) return Boolean(this.db.prepare("SELECT 1 FROM projects WHERE project_id=? AND archive_state='active' AND deleted_at IS NULL").get(job.project_id));
    }
    const owner=this.db.prepare("SELECT s.project_id FROM agents a JOIN sessions s ON s.thread_id=a.current_thread_id WHERE a.agent_id=?").get(candidate.agentId) as {project_id:string|null}|undefined;
    return !owner?.project_id || Boolean(this.db.prepare("SELECT 1 FROM projects WHERE project_id=? AND archive_state='active' AND deleted_at IS NULL").get(owner.project_id));
  }

  private sourceIdentity(candidate: AutomaticRecoveryCandidate): {project_id:string|null;activity_id:string|null;thread_id:string|null} {
    if (candidate.jobId) {
      const row=this.db.prepare(`SELECT a.project_id,j.activity_id,j.thread_id FROM jobs j
        LEFT JOIN activities a ON a.activity_id=j.activity_id WHERE j.job_id=?`).get(candidate.jobId) as
        {project_id:string|null;activity_id:string|null;thread_id:string|null}|undefined;
      return row || {project_id:null,activity_id:null,thread_id:null};
    }
    const row=this.db.prepare(`SELECT s.project_id,a.current_thread_id AS thread_id FROM agents a
      LEFT JOIN sessions s ON s.thread_id=a.current_thread_id WHERE a.agent_id=?`).get(candidate.agentId) as
      {project_id:string|null;thread_id:string|null}|undefined;
    return {project_id:row?.project_id || null,activity_id:null,thread_id:row?.thread_id || null};
  }

  begin(candidate: AutomaticRecoveryCandidate, now: number): AutomaticRecoveryRecord | undefined {
    return this.db.transaction(() => {
    if (!this.projectAvailable(candidate)) return;
    const previous = this.get(candidate.key);
    if (this.control(candidate.key)?.history_expired) return;
    if (previous && (previous.state !== "retrying" || previous.attempts >= AUTOMATIC_RECOVERY_ATTEMPTS || previous.nextAttemptAt > now)) return;
    const attempts = (previous?.attempts || 0) + 1;
    const source=this.sourceIdentity(candidate);
    this.db.prepare(`INSERT INTO automatic_recovery
      (recovery_key,scope_id,agent_id,job_id,kind,state,attempts,created_at,updated_at,next_attempt_at,reason,occurred_at,project_id,activity_id,thread_id)
      VALUES (?,?,?,?,?,'retrying',?,?,?,?, 'inspection-pending',?,
        ?,?,?)
      ON CONFLICT(recovery_key) DO UPDATE SET state='retrying',attempts=excluded.attempts,
        updated_at=excluded.updated_at,next_attempt_at=excluded.next_attempt_at,reason=excluded.reason,evidence=NULL`)
      .run(candidate.key,candidate.scopeId,candidate.agentId,candidate.jobId || null,candidate.kind,
        attempts,previous?.createdAt ?? now,now,now + RETRY_DELAYS[attempts - 1]!,previous?.occurredAt ?? now,source.project_id,source.activity_id,source.thread_id);
    this.db.prepare(`INSERT INTO recovery_controls(recovery_key,agent_id,job_id,attempts,state,history_expired)
      VALUES (?,?,?,?,'retrying',0) ON CONFLICT(recovery_key) DO UPDATE SET attempts=excluded.attempts,state=excluded.state`)
      .run(candidate.key,candidate.agentId,candidate.jobId || null,attempts);
    this.step(candidate.key,"attempt",{attempts},now);
    return this.get(candidate.key);
    })();
  }

  canBegin(candidate: AutomaticRecoveryCandidate, now: number): boolean {
    if (!this.projectAvailable(candidate) || this.control(candidate.key)?.history_expired) return false;
    const previous = this.get(candidate.key);
    return !previous || previous.state === "retrying" &&
      previous.attempts < AUTOMATIC_RECOVERY_ATTEMPTS && previous.nextAttemptAt <= now;
  }

  finish(key: string, attempt: number, result: AutomaticRecoveryResult, now: number): void {
    this.db.transaction(() => {
      const confirmed = result.resolved && Boolean(result.evidence);
      const updated = this.db.prepare(`UPDATE automatic_recovery SET state=?,updated_at=?,reason=?,evidence=?
        WHERE recovery_key=? AND attempts=? AND state='retrying'`).run(
        confirmed ? "resolved" : result.retryable === false || attempt >= AUTOMATIC_RECOVERY_ATTEMPTS ? "blocked" : "retrying",
        now,result.resolved && !confirmed ? "recovery-unconfirmed" : result.reason,confirmed ? result.evidence! : null,key,attempt);
      if(updated.changes) this.step(key,"result",{attempt,...result},now);
      const controlled=this.db.prepare("UPDATE recovery_controls SET state=? WHERE recovery_key=? AND attempts=? AND state='retrying'")
        .run(confirmed ? "resolved" : result.retryable===false||attempt>=AUTOMATIC_RECOVERY_ATTEMPTS ? "blocked" : "retrying",key,attempt);
      if (confirmed && (updated.changes||controlled.changes)) this.closeIncident(key,now);
    })();
  }

  reconcileInterrupted(now: number, limit = 32): number {
    const boundedLimit = Math.max(1, Math.min(32, Math.floor(limit)));
    return this.db.prepare(`UPDATE automatic_recovery SET state='blocked',updated_at=?,reason='recovery-interrupted',evidence=NULL
      WHERE recovery_key IN (SELECT recovery_key FROM automatic_recovery
        WHERE state='retrying' AND attempts>=? ORDER BY recovery_key LIMIT ?)`)
      .run(now,AUTOMATIC_RECOVERY_ATTEMPTS,boundedLimit).changes;
  }

  confirm(key: string, reason: string, evidence: string, now: number): void {
    if (!evidence) throw new Error("Recovery confirmation requires observed evidence.");
    this.db.transaction(() => {
      this.db.prepare("UPDATE automatic_recovery SET state='resolved',reason=?,evidence=?,updated_at=? WHERE recovery_key=?")
        .run(reason,evidence,now,key);
      this.step(key,"confirmed",{reason,evidence},now);
      this.db.prepare("UPDATE recovery_controls SET state='resolved' WHERE recovery_key=?").run(key);
      this.closeIncident(key,now);
    })();
  }

  private closeIncident(key: string, now: number): void {
    this.db.prepare("UPDATE automatic_recovery_incidents SET active=0,updated_at=? WHERE recovery_key=?").run(now,key);
  }

  prune(retentionDays: number, now = Date.now(), limit = 64): { recordsRemoved: number; incidentsRemoved: number } {
    const policy=readAppliedHistoryPolicy(this.db,now);
    if (policy.cutoffAt===null) return {recordsRemoved:0,incidentsRemoved:0};
    const keys=this.db.prepare(`SELECT recovery_key FROM automatic_recovery WHERE occurred_at<=?
      ORDER BY occurred_at,recovery_key LIMIT ?`).all(policy.cutoffAt,Math.max(1,Math.min(64,limit))) as Array<{recovery_key:string}>;
    let recordsRemoved=0;
    for (const {recovery_key:key} of keys) {
      const current=readAppliedHistoryPolicy(this.db,now);
      if (current.cutoffAt===null) break;
      const row=this.get(key);
      if (!row || row.occurredAt>current.cutoffAt) continue;
      this.db.prepare("UPDATE recovery_controls SET history_expired=1 WHERE recovery_key=?").run(key);
      this.db.prepare("DELETE FROM automatic_recovery_steps WHERE recovery_key=?").run(key);
      recordsRemoved+=this.db.prepare("DELETE FROM automatic_recovery WHERE recovery_key=?").run(key).changes;
    }
    // Current unresolved incident IDs/budgets prevent replay. They contain no historical prose.
    // A confirmed observation closes the incident and permits a distinct recurrence.
    const controlsRemoved=this.db.prepare(`DELETE FROM recovery_controls WHERE recovery_key IN (
      SELECT c.recovery_key FROM recovery_controls c WHERE c.history_expired=1 AND
      (c.agent_id NOT IN (SELECT agent_id FROM agents) OR c.state='resolved' AND
       NOT EXISTS (SELECT 1 FROM automatic_recovery_incidents i WHERE i.recovery_key=c.recovery_key AND i.active=1))
      ORDER BY recovery_key LIMIT ?)`).run(Math.max(1,Math.min(64,limit))).changes;
    const incidentsRemoved=this.db.prepare(`DELETE FROM automatic_recovery_incidents WHERE identity_key IN (
      SELECT identity_key FROM automatic_recovery_incidents WHERE agent_id NOT IN (SELECT agent_id FROM agents)
      AND recovery_key NOT IN (SELECT recovery_key FROM automatic_recovery) ORDER BY identity_key LIMIT ?)`)
      .run(Math.max(1,Math.min(64,limit))).changes;
    this.db.prepare(`DELETE FROM bridge_meta WHERE key IN (
      SELECT key FROM bridge_meta WHERE key GLOB 'recheck_identity/*'
      AND substr(key,18) NOT IN (SELECT agent_id FROM agents) ORDER BY key LIMIT ?)`)
      .run(Math.max(1,Math.min(64,limit)));
    return {recordsRemoved,incidentsRemoved:incidentsRemoved+controlsRemoved};
  }

  steps(key:string): Array<{at:string;step:string;details:Record<string,unknown>}> {
    return this.stepsMany([key]).get(key) || [];
  }

  stepsMany(keys:readonly string[]):Map<string,Array<{at:string;step:string;details:Record<string,unknown>}>> {
    const output=new Map<string,Array<{at:string;step:string;details:Record<string,unknown>}>>(),policy=this.policy();
    const unique=[...new Set(keys)];
    for(let offset=0;offset<unique.length;offset+=500) {
      const part=unique.slice(offset,offset+500);
      const rows=this.db.prepare(`SELECT s.recovery_key,s.occurred_at,s.step,s.details FROM automatic_recovery_steps s
        JOIN automatic_recovery r ON r.recovery_key=s.recovery_key
        WHERE s.recovery_key IN (${part.map(()=>"?").join(",")}) ${policy.cutoffAt===null ? "" : "AND r.occurred_at>?"}
        ORDER BY s.step_id`).all(...part,...(policy.cutoffAt===null ? [] : [policy.cutoffAt])) as Array<{recovery_key:string;occurred_at:number;step:string;details:string}>;
      for(const row of rows) {
        const steps=output.get(row.recovery_key)||[];
        steps.push({at:new Date(row.occurred_at).toISOString(),step:row.step,details:JSON.parse(row.details)});
        output.set(row.recovery_key,steps);
      }
    }
    return output;
  }

  private step(key:string,step:string,details:unknown,now:number):void {
    this.db.prepare("INSERT INTO automatic_recovery_steps(recovery_key,occurred_at,step,details) VALUES (?,?,?,?)")
      .run(key,now,step,JSON.stringify(details));
  }

  private control(key:string): {history_expired:number;attempts:number;state:string}|undefined {
    return this.db.prepare("SELECT history_expired,attempts,state FROM recovery_controls WHERE recovery_key=?").get(key) as {history_expired:number;attempts:number;state:string}|undefined;
  }

  private decode(row: Record<string, unknown>): AutomaticRecoveryRecord {
    return {key:String(row.recovery_key),scopeId:String(row.scope_id),agentId:String(row.agent_id),
      ...(row.job_id ? {jobId:String(row.job_id)} : {}),
      ...(row.execution_failure_job_id ? {executionFailureJobId:String(row.execution_failure_job_id)} : {}),
      ...(row.project_id ? {projectId:String(row.project_id)} : {}),
      ...(row.activity_id ? {activityId:String(row.activity_id)} : {}),
      ...(row.thread_id ? {threadId:String(row.thread_id)} : {}),kind:row.kind as AutomaticRecoveryKind,state:row.state as AutomaticRecoveryState,
      attempts:Number(row.attempts),occurredAt:Number(row.occurred_at ?? row.created_at),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),nextAttemptAt:Number(row.next_attempt_at),
      reason:String(row.reason),...(row.evidence ? {evidence:String(row.evidence)} : {})};
  }
}

export type AutomaticRecoverySweepObservation = {
  agents: number; candidates: number; dispatched: number; durationMs: number;
  plannedRoundTrips: number; full: boolean;
};

/** One recovery tick may inspect at most one small Agent page. The cursor is
 * reconstructible: after restart a new pass begins at the first Agent, while
 * the durable incident journal keeps attempt and backoff authority. */
export class AutomaticRecoveryController {
  lastError?: string;
  lastObservation?: AutomaticRecoverySweepObservation;
  private timer?: NodeJS.Timeout;
  private scheduled?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private closed = false;
  private candidateCursor = "";
  private agentCursor = "";
  private fullScanScheduled = false;
  private readonly scheduledAgents = new Set<string>();
  readonly now: () => number;
  constructor(private readonly store: AutomaticRecoveryStore, private readonly options: {
    candidates: (agentId?: string) => AutomaticRecoveryCandidate[] | Promise<AutomaticRecoveryCandidate[]>;
    pageAgents?: (afterAgentId: string, limit: number) => string[];
    agentForJob?: (jobId: string) => string | undefined;
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

  schedule(agentId?: string): void {
    if (this.closed) return;
    if (agentId) {
      if (this.scheduledAgents.size < 128 || this.scheduledAgents.has(agentId)) {
        this.scheduledAgents.add(agentId);
      } else {
        // The periodic keyset pass remains authoritative after a dirty-set
        // overflow. Do not retain an unbounded queue during a progress storm.
        this.fullScanScheduled = true;
      }
    } else this.fullScanScheduled = true;
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      const full = this.fullScanScheduled;
      this.fullScanScheduled = false;
      const agents = [...this.scheduledAgents].slice(0, 8);
      for (const id of agents) this.scheduledAgents.delete(id);
      void (async () => {
        await this.pending;
        for (const id of agents) await this.sweep(undefined, id);
        if (full) await this.sweep();
        if (this.scheduledAgents.size || this.fullScanScheduled) this.scheduleNext();
      })();
    }, 100);
    this.scheduled.unref();
  }

  private scheduleNext(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.schedule(this.scheduledAgents.values().next().value);
    }, 100);
    this.scheduled.unref();
  }

  sweep(jobId?: string, agentId?: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.pending ||= this.runSweep(jobId, agentId).catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error);
    }).finally(() => { this.pending = undefined; });
  }

  async recoverJob(jobId: string): Promise<void> {
    await this.pending;
    await this.sweep(jobId, this.options.agentForJob?.(jobId));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearTimeout(this.scheduled);
    await this.pending;
  }

  private async runSweep(jobId?: string, agentId?: string): Promise<void> {
    if (this.options.enabled?.() === false) return;
    this.store.reconcileInterrupted(this.now());
    const budget = new BackgroundWorkSlice(RECOVERY_WORK_LIMITS);
    budget.roundTrips = 1; // bounded interrupted-attempt reconciliation
    let agents = 0, candidates = 0, dispatched = 0;
    const full = !agentId;
    try {
      if (!agentId && this.options.pageAgents) {
        const due = this.store.dueAgentIds(this.now());
        for (const id of due) {
          if (this.closed || dispatched >= 3 || !budget.take(12)) break;
          const result = await this.survey(id, jobId, 3 - dispatched, budget);
          agents++;
          candidates += result.candidates;
          dispatched += result.dispatched;
          if (budget.targets % budget.limits.yieldEvery === 0) await budget.yieldIfNeeded();
        }
        let page = this.options.pageAgents(this.agentCursor, Math.max(1,budget.limits.maxTargets-budget.targets));
        if (page.length === 0 && this.agentCursor) {
          this.agentCursor = "";
          page = this.options.pageAgents("", Math.max(1,budget.limits.maxTargets-budget.targets));
        }
        for (const id of page) {
          if (this.closed || dispatched >= 4 || !budget.take(12)) break;
          if (!due.includes(id)) {
            const result = await this.survey(id, jobId, 4 - dispatched, budget);
            agents++;
            candidates += result.candidates;
            dispatched += result.dispatched;
          }
          this.agentCursor = id;
          if (budget.targets % budget.limits.yieldEvery === 0) await budget.yieldIfNeeded();
        }
        return;
      }
      budget.take(12);
      const result = await this.survey(agentId, jobId, 4, budget);
      agents = 1;
      candidates = result.candidates;
      dispatched = result.dispatched;
    } finally {
      this.lastObservation = {agents,candidates,dispatched,durationMs:budget.durationMs,
        plannedRoundTrips:budget.roundTrips,full};
    }
  }

  private async survey(agentId: string | undefined, jobId: string | undefined, dispatchLimit: number,
    budget: BackgroundWorkSlice): Promise<{candidates:number;dispatched:number}> {
    const available = await budget.awaitExternal(this.options.candidates(agentId));
    const keys = new Set(available.map(candidate => candidate.key));
    // A production Agent has at most three current candidate kinds. Every
    // nonmatching retry is resolved in this pass, so repeated first pages
    // drain historical records without retaining a cursor for every Agent.
    const records = agentId ? this.store.pendingForAgent(agentId)
      : this.store.list().filter(record => record.state === "retrying");
    for (const record of records) {
      if (jobId && record.jobId !== jobId) continue;
      if (!keys.has(record.key)) {
        this.store.finish(record.key,record.attempts,{resolved:false,reason:"work-changed",retryable:false},this.now());
        this.options.changed?.();
      }
    }
    const candidates = available.filter(candidate => !jobId || candidate.jobId === jobId)
      .sort((a,b) => a.key.localeCompare(b.key));
    const after = candidates.filter(candidate => candidate.key > this.candidateCursor);
    const before = candidates.filter(candidate => candidate.key <= this.candidateCursor);
    let dispatched = 0;
    for (const candidate of [...after,...before]) {
      if (this.closed || dispatched >= dispatchLimit) break;
      if (candidate.kind === "release" && !this.store.canBegin(candidate,this.now())) {
        this.candidateCursor = candidate.key;
        continue;
      }
      // A shared-worker release can inspect 31 additional connections. Charge
      // that work before persisting an attempt, so a deferred release keeps
      // its retry budget and can run in a later Agent page.
      if (candidate.kind === "release" && !budget.reserve(180)) break;
      this.candidateCursor = candidate.key;
      const attempt = this.store.begin(candidate,this.now());
      if (!attempt) continue;
      dispatched++;
      this.options.changed?.();
      let result: AutomaticRecoveryResult;
      try { result = await budget.awaitExternal(this.options.attempt(candidate)); }
      catch { result = {resolved:false,reason:"recovery-unconfirmed"}; }
      this.store.finish(candidate.key,attempt.attempts,result,this.now());
      this.options.changed?.();
      // A shared-worker release may resolve a peer. Its durable state is
      // checked by begin() on the next candidate; no global rediscovery here.
    }
    return {candidates:candidates.length,dispatched};
  }
}
