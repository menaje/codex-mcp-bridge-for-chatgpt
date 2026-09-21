import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  TRANSPORT_OBSERVATION_KINDS,
  type TransportObservationKind,
  type TransportObservationRecord
} from "./stateStore.js";

const CHILD_FLAG = "--bridge-telemetry-child";
const FREEZE_PAGE_COUNT_FLAG = "--test-freeze-page-count";
const RETENTION_LIMIT = 1_000;
const QUEUE_CAPACITY = 256;
const MAX_MESSAGE_BYTES = 16 * 1024;
const STARTUP_TIMEOUT_MS = 10_000;
const CLOSE_FLUSH_MS = 1_000;
const FORCE_CLOSE_MS = 2_000;
const RESTART_BASE_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 10_000;

export type TransportObservationInput = {
  kind: TransportObservationKind;
  scopeId?: string;
  jobId?: string;
  activityId?: string;
  toolName?: string;
  callerRequestDigest?: string;
  reasonCode: string;
  now?: number;
};

export type TelemetryServiceStatus = {
  connected: boolean;
  queued: number;
  inFlight: number;
  retained: number;
  dropped: number;
  failed: number;
  lastPersistedAt?: number;
};

export interface BridgeTelemetryService {
  recordTransportObservation(
    input: TransportObservationInput,
    bridgeInstanceId: string
  ): TransportObservationRecord | undefined;
  listTransportObservations(kind?: TransportObservationKind): TransportObservationRecord[];
  status(): TelemetryServiceStatus;
  close(): Promise<void>;
}

/** Fail-open diagnostic fallback: bounded memory only, never operational DB. */
export class InMemoryTelemetryService implements BridgeTelemetryService {
  private readonly records: TransportObservationRecord[] = [];
  private nextObservationId = 1;
  private failed = 0;

  recordTransportObservation(
    input: TransportObservationInput,
    bridgeInstanceId: string
  ): TransportObservationRecord | undefined {
    let record: TransportObservationRecord;
    try {
      record = normalizeRecord(input, bridgeInstanceId, this.nextObservationId++);
    } catch {
      this.failed += 1;
      return undefined;
    }
    this.records.push(record);
    trimRecords(this.records);
    return { ...record };
  }

  listTransportObservations(kind?: TransportObservationKind): TransportObservationRecord[] {
    return this.records
      .filter(record => kind === undefined || record.kind === kind)
      .map(record => ({ ...record }));
  }

  status(): TelemetryServiceStatus {
    return {
      connected: false,
      queued: 0,
      inFlight: 0,
      retained: this.records.length,
      dropped: 0,
      failed: this.failed
    };
  }

  async close(): Promise<void> {}
}

type RecordMessage = { type: "record"; record: TransportObservationRecord };
type CloseMessage = { type: "close" };
type ParentMessage = RecordMessage | CloseMessage;
type ReadyMessage = { type: "ready"; records: TransportObservationRecord[] };
type AckMessage = {
  type: "ack";
  observationId: number;
  ok: boolean;
  persistedAt?: number;
};
type FatalMessage = { type: "fatal"; message: string };
type ChildMessage = ReadyMessage | AckMessage | FatalMessage;

/**
 * Best-effort diagnostic persistence. The caller updates a bounded in-memory
 * view synchronously, while SQLite work is serialized in a separate process.
 * Queue overflow or telemetry storage failure is observable but can never
 * block or change an operational command.
 */
export class ChildProcessTelemetryService implements BridgeTelemetryService {
  private child?: ChildProcess;
  private readonly records: TransportObservationRecord[] = [];
  private readonly queue: TransportObservationRecord[] = [];
  private inFlight?: TransportObservationRecord;
  private nextObservationId = 1;
  private dropped = 0;
  private failed = 0;
  private lastPersistedAt?: number;
  private closed = false;
  private closePromise?: Promise<void>;
  private restartTimer?: NodeJS.Timeout;
  private restartAttempts = 0;
  private initialized = false;
  private ready = false;

  private constructor(
    private readonly file: string,
    private readonly freezePageCountAfterStartup: boolean
  ) {}

