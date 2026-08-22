import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
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
      revision: 0,
      accessStrategy: "adaptive",
      defaultModel: "gpt-5.6-sol",
      defaultReasoningEffort: "max",
      defaultCwd: config.allowedRoots[0],
      uiLocalePreference: "auto",
      maxConcurrentJobs: 30
    });

    const updated = store.update(
      {
        accessStrategy: "always-full",
        uiLocalePreference: "ko",
        maxConcurrentJobs: 12,
        completionDeliveryMode: "auto-handoff"
      },
      0
    );
    expect(updated).toMatchObject({
      revision: 1,
      updatedAt: "2026-08-21T01:02:03.000Z",
      accessStrategy: "always-full",
      uiLocalePreference: "ko",
      maxConcurrentJobs: 12,
      completionDeliveryMode: "auto-handoff"
    });
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({
      version: 1,
      settings: { revision: 1, accessStrategy: "always-full" }
    });

    const restored = new UserSettingsStore(config, { stateFile });
    expect(restored.current).toMatchObject({
      revision: 1,
      accessStrategy: "always-full",
      uiLocalePreference: "ko",
      maxConcurrentJobs: 12
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

    expect(() => store.update({ uiLocalePreference: "auto" }, 0)).toThrow(/Settings changed/);
    expect(() => store.update({ accessStrategy: "always-full" }, 1)).toThrow(/security policy disables/);
    expect(() => store.update({ defaultCwd: outside }, 1)).toThrow(/outside allowed roots/);
    expect(() => store.update({ maxConcurrentJobs: 5 }, 1)).toThrow(/Concurrent job limit/);
    expect(() =>
      store.update({ uiLocalePreference: "it" as "ko" }, 1)
    ).toThrow(/Invalid interface language preference/);
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
    });
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
      defaultCwd: tightenedConfig.allowedRoots[0],
      maxConcurrentJobs: 2
    });
    expect(reconciled.current).not.toHaveProperty("taskTimeoutMs");
    expect(reconciled.current).not.toHaveProperty("defaultSessionMode");
    expect(reconciled.current).not.toHaveProperty("autoResumeTtlMs");
    expect(reconciled.loadWarnings).toHaveLength(5);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/downgraded to read-only/);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/outside the currently allowed roots/);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/taskTimeoutMs was retired and removed/);
    expect(reconciled.loadWarnings.join(" ")).toMatch(/Activity-managed/);
    const migrated = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(migrated).toMatchObject({
      settings: { revision: 2, accessStrategy: "read-only", maxConcurrentJobs: 2 }
    });
    expect(migrated.settings).not.toHaveProperty("taskTimeoutMs");
    expect(migrated.settings).not.toHaveProperty("defaultSessionMode");
    expect(migrated.settings).not.toHaveProperty("autoResumeTtlMs");
  });
});

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
