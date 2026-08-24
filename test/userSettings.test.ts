import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";

describe("user settings store", () => {
  it("persists validated settings atomically with private file permissions", () => {
    const root = temporaryDirectory("bridge-root-");
    const stateFile = path.join(temporaryDirectory("bridge-settings-"), "settings.json");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root,
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
      defaultCwd: config.allowedRoots[0],
      uiLocalePreference: "auto",
      maxConcurrentJobs: 30,
      activityCardVisibility: "always",
      completionHandoff: "off"
    });

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
    expect(() => store.update({ defaultCwd: outside }, 1)).toThrow(/outside allowed roots/);
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
      expect.stringContaining("completionDeliveryMode was migrated")
    ]);
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
    expect(persisted).toMatchObject({ schemaVersion: 2, revision: 5 });

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
      defaultCwd: null,
      maxConcurrentJobs: 2
    });
    expect(reconciled.current).not.toHaveProperty("taskTimeoutMs");
    expect(reconciled.current).not.toHaveProperty("defaultSessionMode");
    expect(reconciled.current).not.toHaveProperty("autoResumeTtlMs");
    expect(reconciled.loadWarnings).toHaveLength(5);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/downgraded to read-only/);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/outside the current allowed roots/);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/save an allowed default/i);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/taskTimeoutMs was retired and removed/);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/Activity-managed/);
    expect(() => reconciled.resolveCwd()).toThrow(/DEFAULT_CWD_NOT_ALLOWED/);
    expect(() => reconciled.update({ uiLocalePreference: "ko" }, 2)).toThrow(
      /DEFAULT_CWD_NOT_ALLOWED/
    );
    const migrated = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(migrated).toMatchObject({
      settings: {
        revision: 2,
        accessStrategy: "read-only",
        defaultCwd: oldConfig.allowedRoots[0],
        maxConcurrentJobs: 2
      }
    });
    expect(migrated.settings).not.toHaveProperty("taskTimeoutMs");
    expect(migrated.settings).not.toHaveProperty("defaultSessionMode");
    expect(migrated.settings).not.toHaveProperty("autoResumeTtlMs");

    const rootsRestored = new UserSettingsStore(oldConfig, { stateFile });
    expect(rootsRestored.current.defaultCwd).toBe(oldConfig.allowedRoots[0]);
  });
});

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
