import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// The same test runs against source or an installed bundle's actual JS modules.
const dist = process.env.CODEX_TEST_BUNDLE_DIST;
const { loadConfig } = await import(dist ? pathToFileURL(path.join(dist, "config.js")).href : "../src/config.js");
const { createIsolatedHttpServer } = await import(dist ? pathToFileURL(path.join(dist, "runtimeProcess.js")).href : "../src/runtimeProcess.js");
const root = await mkdtemp(path.join(tmpdir(), "issue-185-runtime-"));
const stateFile = path.join(root, "state.sqlite");
const turnFile = path.join(root, "turns.jsonl");
const gate = path.join(root, "complete");
const statePids: number[] = [];
const ownerPids: number[] = [];
let pauseReplacement = false;
let pausedPid: number | undefined;
const environment = { ...process.env, HOME: root, CODEX_HOME: path.join(root, ".codex"),
  CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
  CODEX_MCP_BRIDGE_CODEX: path.resolve("test/fixtures/fake-codex-app-server.mjs"),
  CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: stateFile,
  CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
  CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills"),
  CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2", CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1",
  CODEX_TEST_COMPLETION_GATE: gate, CODEX_TEST_TURN_OBSERVATION: turnFile };
const server = await createIsolatedHttpServer(loadConfig(environment), { childEnvironment: environment,
  onRuntimeProcessSpawn(pid: number) {
    statePids.push(pid);
    if (pauseReplacement) { process.kill(pid, "SIGSTOP"); pausedPid = pid; }
  },
  onExecutionProcessSpawn(pid: number) { ownerPids.push(pid); } });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const client = new Client({ name: "issue-185-recovery", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } });
