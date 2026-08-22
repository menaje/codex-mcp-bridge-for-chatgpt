import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

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
};

type JsonRow = { payload: string };
type CountRow = { count: number };

export type BridgeStateStoreOptions = {
  file: string;
};

/**
 * Durable bridge state backed by one SQLite database. Registries keep their
 * in-memory indexes, while every row-level change is committed independently.
 * Calls wrapped in transaction() make cross-registry changes atomic.
 */
export class BridgeStateStore {
  private readonly database: Database.Database;
  private transactionDepth = 0;

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
    const schemaVersion = this.getMeta("schema_version");
    if (schemaVersion !== undefined && schemaVersion !== "1") {
      this.database.close();
      throw new Error(`Unsupported bridge state database schema version: ${schemaVersion}.`);
    }
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
    if (schemaVersion === undefined) this.setMeta("schema_version", "1");
    this.enforcePrivateFileModes();
  }

  get persistent(): boolean {
    return this.options.file !== ":memory:";
  }

  get persistencePath(): string | null {
    return this.persistent ? this.options.file : null;
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
      .prepare("SELECT payload FROM jobs ORDER BY updated_at ASC")
      .all()
      .map((row) => parsePayload(row as JsonRow, "job"));
  }

  upsertJob(job: JobRowInput): void {
    this.database
      .prepare(`
        INSERT INTO jobs(job_id, scope_id, request_id, status, updated_at, payload)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          scope_id = excluded.scope_id,
          request_id = excluded.request_id,
          status = excluded.status,
          updated_at = excluded.updated_at,
          payload = excluded.payload
      `)
      .run(job.jobId, job.scopeId, job.requestId, job.status, job.updatedAt, JSON.stringify(job));
  }

  deleteJob(jobId: string): void {
    this.database.prepare("DELETE FROM jobs WHERE job_id = ?").run(jobId);
  }

  replaceJobs(jobs: JobRowInput[]): void {
    this.transaction(() => {
      this.database.exec("DELETE FROM jobs");
      for (const job of jobs) this.upsertJob(job);
    });
  }

  countJobs(scopeId?: string, status?: string): number {
    let sql = "SELECT COUNT(*) AS count FROM jobs";
    const parameters: string[] = [];
    if (scopeId || status) {
      const clauses: string[] = [];
      if (scopeId) {
        clauses.push("scope_id = ?");
        parameters.push(scopeId);
      }
      if (status) {
        clauses.push("status = ?");
        parameters.push(status);
      }
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }
    const row = this.database.prepare(sql).get(...parameters) as CountRow;
    return Number(row.count);
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
    this.database.close();
  }

  private enforcePrivateFileModes(): void {
    if (this.options.file === ":memory:") return;
    for (const file of [this.options.file, `${this.options.file}-wal`, `${this.options.file}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }
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
