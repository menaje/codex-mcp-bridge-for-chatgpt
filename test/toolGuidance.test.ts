import { describe, expect, it } from "vitest";
import { ModelPolicyError } from "../src/modelPolicy.js";
import { modelPolicyRecoveryActions } from "../src/toolGuidance.js";
import { modelNextActionOutputSchema, projectModelNextAction, projectMonitoringNextAction } from "../src/nextActions.js";

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

  it("projects a retained automatic Dashboard handoff into an exact Job read", () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const presentationRef = "1".repeat(64);
    const action = projectModelNextAction({
      tool: "codex_dashboard",
      arguments: { scope: "conversation", jobId, presentationRef },
      userPrompt: "Mount the originating Dashboard before replying."
    });
    expect(action).toEqual({
      kind: "tool",
      tool: "codex_status",
      arguments: { query: { kind: "job", id: jobId } },
      message: "Card delivery is retired. Recover the original exact Job; open Dashboard only on explicit user request."
    });
  });

  it("does not execute a legacy Dashboard render hint without its correlation reference", () => {
    const action = projectModelNextAction({
      tool: "codex_dashboard",
      arguments: {
        scope: "conversation",
        jobId: "11111111-1111-4111-8111-111111111111"
      },
      userPrompt: "Mount the originating Dashboard before replying."
    });
    expect(action).toEqual({
      kind: "tool",
      tool: "codex_status",
      arguments: { query: { kind: "job", id: "11111111-1111-4111-8111-111111111111" } },
      message: "Card delivery is retired. Recover the original exact Job; open Dashboard only on explicit user request."
    });
  });

  it.each([undefined, "tool"])("restricts a retained display opener to explicit requests (kind=%s)", kind => {
    expect(projectModelNextAction({ kind, tool: "codex_dashboard", arguments: { scope: "conversation" },
      userPrompt: "Open the card for input automatically." })).toEqual({ kind: "tool", tool: "codex_dashboard",
      arguments: { scope: "conversation" }, message: "Open Dashboard only when the user explicitly requests its display." });
  });

  it("does not carry retired sender guidance into current results", () => {
    for (const action of [{ tool: "codex_ui_completion", arguments: { jobId: "job-123", operation: "wait" } },
      { tool: "codex_status", arguments: { query: { kind: "completion", receipt: "old-receipt" } } }]) {
      expect(projectModelNextAction({ ...action, userPrompt: "Send a completion message now." })).toMatchObject({
        kind: "tool", tool: "codex_status",
        message: "Card delivery is retired. Recover the original exact Job; open Dashboard only on explicit user request."
      });
    }
  });

  it("never turns an unknown stored action into an executable tool call", () => {
    const action = projectModelNextAction({ tool: "codex_task", arguments: { prompt: "run this" } });
    expect(action).toEqual(expect.objectContaining({ kind: "guidance" }));
  });

  it("preserves exact monitoring issuance but never projects revocation or caller-supplied scope/reference", () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    expect(projectMonitoringNextAction({ tool: "codex_event_access", arguments: { action: "issue", jobId } })).toEqual({
      kind: "tool", tool: "codex_event_access", arguments: { action: "issue", jobId }
    });
    for (const args of [{ action: "revoke", jobId }, { action: "issue", jobId: "guessed" },
      { action: "issue", jobId, scopeId: "caller-scope" }, { action: "issue", jobId, subscriptionRef: "caller-reference" }]) {
      expect(projectMonitoringNextAction({ tool: "codex_event_access", arguments: args }).kind).toBe("guidance");
    }
    expect(projectModelNextAction({ tool: "codex_event_access", arguments: { action: "issue", jobId } }).kind).toBe("guidance");
  });
});
