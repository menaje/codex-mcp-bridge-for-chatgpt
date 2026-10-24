import { describe, expect, it } from "vitest";
import { ModelPolicyError } from "../src/modelPolicy.js";
import { modelPolicyRecoveryActions } from "../src/toolGuidance.js";

describe("model policy recovery actions", () => {
  it("uses only the current structured action contract", () => {
    const actions = modelPolicyRecoveryActions(new ModelPolicyError(
      "MODEL_UNAVAILABLE",
      "The selected model is unavailable.",
      4,
      ["Refresh models before retrying."]
    ));

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", tool: "codex_models" })
    ]));
    expect(actions.every(action => action.kind === "guidance" ||
      ["codex_models", "codex_settings", "codex_status"].includes(action.tool))).toBe(true);
  });
});
