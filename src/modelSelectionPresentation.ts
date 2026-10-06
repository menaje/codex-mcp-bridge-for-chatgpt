import type { ModelChoice } from "./modelPolicy.js";

/** The editor projects user choices onto supported pairs; execution still stores exact pairs. */
export function projectModelChoices(models: string[], efforts: string[], choices: ModelChoice[]): ModelChoice[] {
  const selectedModels = new Set(models), selectedEfforts = new Set(efforts);
  return choices.filter(choice => selectedModels.has(choice.model) && selectedEfforts.has(choice.reasoningEffort));
}

export function availableCommonEfforts(models: string[], choices: ModelChoice[]): string[] {
  const values = new Set(choices.filter(choice => models.includes(choice.model)).map(choice => choice.reasoningEffort));
  const known = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  return [...known.filter(effort => values.has(effort)), ...[...values].filter(effort => !known.includes(effort)).sort()];
}

export function unsupportedModelEfforts(models: string[], efforts: string[], catalogChoices: ModelChoice[]) {
  return models.flatMap(model => {
    const supported = new Set(catalogChoices.filter(choice => choice.model === model).map(choice => choice.reasoningEffort));
    const unsupported = efforts.filter(effort => !supported.has(effort));
    return unsupported.length ? [{ model, efforts: unsupported }] : [];
  });
}

export function orderedModelIDs(catalog: string[], retained: string[]): string[] {
  const visible = [...new Set(catalog)], known = new Set(visible);
  return [...visible, ...[...new Set(retained)].filter(id => !known.has(id)).sort()];
}
