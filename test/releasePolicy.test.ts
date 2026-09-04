import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadReleaseManifest, validateReleaseManifest } from "../scripts/release-manifest.mjs";
import {
  deriveReleasePlan,
  deriveWorkflowContext,
  loadChangeFragments,
  prepareCandidate,
  prepareNextCandidate,
  promoteStable,
  resolvePolicyBranch,
  returnToDevelopment,
  validateBranchStage,
  validateChangeFragment
} from "../scripts/release-policy.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("release governance policy", () => {
  it("aggregates repository-owned fragments into the proposed 0.4.0-rc.1", () => {
    const manifest = loadReleaseManifest(REPO_ROOT);
    const fragments = loadChangeFragments(REPO_ROOT);

    expect(deriveReleasePlan(manifest, fragments)).toEqual({
      releaseUnitId: "codex-mcp-bridge",
      stage: "development",
      currentVersion: "0.3.0",
      bump: "minor",
      breaking: true,
      fragmentCount: 6,
      targetVersion: "0.4.0",
      candidateVersion: "0.4.0-rc.1",
      releaseBranch: "release/0.4.0"
    });
  });

  it("rejects malformed fragments and under-versioned breaking changes", () => {
    const base = {
      schemaVersion: 1,
      releaseUnitId: "codex-mcp-bridge",
      bump: "patch",
      summary: "A compatible fix.",
      breaking: false,
      migration: null
    };
    expect(validateChangeFragment(base)).toEqual(base);
    expect(() => validateChangeFragment({ ...base, bump: "feature" })).toThrow(/patch, minor, or major/);
    expect(() => validateChangeFragment({ ...base, unexpected: true })).toThrow(/keys must be exactly/);
    expect(() => validateChangeFragment({
      ...base,
      breaking: true,
      summary: "Changed the contract.",
      migration: "Update callers."
    })).toThrow(/must start with BREAKING/);

    const manifest = loadReleaseManifest(REPO_ROOT);
    expect(() => deriveReleasePlan(manifest, [{ ...base, breaking: true, summary: "BREAKING: API", migration: "Update." }]))
      .toThrow(/requires at least a minor bump/);
  });

  it("rejects branch, stage, version, and event combinations that bypass promotion", () => {
    expect(resolvePolicyBranch({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "release/0.4.0",
      GITHUB_REF_NAME: "17/merge"
    })).toBe("release/0.4.0");
    expect(resolvePolicyBranch({
      GITHUB_EVENT_NAME: "push",
      GITHUB_HEAD_REF: "",
      GITHUB_REF_NAME: "main"
    })).toBe("main");

    const development = loadReleaseManifest(REPO_ROOT);
    expect(validateBranchStage(development, "dev")).toMatchObject({ stage: "development" });
    expect(() => validateBranchStage(development, "main")).toThrow(/main requires stable/);

    const candidate = candidateManifest("0.4.0-rc.2");
    expect(validateReleaseManifest(candidate)).toBe(candidate);
    expect(validateBranchStage(candidate, "release/0.4.0")).toMatchObject({ stage: "candidate" });
    expect(() => validateBranchStage(candidate, "release/0.5.0")).toThrow(/does not match/);
    expect(() => deriveWorkflowContext(candidate, { eventName: "push", refName: "release/0.4.0" }))
      .toThrow(/Stable release runs require|Manual release runs require|allowed only/);
    expect(deriveWorkflowContext(candidate, {
      eventName: "workflow_dispatch",
      refName: "release/0.4.0"
    })).toMatchObject({ mode: "candidate", prerelease: true, publish: true });
    expect(deriveWorkflowContext(candidate, releasePullRequestInput())).toMatchObject({
      mode: "candidate-pr",
      stage: "candidate",
      prerelease: true,
      publish: false,
      refName: "release/0.4.0",
      baseRef: "main"
    });
    expect(() => deriveWorkflowContext(candidate, {
      ...releasePullRequestInput(),
      baseRef: "dev"
    })).toThrow(/must target main/);
    expect(() => deriveWorkflowContext(candidate, {
      ...releasePullRequestInput(),
      headRef: "feature/not-a-release"
    })).toThrow(/must originate from release\/X\.Y\.Z/);
    expect(() => deriveWorkflowContext(candidate, {
      ...releasePullRequestInput(),
      headRepository: "someone/codex-mcp-bridge-for-chatgpt"
    })).toThrow(/same repository/);
    expect(() => deriveReleasePlan(candidate, [{
      schemaVersion: 1,
      releaseUnitId: "codex-mcp-bridge",
      bump: "patch",
      summary: "Late compatible fix.",
      breaking: false,
      migration: null
    }])).toThrow(/now target 0\.3\.1, not 0\.4\.0/);

    const stable = stableManifest("0.4.0", "0.4.0-rc.2");
    expect(validateReleaseManifest(stable)).toBe(stable);
    expect(deriveWorkflowContext(stable, { eventName: "push", refName: "main" }))
      .toMatchObject({ mode: "stable", prerelease: false, publish: true });
    expect(deriveWorkflowContext(stable, releasePullRequestInput())).toMatchObject({
      mode: "stable-pr",
      stage: "stable",
      prerelease: false,
      publish: false
    });
    expect(() => deriveWorkflowContext(stable, { eventName: "workflow_dispatch", refName: "main" }))
      .toThrow(/Manual release runs require/);

    stable.release.sourceCandidate = "0.4.1-rc.1";
    expect(() => validateReleaseManifest(stable)).toThrow(/same numeric version/);
    stable.release.sourceCandidate = "0.4.0-rc.2";
    stable.release.sourceVersion = "0.5.0";
    expect(() => validateReleaseManifest(stable)).toThrow(/must precede/);
    candidate.release.version = "0.4.0-beta.1";
    expect(() => validateReleaseManifest(candidate)).toThrow(/X\.Y\.Z-rc\.N/);
  });

  it("prepares, increments, promotes, consumes fragments, and returns to development", () => {
    const root = fixtureRoot();
    expect(prepareCandidate(root, "release/0.4.0")).toMatchObject({
      version: "0.4.0-rc.1",
      stage: "candidate",
      channel: "prerelease"
    });
    expect(prepareNextCandidate(root, "release/0.4.0")).toMatchObject({ version: "0.4.0-rc.2" });
    expect(promoteStable(root, "release/0.4.0")).toMatchObject({
      version: "0.4.0",
      stage: "stable",
      sourceCandidate: "0.4.0-rc.2",
      consumedFragments: ["change.json"]
    });
    expect(existsSync(path.join(root, ".changes/change.json"))).toBe(false);
    expect(returnToDevelopment(root, "dev")).toMatchObject({
      version: "0.4.0",
      stage: "development",
      channel: "none",
      sourceCandidate: null
    });
  });
});

