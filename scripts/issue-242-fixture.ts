/** Synthetic fixtures only. Never accepts a database/runtime path from the caller. */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { CodexJobRegistry } from "../src/tools.js";

export const fixtureScope = "11111111-1111-4111-8111-111111111111";
export function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return { samples: values.length, p50: p(.5), p95: p(.95), p99: p(.99), max: p(1) };
}

export async function issue242Fixture(size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > 6_000) throw new Error("Fixture size is bounded to 0..6000.");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "bridge-issue-242-")));
  const file = path.join(root, "state.sqlite");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("CODEX_") && !key.startsWith("OPENAI_") && key !== "HOME"));
  const environment = { ...inherited, HOME: root, CODEX_HOME: path.join(root, "codex"),
    CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
    CODEX_MCP_BRIDGE_ROOTS: root, CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
    CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills"),
    CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS: String(Math.max(100, size)),
    CODEX_MCP_BRIDGE_JOB_TTL_MS: String(24 * 60 * 60 * 1_000) };
  await mkdir(environment.CODEX_HOME);
  const config = loadConfig(environment);
  let trace = false;
  let counts: Record<string, number> = {};
  const store = new BridgeStateStore({ file, traceSql: sql => {
    if (!trace) return;
    const kind = /^\s*(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/i.exec(sql)?.[1]?.toUpperCase() ?? "OTHER";
    counts[kind] = (counts[kind] ?? 0) + 1;
  } });
  const settings = new UserSettingsStore(config, { stateStore: store });
  new ScopeResolver({ stateStore: store });
  const sessions = new SessionRegistry({ stateStore: store, allowedRoots: [root], projectionOnly: true });
  const now = Date.now();
  let agentId = "";
  store.transaction(() => {
    for (let i = 0; i < size; i++) {
      if (i % 10 === 0) {
        agentId = store.createAgent({ scopeId: fixtureScope, agentName: `Fixture ${i / 10}` }).agentId;
        sessions.record({ threadId: `fixture-${i / 10}`, agentId, scopeId: fixtureScope,
          backendKind: "mcp-server", cwd: root, sandbox: "read-only",
          createdAt: now, updatedAt: now, lastUsedAt: now });
      }
      const jobId = randomUUID();
      store.upsertJob({ jobId, agentId, activityId: randomUUID(), scopeId: fixtureScope,
        requestId: `fixture-${i}`, requestHash: "a".repeat(64), requestHashVersion: 11,
        operation: "start", backendKind: "mcp-server", status: i % 5 === 0 ? "failed" : "completed",
        createdAt: now - size + i, updatedAt: now - size + i, lastProgressAt: now - size + i,
        cwd: root, sandbox: "read-only", version: 1, completionDeliveryPolicy: "direct-wait",
        exclusiveKeys: [], sessionDecision: { requestedMode: "new", action: "start", reason: "explicit-new" },
        publicEvents: [], pendingInteractions: [], result: { content: [{ type: "text", text: "synthetic" }] } });
    }
  });
  const jobs = new CodexJobRegistry({ stateStore: store, allowedRoots: [root], projectionOnly: true,
    maxJobs: Math.max(size, 100), maxConcurrentJobs: 30 });
  // Test-only inspection of the fixture-owned handle; SQL and row contents are never emitted.
  const database = (store as unknown as { database: Database.Database }).database;
  const totalChanges = () => (database.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const walBytes = async () => (await stat(file + "-wal").catch(() => ({ size: 0 }))).size;
  return { root, file, environment, config, store, settings, sessions, jobs, database,
    async measure<T>(run: () => T | Promise<T>) {
      const before = totalChanges(), walBefore = await walBytes();
      counts = {}; trace = true;
      const at = performance.now();
      let result: T;
      try { result = await run(); } finally { trace = false; }
      return { result, wallMs: performance.now() - at, sql: { ...counts },
        changedRows: totalChanges() - before, walFileBytesDelta: (await walBytes()) - walBefore };
    },
    async close() { await jobs.closeThreadConnections(); store.close(); await rm(root, { recursive: true }); }
  };
}
