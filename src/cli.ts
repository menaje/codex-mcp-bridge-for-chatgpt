#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { createHttpServer } from "./server.js";
import { CodexUpstreamPool } from "./upstream.js";

const config = loadConfig();
const upstream = new CodexUpstreamPool(config.codexCommand, config.upstreamPoolSize);
const server = createHttpServer(config, upstream);
let shuttingDown = false;

server.listen(config.port, config.host, () => {
  const authHint = config.token && !config.noAuth ? "Bearer token required" : "no auth";
  console.log(`codex-mcp-bridge listening on http://${config.host}:${config.port}/mcp (${authHint})`);
  console.log(`build: ${BRIDGE_BUILD_INFO.id} (${BRIDGE_BUILD_INFO.version})`);
  console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await upstream.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
