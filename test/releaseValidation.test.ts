import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  affectedValidationPlan,
  classifyChangedPaths,
  collectChangedPaths
} from "../scripts/release-validation.mjs";

const repositories: string[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true });
});

function git(repository: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=Release validation test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repository, stdio: "pipe" });
}

function repositoryWithBaseline() {
  const repository = mkdtempSync(path.join(tmpdir(), "bridge-validation-"));
  repositories.push(repository);
  git(repository, "init", "--initial-branch=dev");
  for (const file of ["src/removed.ts", "macos/Sources/Removed.swift", "docs/kept.md"]) {
    mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
    writeFileSync(path.join(repository, file), `Tracked baseline: ${file}\n`);
  }
  git(repository, "add", ".");
  git(repository, "commit", "-m", "Baseline");
  git(repository, "branch", "baseline");
  return repository;
}

describe("release validation levels", () => {
  it("keeps documentation and change fragments on the fast validation level", () => {
    expect(classifyChangedPaths(["README.md", ".changes/fix.json"])).toEqual({
      node: false,
      macos: false
    });
    expect(affectedValidationPlan(["docs/releasing.md"]).commands).toHaveLength(1);
  });

  it("routes Node and Swift-owned paths to their affected checks", () => {
    expect(classifyChangedPaths(["src/server.ts"])).toEqual({ node: true, macos: false });
    expect(classifyChangedPaths(["src/macosHelperServer.ts"]))
      .toEqual({ node: true, macos: true });
    expect(classifyChangedPaths(["macos/Sources/App.swift"])).toEqual({ node: false, macos: true });
    expect(classifyChangedPaths(["release-manifest.json"])).toEqual({ node: true, macos: true });

    const plan = affectedValidationPlan(["src/server.ts", "macos/Sources/App.swift"]);
    expect(plan.commands).toEqual([
      ["npm", ["run", "validate:fast"]],
      ["npm", ["run", "check"]],
      ["npm", ["run", "macos:check"]]
    ]);
  });

  it.each(["working tree", "index", "commit"])("validates source deletions in the %s", (stage) => {
    const repository = repositoryWithBaseline();
    for (const file of ["src/removed.ts", "macos/Sources/Removed.swift"]) rmSync(path.join(repository, file));
    if (stage !== "working tree") git(repository, "add", "-u");
    if (stage === "commit") git(repository, "commit", "-m", "Remove source files");
    const changed = collectChangedPaths(repository, "baseline");
    expect(changed).toEqual(["macos/Sources/Removed.swift", "src/removed.ts"]);
    expect(classifyChangedPaths(changed)).toEqual({ node: true, macos: true });
  });

  it("validates both sides when source is renamed into documentation", () => {
    const repository = repositoryWithBaseline();
    renameSync(path.join(repository, "src/removed.ts"), path.join(repository, "docs/archived.ts"));
    git(repository, "add", "-A");
    git(repository, "commit", "-m", "Archive source");
    const changed = collectChangedPaths(repository, "baseline");
    expect(changed).toEqual(["docs/archived.ts", "src/removed.ts"]);
    expect(classifyChangedPaths(changed).node).toBe(true);
  });

  it("keeps quoted and newline-containing Git paths intact", () => {
    const repository = repositoryWithBaseline();
    const unusualPath = 'src/quoted "module"\n.ts';
    writeFileSync(path.join(repository, unusualPath), "export {};\n");
    git(repository, "add", "-A");
    expect(collectChangedPaths(repository, "baseline")).toEqual([unusualPath]);
  });

  it("reports a missing comparison base instead of skipping committed changes", () => {
    const repository = repositoryWithBaseline();
    expect(() => collectChangedPaths(repository, "missing-base")).toThrow(/comparison base.*missing-base/i);
  });
});
