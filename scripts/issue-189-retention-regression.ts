import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const dist = process.env.CODEX_TEST_BUNDLE_DIST;
const moduleUrl = (name: string) => pathToFileURL(path.resolve(dist || "src", `${name}.${dist ? "js" : "ts"}`)).href;
const { loadConfig } = await import(moduleUrl("config"));
const { createExecutionRuntime } = await import(moduleUrl("executionRuntime"));
const { createHttpServer } = await import(moduleUrl("server"));
const keepAlive = setInterval(() => {}, 1000);
const root = await mkdtemp(path.join(tmpdir(), "issue-189-retention-"));
const stateFile = path.join(root, "state.sqlite");
const turnFile = path.join(root, "turns.jsonl");
const env = { ...process.env, HOME: root, CODEX_HOME: path.join(root, ".codex"),
  CODEX_MCP_BRIDGE_CODEX: path.resolve("test/fixtures/fake-codex-app-server.mjs"),
  CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: root,
  CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS: "1000",
  CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "3",
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: stateFile,
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
  CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
  CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills"),
  CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
  CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1", CODEX_TEST_TURN_OBSERVATION: turnFile };
const config = loadConfig(env);
const upstream = createExecutionRuntime(config, {}, env, { isolateCodexExecution: true });
await upstream.prepareExecution({ backendKind: "app-server", contextMode: "fresh" });
// Test-only access to the real factory's isolated transport, never an operational connection.
const service = upstream.backends.get("app-server").instance;
const endpoint = service.endpoint;
const server = createHttpServer(config, upstream, undefined,
  { canAcceptNewJobs: () => service.health().status === "ready" });
const client = new Client({ name: "issue-189-retention", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } });
type Job = { jobId: string; session: string; agentId: string; activityId: string };
const jobs: Job[] = [];
let project: unknown;
let contract: Record<string, { const?: unknown }>;
let blockCommitAcks = false, withheldAcks = 0;
const send = service.child.send.bind(service.child);
service.child.send = (message: any, callback?: (error?: Error) => void) => {
  if (blockCommitAcks && message.type === "acknowledge" && read(db =>
    Boolean(db.prepare("SELECT 1 FROM jobs WHERE job_id=?").get(message.requestId)))) {
    withheldAcks++; callback?.(); return true;
  }
  return send(message, callback);
};
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await server.applicationService.updateSettings({ expectedRegistryRevision: 0, operation: { kind: "patch",
    settings: { projectOperations: [{ kind: "add", project: { name: "Retention fixture", cwd: root } }] } } });
  project = read(db => db.prepare("SELECT name,project_ref AS projectRef,project_revision AS projectRevision FROM projects LIMIT 1").get());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  contract = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!.inputSchema.properties as typeof contract;
  const generation = service.health().generation;
  for (let batch = 0; batch < 20; batch++) await Promise.all(Array.from({ length: 8 }, () => service.listTools()));
  assert(service.health().journal, "artifact must report its actual journal capacity");
  await until(() => service.health().journal?.lanes.metadata.used === 0);
  console.error("Metadata burst passed; filling durable execution reservations.");
  blockCommitAcks = true;
  const held = await start("hold while receipt reservations fill");
  for (let index = 0; index < 29; index++) await completed(await start(`reserved completion ${index}`));
  await until(() => service.health().status === "capacity");
  console.error("30 execution reservations held; testing management and controls.");
  assert.equal(service.health().journal.lanes.execution.used, 30);
  assert.equal(service.health().journal.lanes.execution.awaitingCommitAcknowledgement, 29);
  const before = read(db => db.prepare("SELECT count(*) AS n FROM jobs").get()).n;
  await call("codex_settings", held, {});
  await call("codex_ui_read", held, { view: "settings" });
  const done = jobs[1];
  await call("codex_agent", done, { requestId: randomUUID(), agentId: done.agentId,
    operation: { kind: "rename", name: "Preserved during saturation" } });
  const archive = await client.callTool({ name: "codex_agent", _meta: { "openai/session": done.session },
    arguments: { requestId: randomUUID(), agentId: done.agentId, operation: { kind: "archive" } } });
  assert.equal(archive.isError, true);
  assert.equal((archive.structuredContent as any).code, "AGENT_ARCHIVE_REMOVED");
  const activityVersion = () => read(db => db.prepare("SELECT version FROM activities WHERE activity_id=?").get(done.activityId)).version;
  const stale = await client.callTool({ name: "codex_activity_update", _meta: { "openai/session": done.session },
    arguments: { activityId: done.activityId, expectedVersion: activityVersion() + 1, operation: { kind: "complete" } } });
  assert.equal(stale.isError, true);
  assert.equal((stale.structuredContent as any).code, "STALE_ACTIVITY_VERSION");
  await call("codex_activity_update", done, { activityId: done.activityId, expectedVersion: activityVersion(),
    operation: { kind: "complete", reason: "Explicit fixture completion" } });
  const abandoned = jobs[2];
  await call("codex_activity_update", abandoned, { activityId: abandoned.activityId,
    expectedVersion: read(db => db.prepare("SELECT version FROM activities WHERE activity_id=?").get(abandoned.activityId)).version,
    operation: { kind: "abandon", reason: "Explicit fixture abandonment" } });
  await call("codex_status", done, { query: { kind: "job", id: done.jobId } });
  assert.equal(read(db => db.prepare("SELECT count(*) AS n FROM jobs").get()).n, before);
  const version = read(db => db.prepare("SELECT job_version FROM jobs WHERE job_id=?").get(held.jobId)).job_version;
  await call("codex_steer", held, { requestId: randomUUID(), jobId: held.jobId, expectedJobVersion: version,
    prompt: "finish exact original turn" });
  await completed(held);
  await until(() => service.health().journal.lanes.execution.awaitingCommitAcknowledgement === 30);
  assert(withheldAcks > 0);
  blockCommitAcks = false;
  await until(() => service.health().journal.lanes.execution.used === 0 && service.health().pendingAcknowledgements === 0);
  console.error("Acknowledgements recovered; completing remaining jobs.");
  for (let index = 0; index < 90; index++) await completed(await start(`after automatic release ${index}`));
  await until(() => service.health().journal.lanes.execution.used === 0);
  const turns = (await readFile(turnFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(turns.length, jobs.length);
  assert.equal(new Set(turns.map(turn => `${turn.pid}:${turn.turnId}`)).size, jobs.length);
  for (const job of jobs) assert.equal(read(db => db.prepare("SELECT status FROM jobs WHERE job_id=?").get(job.jobId)).status, "completed");
  assert.equal(service.health().generation, generation);
  assert.equal(read(db => db.pragma("quick_check", { simple: true })), "ok");
  console.log(JSON.stringify({ issue: 189, runtime: dist || "source", testedAt: new Date().toISOString(),
    productionDatabaseModified: false, metadataRequests: 160, jobs: jobs.length, completedJobs: jobs.length,
    withheldCommitAcknowledgements: withheldAcks, saturatedExecutionReceipts: 30,
    settingsAndManagementDuringSaturation: true, structuredManagementErrors: true,
    automaticReleaseAfterAckRecovery: true, sameExecutionOwner: true, duplicateTurns: 0,
    finalJournal: service.health().journal, databaseQuickCheck: "ok", passed: true }, null, 2));
} finally {
  blockCommitAcks = false;
  await client.close().catch(() => {});
  await new Promise<void>(resolve => server.close(resolve));
  await service.close();
  await rm(root, { recursive: true, force: true });
  await rm(endpoint.directory, { recursive: true, force: true });
  clearInterval(keepAlive);
}

async function start(prompt: string): Promise<Job> {
  const session = randomUUID();
  const result = await client.callTool({ name: "codex_task", _meta: { "openai/session": session }, arguments: {
    requestId: randomUUID(), taskContractVersion: contract.taskContractVersion.const,
    executionEnvelopeRef: contract.executionEnvelopeRef.const, prompt, project,
    selection: { model: "gpt-5.6-sol", reasoningEffort: "max" } } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const { jobId, agentId, activityId } = result.structuredContent as any;
  assert(jobId && agentId && activityId, JSON.stringify(result));
  const job = { jobId, agentId, activityId, session }; jobs.push(job); return job;
}
async function call(name: string, job: Job, args: Record<string, unknown>) {
  const result = await client.callTool({ name, _meta: { "openai/session": job.session }, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent as any;
}
async function completed(job: Job) {
  await until(() => read(db => db.prepare("SELECT status FROM jobs WHERE job_id=?").get(job.jobId)).status === "completed");
  const payload = JSON.parse(read(db => db.prepare("SELECT payload FROM jobs WHERE job_id=?").get(job.jobId)).payload);
  assert(payload.result?.content?.[0]?.text, "durable completion result available");
}
function read(fn: (db: Database.Database) => any): any {
  const db = new Database(stateFile, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("retention regression condition timeout"); await new Promise(r => setTimeout(r, 20)); }
}
