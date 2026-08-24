#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { computeSourceHash } from "./build-fingerprint.mjs";
import {
  parseLauncherArgs,
  resolveLauncherRoots,
  serializeLauncherRoots
} from "./launcher-options.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = parseLauncherArgs(process.argv.slice(2));
const mode = args.mode || process.env.CODEX_MCP_BRIDGE_MODE || "local";
const port = String(args.port || process.env.CODEX_MCP_BRIDGE_PORT || "8876");
const host = "127.0.0.1";
const localOriginUrl = `http://${host}:${port}`;
const localMcpUrl = `${localOriginUrl}/mcp`;
const children = new Set();
let shuttingDown = false;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  cleanup(1);
});

async function main() {
  if (args.help) {
    printHelp();
    return;
  }
  if (mode !== "local" && mode !== "secure") {
    throw new Error(`Unknown mode: ${mode}. Use local or secure.`);
  }
  const roots = resolveLauncherRoots(args.roots);

  ensurePrerequisites();
  ensureBuilt();
  startBridge(roots);
  await waitForHealth(`${localOriginUrl}/healthz`);

  if (mode === "local") {
    console.log(`Local MCP endpoint: ${localMcpUrl}`);
    console.log("This endpoint is loopback-only. Press Ctrl-C to stop.");
    await waitForever();
    return;
  }

  await startSecureTunnel();
}

function ensurePrerequisites() {
  const codex = spawnSync(process.env.CODEX_MCP_BRIDGE_CODEX || "codex", ["mcp-server", "--help"], {
    encoding: "utf8"
  });
  if (codex.status !== 0) {
    throw new Error("Codex CLI with mcp-server support is required and must be available in PATH.");
  }
}

function ensureBuilt() {
  const cliPath = resolve(repoRoot, "dist/cli.js");
  if (args.noBuild && buildMatchesSource(cliPath)) return;
  if (args.noBuild && existsSync(cliPath)) {
    console.log("Built output does not match the current source; rebuilding before startup.");
  } else if (args.noBuild) {
    console.log("Built output is missing; building once before startup.");
  }
  const result = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("Build failed. Run npm run build for details.");
  }
}

function buildMatchesSource(cliPath) {
  if (!existsSync(cliPath)) return false;
  try {
    const buildInfo = JSON.parse(readFileSync(resolve(repoRoot, "dist/build-info.json"), "utf8"));
    return buildInfo.sourceHash === computeSourceHash(repoRoot);
  } catch {
    return false;
  }
}

