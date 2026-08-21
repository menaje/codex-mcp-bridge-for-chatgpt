import { mkdtempSync, readFileSync, statSync } from "node:fs";
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
      defaultSessionMode: "auto",
      maxConcurrentJobs: 30
    });

    const updated = store.update(
      {
        accessStrategy: "always-full",
        defaultSessionMode: "new",
        autoResumeTtlMs: 60 * 60 * 1000,
        taskTimeoutMs: 2 * 60 * 60 * 1000,
        maxConcurrentJobs: 12
      },
      0
    );
    expect(updated).toMatchObject({
      revision: 1,
      updatedAt: "2026-08-21T01:02:03.000Z",
      accessStrategy: "always-full",
      defaultSessionMode: "new",
      maxConcurrentJobs: 12
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
      defaultSessionMode: "new",
      maxConcurrentJobs: 12
    });
    expect(restored.resolveSandbox("read-only")).toBe("danger-full-access");
  });

  it("rejects stale cards and values beyond owner-enforced limits", () => {
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
    store.update({ defaultSessionMode: "new" }, 0);

    expect(() => store.update({ defaultSessionMode: "auto" }, 0)).toThrow(/Settings changed/);
    expect(() => store.update({ accessStrategy: "always-full" }, 1)).toThrow(/owner disabled/);
    expect(() => store.update({ defaultCwd: outside }, 1)).toThrow(/outside allowed roots/);
    expect(() => store.update({ taskTimeoutMs: 60001 }, 1)).toThrow(/Task timeout/);
    expect(() => store.update({ maxConcurrentJobs: 5 }, 1)).toThrow(/Concurrent job limit/);
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
});

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
