import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const dist = process.env.CODEX_TEST_BUNDLE_DIST;
const durationMs = Number(process.env.CODEX_TEST_OBSERVATION_OUTAGE_MS || 90_000);
assert(Number.isInteger(durationMs) && durationMs >= 30_000 && durationMs <= 600_000);
const root = await mkdtemp(path.join(tmpdir(), "issue-186-observation-"));
const stateFile = path.join(root, "state.sqlite");
const faultFile = path.join(root, "fault.json");
const traceFile = path.join(root, "probes.jsonl");
const turnsFile = path.join(root, "turns.jsonl");
const preload = path.resolve("test/fixtures/execution-faults.mjs");
const previousFault = process.env.CODEX_TEST_PS_FAULT;
const previousTrace = process.env.CODEX_TEST_PS_TRACE;
process.env.CODEX_TEST_PS_FAULT = faultFile;
process.env.CODEX_TEST_PS_TRACE = traceFile;
// Instrument the parent as well as its children: absence of parent periodic
// scans is measured, not disguised as a successfully injected parent failure.
await import(pathToFileURL(preload).href);
const { loadConfig } = await import(dist ? pathToFileURL(path.join(dist, "config.js")).href : "../src/config.js");
const { createIsolatedHttpServer } = await import(dist ? pathToFileURL(path.join(dist, "runtimeProcess.js")).href : "../src/runtimeProcess.js");
const environment = { ...process.env, HOME: root, CODEX_HOME: path.join(root, ".codex"),
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(" "),
  CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
  CODEX_MCP_BRIDGE_CODEX: path.resolve("test/fixtures/fake-codex-app-server.mjs"),
  CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: stateFile,
  CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
  CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills"),
  CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "3", CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1",
  CODEX_TEST_TURN_OBSERVATION: turnsFile };
const ownerPids: number[] = [];
const statePids: number[] = [];
const server = await createIsolatedHttpServer(loadConfig(environment), { childEnvironment: environment,
  onRuntimeProcessSpawn: (pid: number) => statePids.push(pid),
  onExecutionProcessSpawn: (pid: number) => ownerPids.push(pid) });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const client = new Client({ name: "issue-186-observation", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } });
