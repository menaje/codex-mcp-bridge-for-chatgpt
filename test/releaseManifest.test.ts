import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkReleaseMetadata,
  deriveReleaseMetadata,
  loadReleaseManifest,
  setReleaseVersion,
  syncReleaseMetadata
} from "../scripts/release-manifest.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("release manifest", () => {
  it("is the synchronized source for runtime, package, repository, and release identity", () => {
    const manifest = loadReleaseManifest(REPO_ROOT);
    const metadata = checkReleaseMetadata(REPO_ROOT);

    expect(metadata).toEqual(deriveReleaseMetadata(manifest));
    expect(metadata).toMatchObject({
      displayName: "Codex MCP Bridge for ChatGPT",
      runtimeName: "codex-mcp-bridge",
      packageName: "codex-mcp-bridge-for-chatgpt",
      binaryName: "codex-mcp-bridge",
      nodeVersion: "22",
      npmVersion: "10.9.3",
      repositorySlug: "menaje/codex-mcp-bridge-for-chatgpt"
    });
  });

  it("detects package drift and synchronizes both npm metadata files atomically", () => {
    const root = fixtureRoot();
    expect(() => checkReleaseMetadata(root)).toThrow(/package\.json, package-lock\.json/);

    const metadata = syncReleaseMetadata(root);
    expect(metadata.packageFilename).toBe(`${metadata.packageName}-${metadata.version}.tgz`);
    expect(readJson(path.join(root, "package.json"))).toMatchObject({
      name: metadata.packageName,
      version: metadata.version,
      packageManager: `npm@${metadata.npmVersion}`,
      engines: { node: metadata.nodeEngine },
      files: expect.arrayContaining(["dist", "docs", "release-manifest.json"]),
      repository: { type: "git", url: `${metadata.repositoryUrl}.git` }
    });
    expect(readJson(path.join(root, "package-lock.json"))).toMatchObject({
      name: metadata.packageName,
      version: metadata.version,
      packages: { "": { name: metadata.packageName, version: metadata.version } }
    });
    expect(checkReleaseMetadata(root)).toEqual(metadata);
  });

  it("updates the manifest and package metadata together for increments and prereleases", () => {
    const root = fixtureRoot();
    syncReleaseMetadata(root);

    expect(setReleaseVersion("1.2.3", root)).toMatchObject({ version: "1.2.3", channel: "stable" });
    expect(setReleaseVersion("patch", root)).toMatchObject({ version: "1.2.4", channel: "stable" });
    expect(setReleaseVersion("1.2.4+build-7", root)).toMatchObject({
      version: "1.2.4+build-7",
      channel: "stable",
      prerelease: false
    });
    expect(setReleaseVersion("0.4.0-beta.1", root)).toMatchObject({
      version: "0.4.0-beta.1",
      tag: "v0.4.0-beta.1",
      channel: "prerelease",
      prerelease: true
    });
    expect(checkReleaseMetadata(root).version).toBe("0.4.0-beta.1");
    expect(() => setReleaseVersion("1.2.3-01", root)).toThrow(/Version must be/);
  });

  it("rejects unknown manifest fields and invalid GitHub owners", () => {
    const root = fixtureRoot();
    const manifest = readJson(path.join(root, "release-manifest.json"));
    manifest.product.unexpected = true;
    writeJson(path.join(root, "release-manifest.json"), manifest);
    expect(() => loadReleaseManifest(root)).toThrow(/product keys must be exactly/);

    delete manifest.product.unexpected;
    manifest.repository.owner = "invalid_owner";
    writeJson(path.join(root, "release-manifest.json"), manifest);
    expect(() => loadReleaseManifest(root)).toThrow(/repository\.owner contains unsupported characters/);

    manifest.repository.owner = "menaje";
    manifest.package.files.push("../secret");
    writeJson(path.join(root, "release-manifest.json"), manifest);
    expect(() => loadReleaseManifest(root)).toThrow(/safe relative package path/);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-release-manifest-"));
  const manifest = loadReleaseManifest(REPO_ROOT);
  writeJson(path.join(root, "release-manifest.json"), manifest);
  writeJson(path.join(root, "package.json"), {
    name: "drifted-package",
    version: "9.9.9",
    type: "module",
    scripts: { test: "vitest run" }
  });
  writeJson(path.join(root, "package-lock.json"), {
    name: "drifted-package",
    version: "9.9.9",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "drifted-package", version: "9.9.9" } }
  });
  return root;
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
