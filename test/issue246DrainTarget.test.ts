import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { RuntimeDrainGate, initialRuntimeDrainBinding, type RuntimeDrainTarget } from "../src/runtimeDrain.js";

function target(): RuntimeDrainTarget {
  return { launcherPid: 100, token: randomUUID(), requestId: randomUUID(), attempt: 1, deadlineAt: Date.now() + 300_000 };
}

it("binds one receiver identity and closes admission in the synchronous guarded mutation", () => {
  const identity = target(), admission = { acceptingNewJobs: true };
  const receiver = new RuntimeDrainGate(admission, identity);
  receiver.begin(identity);
  expect(admission.acceptingNewJobs).toBe(false);
  receiver.cancel(identity);
  expect(admission.acceptingNewJobs).toBe(true);
});

it("owner/socket replacement during the asynchronous ps gap cannot drain the new receiver", async () => {
  const observedA = target();
  const replacementB = { ...target(), launcherPid: 200 };
  const admissionB = { acceptingNewJobs: true };
  const receiverB = new RuntimeDrainGate(admissionB, replacementB);
  // Model the caller retaining A across the process-table await; B now owns
  // the socket. This is a receiver-boundary unit, not an executed OS race.
  await Promise.resolve();
  expect(() => receiverB.begin(observedA)).toThrow("RUNTIME_DRAIN_TARGET_CHANGED");
  expect(admissionB.acceptingNewJobs).toBe(true);
});

it("cancelDrain dispatched after socket service replacement cannot reopen B's independent drain", async () => {
  const observedA = target(), identityB = { ...target(), launcherPid: 200 };
  const admissionB = { acceptingNewJobs: true };
  const receiverB = new RuntimeDrainGate(admissionB, identityB);
  receiverB.begin();
  await Promise.resolve();
  expect(() => receiverB.cancel(observedA)).toThrow("RUNTIME_DRAIN_TARGET_CHANGED");
  expect(admissionB.acceptingNewJobs).toBe(false);
});

it("an unbound/legacy receiver cannot silently accept a targeted mutation", () => {
  const admission = { acceptingNewJobs: true }, receiver = new RuntimeDrainGate(admission, null);
  expect(() => receiver.begin(target())).toThrow("RUNTIME_DRAIN_TARGET_CHANGED");
  expect(admission.acceptingNewJobs).toBe(true);
});

