#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { computeSourceHash } from "./build-fingerprint.mjs";
import { parseLauncherArgs, requiredBuildOutputs } from "./launcher-options.mjs";
import {
  loadRuntimeEnvFile,
  resolveRuntimeEnvFile,
  validateSecureTunnelEnvironment
} from "./runtime-env.mjs";
import {
  acquireRuntimeLock,
  defaultRuntimeLockDirectory
} from "./runtime-lock.mjs";
import { terminateManagedChildren } from "./child-shutdown.mjs";
import {
  defaultTunnelProfileMetadataFile,
  expectedTunnelProfileIdentity,
  inspectReusableTunnelProfile,
  readTunnelClientVersion,
  recordTunnelProfileMetadata
} from "./tunnel-profile.mjs";
import { writeManagedRuntimeStatus } from "./runtime-status.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const MANAGED_APP_RUNTIME_EXACT_KEYS = new Set([
  "CA_BUNDLE",
  "CLOUDFLARED_MANAGED",
  "CLOUDFLARED_PATH",
  "CLOUDFLARED_READY_TIMEOUT",
  "CLOUDFLARED_TUNNEL_TOKEN",
  "CODEX_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOG_LEVEL",
  "NODE_EXTRA_CA_CERTS",
  "PROXY_CHECK_INTERVAL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TUNNEL_CLIENT",
  "TUNNEL_CLIENT_CONFIG",
  "TUNNEL_CLIENT_PROFILE",
  "TUNNEL_CLIENT_PROFILE_DIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME"
]);
const args = parseLauncherArgs(process.argv.slice(2));
// Capture the per-user ownership namespace before an alternate dotenv can
// modify runtime variables such as XDG_CONFIG_HOME.
const canonicalRuntimeLockDirectory = defaultRuntimeLockDirectory();
const runtimeEnvFile = resolveRuntimeEnvFile({
  explicitPath: args.envFile,
  repoRoot
});
const runtimeEnvLoaded = args.help
  ? false
  : loadRuntimeEnvFile(runtimeEnvFile, {
      required: Boolean(args.envFile || process.env.CODEX_MCP_BRIDGE_ENV_FILE),
      allowedKey: process.env.CODEX_MCP_BRIDGE_MANAGED_BY_APP === "1"
        ? isManagedAppRuntimeKey
        : undefined
    });
const mode = args.mode || process.env.CODEX_MCP_BRIDGE_MODE || "local";
const tunnelTransport =
  args.transport || process.env.CODEX_MCP_BRIDGE_TUNNEL_TRANSPORT || "http";
const port = String(args.port || process.env.CODEX_MCP_BRIDGE_PORT || "8876");
const host = "127.0.0.1";
const localOriginUrl = `http://${host}:${port}`;
const localMcpUrl = `${localOriginUrl}/mcp`;
const runtimeDirectory = resolve(dirname(runtimeEnvFile), "run");
const runtimeStatusFile = resolve(
  args.runtimeStatusFile || resolve(runtimeDirectory, "launcher-status.json")
);
const tunnelHealthUrlFile = resolve(
  args.tunnelHealthUrlFile || resolve(runtimeDirectory, "tunnel-health.url")
);
const tunnelPidFile = resolve(
  args.tunnelPidFile || resolve(runtimeDirectory, "tunnel.pid")
);
const legacyRuntimeLockDirectory = resolve(runtimeDirectory, "launcher.lock");
const children = new Set();
let shuttingDown = false;
let shutdownPromise;
let runtimeLocks = [];
let ownsRuntimeState = false;
let tunnelHealthTimer;
let tunnelHealthProbeRunning = false;
let runtimePhase = "starting";
let activeRuntimeBuildId = "unbuilt";
let tunnelState = {
  phase: mode === "secure" ? "stopped" : "not-applicable",
  profile: null,
  transport: mode === "secure" ? tunnelTransport : null,
  doctorPassed: false,
  processRunning: false,
  connected: false,
  lastCheckedAt: null,
  lastError: null
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  void shutdown(1, "failed");
});

