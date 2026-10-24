import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  reserveValidationOutput, scenarioPassed, scenarioRuntimeEvidence,
  validationChildEnvironment
} from "../scripts/issue-198-validation-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("#198 validation evidence boundaries", () => {
  it("keeps a parent bundle selector out of source checks and injects only the verified installed runtime", () => {
    const parent = {
      CODEX_TEST_BUNDLE_DIST: "/tmp/previous-candidate/dist",
      CODEX_MCP_BRIDGE_CODEX: "/tmp/pinned-codex",
      VALIDATION_MARKER: "parent"
    };
    const source = validationChildEnvironment({
      stage: "integrated", parent, extra: { CODEX_TEST_BUNDLE_DIST: "/tmp/another/dist" }
    });
    expect(source.CODEX_TEST_BUNDLE_DIST).toBeUndefined();
    expect(source.CODEX_MCP_BRIDGE_CODEX).toBeUndefined();
    expect(parent.CODEX_TEST_BUNDLE_DIST).toBe("/tmp/previous-candidate/dist");

    const schemaCheck = validationChildEnvironment({
      stage: "quick", parent, usePinnedCodexCli: true
    });
    expect(schemaCheck.CODEX_TEST_BUNDLE_DIST).toBeUndefined();
    expect(schemaCheck.CODEX_MCP_BRIDGE_CODEX).toBe("/tmp/pinned-codex");

    const build = validationChildEnvironment({ stage: "installed", parent });
    expect(build.CODEX_TEST_BUNDLE_DIST).toBeUndefined();
    const candidate = validationChildEnvironment({
      stage: "installed", parent, bundleDist: "/tmp/verified/dist",
      verifiedBundleDist: "/tmp/verified/dist"
    });
    expect(candidate.CODEX_TEST_BUNDLE_DIST).toBe("/tmp/verified/dist");
    expect(() => validationChildEnvironment({
      stage: "installed", parent, bundleDist: "/tmp/previous-candidate/dist",
      verifiedBundleDist: "/tmp/verified/dist"
    })).toThrow("VALIDATION_BUNDLE_UNVERIFIED");
  });

  it("fails an exit-0 product regression if its reported runtime is absent or different", () => {
    const expectedSource = scenarioRuntimeEvidence(
      "integrated", "execution-recovery", { runtime: "source" }
    );
    expect(expectedSource?.matches).toBe(true);
    for (const observed of [{ runtime: "/tmp/stale/dist" }, {}]) {
      const executionTarget = scenarioRuntimeEvidence(
        "integrated", "observation-faults", observed
      );
      expect(scenarioPassed({ exitCode: 0, timedOut: false, executionTarget })).toBe(false);
    }
    const bundled = scenarioRuntimeEvidence(
      "installed", "bundled-retention-and-ack", { runtime: "/tmp/verified/dist" },
      "/tmp/verified/dist"
    );
    expect(scenarioPassed({ exitCode: 0, timedOut: false, executionTarget: bundled })).toBe(true);
    const wrongBundle = scenarioRuntimeEvidence(
      "installed", "bundled-retention-and-ack", { runtime: "/tmp/stale/dist" },
      "/tmp/verified/dist"
    );
    expect(scenarioPassed({ exitCode: 0, timedOut: false, executionTarget: wrongBundle })).toBe(false);
  });

  it("reserves distinct default directories even when two runs start in the same millisecond", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "issue-198-output-"));
    roots.push(root);
    const now = new Date("2026-09-29T00:00:00.000Z");
    const first = reserveValidationOutput(root, "quick", undefined, now);
    const second = reserveValidationOutput(root, "quick", undefined, now);
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(path.join(root, "output", "issue-198"));
  });

  it("rejects a reused explicit directory before touching the prior report or log", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "issue-198-existing-"));
    roots.push(root);
    const output = path.join(root, "previous-run");
    await mkdir(output);
    const original = new Map([
      ["results.json", '{"verdict":"failed-or-incomplete"}\n'],
      ["report.md", "# Original failed run\n"],
      ["01-contract-and-release.log", "original failure\n"]
    ]);
    for (const [file, content] of original) await writeFile(path.join(output, file), content);
    const attempted = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts", "issue-198-validation.mjs"),
      "integrated", "--output-dir", output
    ], { cwd: repoRoot, encoding: "utf8", timeout: 10_000 });
    expect(attempted.status).not.toBe(0);
    expect(attempted.stderr).toContain("VALIDATION_OUTPUT_EXISTS");
    expect((await readdir(output)).sort()).toEqual([...original.keys()].sort());
    for (const [file, content] of original) {
      expect(await readFile(path.join(output, file), "utf8")).toBe(content);
    }
  });

  it.skipIf(process.platform === "win32")(
    "records a separate failure if a scenario log cannot be created", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "issue-198-log-open-"));
      roots.push(root);
      const output = path.join(root, "new-run");
      const delayedCli = path.join(root, "delayed-codex");
      await writeFile(delayedCli, [
        "#!/usr/bin/env node",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);",
        "process.stdout.write('codex-cli 0.153.3\\n');",
        ""
      ].join("\n"), { mode: 0o755 });
      const child = spawn(process.execPath, [
        path.join(repoRoot, "scripts", "issue-198-validation.mjs"),
        "quick", "--output-dir", output
      ], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_MCP_BRIDGE_CODEX: delayedCli },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const completion = new Promise<number | null>(resolve =>
        child.once("close", code => resolve(code))
      );
      const deadline = Date.now() + 5_000;
      while (!existsSync(output) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(existsSync(output)).toBe(true);
      await mkdir(path.join(output, "01-contract-and-release.log"));
      const exitCode = await completion;
      expect(exitCode).not.toBe(0);
      const result = JSON.parse(await readFile(path.join(output, "results.json"), "utf8"));
      const error = JSON.parse(await readFile(path.join(output, "runner-error.json"), "utf8"));
      expect(result.verdict).toBe("failed-or-incomplete");
      expect(result.scenarios).toEqual([]);
      expect(error.reason).toContain("VALIDATION_LOG_OPEN_FAILED");
    }, 10_000
  );
});