it("lost begin reply can be cancelled, and a delayed begin cannot undo the restoration", () => {
  const identity = target(), admission = { acceptingNewJobs: true };
  const receiver = new RuntimeDrainGate(admission, identity);
  receiver.cancel(identity); // begin may still be queued in IPC.
  expect(() => receiver.begin(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(admission.acceptingNewJobs).toBe(true);
  receiver.begin(); // A later operator drain must not be reopened by old cancel.
  expect(() => receiver.cancel(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(admission.acceptingNewJobs).toBe(false);
});

it("ordinary drain/cancel remains usable while a later ordinary begin supersedes targeted A", () => {
  const identity = target(), admission = { acceptingNewJobs: true };
  const receiver = new RuntimeDrainGate(admission, identity);
  receiver.begin(identity);
  expect(() => receiver.cancel()).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(admission.acceptingNewJobs).toBe(false);
  receiver.begin(); // The newer ordinary control supersedes A's ownership.
  expect(() => receiver.cancel(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(admission.acceptingNewJobs).toBe(false);
  receiver.cancel(); expect(admission.acceptingNewJobs).toBe(true);
  expect(() => receiver.begin(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(admission.acceptingNewJobs).toBe(true);
});

it("late cancel(A) cannot release a newer ordinary stop/drain/force/handoff gate", () => {
  // These controls share the existing ordinary beginDrain boundary; no new
  // authority or distinction between their wire contracts is introduced.
  const identity = target(), admission = { acceptingNewJobs: true };
  const receiver = new RuntimeDrainGate(admission, identity);
  receiver.begin(identity); receiver.begin();
  expect(() => receiver.cancel(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(admission.acceptingNewJobs).toBe(false);
  receiver.cancel(); expect(admission.acceptingNewJobs).toBe(true);
  receiver.begin();
  expect(() => receiver.cancel(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(admission.acceptingNewJobs).toBe(false);
});

it("ordinary begin before delayed A permanently prevents A begin from re-closing after ordinary cancel", () => {
  const identity = target(), admission = { acceptingNewJobs: true };
  const receiver = new RuntimeDrainGate(admission, identity);
  receiver.begin();
  expect(() => receiver.begin(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(() => receiver.cancel(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(admission.acceptingNewJobs).toBe(false);
  receiver.cancel();
  expect(() => receiver.begin(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(admission.acceptingNewJobs).toBe(true);
});

it("cancelled A replay cannot affect a following ordinary drain, including repeated overlap", () => {
  const identity = target(), admission = { acceptingNewJobs: true };
  const receiver = new RuntimeDrainGate(admission, identity);
  receiver.begin(identity); receiver.cancel(identity);
  receiver.begin(); receiver.begin();
  expect(() => receiver.cancel(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(() => receiver.begin(identity)).toThrow("RUNTIME_DRAIN_NOT_OWNED");
  expect(admission.acceptingNewJobs).toBe(false);
  receiver.cancel(); expect(admission.acceptingNewJobs).toBe(true);
});

it("same-owner A begin replay remains cancellable without a later ordinary begin", () => {
  const identity = target(), admission = { acceptingNewJobs: true };
  const receiver = new RuntimeDrainGate(admission, identity);
  receiver.begin(identity); receiver.begin(identity); receiver.cancel(identity);
  expect(admission.acceptingNewJobs).toBe(true);
});

it("an ordinary unbound gate retains repeated begin/cancel behavior", () => {
  const admission = { acceptingNewJobs: true }, receiver = new RuntimeDrainGate(admission, null);
  receiver.begin(); receiver.begin(); expect(admission.acceptingNewJobs).toBe(false);
  receiver.cancel(); expect(admission.acceptingNewJobs).toBe(true);
  receiver.begin(); receiver.cancel(); expect(admission.acceptingNewJobs).toBe(true);
});

it("late recovery dispatch respects the original/shortened deadline before any mutation", () => {
  const identity = target(), admission = { acceptingNewJobs: true };
  let observedTime = identity.deadlineAt - 2;
  const receiver = new RuntimeDrainGate(admission, identity, () => observedTime);
  receiver.begin({ ...identity, deadlineAt: identity.deadlineAt - 1 });
  observedTime = identity.deadlineAt - 1;
  expect(() => receiver.cancel(identity)).toThrow("RUNTIME_DRAIN_DEADLINE");
  expect(admission.acceptingNewJobs).toBe(false);
});

it("freezes the inherited launcher binding and rejects renewed budget", () => {
  const identity = target();
  const environment = { CODEX_MCP_BRIDGE_INITIAL_START_REQUEST: identity.requestId,
    CODEX_MCP_BRIDGE_INITIAL_START_TOKEN: identity.token, CODEX_MCP_BRIDGE_INITIAL_START_ATTEMPT: "1",
    CODEX_MCP_BRIDGE_INITIAL_START_LAUNCHER_PID: "100", CODEX_MCP_BRIDGE_INITIAL_START_DEADLINE: String(identity.deadlineAt - 7000) };
  const bound = initialRuntimeDrainBinding(environment)!;
  environment.CODEX_MCP_BRIDGE_INITIAL_START_TOKEN = randomUUID();
  const admission = { acceptingNewJobs: true }, receiver = new RuntimeDrainGate(admission, bound);
  expect(() => receiver.begin({ ...identity, deadlineAt: identity.deadlineAt + 1 })).toThrow("RUNTIME_DRAIN_DEADLINE");
  expect(admission.acceptingNewJobs).toBe(true);
  receiver.begin(identity); expect(admission.acceptingNewJobs).toBe(false);
});