  static async start(
    file: string,
    options: { /** Deterministic disk-capacity fault injection for tests. */ freezePageCountAfterStartup?: boolean } = {}
  ): Promise<ChildProcessTelemetryService> {
    const service = new ChildProcessTelemetryService(
      file,
      options.freezePageCountAfterStartup === true
    );
    try {
      await service.spawnAndWait();
      return service;
    } catch (error) {
      await service.close().catch(() => undefined);
      throw error;
    }
  }

  recordTransportObservation(
    input: TransportObservationInput,
    bridgeInstanceId: string
  ): TransportObservationRecord | undefined {
    if (this.closed) return undefined;
    let record: TransportObservationRecord;
    try {
      record = normalizeRecord(input, bridgeInstanceId, this.nextObservationId++);
    } catch {
      this.failed += 1;
      return undefined;
    }
    this.records.push(record);
    trimRecords(this.records);
    if (this.queue.length + (this.inFlight ? 1 : 0) >= QUEUE_CAPACITY) {
      this.dropped += 1;
      return record;
    }
    this.queue.push(record);
    this.pump();
    return { ...record };
  }

  listTransportObservations(kind?: TransportObservationKind): TransportObservationRecord[] {
    return this.records
      .filter(record => kind === undefined || record.kind === kind)
      .map(record => ({ ...record }));
  }

  status(): TelemetryServiceStatus {
    return {
      connected: Boolean(this.ready && this.child?.connected && this.child.exitCode === null),
      queued: this.queue.length,
      inFlight: this.inFlight ? 1 : 0,
      retained: this.records.length,
      dropped: this.dropped,
      failed: this.failed,
      ...(this.lastPersistedAt !== undefined ? { lastPersistedAt: this.lastPersistedAt } : {})
    };
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeChild();
    return this.closePromise;
  }

  /** Test/supervisor visibility only; never exposed through diagnostics records. */
  get processId(): number | undefined {
    return this.child?.pid;
  }

  private spawnAndWait(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("TELEMETRY_CLOSED: Telemetry service closed."));
    }
    const modulePath = fileURLToPath(import.meta.url);
    const args = modulePath.endsWith(".ts")
      ? ["--import", "tsx", modulePath, CHILD_FLAG, this.file]
      : [modulePath, CHILD_FLAG, this.file];
    if (this.freezePageCountAfterStartup) args.push(FREEZE_PAGE_COUNT_FLAG);
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: childEnvironment(),
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    this.child = child;
    this.ready = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        const error = new Error("TELEMETRY_START_TIMEOUT: Telemetry process did not become ready.");
        finish(error);
        child.kill("SIGKILL");
      }, STARTUP_TIMEOUT_MS);
      timer.unref();
      child.once("error", error => {
        finish(error);
        this.onExit(child);
      });
      child.once("exit", (code, signal) => {
        finish(new Error(`TELEMETRY_PROCESS_EXITED: code=${code}, signal=${signal}`));
        this.onExit(child);
      });
      child.stderr?.on("data", chunk => {
        if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") process.stderr.write(chunk);
      });
      child.on("message", value => {
        if (this.child !== child) return;
        if (!isChildMessage(value)) return;
        if (value.type === "fatal") {
          finish(new Error(`TELEMETRY_START_FAILED: ${value.message}`));
          return;
        }
        if (value.type === "ready") {
          if (!this.initialized) {
            this.records.push(...value.records.map(record => ({ ...record })));
            trimRecords(this.records);
            this.nextObservationId = Math.max(
              1,
              ...this.records.map(record => record.observationId + 1)
            );
            this.initialized = true;
          }
          this.ready = true;
          finish();
          this.pump();
          return;
        }
        if (this.inFlight?.observationId !== value.observationId) return;
        this.inFlight = undefined;
        if (value.ok) this.lastPersistedAt = value.persistedAt;
        else this.failed += 1;
        this.pump();
      });
    });
  }

  private onExit(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.ready = false;
    if (this.inFlight) this.queue.unshift(this.inFlight);
    this.inFlight = undefined;
    while (this.queue.length > QUEUE_CAPACITY) {
      this.queue.pop();
      this.dropped += 1;
    }
    if (!this.closed) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** this.restartAttempts,
      RESTART_MAX_DELAY_MS
    );
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.spawnAndWait().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }

  private pump(): void {
    const child = this.child;
    if (
      this.closed || this.inFlight || this.queue.length === 0 ||
      !child?.connected || child.exitCode !== null
    ) return;
    const record = this.queue.shift() as TransportObservationRecord;
    const message: RecordMessage = { type: "record", record };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_MESSAGE_BYTES) {
      this.failed += 1;
      queueMicrotask(() => this.pump());
      return;
    }
    this.inFlight = record;
    child.send(message, error => {
      if (
        !error || this.child !== child ||
        this.inFlight?.observationId !== record.observationId
      ) return;
      this.inFlight = undefined;
      this.failed += 1;
      this.pump();
    });
  }

  private async closeChild(): Promise<void> {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const deadline = Date.now() + CLOSE_FLUSH_MS;
    while ((this.inFlight || this.queue.length > 0) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    this.dropped += this.queue.length + (this.inFlight ? 1 : 0);
    this.queue.length = 0;
    this.inFlight = undefined;
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: "close" } satisfies CloseMessage);
    await new Promise<void>(resolve => {
      let settled = false;
      const force = setTimeout(() => child.kill("SIGKILL"), FORCE_CLOSE_MS);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(force);
        resolve();
      };
      child.once("exit", finish);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
  }
}