type Job = { jobId: string; requestId: string; session: string; threadId: string; turnId: string; workerPid: number };
const jobs: Job[] = [];
let project: unknown;
let contract: Record<string, { const?: unknown }>;
const health = () => server.applicationService.runtimeHealth?.().executionService;
try {
  await until(async () => (await fetch(`${base}/readyz`)).ok);
  await server.applicationService.updateSettings({ expectedRegistryRevision: 0, operation: { kind: "patch",
    settings: { projectOperations: [{ kind: "add", project: { name: "Observation fixture", cwd: root } }] } } });
  project = read(db => db.prepare("SELECT name, project_ref AS projectRef, project_revision AS projectRevision FROM projects WHERE archived_at IS NULL LIMIT 1").get());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
  contract = descriptor.inputSchema.properties as typeof contract;
  const survivor = await start("hold across a long observation outage");
  const question = await start("blocking input");
  const steerable = await start("hold steer during observation outage");
  assert.equal(new Set(jobs.map(job => job.workerPid)).size, 3);
  const ownerPid = ownerPids.at(-1)!;
  const generation = health()!.generation;
  await setFault("execution");
  await until(() => health()?.observationStatus === "degraded");
  const outageStartedAt = Date.now();
  const independent = await start("independent admission while ps fails");
  await completed(independent, "APP SERVER");
  const input = await call("codex_status", question, { query: { kind: "input", jobId: question.jobId } });
  await call("codex_answer", question, { requestId: randomUUID(), jobId: question.jobId,
    questionRef: input.questions[0].questionRef, answers: { color: ["blue"] } });
  await completed(question, "OPTIONAL INPUT COMPLETE");
  await steer(steerable, "control continues during observation failure");
  const cancelled = await start("hold explicit cancellation during outage");
  await call("codex_cancel", cancelled, { requestId: randomUUID(), target: { kind: "job", id: cancelled.jobId },
    expectedVersion: payload(cancelled).version, reason: "Isolated regression test cancellation" });
  await until(() => payload(cancelled).status === "cancelled");
  let independentLater: Job | undefined;
  while (Date.now() - outageStartedAt < durationMs) {
    const elapsed = Date.now() - outageStartedAt;
    assert.equal(payload(survivor).status, "running");
    assert.equal(health()?.generation, generation);
    assert.equal(health()?.observationStatus, "degraded");
    assert.equal(health()?.status, "ready");
    if (!independentLater && elapsed >= durationMs / 2) {
      independentLater = await start("new independent admission late in outage");
      await completed(independentLater, "APP SERVER");
    }
    await delay(250);
  }
  const outageEndedAt = Date.now();
  assert(independentLater);
  assert.equal(new Set(ownerPids).size, 1);
  process.kill(ownerPid, 0);
  // Target the removed parent periodic observer. The child now recovers while
  // the original survivor is still running. No parent ps should be attempted.
  await setFault("control");
  await until(() => health()?.observationStatus === "ready");
  await delay(6_000);
  const afterRecovery = await start("independent work after observer recovery");
  await completed(afterRecovery, "APP SERVER");
  await steer(survivor, "same original turn after observer recovery");
  assert.equal(health()?.generation, generation);
  assert.equal(statePids.length, 1);
  const turns = jsonLines(turnsFile);
  assert.equal(turns.length, jobs.length, "no automatic duplicate turn");
  for (const job of jobs) {
    const actual = payload(job);
    assert.equal(actual.threadId, job.threadId); assert.equal(actual.turnId, job.turnId);
    assert.equal(read(db => db.prepare("SELECT count(*) AS n FROM jobs WHERE request_id=?").get(job.requestId)).n, 1);
    assert.equal(turns.filter(turn => turn.pid === job.workerPid && turn.turnId === job.turnId).length, 1);
  }
  const trace = jsonLines(traceFile);
  const parentProbes = trace.filter(entry => entry.event === "probe-start" && entry.role === "control");
  assert.equal(parentProbes.length, 0, "no parent periodic process-table scans");
  const ownerTrace = trace.filter(entry => entry.pid === ownerPid);
  let active = 0, maxActive = 0;
  for (const entry of ownerTrace) {
    if (entry.event === "probe-start") { active += 1; maxActive = Math.max(maxActive, active); }
    if (entry.event === "probe-close") active -= 1;
  }
  assert.equal(maxActive, 1, "single in-flight observation probe");
  const probes = ownerTrace.filter(entry => entry.event === "probe-start" && entry.at >= outageStartedAt && entry.at <= outageEndedAt);
  assert(probes.length >= 5 && probes.length <= Math.ceil(durationMs / 2000) + 6);
  assert(probes.every(entry => entry.mode === "slow"), "fault remains active throughout the measured outage");
  const samples = ownerTrace.filter(entry => entry.event === "resources" && entry.at >= outageStartedAt && entry.at <= outageEndedAt);
  assert(samples.length >= 10);
  const first = samples[0], last = samples.at(-1)!;
  const cpuPercent = 100 * ((last.cpu.user + last.cpu.system) - (first.cpu.user + first.cpu.system)) / ((last.at - first.at) * 1000);
  const rssGrowthBytes = Math.max(...samples.map(sample => sample.memory.rss)) - first.memory.rss;
  assert(cpuPercent < 50, "observer retry must not spin on one CPU core");
  assert(rssGrowthBytes < 128 * 1024 * 1024, "bounded observer retry memory");
  assert.equal(read(db => db.pragma("quick_check", { simple: true })), "ok");
  console.log(JSON.stringify({ issue: 186, kind: "isolated-observation-fault-injection", testedAt: new Date().toISOString(),
    runtime: dist || "source", productionDatabaseModified: false, workers: 3, jobs: jobs.length,
    completedJobs: jobs.length - 1, explicitlyCancelledJobs: 1, duplicateJobs: 0, duplicateTurns: 0,
    outageMs: outageEndedAt - outageStartedAt, oldHeartbeatKillThresholdsExceeded: (outageEndedAt - outageStartedAt) / 10_000,
    observationProbes: probes.length, maximumConcurrentProbes: maxActive, parentPeriodicProbes: parentProbes.length,
    ownerCpuPercent: Number(cpuPercent.toFixed(2)), ownerRssGrowthBytes: rssGrowthBytes,
    executionOwnerPreserved: true, stateOwnerPreserved: true, sameJobRecoveredAfterObservation: true,
    questionAnsweredDuringOutage: true, steeringDeliveredDuringOutage: true, cancellationIsolatedDuringOutage: true,
    newIndependentJobsDuringOutage: 2, databaseQuickCheck: "ok", passed: true }, null, 2));
} finally {
  await rm(faultFile, { force: true });
  await client.close().catch(() => {});
  await new Promise<void>(resolve => server.close(resolve));
  if (previousFault === undefined) delete process.env.CODEX_TEST_PS_FAULT; else process.env.CODEX_TEST_PS_FAULT = previousFault;
  if (previousTrace === undefined) delete process.env.CODEX_TEST_PS_TRACE; else process.env.CODEX_TEST_PS_TRACE = previousTrace;
  await rm(root, { recursive: true, force: true });
}

