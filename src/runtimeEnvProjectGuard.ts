import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { isPathWithinRoot } from "./config.js";

export const RUNTIME_ENV_PROJECT_CONFLICT = "RUNTIME_ENV_PROJECT_CONFLICT";

/**
 * Runtime credentials must stay outside every registered work folder so a
 * Codex task can never read or modify them through project-scoped access.
 */
export function assertRuntimeEnvOutsideProjectRoots(
  envFile: string,
  projectRoots: readonly string[]
): void {
  const candidate = canonicalPotentialPath(envFile);
  for (const projectRoot of projectRoots) {
    const canonicalRoot = canonicalPotentialPath(projectRoot);
    if (isPathWithinRoot(candidate, canonicalRoot)) {
      throw new Error(
        `${RUNTIME_ENV_PROJECT_CONFLICT}: Move the runtime .env outside all registered project folders.`
      );
    }
  }
}

function canonicalPotentialPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  let existingAncestor = resolved;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return resolved;
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync.native(existingAncestor);
  const remainder = path.relative(existingAncestor, resolved);
  return remainder ? path.join(canonicalAncestor, remainder) : canonicalAncestor;
}
