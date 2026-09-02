#!/usr/bin/env node
import { CodexAppServerUpstreamPool } from "./appServerUpstream.js";
import { AppServerLateResponseJournal } from "./appServerLateResponses.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { loadConfig } from "./config.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  startBridgeCompanionServer,
  type BridgeCompanionServer
} from "./companionServer.js";
import { createStdioBridgeRuntime } from "./stdioServer.js";
import { BridgeStateStore } from "./stateStore.js";
import { CodexUpstreamPool } from "./upstream.js";
import { CodexBackendRouter } from "./upstreamRouter.js";

// stdio has no HTTP authentication boundary. Force the same loopback/no-auth
// configuration used behind Secure MCP Tunnel while retaining every execution,
// project, model, and persistence policy from the operator environment.
const config = loadConfig({
  ...process.env,
  CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
  CODEX_MCP_BRIDGE_NO_AUTH: "1"
});
const stateStore = new BridgeStateStore({ file: config.stateDatabaseFile });
const appServerLateResponses = new AppServerLateResponseJournal(stateStore);
const upstream = new CodexBackendRouter(
  config.defaultBackend,
  new CodexUpstreamPool(config.codexCommand, config.upstreamPoolSize),
  new CodexAppServerUpstreamPool(config.codexCommand, config.upstreamPoolSize, {
    onLateResponse: (response) => appServerLateResponses.observe(response)
  })
);
const runtime = createStdioBridgeRuntime(config, upstream, { stateStore });
let companionServer: BridgeCompanionServer | undefined;
let shuttingDown = false;

for (const warning of config.startupWarnings) console.error(`warning: ${warning}`);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  void shutdown("startup failure", 1);
});

async function main(): Promise<void> {
  await runtime.start();
  const companionSocketPath = process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET?.trim();
  if (companionSocketPath) {
    companionServer = await startBridgeCompanionServer({
      socketPath: companionSocketPath,
      applicationService: runtime.applicationService
    });
    console.error(`native companion ready at ${companionServer.socketPath}`);
  }
  console.error(
    `${PRODUCT_INFO.displayName} persistent stdio ready; build ${BRIDGE_BUILD_INFO.id} ` +
    `(${BRIDGE_BUILD_INFO.version})`
  );
}

async function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`received ${reason}, shutting down persistent stdio`);
  let exitCode = code;
  try {
    await companionServer?.close();
  } catch (error) {
    exitCode = 1;
    console.error(`native companion shutdown failed: ${errorMessage(error)}`);
  }
  try {
    await runtime.close();
  } catch (error) {
    exitCode = 1;
    console.error(`persistent stdio runtime shutdown failed: ${errorMessage(error)}`);
  }
  try {
    await upstream.close();
  } catch (error) {
    exitCode = 1;
    console.error(`Codex upstream shutdown failed: ${errorMessage(error)}`);
  }
  try {
    stateStore.close();
  } catch (error) {
    exitCode = 1;
    console.error(`bridge state shutdown failed: ${errorMessage(error)}`);
  }
  process.exit(exitCode);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

process.stdin.once("end", () => void shutdown("stdin EOF"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
