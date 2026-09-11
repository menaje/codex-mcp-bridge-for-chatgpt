import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createBridgeMcpServer } from "../src/server.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import { UserSettingsStore } from "../src/userSettings.js";

// Open an explicit source read-only, make a consistent private SQLite backup,
// and exercise migration plus two initializations only on that disposable copy.
// No listener, companion, model lookup, or Codex execution is started.
const [sourceFile, outputFile = "docs/audits/issue-95-state-restart.json"] = process.argv.slice(2);
assert.ok(
  sourceFile,
  "Usage: tsx scripts/card-state-restart-audit.ts /absolute/state.sqlite [report.json]"
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
const TERMINAL_ORIGINS = new Set([
  "normal-completion", "upstream-failure", "app-server-interrupted", "explicit-cancellation",
  "assignment-containment", "bridge-restart", "worker-loss", "sdk-abort", "sdk-timeout",
  "authentication-failure", "usage-limit", "legacy-unattributed-cancellation"
]);
const EXACT_CRITICAL_TABLES = [
  "project_registry", "projects", "user_settings", "activity_agents",
  "activity_events", "job_events", "completion_outbox", "agent_mutations",
  "cancellation_operations", "cancellation_intents", "steering_deliveries",
  "transport_observations", "user_questions", "codex_question_deliveries",
  "thread_connections", "result_holds", "automatic_recovery",
  "automatic_recovery_incidents"
] as const;

const auditAt = Date.now();
const root = await mkdtemp(path.join(tmpdir(), "bridge-state-restart-audit-"));
await chmod(root, 0o700);
const baseline = path.join(root, "source.sqlite");
const copy = path.join(root, "state.sqlite");
const report: Record<string, unknown> = {
  issue: 95,
  testedAt: new Date(auditAt).toISOString(),
  source: "consistent read-only backup of the explicitly supplied database",
  productionDatabaseModified: false,
  codexCalls: 0,
  appReads: 0,
  restartPasses: []
};
let source: Database.Database | undefined;
let state: BridgeStateStore | undefined;
let server: ReturnType<typeof createBridgeMcpServer> | undefined;
let client: Client | undefined;

try {
  source = new Database(sourceFile, { readonly: true, fileMustExist: true });
  await source.backup(baseline);
  source.close();
  source = undefined;
  await chmod(baseline, 0o600);

  source = new Database(baseline, { readonly: true, fileMustExist: true });
  const sourceVersion = schemaVersion(source);
  assert.ok(
    sourceVersion === 18 || sourceVersion === 19,
    `Restart audit supports source schema 18 or 19, received ${sourceVersion}`
  );
  report.sourceSchema = sourceVersion;
  report.sourceCounts = redactedCounts(source);
  const preservedKeys = preservationKeys(source, sourceVersion, auditAt);
  const jobReceipts = jobReceiptDigest(source, sourceVersion);
  const sessionContexts = sessionContextDigest(source, sourceVersion);
  const agentThreadRelationships = agentThreadRelationshipDigest(source, sourceVersion);
  const scopeState = scopeStateDigest(source, sourceVersion);
  const activityState = activityStateDigest(source, sourceVersion);
  const agentState = agentStateDigest(source, sourceVersion);
  const workHistoryState = workHistoryStateDigest(source, sourceVersion);
  const criticalPayloads = exactCriticalTableSnapshots(source);
  const criticalState = criticalStateCounts(source, sourceVersion, auditAt);
  report.criticalState = criticalState;
  report.approvedDrops = approvedDropCounts(source, sourceVersion);

  await source.backup(copy);
  source.close();
  source = undefined;
  await chmod(copy, 0o600);

  report.stage = "migrate-copy";
  state = new BridgeStateStore({ file: copy });
  state.close();
  state = undefined;

  const migrated = new Database(copy, { readonly: true, fileMustExist: true });
  try {
    assert.equal(schemaVersion(migrated), 19);
    assert.equal(String(migrated.pragma("integrity_check", { simple: true })), "ok");
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
    assertPreservedKeys(preservedKeys, preservationKeys(migrated, 19, auditAt));
    assert.deepEqual(jobReceiptDigest(migrated, 19), jobReceipts);
    assert.deepEqual(
      sessionContextDigest(migrated, 19, sessionContexts.threadIds).snapshot,
      sessionContexts.snapshot,
      "Surviving session execution contexts changed during migration"
    );
    assert.deepEqual(
      agentThreadRelationshipDigest(migrated, 19),
      agentThreadRelationships,
      "Surviving Agent/thread relationships changed during migration"
    );
    assert.deepEqual(scopeStateDigest(migrated, 19), scopeState,
      "Scope versions or timestamps changed during migration");
    assert.deepEqual(activityStateDigest(migrated, 19), activityState,
      "Activity ownership or lifecycle state changed during migration");
    assert.deepEqual(agentStateDigest(migrated, 19), agentState,
      "Agent identity or lifecycle state changed during migration");
    assert.deepEqual(workHistoryStateDigest(migrated, 19), workHistoryState,
      "Work-history acknowledgement or expiry state changed during migration");
    assert.deepEqual(
      exactCriticalTableSnapshots(migrated),
      criticalPayloads,
      "Critical request, question, cancellation, recovery, or delivery payloads changed during migration"
    );
    assert.deepEqual(criticalStateCounts(migrated, 19, auditAt), criticalState);
    assertCurrentSchema(migrated);
    report.currentSchema = 19;
    report.currentTableCount = tableNames(migrated).length;
    report.currentIndexCount = objectCount(migrated, "index");
    report.currentTriggerCount = objectCount(migrated, "trigger");
    report.preservedEntities = Object.fromEntries(
      Object.entries(preservedKeys).map(([name, value]) => [name, value.count])
    );
    report.jobReceipts = jobReceipts;
    report.sessionContexts = sessionContexts.snapshot;
    report.agentThreadRelationships = agentThreadRelationships;
    report.scopeState = scopeState;
    report.activityState = activityState;
    report.agentState = agentState;
    report.workHistoryState = workHistoryState;
    report.exactCriticalTables = criticalPayloads;
  } finally {
    migrated.close();
  }

  let stableBaseline: Record<string, { count: number; digest: string }> | undefined;
  for (let pass = 1; pass <= 2; pass += 1) {
    report.stage = `restart-${pass}`;
    state = new BridgeStateStore({ file: copy });
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: copy
    });
    const settings = new UserSettingsStore(config, { stateStore: state });
    const sessions = new SessionRegistry({ stateStore: state });
    const jobs = new CodexJobRegistry({ stateStore: state });
    const catalog = {
      source: "codex-cli",
      fetchedAt: new Date(auditAt).toISOString(),
      validatedAt: new Date(auditAt).toISOString(),
      fingerprint: "a".repeat(64),
      cached: true,
      stale: false,
      validation: "valid",
      models: []
    };
    server = createBridgeMcpServer(
      config,
      {
        async listTools() { return { tools: [] }; },
        async callTool() {
          report.codexCalls = Number(report.codexCalls) + 1;
          throw new Error("Codex execution is forbidden in the restart audit");
        },
        async close() {}
      },
      sessions,
      jobs,
      {
        async getCatalog() { return catalog as never; },
        getCachedCatalog() { return catalog as never; }
      },
      settings
    );
    client = new Client({ name: "card-state-restart-audit", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const discovered = (await client.listTools()).tools.map((tool) => tool.name).sort();
    for (const required of ["codex_task", "codex_ui_read"]) {
      assert.ok(discovered.includes(required), `Required tool ${required} was not discovered`);
    }
    for (const arguments_ of [
      { view: "settings" },
      { view: "dashboard", widgetInstanceId: randomUUID(), enrich: false }
    ]) {
      const result = await client.callTool({
        name: "codex_ui_read",
        arguments: arguments_,
        _meta: { "openai/session": "isolated-restart-audit" }
      });
      assert.notEqual(result.isError, true, `${arguments_.view} read failed on copied state`);
      report.appReads = Number(report.appReads) + 1;
    }

    await client.close();
    client = undefined;
    await server.close();
    server = undefined;
    await jobs.closeThreadConnections();
    state.close();
    state = undefined;

    const after = stableStateSnapshot(copy, auditAt);
    const changes = stableBaseline ? changedSnapshots(stableBaseline, after) : [];
    if (stableBaseline) {
      assert.deepEqual(changes, [], "Business state changed during the second read-only restart");
    } else {
      stableBaseline = after;
    }
    (report.restartPasses as unknown[]).push({
      pass,
      discoveredToolCount: discovered.length,
      stableAgainstPreviousPass: pass === 1 ? null : changes.length === 0,
      changedTables: changes
    });
  }

  assert.equal(report.codexCalls, 0);
  report.stage = "complete";
  report.passed = true;
} catch (error) {
  if (process.env.CODEX_MCP_BRIDGE_AUDIT_DEBUG === "1") console.error(error);
  report.passed = false;
  report.failure = error instanceof assert.AssertionError
    ? error.message.split("\n")[0]
    : "Audit initialization, migration, or semantic comparison failed";
  report.errorType = error instanceof Error ? error.name : "unknown";
} finally {
  if (source?.open) source.close();
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  state?.close();
  await rm(root, { recursive: true, force: true });
  report.temporaryCopyRemoved = true;
}

await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.passed !== true) process.exitCode = 1;

