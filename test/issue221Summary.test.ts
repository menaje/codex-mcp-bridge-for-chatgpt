import { describe, expect, it } from "vitest";
import { validateModelVisibleStructuredOutput } from "../src/tools.js";
import { statusAction } from "../src/nextActions.js";

const jobId = "00000000-0000-4000-8000-000000000221";
const otherJobId = "00000000-0000-4000-8000-000000000222";
const retrieval = (id = jobId) => statusAction({ query: { kind: "job", id } }, "Read the exact result.");
function summary(kind = "overview", actions: unknown[] = [retrieval()]) {
  return {
    kind, scope: { mode: "scoped" },
    counts: { sessions: 0, jobs: 1, runningJobs: 0, activities: 0, agents: 0, orphanedAgents: 0 },
    items: [{ type: "job", id: jobId, state: "completed", result: { availability: "delivered", omitted: false }, nextActions: actions }],
    warnings: []
  };
}
const validate = (value: unknown) => validateModelVisibleStructuredOutput("codex_status", value);

describe("#221 exact result actions in summaries", () => {
  it.each(["overview", "page", "activity", "thread"])("accepts structural actions and JSON roundtrips in %s", kind => {
    const value = summary(kind);
    expect(() => validate(value)).not.toThrow();
    expect(() => validate(JSON.parse(JSON.stringify(value)))).not.toThrow();
  });
  it.each([
    [],
    [retrieval(otherJobId)],
    [statusAction({ query: { kind: "activity", id: jobId } })],
    [{ kind: "tool", tool: "codex_models", arguments: {} }],
    [{ kind: "guidance", message: "Retrieve the answer." }]
  ].map(actions => [actions]))("rejects missing or unrelated retrieval actions: %j", actions => {
    expect(() => validate(summary("overview", actions))).toThrow();
  });
  it("requires each delivered Job's own action", () => {
    const value = summary();
    value.items.push({ ...value.items[0]!, id: otherJobId });
    expect(() => validate(value)).toThrow(/exact-Job/);
    value.items[1]!.nextActions = [retrieval(otherJobId)];
    expect(() => validate(value)).not.toThrow();
  });
  it.each(["running", "failed", "cancelled", "completed"])("does not require delivered-result actions for %s without an available result", state => {
    const value = summary("overview", []);
    value.items[0]!.state = state;
    value.items[0]!.result.availability = state === "running" ? "pending" : "unavailable";
    expect(() => validate(value)).not.toThrow();
  });
  it("keeps original answer bodies exclusively in exact Job reads", () => {
    const value = summary();
    const item = { ...value.items[0]!, answer: "Original answer." };
    expect(() => validate({ ...value, items: [item] })).toThrow(/cannot embed/);
    expect(() => validate({ ...value, kind: "job", items: [item] })).not.toThrow();
  });
});
