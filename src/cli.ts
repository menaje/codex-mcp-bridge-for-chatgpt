#!/usr/bin/env node
import { createExecutionRuntime } from "./executionRuntime.js";
import { loadConfig } from "./config.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { createHttpServer } from "./server.js";
import { AppServerLateResponseJournal } from "./appServerLateResponses.js";
import { PRODUCT_INFO } from "./productInfo.js";
import { BridgeStateStore } from "./stateStore.js";
import { startRuntimeCompanions } from "./runtimeCompanions.js";

if (process.platform === "darwin") {
  process.title = "Codex MCP Bridge Server";
}

const config = loadConfig();
const stateStore = new BridgeStateStore({ file: config.stateDatabaseFile });
const appServerLateResponses = new AppServerLateResponseJournal(stateStore);
const upstream = createExecutionRuntime(config, {
  onLateResponse: (response) => appServerLateResponses.observe(response)
});
const server = createHttpServer(config, upstream, undefined, {
  stateStore,
  healthDiagnostics: () => ({
    appServerLateResponses: appServerLateResponses.status()
  })
});
let shuttingDown = false;
let companions: Awaited<ReturnType<typeof startRuntimeCompanions>> | undefined;

for (const warning of config.startupWarnings) console.warn(`warning: ${warning}`);

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  void shutdown("startup failure", 1);
});

async function main(): Promise<void> {
  companions = await startRuntimeCompanions(config, server.applicationService);
  if (shuttingDown) { await companions.close(); return; }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const authHint = config.token && !config.noAuth ? "Bearer token required" : "no auth";
  console.log(`${PRODUCT_INFO.displayName} listening on http://${config.host}:${config.port}/mcp (${authHint})`);
  console.log(`build: ${BRIDGE_BUILD_INFO.id} (${BRIDGE_BUILD_INFO.version})`);
}

async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  for (const [name, close] of [
    ["companions", () => companions?.close()],
    ["HTTP server", () => new Promise<void>((resolve, reject) => server.close(error =>
      error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()))],
    ["Codex upstream", () => upstream.close()],
    ["bridge state", () => stateStore.close()]
  ] as const) {
    try { await close(); }
    catch (error) { code = 1; console.error(`${name} shutdown failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
