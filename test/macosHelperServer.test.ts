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
      method: "setup.save",
      params: { apiKey: secret, tunnelId: "tunnel_native123" }
    });
    expect(controller.saveConfiguration).toHaveBeenCalledWith({
      apiKey: secret,
      tunnelId: "tunnel_native123"
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
    vi.mocked(controller.saveConfiguration).mockRejectedValueOnce(
      new Error("failed for sk-leaked-1234567890123456 and tunnel_leaked123")
    );
    const server = await startMacOSHelperServer({ socketPath, controller });
    servers.push(server);

    const response = await request(socketPath, {
      jsonrpc: "2.0",
      id: "redaction",
      method: "setup.save",
      params: { apiKey: "", tunnelId: "" }
    });
    expect(response).toMatchObject({ id: "redaction", error: { code: -32602 } });
    expect(JSON.stringify(response)).not.toContain("sk-leaked");
    expect(JSON.stringify(response)).not.toContain("tunnel_leaked123");
  });

  it("reuses an existing tunnel profile until the configured tunnel identity changes", async () => {
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
      tunnelId: "tunnel_original123"
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

      await supervisor.saveConfiguration({ tunnelId: "tunnel_replaced123" });
      await supervisor.restart({ mode: "force", timeoutMs: 5_000 });
      expect(JSON.parse(readFileSync(argumentsFile, "utf8"))).not.toContain("--reuse-profile");
    } finally {
      await supervisor.close();
    }
  });
});

function fakeController(): MacOSHelperController {
  return {
    snapshot: vi.fn(async () => helperStatus()),
    saveConfiguration: vi.fn(async () => ({
      configuration: helperStatus().configuration,
      restartRequired: true
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
      tunnelId: "tunnel_native123",
      issue: null
    },
    bridge: {
      socketPath: "/private/config/run/bridge.sock",
      connected: true,
      acceptingNewJobs: true,
      activeJobs: 2,
      pendingAdmissions: 0
    }
  };
}

function temporarySocketPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "codex-macos-helper-")), "helper.sock");
}

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-macos-supervisor-"));
}

function writeFakeLauncher(file: string, argumentsFile: string): void {
  writeFileSync(file, `
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
const socketPath = process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET;
mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
try { unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv.slice(2)));
const server = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    const draining = request.method === "runtime.beginDrain";
    socket.end(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { acceptingNewJobs: !draining, activeJobs: 0, pendingAdmissions: 0 }
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
