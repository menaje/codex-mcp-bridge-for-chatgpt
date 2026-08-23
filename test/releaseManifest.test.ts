import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkReleaseMetadata,
  deriveReleaseMetadata,
  deriveUiResourceManifest,
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

  it("keeps UI cache keys independent from SemVer and changes them for HTML or host metadata", () => {
    const manifest = loadReleaseManifest(REPO_ROOT);
    const rendered = {
      resources: {
        settings: {
          html: "<!doctype html><p>settings</p>",
          metadata: {
            descriptor: { mimeType: "text/html;profile=mcp-app" },
            content: { prefersBorder: true, csp: { connectDomains: [] } }
          }
        },
        activity: {
          html: "<!doctype html><p>activity</p>",
          metadata: {
            descriptor: { mimeType: "text/html;profile=mcp-app" },
            content: { prefersBorder: true, csp: { connectDomains: [] } }
          }
        }
      }
    };
    const initial = deriveUiResourceManifest(manifest, rendered);
    const nextRelease = structuredClone(manifest);
    nextRelease.release.version = "0.3.1";
    const semverOnly = deriveUiResourceManifest(nextRelease, rendered, initial);

    expect(semverOnly.resources.settings.uri).toBe(initial.resources.settings.uri);
    expect(semverOnly.resources.activity.uri).toBe(initial.resources.activity.uri);

    const metadataChanged = structuredClone(rendered);
    metadataChanged.resources.settings.metadata.content.prefersBorder = false;
    const afterMetadata = deriveUiResourceManifest(manifest, metadataChanged, initial);
    expect(afterMetadata.resources.settings.uri).not.toBe(initial.resources.settings.uri);
    expect(afterMetadata.resources.settings.previous).toEqual([
      expect.objectContaining({ uri: initial.resources.settings.uri, digest: initial.resources.settings.digest })
    ]);
    expect(afterMetadata.resources.activity.uri).toBe(initial.resources.activity.uri);

    const htmlChanged = structuredClone(rendered);
    htmlChanged.resources.activity.html += "<!-- changed -->";
    const afterHtml = deriveUiResourceManifest(manifest, htmlChanged, initial);
    expect(afterHtml.resources.activity.uri).not.toBe(initial.resources.activity.uri);
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