type Snapshot = { count: number; digest: string };
type Row = Record<string, unknown>;
type SemanticSnapshot = { snapshot: Snapshot; threadIds: Set<string> };

function schemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM bridge_meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  return Number(row?.value);
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function objectCount(db: Database.Database, type: "index" | "trigger"): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type=? AND name NOT LIKE 'sqlite_%'`).get(type) as { count: number }).count);
}

function redactedCounts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(tableNames(db).map((table) => [table, count(db, table)]));
}

function count(db: Database.Database, table: string, where = "", parameters: unknown[] = []): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${identifier(table)} ${where}`)
    .get(...parameters) as { count: number }).count);
}

function preservationKeys(
  db: Database.Database,
  version: number,
  now: number
): Record<string, Snapshot> {
  const retained = [
    "scopes", "project_registry", "projects", "user_settings", "activities", "agents",
    "activity_agents", "jobs", "activity_events", "completion_outbox", "agent_mutations",
    "cancellation_operations", "cancellation_intents", "steering_deliveries",
    "transport_observations", "codex_question_deliveries", "thread_connections",
    "automatic_recovery", "automatic_recovery_incidents"
  ];
  const result: Record<string, Snapshot> = {};
  for (const table of retained) {
    if (tableNames(db).includes(table)) result[table] = keySnapshot(db, table);
  }

  if (version === 18) {
    const contexts = acceptedLegacyContexts(db);
    result.sessions = snapshotValues(contexts.sessionThreadIds);
    result.agent_threads = snapshotValues(contexts.agentThreadIds);
  } else {
    result.sessions = keySnapshot(db, "sessions");
    result.agent_threads = keySnapshot(db, "agent_threads");
  }

  result.job_events = queryKeySnapshot(db,
    "SELECT e.event_id AS key FROM job_events e JOIN jobs j ON j.job_id=e.job_id");
  result.result_holds = queryKeySnapshot(db,
    "SELECT h.job_id AS key FROM result_holds h JOIN jobs j ON j.job_id=h.job_id");
  result.work_history_state = queryKeySnapshot(db,
    "SELECT h.job_id AS key FROM work_history_state h JOIN jobs j ON j.job_id=h.job_id");
  result.user_questions = queryKeySnapshot(db,
    "SELECT question_id AS key FROM user_questions WHERE expires_at>?", [now]);
  return result;
}

