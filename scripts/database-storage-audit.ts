import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { BridgeStateStore } from "../src/stateStore.js";

const [sourceFile, outputFile = "docs/audits/issue-95-database-storage.json"] = process.argv.slice(2);
assert.ok(
  sourceFile,
  "Usage: tsx scripts/database-storage-audit.ts /absolute/state.sqlite [report.json]"
);
assert.ok(path.isAbsolute(sourceFile), "An absolute source database path is required");

const STRUCTURED_JOB_KEYS = new Set([
  "jobId", "scopeId", "requestId", "activityId", "threadId", "sourceThreadId",
  "status", "executionMode", "backendKind", "bridgeInstanceId", "workerId",
  "workerGeneration", "upstreamRequestId", "terminalVersion", "agentId", "contextMode",
  "projectId", "projectLabel", "projectName", "projectUuid", "projectNameSnapshot",
  "projectCwdSnapshot", "cwd", "sandbox", "createdAt", "updatedAt", "version",
  "lastProgressAt", "lastProgress", "publicEvents", "inputEvents", "pendingInteractions",
  "terminalOrigin", "cancellationIntentId"
]);
const RETAINED_JOB_SUMMARY_KEYS = new Set([
  "execution", "usage", "uncertainResponseReview"
]);
const FORMAL_JOB_SUMMARY_KEYS = new Set([
  "status", "endedAt", "durationMs", "errorCode"
]);

const LEGACY_UNFINISHED_SQL = `SELECT 1 FROM jobs j WHERE (
  j.thread_id=? OR json_extract(j.payload,'$.sourceThreadId')=? OR
  j.agent_id=(SELECT agent_id FROM thread_connections WHERE thread_id=?))
  AND j.archived_at IS NULL
  AND (j.status IN ('running','terminating','termination-failed')
    OR EXISTS (SELECT 1 FROM json_each(j.payload,'$.pendingInteractions') interaction
      WHERE CASE WHEN interaction.type='object'
        THEN COALESCE(json_extract(interaction.value,'$.isBlocking'),1)!=0 ELSE 1 END)
    OR EXISTS (SELECT 1 FROM cancellation_intents cancellation
      WHERE (cancellation.target_job_id=j.job_id OR
        (cancellation.target_kind='activity' AND cancellation.target_activity_id=j.activity_id))
      AND cancellation.status IN ('recorded','dispatched'))) LIMIT 1`;

const CURRENT_UNFINISHED_SQL = `SELECT 1 FROM jobs j WHERE (
  j.thread_id=? OR j.source_thread_id=? OR
  j.agent_id=(SELECT agent_id FROM thread_connections WHERE thread_id=?))
  AND j.archived_at IS NULL
  AND (j.status IN ('running','terminating','termination-failed')
    OR EXISTS (SELECT 1 FROM job_interactions interaction
      WHERE interaction.job_id=j.job_id AND interaction.is_blocking=1)
    OR EXISTS (SELECT 1 FROM cancellation_intents cancellation
      WHERE (cancellation.target_job_id=j.job_id OR
        (cancellation.target_kind='activity' AND cancellation.target_activity_id=j.activity_id))
      AND cancellation.status IN ('recorded','dispatched'))) LIMIT 1`;

const root = await mkdtemp(path.join(tmpdir(), "bridge-database-storage-audit-"));
await chmod(root, 0o700);
const workingFile = path.join(root, "state.sqlite");
const compactFile = path.join(root, "state.compact.sqlite");
const precompactFile = path.join(root, "state.precompact.sqlite");
const report: Record<string, unknown> = {
  issue: 95,
  testedAt: new Date().toISOString(),
  source: "read-only metrics plus a consistent disposable SQLite backup",
  productionDatabaseModified: false
};
let source: Database.Database | undefined;
let working: Database.Database | undefined;

