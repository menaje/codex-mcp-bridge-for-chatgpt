import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";
import { startBridgeCompanionServer } from "../src/companionServer.js";
import type {
  CodexModelCatalogProvider,
  CodexModelCatalogSnapshot,
  ModelCatalogOptions
} from "../src/modelCatalog.js";
import { createHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";

type FixtureMessage =
  | { type: "ready"; port: number; socketPath: string; stateFile: string }
  | { type: "write-started"; at: number }
  | { type: "write-finished"; startedAt: number; finishedAt: number; durationMs: number; error: string | null }
  | { type: "timer-fired"; scheduledAt: number; firedAt: number; delayMs: number }
  | { type: "closed" };

const CHILD_FLAG = "--fixture-child";

async function runCharacterization(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "issue-143-reliability-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), CHILD_FLAG, root],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  let childOutput = "";
  child.stdout?.on("data", chunk => { childOutput += chunk; });
  child.stderr?.on("data", chunk => { childOutput += chunk; });

  try {
    const ready = await waitForMessage(child, "ready", 15_000);
    const baselineHttp = await probeHttp(ready.port, 2_000);
    const baselineCompanion = await companionRequest(ready.socketPath, "runtime.health", 2_000);
    assert.equal(baselineHttp.statusCode, 200);
    assert.equal(baselineCompanion.ok, true);

    const locker = new Database(ready.stateFile);
    let lockReleased = false;
    try {
      locker.pragma("busy_timeout = 5000");
      locker.exec("BEGIN IMMEDIATE");
      child.send({ type: "block-write" });
      const writeStarted = await waitForMessage(child, "write-started", 5_000);

      const lockHoldMs = 3_200;
      const releaseTimer = setTimeout(() => {
        locker.exec("COMMIT");
        lockReleased = true;
      }, lockHoldMs);

      const blockedHttpPromise = probeHttp(ready.port, 6_000);
      const blockedCompanionPromise = companionRequest(ready.socketPath, "runtime.health", 2_000);
      const [blockedHttp, blockedCompanion, writeFinished, timerFired] = await Promise.all([
        blockedHttpPromise,
        blockedCompanionPromise,
        waitForMessage(child, "write-finished", 7_000),
        waitForMessage(child, "timer-fired", 7_000)
      ]);
      clearTimeout(releaseTimer);
      if (!lockReleased) {
        locker.exec("COMMIT");
        lockReleased = true;
      }

      assert.equal(writeFinished.error, null);
      assert.ok(writeFinished.durationMs >= lockHoldMs - 250, `write blocked only ${writeFinished.durationMs} ms`);
      assert.equal(blockedHttp.statusCode, 200);
      assert.ok(blockedHttp.durationMs >= lockHoldMs - 250, `HTTP health delayed only ${blockedHttp.durationMs} ms`);
      assert.equal(blockedCompanion.ok, false);
      assert.equal(blockedCompanion.error, "timeout");
      assert.ok(timerFired.delayMs >= lockHoldMs - 250, `event-loop timer delayed only ${timerFired.delayMs} ms`);

      const recoveredHttp = await probeHttp(ready.port, 2_000);
      const recoveredCompanion = await companionRequest(ready.socketPath, "runtime.health", 2_000);
      assert.equal(recoveredHttp.statusCode, 200);
      assert.equal(recoveredCompanion.ok, true);

      const report = {
        issue: 143,
        kind: "failure-characterization",
        testedAt: new Date().toISOString(),
        source: "current checkout",
        database: "disposable schema-24 fixture",
        productionDatabaseModified: false,
        scenario: {
          lock: "separate SQLite connection BEGIN IMMEDIATE",
          blockedOperation: "BridgeStateStore.setMeta on the bridge process",
          lockHoldMs,
          configuredBusyTimeoutMs: 5_000,
          helperRuntimeHealthTimeoutMs: 2_000
        },
        baseline: {
          healthzMs: rounded(baselineHttp.durationMs),
          runtimeHealthMs: rounded(baselineCompanion.durationMs)
        },
        contention: {
          writeDurationMs: rounded(writeFinished.durationMs),
          healthzMs: rounded(blockedHttp.durationMs),
          runtimeHealth: {
            outcome: blockedCompanion.error,
            durationMs: rounded(blockedCompanion.durationMs)
          },
          eventLoopTimerDelayMs: rounded(timerFired.delayMs),
          writeStartedAt: writeStarted.at
        },
        recovery: {
          healthzMs: rounded(recoveredHttp.durationMs),
          runtimeHealthMs: rounded(recoveredCompanion.durationMs)
        },
        conclusion: [
          "runtime.health is memory-only but cannot respond while synchronous SQLite blocks the bridge event loop",
          "the macOS two-second runtime.health deadline can expire while the bridge process remains alive",
          "an HTTP health handler on the same event loop is delayed by the same database wait",
          "releasing the database lock restores both response paths without restarting the process"
        ],
        limits: [
          "this controlled fault proves a structural failure mode, not that SQLite locking caused the reported incident",
          "the fixture does not exercise the Secure MCP Tunnel or ChatGPT host round trip",
          "CPU, memory pressure, filesystem stalls, and large JSON work require separate fault cases"
        ],
        failureReproduced: true,
        resolutionVerified: false,
        temporaryFixtureRemoved: true
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } finally {
      if (!lockReleased && locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
    }
  } catch (error) {
    if (childOutput) process.stderr.write(childOutput);
    throw error;
  } finally {
    if (child.connected) {
      child.send({ type: "close" });
      await waitForMessage(child, "closed", 3_000).catch(() => undefined);
    }
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => child.once("exit", () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function runFixtureChild(root: string): Promise<void> {
  const stateFile = path.join(root, "state.sqlite");
  const socketPath = path.join(root, "bridge.sock");
  const config = loadConfig({
    ...process.env,
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_PORT: "8876",
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: stateFile,
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
  });
  const store = new BridgeStateStore({ file: stateFile });
  const server = createHttpServer(config, new FixtureUpstream(), new FixtureCatalog(), { stateStore: store });
  const companion = await startBridgeCompanionServer({
    socketPath,
    applicationService: server.applicationService
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture HTTP address is unavailable.");
  send({ type: "ready", port: address.port, socketPath, stateFile });

  process.on("message", message => {
    if (!message || typeof message !== "object") return;
    const type = (message as { type?: unknown }).type;
    if (type === "block-write") {
      const scheduledAt = performance.now();
      setTimeout(() => {
        const firedAt = performance.now();
        send({
          type: "timer-fired",
          scheduledAt,
          firedAt,
          delayMs: firedAt - scheduledAt
        });
      }, 10);
      const startedAt = performance.now();
      send({ type: "write-started", at: startedAt });
      let error: string | null = null;
      try {
        store.setMeta("issue_143_contention_probe", randomUUID());
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const finishedAt = performance.now();
      send({
        type: "write-finished",
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        error
      });
      return;
    }
    if (type === "close") {
      void (async () => {
        await companion.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        store.close();
        send({ type: "closed" });
        process.disconnect?.();
      })();
    }
  });
}

class FixtureUpstream implements CodexUpstream {
  async listTools(): Promise<unknown> { return { tools: [] }; }
  async callTool(): Promise<ToolResult> {
    return { content: [{ type: "text", text: "fixture" }] };
  }
  async close(): Promise<void> {}
}

class FixtureCatalog implements CodexModelCatalogProvider {
  private readonly snapshot: CodexModelCatalogSnapshot = {
    source: "codex-cli",
    fetchedAt: "2026-09-21T00:00:00.000Z",
    validatedAt: "2026-09-21T00:00:00.000Z",
    fingerprint: "a".repeat(64),
    cached: true,
    stale: false,
    validation: "valid",
    models: [{
      id: "gpt-5.6-sol",
      displayName: "Fixture",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ effort: "medium" }],
      serviceTiers: [],
      inputModalities: ["text"]
    }]
  };

  async getCatalog(_options: ModelCatalogOptions = {}): Promise<CodexModelCatalogSnapshot> {
    return this.snapshot;
  }

  getCachedCatalog(): CodexModelCatalogSnapshot { return this.snapshot; }
}

function send(message: FixtureMessage): void {
  if (process.send) process.send(message);
}

function waitForMessage<T extends FixtureMessage["type"]>(
  child: ChildProcess,
  type: T,
  timeoutMs: number
): Promise<Extract<FixtureMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for fixture message: ${type}`)), timeoutMs);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== type) return;
      finish(undefined, message as Extract<FixtureMessage, { type: T }>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Fixture child exited before ${type}: code=${code} signal=${signal}`));
    };
    const finish = (error?: Error, message?: Extract<FixtureMessage, { type: T }>) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(message!);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function probeHttp(port: number, timeoutMs: number): Promise<{ statusCode: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = httpRequest({ host: "127.0.0.1", port, path: "/healthz", method: "GET" }, response => {
      response.resume();
      response.once("end", () => resolve({
        statusCode: response.statusCode || 0,
        durationMs: performance.now() - started
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("HTTP timeout")));
    request.once("error", reject);
    request.end();
  });
}

function companionRequest(
  socketPath: string,
  method: string,
  timeoutMs: number
): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  return new Promise(resolve => {
    const started = performance.now();
    const socket = createConnection(socketPath);
    let buffer = "";
    const finish = (ok: boolean, error?: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok, durationMs: performance.now() - started, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", error => finish(false, error.message));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: method, method, params: {} })}\n`);
    });
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const response = JSON.parse(buffer.split("\n")[0]!) as { error?: { message?: string } };
      finish(!response.error, response.error?.message);
    });
  });
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

const rootArgument = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
if (process.argv.includes(CHILD_FLAG)) {
  if (!rootArgument) throw new Error("Fixture child root is required.");
  await runFixtureChild(rootArgument);
} else {
  await runCharacterization();
}
