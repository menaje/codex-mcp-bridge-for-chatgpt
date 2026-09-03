import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildWindowsRelease,
  checkWindowsRelease,
  collectWindowsRelease,
  verifyWindowsReleaseArchive
} from "../scripts/build-windows-release.mjs";
import { deriveReleaseMetadata, loadReleaseManifest } from "../scripts/release-manifest.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("Windows server release archive", () => {
  it("creates a deterministic package around the canonical npm tarball", () => {
    const result = checkWindowsRelease(REPO_ROOT);

    expect(result.verified).toBe(true);
    expect(result.manifest).toMatchObject({
      manifestVersion: 1,
      version: loadReleaseManifest(REPO_ROOT).release.version,
      sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      target: {
        os: "windows",
        architecture: "x64",
        format: "zip",
        transport: "http",
        runtime: "node"
      },
      prerequisites: {
        nodeMajor: 22,
        codexCli: "0.145.0",
        tunnelClient: "external"
      }
    });
    expect(existsSync(result.outputFile)).toBe(false);
  }, 20_000);

  it("retains one exact npm tarball and contains no user secrets or state", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-windows-archive-test-"));
    try {
      const metadata = deriveReleaseMetadata(loadReleaseManifest(REPO_ROOT));
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const packed = JSON.parse(execFileSync(
        npm,
        ["pack", "--json", "--pack-destination", directory],
        { cwd: REPO_ROOT, encoding: "utf8" }
      ));
      const packageFile = path.join(directory, packed[0].filename);
      const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
      const release = collectWindowsRelease({ repoRoot: REPO_ROOT, packageFile, sourceCommit });
      const result = buildWindowsRelease({
        repoRoot: REPO_ROOT,
        packageFile,
        outputFile: path.join(directory, metadata.windowsArchiveFilename),
        sourceCommit
      });

      expect(verifyWindowsReleaseArchive(result.outputFile, release)).toEqual(release.manifest);
      expect(release.archiveEntries.filter((entry) => entry.path.endsWith(".tgz"))).toHaveLength(1);
      expect(release.archiveEntries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        `${release.rootDirectory}/Install-CodexBridge.ps1`,
        `${release.rootDirectory}/Start-CodexBridge.ps1`,
        `${release.rootDirectory}/Get-CodexBridgeStatus.ps1`,
        `${release.rootDirectory}/Test-Prerequisites.ps1`,
        `${release.rootDirectory}/.env.example`
      ]));
      const textContents = release.archiveEntries
        .filter((entry) => !entry.path.endsWith(".tgz"))
        .map((entry) => entry.data.toString("utf8"))
        .join("\n");
      expect(textContents).toContain("--ignore-scripts");
      expect(textContents).toContain("better-sqlite3");
      expect(textContents).not.toMatch(/^(?!\s*#)\s*CONTROL_PLANE_API_KEY=sk-/m);
      expect(textContents).not.toMatch(/^(?!\s*#)\s*CONTROL_PLANE_TUNNEL_ID=tunnel_/m);
      expect(release.archiveEntries.map((entry) => entry.path)).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/(?:^|\/)\.env$/),
        expect.stringMatching(/\.sqlite(?:-|$)/),
        expect.stringContaining("/.codex/")
      ]));
      expect(readFileSync(result.outputFile).length).toBeGreaterThan(readFileSync(packageFile).length);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects a renamed package or abbreviated source revision", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-windows-invalid-test-"));
    try {
      const fakePackage = path.join(directory, "wrong.tgz");
      writeFileSync(fakePackage, "not a package");
      expect(() => collectWindowsRelease({
        repoRoot: REPO_ROOT,
        packageFile: fakePackage,
        sourceCommit: "0123456"
      })).toThrow(/Expected npm package/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
