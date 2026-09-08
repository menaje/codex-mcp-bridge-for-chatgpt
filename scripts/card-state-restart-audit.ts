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
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";

// Explicit source only. Open it read-only, make a consistent private SQLite
// backup, and run every initializer against that disposable copy. No HTTP
// listener, companion, real model catalog, or Codex execution is started.
const sourceFile = process.argv[2];
assert.ok(sourceFile, "Usage: tsx scripts/card-state-restart-audit.ts /absolute/state.sqlite");
assert.ok(path.isAbsolute(sourceFile), "An absolute source database path is required");
const protectedTables = ["sessions", "jobs", "activities", "agents", "agent_threads", "activity_agents",
  "user_settings", "projects", "project_registry", "user_questions", "codex_question_deliveries",
  "agent_mutations", "cancellation_operations", "cancellation_intents", "steering_deliveries", "completion_outbox"];
type TableSummary = { count: number; digest: string };
function snapshot(file: string, ignoreQuestionsExpiredAt?: number): Record<string, TableSummary> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(protectedTables.map(table => {
      const stored = table === "user_questions" && ignoreQuestionsExpiredAt !== undefined
        ? db.prepare("SELECT * FROM user_questions WHERE expires_at > ?").all(ignoreQuestionsExpiredAt)
        : db.prepare(`SELECT * FROM ${table}`).all();
      const rows = stored.map(row => JSON.stringify(row)).sort();
      return [table, { count: rows.length, digest: createHash("sha256").update(rows.join("\n")).digest("hex") }];
    }));
  } finally { db.close(); }
}
const root = await mkdtemp(path.join(tmpdir(), "card-state-restart-audit-"));
await chmod(root, 0o700);
const copy = path.join(root, "state.sqlite");
const source = new Database(sourceFile, { readonly: true, fileMustExist: true });
const report: Record<string, unknown> = { issue: 69, testedAt: new Date().toISOString(),
  source: "consistent read-only backup of the user's current database", productionDatabaseModified: false,
  codexCalls: 0, appReads: 0, restartPasses: [], activeJobRecovery: "not exercised when snapshot has no active Jobs" };
let state: BridgeStateStore | undefined;
let server: ReturnType<typeof createBridgeMcpServer> | undefined;
let client: Client | undefined;
try {
  report.sourceSchema = (source.prepare("SELECT value FROM bridge_meta WHERE key = 'schema_version'").get() as { value: string }).value;
  report.sourceJobStates = source.prepare("SELECT status, count(*) AS count FROM jobs GROUP BY status").all();
  await source.backup(copy);
  source.close();
  await chmod(copy, 0o600);
  const allRows = snapshot(copy);
  report.tableCounts = Object.fromEntries(Object.entries(allRows).map(([key, value]) => [key, value.count]));
  // Existing #68 retention deletes expired questions at startup. Verify this
  // declared cleanup separately instead of treating it as #69 data loss.
  const before = snapshot(copy, Date.now());
  report.expiredQuestionsEligibleForExistingCleanup = allRows.user_questions.count - before.user_questions.count;
  const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: copy });
  for (let pass = 1; pass <= 2; pass++) {
    report.stage = "load-store-and-registries";
    state = new BridgeStateStore({ file: copy });
    const settings = new UserSettingsStore(config, { stateStore: state });
    const sessions = new SessionRegistry({ stateStore: state });
    const jobs = new CodexJobRegistry({ stateStore: state });
    const catalog = { source: "codex-cli", fetchedAt: new Date().toISOString(), validatedAt: new Date().toISOString(),
      fingerprint: "a".repeat(64), cached: true, stale: false, validation: "valid", models: [] };
    report.stage = "create-mcp-server";
    server = createBridgeMcpServer(config, {
      async listTools() { return { tools: [] }; },
      async callTool() { report.codexCalls = Number(report.codexCalls) + 1; throw new Error("Execution forbidden in audit"); }, async close() {}
    }, sessions, jobs, { async getCatalog() { return catalog as never; }, getCachedCatalog() { return catalog as never; } }, settings);
    client = new Client({ name: "card-state-restart-audit", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    report.stage = "discover-tools";
    assert.equal((await client.listTools()).tools.length, 29);
    for (const arguments_ of [{ view: "settings" }, { view: "dashboard", widgetInstanceId: randomUUID(), enrich: false }]) {
      report.stage = "read-" + arguments_.view;
      const result = await client.callTool({ name: "codex_ui_read", arguments: arguments_,
        _meta: { "openai/session": "isolated-restart-audit" } });
      assert.notEqual(result.isError, true, "App read failed on copied state");
      report.appReads = Number(report.appReads) + 1;
    }
    await client.close(); client = undefined;
    await server.close(); server = undefined;
    state.close(); state = undefined;
    report.stage = "compare-retained-data";
    const after = snapshot(copy);
    const changed = protectedTables.filter(table => before[table].digest !== after[table].digest);
    (report.restartPasses as unknown[]).push({ pass, preserved: changed.length === 0, changedTables: changed,
      expiredQuestionsRemoved: allRows.user_questions.count - after.user_questions.count });
    assert.deepEqual(changed, [], "Protected data changed during initialization/read/restart of the copy");
  }
  assert.equal(report.codexCalls, 0);
  report.stage = "complete";
  report.passed = true;
} catch (error) {
  report.passed = false;
  // Keep errors and all raw rows/identifiers out of the public audit report.
  report.failure = error instanceof assert.AssertionError ? error.message.split("\n")[0] : "Audit initialization or read failed";
  report.errorType = error instanceof Error ? error.name : "unknown";
} finally {
  if (source.open) source.close();
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  state?.close();
  await rm(root, { recursive: true, force: true });
  report.temporaryCopyRemoved = true;
}
await writeFile("docs/audits/issue-69-state-restart.json", JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report) + "\n");
if (report.passed !== true) process.exitCode = 1;
