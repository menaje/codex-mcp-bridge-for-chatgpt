#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = parseArgs(process.argv.slice(2));
const mode = args.mode || process.env.CODEX_MCP_BRIDGE_MODE || "local";
const root = resolve(args.root || process.cwd());
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

  ensurePrerequisites();
  ensureBuilt();
  startBridge();
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
  if (args.noBuild && existsSync(cliPath)) return;
  if (args.noBuild) {
    console.log("dist/cli.js is missing; building once before startup.");
  }
  const result = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("Build failed. Run npm run build for details.");
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

function startBridge() {
  const env = {
    ...process.env,
    CODEX_MCP_BRIDGE_HOST: host,
    CODEX_MCP_BRIDGE_PORT: port,
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_ROOTS: root,
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

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--no-build") parsed.noBuild = true;
    else if (arg === "--write") parsed.write = true;
    else if (arg === "--allow-full-access") parsed.allowFullAccess = true;
    else if (arg === "--allow-write") parsed.allowWrite = true;
    else if (arg === "--mode") parsed.mode = rawArgs[++index];
    else if (arg === "--root") parsed.root = rawArgs[++index];
    else if (arg === "--port") parsed.port = rawArgs[++index];
    else if (arg === "--tunnel-id") parsed.tunnelId = rawArgs[++index];
    else if (arg === "--profile") parsed.profile = rawArgs[++index];
    else if (arg === "--tunnel-client") parsed.tunnelClient = rawArgs[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  npm run bridge:local -- --root /absolute/repo
  npm run bridge:secure -- --root /absolute/repo --tunnel-id tunnel_...

Options:
  --root <path>          Only allowed repository root. Defaults to cwd.
  --write                Enable workspace-write for this process.
  --allow-write          Keep read-only as the default, but allow explicit workspace-write calls.
  --allow-full-access    Keep read-only as the default, but allow workspace-write and danger-full-access calls.
  --tunnel-id <id>       OpenAI Secure MCP Tunnel id.
  --profile <name>       tunnel-client profile name.
  --tunnel-client <path> tunnel-client binary path.
  --port <port>          Loopback HTTP port. Defaults to 8876.
  --no-build             Skip the build step.`);
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
