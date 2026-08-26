import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";

describe("user settings store", () => {
  it("persists validated settings atomically with private file permissions", () => {
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const store = new UserSettingsStore(config, { stateFile, now: () => Date.parse("2026-08-21T01:02:03Z") });

    expect(store.current).toMatchObject({
      schemaVersion: 2,
      revision: 0,
      accessStrategy: "adaptive",
      modelPolicy: {
        mode: "automatic",
        preferredSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        allowedSelections: { kind: "catalog-visible" },
        constraints: { allowDelegation: true }
      },
      usePriorityServiceTier: false,
      projects: [],
      uiLocalePreference: "auto",
      maxConcurrentJobs: 30,
      activityCardVisibility: "always",
      completionHandoff: "off"
    });
    expect(store.current).not.toHaveProperty("defaultProjectId");
    expect(store.current).not.toHaveProperty("defaultCwd");

    const updated = store.update(
      {
        accessStrategy: "always-full",
        uiLocalePreference: "ko",
        maxConcurrentJobs: 12,
        activityCardVisibility: "background-only",
        completionHandoff: "auto-handoff"
      },
      0
    );
    expect(updated).toMatchObject({
      revision: 1,
      updatedAt: "2026-08-21T01:02:03.000Z",
      accessStrategy: "always-full",
      uiLocalePreference: "ko",
      maxConcurrentJobs: 12,
      activityCardVisibility: "background-only",
      completionHandoff: "auto-handoff"
    });
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({
      version: 2,
      settings: { schemaVersion: 2, revision: 1, accessStrategy: "always-full" }
    });

    const restored = new UserSettingsStore(config, { stateFile });
    expect(restored.current).toMatchObject({
      revision: 1,
      accessStrategy: "always-full",
      uiLocalePreference: "ko",
      maxConcurrentJobs: 12,
      activityCardVisibility: "background-only",
      completionHandoff: "auto-handoff"
    });
    expect(restored.resolveSandbox("read-only")).toBe("danger-full-access");
  });

  it("registers unrelated folders without a default and preserves projects on reset", () => {
    const first = temporaryDirectory("bridge-project-first-");
    const second = temporaryDirectory("bridge-project-second-");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1"
    });
    const store = new UserSettingsStore(config);

    const firstSaved = store.updateWithProjectOperations({}, [{
      kind: "add",
      project: { id: "first", label: "첫 프로젝트", cwd: first }
    }], 0);
    expect(firstSaved.projects).toEqual([
      { id: "first", label: "첫 프로젝트", cwd: realpathSync(first) }
    ]);
    expect(() => store.resolveProject()).toThrow(/PROJECT_REQUIRED/);
    expect(store.resolveProject("first")).toMatchObject({ id: "first" });

    const customized = store.updateWithProjectOperations({
      accessStrategy: "always-full",
      uiLocalePreference: "ko"
    }, [{
      kind: "add",
      project: { id: "second", label: "Second", cwd: second }
    }], 1);
    const projectsBeforeReset = customized.projects;

    const reset = store.reset(2);
    expect(reset).toMatchObject({
      revision: 3,
      accessStrategy: "adaptive",
      uiLocalePreference: "auto",
      projects: projectsBeforeReset
    });
    expect(reset).not.toHaveProperty("defaultProjectId");
    expect(reset).not.toHaveProperty("defaultCwd");
  });

  it("rejects stale cards and values beyond bridge-enforced limits", () => {
    const root = temporaryDirectory("bridge-root-");
    const outside = temporaryDirectory("bridge-outside-");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "4",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "4",
      CODEX_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS: "60000"
    });
    const store = new UserSettingsStore(config);
    store.update({ uiLocalePreference: "ko" }, 0);

    expect(() => store.update({ uiLocalePreference: "auto" }, 0)).toThrow(/SETTINGS_REVISION_CONFLICT/);
    expect(() => store.update({ accessStrategy: "always-full" }, 1)).toThrow(/security policy disables/);
    expect(() => store.update({
      projects: [{ id: "outside", label: "Outside", cwd: outside }]
    }, 1)).toThrow(/legacy operator restriction/);
    expect(() => store.update({ maxConcurrentJobs: 5 }, 1)).toThrow(/Concurrent job limit/);
    expect(() =>
      store.update({ uiLocalePreference: "it" as "ko" }, 1)
    ).toThrow(/Invalid interface language preference/);
    expect(() =>
      store.update({ activityCardVisibility: "never", completionHandoff: "auto-handoff" }, 1)
    ).toThrow(/requires the Activity card/);
  });

  it("migrates legacy completion delivery into independent card and handoff settings", () => {
    const root = temporaryDirectory("bridge-root-");
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root
    });
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      settings: {
        revision: 4,
        updatedAt: "2026-08-21T00:00:00.000Z",
        accessStrategy: "adaptive",
        defaultModel: "gpt-5.6-sol",
        defaultReasoningEffort: "max",
        defaultCwd: root,
        uiLocalePreference: "auto",
        maxConcurrentJobs: 30,
        activityCardView: "activity-summary",
        completionDeliveryMode: "auto-handoff"
      }
    }));

    const migrated = new UserSettingsStore(config, { stateFile });
    expect(migrated.current).toMatchObject({
      revision: 5,
      modelPolicy: {
        mode: "automatic",
        preferredSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        allowedSelections: { kind: "catalog-visible" }
      },
      activityCardVisibility: "always",
      completionHandoff: "auto-handoff"
    });
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")).settings;
    expect(migrated.current).not.toHaveProperty("activityCardView");
    expect(persisted).not.toHaveProperty("activityCardView");
    expect(persisted).not.toHaveProperty("completionDeliveryMode");
    expect(migrated.loadWarnings).toEqual([
      expect.stringContaining("model policy"),
      expect.stringContaining("default project selection"),
      expect.stringContaining("completionDeliveryMode was migrated")
    ]);
  });

  it("migrates model-policy service tiers to the independent Priority preference", () => {
    const root = temporaryDirectory("bridge-root-");
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root
    });
    writeFileSync(stateFile, JSON.stringify({
      version: 2,
      settings: {
        schemaVersion: 2,
        revision: 4,
        updatedAt: "2026-08-21T00:00:00.000Z",
        accessStrategy: "adaptive",
        modelPolicy: {
          mode: "automatic",
          preferredSelection: {
            model: "gpt-5.6-sol",
            reasoningEffort: "max",
            serviceTier: "priority"
          },
          allowedSelections: {
            kind: "explicit",
            selections: [
              { model: "gpt-5.6-sol", reasoningEffort: "high" },
              { model: "gpt-5.6-sol", reasoningEffort: "high", serviceTier: "priority" },
              { model: "gpt-5.6-sol", reasoningEffort: "max", serviceTier: "priority" }
            ]
          },
          constraints: { allowDelegation: true }
        },
        defaultCwd: root,
        uiLocalePreference: "auto",
        maxConcurrentJobs: 30,
        activityCardVisibility: "always",
        completionHandoff: "off"
      }
    }));

    const migrated = new UserSettingsStore(config, { stateFile });
    expect(migrated.current).toMatchObject({
      revision: 5,
      usePriorityServiceTier: true,
      modelPolicy: {
        preferredSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        allowedSelections: {
          kind: "explicit",
          selections: [
            { model: "gpt-5.6-sol", reasoningEffort: "high" },
            { model: "gpt-5.6-sol", reasoningEffort: "max" }
          ]
        }
      }
    });
    expect(JSON.stringify(migrated.current.modelPolicy)).not.toContain("serviceTier");
    expect(migrated.loadWarnings).toEqual([
      expect.stringContaining("independent Priority preference"),
      expect.stringContaining("default project selection")
    ]);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")).settings;
    expect(persisted.usePriorityServiceTier).toBe(true);
    expect(JSON.stringify(persisted.modelPolicy)).not.toContain("serviceTier");

    const reloaded = new UserSettingsStore(config, { stateFile });
    expect(reloaded.current).toEqual(migrated.current);
    expect(reloaded.loadWarnings).toEqual([]);
  });

  it.each(["agent-list", "activity-summary"])(
    "discards the retired %s Activity layout without changing the flat-feed settings",
    (activityCardView) => {
      const root = temporaryDirectory("bridge-root-");
      const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
      const config = loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_ROOTS: root
      });
      writeFileSync(stateFile, JSON.stringify({
        version: 2,
        settings: {
          schemaVersion: 2,
          revision: 2,
          updatedAt: "2026-08-21T00:00:00.000Z",
          accessStrategy: "adaptive",
          modelPolicy: {
            mode: "automatic",
            allowedSelections: { kind: "catalog-visible" },
            constraints: { allowDelegation: true }
          },
          defaultCwd: root,
          uiLocalePreference: "auto",
          maxConcurrentJobs: 30,
          activityCardVisibility: "always",
          activityCardView,
          completionHandoff: "off"
        }
      }));

      const migrated = new UserSettingsStore(config, { stateFile });
      const persisted = JSON.parse(readFileSync(stateFile, "utf8")).settings;
      expect(migrated.current).toMatchObject({ revision: 3, activityCardVisibility: "always" });
      expect(migrated.current).not.toHaveProperty("activityCardView");
      expect(persisted).not.toHaveProperty("activityCardView");
    }
  );

  it("preserves a legacy JSON model-only default until its exact effort is materialized", () => {
    const root = temporaryDirectory("bridge-root-");
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root
    });
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      settings: {
        revision: 4,
        updatedAt: "2026-08-21T00:00:00.000Z",
        accessStrategy: "adaptive",
        defaultModel: "gpt-5.6-terra",
        defaultReasoningEffort: null,
        defaultCwd: root,
        uiLocalePreference: "auto",
        maxConcurrentJobs: 30,
        completionDeliveryMode: "off"
      }
    }));

    const migrated = new UserSettingsStore(config, { stateFile });
    expect(migrated.current).toMatchObject({
      revision: 5,
      legacyPreferredModel: "gpt-5.6-terra",
      modelPolicy: {
        mode: "automatic",
        allowedSelections: { kind: "catalog-visible" }
      }
    });
    expect(migrated.current.modelPolicy).not.toHaveProperty("preferredSelection");
    expect(migrated.loadWarnings).toEqual([
      expect.stringContaining("legacy preference"),
      expect.stringContaining("default project selection"),
      expect.stringContaining("completionDeliveryMode was migrated")
    ]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).settings).toMatchObject({
      schemaVersion: 2,
      legacyPreferredModel: "gpt-5.6-terra"
    });

    const reloaded = new UserSettingsStore(config, { stateFile });
    expect(reloaded.current).toEqual(migrated.current);
    expect(reloaded.loadWarnings).toEqual([]);
    expect(reloaded.update(
      { uiLocalePreference: "ko" },
      reloaded.current.revision
    )).toMatchObject({
      legacyPreferredModel: "gpt-5.6-terra",
      uiLocalePreference: "ko"
    });
    const materialized = reloaded.update(
      {
        modelPolicy: {
          mode: "automatic",
          preferredSelection: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
          allowedSelections: { kind: "catalog-visible" },
          constraints: { allowDelegation: true }
        }
      },
      reloaded.current.revision
    );
    expect(materialized).not.toHaveProperty("legacyPreferredModel");
  });

  it("migrates a legacy SQLite payload to an idempotent automatic exact policy", () => {
    const root = temporaryDirectory("bridge-root-");
    const databaseFile = path.join(temporaryDirectory("bridge-state-"), "state.sqlite");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: databaseFile
    });
    const stateStore = new BridgeStateStore({ file: databaseFile });
    stateStore.setSettings({
      revision: 4,
      updatedAt: "2026-08-21T00:00:00.000Z",
      accessStrategy: "adaptive",
      defaultModel: "gpt-5.6-terra",
      defaultReasoningEffort: "high",
      defaultCwd: root,
      uiLocalePreference: "auto",
      maxConcurrentJobs: 30,
      activityCardVisibility: "always",
      completionHandoff: "off"
    });

    const migrated = new UserSettingsStore(config, {
      stateStore,
      now: () => Date.parse("2026-08-23T00:00:00.000Z")
    });
    expect(migrated.current).toMatchObject({
      schemaVersion: 2,
      revision: 5,
      projects: [{
        id: "default",
        label: path.basename(config.allowedRoots[0]!),
        cwd: config.allowedRoots[0]
      }],
      modelPolicy: {
        mode: "automatic",
        preferredSelection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
        allowedSelections: { kind: "catalog-visible" },
        constraints: { allowDelegation: true }
      }
    });
    const persisted = stateStore.getSettings() as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("defaultModel");
    expect(persisted).not.toHaveProperty("defaultReasoningEffort");
    expect(persisted).toMatchObject({
      schemaVersion: 2,
      revision: 5,
      projects: [{
        id: "default",
        label: path.basename(config.allowedRoots[0]!),
        cwd: config.allowedRoots[0]
      }]
    });
    expect(persisted).not.toHaveProperty("defaultProjectId");
    expect(persisted).not.toHaveProperty("defaultCwd");

    const reloaded = new UserSettingsStore(config, { stateStore });
    expect(reloaded.current).toEqual(migrated.current);
    expect(reloaded.loadWarnings).toEqual([]);
    stateStore.close();
  });

  it("preserves a legacy SQLite model-only default", () => {
    const root = temporaryDirectory("bridge-root-");
    const databaseFile = path.join(temporaryDirectory("bridge-state-"), "state.sqlite");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: databaseFile
    });
    const stateStore = new BridgeStateStore({ file: databaseFile });
    stateStore.setSettings({
      revision: 2,
      updatedAt: "2026-08-21T00:00:00.000Z",
      accessStrategy: "adaptive",
      defaultModel: "gpt-5.6-sol",
      defaultReasoningEffort: null,
      defaultCwd: root,
      uiLocalePreference: "auto",
      maxConcurrentJobs: 30,
      activityCardVisibility: "always",
      completionHandoff: "off"
    });

    const migrated = new UserSettingsStore(config, { stateStore });
    expect(migrated.current).toMatchObject({
      schemaVersion: 2,
      revision: 3,
      legacyPreferredModel: "gpt-5.6-sol",
      modelPolicy: {
        mode: "automatic",
        allowedSelections: { kind: "catalog-visible" }
      }
    });
    expect(stateStore.getSettings()).toMatchObject({
      schemaVersion: 2,
      legacyPreferredModel: "gpt-5.6-sol"
    });
    stateStore.close();
  });

  it("migrates an allowed legacy default cwd into a deterministic saved project", () => {
    const root = temporaryDirectory("bridge-legacy-project-");
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root
    });
    const canonicalRoot = config.allowedRoots[0]!;
    writeFileSync(stateFile, JSON.stringify({
      version: 2,
      settings: {
        schemaVersion: 2,
        revision: 7,
        updatedAt: "2026-08-23T00:00:00.000Z",
        accessStrategy: "adaptive",
        modelPolicy: {
          mode: "automatic",
          allowedSelections: { kind: "catalog-visible" },
          constraints: { allowDelegation: true }
        },
        usePriorityServiceTier: false,
        defaultCwd: root,
        uiLocalePreference: "auto",
        maxConcurrentJobs: 30,
        activityCardVisibility: "always",
        completionHandoff: "off"
      }
    }));

    const migrated = new UserSettingsStore(config, {
      stateFile,
      now: () => Date.parse("2026-08-24T01:02:03Z")
    });
    expect(migrated.current).toMatchObject({
      revision: 8,
      updatedAt: "2026-08-24T01:02:03.000Z",
      projects: [{ id: "default", label: path.basename(canonicalRoot), cwd: canonicalRoot }]
    });
    expect(() => migrated.resolveProject()).toThrow(/PROJECT_REQUIRED/);
    expect(migrated.resolveProject("default")).toEqual({
      id: "default",
      label: path.basename(canonicalRoot),
      cwd: canonicalRoot
    });
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")).settings;
    expect(persisted).toMatchObject({
      revision: 8,
      projects: [{ id: "default", label: path.basename(canonicalRoot), cwd: canonicalRoot }]
    });
    expect(persisted).not.toHaveProperty("defaultProjectId");
    expect(persisted).not.toHaveProperty("defaultCwd");

    const reloaded = new UserSettingsStore(config, { stateFile });
    expect(reloaded.current).toEqual(migrated.current);
    expect(reloaded.loadWarnings).toEqual([]);
  });

  it("persists a named multi-project registry and requires exact project resolution", () => {
    const first = temporaryDirectory("bridge-first-");
    const second = temporaryDirectory("bridge-second-");
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const [canonicalFirst, canonicalSecond] = config.allowedRoots;
    const store = new UserSettingsStore(config, { stateFile });

    const updated = store.update({
      projects: [
        { id: "Web_APP", label: "웹 앱", cwd: first },
        { id: "API", label: "API 서비스", cwd: second }
      ]
    }, 0);
    expect(updated).toMatchObject({
      projects: [
        { id: "web-app", label: "웹 앱", cwd: canonicalFirst },
        { id: "api", label: "API 서비스", cwd: canonicalSecond }
      ]
    });
    expect(() => store.resolveProject()).toThrow(/PROJECT_REQUIRED/);
    expect(store.resolveProject("api")).toMatchObject({ id: "api", cwd: canonicalSecond });
    expect(store.resolveProject("WEB APP")).toMatchObject({ id: "web-app", cwd: canonicalFirst });

    const reloaded = new UserSettingsStore(config, { stateFile });
    expect(reloaded.current).toEqual(updated);
    expect(() => reloaded.resolveProject()).toThrow(/PROJECT_REQUIRED/);
    expect(reloaded.resolveProject("api")).toMatchObject({ id: "api", cwd: canonicalSecond });
  });

  it("removes persisted default selection fields without changing registered projects", () => {
    const first = temporaryDirectory("bridge-first-");
    const second = temporaryDirectory("bridge-second-");
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const original = new UserSettingsStore(config, { stateFile });
    const saved = original.update({
      projects: [
        { id: "first", label: "First", cwd: first },
        { id: "second", label: "Second", cwd: second }
      ]
    }, 0);
    const legacy = JSON.parse(readFileSync(stateFile, "utf8"));
    legacy.settings.defaultProjectId = "second";
    legacy.settings.defaultCwd = config.allowedRoots[1];
    writeFileSync(stateFile, JSON.stringify(legacy));

    const migrated = new UserSettingsStore(config, {
      stateFile,
      now: () => Date.parse("2026-08-24T04:05:06Z")
    });
    expect(migrated.current).toMatchObject({
      revision: saved.revision + 1,
      updatedAt: "2026-08-24T04:05:06.000Z",
      projects: saved.projects
    });
    expect(migrated.loadWarnings).toEqual([
      expect.stringContaining("default project selection was retired")
    ]);
    expect(() => migrated.resolveProject()).toThrow(/PROJECT_REQUIRED/);
    expect(migrated.resolveProject("second")).toMatchObject({ cwd: config.allowedRoots[1] });
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")).settings;
    expect(persisted.projects).toEqual(saved.projects);
    expect(persisted).not.toHaveProperty("defaultProjectId");
    expect(persisted).not.toHaveProperty("defaultCwd");
  });

  it("applies explicit project registry operations atomically at one expected revision", () => {
    const first = temporaryDirectory("bridge-first-");
    const second = temporaryDirectory("bridge-second-");
    const relocated = temporaryDirectory("bridge-relocated-");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second},${relocated}`
    });
    const store = new UserSettingsStore(config);

    const added = store.updateWithProjectOperations({
      uiLocalePreference: "ko"
    }, [
      { kind: "add", project: { id: "web", label: "Web", cwd: first } },
      { kind: "add", project: { id: "api", label: "API", cwd: second } }
    ], 0);
    expect(added).toMatchObject({
      revision: 1,
      uiLocalePreference: "ko",
      projects: [
        { id: "web", label: "Web", cwd: config.allowedRoots[0] },
        { id: "api", label: "API", cwd: config.allowedRoots[1] }
      ]
    });

    const edited = store.updateWithProjectOperations({}, [
      { kind: "rename", projectId: "web", label: "웹 앱" },
      { kind: "relocate", projectId: "web", cwd: relocated },
      { kind: "remove", projectId: "api" }
    ], 1);
    expect(edited).toMatchObject({
      revision: 2,
      projects: [{ id: "web", label: "웹 앱", cwd: config.allowedRoots[2] }]
    });

    expect(() => store.updateWithProjectOperations({}, [
      { kind: "rename", projectId: "web", label: "One" },
      { kind: "rename", projectId: "web", label: "Two" }
    ], 2)).toThrow(/PROJECT_OPERATION_CONFLICT/);
    expect(() => store.updateWithProjectOperations({}, [
      { kind: "remove", projectId: "missing" }
    ], 2)).toThrow(/PROJECT_NOT_FOUND/);
    expect(store.current).toEqual(edited);
  });

  it("rejects invalid project writes without advancing or persisting the revision", () => {
    const first = temporaryDirectory("bridge-first-");
    const second = temporaryDirectory("bridge-second-");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const store = new UserSettingsStore(config);

    expect(() => store.update({
      projects: [
        { id: "same id", label: "One", cwd: first },
        { id: "same_id", label: "Two", cwd: second }
      ]
    }, 0)).toThrow(/PROJECT_DUPLICATE_ID/);
    expect(() => store.update({
      defaultProjectId: "missing"
    } as never, 0)).toThrow(/SETTINGS_FIELD_RETIRED/);
    expect(() => store.update({
      defaultCwd: first
    } as never, 0)).toThrow(/SETTINGS_FIELD_RETIRED/);
    expect(store.current.revision).toBe(0);
    expect(store.current.projects).toEqual([]);
  });

  it("retains stale project metadata across root changes but blocks its admission", () => {
    const first = temporaryDirectory("bridge-first-");
    const second = temporaryDirectory("bridge-second-");
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const broadConfig = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const [canonicalFirst, canonicalSecond] = broadConfig.allowedRoots;
    const original = new UserSettingsStore(broadConfig, { stateFile });
    original.update({
      projects: [
        { id: "active", label: "활성", cwd: first },
        { id: "stale", label: "복구 필요", cwd: second }
      ]
    }, 0);

    const narrowedConfig = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: first
    });
    const narrowed = new UserSettingsStore(narrowedConfig, { stateFile });
    expect(narrowed.current.projects).toEqual([
      { id: "active", label: "활성", cwd: canonicalFirst },
      { id: "stale", label: "복구 필요", cwd: canonicalSecond }
    ]);
    expect(narrowed.projectRegistry.selectableProjects.map(({ id }) => id)).toEqual(["active"]);
    expect(narrowed.projectRegistry.unavailableProjectIds).toEqual(["stale"]);
    expect(narrowed.loadWarnings).toEqual([expect.stringContaining("PROJECT_UNAVAILABLE")]);
    expect(() => narrowed.resolveProject("stale")).toThrow(/PROJECT_UNAVAILABLE/);
    expect(() => narrowed.resolveProject()).toThrow(/PROJECT_REQUIRED/);
    expect(narrowed.resolveProject("active")).toMatchObject({ id: "active" });

    const unrelated = narrowed.update(
      { uiLocalePreference: "ko" },
      narrowed.current.revision
    );
    expect(unrelated.projects).toHaveLength(2);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).settings.projects).toContainEqual({
      id: "stale",
      label: "복구 필요",
      cwd: canonicalSecond
    });

    const recovered = narrowed.update({
      projects: [{ id: "active", label: "활성", cwd: first }]
    }, narrowed.current.revision);
    expect(recovered.projects).toHaveLength(1);
    expect(narrowed.projectRegistry.unavailableProjectIds).toEqual([]);
  });

  it("migrates an unavailable legacy folder as recovery metadata without restoring a default", () => {
    const oldRoot = temporaryDirectory("bridge-old-");
    const newRoot = temporaryDirectory("bridge-new-");
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const oldConfig = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: oldRoot
    });
    const oldCanonicalRoot = oldConfig.allowedRoots[0]!;
    writeFileSync(stateFile, JSON.stringify({
      version: 2,
      settings: {
        schemaVersion: 2,
        revision: 3,
        updatedAt: "2026-08-23T00:00:00.000Z",
        accessStrategy: "adaptive",
        modelPolicy: {
          mode: "automatic",
          allowedSelections: { kind: "catalog-visible" },
          constraints: { allowDelegation: true }
        },
        usePriorityServiceTier: false,
        defaultCwd: oldCanonicalRoot,
        uiLocalePreference: "auto",
        maxConcurrentJobs: 30,
        activityCardVisibility: "always",
        completionHandoff: "off"
      }
    }));
    const narrowedConfig = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: newRoot
    });
    const narrowed = new UserSettingsStore(narrowedConfig, { stateFile });

    expect(narrowed.current).toMatchObject({
      revision: 4,
      projects: [{
        id: "default",
        label: path.basename(oldCanonicalRoot),
        cwd: oldCanonicalRoot
      }]
    });
    expect(narrowed.projectRegistry.unavailableProjectIds).toEqual(["default"]);
    expect(() => narrowed.resolveProject()).toThrow(/PROJECT_REQUIRED/);
    expect(() => narrowed.resolveProject("default")).toThrow(/PROJECT_UNAVAILABLE/);
    const migratedPersisted = JSON.parse(readFileSync(stateFile, "utf8")).settings;
    expect(migratedPersisted).toMatchObject({
      projects: [{ id: "default", cwd: oldCanonicalRoot }]
    });
    expect(migratedPersisted).not.toHaveProperty("defaultProjectId");
    expect(migratedPersisted).not.toHaveProperty("defaultCwd");

    const reset = narrowed.reset(4);
    expect(reset).toMatchObject({
      revision: 5,
      projects: [{ id: "default", cwd: oldCanonicalRoot }]
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8")).settings).toMatchObject({
      revision: 5,
      projects: [{ id: "default", cwd: oldCanonicalRoot }]
    });

    const restored = new UserSettingsStore(oldConfig, { stateFile });
    expect(() => restored.resolveProject()).toThrow(/PROJECT_REQUIRED/);
    expect(restored.resolveProject("default"))
      .toMatchObject({ id: "default", cwd: oldCanonicalRoot });
  });

  it("imports an unavailable JSON project into SQLite exactly once without erasing recovery data", () => {
    const oldRoot = temporaryDirectory("bridge-import-old-root-");
    const newRoot = temporaryDirectory("bridge-import-new-root-");
    const stateDirectory = temporaryDirectory("bridge-import-settings-");
    const settingsFile = path.join(stateDirectory, "settings.json");
    const databaseFile = path.join(stateDirectory, "state.sqlite");
    const oldConfig = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: oldRoot
    });
    const legacy = new UserSettingsStore(oldConfig, { stateFile: settingsFile });
    legacy.update({ uiLocalePreference: "ko" }, legacy.current.revision);

    const tightenedConfig = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: newRoot
    });
    const firstState = new BridgeStateStore({ file: databaseFile });
    const first = new UserSettingsStore(tightenedConfig, {
      stateFile: settingsFile,
      stateStore: firstState,
      now: () => Date.parse("2026-08-24T02:00:00Z")
    });
    const firstRevision = first.current.revision;
    expect(first.current).toMatchObject({
      projects: [{ id: "default", cwd: oldConfig.allowedRoots[0] }]
    });
    expect(firstState.getSettings()).toMatchObject({
      revision: firstRevision,
      projects: [{ id: "default", cwd: oldConfig.allowedRoots[0] }]
    });
    firstState.close();

    const reopenedState = new BridgeStateStore({ file: databaseFile });
    const reopened = new UserSettingsStore(tightenedConfig, {
      stateFile: settingsFile,
      stateStore: reopenedState,
      now: () => Date.parse("2026-08-24T03:00:00Z")
    });
    expect(reopened.current.revision).toBe(firstRevision);
    expect(reopened.current.projects).toEqual(first.current.projects);
    expect(reopenedState.getSettings()).toMatchObject({
      revision: firstRevision
    });
    reopenedState.close();
  });

  it("keeps project registration independent from selection during UI integration", () => {
    const first = temporaryDirectory("bridge-first-");
    const second = temporaryDirectory("bridge-second-");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const [canonicalFirst, canonicalSecond] = config.allowedRoots;
    const store = new UserSettingsStore(config);

    const saved = store.update({
      projects: [
        { id: "first", label: "First", cwd: first },
        { id: "second", label: "Second", cwd: second }
      ]
    }, 0);
    expect(saved.projects).toEqual([
      { id: "first", label: "First", cwd: canonicalFirst },
      { id: "second", label: "Second", cwd: canonicalSecond }
    ]);
    expect(() => store.resolveProject()).toThrow(/PROJECT_REQUIRED/);
    expect(store.resolveProject("first")).toMatchObject({ cwd: canonicalFirst });
    expect(store.resolveProject("second")).toMatchObject({ cwd: canonicalSecond });
  });

  it("forces read-only even when a caller asks for full access", () => {
    const root = temporaryDirectory("bridge-root-");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
      CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY: "read-only"
    });
    const store = new UserSettingsStore(config);

    expect(store.resolveSandbox("danger-full-access")).toBe("read-only");
  });

  it("safely reconciles saved preferences when owner capabilities and limits tighten", () => {
    const oldRoot = temporaryDirectory("bridge-old-root-");
    const newRoot = temporaryDirectory("bridge-new-root-");
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const oldConfig = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: oldRoot,
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
      CODEX_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS: "60000",
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "4",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "4"
    });
    const oldStore = new UserSettingsStore(oldConfig, { stateFile });
    oldStore.update({
      accessStrategy: "always-full",
      maxConcurrentJobs: 4
    }, oldStore.current.revision);
    const legacy = JSON.parse(readFileSync(stateFile, "utf8"));
    legacy.settings.taskTimeoutMs = 60000;
    legacy.settings.defaultSessionMode = "new";
    legacy.settings.autoResumeTtlMs = 6 * 60 * 60 * 1000;
    writeFileSync(stateFile, JSON.stringify(legacy));

    const tightenedConfig = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: newRoot,
      CODEX_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS: "30000",
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2"
    });
    const reconciled = new UserSettingsStore(tightenedConfig, {
      stateFile,
      now: () => Date.parse("2026-08-22T00:00:00Z")
    });

    expect(reconciled.current).toMatchObject({
      revision: 2,
      updatedAt: "2026-08-22T00:00:00.000Z",
      accessStrategy: "read-only",
      maxConcurrentJobs: 2
    });
    expect(reconciled.current).not.toHaveProperty("taskTimeoutMs");
    expect(reconciled.current).not.toHaveProperty("defaultSessionMode");
    expect(reconciled.current).not.toHaveProperty("autoResumeTtlMs");
    expect(reconciled.loadWarnings).toHaveLength(5);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/downgraded to read-only/);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/PROJECT_UNAVAILABLE/);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/taskTimeoutMs was retired and removed/);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/Activity-managed/);
    expect(() => reconciled.resolveProject()).toThrow(/PROJECT_REQUIRED/);
    expect(() => reconciled.resolveProject("default")).toThrow(/PROJECT_UNAVAILABLE/);
    expect(reconciled.update({ uiLocalePreference: "ko" }, 2).uiLocalePreference).toBe("ko");
    const migrated = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(migrated).toMatchObject({
      settings: {
        revision: 3,
        accessStrategy: "read-only",
        projects: [{ id: "default", cwd: oldConfig.allowedRoots[0] }],
        maxConcurrentJobs: 2
      }
    });
    expect(migrated.settings).not.toHaveProperty("taskTimeoutMs");
    expect(migrated.settings).not.toHaveProperty("defaultSessionMode");
    expect(migrated.settings).not.toHaveProperty("autoResumeTtlMs");

    const rootsRestored = new UserSettingsStore(oldConfig, { stateFile });
    expect(rootsRestored.resolveProject("default").cwd).toBe(oldConfig.allowedRoots[0]);
  });
});

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
