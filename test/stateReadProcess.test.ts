import Database from "better-sqlite3";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CodexService, type CodexSessionAuthBoundaryEvidence } from "../src/codexService.js";
import { projectCodexAccount } from "../src/codexAccount.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { ChildProcessStateReadService } from "../src/stateReadProcess.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { syntheticIdToken } from "./fixtures/syntheticAuth.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("settings speed support in the isolated read process", () => {
  it.each([undefined, "turn/start"])("uses the selected CLI schema before any Job, missing method %s", async missingMethod => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-speed-read-")); roots.push(root);
    const file = path.join(root, "state.sqlite"), turnLog = path.join(root, "turns.jsonl");
    const command = path.join(root, "codex-speed.mjs");
    const models = { models: [{ slug: "sol", display_name: "Sol", visibility: "list",
      supported_reasoning_levels: [{ effort: "medium" }], service_tiers: [{ id: "priority", name: "Fast" }] }] };
    await writeFile(command, `#!/usr/bin/env node\nif(process.argv[2]==='debug'&&process.argv[3]==='models'){console.log(${JSON.stringify(JSON.stringify(models))});process.exit(0)}\nawait import(${JSON.stringify(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url).href)});\n`, { mode: 0o700 });
    const environment = { ...process.env, HOME: root, CODEX_HOME: path.join(root, "codex"),
      CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_CODEX: command,
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"), CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"), CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills"),
      CODEX_TEST_MISSING_METHOD: missingMethod, CODEX_TEST_SPEED_LOG: turnLog };
    const store = new BridgeStateStore({ file });
    new UserSettingsStore(loadConfig(environment), { stateStore: store }); new ScopeResolver({ stateStore: store });
    const writers = bridgeInstanceCount(file);
    const service = await ChildProcessStateReadService.start(file, environment);
    try {
      const view = await service.settingsSnapshot();
      if (missingMethod) {
        expect(view.capabilities.availableProcessingSpeeds).toEqual(["legacy"]);
        expect(view.capabilities.processingSpeedSupport?.protocol).toBe("unverified");
        expect(view.warnings.some(warning => warning.startsWith("PROCESSING_SPEED_UNSUPPORTED:"))).toBe(true);
      } else {
        expect(view.capabilities.availableProcessingSpeeds).toEqual(expect.arrayContaining(["inherit", "standard", "fast"]));
        expect(view.capabilities.processingSpeedSupport?.protocol).toBe("supported");
      }
      expect(view.capabilities.availableProcessingSpeeds).not.toContain("ultrafast");
      expect(bridgeInstanceCount(file)).toBe(writers);
      await expect(import("node:fs/promises").then(fs => fs.readFile(turnLog))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await service.close(); store.close(); }
  }, 20_000);
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
  it("keeps a session visible through IPC during account loss, change and reader restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-state-read-owner-"));
    roots.push(root);
    const home = path.join(root, "codex-home");
    await mkdir(home);
    await writeFile(path.join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    const file = path.join(root, "state.sqlite");
    const environment = {
      ...process.env,
      HOME: root,
      CODEX_HOME: home,
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
    new UserSettingsStore(config, { stateStore: store });
    new ScopeResolver({ stateStore: store });
    const owner = async (accountId: string) => {
      const ownerHome = path.join(root, accountId);
      await mkdir(ownerHome);
      await writeFile(path.join(ownerHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
      const authFile = path.join(ownerHome, "auth.json");
      await writeFile(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: {
        account_id: accountId, id_token: syntheticIdToken("fixture-user", accountId) }
      }));
      const codex = new CodexService({ ...environment, CODEX_HOME: ownerHome });
      codex.setAuthPolicyReader(async () => ({
        config: { config: { cliAuthCredentialsStore: "file" } }, requirements: { requirements: null }
      }));
      codex.setAccountReader(async () => projectCodexAccount({
        account: { type: "chatgpt", email: "same@example.invalid" },
        workspaceRouting: { chatgptAccountId: accountId, backendOrigin: "https://example.invalid",
          accountRoutingOverride: "NO_CONSTRAINT" }
      }, null));
      await codex.assertCurrentAdmission();
      await rm(authFile);
      return codex;
    };
    const firstOwner = await owner("workspace-a");
    const secondOwner = await owner("workspace-b");
    const sessions = new SessionRegistry({ stateStore: store, allowedRoots: [root],
      authBoundary: () => firstOwner.sessionAuthBoundary() });
    const now = Date.now();
    sessions.record({ threadId: "file-thread", scopeId: "11111111-1111-4111-8111-111111111111",
      backendKind: "app-server", cwd: root, sandbox: "read-only", updatedAt: now,
      createdAt: now, lastUsedAt: now });
    expect(sessions.list()).toHaveLength(1);
    let evidence: CodexSessionAuthBoundaryEvidence | null = firstOwner.sessionAuthBoundary();
    let evidenceUnavailable = false;
    expect(evidence.ownerStatus).toBe("last-confirmed");
    const readOnlyStore = new BridgeStateStore({ file, readOnly: true });
    expect(new SessionRegistry({ stateStore: readOnlyStore, allowedRoots: config.allowedRoots,
      projectionOnly: true, authBoundary: { key: evidence.key, allowLegacyShared: false } }).list()).toHaveLength(1);
    readOnlyStore.close();
    const service = await ChildProcessStateReadService.start(file, environment,
      { authBoundary: () => {
        if (evidenceUnavailable) throw new Error("synthetic account lookup unavailable");
        return evidence;
      } });
    try {
      expect((await service.dashboardSnapshot()).counts.trackedConversations).toBe(1);
      const previousProcess = service.processId;
      process.kill(previousProcess!, "SIGKILL");
      await waitFor(() => service.health().ready && service.processId !== previousProcess);
      expect((await service.dashboardSnapshot()).counts.trackedConversations).toBe(1);
      evidence = null;
      expect((await service.dashboardSnapshot()).counts.trackedConversations).toBe(1);
      evidenceUnavailable = true;
      expect((await service.dashboardSnapshot()).counts.trackedConversations).toBe(1);
      evidenceUnavailable = false;
      evidence = secondOwner.sessionAuthBoundary();
      expect((await service.dashboardSnapshot()).counts.trackedConversations).toBe(1);
      evidence = firstOwner.sessionAuthBoundary();
      expect((await service.dashboardSnapshot()).counts.trackedConversations).toBe(1);
    } finally {
      await service.close();
      store.close();
    }
  }, 15_000);

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
      // A 50 ms test-only deadline can still expire after SIGCONT when other
      // workers are scheduled. Verify eventual reuse without changing that
      // per-request deadline or accepting a leaked abandoned request.
      let snapshot: Awaited<ReturnType<typeof service.settingsSnapshot>> | undefined;
      const recoveryDeadline = Date.now() + 5_000;
      while (Date.now() < recoveryDeadline && !snapshot) {
        await waitFor(() => service.health().inFlight === 0);
        try {
          snapshot = await service.settingsSnapshot();
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("STATE_READ_STALE")) throw error;
        }
      }
      expect(snapshot).toMatchObject({
        settings: { settingsRevision: 1, uiLocalePreference: "ko" }
      });
      await waitFor(() => service.health().inFlight === 0);
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