function candidateManifest(version: string): any {
  const manifest = structuredClone(loadReleaseManifest(REPO_ROOT));
  manifest.release.version = version;
  manifest.release.stage = "candidate";
  manifest.release.channel = "prerelease";
  manifest.release.sourceVersion = "0.3.0";
  manifest.release.sourceCandidate = null;
  return manifest;
}

function stableManifest(version: string, sourceCandidate: string): any {
  const manifest = structuredClone(loadReleaseManifest(REPO_ROOT));
  manifest.release.version = version;
  manifest.release.stage = "stable";
  manifest.release.channel = "stable";
  manifest.release.sourceVersion = "0.3.0";
  manifest.release.sourceCandidate = sourceCandidate;
  return manifest;
}

function releasePullRequestInput(): any {
  return {
    eventName: "pull_request",
    refName: "17/merge",
    headRef: "release/0.4.0",
    baseRef: "main",
    repository: "menaje/codex-mcp-bridge-for-chatgpt",
    headRepository: "menaje/codex-mcp-bridge-for-chatgpt"
  };
}

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-release-policy-"));
  mkdirSync(path.join(root, ".changes"));
  writeJson(path.join(root, "release-manifest.json"), loadReleaseManifest(REPO_ROOT));
  copyFileSync(
    path.join(REPO_ROOT, "app-server-schema.lock.json"),
    path.join(root, "app-server-schema.lock.json")
  );
  writeJson(path.join(root, "package.json"), {
    name: "codex-mcp-bridge-for-chatgpt",
    version: "0.3.0",
    type: "module"
  });
  writeJson(path.join(root, "package-lock.json"), {
    name: "codex-mcp-bridge-for-chatgpt",
    version: "0.3.0",
    lockfileVersion: 3,
    packages: { "": { name: "codex-mcp-bridge-for-chatgpt", version: "0.3.0" } }
  });
  writeJson(path.join(root, ".changes/change.json"), {
    schemaVersion: 1,
    releaseUnitId: "codex-mcp-bridge",
    bump: "minor",
    summary: "BREAKING: Add the native app release unit.",
    breaking: true,
    migration: "Existing npm users can keep their current launch flow."
  });
  return root;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
