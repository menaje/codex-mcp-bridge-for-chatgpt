import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { ChildProcessCodexExecutionService as Service } from "../src/executionServiceProcess.js";
import { executionEndpoint, type ExecutionPeer } from "../src/executionTransport.js";
import { withExecutionIdentity } from "../src/executionIdentity.js";
import type { CodexPendingInteraction, UpstreamWorkerAssignment } from "../src/upstream.js";

const fixture = path.resolve("test/fixtures/fake-codex-app-server.mjs");
const preload = path.resolve("test/fixtures/execution-faults.mjs");
const services: Service[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(extra: NodeJS.ProcessEnv = {}, endpoint = executionEndpoint()) {
  directories.push(endpoint.directory);
  const home = await mkdtemp(path.join(tmpdir(), "exec-recovery-"));
  directories.push(home);
  const options = { command: fixture, poolSize: 2, endpoint,
    environment: { ...process.env, CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1", HOME: home, CODEX_HOME: path.join(home, ".codex"), ...extra } };
  const service = await Service.start(options); services.push(service);
  return { service, options };
}
const task = (prompt: string) => ({ prompt, cwd: process.cwd(), sandbox: "read-only", "approval-policy": "on-request" });
const peer = (service: Service) => (service as unknown as { child: ExecutionPeer }).child;
async function until(predicate: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("condition timeout"); await new Promise(r => setTimeout(r, 20)); }
}

it("reconnects a broken control socket without duplicating its turn or result", async () => {
  const { service } = await setup();
  let assignment: UpstreamWorkerAssignment | undefined;
  const id = randomUUID();
  const running = withExecutionIdentity(id, () => service.callTool("codex", task("hold recovery"), undefined, value => { assignment = value; }));
  await until(() => Boolean(assignment?.upstreamRequestId));
  const original = { ...assignment };
  const generation = service.health().generation;
  peer(service).disconnect();
  await until(() => service.health().status === "ready");
  await service.steerThread(original.threadId!, "same turn after reconnect");
  await expect(running).resolves.toMatchObject({ content: [{ text: "STEERED:same turn after reconnect" }] });
  expect(assignment).toEqual(original);
  expect(service.health().generation).toBe(generation);
  // Re-delivery of the terminal receipt cannot start a second turn.
  await expect(service.recoverExecution(id)).resolves.toMatchObject({ content: [{ text: "STEERED:same turn after reconnect" }] });
  service.acknowledgeExecution(id);
}, 20_000);

it("drains a large restored acknowledgement history through the bounded reconnect queue", async () => {
  const { service } = await setup();
  const generation = service.health().generation;
  peer(service).disconnect();
  await until(() => !peer(service).connected);
  for (let index = 0; index < 600; index++) {
    service.acknowledgeExecution(`durable-terminal-${index}`);
    service.protectThreadFromImplicitResume(`protected-thread-${index}`);
  }
  const acknowledgements = (service as unknown as { acknowledgements: Set<string> }).acknowledgements;
  await until(() => acknowledgements.size === 0);
  await expect(service.callTool("codex", task("after restored history")))
    .resolves.toMatchObject({ content: [{ text: "APP SERVER" }] });
  expect(service.health().generation).toBe(generation);
}, 20_000);

it("reattaches a replacement controller to an exact question and preserves its answer/result", async () => {
  const { service, options } = await setup();
  let input: CodexPendingInteraction | undefined;
  let assignment: UpstreamWorkerAssignment | undefined;
  const id = randomUUID();
  void withExecutionIdentity(id, () => service.callTool("codex", task("elicitation form"), progress => {
    input = progress.event?.details?.interaction as CodexPendingInteraction || input;
  }, value => { assignment = value; }));
  await until(() => Boolean(input && assignment?.upstreamRequestId));
  const generation = service.health().generation;
  service.detachExecution();
  const replacement = await Service.start(options); services.push(replacement);
  let recovered: CodexPendingInteraction | undefined;
  const result = replacement.recoverExecution(id, progress => {
    recovered = progress.event?.details?.interaction as CodexPendingInteraction || recovered;
  }, value => expect(value).toEqual(assignment));
  await until(() => Boolean(recovered));
  expect(recovered!.interactionId).toBe(input!.interactionId);
  expect(replacement.interactionInput(input!.interactionId)).toHaveProperty("requestedSchema");
  await replacement.respondToInteraction(input!.interactionId, { elicitation: {
    action: "accept", content: { color: "blue", count: 2, enabled: false, tags: ["b"] }
  } });
  await expect(result).resolves.toMatchObject({ content: [{ text: "ELICITATION COMPLETE" }] });
  expect(replacement.health().generation).toBe(generation);
  await expect(replacement.respondToInteraction(input!.interactionId, { elicitation: { action: "cancel" } }))
    .rejects.toThrow(/already resolved|Unknown/);
  replacement.acknowledgeExecution(id);
}, 20_000);

it("recovers completion produced while no controller was connected", async () => {
  const { service, options } = await setup();
  const id = randomUUID();
  let assigned = false;
  void withExecutionIdentity(id, () => service.callTool("codex", task("delayed isolated completion"), undefined, () => { assigned = true; }));
  await until(() => assigned);
  const ownerPid = service.processId;
  service.detachExecution();
  await new Promise(r => setTimeout(r, 400));
  const replacement = await Service.start(options); services.push(replacement);
  expect(replacement.processId).toBe(ownerPid);
  await expect(replacement.recoverExecution(id)).resolves.toMatchObject({ content: [{ text: "ISOLATED COMPLETION" }] });
  replacement.acknowledgeExecution(id);
}, 20_000);

it("lets exact completion win a late cancellation without killing another turn on the same worker", async () => {
  const { service } = await setup();
  let completed: UpstreamWorkerAssignment | undefined;
  await service.callTool("codex", task("complete before cancel"), undefined, value => { completed = value; });
  let active: UpstreamWorkerAssignment | undefined;
  const running = service.callTool("codex", task("hold unaffected same worker"), undefined, value => { active = value; });
  void running.catch(() => {});
  await until(() => Boolean(active?.upstreamRequestId));
  expect(active!.workerId).toBe(completed!.workerId);
  await expect(service.forceTerminateWorker(completed!, {
    kind: "cancellation-intent", intentId: randomUUID(), requestId: randomUUID(),
    source: "operator", reasonCode: "explicit-stop"
  })).resolves.toMatchObject({ mode: "already-completed", workerExited: false });
  await service.steerThread(active!.threadId!, "still active after late cancellation");
  await expect(running).resolves.toMatchObject({ content: [{ text: "STEERED:still active after late cancellation" }] });
}, 20_000);

it.each(["slow", "output-limit", "exit"])("completes old and new turns throughout continuous ps %s failure", async mode => {
  const dir = await mkdtemp(path.join(tmpdir(), "ps-fault-")); directories.push(dir);
  const gate = path.join(dir, "fault"); await writeFile(gate, mode);
  const { service } = await setup({ NODE_OPTIONS: `--import=${preload}`, CODEX_TEST_PS_FAULT: gate });
  let assignment: UpstreamWorkerAssignment | undefined;
  const running = service.callTool("codex", task("hold observer outage"), undefined, value => { assignment = value; });
  void running.catch(() => {});
  await until(() => Boolean(assignment?.threadId));
  const pid = service.processId;
  await until(() => service.health().observationStatus === "degraded");
  // At least two full slow-probe deadlines elapse; recovery is deliberately absent.
  if (mode === "slow") await new Promise(r => setTimeout(r, 7000));
  await expect(service.callTool("codex", task("new independent task")))
    .resolves.toMatchObject({ structuredContent: { turnStatus: "completed" } });
  await service.steerThread(assignment!.threadId!, "observer still broken");
  await expect(running).resolves.toMatchObject({ content: [{ text: "STEERED:observer still broken" }] });
  expect(service.processId).toBe(pid);
  expect(service.health().status).toBe("ready");
  expect(service.health().observationStatus).toBe("degraded");
  // Restore only for teardown, after every result above was already recovered.
  await rm(gate);
}, 30_000);

it("keeps healthy protocol traffic alive when only heartbeat is missing beyond the old kill threshold", async () => {
  const { service } = await setup({ NODE_OPTIONS: `--import=${preload}`, CODEX_TEST_NO_HEARTBEAT: "1" });
  let assignment: UpstreamWorkerAssignment | undefined;
  const running = service.callTool("codex", task("hold heartbeat missing"), undefined, value => { assignment = value; });
  void running.catch(() => {});
  await until(() => Boolean(assignment?.threadId));
  const pid = service.processId;
  await new Promise(r => setTimeout(r, 11_000));
  expect(service.health()).toMatchObject({ status: "ready", heartbeatStatus: "delayed" });
  await expect(service.callTool("codex", task("new work without heartbeat"))).resolves.toHaveProperty("content");
  await service.steerThread(assignment!.threadId!, "protocol is healthy");
  await expect(running).resolves.toMatchObject({ content: [{ text: "STEERED:protocol is healthy" }] });
  expect(service.processId).toBe(pid);
}, 25_000);
