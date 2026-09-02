import { existsSync, lstatSync, mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_PROTOCOL_NAME,
  COMPANION_PROTOCOL_VERSION,
  startBridgeCompanionServer,
  type BridgeCompanionServer
} from "../src/companionServer.js";
import type {
  BridgeApplicationService,
  DashboardView,
  SettingsView
} from "../src/tools.js";

const servers: BridgeCompanionServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe("native companion server", () => {
  it("serves a versioned hello over a private Unix socket", async () => {
    const socketPath = temporarySocketPath();
    const server = await startBridgeCompanionServer({
      socketPath,
      applicationService: fakeApplicationService()
    });
    servers.push(server);

    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    const response = await request(socketPath, {
      jsonrpc: "2.0",
      id: "hello-1",
      method: "companion.hello",
      params: {}
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "hello-1",
      result: {
        protocol: {
          name: COMPANION_PROTOCOL_NAME,
          version: COMPANION_PROTOCOL_VERSION
        },
        capabilities: ["dashboard.read", "settings.read", "settings.write", "runtime.drain"]
      }
    });
  });

  it("routes Dashboard and Settings through the shared application service", async () => {
    const socketPath = temporarySocketPath();
    const applicationService = fakeApplicationService();
    const server = await startBridgeCompanionServer({ socketPath, applicationService });
    servers.push(server);

    const dashboard = await request(socketPath, {
      jsonrpc: "2.0",
      id: 1,
      method: "dashboard.snapshot",
      params: { limit: 12, terminalOffset: 4, idleOffset: 7 }
    });
    expect(applicationService.dashboardSnapshot).toHaveBeenCalledWith({
      limit: 12,
      terminalOffset: 4,
      idleOffset: 7,
      inspectRuntime: true
    });
    expect(dashboard).toMatchObject({ id: 1, result: { kind: "dashboard" } });

    const settings = await request(socketPath, {
      jsonrpc: "2.0",
      id: 2,
      method: "settings.snapshot",
      params: { refreshModels: true }
    });
    expect(applicationService.settingsSnapshot).toHaveBeenCalledWith({ refreshModels: true });
    expect(settings).toMatchObject({ id: 2, result: { settings: { settingsRevision: 3 } } });

    const mutation = {
      expectedSettingsRevision: 3,
      operation: {
        kind: "patch",
        settings: { maxConcurrentJobs: 4 }
      }
    };
    const updated = await request(socketPath, {
      jsonrpc: "2.0",
      id: 3,
      method: "settings.update",
      params: mutation
    });
    expect(applicationService.updateSettings).toHaveBeenCalledWith(mutation);
    expect(updated).toMatchObject({ id: 3, result: { settings: { settingsRevision: 3 } } });
  });

  it("rejects malformed requests without closing the server", async () => {
    const socketPath = temporarySocketPath();
    const server = await startBridgeCompanionServer({
      socketPath,
      applicationService: fakeApplicationService()
    });
    servers.push(server);

    const invalid = await request(socketPath, {
      jsonrpc: "2.0",
      id: "invalid-1",
      method: "unknown.method",
      params: {}
    });
    expect(invalid).toMatchObject({
      id: "invalid-1",
      error: { code: -32600, message: "Invalid companion request." }
    });

    const valid = await request(socketPath, {
      jsonrpc: "2.0",
      id: "hello-after-invalid",
      method: "companion.hello"
    });
    expect(valid).toMatchObject({ id: "hello-after-invalid", result: { protocol: { version: 1 } } });
  });

  it("exposes a bounded runtime drain gate without adding MCP authority", async () => {
    const socketPath = temporarySocketPath();
    const applicationService = fakeApplicationService();
    const server = await startBridgeCompanionServer({ socketPath, applicationService });
    servers.push(server);

    const begin = await request(socketPath, {
      jsonrpc: "2.0",
      id: "drain-1",
      method: "runtime.beginDrain",
      params: { inspectBackgroundProcesses: true }
    });
    expect(applicationService.beginDrain).toHaveBeenCalledWith({
      inspectBackgroundProcesses: true
    });
    expect(begin).toMatchObject({
      result: {
        acceptingNewJobs: false,
        activeJobs: 2,
        pendingAdmissions: 0,
        backgroundProcessState: "confirmed",
        backgroundProcesses: 1
      }
    });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "drain-2",
      method: "runtime.cancelDrain",
      params: {}
    });
    expect(applicationService.cancelDrain).toHaveBeenCalledOnce();
  });

  it("refuses to replace an active socket and removes only its own socket on close", async () => {
    const socketPath = temporarySocketPath();
    const server = await startBridgeCompanionServer({
      socketPath,
      applicationService: fakeApplicationService()
    });
    servers.push(server);

    await expect(startBridgeCompanionServer({
      socketPath,
      applicationService: fakeApplicationService()
    })).rejects.toThrow("already running");

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(existsSync(socketPath)).toBe(false);
  });
});

function fakeApplicationService(): BridgeApplicationService {
  return {
    dashboardSnapshot: vi.fn(async () => ({ kind: "dashboard" }) as DashboardView),
    settingsSnapshot: vi.fn(async () => ({
      settings: { settingsRevision: 3 }
    }) as SettingsView),
    updateSettings: vi.fn(async () => ({
      settings: { settingsRevision: 3 }
    }) as SettingsView),
    runtimeSnapshot: vi.fn(async () => ({
      acceptingNewJobs: true,
      activeJobs: 2,
      pendingAdmissions: 0,
      backgroundProcessState: "confirmed" as const,
      backgroundProcesses: 1,
      backgroundProcessAgents: 1,
      backgroundProcessUnknownAgents: 0
    })),
    beginDrain: vi.fn(async () => ({
      acceptingNewJobs: false,
      activeJobs: 2,
      pendingAdmissions: 0,
      backgroundProcessState: "confirmed" as const,
      backgroundProcesses: 1,
      backgroundProcessAgents: 1,
      backgroundProcessUnknownAgents: 0
    })),
    cancelDrain: vi.fn(async () => ({
      acceptingNewJobs: true,
      activeJobs: 2,
      pendingAdmissions: 0,
      backgroundProcessState: "confirmed" as const,
      backgroundProcesses: 1,
      backgroundProcessAgents: 1,
      backgroundProcessUnknownAgents: 0
    }))
  };
}

function temporarySocketPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "codex-companion-")), "bridge.sock");
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
