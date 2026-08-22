import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  ACTIVITY_COMPLETION_TRIGGERS,
  ACTIVITY_EXECUTION_MODES,
  ACTIVITY_HANDOFF_POLICIES,
  ACTIVITY_JOB_STATUSES,
  ACTIVITY_KINDS,
  ACTIVITY_LIFECYCLES,
  ACTIVITY_VERIFICATION_STATES,
  ACTIVITY_WAITING_ON,
  deriveActivityBarrier,
  isTerminalActivityJobStatus,
  valueIsOneOf,
  type ActivityCompletionTrigger,
  type ActivityExecutionMode,
  type ActivityHandoffPolicy,
  type ActivityJobCounts,
  type ActivityKind,
  type ActivityVerificationState,
  type BridgeActivity
} from "./activity.js";

const CURRENT_SCHEMA_VERSION = "2";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SessionRowInput = {
  threadId: string;
  scopeId: string;
  cwd: string;
  lastUsedAt: number;
};

type JobRowInput = {
  jobId: string;
  scopeId: string;
  requestId: string;
  status: string;
  updatedAt: number;
  activityId?: string;
  threadId?: string;
  executionMode?: ActivityExecutionMode;
  backendKind?: string;
  bridgeInstanceId?: string;
  workerId?: string;
  workerGeneration?: number;
  upstreamRequestId?: string;
  terminalVersion?: number;
  sessionDecision?: { threadId?: string };
};

type JsonRow = { payload: string };
type CountRow = { count: number };
type JobStorageRow = JsonRow & {
  activity_id: string;
  thread_id: string | null;
  execution_mode: string;
  backend_kind: string;
  bridge_instance_id: string | null;
  worker_id: string | null;
  worker_generation: number | null;
  upstream_request_id: string | null;
  terminal_version: number | null;
};
type PreviousJobRow = {
  scope_id: string;
  activity_id: string;
  thread_id: string | null;
  status: string;
  backend_kind: string;
  bridge_instance_id: string | null;
  terminal_version: number | null;
  archived_at: number | null;
};
type ActivityStorageRow = {
  activity_id: string;
  scope_id: string;
  title: string;
  kind: string;
  execution_mode: string;
  handoff_policy: string;
  completion_trigger: string;
  lifecycle: string;
  waiting_on: string;
  verification: string;
  version: number;
  completion_version: number;
  legacy: number;
  created_at: number;
  updated_at: number;
  sealed_at: number | null;
  completed_at: number | null;
  total_jobs: number;
  running_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  interrupted_jobs: number;
  cancelled_jobs: number;
  terminal_jobs: number;
};

export type CreateActivityInput = {
  activityId?: string;
  scopeId: string;
  title?: string;
  kind?: ActivityKind;
  executionMode?: ActivityExecutionMode;
  handoffPolicy?: ActivityHandoffPolicy;
  completionTrigger?: ActivityCompletionTrigger;
  legacy?: boolean;
  now?: number;
};

export type ActivityEventRecord = {
  eventId: number;
  activityId: string;
  scopeId: string;
  scopeVersion: number;
  eventType: string;
  createdAt: number;
  payload: unknown;
};

export type JobEventRecord = {
  eventId: number;
  jobId: string;
  activityId: string;
  scopeId: string;
  scopeVersion: number;
  eventType: string;
  status: string;
  createdAt: number;
  payload: unknown;
};

export type CompletionOutboxRecord = {
  outboxId: number;
  activityId: string;
  scopeId: string;
  completionVersion: number;
  channel: "notify" | "verify";
  payload: unknown;
  attemptCount: number;
  nextAttemptAt?: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  createdAt: number;
};

export type BridgeInstanceRecord = {
  instanceId: string;
  startedAt: number;
  stoppedAt?: number;
  terminationReason?: string;
  processId: number;
};

export type BridgeStateStoreOptions = {
  file: string;
};

/**
 * Durable bridge state backed by one SQLite database. Registry snapshots are
 * retained for compatibility, while Activity/job state changes share one
 * transaction, one scope version, and an idempotent completion outbox.
 */
export class BridgeStateStore {
  private readonly database: Database.Database;
  private readonly currentInstanceId = randomUUID();
  private transactionDepth = 0;
  private closed = false;

  constructor(private readonly options: BridgeStateStoreOptions) {
    if (options.file !== ":memory:") {
      mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
    }
    this.database = new Database(options.file);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS bridge_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);

    const existingVersion = this.getMeta("schema_version");
    if (
      existingVersion !== undefined &&
      existingVersion !== "1" &&
      existingVersion !== CURRENT_SCHEMA_VERSION
    ) {
      this.database.close();
      throw new Error(`Unsupported bridge state database schema version: ${existingVersion}.`);
    }

