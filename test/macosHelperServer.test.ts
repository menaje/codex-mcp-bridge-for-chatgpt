import {
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MACOS_HELPER_PROTOCOL_NAME,
  MACOS_HELPER_PROTOCOL_VERSION,
  MacOSBridgeSupervisor,
  startMacOSHelperServer,
  type MacOSHelperController,
  type MacOSHelperStatus
} from "../src/macosHelperServer.js";
import type { BridgeCompanionServer } from "../src/companionServer.js";
import { updateRuntimeEnvFile } from "../scripts/runtime-env.mjs";

const servers: BridgeCompanionServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe("macOS runtime helper RPC", () => {
  it("serves a versioned, private control surface", async () => {
    const socketPath = temporarySocketPath();
    const server = await startMacOSHelperServer({
      socketPath,
      controller: fakeController()
    });
    servers.push(server);

    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    const response = await request(socketPath, {
      jsonrpc: "2.0",
      id: "hello",
      method: "helper.hello",
      params: {}
    });
    expect(response).toMatchObject({
      result: {
        protocol: {
          name: MACOS_HELPER_PROTOCOL_NAME,
          version: MACOS_HELPER_PROTOCOL_VERSION
        },
        status: { kind: "helper-status", phase: "running" }
      }
    });
  });

  it("routes setup and explicit drain or force semantics", async () => {
    const socketPath = temporarySocketPath();
    const controller = fakeController();
    const server = await startMacOSHelperServer({ socketPath, controller });
    servers.push(server);

    const secret = "sk-native-test-1234567890123456";
    const setup = await request(socketPath, {
      jsonrpc: "2.0",
      id: "setup",
      method: "setup.apply",
      params: {
        apiKey: secret,
        tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
        mode: "drain",
        timeoutMs: 60_000
      }
    });
    expect(controller.applyConfiguration).toHaveBeenCalledWith({
      apiKey: secret,
      tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
      mode: "drain",
      timeoutMs: 60_000
    });
    expect(JSON.stringify(setup)).not.toContain(secret);

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "stop",
      method: "runtime.stop",
      params: { mode: "drain", timeoutMs: 30_000 }
    });
    expect(controller.stop).toHaveBeenCalledWith({ mode: "drain", timeoutMs: 30_000 });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "restart",
      method: "runtime.restart",
      params: { mode: "force", timeoutMs: 5_000 }
    });
    expect(controller.restart).toHaveBeenCalledWith({ mode: "force", timeoutMs: 5_000 });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "repair",
      method: "runtime.repair",
      params: { mode: "drain", timeoutMs: 60_000 }
    });
    expect(controller.repair).toHaveBeenCalledWith({ mode: "drain", timeoutMs: 60_000 });
  });

  it("redacts credential-shaped text from helper failures", async () => {
    const socketPath = temporarySocketPath();
    const controller = fakeController();
    vi.mocked(controller.applyConfiguration).mockRejectedValueOnce(
      new Error("failed for sk-leaked-1234567890123456 and tunnel_leaked123")
    );
    const server = await startMacOSHelperServer({ socketPath, controller });
    servers.push(server);

    const response = await request(socketPath, {
      jsonrpc: "2.0",
      id: "redaction",
      method: "setup.apply",
      params: { apiKey: "", tunnelId: "", mode: "drain", timeoutMs: 60_000 }
    });
    expect(response).toMatchObject({ id: "redaction", error: { code: -32602 } });
    expect(JSON.stringify(response)).not.toContain("sk-leaked");
    expect(JSON.stringify(response)).not.toContain("tunnel_leaked123");
  });

  it("creates a private dotenv and starts the runtime on a fresh install", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configDirectory = path.join(root, "c");
    const configFile = path.join(configDirectory, ".env");
    const bridgeSocket = path.join(configDirectory, "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "stdio.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile);
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      autoRestart: false,
      startTimeoutMs: 5_000,
      registeredProjectRoots: () => [path.join(root, "safe-project")]
    });

    try {
      const applied = await supervisor.applyConfiguration({
        apiKey: "sk-supervisor-1234567890123456",
        tunnelId: "tunnel_ffffffffffffffffffffffffffffffff",
        mode: "drain",
        timeoutMs: 5_000
      });
      expect(applied.status.phase).toBe("running");
      expect(applied.configuration).toMatchObject({
        exists: true,
        valid: true,
        hasApiKey: true,
        tunnelId: "tunnel_ffffffffffffffffffffffffffffffff"
      });
      expect(lstatSync(configDirectory).mode & 0o777).toBe(0o700);
      expect(lstatSync(configFile).mode & 0o777).toBe(0o600);
    } finally {
      await supervisor.close();
    }
  });

  it("atomically applies configuration and restarts the managed runtime", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "stdio.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile);
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      expect(JSON.parse(readFileSync(argumentsFile, "utf8"))).toContain("--reuse-profile");

      const applied = await supervisor.applyConfiguration({
        tunnelId: "tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
        mode: "force",
        timeoutMs: 5_000
      });
      expect(applied.status.phase).toBe("running");
      expect(applied.configuration.tunnelId).toBe("tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr");
      expect(JSON.parse(readFileSync(argumentsFile, "utf8"))).toContain("--reuse-profile");
    } finally {
      await supervisor.close();
    }
  });

  it("does not change the dotenv when active work misses the drain deadline", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "stdio.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, { activeJobs: 1 });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const original = readFileSync(configFile, "utf8");
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      await expect(supervisor.applyConfiguration({
        tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
        mode: "drain",
        timeoutMs: 1_000
      })).rejects.toThrow("DRAIN_TIMEOUT");
      expect(readFileSync(configFile, "utf8")).toBe(original);
      expect((await supervisor.snapshot()).phase).toBe("running");
    } finally {
      await supervisor.close();
    }
  });

  it("rolls back the dotenv and restores the old runtime when new startup fails", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "stdio.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, {
      failTunnelId: "tunnel_ssssssssssssssssssssssssssssssss"
    });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const original = readFileSync(configFile, "utf8");
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      await expect(supervisor.applyConfiguration({
        tunnelId: "tunnel_ssssssssssssssssssssssssssssssss",
        mode: "force",
        timeoutMs: 5_000
      })).rejects.toThrow("Previous runtime configuration was restored");
      expect(readFileSync(configFile, "utf8")).toBe(original);
      const status = await supervisor.snapshot();
      expect(status.phase).toBe("running");
      expect(status.configuration.tunnelId).toBe("tunnel_oooooooooooooooooooooooooooooooo");
    } finally {
      await supervisor.close();
    }
  });

  it("restarts the unchanged runtime when a concurrent dotenv edit prevents commit", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "stdio.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, { mutateEnvOnDrain: "# concurrent edit" });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const original = readFileSync(configFile, "utf8");
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      await expect(supervisor.applyConfiguration({
        tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
        mode: "force",
        timeoutMs: 5_000
      })).rejects.toThrow("Runtime configuration was not changed");
      expect(readFileSync(configFile, "utf8")).toBe(`${original}# concurrent edit\n`);
      const status = await supervisor.snapshot();
      expect(status.phase).toBe("running");
      expect(status.configuration.tunnelId).toBe("tunnel_oooooooooooooooooooooooooooooooo");
    } finally {
      await supervisor.close();
    }
  });

  it("rejects a configured dotenv inside any registered project", async () => {
    const root = temporaryDirectory();
    const project = path.join(root, "project");
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(project, ".runtime", ".env");
    const bridgeSocket = path.join(root, "run", "bridge.sock");
    mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "stdio.js"), "", { mode: 0o600 });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: path.join(bridgeRoot, "missing-launcher.mjs"),
      autoRestart: false,
      registeredProjectRoots: () => [project]
    });

    expect((await supervisor.snapshot()).configuration).toMatchObject({
      valid: false,
      issue: expect.stringContaining("RUNTIME_ENV_PROJECT_CONFLICT")
    });
    await expect(supervisor.start()).rejects.toThrow("RUNTIME_ENV_PROJECT_CONFLICT");
  });

  it("uses Codex command and CODEX_HOME from dotenv without returning raw CLI output", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configDirectory = path.join(root, "config");
    const configFile = path.join(configDirectory, ".env");
    const codexHome = path.join(root, "codex-home");
    const invocationFile = path.join(root, "codex-invocation.json");
    const fakeCodex = path.join(root, "fake-codex.mjs");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(invocationFile)}, JSON.stringify({
  args: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME
}));
console.log("user@example.com sk-raw-output-1234567890123456");
`, { mode: 0o700 });
    writeFileSync(configFile, [
      "CONTROL_PLANE_API_KEY=sk-supervisor-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo",
      `CODEX_MCP_BRIDGE_CODEX=${fakeCodex}`,
      `CODEX_HOME=${codexHome}`,
      ""
    ].join("\n"), { mode: 0o600 });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: path.join(configDirectory, "run", "bridge.sock"),
      autoRestart: false,
      registeredProjectRoots: () => []
    });

    const status = await supervisor.authStatus();
    expect(status).toEqual({
      installed: true,
      authenticated: true,
      summary: "Codex login is available."
    });
    expect(JSON.stringify(status)).not.toContain("user@example.com");
    expect(JSON.parse(readFileSync(invocationFile, "utf8"))).toEqual({
      args: ["login", "status"],
      codexHome
    });
  });
});

function fakeController(): MacOSHelperController {
  return {
    snapshot: vi.fn(async () => helperStatus()),
    applyConfiguration: vi.fn(async () => ({
      configuration: helperStatus().configuration,
      status: helperStatus(),
      restarted: true,
      rolledBack: false as const
    })),
    authStatus: vi.fn(async () => ({
      installed: true,
      authenticated: true,
      summary: "Logged in"
    })),
    startLogin: vi.fn(async () => ({ started: true as const })),
    start: vi.fn(async () => helperStatus()),
    stop: vi.fn(async () => helperStatus("stopped")),
    restart: vi.fn(async () => helperStatus()),
    repair: vi.fn(async () => helperStatus()),
    logs: vi.fn(() => [])
  };
}

function helperStatus(phase: MacOSHelperStatus["phase"] = "running"): MacOSHelperStatus {
  return {
    kind: "helper-status",
    generatedAt: "2026-09-02T00:00:00.000Z",
    phase,
    pid: phase === "stopped" ? null : 123,
    startedAt: phase === "stopped" ? null : "2026-09-02T00:00:00.000Z",
    lastExit: null,
    lastError: null,
    restartAttempt: 0,
    configuration: {
      path: "/private/config/.env",
      exists: true,
      valid: true,
      hasApiKey: true,
      hasTunnelId: true,
      tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
      issue: null
    },
    bridge: {
      socketPath: "/private/config/run/bridge.sock",
      connected: true,
      acceptingNewJobs: true,
      activeJobs: 2,
      pendingAdmissions: 0
    },
    tunnel: {
      phase: "connected",
      profile: "codex-mcp-bridge-stdio",
      transport: "stdio",
      doctorPassed: true,
      processRunning: true,
      connected: true,
      lastCheckedAt: "2026-09-02T00:00:00.000Z",
      lastError: null
    }
  };
}

function temporarySocketPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "codex-macos-helper-")), "helper.sock");
}

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-macos-supervisor-"));
}

function writeFakeLauncher(
  file: string,
  argumentsFile: string,
  options: { activeJobs?: number; failTunnelId?: string; mutateEnvOnDrain?: string } = {}
): void {
  writeFileSync(file, `
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
const socketPath = process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET;
const statusIndex = process.argv.indexOf("--runtime-status-file");
const runtimeStatusFile = statusIndex >= 0 ? process.argv[statusIndex + 1] : null;
const envIndex = process.argv.indexOf("--env-file");
const envFile = envIndex >= 0 ? process.argv[envIndex + 1] : null;
let mutatedEnv = false;
if (
  envFile &&
  ${JSON.stringify(options.failTunnelId || "")} &&
  readFileSync(envFile, "utf8").includes(${JSON.stringify(options.failTunnelId || "")})
) {
  process.exit(7);
}
mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
try { unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv.slice(2)));
if (runtimeStatusFile) {
  writeFileSync(runtimeStatusFile, JSON.stringify({
    protocol: "codex-mcp-bridge-launcher-status",
    version: 1,
    generatedAt: new Date().toISOString(),
    launcherPid: process.pid,
    phase: "running",
    runtimeBuildId: "development",
    tunnel: {
      phase: "connected",
      profile: "test",
      transport: "stdio",
      doctorPassed: true,
      processRunning: true,
      connected: true,
      lastCheckedAt: new Date().toISOString(),
      lastError: null
    }
  }), { mode: 0o600 });
}
const server = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    const draining = request.method === "runtime.beginDrain";
    if (draining && envFile && !mutatedEnv && ${JSON.stringify(Boolean(options.mutateEnvOnDrain))}) {
      appendFileSync(envFile, ${JSON.stringify(`${options.mutateEnvOnDrain || ""}\n`)});
      mutatedEnv = true;
    }
    socket.end(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        acceptingNewJobs: !draining,
        activeJobs: ${options.activeJobs || 0},
        pendingAdmissions: 0
      }
    }) + "\\n");
  });
});
server.listen(socketPath);
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`, { mode: 0o700 });
}

function request(
  socketPath: string,
  payload: Record<string, unknown>
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, any>);
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
    socket.once("error", reject);
  });
}
