import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

const sourceRuntimeScenarios = new Set([
  "execution-recovery", "observation-faults", "retention-and-ack"
]);
const bundledRuntimeScenarios = new Set([
  "bundled-execution-recovery", "bundled-observation-faults", "bundled-retention-and-ack"
]);

/** Reserve one run directory before any result or log can be written. */
export function reserveValidationOutput(root, stage, requestedDirectory, now = new Date()) {
  if (requestedDirectory !== undefined) {
    const output = path.resolve(requestedDirectory);
    mkdirSync(path.dirname(output), { recursive: true });
    try {
      mkdirSync(output, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(
          `VALIDATION_OUTPUT_EXISTS: Choose a new --output-dir; previous evidence was not modified: ${output}`
        );
      }
      throw error;
    }
    return output;
  }
  const parent = path.join(root, "output", "issue-198");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, `${stage}-${now.toISOString().replaceAll(":", "-")}-`));
}

/** Only a checked installed bundle may select product code outside this checkout. */
export function validationChildEnvironment({
  stage, parent, extra = {}, usePinnedCodexCli = false, bundleDist, verifiedBundleDist
}) {
  const environment = { ...parent, ...extra };
  delete environment.CODEX_TEST_BUNDLE_DIST;
  if (!usePinnedCodexCli) delete environment.CODEX_MCP_BRIDGE_CODEX;
  if (bundleDist !== undefined) {
    if (stage !== "installed" || verifiedBundleDist === undefined ||
        path.resolve(bundleDist) !== path.resolve(verifiedBundleDist)) {
      throw new Error("VALIDATION_BUNDLE_UNVERIFIED: A scenario selected an unverified bundle.");
    }
    environment.CODEX_TEST_BUNDLE_DIST = verifiedBundleDist;
  }
  return environment;
}

/** Product regressions must report the code they actually loaded. */
export function scenarioRuntimeEvidence(stage, scenarioId, observed, verifiedBundleDist) {
  const expected = stage === "integrated" && sourceRuntimeScenarios.has(scenarioId)
    ? "source"
    : stage === "installed" && bundledRuntimeScenarios.has(scenarioId)
      ? verifiedBundleDist ?? null
      : undefined;
  if (expected === undefined) return undefined;
  const actual = typeof observed?.runtime === "string" ? observed.runtime : null;
  return { expected, actual, matches: expected !== null && actual === expected };
}

export function scenarioPassed({ exitCode, timedOut, spawnError, logError, executionTarget }) {
  return exitCode === 0 && !timedOut && !spawnError && !logError &&
    (executionTarget?.matches ?? true);
}
