import { projectNameKey, type ProjectRegistry, type ProjectTarget } from "./projectRegistry.js";

/** A public identity only: never recover a known reference by a different name match. */
export type RequestedProjectIdentity = { name: string; projectRef?: string };

export function projectSelectorRetryAction(project: ProjectTarget): string {
  const selector = { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision };
  return `Retry this same codex_task with project=${JSON.stringify(selector)} and a new requestId. No connection Refresh is required.`;
}

export function projectRecoveryGuidance(
  registry: ProjectRegistry,
  requested: RequestedProjectIdentity | undefined,
  lookupAction: (names: string[], remaining: number) => string
): string[] {
  const registered = registry.projects;
  if (!registered.length) {
    return ['Open settings with codex_settings({}) so the user can register the project folder for this work. Then repeat the project lookup.'];
  }
  const selectable = registry.selectableProjects;
  if (requested) {
    const matches = registered.filter(project => requested.projectRef !== undefined
      ? project.projectRef === requested.projectRef
      : project.nameKey === projectNameKey(requested.name));
    const exact = selectable.find(project => matches.some(match => match.projectRef === project.projectRef));
    if (exact) return [projectSelectorRetryAction(exact)];
    const identity = JSON.stringify({ name: requested.name, ...(requested.projectRef ? { projectRef: requested.projectRef } : {}) });
    if (!matches.length) {
      return [`The requested project ${identity} is not registered. Confirm the intended project with the user before choosing another registration. Open codex_settings({}) only if they need to register or repair it.`];
    }
    if (matches.every(project => project.archivedAt !== undefined)) {
      return [`Open codex_settings({}) so the user can restore the intended archived registration for ${identity}. Then repeat the lookup for that project; do not substitute another project.`];
    }
    return [`Open codex_settings({}) so the user can repair the unavailable folder for ${identity}. Then repeat the lookup for that project; do not substitute another project.`];
  }
  if (registered.every(project => project.archivedAt !== undefined)) {
    return ['All registered projects are archived. Open codex_settings({}) so the user can restore the intended existing registration, then look up that project.'];
  }
  if (!selectable.length) {
    return ['No active project folder is available. Open codex_settings({}) so the user can repair the intended registered project, then look it up again.'];
  }
  const names = selectable.slice(0, 8).map(project => project.name);
  return [lookupAction(names, selectable.length - names.length)];
}