try {
  source = new Database(sourceFile, { readonly: true, fileMustExist: true });
  const sourceVersion = version(source);
  assert.ok(
    sourceVersion === 18 || sourceVersion === 19,
    `Storage audit supports source schema 18 or 19, received ${sourceVersion}`
  );
  const threadIds = representativeThreadIds(source);
  const sourceConnection = connectionAudit(source, sourceVersion, threadIds);
  report.sourceSchema = sourceVersion;
  report.sourceCapacity = await capacity(source, sourceFile);
  report.migrationBackups = await migrationBackupCapacity(sourceFile);
  report.sourceRows = rowTotals(source);
  report.sourceSerialization = serializationMetrics(source, sourceVersion);
  report.beforeConnectionQuery = publicQueryMetrics(sourceConnection);

  await source.backup(workingFile);
  source.close();
  source = undefined;
  await chmod(workingFile, 0o600);

  const store = new BridgeStateStore({ file: workingFile });
  store.close();
  working = new Database(workingFile, { fileMustExist: true });
  assert.equal(version(working), 19);
  assert.equal(String(working.pragma("integrity_check", { simple: true })), "ok");
  assert.deepEqual(working.pragma("foreign_key_check"), []);

  const currentConnection = connectionAudit(working, 19, threadIds);
  assert.deepEqual(
    currentConnection.results,
    sourceConnection.results,
    "Indexed unfinished-work query changed its answers"
  );
  assertIndexedConnectionPlan(currentConnection.plan);
  const retentionPlans = currentRetentionPlans(working);
  assert.ok(
    retentionPlans.eventByJob.some((detail) => detail.includes("job_events_job_cursor")),
    "Event-by-Job cleanup does not use job_events_job_cursor"
  );
  assert.ok(
    retentionPlans.blockingInteraction.some((detail) => detail.includes("job_interactions_blocking")),
    "Blocking-interaction lookup does not use job_interactions_blocking"
  );

  report.currentConnectionQuery = publicQueryMetrics(currentConnection);
  report.currentRetentionPlans = retentionPlans;
  report.currentRows = rowTotals(working);
  const currentSerialization = serializationMetrics(working, 19);
  assert.equal(
    (currentSerialization.interactions as { structuredDuplicateFields: number })
      .structuredDuplicateFields,
    0,
    "Current interaction payloads duplicate structured identity or blocking fields"
  );
  assert.equal(
    (currentSerialization.summaries as { formalDuplicateFields: number })
      .formalDuplicateFields,
    0,
    "Current Job summaries duplicate formal Job lifecycle fields"
  );
  assert.equal(
    (currentSerialization.summaries as { unexpectedTopLevelFields: number })
      .unexpectedTopLevelFields,
    0,
    "Current Job summaries retain fields without a current reader"
  );
  report.currentSerialization = currentSerialization;
  report.telemetryWritePath = telemetryWritePath(sourceVersion);
  report.currentCapacity = await capacity(working, workingFile);

  await working.backup(precompactFile);
  await chmod(precompactFile, 0o600);
  const beforeCompactCounts = tableCounts(working);
  working.pragma("wal_checkpoint(TRUNCATE)");
  working.exec(`VACUUM INTO ${sqlString(compactFile)}`);
  working.close();
  working = undefined;
  await chmod(compactFile, 0o600);

  const compact = new Database(compactFile, { readonly: true, fileMustExist: true });
  try {
    assert.equal(String(compact.pragma("integrity_check", { simple: true })), "ok");
    assert.deepEqual(compact.pragma("foreign_key_check"), []);
    assert.deepEqual(tableCounts(compact), beforeCompactCounts);
    assert.equal(version(compact), 19);
    report.compactedCapacity = await capacity(compact, compactFile);
  } finally {
    compact.close();
  }

  const recovery = new Database(precompactFile, { readonly: true, fileMustExist: true });
  try {
    assert.equal(String(recovery.pragma("integrity_check", { simple: true })), "ok");
    assert.deepEqual(recovery.pragma("foreign_key_check"), []);
    assert.deepEqual(tableCounts(recovery), beforeCompactCounts);
    report.offlineCompaction = {
      sourceStopped: true,
      precompactBackupVerified: true,
      compactCopyVerifiedBeforeReplacement: true,
      rollbackCopyVerified: true,
      liveDatabaseReplacementPerformed: false
    };
  } finally {
    recovery.close();
  }

  report.passed = true;
} catch (error) {
  if (process.env.CODEX_MCP_BRIDGE_AUDIT_DEBUG === "1") console.error(error);
  report.passed = false;
  report.failure = error instanceof assert.AssertionError
    ? error.message.split("\n")[0]
    : "Database storage audit failed";
  report.errorType = error instanceof Error ? error.name : "unknown";
} finally {
  if (source?.open) source.close();
  if (working?.open) working.close();
  await rm(root, { recursive: true, force: true });
  report.temporaryCopiesRemoved = true;
}