const jobs: Array<{ jobId: string; requestId: string; marker: string; session: string; threadId?: string; turnId?: string }> = [];
try {
  await until(async () => (await fetch(`${base}/readyz`)).ok);
  await server.applicationService.updateSettings({ expectedRegistryRevision: 0,
    operation: { kind: "patch", settings: { projectOperations: [{ kind: "add", project: { name: "Recovery fixture", cwd: root } }] } } });
  const project = read(db => db.prepare("SELECT name, project_ref AS projectRef, project_revision AS projectRevision FROM projects WHERE archived_at IS NULL AND deleted_at IS NULL LIMIT 1").get());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
  const properties = descriptor.inputSchema.properties as Record<string, { const?: unknown }>;
  for (let index = 0; index < 3; index++) {
    const requestId = randomUUID();
    const marker = index === 2 ? "blocking input" : `controller restart gate ${index}`;
    const session = randomUUID();
    const result = await client.callTool({ name: "codex_task", _meta: { "openai/session": session }, arguments: {
      requestId, taskContractVersion: properties.taskContractVersion.const,
      executionEnvelopeRef: properties.executionEnvelopeRef.const,
      prompt: marker, selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }, project
    } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const jobId = (result.structuredContent as { jobId: string }).jobId;
    jobs.push({ jobId, requestId, marker, session });
  }
  await until(() => jobs.every(job => Boolean(jobPayload(job.jobId)?.upstreamRequestId)));
  for (const job of jobs) {
    const payload = jobPayload(job.jobId);
    job.threadId = payload.threadId; job.turnId = payload.upstreamRequestId;
    assert.equal(payload.executionReceipt, true);
  }
  const turnsBefore = readFileSync(turnFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(turnsBefore.length, 3);
  const questionJob = jobs[2];
  const inputRequest = { name: "codex_status", _meta: { "openai/session": questionJob.session },
    arguments: { query: { kind: "input", jobId: questionJob.jobId } } };
  const initialInput = (await client.callTool(inputRequest)).structuredContent as any;
  assert.equal(initialInput.questions.length, 1);
  assert.equal(new Set(turnsBefore.map(turn => turn.pid)).size, 2, "two independent worker processes");
  const ownerPid = ownerPids.at(-1)!;
  pauseReplacement = true;
  process.kill(statePids[0], "SIGKILL");
  await until(() => pausedPid !== undefined);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  await writeFile(gate, "complete while controller is stopped");
  await new Promise(resolve => setTimeout(resolve, 600));
  process.kill(ownerPid, 0);
  pauseReplacement = false;
  process.kill(pausedPid!, "SIGCONT"); pausedPid = undefined;
  await until(() => jobs.slice(0, 2).every(job => jobPayload(job.jobId)?.status === "completed"), 20_000);
  await until(() => jobPayload(questionJob.jobId)?.trackingState === "connected");
  // A graceful control-layer stop also detaches; only an explicit runtime
  // close message is allowed to shut down the independent execution owner.
  process.kill(statePids.at(-1)!, "SIGTERM");
  await until(() => statePids.length === 3);
  await until(async () => (await fetch(`${base}/readyz`)).ok);
  await until(() => jobPayload(questionJob.jobId)?.trackingState === "connected");
  const recoveredInput = (await client.callTool(inputRequest)).structuredContent as any;
  assert.equal(recoveredInput.questions[0].questionRef, initialInput.questions[0].questionRef);
  const answerRequest = { name: "codex_answer", _meta: { "openai/session": questionJob.session },
    arguments: { requestId: randomUUID(), jobId: questionJob.jobId,
      questionRef: recoveredInput.questions[0].questionRef, answers: { color: ["blue"] } } };
  const answer = await client.callTool(answerRequest);
  assert.equal((answer.structuredContent as any).delivery, "delivered", JSON.stringify(answer));
  const duplicateAnswer = await client.callTool(answerRequest);
  assert.equal((duplicateAnswer.structuredContent as any).delivery, "delivered");
  await until(() => jobPayload(questionJob.jobId)?.status === "completed");
  for (const job of jobs) {
    const payload = jobPayload(job.jobId);
    assert.equal(payload.threadId, job.threadId);
    assert.equal(payload.upstreamRequestId, job.turnId);
    assert.equal(payload.result.content[0].text, job === questionJob ? "OPTIONAL INPUT COMPLETE" : `RECOVERED:${job.marker}`);
    assert.equal(payload.terminalOrigin, "normal-completion");
    assert.equal(read(db => db.prepare("SELECT count(*) AS n FROM jobs WHERE request_id = ?").get(job.requestId)).n, 1);
  }
  assert.equal(readFileSync(turnFile, "utf8").trim().split("\n").length, 3, "no replayed turn");
  assert.equal(new Set(ownerPids).size, 1, "the execution owner generation survived");
  assert.equal(read(db => db.pragma("quick_check", { simple: true })), "ok");
  console.log(JSON.stringify({ issue: 185, kind: "isolated-fault-injection",
    testedAt: new Date().toISOString(), runtime: dist || "source", productionDatabaseModified: false,
    stateOwnerRestarts: statePids.length - 1, stateOwnerRestarted: statePids.length === 3, executionOwnerPreserved: true,
    workers: 2, jobs: jobs.map(job => job.jobId), exactResultsRecovered: 3, recoveredQuestionAnsweredOnce: true,
    duplicateJobs: 0, duplicateTurns: 0, databaseQuickCheck: "ok", passed: true }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ health: server.applicationService.runtimeHealth?.(), jobs: jobs.map(job => jobPayload(job.jobId)) }, null, 2));
  throw error;
} finally {
  if (pausedPid) process.kill(pausedPid, "SIGCONT");
  await client.close().catch(() => {});
  await new Promise<void>(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

function read<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(stateFile, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
}
function jobPayload(id: string): any {
  const row = read(db => db.prepare("SELECT payload, status, thread_id AS threadId, upstream_request_id AS upstreamRequestId, terminal_origin AS terminalOrigin FROM jobs WHERE job_id=?").get(id)) as Record<string, any> | undefined;
  return row?.payload ? { ...JSON.parse(row.payload), ...row } : undefined;
}
async function until(predicate: () => boolean | Promise<boolean>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) { if (Date.now() >= deadline) throw new Error("recovery condition timeout"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