function assertPreservedKeys(
  expected: Record<string, Snapshot>,
  actual: Record<string, Snapshot>
): void {
  for (const [table, snapshot] of Object.entries(expected)) {
    assert.deepEqual(actual[table], snapshot, `Preserved entity keys changed in ${table}`);
  }
}

function keySnapshot(db: Database.Database, table: string): Snapshot {
  const columns = (db.pragma(`table_info(${identifier(table)})`) as Array<{
    name: string;
    pk: number;
  }>).filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk);
  assert.ok(columns.length > 0, `Table ${table} has no declared primary key`);
  const expression = columns.length === 1
    ? `${identifier(columns[0]!.name)} AS key`
    : `json_array(${columns.map((column) => identifier(column.name)).join(",")}) AS key`;
  return queryKeySnapshot(db, `SELECT ${expression} FROM ${identifier(table)}`);
}

function queryKeySnapshot(
  db: Database.Database,
  sql: string,
  parameters: unknown[] = []
): Snapshot {
  const values = (db.prepare(sql).all(...parameters) as Array<{ key: unknown }>)
    .map((row) => canonical(row.key)).sort();
  return { count: values.length, digest: hash(values) };
}

function snapshotValues(values: Iterable<string>): Snapshot {
  const canonicalValues = [...values].map(canonical).sort();
  return { count: canonicalValues.length, digest: hash(canonicalValues) };
}