async function runChild(file: string, freezePageCountAfterStartup: boolean): Promise<void> {
  let database: Database.Database | undefined;
  const send = (message: ChildMessage) => {
    if (!process.connected || !process.send) return;
    try { process.send(message, () => {}); } catch { /* Parent owns recovery. */ }
  };
  const close = () => {
    try { database?.close(); } finally {
      database = undefined;
      if (process.connected) process.disconnect();
    }
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    database = new Database(file);
    database.pragma("busy_timeout = 1000");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.pragma("wal_autocheckpoint = 128");
    database.exec(`
      CREATE TABLE IF NOT EXISTS transport_observations (
        observation_id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        scope_id TEXT,
        job_id TEXT,
        activity_id TEXT,
        tool_name TEXT,
        caller_request_digest TEXT,
        bridge_instance_id TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS transport_observations_recent
        ON transport_observations(created_at DESC, observation_id DESC);
    `);
    if (freezePageCountAfterStartup) {
      database.pragma("wal_checkpoint(TRUNCATE)");
      const pageCount = database.pragma("page_count", { simple: true }) as number;
      database.pragma(`max_page_count = ${pageCount}`);
    }
    try { chmodSync(file, 0o600); } catch { /* Best effort on non-POSIX filesystems. */ }
    const records = (database.prepare(
      "SELECT * FROM transport_observations ORDER BY observation_id ASC"
    ).all() as Array<Record<string, unknown>>).map(readRow);
    send({ type: "ready", records });
    process.on("message", value => {
      if (!isParentMessage(value)) return;
      if (value.type === "close") {
        close();
        return;
      }
      let ok = false;
      try {
        const record = normalizeRecord(
          value.record,
          value.record.bridgeInstanceId,
          value.record.observationId
        );
        database?.transaction(() => {
          database?.prepare(`
            INSERT OR IGNORE INTO transport_observations(
              observation_id, kind, scope_id, job_id, activity_id, tool_name,
              caller_request_digest, bridge_instance_id, reason_code, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            record.observationId,
            record.kind,
            record.scopeId || null,
            record.jobId || null,
            record.activityId || null,
            record.toolName || null,
            record.callerRequestDigest || null,
            record.bridgeInstanceId,
            record.reasonCode,
            record.createdAt
          );
          database?.prepare(`
            DELETE FROM transport_observations
             WHERE observation_id NOT IN (
               SELECT observation_id FROM transport_observations
                ORDER BY observation_id DESC LIMIT ?
             )
          `).run(RETENTION_LIMIT);
        })();
        ok = true;
      } catch {
        ok = false;
      }
      send({
        type: "ack",
        observationId: value.record.observationId,
        ok,
        ...(ok ? { persistedAt: Date.now() } : {})
      });
    });
    process.once("disconnect", close);
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  } catch (error) {
    send({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
    close();
    process.exitCode = 1;
  }
}

function normalizeRecord(
  input: TransportObservationInput | TransportObservationRecord,
  bridgeInstanceId: string,
  observationId: number
): TransportObservationRecord {
  if (!Number.isSafeInteger(observationId) || observationId < 1) {
    throw new Error("Invalid telemetry observation id.");
  }
  if (!TRANSPORT_OBSERVATION_KINDS.includes(input.kind)) {
    throw new Error("Unsupported transport observation kind.");
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!uuid.test(bridgeInstanceId)) throw new Error("Invalid telemetry bridge instance id.");
  const optionalId = (value: string | undefined, name: string) => {
    if (value !== undefined && !uuid.test(value)) throw new Error(`Invalid telemetry ${name}.`);
    return value;
  };
  const reasonCode = String(input.reasonCode || "");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(reasonCode)) {
    throw new Error("Invalid telemetry reason code.");
  }
  const toolName = input.toolName === undefined ? undefined : String(input.toolName);
  if (toolName !== undefined && (toolName.length < 1 || Buffer.byteLength(toolName, "utf8") > 100)) {
    throw new Error("Invalid telemetry tool name.");
  }
  const callerRequestDigest = input.callerRequestDigest === undefined
    ? undefined
    : String(input.callerRequestDigest);
  if (callerRequestDigest !== undefined && !/^[a-f0-9]{64}$/u.test(callerRequestDigest)) {
    throw new Error("Invalid telemetry request digest.");
  }
  const createdAt = "createdAt" in input
    ? input.createdAt
    : input.now ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("Invalid telemetry timestamp.");
  }
  return {
    observationId,
    kind: input.kind,
    ...((input.scopeId && { scopeId: optionalId(input.scopeId, "scope id") }) || {}),
    ...((input.jobId && { jobId: optionalId(input.jobId, "job id") }) || {}),
    ...((input.activityId && { activityId: optionalId(input.activityId, "activity id") }) || {}),
    ...(toolName ? { toolName } : {}),
    ...(callerRequestDigest ? { callerRequestDigest } : {}),
    bridgeInstanceId,
    reasonCode,
    createdAt
  };
}

function readRow(row: Record<string, unknown>): TransportObservationRecord {
  return normalizeRecord({
    observationId: Number(row.observation_id),
    kind: row.kind as TransportObservationKind,
    ...(row.scope_id ? { scopeId: String(row.scope_id) } : {}),
    ...(row.job_id ? { jobId: String(row.job_id) } : {}),
    ...(row.activity_id ? { activityId: String(row.activity_id) } : {}),
    ...(row.tool_name ? { toolName: String(row.tool_name) } : {}),
    ...(row.caller_request_digest
      ? { callerRequestDigest: String(row.caller_request_digest) }
      : {}),
    bridgeInstanceId: String(row.bridge_instance_id),
    reasonCode: String(row.reason_code),
    createdAt: Number(row.created_at)
  }, String(row.bridge_instance_id), Number(row.observation_id));
}

function trimRecords(records: TransportObservationRecord[]): void {
  if (records.length > RETENTION_LIMIT) records.splice(0, records.length - RETENTION_LIMIT);
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "fatal") return typeof message.message === "string";
  if (message.type === "ready") return Array.isArray(message.records);
  return message.type === "ack" && Number.isSafeInteger(message.observationId) &&
    typeof message.ok === "boolean";
}

function isParentMessage(value: unknown): value is ParentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "close") return true;
  return message.type === "record" && value !== undefined &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_MESSAGE_BYTES &&
    typeof message.record === "object";
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

const childFile = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
if (process.argv.includes(CHILD_FLAG)) {
  if (!childFile) throw new Error("Telemetry database path is required.");
  await runChild(childFile, process.argv.includes(FREEZE_PAGE_COUNT_FLAG));
}
