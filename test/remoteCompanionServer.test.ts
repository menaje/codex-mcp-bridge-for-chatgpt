import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_COMPANION_PROTOCOL_NAME,
  REMOTE_COMPANION_PROTOCOL_VERSION,
  RemoteCompanionManager
} from "../src/remoteCompanionServer.js";
import type {
  BridgeApplicationService,
  DashboardView,
  SettingsView
} from "../src/tools.js";

const managers: RemoteCompanionManager[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("remote native companion", () => {
  it("pairs one device over pinned TLS and serves only the remote application API", async () => {
    const directory = temporaryDirectory();
    const stateFile = path.join(directory, "remote.json");
    const port = await availablePort();
    const endpoint = `https://127.0.0.1:${port}`;
    const applicationService = fakeApplicationService();
    const manager = new RemoteCompanionManager({ stateFile, applicationService });
    managers.push(manager);

    expect(manager.status()).toMatchObject({
      enabled: false,
      listening: false,
      lastProblem: null,
      devices: []
    });
    const enabled = await manager.configure({
      enabled: true,
      endpoint,
      displayName: "작업실 서버"
    });
    expect(enabled).toMatchObject({
      enabled: true,
      listening: true,
      endpoint,
      displayName: "작업실 서버"
    });
    expect(enabled.certificateSha256).toMatch(/^[a-f0-9]{64}$/);

    const invitation = await manager.beginPairing(60);
    const decoded = JSON.parse(
      Buffer.from(invitation.invitation, "base64url").toString("utf8")
    ) as Record<string, string | number>;
    expect(decoded).toMatchObject({
      version: 1,
      protocol: REMOTE_COMPANION_PROTOCOL_NAME,
      endpoint,
      serverId: enabled.serverId,
      certificateSha256: enabled.certificateSha256
    });

    const hello = await jsonRequest(`${endpoint}/remote-companion/v1/hello`, "GET");
    expect(hello.status).toBe(200);
    expect(hello.fingerprint).toBe(enabled.certificateSha256);
    expect(hello.body).toMatchObject({
      protocol: {
        name: REMOTE_COMPANION_PROTOCOL_NAME,
        version: REMOTE_COMPANION_PROTOCOL_VERSION
      },
      server: { id: enabled.serverId, displayName: "작업실 서버" }
    });

    const paired = await jsonRequest(`${endpoint}/remote-companion/v1/pair`, "POST", {
      serverId: decoded.serverId,
      code: decoded.code,
      deviceName: "거실 Mac"
    });
    expect(paired.status).toBe(200);
    const credential = paired.body.credential as string;
    const deviceId = paired.body.device.id as string;
    expect(credential).toMatch(/^device_[A-Za-z0-9_-]{40,}$/);
    expect(manager.status().devices).toEqual([
      expect.objectContaining({ id: deviceId, name: "거실 Mac", lastSeenAt: null })
    ]);
    const persisted = readFileSync(stateFile, "utf8");
    expect(persisted).not.toContain(credential);
    expect(persisted).not.toContain(String(decoded.code));
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);

    const authenticatedHello = await jsonRequest(
      `${endpoint}/remote-companion/v1/rpc`,
      "POST",
      { jsonrpc: "2.0", id: "hello-authenticated", method: "companion.hello", params: {} },
      {
        authorization: `Bearer ${credential}`,
        "x-codex-bridge-server-id": enabled.serverId
      }
    );
    expect(authenticatedHello).toMatchObject({
      status: 200,
      body: {
        id: "hello-authenticated",
        result: {
          protocol: {
            name: REMOTE_COMPANION_PROTOCOL_NAME,
            version: REMOTE_COMPANION_PROTOCOL_VERSION
          },
          server: { id: enabled.serverId }
        }
      }
    });

    const rpcPayload = {
      jsonrpc: "2.0",
      id: "dashboard-1",
      method: "dashboard.snapshot",
      params: { limit: 12, terminalOffset: 0, idleOffset: 0, enrich: false }
    };
    const unauthorized = await jsonRequest(
      `${endpoint}/remote-companion/v1/rpc`,
      "POST",
      rpcPayload,
      { "x-codex-bridge-server-id": enabled.serverId }
    );
    expect(unauthorized).toMatchObject({ status: 401, body: { error: "unauthorized" } });

    const wrongIdentity = await jsonRequest(
      `${endpoint}/remote-companion/v1/rpc`,
      "POST",
      rpcPayload,
      {
        authorization: `Bearer ${credential}`,
        "x-codex-bridge-server-id": "eb85d508-b32d-4b0a-a68a-9f53c778be27"
      }
    );
    expect(wrongIdentity).toMatchObject({
      status: 409,
      body: { error: "server_identity_mismatch" }
    });

    const dashboard = await jsonRequest(
      `${endpoint}/remote-companion/v1/rpc`,
      "POST",
      rpcPayload,
      {
        authorization: `Bearer ${credential}`,
        "x-codex-bridge-server-id": enabled.serverId
      }
    );
    expect(dashboard).toMatchObject({
      status: 200,
      body: { jsonrpc: "2.0", id: "dashboard-1", result: { kind: "dashboard" } }
    });
    expect(applicationService.dashboardSnapshot).toHaveBeenCalledWith({
      limit: 12,
      terminalOffset: 0,
      idleOffset: 0,
      inspectRuntime: false
    });
    expect(manager.status().devices[0]?.lastSeenAt).not.toBeNull();

    const forbiddenControl = await jsonRequest(
      `${endpoint}/remote-companion/v1/rpc`,
      "POST",
      { jsonrpc: "2.0", id: 2, method: "remote.status", params: {} },
      {
        authorization: `Bearer ${credential}`,
        "x-codex-bridge-server-id": enabled.serverId
      }
    );
    expect(forbiddenControl).toMatchObject({
      status: 403,
      body: { error: "method_not_available_remotely" }
    });

    await manager.revokeDevice(deviceId);
    const revoked = await jsonRequest(
      `${endpoint}/remote-companion/v1/rpc`,
      "POST",
      rpcPayload,
      {
        authorization: `Bearer ${credential}`,
        "x-codex-bridge-server-id": enabled.serverId
      }
    );
    expect(revoked.status).toBe(401);
  });

  it("uses one-shot expiring invitations and retains server identity across restarts", async () => {
    const directory = temporaryDirectory();
    const stateFile = path.join(directory, "remote.json");
    const endpoint = `https://127.0.0.1:${await availablePort()}`;
    const first = new RemoteCompanionManager({
      stateFile,
      applicationService: fakeApplicationService()
    });
    managers.push(first);
    await first.configure({ enabled: true, endpoint, displayName: "서버" });
    const invitation = await first.beginPairing(60);
    const decoded = JSON.parse(
      Buffer.from(invitation.invitation, "base64url").toString("utf8")
    ) as Record<string, string>;

    const firstPair = await jsonRequest(`${endpoint}/remote-companion/v1/pair`, "POST", {
      serverId: decoded.serverId,
      code: decoded.code,
      deviceName: "첫 기기"
    });
    expect(firstPair.status).toBe(200);
    const replay = await jsonRequest(`${endpoint}/remote-companion/v1/pair`, "POST", {
      serverId: decoded.serverId,
      code: decoded.code,
      deviceName: "재사용 기기"
    });
    expect(replay).toMatchObject({
      status: 400,
      body: { error: "invalid_request", message: "PAIRING_EXPIRED" }
    });

    const original = first.status();
    await first.close();
    managers.splice(managers.indexOf(first), 1);
    const restarted = new RemoteCompanionManager({
      stateFile,
      applicationService: fakeApplicationService()
    });
    managers.push(restarted);
    await restarted.start();
    expect(restarted.status()).toMatchObject({
      enabled: true,
      listening: true,
      serverId: original.serverId,
      certificateSha256: original.certificateSha256,
      devices: [expect.objectContaining({ name: "첫 기기" })]
    });
  });

  it("closes authenticated access after overlapping enable requests", async () => {
    const endpoint = `https://127.0.0.1:${await availablePort()}`;
    const applicationService = fakeApplicationService();
    const manager = new RemoteCompanionManager({
      stateFile: path.join(temporaryDirectory(), "remote.json"),
      applicationService
    });
    managers.push(manager);
    const configuration = { enabled: true, endpoint, displayName: "서버" };
    await manager.configure(configuration);
    const invitation = await manager.beginPairing();
    const decoded = JSON.parse(Buffer.from(invitation.invitation, "base64url").toString("utf8"));
    const paired = await jsonRequest(`${endpoint}/remote-companion/v1/pair`, "POST", {
      serverId: decoded.serverId,
      code: decoded.code,
      deviceName: "등록 기기"
    });
    expect(paired.status).toBe(200);
    await manager.configure({ ...configuration, enabled: false });

    const enabled = await Promise.all([
      manager.configure(configuration),
      manager.configure(configuration)
    ]);
    expect(enabled).toEqual([
      expect.objectContaining({ listening: true, lastError: null }),
      expect.objectContaining({ listening: true, lastError: null })
    ]);
    const disabled = await manager.configure({ ...configuration, enabled: false });
    expect(disabled).toMatchObject({ enabled: false, listening: false, lastError: null });
    await expect(jsonRequest(
      `${endpoint}/remote-companion/v1/rpc`,
      "POST",
      { jsonrpc: "2.0", id: 1, method: "dashboard.snapshot", params: {} },
      {
        authorization: `Bearer ${paired.body.credential}`,
        "x-codex-bridge-server-id": decoded.serverId
      }
    )).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(applicationService.dashboardSnapshot).not.toHaveBeenCalled();
  });

  it("honors shutdown and disable calls queued while a listener is starting", async () => {
    const endpoint = `https://127.0.0.1:${await availablePort()}`;
    const manager = new RemoteCompanionManager({
      stateFile: path.join(temporaryDirectory(), "remote.json"),
      applicationService: fakeApplicationService()
    });
    managers.push(manager);
    const configuration = { enabled: true, endpoint, displayName: "서버" };
    await manager.configure(configuration);
    await manager.close();

    await Promise.all([manager.start(), manager.start(), manager.close()]);
    expect(manager.status().listening).toBe(false);
    await expect(jsonRequest(`${endpoint}/remote-companion/v1/hello`, "GET"))
      .rejects.toMatchObject({ code: "ECONNREFUSED" });

    await Promise.all([
      manager.configure(configuration),
      manager.configure({ ...configuration, enabled: false })
    ]);
    expect(manager.status()).toMatchObject({ enabled: false, listening: false });
    await expect(jsonRequest(`${endpoint}/remote-companion/v1/hello`, "GET"))
      .rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("serves an IPv6 endpoint and IPv4 clients from the same listener", async () => {
    const port = await availablePort("::1");
    const endpoint = `https://[::1]:${port}`;
    const manager = new RemoteCompanionManager({
      stateFile: path.join(temporaryDirectory(), "remote.json"),
      applicationService: fakeApplicationService()
    });
    managers.push(manager);
    const status = await manager.configure({ enabled: true, endpoint, displayName: "서버" });
    expect(status).toMatchObject({ endpoint, listening: true, lastError: null });

    const responses = await Promise.all([
      jsonRequest(`${endpoint}/remote-companion/v1/hello`, "GET"),
      jsonRequest(`https://127.0.0.1:${port}/remote-companion/v1/hello`, "GET")
    ]);
    for (const response of responses) {
      expect(response).toMatchObject({
        status: 200,
        fingerprint: status.certificateSha256,
        body: { server: { id: status.serverId } }
      });
    }
  });

  it.each(["0.0.0.0", "::"])("closes partial listeners when %s is already in use", async (host) => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen({ port: 0, host, ipv6Only: host === "::" }, resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not reserve a test port.");
    }
    const manager = new RemoteCompanionManager({
      stateFile: path.join(temporaryDirectory(), "remote.json"),
      applicationService: fakeApplicationService()
    });
    managers.push(manager);

    try {
      const status = await manager.configure({
        enabled: true,
        endpoint: `https://127.0.0.1:${address.port}`,
        displayName: "서버"
      });
      expect(status).toMatchObject({
        listening: false,
        lastProblem: { code: "remote-address-in-use", arguments: {} }
      });
      if (host === "::") {
        await expect(jsonRequest(
          `https://127.0.0.1:${address.port}/remote-companion/v1/hello`, "GET"
        )).rejects.toMatchObject({ code: "ECONNREFUSED" });
      }
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
    const restarted = await manager.start();
    expect(restarted).toMatchObject({ listening: true, lastError: null });
  });
});

function fakeApplicationService(): BridgeApplicationService {
  return {
    dashboardSnapshot: vi.fn(async () => ({ kind: "dashboard" }) as DashboardView),
    settingsSnapshot: vi.fn(async () => ({
      settings: { settingsRevision: 3 }
    }) as SettingsView),
    updateSettings: vi.fn(async () => ({
      settings: { settingsRevision: 4 }
    }) as SettingsView),
    runtimeSnapshot: vi.fn(async () => ({
      acceptingNewJobs: true,
      activeJobs: 0,
      pendingAdmissions: 0,
      backgroundProcessState: "confirmed" as const,
      backgroundProcesses: 0,
      backgroundProcessAgents: 0,
      backgroundProcessUnknownAgents: 0
    })),
    beginDrain: vi.fn(),
    cancelDrain: vi.fn()
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-remote-companion-"));
  directories.push(directory);
  return directory;
}

function availablePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a test port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function jsonRequest(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, any>; fingerprint: string | null }> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const request = httpsRequest(url, {
      method,
      agent: false,
      rejectUnauthorized: false,
      headers: {
        ...headers,
        ...(encoded
          ? {
              "content-type": "application/json",
              "content-length": String(encoded.length)
            }
          : {})
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      const peer = (response.socket as TLSSocket).getPeerCertificate();
      const fingerprint = peer.fingerprint256?.replaceAll(":", "").toLowerCase() || null;
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve({
            status: response.statusCode || 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            fingerprint
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}