function acceptedLegacyContexts(db: Database.Database): {
  sessionThreadIds: Set<string>;
  agentThreadIds: Set<string>;
} {
  const projects = new Set(allRows(db, "projects").map((row) => String(row.project_id)));
  const legacySessions = allRows(db, "sessions");
  const sessionsByThread = new Map(
    legacySessions.map((row) => [String(row.thread_id), row])
  );
  const sessionThreadIds = new Set(
    legacySessions
      .filter((row) => acceptedLegacyProjectContext(row, projects, true))
      .map((row) => String(row.thread_id))
  );
  const acceptedAgentRows = allRows(db, "agent_threads").filter((row) =>
    acceptedLegacyProjectContext(row, projects, false)
  );
  for (const row of acceptedAgentRows) {
    const threadId = String(row.thread_id);
    if (!sessionsByThread.has(threadId)) sessionThreadIds.add(threadId);
  }
  const agentThreadIds = new Set(
    acceptedAgentRows
      .map((row) => String(row.thread_id))
      .filter((threadId) => sessionThreadIds.has(threadId))
  );
  return { sessionThreadIds, agentThreadIds };
}

function acceptedLegacyProjectContext(
  row: Row,
  projects: Set<string>,
  includeSessionPayload: boolean
): boolean {
  const projectId = row.project_uuid ?? row.project_id;
  if (projectId !== null && projectId !== undefined && projects.has(String(projectId))) {
    return true;
  }
  const metadata = [
    row.project_id,
    row.project_label,
    row.project_uuid,
    row.project_name_snapshot
  ];
  if (includeSessionPayload) {
    const payload = parseObject(row.payload);
    metadata.push(payload.projectId, payload.projectLabel);
  }
  return metadata.every((value) => value === null || value === undefined);
}

function agentThreadRelationshipDigest(db: Database.Database, version: number): Snapshot {
  const accepted = version === 18 ? acceptedLegacyContexts(db).agentThreadIds : undefined;
  const values = allRows(db, "agent_threads")
    .filter((row) => accepted === undefined || accepted.has(String(row.thread_id)))
    .map((row) => canonical({
      threadId: row.thread_id,
      agentId: row.agent_id,
      contextMode: row.context_mode,
      isCurrent: row.is_current,
      linkedAt: row.linked_at,
      replacedAt: row.replaced_at
    }))
    .sort();
  return { count: values.length, digest: hash(values) };
}

function scopeStateDigest(db: Database.Database, version: number): Snapshot {
  const rows = version === 19
    ? allRows(db, "scopes")
    : db.prepare(`SELECT s.scope_id,COALESCE(v.version,0) AS version,s.created_at,
        MAX(s.updated_at,COALESCE(v.updated_at,s.updated_at)) AS updated_at
      FROM scopes s LEFT JOIN scope_versions v ON v.scope_id=s.scope_id`).all() as Row[];
  return snapshotRows(rows);
}

function activityStateDigest(db: Database.Database, version: number): Snapshot {
  if (version === 19) return snapshotRows(allRows(db, "activities"));
  const rows = db.prepare(`SELECT
      a.activity_id,a.scope_id,p.project_id,
      CASE WHEN p.project_id IS NOT NULL THEN
        COALESCE(a.project_cwd_snapshot,a.project_cwd,p.cwd) END AS pinned_cwd,
      a.continuation_of_activity_id,a.card_generation,a.title,a.kind,
      CASE a.execution_mode WHEN 'foreground' THEN 'foreground' ELSE 'background' END
        AS execution_mode,
      a.handoff_policy,a.completion_trigger,a.lifecycle,a.waiting_on,a.verification,
      a.version,a.completion_version,a.legacy,a.created_at,a.updated_at,a.sealed_at,
      a.completed_at,a.total_jobs,a.running_jobs,a.completed_jobs,a.failed_jobs,
      a.interrupted_jobs,a.cancelled_jobs,a.terminal_jobs
    FROM activities a LEFT JOIN projects p
      ON p.project_id=COALESCE(a.project_uuid,a.project_id)`).all() as Row[];
  return snapshotRows(rows);
}

