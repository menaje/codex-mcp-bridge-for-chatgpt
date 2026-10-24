import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ChildProcessCodexExecutionService as Service } from "../src/executionServiceProcess.js";
import { executionEndpoint, type ExecutionPeer } from "../src/executionTransport.js";
import { withExecutionIdentity } from "../src/executionIdentity.js";
import type { UpstreamWorkerAssignment } from "../src/upstream.js";

it("reclaims settled metadata receipts before admitting the next bounded batch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retention-burst-"));
  const endpoint = executionEndpoint();
  const service = await Service.start({ command: path.resolve("test/fixtures/fake-codex-app-server.mjs"),
    poolSize: 1, endpoint, environment: { ...process.env, HOME: root, CODEX_HOME: path.join(root, ".codex"), CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1" } });
  try {
    // Eight callers, below the old 30-entry capacity. Every response is consumed
    // before the next batch; completed reads must not create artificial pressure.
    for (let batch = 0; batch < 20; batch++) {
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.listTools()));
      expect(results.filter(result => result.status === "rejected")).toEqual([]);
    }
    await expect(service.callTool("codex", { prompt: "after metadata burst", cwd: root,
      sandbox: "read-only", "approval-policy": "never" })).resolves.toHaveProperty("content");
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
    await rm(endpoint.directory, { recursive: true, force: true });
  }
}, 20_000);

