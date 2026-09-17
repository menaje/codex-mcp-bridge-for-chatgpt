import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Database from "better-sqlite3";

const CURRENT_MCP_PROTOCOL = "2026-07-28";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8876/mcp";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JobRow = {
  job_id: string;
  scope_id: string;
  status: string;
  job_version: number;
  created_at: number;
  updated_at: number;
  thread_id: string | null;
};

function usage(): never {
  console.error(
    "Usage: npx tsx scripts/issue-125-live-control.ts <observe|release|terminal> " +
      "<scope-id> <job-id> <run-marker> [endpoint]"
  );
  process.exit(2);
}

const [action, scopeId, jobId, runMarker, endpoint = DEFAULT_ENDPOINT] = process.argv.slice(2);
if (action === "--help" || action === "-h") usage();
if (!action || !scopeId || !jobId || !runMarker) usage();
assert.ok(["observe", "release", "terminal"].includes(action), "Unknown action.");
assert.match(scopeId, UUID, "scope-id must be an exact UUID returned by the bridge state.");
assert.match(jobId, UUID, "job-id must be an exact UUID returned by the bridge state.");
assert.match(runMarker, /^[A-Za-z0-9._:-]{1,160}$/, "run-marker must be a safe, exact token.");

const client = new Client(
  { name: "issue-125-live-control", version: "1" },
  { versionNegotiation: { mode: { pin: CURRENT_MCP_PROTOCOL } } }
);

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  if (action === "terminal") {
    const terminal = await call("codex_status", {
      scopeId,
      query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 1_000 }
    });
    const item = terminal.items?.find((candidate: { id?: string }) => candidate.id === jobId);
    assert.ok(item, "The exact Job was not returned in this scope.");
    console.log(JSON.stringify({
      action,
      observedAt: new Date().toISOString(),
      scopeId,
      jobId,
      state: item.state,
      terminal: item.terminal,
      answer: item.answer
    }, null, 2));
  } else {
    const observed = observeReadyMessage(scopeId, jobId, runMarker);

    if (action === "observe") {
      console.log(JSON.stringify({
        action,
        observedAt: new Date().toISOString(),
        scopeId,
        jobId,
        runMarker,
        state: observed.job.status,
        jobVersion: observed.job.job_version,
        threadId: observed.job.thread_id,
        createdAt: new Date(observed.job.created_at).toISOString(),
        readyAt: new Date(observed.readyAt).toISOString(),
        elapsedMs: Date.now() - observed.job.created_at,
        readySummary: observed.readySummary
      }, null, 2));
    } else {
      const release = await steerAfterReady(scopeId, jobId, runMarker);
      console.log(JSON.stringify({
        action,
        releasedAt: new Date().toISOString(),
        scopeId,
        jobId,
        runMarker,
        expectedJobVersion: release.expectedJobVersion,
        staleRetries: release.staleRetries,
        delivery: release.result.delivery
      }, null, 2));
    }
  }
} finally {
  await client.close().catch(() => {});
}

async function steerAfterReady(scope: string, job: string, marker: string) {
  for (let staleRetries = 0; staleRetries < 8; staleRetries += 1) {
    const current = await call("codex_status", {
      scopeId: scope,
      query: { kind: "job", id: job }
    });
    const item = current.items?.find((candidate: { id?: string }) => candidate.id === job);
    assert.ok(item, "The exact Job was not returned in this scope.");
    assert.equal(item.state, "running", "The READY Job must still have an active turn.");
    const expectedJobVersion = item.versions?.job;
    assert.ok(Number.isInteger(expectedJobVersion), "The exact current Job version is required.");
    const response = await callUnchecked("codex_steer", {
      scopeId: scope,
      requestId: randomUUID(),
      jobId: job,
      expectedJobVersion,
      prompt: `RELEASE ${marker} seq=2. Generate the previously forbidden fresh UUID now and finish exactly as instructed.`
    });
    if (!response.isError) {
      assert.ok(response.structuredContent, "codex_steer returned no structured content.");
      return { expectedJobVersion, staleRetries, result: response.structuredContent as any };
    }
    if (!JSON.stringify(response.content).includes("STALE_JOB_VERSION")) {
      assert.fail(JSON.stringify(response.content));
    }
  }
  assert.fail("The active Job version changed during every bounded RELEASE attempt.");
}

function observeReadyMessage(scope: string, job: string, marker: string): {
  job: JobRow;
  readyAt: number;
  readySummary: string;
} {
  const databasePath = process.env.CODEX_MCP_BRIDGE_STATE_DB ||
    join(homedir(), ".codex-mcp-bridge", "state.sqlite");
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database.prepare(`
      SELECT job_id, scope_id, status, job_version, created_at, updated_at, thread_id
      FROM jobs
      WHERE job_id = ? AND scope_id = ?
    `).get(job, scope) as JobRow | undefined;
    assert.ok(row, "The exact Job was not found in the expected scope.");
    assert.equal(row.status, "running", "The READY Job must still have an active turn.");
    const events = database.prepare(`
      SELECT created_at, payload
      FROM job_events
      WHERE job_id = ? AND event_type = 'app-agent-message-completed'
      ORDER BY event_id
    `).all(job) as Array<{ created_at: number; payload: string }>;
    const matches = events.flatMap((event) => {
      const payload = JSON.parse(event.payload) as { summary?: unknown };
      const summary = typeof payload.summary === "string" ? payload.summary : "";
      return summary.includes(`READY ${marker} seq=1`)
        ? [{ readyAt: event.created_at, readySummary: summary }]
        : [];
    });
    assert.equal(matches.length, 1, "Expected one exact READY message for the run marker.");
    return { job: row, ...matches[0]! };
  } finally {
    database.close();
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await callUnchecked(name, args);
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.ok(result.structuredContent, `${name} returned no structured content.`);
  return result.structuredContent;
}

async function callUnchecked(name: string, args: Record<string, unknown>): Promise<{
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}> {
  return await client.callTool({ name, arguments: args }) as {
    isError?: boolean;
    content?: unknown;
    structuredContent?: unknown;
  };
}
