import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  createIsolatedHttpServer,
  createIsolatedStdioRuntime
} from "../src/runtimeProcess.js";
import type { BridgeHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";

type RunningRuntime = {
  root: string;
  server: BridgeHttpServer;
  baseUrl: string;
};

const running: RunningRuntime[] = [];

afterEach(async () => {
  for (const item of running.splice(0)) {
    await new Promise<void>(resolve => item.server.close(() => resolve()));
    await rm(item.root, { recursive: true, force: true });
  }
});

async function start(
  onRuntimeProcessSpawn?: (processId: number) => void,
  restartStartupTimeoutMs?: number
): Promise<RunningRuntime> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-runtime-process-"));
  const environment = runtimeEnvironment(root);
  const server = await createIsolatedHttpServer(loadConfig(environment), {
    childEnvironment: environment,
    onRuntimeProcessSpawn,
    restartStartupTimeoutMs
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address.");
  const item = {
    root,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
  running.push(item);
  return item;
}

function runtimeEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
    CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
  };
}

async function waitUntilReady(baseUrl: string, timeoutMs = 8_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let response: Response | undefined;
  while (Date.now() < deadline) {
    response = await fetch(`${baseUrl}/readyz`);
    if (response.status === 200) return response;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Runtime did not recover: ${await response?.text()}`);
}

async function waitUntilCapacity(baseUrl: string, timeoutMs = 8_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let response: Response | undefined;
  while (Date.now() < deadline) {
    response = await fetch(`${baseUrl}/readyz`);
    if (response.status === 503) {
      const body = await response.clone().json() as { reason?: string };
      if (body.reason === "state-capacity") return response;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Runtime did not report capacity: ${await response?.text()}`);
}

async function waitForRuntimeHealth(
  applicationService: BridgeHttpServer["applicationService"],
  stateStatus: string,
  timeoutMs = 8_000,
  additional: () => boolean = () => true
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      applicationService.runtimeHealth?.().stateService?.status === stateStatus &&
      additional()
    ) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Runtime health did not reach ${stateStatus}.`);
}

function openIncompleteMcpRequest(baseUrl: string): Promise<Socket> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = createConnection(Number(url.port), url.hostname);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => {});
      socket.write(
        `POST /mcp HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        "Content-Type: application/json\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "Connection: keep-alive\r\n\r\n" +
        "1\r\n{\r\n"
      );
      resolve(socket);
    });
  });
}

