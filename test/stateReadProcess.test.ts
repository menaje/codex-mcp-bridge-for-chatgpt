import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { ChildProcessStateReadService } from "../src/stateReadProcess.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the read projection.");
}

describe("isolated state read projection", () => {
  it("reads current WAL state without registering a writer and recovers its own process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-state-read-"));
    roots.push(root);
    const file = path.join(root, "state.sqlite");
    const environment = {
      ...process.env,
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
      CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
      CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
    };
    const config = loadConfig(environment);
    const store = new BridgeStateStore({ file });
    // Initialize the durable execution-policy key before opening a query-only projection.
    new UserSettingsStore(config, { stateStore: store });
    new ScopeResolver({ stateStore: store });
    const before = bridgeInstanceCount(file);
    const service = await ChildProcessStateReadService.start(file, environment);
    try {
      await expect(service.settingsSnapshot()).resolves.toMatchObject({
        settings: { settingsRevision: 0 }
      });
      await expect(service.dashboardSnapshot()).resolves.toMatchObject({
        statusRows: expect.any(Array),
        generatedAt: expect.any(String)
      });
      expect(service.health()).toMatchObject({
        ready: true,
        reason: "ready",
        lastSnapshotAt: expect.any(Number)
      });
      expect(bridgeInstanceCount(file)).toBe(before);

      const generation = service.health().generation;
      const lastSnapshotAt = service.health().lastSnapshotAt;
      const processId = service.processId;
      expect(processId).toBeTypeOf("number");
      process.kill(processId!, "SIGKILL");
      await waitFor(() => {
        const health = service.health();
        return health.ready && health.generation !== generation;
      });
      expect(service.health().lastSnapshotAt).toBe(lastSnapshotAt);
      await expect(service.settingsSnapshot()).resolves.toMatchObject({
        settings: { settingsRevision: 0 }
      });
      expect(bridgeInstanceCount(file)).toBe(before);
    } finally {
      await service.close();
      store.close();
    }
  }, 15_000);

  it("keeps timed-out reads charged to bounded capacity until the child replies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-state-read-capacity-"));
    roots.push(root);
    const file = path.join(root, "state.sqlite");
    const environment = {
      ...process.env,
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
      CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
      CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
    };
    const config = loadConfig(environment);
    const store = new BridgeStateStore({ file });
    const settings = new UserSettingsStore(config, { stateStore: store });
    new ScopeResolver({ stateStore: store });
    const service = await ChildProcessStateReadService.start(file, environment, {
      requestDeadlineMs: 50
    });
    const processId = service.processId;
    expect(processId).toBeTypeOf("number");
    let stopped = false;
    try {
      process.kill(processId!, "SIGSTOP");
      stopped = true;
      const timedOut = Array.from({ length: 16 }, () =>
        service.settingsSnapshot().then(
          () => "resolved",
          error => error instanceof Error ? error.message : String(error)
        )
      );
      await expect(Promise.all(timedOut)).resolves.toEqual(
        Array.from({ length: 16 }, () => expect.stringContaining("STATE_READ_STALE"))
      );
      expect(service.health()).toMatchObject({ inFlight: 16, capacity: 16 });
      await expect(service.settingsSnapshot()).rejects.toThrow("STATE_READ_CAPACITY");
      expect(settings.update({ uiLocalePreference: "ko" }, 0)).toMatchObject({
        settingsRevision: 1,
        uiLocalePreference: "ko"
      });

      process.kill(processId!, "SIGCONT");
      stopped = false;
      await waitFor(() => service.health().inFlight === 0);
      await expect(service.settingsSnapshot()).resolves.toMatchObject({
        settings: { settingsRevision: 1, uiLocalePreference: "ko" }
      });
    } finally {
      if (stopped) {
        try { process.kill(processId!, "SIGCONT"); } catch { /* already exited */ }
      }
      await service.close();
      store.close();
    }
  }, 15_000);

  it("keeps current reads and writes moving while an older WAL snapshot delays truncation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-state-read-wal-"));
    roots.push(root);
    const file = path.join(root, "state.sqlite");
    const environment = {
      ...process.env,
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
      CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
      CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
    };
    const config = loadConfig(environment);
    const store = new BridgeStateStore({ file });
    const settings = new UserSettingsStore(config, { stateStore: store });
    new ScopeResolver({ stateStore: store });
    const service = await ChildProcessStateReadService.start(file, environment);
    const oldReader = new Database(file, { readonly: true });
    const checkpoint = new Database(file);
    try {
      expect(settings.update({ uiLocalePreference: "en" }, 0)).toMatchObject({
        settingsRevision: 1,
        uiLocalePreference: "en"
      });
      oldReader.exec("BEGIN");
      expect(oldReader.prepare(
        "SELECT settings_revision AS revision FROM user_settings WHERE singleton = 1"
      ).get()).toMatchObject({ revision: 1 });

      expect(settings.update({ uiLocalePreference: "ko" }, 1)).toMatchObject({
        settingsRevision: 2,
        uiLocalePreference: "ko"
      });
      await expect(service.settingsSnapshot()).resolves.toMatchObject({
        settings: { settingsRevision: 2, uiLocalePreference: "ko" }
      });
      expect(oldReader.prepare(
        "SELECT settings_revision AS revision FROM user_settings WHERE singleton = 1"
      ).get()).toMatchObject({ revision: 1 });

      checkpoint.pragma("busy_timeout = 50");
      expect(checkpoint.pragma("wal_checkpoint(TRUNCATE)")[0]).toMatchObject({ busy: 1 });
      oldReader.exec("COMMIT");
      expect(checkpoint.pragma("wal_checkpoint(TRUNCATE)")[0]).toMatchObject({ busy: 0 });
    } finally {
      if (oldReader.inTransaction) oldReader.exec("ROLLBACK");
      oldReader.close();
      checkpoint.close();
      await service.close();
      store.close();
    }
  }, 15_000);
});

function bridgeInstanceCount(file: string): number {
  const database = new Database(file, { readonly: true });
  try {
    return (database.prepare("SELECT COUNT(*) AS count FROM bridge_instances").get() as {
      count: number;
    }).count;
  } finally {
    database.close();
  }
}