async function main() {
  if (args.help) {
    printHelp();
    return;
  }
  if (mode !== "local" && mode !== "secure") {
    throw new Error(`Unknown mode: ${mode}. Use local or secure.`);
  }
  if (tunnelTransport !== "http" && tunnelTransport !== "stdio") {
    throw new Error(`Unknown transport: ${tunnelTransport}. Use http or stdio.`);
  }
  if (mode === "local" && tunnelTransport === "stdio") {
    throw new Error("Local stdio uses npm run dev:stdio or npm run start:stdio directly.");
  }
  if (runtimeEnvLoaded) console.log(`Loaded runtime environment from ${runtimeEnvFile}.`);
  const secureTunnelEnvironment =
    mode === "secure"
      ? validateSecureTunnelEnvironment(
          {
            ...process.env,
            CONTROL_PLANE_TUNNEL_ID: args.tunnelId || process.env.CONTROL_PLANE_TUNNEL_ID
          },
          runtimeEnvFile
        )
      : undefined;
  enforceManagedAppAuthenticationBoundary();
  ensurePrerequisites();
  ensureBuilt();
  activeRuntimeBuildId = installedRuntimeBuildId();
  runtimeLocks = acquireRuntimeOwnershipLocks(
    resolve(args.runtimeLockDirectory || canonicalRuntimeLockDirectory),
    legacyRuntimeLockDirectory
  );
  ownsRuntimeState = true;
  publishRuntimeStatus();
  if (tunnelTransport === "http") {
    startBridge();
    await waitForHealth(`${localOriginUrl}/healthz`);
  }

  if (mode === "local") {
    runtimePhase = "running";
    publishRuntimeStatus();
    console.log(`Local MCP endpoint: ${localMcpUrl}`);
    console.log("This endpoint is loopback-only. Press Ctrl-C to stop.");
    await waitForever();
    return;
  }

  await startSecureTunnel(secureTunnelEnvironment);
}

function enforceManagedAppAuthenticationBoundary() {
  if (process.env.CODEX_MCP_BRIDGE_MANAGED_BY_APP !== "1") return;
  // Issue #29 keeps execution authentication separate from the Tunnel key.
  // Until the native app exposes an explicit API-key auth mode, app-managed
  // Codex children must use the existing ChatGPT login cache and must never
  // inherit an API key merely because an older dotenv contains one.
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
}

function acquireRuntimeOwnershipLocks(primaryDirectory, compatibilityDirectory) {
  const directories = [...new Set([
    resolve(primaryDirectory),
    resolve(compatibilityDirectory)
  ])];
  const locks = [];
  try {
    for (const directory of directories) {
      locks.push(acquireRuntimeLock(directory));
    }
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) {
      try {
        lock.release();
      } catch {
        // Preserve the ownership acquisition error; a verified lock owned by
        // this process is best-effort cleanup while startup is already failing.
      }
    }
    throw error;
  }
}

function isManagedAppRuntimeKey(name) {
  if (
    name.startsWith("CODEX_MCP_BRIDGE_") ||
    name.startsWith("CODEX_GPT_BRIDGE_") ||
    name.startsWith("CONTROL_PLANE_") ||
    name.startsWith("MCP_")
  ) {
    return true;
  }
  return MANAGED_APP_RUNTIME_EXACT_KEYS.has(name);
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
  const outputPaths = requiredBuildOutputs(tunnelTransport)
    .map((output) => resolve(repoRoot, output));
  if (args.requireBuilt) {
    const missing = outputPaths.filter((outputPath) => !existsSync(outputPath));
    if (missing.length > 0) {
      throw new Error(
        `Installed bridge runtime is incomplete; missing ${missing.join(", ")}.`
      );
    }
    return;
  }
  if (args.noBuild && buildMatchesSource(outputPaths)) return;
  if (args.noBuild && outputPaths.every((outputPath) => existsSync(outputPath))) {
    console.log("Built output does not match the current source; rebuilding before startup.");
  } else if (args.noBuild) {
    console.log("Built output is missing; building once before startup.");
  }
  const result = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("Build failed. Run npm run build for details.");
  }
}

function buildMatchesSource(outputPaths) {
  if (!outputPaths.every((outputPath) => existsSync(outputPath))) return false;
  try {
    const buildInfo = JSON.parse(readFileSync(resolve(repoRoot, "dist/build-info.json"), "utf8"));
    return buildInfo.sourceHash === computeSourceHash(repoRoot);
  } catch {
    return false;
  }
}