function agentStateDigest(db: Database.Database, version: number): Snapshot {
  if (version === 19) return snapshotRows(allRows(db, "agents"));
  const acceptedThreads = acceptedLegacyContexts(db).agentThreadIds;
  const relationships = new Map(allRows(db, "agent_threads")
    .filter((row) => acceptedThreads.has(String(row.thread_id)))
    .map((row) => [String(row.thread_id), row]));
  const rows = allRows(db, "agents").map((row) => {
    const oldCurrentThreadId = nonempty(row.current_thread_id);
    const relationship = oldCurrentThreadId ? relationships.get(oldCurrentThreadId) : undefined;
    const currentThreadId = relationship?.agent_id === row.agent_id
      ? oldCurrentThreadId || null
      : null;
    let lifecycle = row.lifecycle === "archived" ? "idle" : row.lifecycle;
    let currentJobId = row.current_job_id;
    let versionValue = Number(row.version);
    let orphanedReason = row.orphaned_reason;
    if ((lifecycle === "active" || lifecycle === "waiting-input") && !currentThreadId) {
      lifecycle = "orphaned";
      currentJobId = null;
      orphanedReason ??= "legacy-project-context-removed";
      versionValue += 1;
    }
    return {
      agent_id: row.agent_id,
      scope_id: row.scope_id,
      agent_name: row.agent_name,
      normalized_name: row.normalized_name,
      lifecycle,
      current_thread_id: currentThreadId,
      current_job_id: currentJobId,
      version: versionValue,
      created_at: row.created_at,
      updated_at: row.updated_at,
      orphaned_reason: orphanedReason
    };
  });
  return snapshotRows(rows);
}

function workHistoryStateDigest(db: Database.Database, version: number): Snapshot {
  if (version === 19) return snapshotRows(allRows(db, "work_history_state"));
  const rows = db.prepare(`SELECT h.job_id,h.acknowledged_at,h.expired_at,
      CAST((SELECT value FROM bridge_meta
        WHERE key='work_history_review_seq:' || h.job_id) AS INTEGER) AS review_sequence
    FROM work_history_state h JOIN jobs j ON j.job_id=h.job_id`).all() as Row[];
  return snapshotRows(rows);
}

function snapshotRows(rows: Row[]): Snapshot {
  const values = rows.map(canonical).sort();
  return { count: values.length, digest: hash(values) };
}

function exactCriticalTableSnapshots(db: Database.Database): Record<string, Snapshot> {
  const available = new Set(tableNames(db));
  return Object.fromEntries(EXACT_CRITICAL_TABLES
    .filter((table) => available.has(table))
    .map((table) => {
      return [table, snapshotRows(allRows(db, table))];
    }));
}

function criticalStateCounts(
  db: Database.Database,
  version: number,
  now: number
): Record<string, number> {
  const blockingInteractions = version === 18
    ? Number((db.prepare(`SELECT COUNT(*) AS count FROM jobs j,json_each(j.payload,'$.pendingInteractions') i
        WHERE json_type(i.value) <> 'object' OR COALESCE(json_extract(i.value,'$.isBlocking'),1) <> 0`)
      .get() as { count: number }).count)
    : count(db, "job_interactions", "WHERE is_blocking=1");
  return {
    activeJobs: count(db, "jobs", "WHERE archived_at IS NULL AND status IN ('running','terminating','termination-failed')"),
    blockingInteractions,
    pendingQuestions: count(db, "user_questions", "WHERE expires_at>?", [now]),
    undeliveredOutbox: count(db, "completion_outbox", "WHERE delivered_at IS NULL"),
    activeCancellations: count(db, "cancellation_intents", "WHERE status IN ('recorded','dispatched')"),
    unresolvedSteering: count(db, "steering_deliveries", "WHERE status IN ('prepared','dispatching','uncertain')"),
    unresolvedRecovery: count(db, "automatic_recovery", "WHERE state IN ('retrying','blocked')"),
    validResultHolds: count(db, "result_holds", "WHERE expires_at>?", [now]),
    archivedReceipts: count(db, "jobs", "WHERE archived_at IS NOT NULL")
  };
}

function approvedDropCounts(db: Database.Database, version: number): Record<string, number> {
  if (version !== 18) return {
    invalidProjectSessions: 0,
    invalidProjectAgentThreads: 0,
    sessionRejectedAgentThreads: 0
  };
  const invalidProjectSessions = Number((db.prepare(`SELECT COUNT(*) AS count FROM sessions s
    LEFT JOIN projects p ON p.project_id=COALESCE(s.project_uuid,s.project_id)
    WHERE p.project_id IS NULL AND COALESCE(
      s.project_id,s.project_label,s.project_uuid,s.project_name_snapshot,
      json_extract(s.payload,'$.projectId'),json_extract(s.payload,'$.projectLabel')
    ) IS NOT NULL`).get() as { count: number }).count);
  const invalidProjectAgentThreads = Number((db.prepare(`SELECT COUNT(*) AS count FROM agent_threads t
    LEFT JOIN projects p ON p.project_id=COALESCE(t.project_uuid,t.project_id)
    WHERE p.project_id IS NULL AND COALESCE(
      t.project_id,t.project_label,t.project_uuid,t.project_name_snapshot
    ) IS NOT NULL`).get() as { count: number }).count);
  const contexts = acceptedLegacyContexts(db);
  const projects = new Set(allRows(db, "projects").map((row) => String(row.project_id)));
  const sessionRejectedAgentThreads = allRows(db, "agent_threads").filter((row) =>
    acceptedLegacyProjectContext(row, projects, false) &&
    !contexts.agentThreadIds.has(String(row.thread_id))
  ).length;
  return { invalidProjectSessions, invalidProjectAgentThreads, sessionRejectedAgentThreads };
}

