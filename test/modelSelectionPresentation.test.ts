import { describe, expect, it } from "vitest";
import { commonEffortState, orderedModelIDs, projectModelChoices } from "../src/modelSelectionPresentation.js";
import { serializeUiFunction } from "../src/uiFunctionSerialization.js";

const choices = [
  { model: "new", reasoningEffort: "low" }, { model: "new", reasoningEffort: "high" },
  { model: "new", reasoningEffort: "ultra" }, { model: "older", reasoningEffort: "low" },
  { model: "older", reasoningEffort: "high" }
];

describe("model selection presentation", () => {
  it("expands only supported pairs and distinguishes partial saved choices without changing them", () => {
    const saved = [choices[1]!, choices[3]!];
    expect(commonEffortState(["new", "older"], "high", choices, saved)).toEqual({ checked: false, mixed: true, supportedModels: 2 });
    expect(saved).toEqual([choices[1], choices[3]]);
    const projected = projectModelChoices(["new", "older"], ["high", "ultra"], choices);
    expect(projected).toEqual([choices[1], choices[2], choices[4]]);
    expect(commonEffortState(["new", "older"], "ultra", choices, projected)).toEqual({ checked: true, mixed: false, supportedModels: 1 });
  });

  it("keeps catalog order, de-duplicates it, and appends removed descriptions", () => {
    expect(orderedModelIDs(["gpt-6.1", "gpt-6", "gpt-5.6", "gpt-6"], ["gpt-5.6", "retired-b", "retired-a"]))
      .toEqual(["gpt-6.1", "gpt-6", "gpt-5.6", "retired-a", "retired-b"]);
  });

  it("retains standalone functions when shipped inside a cached card", () => {
    const project = new Function(`${serializeUiFunction(projectModelChoices)};return projectModelChoices;`)();
    const state = new Function(`${serializeUiFunction(commonEffortState)};return commonEffortState;`)();
    const order = new Function(`${serializeUiFunction(orderedModelIDs)};return orderedModelIDs;`)();
    expect(project(["older"], ["high", "ultra"], choices)).toEqual([choices[4]]);
    expect(state(["new", "older"], "high", choices, [choices[1]]).mixed).toBe(true);
    expect(order(["new", "older"], ["removed"])).toEqual(["new", "older", "removed"]);
  });
});