async function start(prompt: string): Promise<Job> {
  const requestId = randomUUID(), session = randomUUID();
  const response = await client.callTool({ name: "codex_task", _meta: { "openai/session": session }, arguments: {
    requestId, taskContractVersion: contract.taskContractVersion.const, executionEnvelopeRef: contract.executionEnvelopeRef.const,
    prompt, selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }, project } });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const jobId = (response.structuredContent as any).jobId;
  await until(() => Boolean(read(db => db.prepare("SELECT upstream_request_id FROM jobs WHERE job_id=?").get(jobId))?.upstream_request_id));
  const row = read(db => db.prepare("SELECT thread_id, upstream_request_id, payload FROM jobs WHERE job_id=?").get(jobId));
  const job = { jobId, requestId, session, threadId: row.thread_id, turnId: row.upstream_request_id, workerPid: JSON.parse(row.payload).workerPid };
  jobs.push(job); return job;
}
async function call(name: string, job: Job, args: unknown): Promise<any> {
  const result = await client.callTool({ name, _meta: { "openai/session": job.session }, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent;
}
async function steer(job: Job, prompt: string): Promise<void> {
  const result = await call("codex_steer", job, { requestId: randomUUID(), jobId: job.jobId, expectedJobVersion: payload(job).version, prompt });
  assert.equal(result.delivery.status, "delivered");
  // Durable Job results intentionally redact user steering input.
  await completed(job, "STEERED:[steering input omitted]");
}
async function completed(job: Job, text: string): Promise<void> {
  await until(() => payload(job).status === "completed");
  assert.equal(payload(job).result.content[0].text, text);
}
async function setFault(role: string): Promise<void> {
  await writeFile(faultFile + ".new", JSON.stringify({ mode: "slow", role }));
  await rename(faultFile + ".new", faultFile);
}
function jsonLines(file: string): any[] { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
function read(fn: (db: Database.Database) => any): any {
  const db = new Database(stateFile, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
}
function payload(job: Job): any {
  const row = read(db => db.prepare("SELECT payload,status,job_version AS version,thread_id AS threadId,upstream_request_id AS turnId FROM jobs WHERE job_id=?").get(job.jobId));
  return { ...JSON.parse(row.payload), ...row };
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
async function until(predicate: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) { if (Date.now() >= deadline) throw new Error("observation regression condition timeout"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