    try {
      this.createV1Schema();
      if (existingVersion === undefined) this.setMeta("schema_version", "1");
      if ((existingVersion || "1") === "1") this.migrateV1ToV2();
      this.registerBridgeInstance();
      this.enforcePrivateFileModes();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  get persistent(): boolean {
    return this.options.file !== ":memory:";
  }

  get persistencePath(): string | null {
    return this.persistent ? this.options.file : null;
  }

  get schemaVersion(): number {
    return Number(this.getMeta("schema_version"));
  }

  get bridgeInstanceId(): string {
    return this.currentInstanceId;
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.database.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  listSessions(): unknown[] {
    return this.database
      .prepare("SELECT payload FROM sessions ORDER BY last_used_at ASC")
      .all()
      .map((row) => parsePayload(row as JsonRow, "session"));
  }

  upsertSession(session: SessionRowInput): void {
    this.transaction(() => {
      this.ensureScope(session.scopeId, session.lastUsedAt);
      this.database
        .prepare(`
          INSERT INTO sessions(thread_id, scope_id, cwd, last_used_at, payload)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET
            scope_id = excluded.scope_id,
            cwd = excluded.cwd,
            last_used_at = excluded.last_used_at,
            payload = excluded.payload
        `)
        .run(session.threadId, session.scopeId, session.cwd, session.lastUsedAt, JSON.stringify(session));
    });
  }

  deleteSession(threadId: string): void {
    this.database.prepare("DELETE FROM sessions WHERE thread_id = ?").run(threadId);
  }

  replaceSessions(sessions: SessionRowInput[]): void {
    this.transaction(() => {
      this.database.exec("DELETE FROM sessions");
      for (const session of sessions) this.upsertSession(session);
    });
  }

  countSessions(scopeId?: string): number {
    const row = scopeId
      ? this.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE scope_id = ?").get(scopeId)
      : this.database.prepare("SELECT COUNT(*) AS count FROM sessions").get();
    return Number((row as CountRow).count);
  }

  listJobs(): unknown[] {
    return this.database
      .prepare(`
        SELECT payload, activity_id, thread_id, execution_mode, backend_kind,
               bridge_instance_id, worker_id, worker_generation, upstream_request_id,
               terminal_version
          FROM jobs
         WHERE archived_at IS NULL
         ORDER BY updated_at ASC
      `)
      .all()
      .map((row) => hydrateJobPayload(row as JobStorageRow));
  }

  upsertJob(job: JobRowInput): void {
    this.transaction(() => this.upsertJobInternal(job));
  }

  deleteJob(jobId: string): void {
    this.transaction(() => {
      const row = this.database
        .prepare(`
          SELECT job_id, scope_id, request_id, status, updated_at, activity_id, terminal_version
            FROM jobs
           WHERE job_id = ? AND archived_at IS NULL
        `)
        .get(jobId) as
        | {
            job_id: string;
            scope_id: string;
            request_id: string;
            status: string;
            updated_at: number;
            activity_id: string;
            terminal_version: number | null;
          }
        | undefined;
      if (!row) return;
      const now = Date.now();
      const scopeVersion = this.nextScopeVersion(row.scope_id, now);
      const retainedSummary = {
        jobId: row.job_id,
        scopeId: row.scope_id,
        requestId: row.request_id,
        activityId: row.activity_id,
        status: row.status,
        updatedAt: row.updated_at,
        terminalVersion: row.terminal_version || undefined,
        archivedAt: now,
        resultOmitted: true
      };
      this.database
        .prepare("UPDATE jobs SET archived_at = ?, payload = ? WHERE job_id = ?")
        .run(now, JSON.stringify(retainedSummary), row.job_id);
      this.insertJobEvent({
        jobId: row.job_id,
        activityId: row.activity_id,
        scopeId: row.scope_id,
        scopeVersion,
        eventType: "retention-pruned",
        status: row.status,
        createdAt: now,
        payload: { resultBodyRetained: false }
      });
      this.touchActivity(row.activity_id, scopeVersion, now, "job-retention-pruned", {
        jobId: row.job_id
      });
    });
  }

  replaceJobs(jobs: JobRowInput[]): void {
    this.transaction(() => {
      const retainedIds = new Set(jobs.map((job) => job.jobId));
      const existing = this.database
        .prepare("SELECT job_id FROM jobs WHERE archived_at IS NULL")
        .all() as Array<{ job_id: string }>;
      for (const job of jobs) this.upsertJobInternal(job);
      for (const row of existing) {
        if (!retainedIds.has(row.job_id)) this.deleteJob(row.job_id);
      }
    });
  }

  countJobs(scopeId?: string, status?: string): number {
    let sql = "SELECT COUNT(*) AS count FROM jobs WHERE archived_at IS NULL";
    const parameters: string[] = [];
    if (scopeId) {
      sql += " AND scope_id = ?";
      parameters.push(scopeId);
    }
    if (status) {
      sql += " AND status = ?";
      parameters.push(status);
    }
    const row = this.database.prepare(sql).get(...parameters) as CountRow;
    return Number(row.count);
  }

  createActivity(input: CreateActivityInput): BridgeActivity {
    const activityId = normalizeUuid(input.activityId || randomUUID(), "activityId");
    const scopeId = normalizeUuid(input.scopeId, "scopeId");
    const kind = input.kind || "other";
    const executionMode = input.executionMode || "auto";
    const handoffPolicy = input.handoffPolicy || "none";
    const completionTrigger = input.completionTrigger || "manual";
    assertActivityPolicy(kind, executionMode, handoffPolicy, completionTrigger);
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      if (this.getActivityRow(activityId)) throw new Error("Activity id already exists.");
      this.ensureScope(scopeId, now);
      const scopeVersion = this.nextScopeVersion(scopeId, now);
      this.insertActivity({
        activityId,
        scopeId,
        title: normalizeActivityTitle(input.title || "Codex activity"),
        kind,
        executionMode,
        handoffPolicy,
        completionTrigger,
        legacy: input.legacy || false,
        now
      });
      this.insertActivityEvent({
        activityId,
        scopeId,
        scopeVersion,
        eventType: "activity-created",
        createdAt: now,
        payload: { kind, executionMode, handoffPolicy, completionTrigger }
      });
      return this.requireActivity(activityId);
    });
  }

  getActivity(activityId: string): BridgeActivity | undefined {
    const row = this.getActivityRow(activityId);
    return row ? readActivityRow(row) : undefined;
  }

