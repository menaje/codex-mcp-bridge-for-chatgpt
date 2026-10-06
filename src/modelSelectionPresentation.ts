import type { ModelChoice } from "./modelPolicy.js";

/** The editor projects user choices onto supported pairs; execution still stores exact pairs. */
export function projectModelChoices(models: string[], efforts: string[], choices: ModelChoice[]): ModelChoice[] {
  const selectedModels = new Set(models), selectedEfforts = new Set(efforts);
  return choices.filter(choice => selectedModels.has(choice.model) && selectedEfforts.has(choice.reasoningEffort));
}

export function commonEffortState(models: string[], effort: string, choices: ModelChoice[], selected: ModelChoice[]) {
  const candidates = choices.filter(choice => models.includes(choice.model) && choice.reasoningEffort === effort);
  const keys = new Set(selected.map(choice => JSON.stringify([choice.model, choice.reasoningEffort])));
  const count = candidates.filter(choice => keys.has(JSON.stringify([choice.model, choice.reasoningEffort]))).length;
  return { checked: candidates.length > 0 && count === candidates.length,
    mixed: count > 0 && count < candidates.length, supportedModels: new Set(candidates.map(choice => choice.model)).size };
}

export function orderedModelIDs(catalog: string[], retained: string[]): string[] {
  const visible = [...new Set(catalog)], known = new Set(visible);
  return [...visible, ...[...new Set(retained)].filter(id => !known.has(id)).sort()];
}