it("retries dropped ACKs on a live link and reconnect without replaying completed execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retention-ack-"));
  const endpoint = executionEndpoint();
  const turns = path.join(root, "turns.jsonl");
  const service = await Service.start({ command: path.resolve("test/fixtures/fake-codex-app-server.mjs"),
    poolSize: 1, endpoint, environment: { ...process.env, HOME: root, CODEX_HOME: path.join(root, ".codex"), CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1", CODEX_TEST_TURN_OBSERVATION: turns } });
  const peer = (service as unknown as { child: ExecutionPeer }).child;
  const send = peer.send.bind(peer);
  let droppedAck = false, droppedReply = false, disconnectOnReply = false, disconnected = false;
  peer.send = (message: any, callback) => {
    if (message.type === "acknowledge" && !droppedAck) { droppedAck = true; callback?.(); return true; }
    return send(message, callback);
  };
  const receiver = service as unknown as { onMessage(message: any): void };
  const receive = receiver.onMessage.bind(service);
  receiver.onMessage = message => {
    if (message.type === "acknowledged" && !droppedReply) { droppedReply = true; return; }
    if (message.type === "acknowledged" && disconnectOnReply) {
      disconnectOnReply = false; disconnected = true; peer.disconnect(); return;
    }
    receive(message);
  };
  try {
    const generation = service.health().generation;
    await expect(service.callTool("codex", { prompt: "one exact turn", cwd: root,
      sandbox: "read-only", "approval-policy": "never" })).resolves.toHaveProperty("content");
    expect(droppedAck && droppedReply).toBe(true);
    expect(service.health().generation).toBe(generation);
    expect(service.health().pendingAcknowledgements).toBe(0);
    expect((await readFile(turns, "utf8")).trim().split("\n")).toHaveLength(1);
    disconnectOnReply = true;
    await expect(service.callTool("codex", { prompt: "one exact turn after reconnect", cwd: root,
      sandbox: "read-only", "approval-policy": "never" })).resolves.toHaveProperty("content");
    expect(disconnected).toBe(true);
    expect(service.health().generation).toBe(generation);
    expect(service.health().pendingAcknowledgements).toBe(0);
    expect((await readFile(turns, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally {
    await service.close(); await rm(root, { recursive: true, force: true }); await rm(endpoint.directory, { recursive: true, force: true });
  }
}, 15_000);

it("reports durable receipt saturation, preserves results, and allows metadata/control until commits release capacity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retention-commit-"));
  const endpoint = executionEndpoint();
  const service = await Service.start({ command: path.resolve("test/fixtures/fake-codex-app-server.mjs"),
    poolSize: 2, endpoint, environment: { ...process.env, HOME: root, CODEX_HOME: path.join(root, ".codex"), CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1" } });
  const task = (prompt: string) => ({ prompt, cwd: root, sandbox: "read-only", "approval-policy": "never" });
  const peer = (service as unknown as { child: ExecutionPeer }).child;
  const send = peer.send.bind(peer);
  let blockCommitAcks = true;
  peer.send = (message: any, callback) => {
    if (blockCommitAcks && message.type === "acknowledge" &&
        (message.requestId.startsWith("durable-") || message.requestId === "held")) { callback?.(); return true; }
    return send(message, callback);
  };
  let assignment: UpstreamWorkerAssignment | undefined;
  const held = withExecutionIdentity("held", () => service.callTool("codex", task("hold exact turn"), undefined, a => { assignment = a; }));
  void held.catch(() => {});
  try {
    await until(() => Boolean(assignment?.upstreamRequestId));
    for (let index = 0; index < 29; index++) {
      await withExecutionIdentity(`durable-${index}`, () => service.callTool("codex", task(`completed ${index}`)));
    }
    await until(() => service.health().status === "capacity");
    expect(service.health().journal?.lanes.execution).toMatchObject({ used: 30, active: 1,
      awaitingAcknowledgement: 29, awaitingCommitAcknowledgement: 29 });
    for (let index = 0; index < 29; index++) service.acknowledgeExecution(`durable-${index}`);
    await expect(service.callTool("codex", task("capacity rejection"))).rejects.toThrow("EXECUTION_RETENTION_CAPACITY");
    await expect(service.listTools()).resolves.toBeDefined();
    await service.steerThread(assignment!.threadId!, "result through saturated journal");
    await expect(held).resolves.toMatchObject({ content: [{ text: "STEERED:result through saturated journal" }] });
    await expect(service.recoverExecution("durable-0")).resolves.toHaveProperty("content");
    service.acknowledgeExecution("held");
    blockCommitAcks = false;
    await until(() => service.health().journal?.lanes.execution.used === 0);
    expect(service.health().status).toBe("ready");
    await expect(service.callTool("codex", task("after durable commits"))).resolves.toHaveProperty("content");
  } finally {
    await service.close(); await held.catch(() => {});
    await rm(root, { recursive: true, force: true }); await rm(endpoint.directory, { recursive: true, force: true });
  }
}, 25_000);

it("keeps reply-release waiters inside parent request limits and preserves the control reserve", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retention-parent-limit-"));
  const endpoint = executionEndpoint();
  const service = await Service.start({ command: path.resolve("test/fixtures/fake-codex-app-server.mjs"),
    poolSize: 1, endpoint, requestLimits: { maxPendingRequests: 4, controlRequestReserve: 1 },
    environment: { ...process.env, HOME: root, CODEX_HOME: path.join(root, ".codex"), CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1" } });
  const peer = (service as unknown as { child: ExecutionPeer }).child;
  const send = peer.send.bind(peer);
  let blockAcks = true;
  peer.send = (message: any, callback) => {
    if (blockAcks && message.type === "acknowledge") { callback?.(); return true; }
    return send(message, callback);
  };
  try {
    const reads = Promise.allSettled(Array.from({ length: 3 }, () => service.listTools()));
    await until(() => service.health().pendingAcknowledgements === 3);
    expect(service.health()).toMatchObject({ inFlight: 3, ordinaryInFlight: 3, status: "capacity" });
    await expect(service.listTools()).rejects.toThrow("EXECUTION_CAPACITY");
    // Even an invalid control must reach the owner and return its domain error.
    const control = service.steerThread("missing-thread", "control reserve").catch(error => error as Error);
    await until(() => service.health().pendingAcknowledgements === 4);
    expect(service.health()).toMatchObject({ inFlight: 4, ordinaryInFlight: 3 });
    await expect(service.steerThread("missing-thread", "over absolute limit")).rejects.toThrow("EXECUTION_CAPACITY");
    blockAcks = false;
    expect((await reads).every(result => result.status === "fulfilled")).toBe(true);
    expect(await control).toBeInstanceOf(Error);
    expect(String(await control)).not.toContain("EXECUTION_CAPACITY");
    expect(service.health()).toMatchObject({ inFlight: 0, ordinaryInFlight: 0, pendingAcknowledgements: 0, status: "ready" });
  } finally {
    blockAcks = false;
    await service.close(); await rm(root, { recursive: true, force: true }); await rm(endpoint.directory, { recursive: true, force: true });
  }
}, 15_000);

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("retention condition timeout"); await new Promise(r => setTimeout(r, 20)); }
}
