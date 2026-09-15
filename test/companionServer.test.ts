import { existsSync, lstatSync, mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
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
  it("keeps opaque completion notification delivery on the local socket", async () => {
    const socketPath = temporarySocketPath();
    const service = fakeApplicationService();
    const leaseOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    service.claimNativeCompletionNotifications = vi.fn(async () => [{
      eventId: "completion-" + "a".repeat(64),
      outboxId: 7
    }]);
    service.markNativeCompletionNotificationsDelivered = vi.fn(async () => undefined);
    service.releaseNativeCompletionNotifications = vi.fn(async () => undefined);
    servers.push(await startBridgeCompanionServer({ socketPath, applicationService: service }));

    const hello = await request(socketPath, {
      jsonrpc: "2.0", id: "completion-hello", method: "companion.hello", params: {}
    });
    expect(hello.result.capabilities).toContain("completion-notifications.local-delivery");

    const claimed = await request(socketPath, {
      jsonrpc: "2.0", id: "completion-claim", method: "completion.claim",
      params: { leaseOwner, limit: 2 }
    });
    expect(claimed).toMatchObject({
      result: { events: [{ eventId: "completion-" + "a".repeat(64), outboxId: 7 }] }
    });
    expect(Object.keys(claimed.result.events[0]).sort()).toEqual(["eventId", "outboxId"]);
    expect(service.claimNativeCompletionNotifications).toHaveBeenCalledWith({ leaseOwner, limit: 2 });

    const mutation = { leaseOwner, outboxIds: [7] };
    expect(await request(socketPath, {
      jsonrpc: "2.0", id: "completion-delivered", method: "completion.delivered", params: mutation
    })).toMatchObject({ result: { ok: true } });
    expect(service.markNativeCompletionNotificationsDelivered).toHaveBeenCalledWith(mutation);
    expect(await request(socketPath, {
      jsonrpc: "2.0", id: "completion-release", method: "completion.release", params: mutation
    })).toMatchObject({ result: { ok: true } });
    expect(service.releaseNativeCompletionNotifications).toHaveBeenCalledWith(mutation);
    expect(REMOTE_COMPANION_APPLICATION_METHODS.has("completion.claim")).toBe(false);

    expect(await request(socketPath, {
      jsonrpc: "2.0", id: "completion-invalid", method: "completion.claim",
      params: { leaseOwner: "not-a-uuid" }
    })).toHaveProperty("error");
    expect(service.claimNativeCompletionNotifications).toHaveBeenCalledTimes(1);
  });

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
  it("uses the same bridge skill source and immutable versions as MCP", async () => {
    const socketPath = temporarySocketPath();
    const service = fakeApplicationService();
    const first = {
      skillId: `bridge_${"a".repeat(32)}`,
      source: "bridge" as const,
      version: "1",
      name: "Report review",
      description: "Review reports.",
      contentDigest: "b".repeat(64),
      enabled: true,
      availability: "available",
      execution: { mode: "conversation-or-codex", note: "Apply directly.", requirements: [] }
    };
    service.skillLibrarySnapshot = vi.fn(async () => ({
      skills: [first]
    }));
    service.readBridgeSkill = vi.fn(async () => ({
      skill: first,
      instructions: "Check every claim.",
      references: [],
      sourceSnapshot: "versioned-bridge-record" as const,
      warnings: []
    }));
    service.readBridgeSkillReference = vi.fn(async ({ reference, referenceId }) => ({
      skill: reference,
      execution: first.execution,
      reference: {
        referenceId,
        name: "Checklist",
        mediaType: "text/plain",
        contentDigest: "c".repeat(64),
        bytes: 11
      },
      content: "- verify\n",
      sourceSnapshot: "versioned-bridge-record" as const,
      warnings: []
    }));
    service.listBridgeSkillVersions = vi.fn(async () => ({
      skillId: first.skillId,
      source: "bridge" as const,
      currentVersion: "1",
      enabled: true,
      versions: [{
        skillId: first.skillId,
        source: "bridge" as const,
        version: "1",
        name: first.name,
        description: first.description,
        contentDigest: first.contentDigest,
        createdAt: "2026-09-15T00:00:00.000Z",
        referenceCount: 1,
        execution: first.execution
      }]
    }));
    service.createBridgeSkill = vi.fn(async () => first);
    service.updateBridgeSkill = vi.fn(async () => ({ ...first, version: "2" }));
    service.restoreBridgeSkill = vi.fn(async () => ({ ...first, version: "3" }));
    service.setBridgeSkillEnabled = vi.fn(async () => ({ ...first, enabled: false, availability: "disabled" as const }));
    servers.push(await startBridgeCompanionServer({ socketPath, applicationService: service }));

    const hello = await request(socketPath, {
      jsonrpc: "2.0", id: "skills-hello", method: "companion.hello", params: {}
    });
    expect(hello.result.capabilities).toEqual(expect.arrayContaining(["skills.read", "skills.write"]));

    await expect(request(socketPath, {
      jsonrpc: "2.0", id: "skills-snapshot", method: "skills.snapshot", params: {}
    })).resolves.toMatchObject({ result: { skills: [first] } });
    expect(service.skillLibrarySnapshot).toHaveBeenCalledTimes(1);

    await expect(request(socketPath, {
      jsonrpc: "2.0", id: "skills-read", method: "skills.read",
      params: { skillId: first.skillId, source: "bridge", version: "1" }
    })).resolves.toMatchObject({ result: { instructions: "Check every claim." } });

    await expect(request(socketPath, {
      jsonrpc: "2.0", id: "skills-reference", method: "skills.reference",
      params: { reference: { skillId: first.skillId, source: "bridge", version: "1" }, referenceId: "ref_" + "c".repeat(32) }
    })).resolves.toMatchObject({ result: { content: "- verify\n" } });
    await expect(request(socketPath, {
      jsonrpc: "2.0", id: "skills-versions", method: "skills.versions", params: { skillId: first.skillId }
    })).resolves.toMatchObject({ result: { currentVersion: "1" } });

    const create = {
      requestId: randomUUID(),
      name: "Report review",
      description: "Review reports.",
      instructions: "Check every claim."
    };
    await request(socketPath, {
      jsonrpc: "2.0", id: "skills-create", method: "skills.create", params: create
    });
    expect(service.createBridgeSkill).toHaveBeenCalledWith(create);

    // Quotes force JSON escaping. This is a valid maximum-size skill mutation
    // whose serialized wire form exceeds the old 3 MiB transport cap.
    const maxEscapedText = "\"".repeat(512 * 1_024);
    const largeCreate = {
      requestId: randomUUID(),
      name: "Large bridge skill",
      description: "Exercises the declared bridge skill material boundary.",
      instructions: maxEscapedText,
      references: [
        { name: "Part one", content: maxEscapedText },
        { name: "Part two", content: maxEscapedText },
        { name: "Part three", content: maxEscapedText },
        { name: "Part four", content: maxEscapedText }
      ]
    };
    await expect(request(socketPath, {
      jsonrpc: "2.0", id: "skills-create-large", method: "skills.create", params: largeCreate
    })).resolves.toMatchObject({ result: { skillId: first.skillId } });
    expect(service.createBridgeSkill).toHaveBeenLastCalledWith(largeCreate);

    const update = { requestId: randomUUID(), skillId: first.skillId, expectedVersion: "1", instructions: "Check evidence too." };
    await expect(request(socketPath, {
      jsonrpc: "2.0", id: "skills-update", method: "skills.update", params: update
    })).resolves.toMatchObject({ result: { version: "2" } });
    expect(service.updateBridgeSkill).toHaveBeenCalledWith(update);

    const restore = { requestId: randomUUID(), skillId: first.skillId, expectedVersion: "2", sourceVersion: "1" };
    await expect(request(socketPath, {
      jsonrpc: "2.0", id: "skills-restore", method: "skills.restore", params: restore
    })).resolves.toMatchObject({ result: { version: "3" } });
    expect(service.restoreBridgeSkill).toHaveBeenCalledWith(restore);

    const setEnabled = { requestId: randomUUID(), skillId: first.skillId, expectedVersion: "3", enabled: false };
    await expect(request(socketPath, {
      jsonrpc: "2.0", id: "skills-disable", method: "skills.set-enabled", params: setEnabled
    })).resolves.toMatchObject({ result: { enabled: false } });
    expect(service.setBridgeSkillEnabled).toHaveBeenCalledWith(setEnabled);

    const wrongSource = await request(socketPath, {
      jsonrpc: "2.0", id: "skills-wrong-source", method: "skills.read",
      params: { skillId: first.skillId, source: "codex", version: "1" }
    });
    expect(wrongSource).toHaveProperty("error");
    expect(service.readBridgeSkill).toHaveBeenCalledTimes(1);
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
    const params = {rowKey:"a".repeat(32),expectedRevision:"b".repeat(64),action:"acknowledge",requestId:"11111111-1111-4111-8111-111111111111"};
    expect(await request(socketPath,{jsonrpc:"2.0",id:1,method:"dashboard.history",params})).toMatchObject({result:{ok:true}});
    expect(applicationService.historyAction).toHaveBeenCalledWith(params);
    expect(await request(socketPath,{jsonrpc:"2.0",id:2,method:"dashboard.history",params:{...params,force:true}})).toHaveProperty("error");
    expect(applicationService.historyAction).toHaveBeenCalledTimes(1);
  });

  it("loads one Agent's deferred Dashboard history through the private socket", async () => {
    const socketPath = temporarySocketPath(), applicationService = fakeApplicationService();
    applicationService.dashboardHistoryDetail = vi.fn(async ({ rowKey }) => ({
      kind: "dashboard-history" as const, rowKey, history: [], historyCount: 0,
      historyRevision: "b".repeat(64)
    }));
    servers.push(await startBridgeCompanionServer({ socketPath, applicationService }));
    const params = { rowKey: "a".repeat(32) };
    expect(await request(socketPath, {
      jsonrpc: "2.0", id: "history-detail", method: "dashboard.history-detail", params
    })).toMatchObject({ result: {
      kind: "dashboard-history", rowKey: params.rowKey, historyRevision: "b".repeat(64)
    } });
    expect(applicationService.dashboardHistoryDetail).toHaveBeenCalledWith(params);
    expect(await request(socketPath, {
      jsonrpc: "2.0", id: "invalid-history-detail", method: "dashboard.history-detail", params: { rowKey: "bad" }
    })).toHaveProperty("error");
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
        "CODEX_MCP_BRIDGE_ROOTS is a legacy compatibility restriction. " +
          "Remove it to manage all project folders only from Codex settings."
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

    expect(response.result.warnings[0]).toBe(
      "CODEX_MCP_BRIDGE_ROOTS는 이전 버전 호환용 제한입니다. " +
        "프로젝트 폴더를 Codex 설정에서만 관리하려면 이 값을 제거하세요."
    );
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