async function startSecureTunnel({ tunnelId }) {
  const tunnelClient = args.tunnelClient || process.env.TUNNEL_CLIENT || defaultTunnelClient();
  const profile = args.profile || process.env.TUNNEL_CLIENT_PROFILE ||
    (tunnelTransport === "stdio" ? "codex-mcp-bridge-stdio" : "codex-mcp-bridge");
  const endpointArguments = tunnelTransport === "stdio"
    ? [
        "--sample",
        "sample_mcp_stdio_local",
        "--mcp-command",
        stdioBridgeCommand()
      ]
    : [
        "--sample",
        "sample_mcp_remote_no_auth",
        "--mcp-server-url",
        localMcpUrl,
        "--health-listen-addr",
        "127.0.0.1:0"
      ];
  const childEnvironment = bridgeEnvironment();
  const runtimeBuildId = activeRuntimeBuildId;
  const tunnelClientVersion = readTunnelClientVersion(
    tunnelClient,
    childEnvironment,
    repoRoot
  );
  const profileMetadataFile = resolve(
    args.profileMetadataFile || defaultTunnelProfileMetadataFile(runtimeEnvFile, profile)
  );
  const identity = expectedTunnelProfileIdentity({
    profile,
    tunnelId,
    transport: tunnelTransport,
    endpoint: tunnelTransport === "stdio" ? stdioBridgeCommand() : localMcpUrl,
    runtimeBuildId,
    runtimeRoot: repoRoot,
    nodeExecutable: process.execPath,
    tunnelClient,
    tunnelClientVersion
  });
  const reuse = args.reuseProfile
    ? inspectReusableTunnelProfile({
        tunnelClient,
        profile,
        environment: childEnvironment,
        cwd: repoRoot,
        metadataFile: profileMetadataFile,
        expected: identity
      })
    : { reusable: false, reason: "profile rebuild was requested" };
  if (reuse.reusable) {
    console.log(`Reusing existing tunnel-client profile ${profile}.`);
  } else {
    if (args.reuseProfile) {
      console.log(`Rebuilding tunnel-client profile ${profile}: ${safeStatusText(reuse.reason)}.`);
    }
    const initArguments = [
      "init",
      "--profile",
      profile,
      "--tunnel-id",
      tunnelId,
      ...endpointArguments,
      "--force"
    ];
    const init = spawnSync(
      tunnelClient,
      initArguments,
      { cwd: repoRoot, env: childEnvironment, stdio: "inherit" }
    );
    if (init.status !== 0) throw new Error("tunnel-client init failed.");
  }

  const doctor = spawnSync(tunnelClient, ["doctor", "--profile", profile, "--explain"], {
    cwd: repoRoot,
    env: childEnvironment,
    encoding: "utf8"
  });
  if (doctor.stdout) process.stdout.write(doctor.stdout);
  if (doctor.stderr) process.stderr.write(doctor.stderr);
  if (doctor.status !== 0 && !isIgnorableNoAuthDoctorFailure(`${doctor.stdout || ""}\n${doctor.stderr || ""}`)) {
    throw new Error("tunnel-client doctor failed. Fix the tunnel or API-key setup first.");
  }
  recordTunnelProfileMetadata({
    tunnelClient,
    profile,
    environment: childEnvironment,
    cwd: repoRoot,
    metadataFile: profileMetadataFile,
    identity
  });

  const mcpConcurrency =
    process.env.MCP_MAX_CONCURRENT_REQUESTS ||
    process.env.CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS ||
    "30";
  const controlPlaneInflight = process.env.CONTROL_PLANE_MAX_INFLIGHT_REQUESTS || mcpConcurrency;
  const logLevel = process.env.LOG_LEVEL || "warn";
  removeStaleRuntimeFile(tunnelHealthUrlFile);
  removeStaleRuntimeFile(tunnelPidFile);
  tunnelState = {
    phase: "starting",
    profile,
    transport: tunnelTransport,
    doctorPassed: true,
    processRunning: false,
    connected: false,
    lastCheckedAt: new Date().toISOString(),
    lastError: null
  };
  publishRuntimeStatus();
  const tunnel = spawnChild(tunnelClient, [
    "run",
    "--profile",
    profile,
    "--health.listen-addr",
    "127.0.0.1:0",
    "--health.url-file",
    tunnelHealthUrlFile,
    "--pid.file",
    tunnelPidFile,
    "--mcp.max-concurrent-requests",
    mcpConcurrency,
    "--control-plane.max-inflight",
    controlPlaneInflight,
    "--log.level",
    logLevel
  ], { env: childEnvironment });
  tunnelState = { ...tunnelState, processRunning: true };
  publishRuntimeStatus();
  await waitForTunnelReady(tunnelClient, childEnvironment, tunnel);
  runtimePhase = "running";
  tunnelState = {
    ...tunnelState,
    phase: "connected",
    processRunning: true,
    connected: true,
    lastCheckedAt: new Date().toISOString(),
    lastError: null
  };
  publishRuntimeStatus();
  beginTunnelHealthMonitoring(tunnelClient, childEnvironment, tunnel);
  console.log(
    `Secure MCP Tunnel is running with profile ${profile} over ${tunnelTransport}.`
  );
  console.log(
    `Tunnel limits: ${mcpConcurrency} active MCP requests, ${controlPlaneInflight} buffered control-plane requests.`
  );
  console.log(`Select tunnel ${tunnelId} in the ChatGPT developer-mode connection.`);
  await waitForever();
}

