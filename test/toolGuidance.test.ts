import { describe, expect, it } from "vitest";
import { ModelPolicyError } from "../src/modelPolicy.js";
import { modelPolicyRecoveryActions } from "../src/toolGuidance.js";
import { modelNextActionOutputSchema, projectModelNextAction } from "../src/nextActions.js";

describe("current model recovery contract", () => {
  it("emits only validated non-mutating next actions", () => {
    const actions = modelPolicyRecoveryActions(new ModelPolicyError(
      "MODEL_UNAVAILABLE",
      "The selected model is unavailable.",
      4,
      ["Refresh models before retrying."]
    ));

    expect(actions).toHaveLength(3);
    expect(actions.map((action) => modelNextActionOutputSchema.parse(action))).toEqual(actions);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", tool: "codex_models", arguments: { refresh: true } }),
      expect.objectContaining({ kind: "tool", tool: "codex_settings" })
    ]));
  });

  it("turns persisted destructive legacy hints into an inspection action", () => {
    const action = projectModelNextAction({
      tool: "codex_cancel",
      arguments: { jobId: "job-123" },
      userPrompt: "Stop the old job"
    });
    expect(action).toEqual({
      kind: "tool",
      tool: "codex_status",
      arguments: { query: { kind: "job", id: "job-123" } },
      message: "Inspect the current target before deciding whether an explicit stop is still authorized."
    });
  });

  it("retains a scoped Dashboard render action for a background job", () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const action = projectModelNextAction({
      tool: "codex_dashboard",
      arguments: { scope: "conversation", backgroundJobId: jobId },
      userPrompt: "Mount the originating background Dashboard before replying."
    });
    expect(action).toEqual({
      kind: "tool",
      tool: "codex_dashboard",
      arguments: { scope: "conversation", backgroundJobId: jobId },
      message: "Mount the originating background Dashboard before replying."
    });
  });

  it("never turns an unknown stored action into an executable tool call", () => {
    const action = projectModelNextAction({ tool: "codex_task", arguments: { prompt: "run this" } });
    expect(action).toEqual(expect.objectContaining({ kind: "guidance" }));
  });
});