async function startSecureTunnel() {
  const tunnelId = args.tunnelId || process.env.CONTROL_PLANE_TUNNEL_ID;
  if (!tunnelId) {
    throw new Error("Secure mode needs --tunnel-id or CONTROL_PLANE_TUNNEL_ID.");
  }
  if (!process.env.CONTROL_PLANE_API_KEY) {
    throw new Error("Secure mode needs CONTROL_PLANE_API_KEY.");
  }

  const tunnelClient = args.tunnelClient || process.env.TUNNEL_CLIENT || defaultTunnelClient();
  const profile = args.profile || process.env.TUNNEL_CLIENT_PROFILE || "codex-mcp-bridge";
  const init = spawnSync(
    tunnelClient,
    [
      "init",
      "--sample",
      "sample_mcp_remote_no_auth",
      "--profile",
      profile,
      "--tunnel-id",
      tunnelId,
      "--mcp-server-url",
      localMcpUrl,
      "--force",
      "--health-listen-addr",
      "127.0.0.1:0"
    ],
    { cwd: repoRoot, stdio: "inherit" }
  );
  if (init.status !== 0) throw new Error("tunnel-client init failed.");

  const doctor = spawnSync(tunnelClient, ["doctor", "--profile", profile, "--explain"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (doctor.stdout) process.stdout.write(doctor.stdout);
  if (doctor.stderr) process.stderr.write(doctor.stderr);
  if (doctor.status !== 0 && !isIgnorableNoAuthDoctorFailure(`${doctor.stdout || ""}\n${doctor.stderr || ""}`)) {
    throw new Error("tunnel-client doctor failed. Fix the tunnel or API-key setup first.");
  }

  const mcpConcurrency =
    process.env.MCP_MAX_CONCURRENT_REQUESTS ||
    process.env.CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS ||
    "30";
  const controlPlaneInflight = process.env.CONTROL_PLANE_MAX_INFLIGHT_REQUESTS || mcpConcurrency;
  const logLevel = process.env.LOG_LEVEL || "warn";
  spawnChild(tunnelClient, [
    "run",
    "--profile",
    profile,
    "--mcp.max-concurrent-requests",
    mcpConcurrency,
    "--control-plane.max-inflight",
    controlPlaneInflight,
    "--log.level",
    logLevel
  ]);
  console.log(`Secure MCP Tunnel is running with profile ${profile}.`);
  console.log(
    `Tunnel limits: ${mcpConcurrency} active MCP requests, ${controlPlaneInflight} buffered control-plane requests.`
  );
  console.log(`Select tunnel ${tunnelId} in the ChatGPT developer-mode connection.`);
  await waitForever();
}

function startBridge(roots) {
  const env = {
    ...process.env,
    CODEX_MCP_BRIDGE_HOST: host,
    CODEX_MCP_BRIDGE_PORT: port,
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_ROOTS: serializeLauncherRoots(roots),
    CODEX_MCP_BRIDGE_ALLOWED_HOSTS: "127.0.0.1,localhost"
  };
  if (args.write) {
    env.CODEX_MCP_BRIDGE_ALLOW_WRITE = "1";
    env.CODEX_MCP_BRIDGE_DEFAULT_SANDBOX = "workspace-write";
  } else if (args.allowFullAccess) {
    env.CODEX_MCP_BRIDGE_ALLOW_WRITE = "1";
    env.CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS = "1";
    env.CODEX_MCP_BRIDGE_DEFAULT_SANDBOX = "read-only";
  } else if (args.allowWrite) {
    env.CODEX_MCP_BRIDGE_ALLOW_WRITE = "1";
    env.CODEX_MCP_BRIDGE_DEFAULT_SANDBOX = "read-only";
  } else {
    env.CODEX_MCP_BRIDGE_DEFAULT_SANDBOX = "read-only";
  }
  return spawnChild("node", [resolve(repoRoot, "dist/cli.js")], { env });
}

function spawnChild(command, childArgs, options = {}) {
  const child = spawn(command, childArgs, {
    cwd: repoRoot,
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(child);
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(`${command} exited unexpectedly with code ${code ?? "unknown"}.`);
      cleanup(typeof code === "number" && code > 0 ? code : 1);
    }
  });
  child.on("error", (error) => {
    if (!shuttingDown) {
      console.error(`Could not start ${command}: ${error.message}`);
      cleanup(1);
    }
  });
  return child;
}

async function waitForHealth(url) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const result = spawnSync("curl", ["-fsS", "--max-time", "5", url], { encoding: "utf8" });
    if (result.status === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function defaultTunnelClient() {
  const localBinary = resolve(homedir(), ".local/bin/tunnel-client");
  return existsSync(localBinary) ? localBinary : "tunnel-client";
}

function isIgnorableNoAuthDoctorFailure(output) {
  const failedChecksLine = output.match(/^FAILED_CHECKS\s+(.+)$/m);
  const failedChecks = failedChecksLine ? failedChecksLine[1].trim().split(/\s+/) : [];
  const oauthOnly = failedChecks.length === 1 && failedChecks[0] === "oauth_metadata";
  const reachable = output.includes("mcp_server_reachable") && output.includes("PASS");
  return oauthOnly && reachable;
}

function printHelp() {
  console.log(`Usage:
  npm run bridge:local -- --root /absolute/repo
  npm run bridge:local -- --root /absolute/repo-a --root /absolute/repo-b
  npm run bridge:secure -- --root /absolute/repo --tunnel-id tunnel_...

Options:
  --root <path>          Allowed repository root. Repeat for multiple roots; defaults to cwd.
  --write                Enable workspace-write for this process.
  --allow-write          Keep read-only as the default, but allow explicit workspace-write calls.
  --allow-full-access    Keep read-only as the default, but allow workspace-write and danger-full-access calls.
  --tunnel-id <id>       OpenAI Secure MCP Tunnel id.
  --profile <name>       tunnel-client profile name.
  --tunnel-client <path> tunnel-client binary path.
  --port <port>          Loopback HTTP port. Defaults to 8876.
  --no-build             Reuse dist only when its source fingerprint is current.`);
}

function cleanup(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGINT");
  setTimeout(() => process.exit(code), 200);
}

function waitForever() {
  return new Promise(() => {});
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));
