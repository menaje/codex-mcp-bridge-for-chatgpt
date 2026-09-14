import { projectNameKey, type ProjectRegistry, type ProjectTarget } from "./projectRegistry.js";
import { guidance, settingsAction, type ModelNextAction } from "./nextActions.js";

/** A public identity only: never recover a known reference by a different name match. */
export type RequestedProjectIdentity = { name: string; projectRef?: string };

export function projectSelectorRetryAction(project: ProjectTarget): ModelNextAction {
  const selector = { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision };
  return guidance(`Retry codex_task with project=${JSON.stringify(selector)} and a new requestId.`);
}

export function projectRecoveryGuidance(
  registry: ProjectRegistry,
  requested: RequestedProjectIdentity | undefined,
  lookupAction: (names: string[], remaining: number) => ModelNextAction
): ModelNextAction[] {
  const registered = registry.projects;
  if (!registered.length) {
    return [settingsAction("The user can register the project folder for this work, then repeat the project lookup.")];
  }
  const selectable = registry.selectableProjects;
  if (requested) {
    const matches = registered.filter(project => requested.projectRef !== undefined
      ? project.projectRef === requested.projectRef
      : project.nameKey === projectNameKey(requested.name));
    const exact = selectable.find(project => matches.some(match => match.projectRef === project.projectRef));
    if (exact) return [projectSelectorRetryAction(exact)];
    const identity = JSON.stringify({ name: requested.name, ...(requested.projectRef ? { projectRef: requested.projectRef } : {}) });
    if (!matches.length) return [guidance(`The requested project ${identity} is not registered. Confirm the intended project with the user before choosing another registration.`)];
    if (matches.every(project => project.archivedAt !== undefined)) {
      return [settingsAction(`The user can restore the intended archived registration for ${identity}, then repeat the lookup for that project. Do not substitute another project.`)];
    }
    return [settingsAction(`The user can repair the unavailable folder for ${identity}, then repeat the lookup for that project. Do not substitute another project.`)];
  }
  if (registered.every(project => project.archivedAt !== undefined)) {
    return [settingsAction("All registered projects are archived. The user can restore the intended existing registration, then look up that project.")];
  }
  if (!selectable.length) {
    return [settingsAction("No active project folder is available. The user can repair the intended registered project, then look it up again.")];
  }
  const names = selectable.slice(0, 8).map(project => project.name);
  return [lookupAction(names, selectable.length - names.length)];
}
