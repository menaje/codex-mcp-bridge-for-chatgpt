import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkReleaseMetadata,
  derivePluginManifests,
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
      codexCliVersion: "0.145.0",
      repositorySlug: "menaje/codex-mcp-bridge-for-chatgpt",
      pluginName: "codex-mcp-bridge",
      pluginDisplayName: "Codex MCP Bridge for ChatGPT",
      pluginDeveloperName: "menaje",
      pluginCategory: "Developer Tools",
      pluginAppId: "plugin_asdk_app_6a86b6dc2fd4819192d54ec3fb27e5b0"
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
      files: expect.arrayContaining(["dist", "docs", ".codex-plugin", ".app.json", "release-manifest.json"]),
      repository: { type: "git", url: `${metadata.repositoryUrl}.git` }
    });
    expect(readJson(path.join(root, "package-lock.json"))).toMatchObject({
      name: metadata.packageName,
      version: metadata.version,
      packages: { "": { name: metadata.packageName, version: metadata.version } }
    });
    const derivedPlugin = derivePluginManifests(loadReleaseManifest(root));
    expect(readJson(path.join(root, ".codex-plugin/plugin.json"))).toEqual(derivedPlugin.pluginManifest);
    expect(readJson(path.join(root, ".app.json"))).toEqual(derivedPlugin.appManifest);
    expect(checkReleaseMetadata(root)).toEqual(metadata);
  });

  it("detects and repairs drift in generated plugin manifests", () => {
    const root = fixtureRoot();
    syncReleaseMetadata(root);

    const pluginFile = path.join(root, ".codex-plugin/plugin.json");
    const pluginManifest = readJson(pluginFile);
    pluginManifest.interface.category = "Productivity";
    writeJson(pluginFile, pluginManifest);
    expect(() => checkReleaseMetadata(root)).toThrow(/\.codex-plugin\/plugin\.json/);

    syncReleaseMetadata(root);
    const appFile = path.join(root, ".app.json");
    const appManifest = readJson(appFile);
    appManifest.apps["codex-mcp-bridge"].id = "plugin_asdk_app_drifted";
    writeJson(appFile, appManifest);
    expect(() => checkReleaseMetadata(root)).toThrow(/\.app\.json/);

    syncReleaseMetadata(root);
    expect(checkReleaseMetadata(root).pluginCategory).toBe("Developer Tools");
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
    expect(readJson(path.join(root, ".codex-plugin/plugin.json")).version).toBe("0.4.0-beta.1");
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
            content: {
              prefersBorder: true,
              csp: { connectDomains: [] },
              "codex/uiContractGeneration": 9
            }
          }
        },
        activity: {
          html: "<!doctype html><p>activity</p>",
          metadata: {
            descriptor: { mimeType: "text/html;profile=mcp-app" },
            content: {
              prefersBorder: true,
              csp: { connectDomains: [] },
              "codex/uiContractGeneration": 7
            }
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

  it("retains every supported UI contract revision and prunes retired generations", () => {
    const manifest = loadReleaseManifest(REPO_ROOT);
    const legacyPolicy = structuredClone(manifest);
    legacyPolicy.uiResources.minimumContractGeneration = { settings: 3, activity: 4 };
    const renderedRevision = (
      settingsHtml: string,
      activityHtml: string,
      settingsGeneration: number,
      activityGeneration: number
    ) => ({
      resources: {
        settings: {
          html: settingsHtml,
          metadata: {
            descriptor: { mimeType: "text/html;profile=mcp-app" },
            content: { "codex/uiContractGeneration": settingsGeneration }
          }
        },
        activity: {
          html: activityHtml,
          metadata: {
            descriptor: { mimeType: "text/html;profile=mcp-app" },
            content: { "codex/uiContractGeneration": activityGeneration }
          }
        }
      }
    });

    let rendered = renderedRevision("settings-v3", "activity-v4", 3, 4);
    let history = deriveUiResourceManifest(legacyPolicy, rendered);
    const retiredSettingsUri = history.resources.settings.uri;
    const retiredActivityUri = history.resources.activity.uri;

    rendered = renderedRevision("settings-v5", "activity-v5", 5, 5);
    history = deriveUiResourceManifest(legacyPolicy, rendered, history);
    for (let revision = 1; revision <= 6; revision += 1) {
      rendered = renderedRevision(
        `settings-v6-${revision}`,
        `activity-v7-${revision}`,
        6,
        7
      );
      history = deriveUiResourceManifest(legacyPolicy, rendered, history);
    }

    expect(history.resources.settings.previous.length).toBeGreaterThan(5);
    expect(history.resources.activity.previous.length).toBeGreaterThan(5);

    const retiredSettingsGeneration6Uri = history.resources.settings.uri;
    rendered = renderedRevision("settings-v9", "activity-v7-current", 9, 7);
    const reconciled = deriveUiResourceManifest(manifest, rendered, history);
    expect(reconciled.resources.settings.previous.map((entry: any) => entry.uri))
      .not.toContain(retiredSettingsUri);
    expect(reconciled.resources.settings.previous.map((entry: any) => entry.uri))
      .not.toContain(retiredSettingsGeneration6Uri);
    expect(reconciled.resources.activity.previous.map((entry: any) => entry.uri))
      .not.toContain(retiredActivityUri);
    expect(reconciled.resources.settings.previous.every((entry: any) =>
      entry.metadata.content["codex/uiContractGeneration"] >= 9
    )).toBe(true);
    expect(reconciled.resources.activity.previous.every((entry: any) =>
      entry.metadata.content["codex/uiContractGeneration"] >= 7
    )).toBe(true);

    const missingGeneration = structuredClone(rendered);
    delete missingGeneration.resources.settings.metadata.content["codex/uiContractGeneration"];
    expect(() => deriveUiResourceManifest(manifest, missingGeneration, reconciled))
      .toThrow(/settings is missing codex\/uiContractGeneration/);
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

  it("fails the release check when the App Server schema lock targets another CLI", () => {
    const root = fixtureRoot();
    syncReleaseMetadata(root);
    const lock = readJson(path.join(root, "app-server-schema.lock.json"));
    lock.supportedCodexCliVersion = "0.144.0";
    writeJson(path.join(root, "app-server-schema.lock.json"), lock);

    expect(() => checkReleaseMetadata(root)).toThrow(
      /schema lock targets Codex CLI 0\.144\.0.*supports 0\.145\.0/
    );
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-release-manifest-"));
  const manifest = loadReleaseManifest(REPO_ROOT);
  writeJson(path.join(root, "release-manifest.json"), manifest);
  writeJson(
    path.join(root, "app-server-schema.lock.json"),
    readJson(path.join(REPO_ROOT, "app-server-schema.lock.json"))
  );
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
