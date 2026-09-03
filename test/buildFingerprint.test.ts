import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasTrackedSourceChanges } from "../scripts/build-fingerprint.mjs";

describe("build provenance worktree state", () => {
  it("ignores untracked user files but detects tracked source changes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-build-dirty-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Test"]);
    writeFileSync(path.join(root, "tracked.txt"), "initial\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "initial"]);

    writeFileSync(path.join(root, "untracked.txt"), "local only\n");
    expect(hasTrackedSourceChanges(root)).toBe(false);

    writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    expect(hasTrackedSourceChanges(root)).toBe(true);
  });
});

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}