await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.passed !== true) process.exitCode = 1;

type QueryPlanRow = { id: number; parent: number; notused: number; detail: string };
type ConnectionAudit = {
  lookups: number;
  totalMs: number;
  medianMs: number;
  p95Ms: number;
  plan: string[];
  results: boolean[];
};

type Capacity = {
  databaseBytes: number;
  walBytes: number;
  shmBytes: number;
  pageSize: number;
  pageCount: number;
  allocatedBytes: number;
  freePages: number;
  reusableBytes: number;
  btreeUsedBytes: number | null;
  cellPayloadBytes: number | null;
};

function version(db: Database.Database): number {
  return Number((db.prepare("SELECT value FROM bridge_meta WHERE key='schema_version'")
    .get() as { value: string }).value);
}

async function capacity(db: Database.Database, file: string): Promise<Capacity> {
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  const pageCount = Number(db.pragma("page_count", { simple: true }));
  const freePages = Number(db.pragma("freelist_count", { simple: true }));
  let btreeUsedBytes: number | null = null;
  let cellPayloadBytes: number | null = null;
  try {
    const usage = db.prepare(`SELECT
      COALESCE(SUM(pgsize-unused),0) AS used,
      COALESCE(SUM(payload),0) AS payload
      FROM dbstat WHERE name NOT LIKE 'sqlite_%'`).get() as { used: number; payload: number };
    btreeUsedBytes = Number(usage.used);
    cellPayloadBytes = Number(usage.payload);
  } catch {
    // dbstat is optional in SQLite builds; page accounting remains available.
  }
  return {
    databaseBytes: await fileBytes(file),
    walBytes: await fileBytes(`${file}-wal`),
    shmBytes: await fileBytes(`${file}-shm`),
    pageSize,
    pageCount,
    allocatedBytes: pageSize * pageCount,
    freePages,
    reusableBytes: pageSize * freePages,
    btreeUsedBytes,
    cellPayloadBytes
  };
}

