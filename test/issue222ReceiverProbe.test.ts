import { describe, expect, it } from "vitest";
import { BASELINE_SHA, digest, evaluate, fixture, fixtureDigest, holdFixture, localDemo,
  type Evidence, type Run, type RunContext } from "../scripts/issue-222-receiver-probe.js";

// Inputs below are deliberately synthetic assertions, not recovered host history.
function trace(observation: Run["observation"] = "synthetic-upstream") {
  const context: RunContext = { runId: "current-test-run", baselineSha: BASELINE_SHA, fixtureDigest,
    startedAtMs: 0, endedAtMs: 1000, observation, route: "direct-wait", aJobRef: "a", bJobRef: "b" };
  const run: Run = { ...context, records: [] };
  const add = (kind: Evidence["kind"], extra: Partial<Evidence> = {}) => {
    const seq = run.records.length + 1;
    const control = ["hold-started", "release", "terminal", "b-admitted", "b-executed"].includes(kind);
    const b = ["b-approved", "b-admitted", "b-executed"].includes(kind);
    const e: Evidence = { runId: context.runId, seq, atMs: seq * 10, kind, source: "unit-test",
      provenance: control ? "synthetic-upstream" : observation, jobRef: b ? "b" : "a", success: true, ...extra };
    run.records.push(e); return e;
  };
  add("b-approved", { promptDigest: digest(fixture.bPrompt) });
  add("hold-started"); add("departure-observed"); add("release");
  add("terminal", { terminalVersion: 1, resultDigest: digest(fixture.a) });
  add("completion-observed", { terminalVersion: 1 });
  add("model-wake", { automatic: true });
  add("chat-bound", { chatMatches: true });
  add("result-read", { scopeMatches: true, terminalVersion: 1, resultDigest: digest(fixture.a) });
  add("result-reviewed", { scopeMatches: true, terminalVersion: 1, resultDigest: digest(fixture.a) });
  add("b-admitted", { scopeMatches: true, promptDigest: digest(fixture.bPrompt) });
  add("b-executed", { scopeMatches: true, promptDigest: digest(fixture.bPrompt), resultDigest: digest(fixture.b) });
  return { context, run, add, score: () => evaluate(context, run), get: (kind: Evidence["kind"]) => run.records.find(e => e.kind === kind)! };
}
function renumber(run: Run) { run.records.forEach((e, i) => { e.seq = i + 1; e.atMs = (i + 1) * 10; }); }
function statuses(report: ReturnType<typeof evaluate>) { return Object.values(report.capabilities).map(v => v.status); }
function expectInvalid(report: ReturnType<typeof evaluate>) {
  expect(report.validity).toBe("invalid");
  expect(statuses(report)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
  expect(report.followup.status).toBe("unknown");
  expect(report.actualHostAcceptance).toBe("unknown");
}

describe("issue #222 test-only receiver evidence", () => {
  it("demonstrates a controlled local fixture without claiming wake, review, B or host acceptance", async () => {
    const { report } = await localDemo();
    expect(report.validity).toBe("valid");
    expect(report.capabilities.Wake.status).toBe("unknown");
    expect(report.followup.status).toBe("unknown");
    expect(report.actualHostAcceptance).toBe("unknown");
    expect(report.counts).toMatchObject({ bAdmissions: 0, bExecutions: 0, reviewRecords: 0 });
  });
  it("requires separate departure observation while the fixture is held, and releases once", async () => {
    const f = trace(); f.run.records = [];
    const held = holdFixture(f.context, kind => f.add(kind));
    expect(() => held.release(undefined)).toThrow();
    let completed = false;
    const result = held.call().then(value => { completed = true; return value; });
    await held.started;
    expect(() => held.release(undefined)).toThrow();
    await Promise.resolve(); expect(completed).toBe(false);
    const departed = f.add("departure-observed");
    expect(() => held.release({ ...departed, runId: "old-run" })).toThrow();
    expect(() => held.release({ ...departed, provenance: "actual-chatgpt" })).toThrow();
    expect(() => held.release({ ...departed, success: false })).toThrow();
    held.release(departed);
    expect(await result).toEqual(fixture.a);
    expect(f.run.records.map(e => e.kind)).toEqual(["hold-started", "departure-observed", "release"]);
    expect(() => held.release(departed)).toThrow();
  });
  it.each(["synthetic-upstream", "local-browser", "actual-chatgpt"] as const)(
    "keeps %s assertions qualified; even fabricated actual labels cannot grant host acceptance", observation => {
      const f = trace(observation), report = f.score();
      expect(statuses(report)).toEqual(["pass", "pass", "pass", "pass"]);
      expect(report.capabilities.Wake.provenance).toBe(observation);
      expect(report.actualHostAcceptance).toBe("unknown");
      expect(report.execution).toBe("synthetic-upstream");
      expect(report.followup.status).toBe("pass");
      expect(report.modelContinuity).toBe("unknown"); expect(report.usageContinuity).toBe("unknown");
    });
  it.each(["hold-started", "departure-observed", "release", "terminal"] as const)("does not pass with missing %s", kind => {
    const f = trace(); f.run.records = f.run.records.filter(e => e.kind !== kind);
    expect(f.score().validity).toBe("invalid"); expect(statuses(f.score())).not.toContain("pass");
  });
  it.each([
    ["hold-started", false], ["hold-started", undefined], ["release", false], ["release", undefined]
  ] as const)("requires explicit %s success, not %s", (kind, success) => {
    const f = trace("local-browser"); f.get(kind).success = success;
    expectInvalid(f.score());
  });
  it.each(["positive", "failed", "missing-success", "synthetic"])("checks event surface/success: %s", mode => {
    const f = trace("local-browser"); f.run.route = f.context.route = "events";
    f.add("subscribe");
    const signal = f.add("signal", { eventId: "same-event", terminalVersion: 1, replay: true });
    if (mode === "failed") signal.success = false;
    if (mode === "missing-success") delete signal.success;
    if (mode === "synthetic") signal.provenance = "synthetic-upstream";
    if (mode !== "positive") expectInvalid(f.score());
    else {
      expect(f.score().validity).toBe("valid"); expect(f.score().followup.status).toBe("pass");
      expect(f.score().actualHostAcceptance).toBe("unknown");
    }
  });
  it.each([false, undefined])("requires explicit review scope proof, not %s", scopeMatches => {
    const f = trace("local-browser"); f.get("result-reviewed").scopeMatches = scopeMatches;
    expect(f.score().counts?.reviewRecords).toBe(0);
    expect(f.score().followup.status).toBe("fail");
  });
  it.each(["review", "review-wrong-scope", "approval", "approval-wrong-scope"])(
    "rejects success followed by same-target failure before B: %s", mode => {
      const f = trace("local-browser"), review = mode.startsWith("review");
      const original = f.get(review ? "result-reviewed" : "b-approved");
      const failure = { ...original, success: false };
      if (mode.endsWith("wrong-scope")) failure.scopeMatches = false;
      else delete failure.scopeMatches;
      f.run.records.splice(f.run.records.indexOf(original) + 1, 0, failure); renumber(f.run);
      expectInvalid(f.score());
    });
  it("keeps a failed-only review out of B eligibility", () => {
    const f = trace("local-browser"); f.get("result-reviewed").success = false;
    expect(f.score().validity).toBe("valid"); expect(f.score().counts?.reviewRecords).toBe(0);
    expect(f.score().followup.status).toBe("fail");
  });
  it.each(["review-digest", "review-version", "approval-prompt"])("limits contradictions to the same exact target: %s", mode => {
    const f = trace("local-browser"), approval = mode === "approval-prompt";
    const original = f.get(approval ? "b-approved" : "result-reviewed");
    const failure = { ...original, success: false };
    if (mode === "review-digest") failure.resultDigest = digest(fixture.b);
    if (mode === "review-version") failure.terminalVersion = 2;
    if (approval) failure.promptDigest = digest("other B prompt");
    f.run.records.splice(f.run.records.indexOf(original) + 1, 0, failure); renumber(f.run);
    expect(f.score().validity).toBe("valid"); expect(f.score().followup.status).toBe("pass");
    expect(f.score().actualHostAcceptance).toBe("unknown");
  });
  it("rejects completion before departure", () => {
    const f = trace(), t = f.get("terminal"), d = f.get("departure-observed");
    [t.kind, d.kind] = [d.kind, t.kind];
    expect(f.score().validity).toBe("invalid"); expect(statuses(f.score())).not.toContain("pass");
  });
  it.each(["old-run", "old-window", "contradictory-time", "duplicate-sequence", "duplicate-terminal", "wrong-job", "wrong-fixture", "secret-field", "foreign-context"])(
    "refuses invalid evidence: %s", mutation => {
      const f = trace();
      if (mutation === "old-run") f.get("result-read").runId = "previous-run";
      if (mutation === "old-window") f.get("departure-observed").atMs = -1;
      if (mutation === "contradictory-time") f.get("result-read").atMs = 1;
      if (mutation === "duplicate-sequence") f.get("result-read").seq = 1;
      if (mutation === "duplicate-terminal") f.add("terminal");
      if (mutation === "wrong-job") f.get("result-read").jobRef = "other-job";
      if (mutation === "wrong-fixture") (f.run as any).fixtureDigest = "0".repeat(64);
      if (mutation === "secret-field") (f.get("result-read") as any).rawSession = "must-not-be-output";
      if (mutation === "foreign-context") f.run.startedAtMs = 1;
      const report = f.score(); expect(report.validity).toBe("invalid"); expect(statuses(report)).not.toContain("pass");
      expect(report.followup.status).not.toBe("pass"); expect(JSON.stringify(report)).not.toContain("must-not-be-output");
    });
  it("does not merge synthetic proofs into local-browser evidence", () => {
    const f = trace("local-browser"); f.get("model-wake").provenance = "synthetic-upstream";
    expect(f.score().capabilities.Wake.status).toBe("unknown");
  });
  it("does not infer wake/review/authority from webhook ACK, UI mount, tool success or result offer", () => {
    const f = trace();
    f.run.records = f.run.records.filter(e => !["completion-observed", "model-wake", "chat-bound", "result-read", "result-reviewed", "b-admitted", "b-executed"].includes(e.kind));
    for (const kind of ["webhook-ack", "ui-mounted", "tool-call", "result-offered"] as const) f.add(kind);
    expect(statuses(f.score())).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(f.score().followup.status).toBe("unknown");
  });
  it("does not count an active-turn continuation as automatic wake", () => {
    const f = trace(); f.get("model-wake").automatic = false;
    expect(f.score().capabilities.Wake.status).toBe("unknown");
  });
  it.each(["wrong-scope", "wrong-digest", "wrong-version"])("rejects original authority mismatch: %s", mode => {
    const f = trace(), read = f.get("result-read");
    if (mode === "wrong-scope") read.scopeMatches = false;
    if (mode === "wrong-digest") read.resultDigest = digest(fixture.b);
    if (mode === "wrong-version") read.terminalVersion = 2;
    expect(f.score().capabilities.BindAuthority.status).toBe("fail"); expect(f.score().followup.status).toBe("fail");
  });
  it("separates visible Chat binding failure from exact authority", () => {
    const f = trace(); f.get("chat-bound").chatMatches = false;
    expect(f.score().capabilities.BindChat.status).toBe("fail");
    expect(f.score().capabilities.BindAuthority.status).toBe("pass");
    expect(f.score().followup.status).toBe("fail");
  });
  it.each(["approval", "review", "exact-prompt", "duplicate-admission", "duplicate-execution", "execution-before-admission"])(
    "does not promote an unsafe B trace: %s", mode => {
      const f = trace();
      if (mode === "approval") f.run.records = f.run.records.filter(e => e.kind !== "b-approved");
      if (mode === "review") f.run.records = f.run.records.filter(e => e.kind !== "result-reviewed");
      if (mode === "exact-prompt") f.get("b-admitted").promptDigest = digest("different B");
      if (mode === "duplicate-admission") f.add("b-admitted", { scopeMatches: true, promptDigest: digest(fixture.bPrompt) });
      if (mode === "duplicate-execution") f.add("b-executed", { scopeMatches: true, promptDigest: digest(fixture.bPrompt), resultDigest: digest(fixture.b) });
      if (mode === "execution-before-admission") {
        const admitted = f.get("b-admitted"), executed = f.get("b-executed");
        [admitted.kind, executed.kind] = ["b-executed", "b-admitted"];
      }
      expect(f.score().followup.status).toBe("fail");
    });
  it("deduplicates repeated signal identity without multiplying B admission/execution counts", () => {
    const f = trace();
    f.add("signal", { eventId: "event-a-v1", terminalVersion: 1 });
    f.add("signal", { eventId: "event-a-v1", terminalVersion: 1 });
    expect(f.score().counts).toMatchObject({ signalRecords: 2, uniqueSignals: 1, bAdmissions: 1, bExecutions: 1 });
  });
  it.each(["missing-subscribe", "missing-signal", "signal-before-subscribe", "unmarked-replay", "marked-replay", "early-signal"])(
    "checks terminal/subscription/replay ordering: %s", mode => {
      const f = trace(); f.run.route = f.context.route = "events";
      if (mode !== "missing-subscribe") f.add("subscribe");
      if (mode !== "missing-signal") f.add("signal", { eventId: "retained-a-v1", terminalVersion: 1, replay: mode === "marked-replay" });
      if (mode === "signal-before-subscribe") {
        const e = f.run.records.pop()!; f.run.records.splice(f.run.records.length - 1, 0, e); renumber(f.run);
      }
      if (mode === "early-signal") {
        const e = f.run.records.pop()!; f.run.records.splice(1, 0, e); renumber(f.run);
      }
      const report = f.score(); expect(report.validity).toBe(mode === "marked-replay" ? "valid" : "invalid");
      if (mode !== "marked-replay") expect(statuses(report)).not.toContain("pass");
      expect(report.actualHostAcceptance).toBe("unknown");
    });
});
