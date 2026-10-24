#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolVersion = "2026-07-28";
const conformanceVersion = "0.2.0-alpha.11";
const stateDirectory = await mkdtemp(path.join(tmpdir(), "codex-mcp-conformance-state-"));
const outputDirectory = process.env.MCP_CONFORMANCE_OUTPUT_DIR || await mkdtemp(
  path.join(tmpdir(), "codex-mcp-conformance-output-")
);
const port = await reserveLoopbackPort();
const endpoint = `http://127.0.0.1:${port}/mcp`;
const bridge = spawn(process.execPath, ["dist/cli.js", "--conformance-fixtures"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_PORT: String(port),
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(stateDirectory, "state.sqlite"),
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(stateDirectory, "models.json")
  },
  stdio: ["ignore", "pipe", "pipe"]
});

for (const stream of [bridge.stdout, bridge.stderr]) {
  stream?.on("data", (chunk) => process.stderr.write(chunk));
}

try {
  await waitForHealth(endpoint);
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const exitCode = await exitCodeOf(spawn(npx, [
    "--yes",
    `@modelcontextprotocol/conformance@${conformanceVersion}`,
    "server",
    "--url", endpoint,
    "--spec-version", protocolVersion,
    "--scenario", "server-stateless",
    "--output-dir", outputDirectory
  ], {
    cwd: repoRoot,
    stdio: "inherit"
  }));
  if (exitCode !== 0) {
    throw new Error(`MCP conformance failed with exit code ${exitCode}.`);
  }
  console.log(`MCP ${protocolVersion} conformance passed. Artifact: ${outputDirectory}`);
} finally {
  await stop(bridge);
  await rm(stateDirectory, { recursive: true, force: true });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve an IPv4 loopback port for MCP conformance.");
  }
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForHealth(endpoint) {
  const health = new URL("/healthz", endpoint);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(health);
      if (response.ok) return;
    } catch {
      // The candidate process has not bound the temporary loopback port yet.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Candidate bridge did not become healthy at ${health}.`);
}

async function exitCodeOf(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = exitCodeOf(child);
  child.kill("SIGINT");
  const timeout = new Promise(resolve => setTimeout(resolve, 5_000));
  if (await Promise.race([exited.then(() => true), timeout.then(() => false)])) return;
  child.kill("SIGKILL");
  await exited;
}
