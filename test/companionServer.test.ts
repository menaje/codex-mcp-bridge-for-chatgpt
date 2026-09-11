import { existsSync, lstatSync, mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_PROTOCOL_NAME,
  COMPANION_PROTOCOL_VERSION,
  REMOTE_COMPANION_APPLICATION_METHODS,
  startBridgeCompanionServer,
  type BridgeCompanionServer,
  type RemoteCompanionControl
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
  it("keeps exact-target conversation handoff on the private local socket", async () => {
    const socketPath=temporarySocketPath(),service=fakeApplicationService();
    service.threadHandoff=vi.fn(async () => ({phase:"unsubscribed",reason:"upstream-unload-grace",requested:true,canOpen:false}));
    servers.push(await startBridgeCompanionServer({socketPath,applicationService:service}));
    const params={rowKey:"a".repeat(32),codexThreadUrl:"codex://threads/11111111-1111-4111-8111-111111111111",action:"request"};
    expect(await request(socketPath,{jsonrpc:"2.0",id:1,method:"thread.handoff",params})).toMatchObject({result:{canOpen:false,phase:"unsubscribed"}});
    expect(service.threadHandoff).toHaveBeenCalledWith(params);
    expect(REMOTE_COMPANION_APPLICATION_METHODS.has("thread.handoff")).toBe(false);
    expect(await request(socketPath,{jsonrpc:"2.0",id:2,method:"thread.handoff",params:{...params,codexThreadUrl:"https://example.com"}})).toHaveProperty("error");
    expect(service.threadHandoff).toHaveBeenCalledTimes(1);
  });
  it("serves lightweight health independently of a stalled admission snapshot", async () => {
    const socketPath = temporarySocketPath();
    const service = fakeApplicationService();
    service.runtimeSnapshot = vi.fn(() => new Promise(() => undefined));
    service.runtimeHealth = vi.fn(() => ({
      acceptingNewJobs: true, activeJobs: 2, pendingAdmissions: 0,
      backgroundProcessState: "unknown", backgroundProcesses: 0,
      backgroundProcessAgents: 0, backgroundProcessUnknownAgents: 0
    }));
    servers.push(await startBridgeCompanionServer({ socketPath, applicationService: service }));
    expect(await request(socketPath, { jsonrpc: "2.0", id: 1, method: "runtime.health" }))
      .toMatchObject({ result: { activeJobs: 2, acceptingNewJobs: true } });
    expect(service.runtimeSnapshot).not.toHaveBeenCalled();
  });

  it("pushes application invalidations without loading hidden snapshots and releases its subscription", async () => {
    const socketPath = temporarySocketPath();
    const service = fakeApplicationService();
    let listener: (topic: "dashboard" | "settings") => void = () => undefined;
    const unsubscribe = vi.fn();
    service.subscribeChanges = callback => { listener = callback; return unsubscribe; };
    const server = await startBridgeCompanionServer({ socketPath, applicationService: service });
    servers.push(server);
    const first = await request(socketPath, { jsonrpc: "2.0", id: 1, method: "changes.wait", params: { waitMs: 0 } });
    const revision = (first.result as { revision: string }).revision;
    const waiting = request(socketPath, { jsonrpc: "2.0", id: 2, method: "changes.wait", params: { after: revision } });
    listener("settings");
    expect(await waiting).toMatchObject({ result: { topics: ["settings"] } });
    expect(service.dashboardSnapshot).not.toHaveBeenCalled();
    expect(service.settingsSnapshot).not.toHaveBeenCalled();
    await server.close();
    expect(unsubscribe).toHaveBeenCalled();
  });

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

  it("validates history actions before forwarding them to the shared application service", async () => {
    const socketPath = temporarySocketPath(), applicationService = fakeApplicationService();
    applicationService.historyAction = vi.fn(async () => ({ok:true as const}));
    servers.push(await startBridgeCompanionServer({socketPath,applicationService}));
    const params = {rowKey:"a".repeat(32),expectedRevision:"b".repeat(64),action:"archive",requestId:"11111111-1111-4111-8111-111111111111"};
    expect(await request(socketPath,{jsonrpc:"2.0",id:1,method:"dashboard.history",params})).toMatchObject({result:{ok:true}});
    expect(applicationService.historyAction).toHaveBeenCalledWith(params);
    expect(await request(socketPath,{jsonrpc:"2.0",id:2,method:"dashboard.history",params:{...params,force:true}})).toHaveProperty("error");
    expect(applicationService.historyAction).toHaveBeenCalledTimes(1);
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
      params: { limit: 12, terminalOffset: 4, idleOffset: 7, enrich: false, includeHistory: false }
    });
    expect(applicationService.dashboardSnapshot).toHaveBeenCalledWith({
      problems: undefined,
      statusFilter: undefined,
      limit: 12,
      terminalOffset: 4,
      idleOffset: 7,
      inspectRuntime: false,
      includeHistory: false
    });
    expect(dashboard).toMatchObject({ id: 1, result: { kind: "dashboard" } });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "retained-native-dashboard",
      method: "dashboard.snapshot",
      params: { limit: 12 }
    });
    expect(applicationService.dashboardSnapshot).toHaveBeenLastCalledWith({
      problems: undefined,
      statusFilter: undefined,
      limit: 12,
      terminalOffset: undefined,
      idleOffset: undefined,
      inspectRuntime: true,
      includeHistory: true
    });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "enriched-dashboard",
      method: "dashboard.snapshot",
      params: { limit: 12, enrich: true }
    });
    expect(applicationService.dashboardSnapshot).toHaveBeenLastCalledWith({
      problems: undefined,
      statusFilter: undefined,
      limit: 12,
      terminalOffset: undefined,
      idleOffset: undefined,
      inspectRuntime: true,
      includeHistory: true
    });

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

  it("keeps the native Dashboard cold snapshot independent from optional enrichment", async () => {
    const socketPath = temporarySocketPath();
    const applicationService = fakeApplicationService();
    vi.mocked(applicationService.dashboardSnapshot).mockImplementation(async (options = {}) => {
      if (options.inspectRuntime) return new Promise(() => undefined);
      return { kind: "dashboard", enrichment: { state: "structural" } } as DashboardView;
    });
    const server = await startBridgeCompanionServer({ socketPath, applicationService });
    servers.push(server);

    const startedAt = performance.now();
    const response = await request(socketPath, {
      jsonrpc: "2.0",
      id: "native-cold-mount",
      method: "dashboard.snapshot",
      params: { limit: 20, enrich: false, includeHistory: false }
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(response).toMatchObject({
      result: { kind: "dashboard", enrichment: { state: "structural" } }
    });
    expect(applicationService.dashboardSnapshot).toHaveBeenCalledWith({
      problems: undefined,
      statusFilter: undefined,
      limit: 20,
      terminalOffset: undefined,
      idleOffset: undefined,
      inspectRuntime: false,
      includeHistory: false
    });
  });

  it("localizes native Settings warnings using the requested locale", async () => {
    const socketPath = temporarySocketPath();
    const applicationService = fakeApplicationService();
    vi.mocked(applicationService.settingsSnapshot).mockResolvedValue({
      settings: { settingsRevision: 3, uiLocalePreference: "ko" },
      catalog: { stale: false, warning: null, models: [] },
      warnings: [
        "Backend routing: app-server applies only to new or deliberately fresh Agent threads. " +
          "Existing Agent threads remain pinned to their original backend. To cross backends, " +
          "choose the existing Agent with context='fresh' and provide an explicit handoffSummary; " +
          "the prior transcript and backend state are not copied."
      ],
      scopeNotice: "unlocalized"
    } as SettingsView);
    const server = await startBridgeCompanionServer({ socketPath, applicationService });
    servers.push(server);

    const response = await request(socketPath, {
      jsonrpc: "2.0",
      id: "localized-settings",
      method: "settings.snapshot",
      params: { refreshModels: false, locale: "ko-KR" }
    });

    expect(response.result.warnings[0]).toContain("백엔드 라우팅");
    expect(response.result.scopeNotice).not.toBe("unlocalized");
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
    expect(valid).toMatchObject({
      id: "hello-after-invalid",
      result: { protocol: { version: COMPANION_PROTOCOL_VERSION } }
    });
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

  it("keeps remote publication and device controls on the private local socket", async () => {
    const socketPath = temporarySocketPath();
    const remoteManagement = fakeRemoteManagement();
    const server = await startBridgeCompanionServer({
      socketPath,
      applicationService: fakeApplicationService(),
      remoteManagement
    });
    servers.push(server);

    const hello = await request(socketPath, {
      jsonrpc: "2.0",
      id: "hello-with-remote-controls",
      method: "companion.hello",
      params: {}
    });
    expect(hello.result.capabilities).toContain("remote-management.configure");

    const configured = await request(socketPath, {
      jsonrpc: "2.0",
      id: "remote-configure",
      method: "remote.configure",
      params: {
        enabled: true,
        endpoint: "https://studio.example:8766",
        displayName: "Studio"
      }
    });
    expect(remoteManagement.configure).toHaveBeenCalledWith({
      enabled: true,
      endpoint: "https://studio.example:8766",
      displayName: "Studio"
    });
    expect(configured.result).toMatchObject({ enabled: false, serverId: expect.any(String) });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "remote-pair",
      method: "remote.pairing.begin",
      params: { expiresInSeconds: 120 }
    });
    expect(remoteManagement.beginPairing).toHaveBeenCalledWith(120);

    const deviceId = "11111111-1111-4111-8111-111111111111";
    await request(socketPath, {
      jsonrpc: "2.0",
      id: "remote-revoke",
      method: "remote.devices.revoke",
      params: { deviceId }
    });
    expect(remoteManagement.revokeDevice).toHaveBeenCalledWith(deviceId);
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

function fakeRemoteManagement(): RemoteCompanionControl {
  const status = {
    enabled: false,
    listening: false,
    endpoint: null,
    displayName: "Studio",
    serverId: "11111111-1111-4111-8111-111111111111",
    certificateSha256: null,
    lastError: null,
    devices: []
  };
  return {
    status: vi.fn(() => status),
    configure: vi.fn(async () => status),
    beginPairing: vi.fn(async () => ({
      invitation: "invitation",
      endpoint: "https://studio.example:8766",
      serverId: status.serverId,
      certificateSha256: "a".repeat(64),
      expiresAt: "2026-09-04T00:05:00.000Z"
    })),
    revokeDevice: vi.fn(async () => status)
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