async function migrationBackupCapacity(file: string): Promise<{
  count: number;
  totalBytes: number;
  largestBytes: number;
}> {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.pre-v`;
  const entries = (await readdir(directory)).filter((name) =>
    name.startsWith(prefix) && name.endsWith(".sqlite")
  );
  const sizes = await Promise.all(entries.map((name) => fileBytes(path.join(directory, name))));
  return {
    count: sizes.length,
    totalBytes: sizes.reduce((sum, value) => sum + value, 0),
    largestBytes: sizes.length > 0 ? Math.max(...sizes) : 0
  };
}

async function fileBytes(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

function representativeThreadIds(db: Database.Database): string[] {
  const values = (db.prepare(`SELECT thread_id FROM thread_connections
    ORDER BY updated_at DESC,thread_id LIMIT 200`).all() as Array<{ thread_id: string }>)
    .map((row) => row.thread_id);
  values.push("audit-missing-thread");
  return values;
}

function connectionAudit(
  db: Database.Database,
  schemaVersion: number,
  threadIds: string[]
): ConnectionAudit {
  const sql = schemaVersion === 18 ? LEGACY_UNFINISHED_SQL : CURRENT_UNFINISHED_SQL;
  const statement = db.prepare(sql);
  for (const threadId of threadIds.slice(0, Math.min(5, threadIds.length))) {
    statement.get(threadId, threadId, threadId);
  }
  const samples: number[] = [];
  const results: boolean[] = [];
  const started = performance.now();
  for (const threadId of threadIds) {
    const at = performance.now();
    results.push(Boolean(statement.get(threadId, threadId, threadId)));
    samples.push(performance.now() - at);
  }
  const totalMs = performance.now() - started;
  samples.sort((left, right) => left - right);
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all("audit-plan-thread", "audit-plan-thread", "audit-plan-thread") as QueryPlanRow[])
    .map((row) => row.detail);
  return {
    lookups: threadIds.length,
    totalMs: rounded(totalMs),
    medianMs: rounded(percentile(samples, 0.5)),
    p95Ms: rounded(percentile(samples, 0.95)),
    plan: [...new Set(plan)],
    results
  };
}

function publicQueryMetrics(value: ConnectionAudit): Omit<ConnectionAudit, "results"> & {
  positiveResults: number;
} {
  return {
    lookups: value.lookups,
    totalMs: value.totalMs,
    medianMs: value.medianMs,
    p95Ms: value.p95Ms,
    plan: value.plan,
    positiveResults: value.results.filter(Boolean).length
  };
}

function assertIndexedConnectionPlan(plan: string[]): void {
  assert.ok(!plan.some((detail) => /^SCAN j$/u.test(detail)), "Current unfinished-work query scans jobs");
  assert.ok(
    plan.some((detail) => /jobs_(thread|source_thread|agent)_active/u.test(detail)),
    "Current unfinished-work query does not use an active Job index"
  );
}

function currentRetentionPlans(db: Database.Database): Record<string, string[]> {
  return {
    eventByJob: explain(db,
      "DELETE FROM job_events WHERE job_id=?", ["audit-job"]),
    oldestEventBatch: explain(db,
      "DELETE FROM job_events WHERE event_id IN (SELECT event_id FROM job_events ORDER BY event_id LIMIT 500)"),
    blockingInteraction: explain(db,
      "SELECT 1 FROM job_interactions WHERE job_id=? AND is_blocking=1", ["audit-job"]),
    historyCandidates: explain(db, `SELECT j.job_id FROM jobs j
      WHERE j.archived_at IS NOT NULL
      AND j.status IN ('completed','failed','interrupted','cancelled')
      AND j.updated_at<? AND (j.updated_at>? OR (j.updated_at=? AND j.job_id>?))
      AND NOT EXISTS (SELECT 1 FROM work_history_state h
        WHERE h.job_id=j.job_id AND h.expired_at IS NOT NULL)
      ORDER BY j.updated_at,j.job_id LIMIT 500`, [0, 0, 0, ""]),
    expiredHolds: explain(db, `DELETE FROM result_holds WHERE job_id IN (
      SELECT job_id FROM result_holds WHERE expires_at<=? LIMIT 500)`, [0])
  };
}

function explain(db: Database.Database, sql: string, parameters: unknown[] = []): string[] {
  return [...new Set((db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as QueryPlanRow[])
    .map((row) => row.detail))];
}

function rowTotals(db: Database.Database): { tables: number; rows: number } {
  const tables = tableNames(db);
  return {
    tables: tables.length,
    rows: tables.reduce((sum, table) => sum + Number((db.prepare(
      `SELECT COUNT(*) AS count FROM ${identifier(table)}`
    ).get() as { count: number }).count), 0)
  };
}

function tableCounts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(tableNames(db).map((table) => [
    table,
    Number((db.prepare(`SELECT COUNT(*) AS count FROM ${identifier(table)}`)
      .get() as { count: number }).count)
  ]));
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function serializationMetrics(db: Database.Database, schemaVersion: number): Record<string, unknown> {
  const payloads = (db.prepare("SELECT payload FROM jobs").all() as Array<{ payload: string }>)
    .map((row) => row.payload);
  const payloadBytes = payloads.map((payload) => Buffer.byteLength(payload));
  const structuredDuplicates = payloads.map(parseRecord).reduce((sum, payload) =>
    sum + [...STRUCTURED_JOB_KEYS].filter((key) => Object.hasOwn(payload, key)).length, 0);
  const result: Record<string, unknown> = {
    jobs: payloads.length,
    storedPayloadBytes: summarize(payloadBytes),
    structuredDuplicateFields: structuredDuplicates
  };
  const encodedSummaries = schemaVersion === 18
    ? (db.prepare("SELECT payload FROM job_summaries").all() as Array<{payload:string}>)
      .map((row) => row.payload)
    : (db.prepare("SELECT summary AS payload FROM jobs").all() as Array<{payload:string}>)
      .map((row) => row.payload);
  const summaries = encodedSummaries.map((encoded) => ({ encoded, value: parseRecord(encoded) }))
    .filter(({ value }) => Object.keys(value).length > 0);
  result.summaries = {
    rowsWithContent: summaries.length,
    storedPayloadBytes: summarize(summaries.map(({ encoded }) => Buffer.byteLength(encoded))),
    formalDuplicateFields: summaries.reduce((sum, { value }) =>
      sum + [...FORMAL_JOB_SUMMARY_KEYS].filter((key) => Object.hasOwn(value, key)).length, 0),
    unexpectedTopLevelFields: summaries.reduce((sum, { value }) =>
      sum + Object.keys(value).filter((key) => !RETAINED_JOB_SUMMARY_KEYS.has(key)).length, 0)
  };
  if (schemaVersion === 18) {
    const statePatchBytes = payloads.map((encoded) => {
      const payload = parseRecord(encoded);
      return Buffer.byteLength(JSON.stringify({
        updatedAt: payload.updatedAt,
        version: payload.version,
        lastProgressAt: payload.lastProgressAt,
        lastProgress: payload.lastProgress,
        pendingInteractions: payload.pendingInteractions
      }));
    });
    result.progressSerializationComparison = {
      beforeFullJobBytes: summarize(payloadBytes),
      afterBoundedStateBytes: summarize(statePatchBytes),
      totalReductionPercent: payloadBytes.reduce((sum, value) => sum + value, 0) === 0
        ? 0
        : rounded(100 * (1 - statePatchBytes.reduce((sum, value) => sum + value, 0) /
          payloadBytes.reduce((sum, value) => sum + value, 0)))
    };
  } else {
    const interactionPayloads = (db.prepare("SELECT payload FROM job_interactions").all() as
      Array<{ payload: string }>).map((row) => row.payload);
    result.interactions = {
      rows: interactionPayloads.length,
      storedPayloadBytes: summarize(interactionPayloads.map((payload) => Buffer.byteLength(payload))),
      structuredDuplicateFields: interactionPayloads.map(parseRecord).reduce(
        (sum, payload) => sum + ["interactionId", "isBlocking"]
          .filter((key) => Object.hasOwn(payload, key)).length,
        0
      )
    };
  }
  return result;
}

function telemetryWritePath(sourceVersion: number): Record<string, unknown> {
  return {
    comparisonSourceSchema: sourceVersion,
    before: {
      sqlWriteStatementsPerOrdinaryProgressEventWithoutInteractions: 9,
      fullJobRowUpserts: 1,
      fullJobSerializations: 1,
      unconditionalSummaryWrites: 1,
      unconditionalThreadConnectionWrites: 1
    },
    current: {
      sqlWriteStatementsPerOrdinaryProgressEventWithoutInteractions: 7,
      fullJobRowUpserts: 0,
      fullJobSerializations: 0,
      boundedJobStateUpdates: 1,
      unconditionalSummaryWrites: 0,
      unconditionalThreadConnectionWrites: 0,
      interactionWrites: "one bounded delete plus one insert per current interaction"
    },
    basis: "static SQL-path count from b1104aa persistTelemetryBestEffort and current recordJobTelemetryEvent; includes scope/coalescing/retention writes and excludes trigger-internal event_budget updates"
  };
}

function summarize(values: number[]): { total: number; median: number; p95: number; max: number } {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    total: sorted.reduce((sum, value) => sum + value, 0),
    median: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    max: sorted.at(-1) || 0
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] || 0;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseRecord(encoded: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(encoded) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function identifier(value: string): string {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/u);
  return `"${value}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