  listActivities(scopeId?: string, limit = 100, offset = 0): BridgeActivity[] {
    const boundedLimit = Math.max(0, Math.min(1_000, limit));
    const boundedOffset = Math.max(0, offset);
    const rows = scopeId
      ? this.database
          .prepare("SELECT * FROM activities WHERE scope_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
          .all(scopeId, boundedLimit, boundedOffset)
      : this.database
          .prepare("SELECT * FROM activities ORDER BY updated_at DESC LIMIT ? OFFSET ?")
          .all(boundedLimit, boundedOffset);
    return (rows as ActivityStorageRow[]).map(readActivityRow);
  }

  setActivityPolicy(
    activityId: string,
    policy: {
      handoffPolicy?: ActivityHandoffPolicy;
      completionTrigger?: ActivityCompletionTrigger;
      executionMode?: ActivityExecutionMode;
      kind?: ActivityKind;
    },
    now = Date.now()
  ): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireActivity(activityId);
      if (activity.lifecycle !== "open") {
        throw new Error("Activity policy can only change while the Activity is open.");
      }
      const kind = policy.kind || activity.kind;
      const executionMode = policy.executionMode || activity.executionMode;
      const handoffPolicy = policy.handoffPolicy || activity.handoffPolicy;
      const completionTrigger = policy.completionTrigger || activity.completionTrigger;
      assertActivityPolicy(kind, executionMode, handoffPolicy, completionTrigger);
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET kind = ?, execution_mode = ?, handoff_policy = ?, completion_trigger = ?,
                 version = version + 1, updated_at = ?
           WHERE activity_id = ?
        `)
        .run(kind, executionMode, handoffPolicy, completionTrigger, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "policy-updated",
        createdAt: now,
        payload: { kind, executionMode, handoffPolicy, completionTrigger }
      });
      return this.requireActivity(activityId);
    });
  }

  sealActivity(activityId: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireActivity(activityId);
      if (activity.lifecycle !== "open") {
        throw new Error("Only an open Activity can be sealed.");
      }
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'sealed', sealed_at = ?, updated_at = ?, version = version + 1
           WHERE activity_id = ?
        `)
        .run(now, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "activity-sealed",
        createdAt: now,
        payload: {}
      });
      this.reconcileActivity(activityId, scopeVersion, now);
      return this.requireActivity(activityId);
    });
  }

  getScopeVersion(scopeId: string): number {
    const row = this.database
      .prepare("SELECT version FROM scope_versions WHERE scope_id = ?")
      .get(scopeId) as { version: number } | undefined;
    return row?.version || 0;
  }

  listActivityEvents(activityId?: string): ActivityEventRecord[] {
    const rows = activityId
      ? this.database
          .prepare("SELECT * FROM activity_events WHERE activity_id = ? ORDER BY event_id ASC")
          .all(activityId)
      : this.database.prepare("SELECT * FROM activity_events ORDER BY event_id ASC").all();
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      eventId: Number(row.event_id),
      activityId: String(row.activity_id),
      scopeId: String(row.scope_id),
      scopeVersion: Number(row.scope_version),
      eventType: String(row.event_type),
      createdAt: Number(row.created_at),
      payload: parsePayload({ payload: String(row.payload) }, "activity event")
    }));
  }

  listJobEvents(jobId?: string): JobEventRecord[] {
    const rows = jobId
      ? this.database.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY event_id ASC").all(jobId)
      : this.database.prepare("SELECT * FROM job_events ORDER BY event_id ASC").all();
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      eventId: Number(row.event_id),
      jobId: String(row.job_id),
      activityId: String(row.activity_id),
      scopeId: String(row.scope_id),
      scopeVersion: Number(row.scope_version),
      eventType: String(row.event_type),
      status: String(row.status),
      createdAt: Number(row.created_at),
      payload: parsePayload({ payload: String(row.payload) }, "job event")
    }));
  }

  listCompletionOutbox(activityId?: string): CompletionOutboxRecord[] {
    const rows = activityId
      ? this.database
          .prepare("SELECT * FROM completion_outbox WHERE activity_id = ? ORDER BY outbox_id ASC")
          .all(activityId)
      : this.database.prepare("SELECT * FROM completion_outbox ORDER BY outbox_id ASC").all();
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      outboxId: Number(row.outbox_id),
      activityId: String(row.activity_id),
      scopeId: String(row.scope_id),
      completionVersion: Number(row.completion_version),
      channel: row.channel as "notify" | "verify",
      payload: parsePayload({ payload: String(row.payload) }, "completion outbox"),
      attemptCount: Number(row.attempt_count),
      nextAttemptAt: optionalNumber(row.next_attempt_at),
      leaseOwner: optionalString(row.lease_owner),
      leaseExpiresAt: optionalNumber(row.lease_expires_at),
      deliveredAt: optionalNumber(row.delivered_at),
      acknowledgedAt: optionalNumber(row.acknowledged_at),
      createdAt: Number(row.created_at)
    }));
  }

  listBridgeInstances(): BridgeInstanceRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM bridge_instances ORDER BY started_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      instanceId: String(row.instance_id),
      startedAt: Number(row.started_at),
      stoppedAt: optionalNumber(row.stopped_at),
      terminationReason: optionalString(row.termination_reason),
      processId: Number(row.process_id)
    }));
  }

  getSettings(): unknown | undefined {
    const row = this.database
      .prepare("SELECT payload FROM user_settings WHERE singleton = 1")
      .get() as JsonRow | undefined;
    return row ? parsePayload(row, "settings") : undefined;
  }

  setSettings(settings: unknown): void {
    this.database
      .prepare(`
        INSERT INTO user_settings(singleton, payload) VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload
      `)
      .run(JSON.stringify(settings));
  }

  getMeta(key: string): string | undefined {
    const row = this.database
      .prepare("SELECT value FROM bridge_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.database
      .prepare(`
        INSERT INTO bridge_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, value);
  }

  close(): void {
    if (this.closed) return;
    const now = Date.now();
    this.database
      .prepare(`
        UPDATE bridge_instances
           SET stopped_at = ?, termination_reason = 'clean-shutdown'
         WHERE instance_id = ? AND stopped_at IS NULL
      `)
      .run(now, this.currentInstanceId);
    this.database.close();
    this.closed = true;
  }

  private createV1Schema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_scope_recent
        ON sessions(scope_id, last_used_at DESC);

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(scope_id, request_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_scope_recent
        ON jobs(scope_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_status_recent
        ON jobs(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS user_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        payload TEXT NOT NULL
      ) STRICT;
    `);
  }

  private migrateV1ToV2(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE scopes (
          scope_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE scope_versions (
          scope_id TEXT PRIMARY KEY REFERENCES scopes(scope_id) ON DELETE CASCADE,
          version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE bridge_instances (
          instance_id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          stopped_at INTEGER,
          termination_reason TEXT,
          process_id INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;

        CREATE TABLE activities (
          activity_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
          title TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('discussion','investigation','review','implementation','other')),
          execution_mode TEXT NOT NULL CHECK(execution_mode IN ('auto','foreground','background')),
          handoff_policy TEXT NOT NULL CHECK(handoff_policy IN ('none','notify','verify')),
          completion_trigger TEXT NOT NULL CHECK(completion_trigger IN ('manual','sealed-jobs-terminal')),
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('open','sealed','completed','cancelled','abandoned')),
          waiting_on TEXT NOT NULL CHECK(waiting_on IN ('none','codex','orchestrator','user','verification')),
          verification TEXT NOT NULL CHECK(verification IN ('not-required','pending','verifying','verified','failed')),
          version INTEGER NOT NULL CHECK(version >= 1),
          completion_version INTEGER NOT NULL DEFAULT 0 CHECK(completion_version >= 0),
          legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          sealed_at INTEGER,
          completed_at INTEGER,
          total_jobs INTEGER NOT NULL DEFAULT 0 CHECK(total_jobs >= 0),
          running_jobs INTEGER NOT NULL DEFAULT 0 CHECK(running_jobs >= 0),
          completed_jobs INTEGER NOT NULL DEFAULT 0 CHECK(completed_jobs >= 0),
          failed_jobs INTEGER NOT NULL DEFAULT 0 CHECK(failed_jobs >= 0),
          interrupted_jobs INTEGER NOT NULL DEFAULT 0 CHECK(interrupted_jobs >= 0),
          cancelled_jobs INTEGER NOT NULL DEFAULT 0 CHECK(cancelled_jobs >= 0),
          terminal_jobs INTEGER NOT NULL DEFAULT 0 CHECK(terminal_jobs >= 0)
        ) STRICT;
        CREATE INDEX activities_scope_recent ON activities(scope_id, updated_at DESC);
        CREATE INDEX activities_scope_attention
          ON activities(scope_id, waiting_on, verification, updated_at DESC);

        CREATE TABLE activity_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
          scope_version INTEGER NOT NULL CHECK(scope_version >= 1),
          event_type TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
        CREATE INDEX activity_events_activity_cursor ON activity_events(activity_id, event_id);
        CREATE INDEX activity_events_scope_cursor ON activity_events(scope_id, scope_version, event_id);

        CREATE TABLE job_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
          scope_version INTEGER NOT NULL CHECK(scope_version >= 1),
          event_type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
        CREATE INDEX job_events_job_cursor ON job_events(job_id, event_id);
        CREATE INDEX job_events_scope_cursor ON job_events(scope_id, scope_version, event_id);

        CREATE TABLE completion_outbox (
          outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
          completion_version INTEGER NOT NULL CHECK(completion_version >= 1),
          channel TEXT NOT NULL CHECK(channel IN ('notify','verify')),
          payload TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
          next_attempt_at INTEGER,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          delivered_at INTEGER,
          acknowledged_at INTEGER,
          created_at INTEGER NOT NULL,
          UNIQUE(activity_id, completion_version, channel)
        ) STRICT;
        CREATE INDEX completion_outbox_pending
          ON completion_outbox(delivered_at, next_attempt_at, created_at);
      `);

      const now = Date.now();
      this.database.exec(`
        INSERT OR IGNORE INTO scopes(scope_id, created_at, updated_at)
          SELECT scope_id, MIN(last_used_at), MAX(last_used_at) FROM sessions GROUP BY scope_id;
        INSERT OR IGNORE INTO scopes(scope_id, created_at, updated_at)
          SELECT scope_id, MIN(updated_at), MAX(updated_at) FROM jobs GROUP BY scope_id;
        INSERT OR IGNORE INTO scope_versions(scope_id, version, updated_at)
          SELECT scope_id, 0, updated_at FROM scopes;
        DROP INDEX IF EXISTS jobs_scope_recent;
        DROP INDEX IF EXISTS jobs_status_recent;
        ALTER TABLE jobs RENAME TO jobs_v1;
      `);
      this.database.exec(`
        CREATE TABLE jobs (
          job_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
          request_id TEXT NOT NULL,
          activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
          thread_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted','cancelled')),
          execution_mode TEXT NOT NULL CHECK(execution_mode IN ('auto','foreground','background')),
          backend_kind TEXT NOT NULL,
          bridge_instance_id TEXT,
          worker_id TEXT,
          worker_generation INTEGER,
          upstream_request_id TEXT,
          terminal_version INTEGER,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER,
          payload TEXT NOT NULL,
          UNIQUE(scope_id, request_id)
        ) STRICT;
        CREATE INDEX jobs_scope_recent ON jobs(scope_id, updated_at DESC);
        CREATE INDEX jobs_status_recent ON jobs(status, updated_at DESC);
        CREATE INDEX jobs_activity_recent ON jobs(activity_id, updated_at DESC);
        CREATE INDEX jobs_thread_recent ON jobs(thread_id, updated_at DESC);
      `);

      const legacyRows = this.database
        .prepare("SELECT * FROM jobs_v1 ORDER BY updated_at ASC")
        .all() as Array<{
        job_id: string;
        scope_id: string;
        request_id: string;
        status: string;
        updated_at: number;
        payload: string;
      }>;
      for (const row of legacyRows) {
        const parsed = parsePayload({ payload: row.payload }, "job") as Record<string, unknown>;
        const activityId = legacyActivityIdForJob(row.job_id);
        const createdAt = finiteNumber(parsed.createdAt) ?? row.updated_at;
        const threadId = readNestedThreadId(parsed);
        const terminalVersion = isTerminalActivityJobStatus(row.status) ? 1 : undefined;
        const counts = countsForSingleStatus(row.status);
        this.insertActivity({
          activityId,
          scopeId: row.scope_id,
          title: `Legacy Codex job ${row.job_id.slice(0, 8)}`,
          kind: "other",
          executionMode: "auto",
          handoffPolicy: "none",
          completionTrigger: "manual",
          legacy: true,
          now: createdAt,
          updatedAt: row.updated_at,
          waitingOn: row.status === "running" ? "codex" : "orchestrator",
          counts
        });
        const hydratedPayload = {
          ...parsed,
          activityId,
          threadId,
          executionMode: "auto",
          backendKind: "mcp-server",
          terminalVersion
        };
        this.database
          .prepare(`
            INSERT INTO jobs(
              job_id, scope_id, request_id, activity_id, thread_id, status, execution_mode,
              backend_kind, bridge_instance_id, worker_id, worker_generation,
              upstream_request_id, terminal_version, updated_at, archived_at, payload
            ) VALUES (?, ?, ?, ?, ?, ?, 'auto', 'mcp-server', NULL, NULL, NULL, NULL, ?, ?, NULL, ?)
          `)
          .run(
            row.job_id,
            row.scope_id,
            row.request_id,
            activityId,
            threadId || null,
            row.status,
            terminalVersion || null,
            row.updated_at,
            JSON.stringify(hydratedPayload)
          );
        const scopeVersion = this.nextScopeVersion(row.scope_id, row.updated_at);
        this.insertActivityEvent({
          activityId,
          scopeId: row.scope_id,
          scopeVersion,
          eventType: "legacy-job-grouped",
          createdAt: row.updated_at,
          payload: { jobId: row.job_id }
        });
        this.insertJobEvent({
          jobId: row.job_id,
          activityId,
          scopeId: row.scope_id,
          scopeVersion,
          eventType: "legacy-imported",
          status: row.status,
          createdAt: row.updated_at,
          payload: { threadLinked: Boolean(threadId) }
        });
      }
      this.database.exec("DROP TABLE jobs_v1");
      this.setMeta("schema_version", CURRENT_SCHEMA_VERSION);
      this.setMeta("schema_v2_migrated_at", new Date(now).toISOString());
    });
  }

  private registerBridgeInstance(): void {
    this.transaction(() => {
      const now = Date.now();
      this.database
        .prepare(`
          UPDATE bridge_instances
             SET stopped_at = ?, termination_reason = 'superseded-by-restart'
           WHERE stopped_at IS NULL AND instance_id <> ?
        `)
        .run(now, this.currentInstanceId);
      this.database
        .prepare(`
          INSERT INTO bridge_instances(
            instance_id, started_at, stopped_at, termination_reason, process_id, payload
          ) VALUES (?, ?, NULL, NULL, ?, ?)
        `)
        .run(this.currentInstanceId, now, process.pid, JSON.stringify({ schemaVersion: 2 }));
    });
  }

  private upsertJobInternal(job: JobRowInput): void {
    if (!valueIsOneOf(ACTIVITY_JOB_STATUSES, job.status)) {
      throw new Error(`Invalid Codex job status for Activity storage: ${job.status}.`);
    }
    const activityId = normalizeUuid(
      job.activityId || legacyActivityIdForJob(job.jobId),
      "job activityId"
    );
    const scopeId = normalizeUuid(job.scopeId, "job scopeId");
    const executionMode = job.executionMode || "auto";
    if (!valueIsOneOf(ACTIVITY_EXECUTION_MODES, executionMode)) {
      throw new Error(`Invalid Activity execution mode: ${executionMode}.`);
    }
    const previous = this.database
      .prepare(`
        SELECT scope_id, activity_id, thread_id, status, backend_kind, bridge_instance_id,
               terminal_version, archived_at
          FROM jobs WHERE job_id = ?
      `)
      .get(job.jobId) as PreviousJobRow | undefined;
    if (previous && previous.scope_id !== scopeId) {
      throw new Error("A persisted Codex job cannot move to another conversation scope.");
    }
    if (previous && previous.activity_id !== activityId) {
      throw new Error("A persisted Codex job cannot move to another Activity.");
    }
    const requestCollision = this.database
      .prepare(`
        SELECT job_id, archived_at FROM jobs
         WHERE scope_id = ? AND request_id = ? AND job_id <> ?
      `)
      .get(scopeId, job.requestId, job.jobId) as
      | { job_id: string; archived_at: number | null }
      | undefined;
    if (requestCollision) {
      throw new Error(
        requestCollision.archived_at
          ? "requestId belongs to an archived Codex job in this scope; its result body is no longer retained. Use a fresh requestId for a new logical turn."
          : "requestId was already used by another Codex job in this scope."
      );
    }

    this.ensureScope(scopeId, job.updatedAt);
    let activity = this.getActivity(activityId);
    let activityCreated = false;
    if (!activity) {
      this.insertActivity({
        activityId,
        scopeId,
        title: `Codex job ${job.jobId.slice(0, 8)}`,
        kind: "other",
        executionMode,
        handoffPolicy: "none",
        completionTrigger: "manual",
        legacy: true,
        now: job.updatedAt
      });
      activity = this.requireActivity(activityId);
      activityCreated = true;
    } else if (activity.scopeId !== scopeId) {
      throw new Error("The requested Activity belongs to another conversation scope.");
    } else if (!previous && activity.lifecycle !== "open") {
      throw new Error("A new Codex job cannot be attached to a non-open Activity.");
    }

    const threadId = normalizeOptionalString(job.threadId || job.sessionDecision?.threadId);
    const wasTerminal = previous ? isTerminalActivityJobStatus(previous.status) : false;
    const nowTerminal = isTerminalActivityJobStatus(job.status);
    const terminalVersion = nowTerminal
      ? wasTerminal
        ? previous?.terminal_version || job.terminalVersion || 1
        : Math.max(previous?.terminal_version || 0, job.terminalVersion || 0) + 1
      : undefined;
    const backendKind = normalizeOptionalString(job.backendKind) || previous?.backend_kind || "mcp-server";
    const bridgeInstanceId = previous
      ? normalizeOptionalString(job.bridgeInstanceId) || previous.bridge_instance_id || undefined
      : normalizeOptionalString(job.bridgeInstanceId) || this.currentInstanceId;
    job.activityId = activityId;
    job.scopeId = scopeId;
    job.threadId = threadId;
    job.executionMode = executionMode;
    job.backendKind = backendKind;
    job.bridgeInstanceId = bridgeInstanceId;
    job.terminalVersion = terminalVersion;

    this.database
      .prepare(`
        INSERT INTO jobs(
          job_id, scope_id, request_id, activity_id, thread_id, status, execution_mode,
          backend_kind, bridge_instance_id, worker_id, worker_generation, upstream_request_id,
          terminal_version, updated_at, archived_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          scope_id = excluded.scope_id,
          request_id = excluded.request_id,
          activity_id = excluded.activity_id,
          thread_id = excluded.thread_id,
          status = excluded.status,
          execution_mode = excluded.execution_mode,
          backend_kind = excluded.backend_kind,
          bridge_instance_id = excluded.bridge_instance_id,
          worker_id = excluded.worker_id,
          worker_generation = excluded.worker_generation,
          upstream_request_id = excluded.upstream_request_id,
          terminal_version = excluded.terminal_version,
          updated_at = excluded.updated_at,
          archived_at = NULL,
          payload = excluded.payload
      `)
      .run(
        job.jobId,
        scopeId,
        job.requestId,
        activityId,
        threadId || null,
        job.status,
        executionMode,
        backendKind,
        bridgeInstanceId || null,
        normalizeOptionalString(job.workerId) || null,
        Number.isInteger(job.workerGeneration) ? job.workerGeneration : null,
        normalizeOptionalString(job.upstreamRequestId) || null,
        terminalVersion || null,
        job.updatedAt,
        JSON.stringify(job)
      );

    const statusChanged = !previous || previous.status !== job.status;
    const threadChanged = (previous?.thread_id || undefined) !== threadId;
    const restoredFromArchive = Boolean(previous?.archived_at);
    if (!activityCreated && !statusChanged && !threadChanged && !restoredFromArchive) return;

    const scopeVersion = this.nextScopeVersion(scopeId, job.updatedAt);
    if (activityCreated) {
      this.insertActivityEvent({
        activityId,
        scopeId,
        scopeVersion,
        eventType: "compatibility-activity-created",
        createdAt: job.updatedAt,
        payload: { jobId: job.jobId }
      });
    }
    const eventType = !previous
      ? "job-started"
      : statusChanged
        ? `job-${job.status}`
        : restoredFromArchive
          ? "job-retained-again"
          : "thread-linked";
    this.insertJobEvent({
      jobId: job.jobId,
      activityId,
      scopeId,
      scopeVersion,
      eventType,
      status: job.status,
      createdAt: job.updatedAt,
      payload: {
        threadLinked: Boolean(threadId),
        terminalVersion: terminalVersion || null,
        backendKind
      }
    });
    this.reconcileActivity(activityId, scopeVersion, job.updatedAt);
  }

  private reconcileActivity(activityId: string, scopeVersion: number, now: number): void {
    const before = this.requireActivity(activityId);
    const counts = this.countActivityJobs(activityId);
    const decision = deriveActivityBarrier(before, counts);
    const completionTransition =
      decision.completionChannel &&
      (before.lifecycle !== decision.lifecycle ||
        before.waitingOn !== decision.waitingOn ||
        before.verification !== decision.verification);
    const completionVersion = completionTransition
      ? before.completionVersion + 1
      : before.completionVersion;
    const completedAt = decision.lifecycle === "completed" ? before.completedAt || now : before.completedAt;
    this.database
      .prepare(`
        UPDATE activities
           SET lifecycle = ?, waiting_on = ?, verification = ?, version = version + 1,
               completion_version = ?, updated_at = ?, completed_at = ?,
               total_jobs = ?, running_jobs = ?, completed_jobs = ?, failed_jobs = ?,
               interrupted_jobs = ?, cancelled_jobs = ?, terminal_jobs = ?
         WHERE activity_id = ?
      `)
      .run(
        decision.lifecycle,
        decision.waitingOn,
        decision.verification,
        completionVersion,
        now,
        completedAt || null,
        counts.total,
        counts.running,
        counts.completed,
        counts.failed,
        counts.interrupted,
        counts.cancelled,
        counts.terminal,
        activityId
      );
    this.insertActivityEvent({
      activityId,
      scopeId: before.scopeId,
      scopeVersion,
      eventType: completionTransition
        ? decision.completionChannel === "verify"
          ? "verification-pending"
          : "activity-completed"
        : decision.attentionRequired
          ? "attention-required"
          : "child-jobs-changed",
      createdAt: now,
      payload: { counts, waitingOn: decision.waitingOn }
    });
    if (completionTransition && decision.completionChannel) {
      this.insertCompletionOutbox({
        activityId,
        scopeId: before.scopeId,
        completionVersion,
        channel: decision.completionChannel,
        createdAt: now,
        payload: {
          activityId,
          completionVersion,
          channel: decision.completionChannel,
          counts,
          requiresResultVerification: decision.completionChannel === "verify"
        }
      });
    }
  }

  private countActivityJobs(activityId: string): ActivityJobCounts {
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) AS interrupted,
               SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
               SUM(CASE WHEN status <> 'running' THEN 1 ELSE 0 END) AS terminal
          FROM jobs WHERE activity_id = ?
      `)
      .get(activityId) as Record<string, number | null>;
    return {
      total: Number(row.total || 0),
      running: Number(row.running || 0),
      completed: Number(row.completed || 0),
      failed: Number(row.failed || 0),
      interrupted: Number(row.interrupted || 0),
      cancelled: Number(row.cancelled || 0),
      terminal: Number(row.terminal || 0)
    };
  }

  private insertActivity(input: {
    activityId: string;
    scopeId: string;
    title: string;
    kind: ActivityKind;
    executionMode: ActivityExecutionMode;
    handoffPolicy: ActivityHandoffPolicy;
    completionTrigger: ActivityCompletionTrigger;
    legacy: boolean;
    now: number;
    updatedAt?: number;
    waitingOn?: BridgeActivity["waitingOn"];
    counts?: ActivityJobCounts;
  }): void {
    const counts = input.counts || countsForSingleStatus(undefined);
    this.database
      .prepare(`
        INSERT INTO activities(
          activity_id, scope_id, title, kind, execution_mode, handoff_policy,
          completion_trigger, lifecycle, waiting_on, verification, version,
          completion_version, legacy, created_at, updated_at, sealed_at, completed_at,
          total_jobs, running_jobs, completed_jobs, failed_jobs, interrupted_jobs,
          cancelled_jobs, terminal_jobs
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, 'not-required', 1, 0, ?, ?, ?, NULL, NULL,
                  ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.activityId,
        input.scopeId,
        normalizeActivityTitle(input.title),
        input.kind,
        input.executionMode,
        input.handoffPolicy,
        input.completionTrigger,
        input.waitingOn || "none",
        input.legacy ? 1 : 0,
        input.now,
        input.updatedAt ?? input.now,
        counts.total,
        counts.running,
        counts.completed,
        counts.failed,
        counts.interrupted,
        counts.cancelled,
        counts.terminal
      );
  }

  private touchActivity(
    activityId: string,
    scopeVersion: number,
    now: number,
    eventType: string,
    payload: unknown
  ): void {
    const activity = this.requireActivity(activityId);
    this.database
      .prepare("UPDATE activities SET version = version + 1, updated_at = ? WHERE activity_id = ?")
      .run(now, activityId);
    this.insertActivityEvent({
      activityId,
      scopeId: activity.scopeId,
      scopeVersion,
      eventType,
      createdAt: now,
      payload
    });
  }

  private ensureScope(scopeId: string, now: number): void {
    this.database
      .prepare(`
        INSERT INTO scopes(scope_id, created_at, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(scope_id) DO UPDATE SET updated_at = MAX(updated_at, excluded.updated_at)
      `)
      .run(scopeId, now, now);
    this.database
      .prepare(`
        INSERT OR IGNORE INTO scope_versions(scope_id, version, updated_at) VALUES (?, 0, ?)
      `)
      .run(scopeId, now);
  }

  private nextScopeVersion(scopeId: string, now: number): number {
    this.ensureScope(scopeId, now);
    this.database
      .prepare("UPDATE scope_versions SET version = version + 1, updated_at = ? WHERE scope_id = ?")
      .run(now, scopeId);
    return this.getScopeVersion(scopeId);
  }

  private insertActivityEvent(input: Omit<ActivityEventRecord, "eventId">): void {
    this.database
      .prepare(`
        INSERT INTO activity_events(
          activity_id, scope_id, scope_version, event_type, created_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.activityId,
        input.scopeId,
        input.scopeVersion,
        input.eventType,
        input.createdAt,
        JSON.stringify(input.payload)
      );
  }

  private insertJobEvent(input: Omit<JobEventRecord, "eventId">): void {
    this.database
      .prepare(`
        INSERT INTO job_events(
          job_id, activity_id, scope_id, scope_version, event_type, status, created_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.jobId,
        input.activityId,
        input.scopeId,
        input.scopeVersion,
        input.eventType,
        input.status,
        input.createdAt,
        JSON.stringify(input.payload)
      );
  }

  private insertCompletionOutbox(input: {
    activityId: string;
    scopeId: string;
    completionVersion: number;
    channel: "notify" | "verify";
    createdAt: number;
    payload: unknown;
  }): void {
    this.database
      .prepare(`
        INSERT OR IGNORE INTO completion_outbox(
          activity_id, scope_id, completion_version, channel, payload, attempt_count,
          next_attempt_at, lease_owner, lease_expires_at, delivered_at, acknowledged_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?)
      `)
      .run(
        input.activityId,
        input.scopeId,
        input.completionVersion,
        input.channel,
        JSON.stringify(input.payload),
        input.createdAt
      );
  }

  private getActivityRow(activityId: string): ActivityStorageRow | undefined {
    return this.database
      .prepare("SELECT * FROM activities WHERE activity_id = ?")
      .get(activityId) as ActivityStorageRow | undefined;
  }

  private requireActivity(activityId: string): BridgeActivity {
    const activity = this.getActivity(activityId);
    if (!activity) throw new Error("Unknown Activity id.");
    return activity;
  }

  private enforcePrivateFileModes(): void {
    if (this.options.file === ":memory:") return;
    for (const file of [this.options.file, `${this.options.file}-wal`, `${this.options.file}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }
}

function hydrateJobPayload(row: JobStorageRow): unknown {
  const payload = parsePayload(row, "job");
  if (!isRecord(payload)) throw new Error("Invalid job payload in the bridge state database: expected an object.");
  return {
    ...payload,
    activityId: row.activity_id,
    threadId: row.thread_id || undefined,
    executionMode: row.execution_mode,
    backendKind: row.backend_kind,
    bridgeInstanceId: row.bridge_instance_id || undefined,
    workerId: row.worker_id || undefined,
    workerGeneration: row.worker_generation ?? undefined,
    upstreamRequestId: row.upstream_request_id || undefined,
    terminalVersion: row.terminal_version ?? undefined
  };
}

function readActivityRow(row: ActivityStorageRow): BridgeActivity {
  if (
    !valueIsOneOf(ACTIVITY_KINDS, row.kind) ||
    !valueIsOneOf(ACTIVITY_EXECUTION_MODES, row.execution_mode) ||
    !valueIsOneOf(ACTIVITY_HANDOFF_POLICIES, row.handoff_policy) ||
    !valueIsOneOf(ACTIVITY_COMPLETION_TRIGGERS, row.completion_trigger) ||
    !valueIsOneOf(ACTIVITY_LIFECYCLES, row.lifecycle) ||
    !valueIsOneOf(ACTIVITY_WAITING_ON, row.waiting_on) ||
    !valueIsOneOf(ACTIVITY_VERIFICATION_STATES, row.verification)
  ) {
    throw new Error(`Invalid Activity row in the bridge state database: ${row.activity_id}.`);
  }
  return {
    activityId: row.activity_id,
    scopeId: row.scope_id,
    title: row.title,
    kind: row.kind,
    executionMode: row.execution_mode,
    handoffPolicy: row.handoff_policy,
    completionTrigger: row.completion_trigger,
    lifecycle: row.lifecycle,
    waitingOn: row.waiting_on,
    verification: row.verification as ActivityVerificationState,
    version: row.version,
    completionVersion: row.completion_version,
    legacy: row.legacy === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sealedAt: row.sealed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    counts: {
      total: row.total_jobs,
      running: row.running_jobs,
      completed: row.completed_jobs,
      failed: row.failed_jobs,
      interrupted: row.interrupted_jobs,
      cancelled: row.cancelled_jobs,
      terminal: row.terminal_jobs
    }
  };
}

function assertActivityPolicy(
  kind: unknown,
  executionMode: unknown,
  handoffPolicy: unknown,
  completionTrigger: unknown
): void {
  if (!valueIsOneOf(ACTIVITY_KINDS, kind)) throw new Error("Invalid Activity kind.");
  if (!valueIsOneOf(ACTIVITY_EXECUTION_MODES, executionMode)) {
    throw new Error("Invalid Activity execution mode.");
  }
  if (!valueIsOneOf(ACTIVITY_HANDOFF_POLICIES, handoffPolicy)) {
    throw new Error("Invalid Activity handoff policy.");
  }
  if (!valueIsOneOf(ACTIVITY_COMPLETION_TRIGGERS, completionTrigger)) {
    throw new Error("Invalid Activity completion trigger.");
  }
}

function normalizeUuid(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error(`${label} must be a UUID.`);
  return normalized;
}

function normalizeActivityTitle(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Activity title cannot be empty.");
  return normalized.slice(0, 120);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function legacyActivityIdForJob(jobId: string): string {
  const digest = createHash("sha256").update(`legacy-activity\0${jobId}`).digest("hex").split("");
  digest[12] = "8";
  digest[16] = "8";
  const value = digest.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function countsForSingleStatus(status: string | undefined): ActivityJobCounts {
  return {
    total: status ? 1 : 0,
    running: status === "running" ? 1 : 0,
    completed: status === "completed" ? 1 : 0,
    failed: status === "failed" ? 1 : 0,
    interrupted: status === "interrupted" ? 1 : 0,
    cancelled: status === "cancelled" ? 1 : 0,
    terminal: status && status !== "running" ? 1 : 0
  };
}

function readNestedThreadId(payload: Record<string, unknown>): string | undefined {
  const direct = normalizeOptionalString(payload.threadId);
  if (direct) return direct;
  const decision = payload.sessionDecision;
  return isRecord(decision) ? normalizeOptionalString(decision.threadId) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function parsePayload(row: JsonRow, label: string): unknown {
  try {
    return JSON.parse(row.payload);
  } catch (error) {
    throw new Error(
      `Invalid ${label} payload in the bridge state database: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
