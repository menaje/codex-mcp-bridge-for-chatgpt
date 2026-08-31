import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  PROJECT_CWD_STILL_PINNED,
  PROJECT_NAME_CONFLICT,
  PROJECT_NOT_FOUND,
  PROJECT_REGISTRY_CHANGED
} from "../src/projectRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import {
  SETTINGS_REVISION_CONFLICT,
  UserSettingsStore
} from "../src/userSettings.js";

const SCOPE = "11111111-1111-4111-8111-111111111111";

describe("user settings and project registry", () => {
  it("starts without a default project, slug, or implicit selection", () => {
    const store = new UserSettingsStore(configFor());
    expect(store.current).toMatchObject({
      schemaVersion: 3,
      settingsRevision: 0,
      registryRevision: 0,
      projects: [],
      accessStrategy: "adaptive"
    });
    expect(store.current).not.toHaveProperty("defaultProjectId");
    expect(store.current).not.toHaveProperty("defaultCwd");
    expect(() => store.resolveProject()).toThrow("PROJECT_SETUP_REQUIRED");
  });

  it("keeps settingsRevision and registryRevision independent with exact CAS", () => {
    const first = temporaryDirectory("settings-project-first-");
    const second = temporaryDirectory("settings-project-second-");
    const state = new BridgeStateStore({ file: ":memory:" });
    const store = new UserSettingsStore(configFor(), { stateStore: state, now: () => 1_000 });

    const registered = store.updateWithProjectOperations(
      {},
      [
        { kind: "add", project: { name: "Bridge", cwd: first } },
        { kind: "add", project: { name: "API", cwd: second } }
      ],
      undefined,
      0
    );
    expect(registered).toMatchObject({ settingsRevision: 0, registryRevision: 1 });
    expect(registered.projects).toHaveLength(2);
    expect(registered.projects.every(({ id }) => UUID_PATTERN.test(id))).toBe(true);

    const ordinary = store.update({ uiLocalePreference: "ko" }, 0);
    expect(ordinary).toMatchObject({ settingsRevision: 1, registryRevision: 1 });
    expect(() => store.update({ maxConcurrentJobs: 2 }, 0)).toThrow(SETTINGS_REVISION_CONFLICT);
    expect(() => store.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: registered.projects[0]!.id, name: "Core" }],
      undefined,
      0
    )).toThrow("PROJECT_REGISTRY_REVISION_CONFLICT");
    expect(store.current).toMatchObject({ settingsRevision: 1, registryRevision: 1 });
    state.close();
  });

  it("increments each affected revision exactly once and leaves no-op/failure unchanged", () => {
    const first = temporaryDirectory("settings-atomic-first-");
    const second = temporaryDirectory("settings-atomic-second-");
    const state = new BridgeStateStore({ file: ":memory:" });
    const store = new UserSettingsStore(configFor(), { stateStore: state, now: () => 2_000 });
    store.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "One", cwd: first } }],
      undefined,
      0
    );
    const initialProject = store.current.projects[0]!;
    const projectId = initialProject.id;
    expect(initialProject).toMatchObject({ projectRevision: 1 });
    expect(initialProject.projectRef).toMatch(/^prj_[A-Za-z0-9_-]{22}$/);
    expect(initialProject.projectRef).not.toBe(initialProject.id);

    const both = store.updateWithProjectOperations(
      { uiLocalePreference: "ko", maxConcurrentJobs: 2 },
      [
        { kind: "rename", projectId, name: "One Core" },
        { kind: "relocate", projectId, cwd: second }
      ],
      0,
      1
    );
    expect(both).toMatchObject({ settingsRevision: 1, registryRevision: 2 });
    expect(both.projects[0]).toMatchObject({
      projectRef: initialProject.projectRef,
      projectRevision: 2
    });

    const noOp = store.updateWithProjectOperations(
      { uiLocalePreference: "ko" },
      [{ kind: "rename", projectId, name: "One Core" }],
      1,
      2
    );
    expect(noOp).toMatchObject({ settingsRevision: 1, registryRevision: 2 });
    expect(noOp.projects[0]).toMatchObject({ projectRevision: 2 });

    expect(() => store.updateWithProjectOperations(
      { uiLocalePreference: "ja" },
      [{ kind: "add", project: { name: "one core", cwd: first } }],
      1,
      2
    )).toThrow(PROJECT_NAME_CONFLICT);
    expect(store.current).toMatchObject({
      settingsRevision: 1,
      registryRevision: 2,
      uiLocalePreference: "ko"
    });
    state.close();
  });

  it("keeps one server UUID through rename, relocate, archive, and restore", () => {
    const first = temporaryDirectory("settings-life-first-");
    const second = temporaryDirectory("settings-life-second-");
    const state = new BridgeStateStore({ file: ":memory:" });
    const store = new UserSettingsStore(configFor(), { stateStore: state });
    store.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Original", cwd: first } }],
      undefined,
      0
    );
    const id = store.current.projects[0]!.id;
    const projectRef = store.current.projects[0]!.projectRef;

    store.updateWithProjectOperations(
      {},
      [
        { kind: "rename", projectId: id, name: "Renamed" },
        { kind: "relocate", projectId: id, cwd: second }
      ],
      undefined,
      1
    );
    expect(store.current.projects[0]).toMatchObject({
      id,
      projectRef,
      projectRevision: 2,
      name: "Renamed",
      cwd: second
    });
    expect(store.current.registryRevision).toBe(2);

    store.updateWithProjectOperations(
      {},
      [{ kind: "archive", projectId: id }],
      undefined,
      2
    );
    expect(store.projectRegistry.selectableProjects).toEqual([]);
    expect(store.current.projects[0]).toMatchObject({ projectRef, projectRevision: 3 });
    expect(() => store.resolveProject({ name: "Renamed", registryRevision: 3 }))
      .toThrow(PROJECT_NOT_FOUND);

    store.updateWithProjectOperations(
      {},
      [{ kind: "restore", projectId: id, name: "Restored", cwd: first }],
      undefined,
      3
    );
    expect(store.current.projects[0]).toMatchObject({
      id,
      projectRef,
      projectRevision: 4,
      name: "Restored",
      cwd: first
    });
    expect(store.current.projects[0]).not.toHaveProperty("archivedAt");
    expect(store.current.registryRevision).toBe(4);
    state.close();
  });

  it("checks revision before name lookup so a stale renamed name cannot be reused", () => {
    const first = temporaryDirectory("settings-stale-first-");
    const second = temporaryDirectory("settings-stale-second-");
    const state = new BridgeStateStore({ file: ":memory:" });
    const store = new UserSettingsStore(configFor(), { stateStore: state });
    store.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Old Name", cwd: first } }],
      undefined,
      0
    );
    const original = store.current.projects[0]!;
    const originalId = original.id;
    store.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: originalId, name: "New Name" }],
      undefined,
      1
    );
    store.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Old Name", cwd: second } }],
      undefined,
      2
    );

    expect(() => store.resolveProject({ name: "Old Name", registryRevision: 1 }))
      .toThrow(PROJECT_REGISTRY_CHANGED);
    const reused = store.resolveProject({ name: "Old Name", registryRevision: 3 });
    expect(reused.id).not.toBe(originalId);
    expect(reused.projectRef).not.toBe(original.projectRef);
    expect(() => store.resolveProject({
      name: "Old Name",
      projectRef: original.projectRef,
      projectRevision: original.projectRevision
    })).toThrow(PROJECT_REGISTRY_CHANGED);
    state.close();
  });

  it("resolves a different valid name in the same revision exactly as supplied", () => {
    const first = temporaryDirectory("settings-semantic-first-");
    const second = temporaryDirectory("settings-semantic-second-");
    const store = new UserSettingsStore(configFor());
    store.updateWithProjectOperations(
      {},
      [
        { kind: "add", project: { name: "Intended", cwd: first } },
        { kind: "add", project: { name: "Other Valid", cwd: second } }
      ],
      undefined,
      0
    );
    const selected = store.resolveProject({
      name: "Other Valid",
      registryRevision: store.current.registryRevision
    });
    expect(selected.name).toBe("Other Valid");
    expect(selected.cwd).toBe(second);
    // The registry protects stale mappings; it cannot infer natural-language
    // intent when the caller supplies another valid name in the same revision.
  });

  it("keeps an unaffected project selector valid across unrelated registry mutations", () => {
    const first = temporaryDirectory("settings-independent-first-");
    const second = temporaryDirectory("settings-independent-second-");
    const store = new UserSettingsStore(configFor());
    store.updateWithProjectOperations(
      {},
      [
        { kind: "add", project: { name: "Alpha", cwd: first } },
        { kind: "add", project: { name: "Beta", cwd: second } }
      ],
      undefined,
      0
    );
    const alpha = store.current.projects.find(({ name }) => name === "Alpha")!;
    const beta = store.current.projects.find(({ name }) => name === "Beta")!;
    const alphaSelection = {
      name: alpha.name,
      projectRef: alpha.projectRef,
      projectRevision: alpha.projectRevision
    };

    store.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: beta.id, name: "Beta Renamed" }],
      undefined,
      1
    );

    expect(store.current.registryRevision).toBe(2);
    expect(store.resolveProject(alphaSelection)).toMatchObject({
      id: alpha.id,
      projectRef: alpha.projectRef,
      projectRevision: 1
    });
    expect(store.current.projects.find(({ id }) => id === beta.id)).toMatchObject({
      projectRevision: 2
    });

    store.updateWithProjectOperations(
      {},
      [{ kind: "reorder", projectIds: [beta.id, alpha.id] }],
      undefined,
      2
    );
    expect(store.current.registryRevision).toBe(3);
    expect(store.current.projects.find(({ id }) => id === alpha.id)).toMatchObject({
      projectRevision: 1
    });
    expect(store.current.projects.find(({ id }) => id === beta.id)).toMatchObject({
      projectRevision: 2
    });
    expect(store.resolveProject(alphaSelection).id).toBe(alpha.id);
  });

  it("rejects active restore conflicts without changing UUID or revision", () => {
    const first = temporaryDirectory("settings-restore-first-");
    const second = temporaryDirectory("settings-restore-second-");
    const store = new UserSettingsStore(configFor());
    store.updateWithProjectOperations(
      {},
      [
        { kind: "add", project: { name: "One", cwd: first } },
        { kind: "add", project: { name: "Two", cwd: second } }
      ],
      undefined,
      0
    );
    const [one, two] = store.current.projects;
    store.updateWithProjectOperations(
      {},
      [{ kind: "archive", projectId: one!.id }],
      undefined,
      1
    );
    expect(() => store.updateWithProjectOperations(
      {},
      [{ kind: "restore", projectId: one!.id, name: two!.name, cwd: first }],
      undefined,
      2
    )).toThrow(PROJECT_NAME_CONFLICT);
    expect(store.current.registryRevision).toBe(2);
    expect(store.current.projects.find(({ id }) => id === one!.id)?.archivedAt).toBeTypeOf("number");
  });

  it("blocks old cwd takeover while another UUID has a resumable Activity pin", () => {
    const first = temporaryDirectory("settings-pin-first-");
    const second = temporaryDirectory("settings-pin-second-");
    const state = new BridgeStateStore({ file: ":memory:" });
    const store = new UserSettingsStore(configFor(), { stateStore: state });
    store.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Pinned", cwd: first } }],
      undefined,
      0
    );
    const pinned = store.current.projects[0]!;
    state.createActivity({
      scopeId: SCOPE,
      projectId: pinned.id,
      projectLabel: pinned.name,
      projectCwd: first,
      now: 1
    });
    store.updateWithProjectOperations(
      {},
      [{ kind: "relocate", projectId: pinned.id, cwd: second }],
      undefined,
      1
    );

    expect(() => store.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Takeover", cwd: first } }],
      undefined,
      2
    )).toThrow(PROJECT_CWD_STILL_PINNED);
    expect(store.current.registryRevision).toBe(2);
    expect(store.current.projects).toHaveLength(1);
    state.close();
  });

  it("blocks old cwd takeover while an archived Agent can restore its pinned thread", () => {
    const first = temporaryDirectory("settings-agent-pin-first-");
    const second = temporaryDirectory("settings-agent-pin-second-");
    const state = new BridgeStateStore({ file: ":memory:" });
    const store = new UserSettingsStore(configFor(), { stateStore: state });
    store.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Pinned Agent", cwd: first } }],
      undefined,
      0
    );
    const pinned = store.current.projects[0]!;
    const agent = state.createAgent({
      scopeId: SCOPE,
      agentName: "Restorable Agent",
      now: 1
    });
    state.linkAgentThread({
      agentId: agent.agentId,
      threadId: "restorable-thread",
      projectId: pinned.id,
      projectLabel: pinned.name,
      backendKind: "mcp-server",
      cwd: first,
      sandbox: "read-only",
      contextMode: "fresh",
      now: 2
    });
    state.archiveAgent(agent.agentId, 3);
    store.updateWithProjectOperations(
      {},
      [{ kind: "relocate", projectId: pinned.id, cwd: second }],
      undefined,
      1
    );

    expect(() => store.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Takeover", cwd: first } }],
      undefined,
      2
    )).toThrow(PROJECT_CWD_STILL_PINNED);
    expect(store.current.registryRevision).toBe(2);
    state.close();
  });

  it("persists the split v4 state and upgrades v3 project selectors exactly once", () => {
    const root = temporaryDirectory("settings-persist-root-");
    const stateFile = path.join(temporaryDirectory("settings-state-"), "settings.json");
    const config = configFor();
    const store = new UserSettingsStore(config, { stateFile, now: () => 3_000 });
    store.updateWithProjectOperations(
      { uiLocalePreference: "ko" },
      [{ kind: "add", project: { name: "Persisted", cwd: root } }],
      0,
      0
    );

    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(persisted).toMatchObject({
      version: 4,
      settings: { settingsRevision: 1, uiLocalePreference: "ko" },
      projectRegistry: { registryRevision: 1 }
    });
    expect(persisted.settings).not.toHaveProperty("projects");
    expect(persisted.projectRegistry.projects[0]).toMatchObject({
      id: expect.stringMatching(UUID_PATTERN),
      projectRef: expect.stringMatching(/^prj_[A-Za-z0-9_-]{22}$/),
      projectRevision: 1,
      name: "Persisted",
      cwd: root
    });
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);

    const restored = new UserSettingsStore(config, { stateFile });
    expect(restored.current).toMatchObject({ settingsRevision: 1, registryRevision: 1 });
    expect(restored.current.projects[0]).toMatchObject({ name: "Persisted", cwd: root });

    const v3File = path.join(temporaryDirectory("settings-v3-selector-"), "settings.json");
    const v3 = structuredClone(persisted);
    v3.version = 3;
    delete v3.projectRegistry.projects[0].projectRef;
    delete v3.projectRegistry.projects[0].projectRevision;
    writeFileSync(v3File, JSON.stringify(v3));
    const migrated = new UserSettingsStore(config, { stateFile: v3File });
    const migratedProject = migrated.current.projects[0]!;
    expect(migratedProject).toMatchObject({
      id: persisted.projectRegistry.projects[0].id,
      projectRevision: 1
    });
    expect(migratedProject.projectRef).toMatch(/^prj_[A-Za-z0-9_-]{22}$/);
    const rewrittenV3 = JSON.parse(readFileSync(v3File, "utf8"));
    expect(rewrittenV3).toMatchObject({
      version: 4,
      projectRegistry: {
        projects: [expect.objectContaining({
          projectRef: migratedProject.projectRef,
          projectRevision: 1
        })]
      }
    });

    const legacyFile = path.join(temporaryDirectory("settings-legacy-"), "settings.json");
    const legacy = structuredClone(persisted);
    legacy.version = 2;
    legacy.settings.projects = [{ id: "default", label: "Legacy", cwd: root }];
    delete legacy.projectRegistry;
    writeFileSync(legacyFile, JSON.stringify(legacy));
    const imported = new UserSettingsStore(config, { stateFile: legacyFile });
    expect(imported.current.projects).toEqual([]);
    expect(imported.loadWarnings.join(" ")).toContain("intentionally not migrated");
  });

  it("migrates the v2 preferred selection to the v3 omission fallback", () => {
    const stateFile = path.join(temporaryDirectory("settings-model-policy-v2-"), "settings.json");
    const config = configFor();
    const original = new UserSettingsStore(config, { stateFile, now: () => 4_000 });
    original.update({ uiLocalePreference: "ko" }, 0);

    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    persisted.settings.schemaVersion = 2;
    persisted.settings.modelPolicy = {
      mode: "automatic",
      preferredSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      allowedSelections: { kind: "catalog-visible" },
      constraints: { allowDelegation: true }
    };
    writeFileSync(stateFile, JSON.stringify(persisted));

    const restored = new UserSettingsStore(config, { stateFile, now: () => 5_000 });
    expect(restored.current).toMatchObject({
      schemaVersion: 3,
      settingsRevision: 2,
      modelPolicy: {
        mode: "automatic",
        fallbackSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      }
    });
    expect(restored.current.modelPolicy).not.toHaveProperty("preferredSelection");
    const rewritten = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(rewritten.settings.modelPolicy).toHaveProperty("fallbackSelection");
    expect(rewritten.settings.modelPolicy).not.toHaveProperty("preferredSelection");
  });

  it("replaces a migrated model-only preference with an exact fallback policy", () => {
    const stateFile = path.join(temporaryDirectory("settings-model-only-"), "settings.json");
    const config = configFor();
    const original = new UserSettingsStore(config, { stateFile, now: () => 6_000 });
    original.update({ uiLocalePreference: "ko" }, 0);

    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    persisted.settings.legacyPreferredModel = "gpt-5.6-sol";
    persisted.settings.modelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "catalog-visible" },
      constraints: { allowDelegation: true }
    };
    writeFileSync(stateFile, JSON.stringify(persisted));

    const restored = new UserSettingsStore(config, { stateFile, now: () => 7_000 });
    const updated = restored.update({
      modelPolicy: {
        mode: "automatic",
        fallbackSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        allowedSelections: { kind: "catalog-visible" },
        constraints: { allowDelegation: true }
      }
    }, restored.current.settingsRevision);

    expect(updated.modelPolicy).toMatchObject({
      mode: "automatic",
      fallbackSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
    });
    expect(updated).not.toHaveProperty("legacyPreferredModel");
  });

  it("persists the configured exact seed when a saved automatic policy lacks a fallback", () => {
    const stateFile = path.join(temporaryDirectory("settings-fallback-seed-"), "settings.json");
    const original = new UserSettingsStore(configFor(), { stateFile, now: () => 8_000 });
    original.update({ uiLocalePreference: "ko" }, 0);

    const restored = new UserSettingsStore(configFor({
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    }), { stateFile, now: () => 9_000 });

    expect(restored.current).toMatchObject({
      settingsRevision: 2,
      modelPolicy: {
        mode: "automatic",
        fallbackSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      }
    });
    expect(restored.loadWarnings.join(" ")).toContain("missing an exact fallback");
    const rewritten = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(rewritten.settings.modelPolicy.fallbackSelection).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "max"
    });
  });

  it("safely narrows saved capability settings in one ordinary generation", () => {
    const stateFile = path.join(temporaryDirectory("settings-narrow-"), "settings.json");
    const broad = configFor({
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "4",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "4"
    });
    const original = new UserSettingsStore(broad, { stateFile });
    original.update({ accessStrategy: "always-full", maxConcurrentJobs: 4 }, 0);

    const narrowed = new UserSettingsStore(configFor({
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2"
    }), {
      stateFile,
      now: () => Date.parse("2026-08-26T00:00:00Z")
    });
    expect(narrowed.current).toMatchObject({
      settingsRevision: 2,
      accessStrategy: "read-only",
      maxConcurrentJobs: 2,
      updatedAt: "2026-08-26T00:00:00.000Z"
    });
    expect(narrowed.loadWarnings.join(" ")).toContain("downgraded to read-only");
    expect(narrowed.loadWarnings.join(" ")).toContain("concurrent-job limit");
  });
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configFor(extra: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
    ...extra
  });
}

function temporaryDirectory(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}