function jobReceiptDigest(db: Database.Database, version: number): Snapshot {
  const rows = allRows(db, "jobs");
  const sessions = new Map(allRows(db, "sessions").map((row) => [String(row.thread_id), row]));
  const activities = new Map(allRows(db, "activities").map((row) => [String(row.activity_id), row]));
  const summaries = version === 18 && tableNames(db).includes("job_summaries")
    ? new Map(allRows(db, "job_summaries").map((row) => [String(row.job_id), parseObject(row.payload)]))
    : new Map<string, Row>();
  const receipts = rows.map((row) => {
    const payload = parseObject(row.payload);
    const session = row.thread_id ? sessions.get(String(row.thread_id)) : undefined;
    const sessionPayload = parseObject(session?.payload);
    const activity = activities.get(String(row.activity_id));
    const stripped = { ...payload };
    for (const key of STRUCTURED_JOB_KEYS) delete stripped[key];
    const cwd = version === 18
      ? nonempty(payload.cwd) || nonempty(session?.cwd) || nonempty(activity?.project_cwd_snapshot) ||
        nonempty(activity?.project_cwd) || "/"
      : String(row.cwd);
    const rawSandbox = version === 18
      ? nonempty(payload.sandbox) || nonempty(sessionPayload.sandbox)
      : nonempty(row.sandbox);
    const sandbox = rawSandbox === "read-only" || rawSandbox === "danger-full-access"
      ? rawSandbox
      : "workspace-write";
    return {
      jobId: row.job_id,
      scopeId: row.scope_id,
      requestId: row.request_id,
      activityId: row.activity_id,
      threadId: row.thread_id,
      sourceThreadId: version === 18 ? nullable(payload.sourceThreadId) : row.source_thread_id,
      status: row.status,
      executionMode: row.execution_mode === "foreground" ? "foreground" : "background",
      backendKind: row.backend_kind,
      bridgeInstanceId: row.bridge_instance_id,
      workerId: row.worker_id,
      workerGeneration: row.worker_generation,
      upstreamRequestId: row.upstream_request_id,
      terminalVersion: row.terminal_version,
      agentId: row.agent_id,
      contextMode: row.context_mode,
      cwd,
      sandbox,
      createdAt: version === 18 ? numeric(payload.createdAt, Number(row.updated_at)) : row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      version: version === 18 ? positiveInteger(payload.version, 1) : row.job_version,
      lastProgressAt: version === 18
        ? numeric(payload.lastProgressAt, Number(row.updated_at))
        : row.last_progress_at,
      lastProgress: version === 18
        ? objectOrNull(payload.lastProgress)
        : parseNullableObject(row.last_progress),
      terminalOrigin: version === 18
        ? allowedTerminalOrigin(payload.terminalOrigin)
        : row.terminal_origin,
      cancellationIntentId: version === 18
        ? (typeof payload.cancellationIntentId === "string" ? payload.cancellationIntentId : null)
        : row.cancellation_intent_id,
      summary: retainedJobSummary(
        version === 18 ? summaries.get(String(row.job_id)) || {} : parseObject(row.summary)
      ),
      payload: stripped
    };
  }).map(canonical).sort();
  return { count: receipts.length, digest: hash(receipts) };
}