function startBridge() {
  return spawnChild("node", [resolve(repoRoot, "dist/cli.js")], {
    env: bridgeEnvironment()
  });
}

function bridgeEnvironment() {
  const env = {
    ...process.env,
    CODEX_MCP_BRIDGE_HOST: host,
    CODEX_MCP_BRIDGE_PORT: port,
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
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
  return env;
}

function stdioBridgeCommand() {
  const command = [process.execPath, resolve(repoRoot, "dist/stdio.js")];
  if (process.env.CODEX_MCP_BRIDGE_MANAGED_BY_APP === "1") {
    command.unshift("/usr/bin/env", "-u", "CONTROL_PLANE_API_KEY");
  }
  return command
    .map(shellQuote)
    .join(" ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
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
      if (command === (args.tunnelClient || process.env.TUNNEL_CLIENT || defaultTunnelClient())) {
        tunnelState = {
          ...tunnelState,
          phase: "failed",
          processRunning: false,
          connected: false,
          lastCheckedAt: new Date().toISOString(),
          lastError: "The tunnel-client process exited unexpectedly."
        };
        tryPublishRuntimeStatus();
      }
      void shutdown(typeof code === "number" && code > 0 ? code : 1, "failed");
    }
  });
  child.on("error", (error) => {
    if (!shuttingDown) {
      console.error(`Could not start ${command}: ${error.message}`);
      void shutdown(1, "failed");
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

function installedRuntimeBuildId() {
  try {
    const build = JSON.parse(readFileSync(resolve(repoRoot, "dist/build-info.json"), "utf8"));
    if (typeof build.id === "string" && build.id) return build.id;
  } catch {
    // ensureBuilt reports missing installed output before secure startup.
  }
  return "unbuilt";
}

async function waitForTunnelReady(tunnelClient, environment, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("tunnel-client exited before the control-plane connection became ready.");
    }
    const connected = probeTunnelHealth(tunnelClient, environment);
    tunnelState = {
      ...tunnelState,
      phase: connected ? "connected" : "starting",
      processRunning: true,
      connected,
      lastCheckedAt: new Date().toISOString(),
      lastError: connected ? null : "Waiting for a successful control-plane poll."
    };
    publishRuntimeStatus();
    if (connected) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("Timed out waiting for a successful Secure MCP Tunnel control-plane poll.");
}

function beginTunnelHealthMonitoring(tunnelClient, environment, child) {
  tunnelHealthTimer = setInterval(() => {
    if (shuttingDown || tunnelHealthProbeRunning) return;
    tunnelHealthProbeRunning = true;
    try {
      const processRunning = child.exitCode === null && child.signalCode === null;
      const connected = processRunning && probeTunnelHealth(tunnelClient, environment);
      tunnelState = {
        ...tunnelState,
        phase: connected ? "connected" : "degraded",
        processRunning,
        connected,
        lastCheckedAt: new Date().toISOString(),
        lastError: connected
          ? null
          : processRunning
            ? "The tunnel readiness probe is failing; reconnecting may be in progress."
            : "The tunnel-client process is not running."
      };
      publishRuntimeStatus();
    } catch (error) {
      tunnelState = {
        ...tunnelState,
        phase: "degraded",
        connected: false,
        lastCheckedAt: new Date().toISOString(),
        lastError: safeStatusText(error instanceof Error ? error.message : String(error))
      };
      tryPublishRuntimeStatus();
    } finally {
      tunnelHealthProbeRunning = false;
    }
  }, 5_000);
  tunnelHealthTimer.unref();
}

function probeTunnelHealth(tunnelClient, environment) {
  if (!existsSync(tunnelHealthUrlFile) || !existsSync(tunnelPidFile)) return false;
  const result = spawnSync(tunnelClient, [
    "health",
    "--json",
    "--url-file",
    tunnelHealthUrlFile,
    "--pid-file",
    tunnelPidFile,
    "--require-control-plane-poll"
  ], {
    cwd: repoRoot,
    env: environment,
    encoding: "utf8",
    timeout: 5_000
  });
  return result.status === 0;
}

function publishRuntimeStatus() {
  if (!ownsRuntimeState) return;
  writeManagedRuntimeStatus(runtimeStatusFile, {
    phase: runtimePhase,
    runtimeBuildId: activeRuntimeBuildId,
    tunnel: tunnelState
  });
}

function tryPublishRuntimeStatus() {
  try {
    publishRuntimeStatus();
  } catch (error) {
    console.error(`Could not write managed runtime status: ${safeStatusText(error)}`);
    process.exitCode = 1;
  }
}

function removeStaleRuntimeFile(filePath) {
  if (!existsSync(filePath)) return;
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Managed runtime state must be a regular, non-symlink file: ${filePath}`);
  }
  unlinkSync(filePath);
}

function safeStatusText(value) {
  return String(value || "unknown")
    .replace(/sk-[^\s]{8,}/g, "[REDACTED_API_KEY]")
    .replace(/tunnel_[A-Za-z0-9_-]{8,}/g, "[REDACTED_TUNNEL_ID]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
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
  npm run bridge:local
  npm run bridge:secure -- --tunnel-id tunnel_...

Options:
  --write                Enable workspace-write for this process.
  --allow-write          Keep read-only as the default, but allow explicit workspace-write calls.
  --allow-full-access    Keep read-only as the default, but allow workspace-write and danger-full-access calls.
  --transport <kind>     Secure Tunnel MCP transport: http (default) or stdio.
  --env-file <path>      Dotenv file. Defaults to ~/.config/codex-mcp-bridge/.env.
  --tunnel-id <id>       OpenAI Secure MCP Tunnel id.
  --profile <name>       tunnel-client profile name.
  --tunnel-client <path> tunnel-client binary path.
  --profile-metadata-file <path> Managed profile identity record.
  --runtime-status-file <path>   Private launcher/tunnel status record.
  --runtime-lock-directory <path> Per-user single-runtime ownership lock.
  --tunnel-health-url-file <path> Private tunnel health endpoint locator.
  --tunnel-pid-file <path>       Private tunnel-client PID record.
  --port <port>          Loopback HTTP port. Defaults to 8876.
  --no-build             Reuse dist only when its source fingerprint is current.
  --require-built        Require installed dist output and never invoke npm or rebuild.
  --reuse-profile        Reuse only when the managed identity and profile contents match.`);
}

function shutdown(code = 0, phase = "stopped") {
  process.exitCode = Math.max(process.exitCode || 0, code);
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    if (tunnelHealthTimer) {
      clearInterval(tunnelHealthTimer);
      tunnelHealthTimer = undefined;
    }
    runtimePhase = "stopping";
    tunnelState = {
      ...tunnelState,
      phase: tunnelState.phase === "not-applicable" ? "not-applicable" : "stopping",
      connected: false,
      lastCheckedAt: new Date().toISOString()
    };
    tryPublishRuntimeStatus();

    const result = await terminateManagedChildren(children);
    if (!result.exited) {
      console.error("Managed child processes did not exit after SIGKILL; retaining the runtime lock.");
      process.exitCode = 1;
    }
    runtimePhase = phase;
    tunnelState = {
      ...tunnelState,
      phase: tunnelState.phase === "not-applicable" ? "not-applicable" : phase,
      processRunning: false,
      connected: false,
      lastCheckedAt: new Date().toISOString()
    };
    tryPublishRuntimeStatus();
    if (result.exited) {
      for (const lock of runtimeLocks.reverse()) {
        try {
          lock.release();
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
      }
      runtimeLocks = [];
      ownsRuntimeState = false;
    }
    process.exit(process.exitCode || 0);
  })();
  return shutdownPromise;
}

function waitForever() {
  return new Promise(() => {});
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
