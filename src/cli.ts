#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { createHttpServer } from "./server.js";
import { CodexUpstreamPool } from "./upstream.js";
import { CodexAppServerUpstreamPool } from "./appServerUpstream.js";
import { AppServerLateResponseJournal } from "./appServerLateResponses.js";
import { CodexBackendRouter } from "./upstreamRouter.js";
import { PRODUCT_INFO } from "./productInfo.js";
import { BridgeStateStore } from "./stateStore.js";

const config = loadConfig();
const stateStore = new BridgeStateStore({ file: config.stateDatabaseFile });
const appServerLateResponses = new AppServerLateResponseJournal(stateStore);
const upstream = new CodexBackendRouter(
  config.defaultBackend,
  new CodexUpstreamPool(config.codexCommand, config.upstreamPoolSize),
  new CodexAppServerUpstreamPool(config.codexCommand, config.upstreamPoolSize, {
    onLateResponse: (response) => appServerLateResponses.observe(response)
  })
);
const server = createHttpServer(config, upstream, undefined, {
  stateStore,
  healthDiagnostics: () => ({
    appServerLateResponses: appServerLateResponses.status()
  })
});
let shuttingDown = false;

for (const warning of config.startupWarnings) console.warn(`warning: ${warning}`);

server.listen(config.port, config.host, () => {
  const authHint = config.token && !config.noAuth ? "Bearer token required" : "no auth";
  console.log(`${PRODUCT_INFO.displayName} listening on http://${config.host}:${config.port}/mcp (${authHint})`);
  console.log(`build: ${BRIDGE_BUILD_INFO.id} (${BRIDGE_BUILD_INFO.version})`);
  console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await upstream.close();
  } finally {
    stateStore.close();
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
