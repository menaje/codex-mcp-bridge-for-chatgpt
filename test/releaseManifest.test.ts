import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkReleaseMetadata,
  checkUiResources,
  derivePluginManifests,
  deriveReleaseMetadata,
  deriveUiResourceManifest,
  loadReleaseManifest,
  setReleaseVersion,
  syncReleaseMetadata,
  validateReleaseManifest
} from "../scripts/release-manifest.mjs";
import {
  loadUiReleaseCatalog,
  validateUiReleaseCatalog
} from "../scripts/ui-release-catalog.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("release manifest", () => {
  it("bootstraps GitHub workflow metadata before dependencies are installed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-release-bootstrap-"));
    const scriptsDirectory = path.join(root, "scripts");
    const metadata = deriveReleaseMetadata(loadReleaseManifest(REPO_ROOT));
    mkdirSync(scriptsDirectory);
    copyFileSync(
      path.join(REPO_ROOT, "scripts/release-manifest.mjs"),
      path.join(scriptsDirectory, "release-manifest.mjs")
    );
    copyFileSync(
      path.join(REPO_ROOT, "scripts/ui-release-catalog.mjs"),
      path.join(scriptsDirectory, "ui-release-catalog.mjs")
    );
    copyFileSync(
      path.join(REPO_ROOT, "release-manifest.json"),
      path.join(root, "release-manifest.json")
    );
    const releaseNotes = path.join(root, metadata.releaseNotesFile);
    mkdirSync(path.dirname(releaseNotes), { recursive: true });
    copyFileSync(path.join(REPO_ROOT, metadata.releaseNotesFile), releaseNotes);

    const output = execFileSync(
      process.execPath,
      [realpathSync(path.join(scriptsDirectory, "release-manifest.mjs")), "github-output"],
      { cwd: realpathSync(root), encoding: "utf8" }
    );

    expect(output).toContain("node_version=22\n");
    expect(output).toContain("npm_version=10.9.3\n");
    expect(output).toContain("codex_cli_version=0.153.3\n");
    expect(output).toContain(`release_notes_file=${metadata.releaseNotesFile}\n`);
  });

  it("requires the dual-architecture macOS, npm, state, and UI manifestVersion 6 contract", () => {
    const manifest = structuredClone(loadReleaseManifest(REPO_ROOT));
    expect(validateReleaseManifest(manifest)).toBe(manifest);
    expect(manifest.release.assets).toEqual([
      "npm-tarball",
      "npm-sha256",
      "macos-arm64-app",
      "macos-x64-app",
      "release-checksums"
    ]);
    expect(manifest.release.targets).toEqual({
      macos: {
        architectures: ["arm64", "x64"],
        format: "dmg",
        minimumVersion: "13.0",
        signing: "ad-hoc",
        notarization: "none"
      }
    });

    expect(manifest.release).toMatchObject({
      releaseUnitId: "codex-mcp-bridge",
      tagPrefix: "v",
      generateNotes: true
    });

    manifest.manifestVersion = 3;
    expect(() => validateReleaseManifest(manifest)).toThrow("manifestVersion must be 6");
  });

  it("publishes one complete schema-3-through-19 compatibility and recovery contract", () => {
    const manifest = loadReleaseManifest(REPO_ROOT);
    const catalog = readJson(path.join(REPO_ROOT, "state-migrations.json"));
    expect(manifest.stateCompatibility).toMatchObject({
      currentSchema: 19,
      supportedSourceSchemas: Array.from({ length: 16 }, (_, index) => index + 3),
      unsupportedSourceSchemas: [1, 2],
      retiredLegacyImports: [
        "settings-state-json",
        "session-state-json",
        "job-state-json"
      ],
      migrationCatalog: "state-migrations.json",
      stateProfilePolicy: "release-stage-isolated-v1",
      rollbackPolicy: "verified-original-before-service-open-v1",
      persistentContracts: {
        userSettingsSchema: 4,
        taskInputContract: 2,
        macosHelperProtocol: 2,
        localCompanionProtocol: 2,
        remoteCompanionProtocol: 1
      }
    });
    expect(catalog).toMatchObject({
      catalogVersion: 1,
      immutabilityPolicy: "append-only-after-release-v1",
      currentSchema: 19,
      supportedSourceSchemas: manifest.stateCompatibility.supportedSourceSchemas
    });
    expect(catalog.fixtures).toEqual(expect.arrayContaining([
      expect.objectContaining({ schema: 3, kind: "published-release", source: "v0.3.0" }),
      expect.objectContaining({ schema: 16, kind: "deployed-development" }),
      expect.objectContaining({ schema: 18, kind: "deployed-development" })
    ]));
    for (const source of manifest.stateCompatibility.supportedSourceSchemas) {
      let schema = source;
      const visited = new Set<number>();
      while (schema !== 19) {
        expect(visited.has(schema)).toBe(false);
        visited.add(schema);
        const migration = catalog.migrations.find((entry: any) => entry.fromSchema === schema);
        expect(migration).toMatchObject({
          id: `bridge-state-${schema}-to-${migration?.toSchema}`,
          fromSchema: schema,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          introducedCommit: expect.stringMatching(/^[0-9a-f]{40}$/)
        });
        schema = migration.toSchema;
      }
    }
  });

  it("rejects incomplete or reordered macOS architecture targets", () => {
    const missingIntel = structuredClone(loadReleaseManifest(REPO_ROOT));
    missingIntel.release.targets.macos.architectures = ["arm64"];
    expect(() => validateReleaseManifest(missingIntel)).toThrow(
      "release.targets.macos.architectures must be arm64, x64 in that order"
    );

    const reordered = structuredClone(loadReleaseManifest(REPO_ROOT));
    reordered.release.targets.macos.architectures = ["x64", "arm64"];
    expect(() => validateReleaseManifest(reordered)).toThrow(
      "release.targets.macos.architectures must be arm64, x64 in that order"
    );
  });

  it("derives release metadata from the synchronized package version and manifest policy", () => {
    const manifest = loadReleaseManifest(REPO_ROOT);
    const metadata = checkReleaseMetadata(REPO_ROOT);
    const baseVersion = manifest.release.version.replace(/-rc\.\d+$/, "");

    expect(metadata).toEqual(deriveReleaseMetadata(manifest));
    expect(metadata).toMatchObject({
      displayName: "Codex MCP Bridge for ChatGPT",
      runtimeName: "codex-mcp-bridge",
      packageName: "codex-mcp-bridge-for-chatgpt",
      binaryName: "codex-mcp-bridge",
      nodeVersion: "22",
      npmVersion: "10.9.3",
      codexCliVersion: "0.153.3",
      repositorySlug: "menaje/codex-mcp-bridge-for-chatgpt",
      pluginName: "codex-mcp-bridge",
      pluginDisplayName: "Codex MCP Bridge for ChatGPT",
      pluginDeveloperName: "menaje",
      pluginCategory: "Developer Tools",
      pluginAppId: "plugin_asdk_app_6a86b6dc2fd4819192d54ec3fb27e5b0",
      macosArchitectures: ["arm64", "x64"],
      macosMinimumVersion: "13.0",
      macosArchiveFilenames: {
        arm64: `Codex-MCP-Bridge-for-ChatGPT-${manifest.release.version}-macOS-arm64-unnotarized.dmg`,
        x64: `Codex-MCP-Bridge-for-ChatGPT-${manifest.release.version}-macOS-x64-unnotarized.dmg`
      },
      macosArm64ArchiveFilename: `Codex-MCP-Bridge-for-ChatGPT-${manifest.release.version}-macOS-arm64-unnotarized.dmg`,
      macosX64ArchiveFilename: `Codex-MCP-Bridge-for-ChatGPT-${manifest.release.version}-macOS-x64-unnotarized.dmg`,
      releaseChecksumsFilename: "SHA256SUMS.txt",
      releaseUnitId: "codex-mcp-bridge",
      releaseNotesFile: `docs/releases/${baseVersion}.md`,
      stage: manifest.release.stage,
      channel: manifest.release.channel,
      prerelease: manifest.release.stage === "candidate"
    });
  });

  it("detects package drift and synchronizes both npm metadata files atomically", () => {
    const root = fixtureRoot();
    expect(() => checkReleaseMetadata(root)).toThrow(/package\.json version 9\.9\.9.*source of truth/);

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

  it("rejects runtime constants and migration catalog bytes that drift from the manifest", () => {
    const root = fixtureRoot();
    syncReleaseMetadata(root);
    const modelPolicy = path.join(root, "src/modelPolicy.ts");
    writeFileSync(
      modelPolicy,
      readFileSync(modelPolicy, "utf8").replace(
        "MODEL_POLICY_SCHEMA_VERSION = 4",
        "MODEL_POLICY_SCHEMA_VERSION = 5"
      )
    );
    expect(() => checkReleaseMetadata(root)).toThrow(
      /userSettingsSchema runtime constant drifted/
    );

    writeFileSync(
      modelPolicy,
      readFileSync(path.join(REPO_ROOT, "src/modelPolicy.ts"), "utf8")
    );
    const catalogFile = path.join(root, "state-migrations.json");
    const catalog = readJson(catalogFile);
    catalog.migrations[0].sha256 = "0".repeat(64);
    writeJson(catalogFile, catalog);
    expect(() => checkReleaseMetadata(root)).toThrow(
      /state-migrations\.json does not match the migration implementations or fixtures/
    );
  });

  it("refuses to rewrite an existing applied migration checksum during synchronization", () => {
    const root = fixtureRoot();
    syncReleaseMetadata(root);
    const stateStore = path.join(root, "src/stateStore.ts");
    const source = readFileSync(stateStore, "utf8");
    const changed = source.replace(
      "  private migrateV18ToV19(): void {",
      "  private migrateV18ToV19(): void {\n    void \"immutable-test\";"
    );
    expect(changed).not.toBe(source);
    writeFileSync(stateStore, changed);

    expect(() => syncReleaseMetadata(root)).toThrow(
      /Immutable state migration migrations entry bridge-state-18-to-19 changed or disappeared/
    );
  });

  it("updates product metadata together and restricts candidates to rc.N", () => {
    const root = fixtureRoot();
    syncReleaseMetadata(root);

    expect(setReleaseVersion("1.2.3", root)).toMatchObject({
      version: "1.2.3",
      stage: "development",
      channel: "none"
    });
    expect(setReleaseVersion("patch", root)).toMatchObject({
      version: "1.2.4",
      stage: "development",
      channel: "none"
    });
    expect(setReleaseVersion("1.3.0-rc.1", root)).toMatchObject({
      version: "1.3.0-rc.1",
      tag: "v1.3.0-rc.1",
      stage: "candidate",
      channel: "prerelease",
      sourceVersion: "1.2.4",
      prerelease: true
    });
    expect(() => checkReleaseMetadata(root)).toThrow(
      /Release notes docs\/releases\/1\.3\.0\.md are required for candidate stage/
    );
    const notesFile = path.join(root, "docs/releases/1.3.0.md");
    mkdirSync(path.dirname(notesFile), { recursive: true });
    writeFileSync(notesFile, `${"Candidate release notes. ".repeat(12)}\n`, "utf8");
    expect(checkReleaseMetadata(root).stage).toBe("candidate");
    expect(setReleaseVersion("1.3.0", root)).toMatchObject({
      version: "1.3.0",
      stage: "stable",
      channel: "stable",
      sourceVersion: "1.2.4",
      sourceCandidate: "1.3.0-rc.1"
    });
    expect(readJson(path.join(root, ".codex-plugin/plugin.json")).version).toBe("1.3.0");
    expect(checkReleaseMetadata(root).version).toBe("1.3.0");
    expect(() => setReleaseVersion("1.4.0-beta.1", root)).toThrow(/suffix-free X\.Y\.Z/);
    expect(() => setReleaseVersion("1.4.0+build-7", root)).toThrow(/build metadata/);
    expect(() => setReleaseVersion("1.2.3-01", root)).toThrow(/Version must be/);
  });

  it("keeps UI cache keys independent from SemVer and changes them for HTML or host metadata", () => {
    const manifest = developmentManifest();
    const catalog = loadUiReleaseCatalog(REPO_ROOT);
    const initialLock = readJson(path.join(REPO_ROOT, "ui-manifest.lock.json"));
    const rendered = renderedFromLock(initialLock);
    const initial = deriveUiResourceManifest(manifest, rendered, undefined, catalog);
    const nextRelease = structuredClone(manifest);
    nextRelease.release.version = "0.3.1";
    const semverOnly = deriveUiResourceManifest(nextRelease, rendered, initial, catalog);

    expect(semverOnly.resources.settings.uri).toBe(initial.resources.settings.uri);
    expect(semverOnly.resources.activity.uri).toBe(initial.resources.activity.uri);
    expect(semverOnly.resources.dashboard.uri).toBe(initial.resources.dashboard.uri);

    const metadataChanged = structuredClone(rendered);
    metadataChanged.resources.settings.metadata.content.prefersBorder = false;
    const afterMetadata = deriveUiResourceManifest(manifest, metadataChanged, initial, catalog);
    expect(afterMetadata.resources.settings.uri).not.toBe(initial.resources.settings.uri);
    expect(afterMetadata.resources.settings.previous).toEqual(initial.resources.settings.previous);
    expect(afterMetadata.resources.activity.uri).toBe(initial.resources.activity.uri);

    const htmlChanged = structuredClone(rendered);
    htmlChanged.resources.activity.html += "<!-- changed -->";
    expect(() => deriveUiResourceManifest(manifest, htmlChanged, initial, catalog))
      .toThrow(/Compatibility-only activity renderer changed/);
  });

  it("selects only current, published, and deployed UI revisions without accumulating development history", () => {
    const manifest = loadReleaseManifest(REPO_ROOT);
    const catalog = loadUiReleaseCatalog(REPO_ROOT);
    const lock = readJson(path.join(REPO_ROOT, "ui-manifest.lock.json"));
    const rendered = renderedFromLock(lock);
    const unrelatedHistory = structuredClone(lock);
    unrelatedHistory.resources.settings.previous.push({
      digest: "0".repeat(64),
      uri: "ui://codex-mcp-bridge/settings/unclassified.html",
      metadata: lock.resources.settings.metadata
    });
    const selected = deriveUiResourceManifest(manifest, rendered, unrelatedHistory, catalog);
    expect(selected).toEqual(lock);
    expect(selected.releaseInventory.selected).toHaveLength(8);
    expect(selected.resources.settings.previous.map((entry: any) => entry.uri)).toEqual([
      "ui://codex-mcp-bridge/settings/fc59cc3d4ed0.html",
      "ui://codex-mcp-bridge/settings-v6.html"
    ]);
    expect(selected.resources.activity.previous.map((entry: any) => entry.uri)).toEqual([
      "ui://codex-mcp-bridge/activity-v1.html"
    ]);
    expect(selected.releaseInventory.retirement.activity).toMatchObject({
      lifecycle: "compatibility-only",
      newPresentations: false,
      firstStableWithReplacement: "0.4.0"
    });

    const missingGeneration = structuredClone(rendered);
    delete missingGeneration.resources.settings.metadata.content["codex/uiContractGeneration"];
    expect(() => deriveUiResourceManifest(manifest, missingGeneration, lock, catalog))
      .toThrow(/settings is missing codex\/uiContractGeneration/);

    const missingCompatibility = structuredClone(catalog);
    missingCompatibility.publishedBaselines[0].resources = missingCompatibility.publishedBaselines[0].resources
      .filter((entry: any) => entry.name !== "activity");
    missingCompatibility.temporaryExceptions[0].resources = missingCompatibility.temporaryExceptions[0].resources
      .filter((entry: any) => entry.name !== "activity");
    expect(() => validateUiReleaseCatalog(missingCompatibility))
      .toThrow(/compatibility resource activity has no selected/);

    const changedRetirement = structuredClone(catalog);
    changedRetirement.retirement.activity.newPresentations = true;
    expect(() => validateUiReleaseCatalog(changedRetirement))
      .toThrow(/retirement\.activity\.newPresentations must be false/);

    const driftedManifest = structuredClone(manifest);
    driftedManifest.uiResources.releaseCatalogSha256 = "0".repeat(64);
    expect(() => checkUiResources(REPO_ROOT, driftedManifest))
      .toThrow(/ui-release-catalog\.json digest does not match/);
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
      /schema lock targets Codex CLI 0\.144\.0.*supports 0\.153\.3/
    );
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-release-manifest-"));
  const manifest = developmentManifest();
  writeJson(path.join(root, "release-manifest.json"), manifest);
  writeJson(
    path.join(root, "app-server-schema.lock.json"),
    readJson(path.join(REPO_ROOT, "app-server-schema.lock.json"))
  );
  for (const relative of [
    "ui-release-catalog.json",
    "state-migrations.json",
    "src/stateStore.ts",
    "src/stateSchema.ts",
    "src/questionStore.ts",
    "src/threadConnections.ts",
    "src/eventRetention.ts",
    "src/workHistory.ts",
    "src/automaticRecovery.ts",
    "src/activity.ts",
    "src/agent.ts",
    "src/projectRegistry.ts",
    "src/cancellation.ts",
    "src/modelPolicy.ts",
    "src/tools.ts",
    "src/macosHelperServer.ts",
    "src/companionServer.ts",
    "src/remoteCompanionServer.ts",
    "test/fixtures/state-v3-seeded.sql",
    "test/fixtures/state-schema-v16.sql",
    "test/fixtures/state-schema-v18.sql"
  ]) {
    const destination = path.join(root, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(REPO_ROOT, relative), destination);
  }
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

function developmentManifest(): any {
  const manifest = structuredClone(loadReleaseManifest(REPO_ROOT));
  manifest.release.version = "0.3.0";
  manifest.release.stage = "development";
  manifest.release.channel = "none";
  manifest.release.sourceVersion = null;
  manifest.release.sourceCandidate = null;
  return validateReleaseManifest(manifest);
}

function renderedFromLock(lock: any): any {
  return {
    resources: Object.fromEntries(Object.entries(lock.resources).map(([name, value]: [string, any]) => [
      name,
      {
        uri: value.uri,
        html: readUiSnapshot(name, value.digest),
        metadata: structuredClone(value.metadata)
      }
    ]))
  };
}

function readUiSnapshot(name: string, digest: string): string {
  const plain = path.join(REPO_ROOT, "ui-resources", name, `${digest}.html`);
  try {
    return readFileSync(plain, "utf8");
  } catch {
    const encoded = readFileSync(`${plain}.base64`, "utf8");
    return Buffer.from(encoded.trim(), "base64").toString("utf8");
  }
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
