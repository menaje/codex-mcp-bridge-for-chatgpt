import { expect, it, vi } from "vitest";
import { ExecutionJournal } from "../src/executionJournal.js";

const request = (id: string) => ({ type: "request", requestId: id, operation: "callTool", args: [id], retained: true });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

it("keeps inspection and metadata saturation outside execution and control reservations", () => {
  const journal = new ExecutionJournal("g", vi.fn());
  for (const operation of ["probeThread", "listModels"]) {
    for (let index = 0; index < 8; index++) {
      expect(journal.admit({ ...request(`${operation}-${index}`), operation, retained: false }, false)).toBe("new");
    }
    expect(journal.admit({ ...request(`${operation}-overflow`), operation, retained: false }, false)).toBe("rejected");
  }
  for (let index = 0; index < 30; index++) expect(journal.admit(request(`job-${index}`), false)).toBe("new");
  for (let index = 0; index < 6; index++) expect(journal.admit(request(`control-${index}`), true)).toBe("new");
  expect(journal.size).toBe(52);
  expect(journal.status().lanes).toMatchObject({
    execution: { used: 30, active: 30, awaitingAcknowledgement: 0 },
    inspection: { used: 8 }, metadata: { used: 8 }, control: { used: 6 }
  });
});

it("retains exact completion through a send failure and releases it only on acknowledgement", async () => {
  const journal = new ExecutionJournal("g", vi.fn());
  const received: any[] = [];
  journal.connect((_message, done) => { done(new Error("broken socket")); return false; });
  expect(journal.admit(request("job"), false)).toBe("new");
  journal.send({ type: "response", requestId: "job", ok: true, result: { exact: "result" } });
  expect(journal.size).toBe(1);
  journal.connect((message, done) => { received.push(message); done(); return true; });
  journal.recover("job"); await tick();
  expect(received).toMatchObject([{ requestId: "job", ok: true, result: { exact: "result" } }]);
  expect(journal.admit(request("job"), false)).toBe("existing");
  journal.acknowledge("job");
  expect(journal.size).toBe(0);
  expect(journal.admit(request("job"), false)).toBe("rejected");
});

it("bounds reservations, preserves existing outcomes at saturation, and reserves control slots", async () => {
  const journal = new ExecutionJournal("g", vi.fn());
  const received: any[] = [];
  journal.connect((message, done) => { received.push(message); done(); return true; });
  for (let index = 0; index < 30; index++) expect(journal.admit(request(`job-${index}`), false)).toBe("new");
  expect(journal.admit(request("overflow"), false)).toBe("rejected");
  for (let index = 0; index < 6; index++) expect(journal.admit(request(`control-${index}`), true)).toBe("new");
  expect(journal.admit(request("control-overflow"), true)).toBe("rejected");
  journal.send({ type: "response", requestId: "job-0", ok: true, result: "preserved" });
  await tick();
  expect(received).toContainEqual(expect.objectContaining({ requestId: "job-0", result: "preserved" }));
  journal.acknowledge("job-0");
  expect(journal.admit(request("available-again"), false)).toBe("new");
  expect(journal.size).toBe(36);
});

it("contains an oversized current question to its exact execution and preserves unrelated completion", async () => {
  const contain = vi.fn();
  const journal = new ExecutionJournal("g", contain);
  const received: any[] = [];
  journal.connect((message, done) => { received.push(message); done(); return true; });
  journal.admit(request("a"), false); journal.admit(request("b"), false);
  journal.send({ type: "assignment", requestId: "a", assignment: { threadId: "t", upstreamRequestId: "turn" } });
  journal.send({ type: "progress", requestId: "a", interactionId: "exact-question", interactionInput: "x".repeat(9 * 1024 * 1024) });
  expect(contain).toHaveBeenCalledExactlyOnceWith("a", { threadId: "t", upstreamRequestId: "turn" }, "EXECUTION_EVENT_RETENTION_EXHAUSTED");
  journal.send({ type: "response", requestId: "b", ok: true, result: "unrelated result" });
  // Containment is not a fabricated turn completion. A's terminal receipt is
  // produced only after the real protocol operation has settled.
  await tick();
  expect(received.filter(message => message.type === "response")).toMatchObject([{ requestId: "b", result: "unrelated result" }]);
  journal.send({ type: "response", requestId: "a", ok: true, result: "interrupted" });
  await tick();
  expect(received).toContainEqual(expect.objectContaining({ requestId: "a", ok: false,
    error: expect.objectContaining({ code: "EXECUTION_EVENT_RETENTION_EXHAUSTED" }) }));
});

it("coalesces a progress flood while keeping a live question and an exact completion", async () => {
  const journal = new ExecutionJournal("g", vi.fn());
  journal.admit(request("job"), false);
  journal.send({ type: "progress", requestId: "job", interactionId: "q", interactionInput: { question: "choose" } });
  for (let index = 0; index < 5000; index++) journal.send({ type: "progress", requestId: "job", progress: { message: `update ${index}` } });
  const received: any[] = [];
  journal.connect((message, done) => { received.push(message); done(); return true; });
  journal.recover("job"); await tick();
  expect(received).toHaveLength(2);
  expect(received[0].interactionId).toBe("q");
  expect(received[1].progress.message).toBe("update 4999");
  journal.send({ type: "response", requestId: "job", ok: true, result: "final" }); await tick();
  expect(received.at(-1)).toMatchObject({ ok: true, result: "final" });
});

it("never executes a duplicate or conflicting request and ignores events after terminal", async () => {
  const journal = new ExecutionJournal("g", vi.fn());
  expect(journal.admit(request("job"), false)).toBe("new");
  expect(journal.admit({ ...request("job"), args: ["different turn"] }, false)).toBe("existing");
  journal.send({ type: "response", requestId: "job", ok: true, result: "first terminal" });
  journal.send({ type: "response", requestId: "job", ok: true, result: "late wrong terminal" });
  const received: any[] = [];
  journal.connect((message, done) => { received.push(message); done(); return true; });
  journal.recover("job"); await tick();
  expect(received).toContainEqual(expect.objectContaining({ result: "first terminal" }));
  expect(received.some(message => message.result === "late wrong terminal")).toBe(false);
});