describe("isolated production runtime", () => {
  it("keeps liveness responsive, reports a blocked write, and recovers after the DB lock", async () => {
    const runtime = await start();
    const initialReady = await fetch(`${runtime.baseUrl}/readyz`);
    expect(initialReady.status).toBe(200);
    await expect(runtime.server.applicationService.dashboardSnapshot({
      inspectRuntime: true
    })).resolves.toMatchObject({
      statusRows: expect.any(Array),
      enrichment: { state: "enriched" }
    });
    expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
      readService: { status: "ready", lastSnapshotAt: expect.any(Number) }
    });
    await runtime.server.applicationService.beginDrain();
    const drainDeadline = Date.now() + 2_000;
    while (
      runtime.server.applicationService.runtimeHealth?.().acceptingNewJobs !== false &&
      Date.now() < drainDeadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
      acceptingNewJobs: false,
      stateService: { status: "ready" }
    });
    await expect(fetch(`${runtime.baseUrl}/readyz`).then(response => response.json()))
      .resolves.toMatchObject({ reason: "admission-draining" });
    await runtime.server.applicationService.cancelDrain();
    await waitUntilReady(runtime.baseUrl);

    const current = await runtime.server.applicationService.settingsSnapshot();
    const databaseFile = path.join(runtime.root, "state.sqlite");
    const locker = new Database(databaseFile);
    locker.exec("BEGIN IMMEDIATE");

    try {
      const mutation = runtime.server.applicationService.updateSettings({
        expectedSettingsRevision: current.settings.settingsRevision,
        operation: {
          kind: "patch",
          settings: {
            showBridgeThreadsInCodexApp: !current.settings.showBridgeThreadsInCodexApp
          }
        }
      }).then(
        () => ({ ok: true as const, error: "" }),
        error => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error)
        })
      );

      expect(await mutation).toMatchObject({
        ok: false,
        error: expect.stringContaining("RUNTIME_RESPONSE_UNCONFIRMED")
      });

      const livenessStartedAt = Date.now();
      const liveness = await fetch(`${runtime.baseUrl}/healthz`);
      expect(liveness.status).toBe(200);
      expect(Date.now() - livenessStartedAt).toBeLessThan(500);

      const readiness = await fetch(`${runtime.baseUrl}/readyz`);
      expect(readiness.status).toBe(503);
      expect(await readiness.json()).toMatchObject({
        ok: false,
        reason: "state-stale",
        limitations: ["state-write-unconfirmed"],
        stateService: {
          activeOperation: {
            access: "write",
            operation: "state-transaction",
            phase: "write-lock-wait"
          }
        }
      });

      expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
        acceptingNewJobs: false,
        backgroundProcessState: "unknown",
        readService: { status: "read-stale" },
        telemetryService: { status: "stale" },
        stateService: {
          status: "state-stale",
          activeOperation: {
            access: "write",
            phase: "write-lock-wait"
          }
        }
      });
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }

    const recovered = await waitUntilReady(runtime.baseUrl);
    expect(await recovered.json()).toMatchObject({ ok: true, reason: "ready" });
    await expect(runtime.server.applicationService.settingsSnapshot()).resolves.toMatchObject({
      settings: { settingsRevision: current.settings.settingsRevision + 1 }
    });
  }, 15_000);

  it("keeps the stdio companion boundary responsive during the same DB lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-runtime-stdio-"));
    const environment = runtimeEnvironment(root);
    const input = new PassThrough();
    const output = new PassThrough();
    const processIds: number[] = [];
    output.resume();
    const runtime = await createIsolatedStdioRuntime(loadConfig(environment), {
      childEnvironment: environment,
      input,
      output,
      onRuntimeProcessSpawn: processId => processIds.push(processId)
    });
    const current = await runtime.applicationService.settingsSnapshot();
    const locker = new Database(path.join(root, "state.sqlite"));
    try {
      locker.exec("BEGIN IMMEDIATE");
      try {
        const mutation = runtime.applicationService.updateSettings({
          expectedSettingsRevision: current.settings.settingsRevision,
          operation: {
            kind: "patch",
            settings: {
              showBridgeThreadsInCodexApp: !current.settings.showBridgeThreadsInCodexApp
            }
          }
        });
        await expect(mutation).rejects.toThrow(/RUNTIME_RESPONSE_UNCONFIRMED/);
        expect(runtime.applicationService.runtimeHealth?.()).toMatchObject({
          acceptingNewJobs: false,
          stateService: {
            status: "state-stale",
            activeOperation: { access: "write", phase: "write-lock-wait" }
          }
        });
      } finally {
        locker.exec("ROLLBACK");
        locker.close();
      }

      await waitForRuntimeHealth(runtime.applicationService, "ready");
      expect(processIds).toHaveLength(1);
      process.kill(processIds[0]!, "SIGKILL");
      await waitForRuntimeHealth(runtime.applicationService, "ready", 12_000, () =>
        processIds.length >= 2
      );
      await expect(runtime.applicationService.settingsSnapshot()).resolves.toMatchObject({
        settings: { settingsRevision: current.settings.settingsRevision + 1 }
      });
    } finally {
      if (locker.open) locker.close();
      await runtime.close();
      input.end();
      output.destroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("reserves native control capacity when incomplete MCP requests saturate the proxy", async () => {
    const runtime = await start();
    const sockets: Socket[] = [];
    try {
      const oversized = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(8 * 1024 * 1024 + 1)
      });
      expect(oversized.status).toBe(413);
      await expect(oversized.json()).resolves.toMatchObject({
        code: "RUNTIME_REQUEST_TOO_LARGE",
        reason: "request-bytes"
      });

      for (let index = 0; index < 112; index += 1) {
        sockets.push(await openIncompleteMcpRequest(runtime.baseUrl));
      }
      const capacity = await waitUntilCapacity(runtime.baseUrl);
      await expect(capacity.json()).resolves.toMatchObject({
        ok: false,
        reason: "state-capacity"
      });

      await expect(runtime.server.applicationService.settingsSnapshot()).resolves.toMatchObject({
        settings: { settingsRevision: expect.any(Number) }
      });
      const rejected = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      expect(rejected.status).toBe(503);
      await expect(rejected.json()).resolves.toMatchObject({
        code: "RUNTIME_RESPONSE_UNCONFIRMED",
        reason: "state-capacity"
      });
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  }, 20_000);

  it("recovers a killed runtime without claiming an in-flight write committed", async () => {
    const processIds: number[] = [];
    const runtime = await start(processId => processIds.push(processId));
    const current = await runtime.server.applicationService.settingsSnapshot();
    const locker = new Database(path.join(runtime.root, "state.sqlite"));
    locker.exec("BEGIN IMMEDIATE");
    try {
      const mutation = runtime.server.applicationService.updateSettings({
        expectedSettingsRevision: current.settings.settingsRevision,
        operation: {
          kind: "patch",
          settings: {
            showBridgeThreadsInCodexApp: !current.settings.showBridgeThreadsInCodexApp
          }
        }
      }).then(
        () => ({ ok: true as const, error: "" }),
        error => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error)
        })
      );
      const deadline = Date.now() + 3_000;
      while (
        runtime.server.applicationService.runtimeHealth?.().stateService?.activeOperation?.phase !==
          "write-lock-wait" &&
        Date.now() < deadline
      ) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
        stateService: { activeOperation: { phase: "write-lock-wait" } }
      });
      expect(processIds).toHaveLength(1);
      process.kill(processIds[0]!, "SIGKILL");
      expect(await mutation).toMatchObject({
        ok: false,
        error: expect.stringMatching(/RUNTIME_(?:OUTCOME_UNKNOWN|RESPONSE_UNCONFIRMED)/)
      });
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }

    await waitUntilReady(runtime.baseUrl, 12_000);
    expect(processIds.length).toBeGreaterThanOrEqual(2);
    await expect(runtime.server.applicationService.settingsSnapshot()).resolves.toMatchObject({
      settings: { settingsRevision: current.settings.settingsRevision }
    });
    await expect(runtime.server.applicationService.updateSettings({
      expectedSettingsRevision: current.settings.settingsRevision,
      operation: {
        kind: "patch",
        settings: {
          showBridgeThreadsInCodexApp: !current.settings.showBridgeThreadsInCodexApp
        }
      }
    })).resolves.toMatchObject({
      settings: { settingsRevision: current.settings.settingsRevision + 1 }
    });
  }, 25_000);

  it("continues recovery when a replacement runtime misses its startup deadline", async () => {
    const processIds: number[] = [];
    const runtime = await start(processId => {
      processIds.push(processId);
      if (processIds.length === 2) process.kill(processId, "SIGSTOP");
    }, 2_500);

    expect(processIds).toHaveLength(1);
    process.kill(processIds[0]!, "SIGKILL");
    const replacementDeadline = Date.now() + 8_000;
    while (processIds.length < 3 && Date.now() < replacementDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(processIds.length).toBeGreaterThanOrEqual(3);
    await waitUntilReady(runtime.baseUrl, 8_000);

    await expect(runtime.server.applicationService.settingsSnapshot()).resolves.toMatchObject({
      settings: { settingsRevision: expect.any(Number) }
    });
  }, 12_000);

  it("keeps the operational database rollback-compatible and rebuilds telemetry independently", async () => {
    const runtime = await start();
    const environment = runtimeEnvironment(runtime.root);
    const config = loadConfig(environment);
    const initial = await runtime.server.applicationService.settingsSnapshot();
    await expect(runtime.server.applicationService.updateSettings({
      expectedSettingsRevision: initial.settings.settingsRevision,
      operation: {
        kind: "patch",
        settings: { uiLocalePreference: "ko" }
      }
    })).resolves.toMatchObject({
      settings: { settingsRevision: initial.settings.settingsRevision + 1 }
    });
    await new Promise<void>(resolve => runtime.server.close(() => resolve()));

    const rollbackStore = new BridgeStateStore({ file: config.stateDatabaseFile });
    try {
      const rollbackSettings = new UserSettingsStore(config, { stateStore: rollbackStore });
      expect(rollbackSettings.current).toMatchObject({
        settingsRevision: initial.settings.settingsRevision + 1,
        uiLocalePreference: "ko"
      });
    } finally {
      rollbackStore.close();
    }

    await Promise.all([
      rm(config.telemetryDatabaseFile, { force: true }),
      rm(`${config.telemetryDatabaseFile}-wal`, { force: true }),
      rm(`${config.telemetryDatabaseFile}-shm`, { force: true })
    ]);
    const restarted = await createIsolatedHttpServer(config, {
      childEnvironment: environment
    });
    await new Promise<void>((resolve, reject) => {
      restarted.once("error", reject);
      restarted.listen(0, "127.0.0.1", () => {
        restarted.removeListener("error", reject);
        resolve();
      });
    });
    const address = restarted.address();
    if (!address || typeof address === "string") throw new Error("Missing restart address.");
    runtime.server = restarted;
    runtime.baseUrl = `http://127.0.0.1:${address.port}`;
    await waitUntilReady(`http://127.0.0.1:${address.port}`);
    await expect(restarted.applicationService.settingsSnapshot()).resolves.toMatchObject({
      settings: {
        settingsRevision: initial.settings.settingsRevision + 1,
        uiLocalePreference: "ko"
      }
    });
    expect(restarted.applicationService.runtimeHealth?.()).toMatchObject({
      telemetryService: { status: "ready" }
    });
  }, 25_000);
});
