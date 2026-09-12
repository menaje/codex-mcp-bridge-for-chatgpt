import {
  mkdtempSync,
  realpathSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  PROJECT_CWD_STILL_PINNED,
  PROJECT_DELETE_REQUIRES_ARCHIVE,
  PROJECT_NAME_CONFLICT,
  PROJECT_NOT_FOUND,
  PROJECT_REGISTRY_CHANGED
} from "../src/projectRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import {
  SETTINGS_REVISION_CONFLICT,
  UserSettingsStore
} from "../src/userSettings.js";
import { replaceStoredSettingsPayloadForTest } from "./helpers/sqliteSettings.js";

const SCOPE = "11111111-1111-4111-8111-111111111111";

describe("user settings and project registry", () => {
  it("validates and persists history retention while migrating legacy settings to thirty days", () => {
    const databaseFile = path.join(temporaryDirectory("settings-history-"), "state.sqlite");
    const config = configFor();
    const first = persistentSettings(config, databaseFile);
    expect(first.settings.current.historyRetentionDays).toBe(30);
    for (const invalid of [1, -1, 31, "7", null]) {
      expect(() => first.settings.update(
        { historyRetentionDays: invalid as any },
        first.settings.current.settingsRevision
      )).toThrow(/retention/);
    }
    first.settings.update({ historyRetentionDays: 0 }, 0);
    first.stateStore.close();

    const second = persistentSettings(config, databaseFile);
    expect(second.settings.current.historyRetentionDays).toBe(0);
    const legacy = second.stateStore.getSettingsRecord()!.payload as Record<string, unknown>;
    delete legacy.historyRetentionDays;
    second.stateStore.close();
    replaceStoredSettingsPayloadForTest(databaseFile, legacy);

    const restored = persistentSettings(config, databaseFile);
    expect(restored.settings.current.historyRetentionDays).toBe(30);
    restored.stateStore.close();
  });

  it("defaults new installations to durable conversations while retaining explicit and legacy hidden settings", () => {
    const databaseFile = path.join(temporaryDirectory("settings-storage-"), "state.sqlite");
    const config = configFor();
    const first = persistentSettings(config, databaseFile);
    expect(first.settings.current.showBridgeThreadsInCodexApp).toBe(true);
    first.settings.update({ showBridgeThreadsInCodexApp: false }, 0);
    first.stateStore.close();

    const second = persistentSettings(config, databaseFile);
    expect(second.settings.current.showBridgeThreadsInCodexApp).toBe(false);
    const legacy = second.stateStore.getSettingsRecord()!.payload as Record<string, unknown>;
    delete legacy.showBridgeThreadsInCodexApp;
    second.stateStore.close();
    replaceStoredSettingsPayloadForTest(databaseFile, legacy);

    const restored = persistentSettings(config, databaseFile);
    expect(restored.settings.current.showBridgeThreadsInCodexApp).toBe(false);
    restored.stateStore.close();
  });

  it("persists inactive Ultra selections through restart and restores them when enabled", () => {
    const databaseFile = path.join(temporaryDirectory("settings-ultra-"), "state.sqlite");
    const config = configFor();
    const first = persistentSettings(config, databaseFile);
    const selection = { model: "gpt-saved", reasoningEffort: "ultra" };
    const policy = {
      mode: "automatic" as const,
      allowedSelections: { kind: "explicit" as const, selections: [selection] },
      constraints: { allowDelegation: false }
    };
    first.settings.update({ modelPolicy: policy }, 0);
    first.stateStore.close();
    const restarted = persistentSettings(config, databaseFile);
    expect(restarted.settings.current.modelPolicy).toEqual(policy);
    expect(restarted.settings.loadWarnings).toEqual([]);
    restarted.settings.update(
      { modelPolicy: { ...policy, constraints: { allowDelegation: true } } },
      1
    );
    expect(restarted.settings.current.modelPolicy).toHaveProperty(
      "allowedSelections.selections",
      [selection]
    );
    restarted.stateStore.close();
  });

  it("notifies after committed changes but not rejected or unchanged writes", () => {
    const store = new UserSettingsStore(configFor());
    const revisions: number[] = [];
    const unsubscribe = store.subscribeChanges(() => revisions.push(store.current.settingsRevision));
    store.update({ uiLocalePreference: "ko" }, 0);
    store.update({ uiLocalePreference: "ko" }, 1);
    expect(() => store.update({ uiLocalePreference: "en" }, 0)).toThrow(SETTINGS_REVISION_CONFLICT);
    expect(revisions).toEqual([1]);
    unsubscribe();
    store.update({ uiLocalePreference: "en" }, 1);
    expect(revisions).toEqual([1]);
  });

  it("starts without a default project, slug, or implicit selection", () => {
    const store = new UserSettingsStore(configFor());
    expect(store.current).toMatchObject({
      schemaVersion: 4,
      settingsRevision: 0,
      registryRevision: 0,
      projects: [],
      accessStrategy: "adaptive",
      maxConcurrentJobs: 30
    });
    expect(store.current).not.toHaveProperty("defaultProjectId");
    expect(store.current).not.toHaveProperty("defaultCwd");
    expect(() => store.update({ projects: [] } as never, 0))
      .toThrow("SETTINGS_FIELD_RETIRED");
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

  it("keeps a conservative default while allowing a higher operator ceiling", () => {
    const store = new UserSettingsStore(configFor());

    expect(store.current.maxConcurrentJobs).toBe(30);
    expect(store.update({ maxConcurrentJobs: 64 }, 0).maxConcurrentJobs).toBe(64);
    expect(() => store.update({ maxConcurrentJobs: 101 }, 1)).toThrow(/Concurrent job limit/);
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

  it("deletes only archived registrations while retaining pinned work history", () => {
    const root = temporaryDirectory("settings-delete-project-");
    const state = new BridgeStateStore({ file: ":memory:" });
    const store = new UserSettingsStore(configFor(), { stateStore: state });
    store.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Tracked", cwd: root } }],
      undefined,
      0
    );
    const project = store.current.projects[0]!;
    const activityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    state.createActivity({
      activityId,
      scopeId: SCOPE,
      projectId: project.id,
      projectName: project.name,
      projectCwd: root,
      now: 1
    });

    expect(() => store.updateWithProjectOperations(
      {},
      [{ kind: "delete", projectId: project.id }],
      undefined,
      1
    )).toThrow(PROJECT_DELETE_REQUIRES_ARCHIVE);
    expect(store.current.registryRevision).toBe(1);

    store.updateWithProjectOperations(
      {},
      [{ kind: "archive", projectId: project.id }],
      undefined,
      1
    );
    store.updateWithProjectOperations(
      {},
      [{ kind: "delete", projectId: project.id }],
      undefined,
      2
    );

    expect(store.current).toMatchObject({ registryRevision: 3, projects: [] });
    expect(store.projectRegistry.selectableProjects).toEqual([]);
    expect(state.getActivityProjectAdmission(activityId)).toEqual({
      projectId: project.id,
      projectName: project.name,
      projectCwd: root
    });
    expect(() => store.resolveProject({
      name: project.name,
      projectRef: project.projectRef,
      projectRevision: project.projectRevision
    })).toThrow(PROJECT_NOT_FOUND);
    expect(statSync(root).isDirectory()).toBe(true);
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
      projectName: pinned.name,
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

  it("blocks old cwd takeover while an idle Agent retains its pinned thread", () => {
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
      projectName: pinned.name,
      backendKind: "mcp-server",
      cwd: first,
      sandbox: "read-only",
      contextMode: "fresh",
      now: 2
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
    state.close();
  });

  it("persists ordinary settings separately from the project registry in SQLite", () => {
    const root = temporaryDirectory("settings-persist-root-");
    const databaseFile = path.join(temporaryDirectory("settings-state-"), "state.sqlite");
    const config = configFor();
    const first = persistentSettings(config, databaseFile, () => 3_000);
    first.settings.updateWithProjectOperations(
      { uiLocalePreference: "ko" },
      [{ kind: "add", project: { name: "Persisted", cwd: root } }],
      0,
      0
    );

    const persistedSettings = first.stateStore.getSettingsRecord();
    const persistedProjects = first.stateStore.getProjectRegistrySnapshot();
    expect(persistedSettings).toMatchObject({
      settingsRevision: 1,
      payload: { settingsRevision: 1, uiLocalePreference: "ko" }
    });
    expect(persistedSettings!.payload).not.toHaveProperty("projects");
    expect(persistedProjects).toMatchObject({ registryRevision: 1 });
    expect(persistedProjects.projects[0]).toMatchObject({
      id: expect.stringMatching(UUID_PATTERN),
      projectRef: expect.stringMatching(/^prj_[A-Za-z0-9_-]{22}$/),
      projectRevision: 1,
      name: "Persisted",
      cwd: root
    });
    expect(statSync(databaseFile).mode & 0o777).toBe(0o600);
    first.stateStore.close();

    const restored = persistentSettings(config, databaseFile);
    expect(restored.settings.current).toMatchObject({
      settingsRevision: 1,
      registryRevision: 1
    });
    expect(restored.settings.current.projects[0]).toMatchObject({
      name: "Persisted",
      cwd: root
    });
    restored.stateStore.close();
  });

  it("migrates the v2 preferred selection by removing the retired fallback", () => {
    const databaseFile = path.join(temporaryDirectory("settings-model-policy-v2-"), "state.sqlite");
    const config = configFor();
    const original = persistentSettings(config, databaseFile, () => 4_000);
    original.settings.update({ uiLocalePreference: "ko" }, 0);
    const persisted = original.stateStore.getSettingsRecord()!.payload as Record<string, unknown>;
    persisted.schemaVersion = 2;
    persisted.modelPolicy = {
      mode: "automatic",
      preferredSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      allowedSelections: { kind: "catalog-visible" },
      constraints: { allowDelegation: true }
    };
    original.stateStore.close();
    replaceStoredSettingsPayloadForTest(databaseFile, persisted);

    const restored = persistentSettings(config, databaseFile, () => 5_000);
    expect(restored.settings.current).toMatchObject({
      schemaVersion: 4,
      settingsRevision: 2,
      modelPolicy: {
        mode: "automatic",
        allowedSelections: { kind: "catalog-visible" },
        constraints: { allowDelegation: true }
      }
    });
    expect(restored.settings.current.modelPolicy).not.toHaveProperty("preferredSelection");
    expect(restored.settings.current.modelPolicy).not.toHaveProperty("fallbackSelection");
    expect(restored.settings.loadWarnings.join(" ")).toContain(
      "retired automatic model default was removed"
    );
    const rewritten = restored.stateStore.getSettingsRecord()!.payload as Record<string, unknown>;
    expect(rewritten.modelPolicy).not.toHaveProperty("fallbackSelection");
    expect(rewritten.modelPolicy).not.toHaveProperty("preferredSelection");
    restored.stateStore.close();
  });

  it("removes a migrated model-only preference while preserving automatic policy", () => {
    const databaseFile = path.join(temporaryDirectory("settings-model-only-"), "state.sqlite");
    const config = configFor();
    const original = persistentSettings(config, databaseFile, () => 6_000);
    original.settings.update({ uiLocalePreference: "ko" }, 0);
    const persisted = original.stateStore.getSettingsRecord()!.payload as Record<string, unknown>;
    persisted.legacyPreferredModel = "gpt-5.6-sol";
    persisted.modelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "catalog-visible" },
      constraints: { allowDelegation: true }
    };
    original.stateStore.close();
    replaceStoredSettingsPayloadForTest(databaseFile, persisted);

    const restored = persistentSettings(config, databaseFile, () => 7_000);
    const updated = restored.settings.update({
      modelPolicy: {
        mode: "automatic",
        allowedSelections: { kind: "catalog-visible" },
        constraints: { allowDelegation: true }
      }
    }, restored.settings.current.settingsRevision);

    expect(updated.modelPolicy).toMatchObject({
      mode: "automatic",
      allowedSelections: { kind: "catalog-visible" }
    });
    expect(updated.modelPolicy).not.toHaveProperty("fallbackSelection");
    expect(updated).not.toHaveProperty("legacyPreferredModel");
    restored.stateStore.close();
  });

  it("ignores retired environment model seeds for an automatic policy", () => {
    const databaseFile = path.join(temporaryDirectory("settings-fallback-seed-"), "state.sqlite");
    const original = persistentSettings(configFor(), databaseFile, () => 8_000);
    original.settings.update({ uiLocalePreference: "ko" }, 0);
    original.stateStore.close();

    const restored = persistentSettings(configFor({
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    }), databaseFile, () => 9_000);

    expect(restored.settings.current).toMatchObject({
      settingsRevision: 1,
      modelPolicy: {
        mode: "automatic",
        allowedSelections: { kind: "catalog-visible" }
      }
    });
    expect(restored.settings.current.modelPolicy).not.toHaveProperty("fallbackSelection");
    const rewritten = restored.stateStore.getSettingsRecord()!.payload as Record<string, unknown>;
    expect(rewritten.modelPolicy).not.toHaveProperty("fallbackSelection");
    restored.stateStore.close();
  });

  it("safely clamps but does not erase a saved full-access preference", () => {
    const databaseFile = path.join(temporaryDirectory("settings-narrow-"), "state.sqlite");
    const broad = configFor({
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "4",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "4"
    });
    const original = persistentSettings(broad, databaseFile);
    original.settings.update({ accessStrategy: "always-full", maxConcurrentJobs: 4 }, 0);
    original.stateStore.close();

    const narrowed = persistentSettings(configFor({
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2"
    }), databaseFile, () => Date.parse("2026-08-26T00:00:00Z"));
    expect(narrowed.settings.current).toMatchObject({
      settingsRevision: 2,
      accessStrategy: "always-full",
      maxConcurrentJobs: 2,
      updatedAt: "2026-08-26T00:00:00.000Z"
    });
    expect(narrowed.settings.resolveSandbox()).toBe("read-only");
    expect(narrowed.settings.loadWarnings.join(" ")).toContain("retained but inactive");
    expect(narrowed.settings.loadWarnings.join(" ")).toContain("concurrent-job limit");
    narrowed.stateStore.close();
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

function persistentSettings(
  config: ReturnType<typeof configFor>,
  databaseFile: string,
  now?: () => number
): { stateStore: BridgeStateStore; settings: UserSettingsStore } {
  const stateStore = new BridgeStateStore({ file: databaseFile });
  return {
    stateStore,
    settings: new UserSettingsStore(config, { stateStore, ...(now ? { now } : {}) })
  };
}
