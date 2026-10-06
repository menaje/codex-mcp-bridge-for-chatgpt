import { describe, expect, it } from "vitest";
import { availableCommonEfforts, orderedModelIDs, projectModelChoices, unsupportedModelEfforts } from "../src/modelSelectionPresentation.js";
import { serializeUiFunction } from "../src/uiFunctionSerialization.js";

const choices = [
  { model: "new", reasoningEffort: "low" }, { model: "new", reasoningEffort: "high" },
  { model: "new", reasoningEffort: "ultra" }, { model: "older", reasoningEffort: "low" },
  { model: "older", reasoningEffort: "high" }
];

describe("model selection presentation", () => {
  it("uses one common effort list and projects only supported pairs", () => {
    const saved = [choices[1]!, choices[3]!];
    const efforts = [...new Set(saved.map(choice => choice.reasoningEffort))];
    expect(projectModelChoices(["new", "older"], efforts, choices)).toEqual([choices[0], choices[1], choices[3], choices[4]]);
    expect(projectModelChoices(["new", "older"], ["high", "ultra"], choices)).toEqual([choices[1], choices[2], choices[4]]);
  });

  it("hides reasoning levels unsupported by every selected model and groups exclusions by model", () => {
    expect(availableCommonEfforts(["older"], choices)).toEqual(["low", "high"]);
    expect(availableCommonEfforts([], choices)).toEqual([]);
    expect(availableCommonEfforts(["new", "older"], choices)).toEqual(["low", "high", "ultra"]);
    expect(unsupportedModelEfforts(["new", "older"], ["high", "ultra"], choices))
      .toEqual([{ model: "older", efforts: ["ultra"] }]);
    // Availability restrictions do not falsely describe supported efforts as absent from the catalog.
    const operatorChoices = choices.filter(choice => choice.reasoningEffort !== "ultra");
    expect(availableCommonEfforts(["new"], operatorChoices)).not.toContain("ultra");
    expect(unsupportedModelEfforts(["new"], ["ultra"], choices)).toEqual([]);
  });

  it("keeps catalog order, de-duplicates it, and appends removed descriptions", () => {
    expect(orderedModelIDs(["gpt-6.1", "gpt-6", "gpt-5.6", "gpt-6"], ["gpt-5.6", "retired-b", "retired-a"]))
      .toEqual(["gpt-6.1", "gpt-6", "gpt-5.6", "retired-a", "retired-b"]);
  });

  it("retains standalone functions when shipped inside a cached card", () => {
    const project = new Function(`${serializeUiFunction(projectModelChoices)};return projectModelChoices;`)();
    const available = new Function(`${serializeUiFunction(availableCommonEfforts)};return availableCommonEfforts;`)();
    const exclusions = new Function(`${serializeUiFunction(unsupportedModelEfforts)};return unsupportedModelEfforts;`)();
    const order = new Function(`${serializeUiFunction(orderedModelIDs)};return orderedModelIDs;`)();
    expect(project(["older"], ["high", "ultra"], choices)).toEqual([choices[4]]);
    expect(available(["older"], choices)).toEqual(["low", "high"]);
    expect(exclusions(["older"], ["high", "ultra"], choices)).toEqual([{ model: "older", efforts: ["ultra"] }]);
    expect(order(["new", "older"], ["removed"])).toEqual(["new", "older", "removed"]);
  });
});