function sessionContextDigest(
  db: Database.Database,
  version: number,
  selectedThreadIds?: Set<string>
): SemanticSnapshot {
  if (version === 19) {
    const rows = allRows(db, "sessions").filter((row) =>
      selectedThreadIds === undefined || selectedThreadIds.has(String(row.thread_id))
    );
    const values = rows.map((row) => canonical({
      threadId: row.thread_id,
      scopeId: row.scope_id,
      projectId: row.project_id,
      backendKind: row.backend_kind,
      cwd: row.cwd,
      sandbox: row.sandbox,
      sessionId: row.session_id,
      forkedFromThreadId: row.forked_from_thread_id,
      persistence: row.persistence,
      visibleInCodexApp: sqliteBoolean(row.visible_in_codex_app),
      selection: parseNullableJson(row.selection),
      policyRevision: row.policy_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at
    })).sort();
    return {
      snapshot: { count: values.length, digest: hash(values) },
      threadIds: new Set(rows.map((row) => String(row.thread_id)))
    };
  }

  const projects = new Set(allRows(db, "projects").map((row) => String(row.project_id)));
  const connections = new Map(allRows(db, "thread_connections")
    .map((row) => [String(row.thread_id), row]));
  const legacySessions = allRows(db, "sessions");
  const legacySessionThreadIds = new Set(
    legacySessions.map((row) => String(row.thread_id))
  );
  const rows = legacySessions.flatMap((row) => {
    const payload = parseObject(row.payload);
    const rawProjectId = row.project_uuid ?? row.project_id;
    const projectId = rawProjectId !== null && rawProjectId !== undefined &&
      projects.has(String(rawProjectId)) ? String(rawProjectId) : null;
    const hasUnmatchedProjectMetadata = projectId === null && [
      row.project_id,
      row.project_label,
      row.project_uuid,
      row.project_name_snapshot,
      payload.projectId,
      payload.projectLabel
    ].some((value) => value !== null && value !== undefined);
    if (hasUnmatchedProjectMetadata) return [];
    const connection = connections.get(String(row.thread_id));
    const visible = jsonBoolean(payload.visibleInCodexApp);
    const payloadPersistence = nonempty(payload.persistence);
    const connectionPersistence = nonempty(connection?.persistence);
    const persistence = ["persistent", "ephemeral", "unknown"].includes(payloadPersistence || "")
      ? payloadPersistence
      : ["persistent", "ephemeral", "unknown"].includes(connectionPersistence || "")
        ? connectionPersistence
        : visible === true
          ? "persistent"
          : visible === false ? "ephemeral" : "unknown";
    const selection = payload.selection && typeof payload.selection === "object" &&
      !Array.isArray(payload.selection) ? payload.selection : null;
    return [{
      threadId: row.thread_id,
      scopeId: row.scope_id,
      projectId,
      backendKind: payload.backendKind === "app-server" || payload.backendKind === "codex-sdk"
        ? payload.backendKind : "mcp-server",
      cwd: row.cwd,
      sandbox: payload.sandbox === "read-only" || payload.sandbox === "danger-full-access"
        ? payload.sandbox : "workspace-write",
      sessionId: typeof payload.sessionId === "string" && payload.sessionId !== ""
        ? payload.sessionId : null,
      forkedFromThreadId: typeof payload.forkedFromThreadId === "string" &&
        payload.forkedFromThreadId !== "" ? payload.forkedFromThreadId : null,
      persistence,
      visibleInCodexApp: visible,
      selection,
      policyRevision: Number.isInteger(payload.policyRevision) && Number(payload.policyRevision) >= 0
        ? payload.policyRevision : null,
      createdAt: typeof payload.createdAt === "number" && Number.isFinite(payload.createdAt)
        ? payload.createdAt : row.last_used_at,
      updatedAt: typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)
        ? payload.updatedAt : row.last_used_at,
      lastUsedAt: row.last_used_at
    }];
  });
  for (const row of allRows(db, "agent_threads")) {
    const threadId = String(row.thread_id);
    if (
      legacySessionThreadIds.has(threadId) ||
      !acceptedLegacyProjectContext(row, projects, false)
    ) {
      continue;
    }
    const rawProjectId = row.project_uuid ?? row.project_id;
    const projectId = rawProjectId !== null && rawProjectId !== undefined
      ? String(rawProjectId)
      : null;
    const connection = connections.get(threadId);
    rows.push({
      threadId: row.thread_id,
      scopeId: row.scope_id,
      projectId,
      backendKind: row.backend_kind,
      cwd: row.cwd,
      sandbox: row.sandbox,
      sessionId: row.session_id,
      forkedFromThreadId: row.forked_from_thread_id,
      persistence: nonempty(connection?.persistence) || "unknown",
      visibleInCodexApp: null,
      selection: null,
      policyRevision: null,
      createdAt: row.linked_at,
      updatedAt: row.replaced_at ?? row.linked_at,
      lastUsedAt: row.replaced_at ?? row.linked_at
    });
  }
  const values = rows.map(canonical).sort();
  return {
    snapshot: { count: values.length, digest: hash(values) },
    threadIds: new Set(rows.map((row) => String(row.threadId)))
  };
}

function stableStateSnapshot(file: string, now: number): Record<string, Snapshot> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const snapshots: Record<string, Snapshot> = {};
    for (const table of tableNames(db)) {
      if (table === "bridge_instances") continue;
      const rows = table === "user_questions"
        ? db.prepare("SELECT * FROM user_questions WHERE expires_at>?").all(now)
        : db.prepare(`SELECT * FROM ${identifier(table)}`).all();
      const values = (rows as Row[]).map(canonical).sort();
      snapshots[table] = { count: values.length, digest: hash(values) };
    }
    return snapshots;
  } finally {
    db.close();
  }
}

function changedSnapshots(
  before: Record<string, Snapshot>,
  after: Record<string, Snapshot>
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((table) => canonical(before[table]) !== canonical(after[table]))
    .sort();
}

function assertCurrentSchema(db: Database.Database): void {
  const objects = db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'`).all() as Array<{ type: string; name: string; sql: string | null }>;
  assert.ok(!objects.some((row) => row.name === "scope_versions" || row.name === "job_summaries"));
  assert.ok(!objects.some((row) => /project_label|project_uuid|project_name_snapshot/iu.test(row.sql || "")));
  const agentColumns = columnNames(db, "agents");
  assert.ok(!agentColumns.includes("archived_at"));
  assert.ok(!/archived/iu.test(String(objects.find((row) => row.name === "agents")?.sql)));
  for (const table of ["activities", "jobs"]) {
    assert.ok(!/execution_mode[^]*'auto'/iu.test(String(objects.find((row) => row.name === table)?.sql)));
  }
  const duplicated = Number((db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE
    json_type(payload,'$.projectId') IS NOT NULL OR
    json_type(payload,'$.projectLabel') IS NOT NULL OR
    json_type(payload,'$.projectName') IS NOT NULL OR
    json_type(payload,'$.cwd') IS NOT NULL OR
    json_type(payload,'$.pendingInteractions') IS NOT NULL OR
    json_type(payload,'$.publicEvents') IS NOT NULL`).get() as { count: number }).count);
  assert.equal(duplicated, 0, "Structured Job fields remain duplicated in payload JSON");
  const unexpectedSummaries = Number((db.prepare(`SELECT COUNT(*) AS count
    FROM jobs,json_each(jobs.summary) entry
    WHERE entry.key NOT IN ('execution','usage','uncertainResponseReview')`)
    .get() as { count: number }).count);
  assert.equal(unexpectedSummaries, 0, "Job summaries retain fields without a current reader");
  const budget = db.prepare("SELECT rows,bytes FROM event_budget WHERE id=1").get();
  const calculatedBudget = db.prepare(`SELECT COUNT(*) AS rows,
    COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM job_events`).get();
  assert.deepEqual(budget, calculatedBudget, "Event budget does not match retained Job events");
}

function allRows(db: Database.Database, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${identifier(table)}`).all() as Row[];
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${identifier(table)})`) as Array<{ name: string }>)
    .map((column) => column.name);
}

function identifier(value: string): string {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/u);
  return `"${value}"`;
}

function parseObject(value: unknown): Row {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
  } catch {
    return {};
  }
}

function retainedJobSummary(value: Row): Row {
  const summary: Row = {};
  for (const key of ["execution", "usage", "uncertainResponseReview"] as const) {
    const entry = objectOrNull(value[key]);
    if (entry) summary[key] = entry;
  }
  return summary;
}

function parseNullableObject(value: unknown): Row | null {
  return value === null || value === undefined ? null : parseObject(value);
}

function parseNullableJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function sqliteBoolean(value: unknown): boolean | null {
  return value === 1 ? true : value === 0 ? false : null;
}

function jsonBoolean(value: unknown): boolean | null {
  return value === true || value === 1 ? true : value === false || value === 0 ? false : null;
}

function objectOrNull(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullable(value: unknown): string | null {
  return nonempty(value) || null;
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : fallback;
}

function allowedTerminalOrigin(value: unknown): string | null {
  return typeof value === "string" && TERMINAL_ORIGINS.has(value) ? value : null;
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Row)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function hash(values: string[]): string {
  return createHash("sha256").update(values.join("\n")).digest("hex");
}
