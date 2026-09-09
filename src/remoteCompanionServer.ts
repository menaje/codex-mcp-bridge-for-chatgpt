import { spawnSync } from "node:child_process";
import {
  X509Certificate,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import {
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { createServer, type Server as HttpsServer } from "node:https";
import path from "node:path";
import * as z from "zod/v4";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import {
  REMOTE_COMPANION_APPLICATION_METHODS,
  dispatchCompanionPayload,
  type RemoteCompanionControl,
  type RemoteCompanionDevice,
  type RemoteCompanionStatus,
  type RemotePairingInvitation
} from "./companionServer.js";
import { PRODUCT_INFO } from "./productInfo.js";
import type { BridgeApplicationService } from "./tools.js";

export const REMOTE_COMPANION_PROTOCOL_NAME = "codex-mcp-bridge-remote-companion";
export const REMOTE_COMPANION_PROTOCOL_VERSION = 1;
const REMOTE_API_PREFIX = "/remote-companion/v1";
const REMOTE_MAX_REQUEST_BYTES = 1024 * 1024;
const REMOTE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REMOTE_MAX_DEVICES = 32;
const REMOTE_DEFAULT_PAIRING_TTL_SECONDS = 300;
const REMOTE_DEVICE_CAPABILITIES = [
  "dashboard.read",
  "settings.read",
  "settings.write",
  "runtime.read"
];

const persistedDeviceSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  capabilities: z.array(z.string().min(1).max(100)).min(1).max(20)
});
const persistedStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  serverId: z.string().uuid(),
  configuration: z.strictObject({
    enabled: z.boolean(),
    endpoint: z.string().nullable(),
    displayName: z.string().min(1).max(120)
  }),
  devices: z.array(persistedDeviceSchema).max(REMOTE_MAX_DEVICES)
});
const pairingRequestSchema = z.strictObject({
  serverId: z.string().uuid(),
  code: z.string().min(40).max(200),
  deviceName: z.string().trim().min(1).max(120)
});

type PersistedRemoteState = z.infer<typeof persistedStateSchema>;
type PersistedRemoteDevice = z.infer<typeof persistedDeviceSchema>;
type PairingSession = {
  codeSha256: string;
  expiresAt: string;
  failedAttempts: number;
};

export type RemoteCompanionManagerOptions = {
  stateFile: string;
  applicationService: BridgeApplicationService;
  defaultDisplayName?: string;
  certificateFile?: string;
  privateKeyFile?: string;
};

/**
 * Owns the opt-in HTTPS management surface used by native remote clients.
 * Configuration and device records live outside Bridge settings because they
 * control access to the server itself. Device bearer credentials are returned
 * once and only SHA-256 verifiers are persisted.
 */
export class RemoteCompanionManager implements RemoteCompanionControl {
  private readonly stateFile: string;
  private readonly certificateFile: string;
  private readonly privateKeyFile: string;
  private readonly applicationService: BridgeApplicationService;
  private state: PersistedRemoteState;
  private servers: HttpsServer[] = [];
  private certificateSha256: string | null = null;
  private lastError: string | null = null;
  private pairing: PairingSession | undefined;
  private lifecycleOperation: Promise<void> = Promise.resolve();

  constructor(options: RemoteCompanionManagerOptions) {
    this.stateFile = path.resolve(options.stateFile);
    const directory = path.dirname(this.stateFile);
    this.certificateFile = path.resolve(
      options.certificateFile || path.join(directory, "remote-companion-cert.pem")
    );
    this.privateKeyFile = path.resolve(
      options.privateKeyFile || path.join(directory, "remote-companion-key.pem")
    );
    this.applicationService = options.applicationService;
    this.state = loadOrCreateState(
      this.stateFile,
      options.defaultDisplayName || "Codex MCP Bridge"
    );
  }

  async start(): Promise<RemoteCompanionStatus> {
    return this.enqueueLifecycle(async () => {
      if (this.state.configuration.enabled) await this.startListener();
      return this.status();
    });
  }

  status(): RemoteCompanionStatus {
    return {
      enabled: this.state.configuration.enabled,
      listening: this.isListening(),
      endpoint: this.state.configuration.endpoint,
      displayName: this.state.configuration.displayName,
      serverId: this.state.serverId,
      certificateSha256: this.certificateSha256,
      lastError: this.lastError,
      lastProblem: remoteManagementProblem(this.lastError),
      devices: this.state.devices.map(publicDevice)
    };
  }

  async configure(input: {
    enabled: boolean;
    endpoint: string;
    displayName: string;
  }): Promise<RemoteCompanionStatus> {
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 120) {
      throw new Error("Remote server display name must contain 1 to 120 characters.");
    }
    const endpoint = normalizeEndpoint(input.endpoint);
    const enabled = input.enabled;
    return this.enqueueLifecycle(async () => {
      await this.stopListener();
      this.pairing = undefined;
      this.state = {
        ...this.state,
        configuration: { enabled, endpoint, displayName }
      };
      persistState(this.stateFile, this.state);
      this.lastError = null;
      if (enabled) await this.startListener();
      return this.status();
    });
  }

  async beginPairing(
    expiresInSeconds = REMOTE_DEFAULT_PAIRING_TTL_SECONDS
  ): Promise<RemotePairingInvitation> {
    if (!this.state.configuration.enabled || !this.isListening()) {
      throw new Error("REMOTE_MANAGEMENT_NOT_LISTENING");
    }
    const endpoint = this.state.configuration.endpoint;
    const certificateSha256 = this.certificateSha256;
    if (!endpoint || !certificateSha256) {
      throw new Error("REMOTE_MANAGEMENT_IDENTITY_UNAVAILABLE");
    }
    const ttl = Math.max(60, Math.min(900, Math.trunc(expiresInSeconds)));
    const code = `pair_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + ttl * 1_000).toISOString();
    this.pairing = {
      codeSha256: digest(code),
      expiresAt,
      failedAttempts: 0
    };
    const invitation = Buffer.from(JSON.stringify({
      version: 1,
      protocol: REMOTE_COMPANION_PROTOCOL_NAME,
      endpoint,
      serverId: this.state.serverId,
      certificateSha256,
      code,
      expiresAt
    }), "utf8").toString("base64url");
    return {
      invitation,
      endpoint,
      serverId: this.state.serverId,
      certificateSha256,
      expiresAt
    };
  }

  async revokeDevice(deviceId: string): Promise<RemoteCompanionStatus> {
    const devices = this.state.devices.filter((device) => device.id !== deviceId);
    if (devices.length === this.state.devices.length) {
      throw new Error("REMOTE_DEVICE_NOT_FOUND");
    }
    this.state = { ...this.state, devices };
    persistState(this.stateFile, this.state);
    return this.status();
  }

  async close(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      this.pairing = undefined;
      await this.stopListener();
    });
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    // Keep listener ownership intact across calls from separate local clients.
    const result = this.lifecycleOperation.then(operation);
    this.lifecycleOperation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async startListener(): Promise<void> {
    if (this.isListening()) return;
    const endpoint = this.state.configuration.endpoint;
    if (!endpoint) {
      this.lastError = "Remote endpoint is not configured.";
      return;
    }
    const servers: HttpsServer[] = [];
    try {
      ensureCertificate(this.certificateFile, this.privateKeyFile);
      const certificate = readFileSync(this.certificateFile, "utf8");
      const privateKey = readFileSync(this.privateKeyFile, "utf8");
      this.certificateSha256 = certificateFingerprint(certificate);
      // Own both address families explicitly: on macOS a dual-stack IPv6 bind
      // can succeed even when another process already owns the IPv4 port.
      for (const host of ["0.0.0.0", "::"]) {
        const server = createServer(
          {
            cert: certificate,
            key: privateKey,
            minVersion: "TLSv1.2"
          },
          (request, response) => {
            void this.serve(request, response);
          }
        );
        servers.push(server);
        server.maxConnections = 16;
        server.requestTimeout = 30_000;
        server.headersTimeout = 10_000;
        server.keepAliveTimeout = 5_000;
        const port = endpointPort(endpoint);
        try {
          await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
              server.removeListener("listening", onListening);
              reject(error);
            };
            const onListening = () => {
              server.removeListener("error", onError);
              resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen({ port, host, ipv6Only: host === "::" });
          });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (host === "::" && !new URL(endpoint).hostname.startsWith("[") &&
              (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL")) {
            // Preserve IPv4 operation on hosts where IPv6 is disabled.
            servers.pop();
            await this.closeServers([server]);
            continue;
          }
          throw error;
        }
        server.on("clientError", (_error, socket) => socket.destroy());
      }
      this.servers = servers;
      this.lastError = null;
    } catch (error) {
      await this.closeServers(servers);
      this.lastError = safeErrorMessage(error);
    }
  }

  private async stopListener(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    await this.closeServers(servers);
  }

  private isListening(): boolean {
    return this.servers.length > 0 && this.servers.every((server) => server.listening);
  }

  private async closeServers(servers: HttpsServer[]): Promise<void> {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    })));
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setSecurityHeaders(response);
    if (!this.state.configuration.enabled || !this.isListening()) {
      sendJson(response, 503, { error: "remote_management_not_listening" });
      return;
    }
    try {
      const url = new URL(request.url || "/", "https://remote.invalid");
      if (request.method === "GET" && url.pathname === `${REMOTE_API_PREFIX}/hello`) {
        sendJson(response, 200, this.hello());
        return;
      }
      if (request.method === "POST" && url.pathname === `${REMOTE_API_PREFIX}/pair`) {
        const body = pairingRequestSchema.parse(await readJsonBody(request));
        sendJson(response, 200, await this.completePairing(body));
        return;
      }
      if (request.method === "POST" && url.pathname === `${REMOTE_API_PREFIX}/rpc`) {
        const device = this.authenticate(request);
        if (!device) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        if (request.headers["x-codex-bridge-server-id"] !== this.state.serverId) {
          sendJson(response, 409, { error: "server_identity_mismatch" });
          return;
        }
        const payload = await readJsonBody(request);
        const method = companionMethod(payload);
        if (!method || !REMOTE_COMPANION_APPLICATION_METHODS.has(method)) {
          sendJson(response, 403, { error: "method_not_available_remotely" });
          return;
        }
        if (!device.capabilities.includes(capabilityForMethod(method))) {
          sendJson(response, 403, { error: "capability_denied" });
          return;
        }
        this.noteDeviceSeen(device);
        const result = await dispatchCompanionPayload(payload, this.applicationService);
        if (method === "companion.hello" && !result.error) {
          result.result = this.hello();
        }
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const message = safeErrorMessage(error);
      const status = message === "request_too_large" ? 413 : 400;
      sendJson(response, status, { error: "invalid_request", message });
    }
  }

  private hello(): Record<string, unknown> {
    return {
      protocol: {
        name: REMOTE_COMPANION_PROTOCOL_NAME,
        version: REMOTE_COMPANION_PROTOCOL_VERSION
      },
      server: {
        id: this.state.serverId,
        displayName: this.state.configuration.displayName,
        certificateSha256: this.certificateSha256
      },
      bridge: {
        name: PRODUCT_INFO.runtimeName,
        title: PRODUCT_INFO.displayName,
        version: BRIDGE_BUILD_INFO.version,
        buildId: BRIDGE_BUILD_INFO.id
      },
      capabilities: [...REMOTE_DEVICE_CAPABILITIES]
    };
  }

  private async completePairing(input: z.infer<typeof pairingRequestSchema>): Promise<Record<string, unknown>> {
    const pairing = this.pairing;
    if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) {
      this.pairing = undefined;
      throw new Error("PAIRING_EXPIRED");
    }
    if (input.serverId !== this.state.serverId || !digestMatches(pairing.codeSha256, input.code)) {
      pairing.failedAttempts += 1;
      if (pairing.failedAttempts >= 5) this.pairing = undefined;
      throw new Error("PAIRING_CODE_INVALID");
    }
    if (this.state.devices.length >= REMOTE_MAX_DEVICES) {
      throw new Error("REMOTE_DEVICE_LIMIT_REACHED");
    }
    this.pairing = undefined;
    const credential = `device_${randomBytes(32).toString("base64url")}`;
    const device: PersistedRemoteDevice = {
      id: randomUUID(),
      name: input.deviceName,
      credentialSha256: digest(credential),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      capabilities: [...REMOTE_DEVICE_CAPABILITIES]
    };
    this.state = { ...this.state, devices: [...this.state.devices, device] };
    persistState(this.stateFile, this.state);
    return {
      credential,
      device: publicDevice(device),
      hello: this.hello()
    };
  }

  private authenticate(request: IncomingMessage): PersistedRemoteDevice | undefined {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const credential = authorization.slice("Bearer ".length);
    if (credential.length < 40 || credential.length > 200) return undefined;
    const credentialDigest = digest(credential);
    return this.state.devices.find((device) =>
      digestMatches(device.credentialSha256, credentialDigest, true)
    );
  }

  private noteDeviceSeen(device: PersistedRemoteDevice): void {
    const now = Date.now();
    if (device.lastSeenAt && now - Date.parse(device.lastSeenAt) < 60_000) return;
    device.lastSeenAt = new Date(now).toISOString();
    persistState(this.stateFile, this.state);
  }
}

function loadOrCreateState(stateFile: string, displayName: string): PersistedRemoteState {
  ensurePrivateDirectory(path.dirname(stateFile));
  if (!existsSync(stateFile)) {
    const state: PersistedRemoteState = {
      schemaVersion: 1,
      serverId: randomUUID(),
      configuration: {
        enabled: false,
        endpoint: null,
        displayName: displayName.trim().slice(0, 120) || "Codex MCP Bridge"
      },
      devices: []
    };
    persistState(stateFile, state);
    return state;
  }
  assertPrivateRegularFile(stateFile);
  return persistedStateSchema.parse(JSON.parse(readFileSync(stateFile, "utf8")));
}

function persistState(stateFile: string, state: PersistedRemoteState): void {
  persistedStateSchema.parse(state);
  const directory = path.dirname(stateFile);
  ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.remote-state-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, stateFile);
    chmodSync(stateFile, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function ensureCertificate(certificateFile: string, privateKeyFile: string): void {
  ensurePrivateDirectory(path.dirname(certificateFile));
  if (path.dirname(certificateFile) !== path.dirname(privateKeyFile)) {
    ensurePrivateDirectory(path.dirname(privateKeyFile));
  }
  const certificateExists = existsSync(certificateFile);
  const keyExists = existsSync(privateKeyFile);
  if (certificateExists !== keyExists) {
    throw new Error("Remote TLS certificate and private key must either both exist or both be absent.");
  }
  if (certificateExists) {
    assertPrivateRegularFile(certificateFile);
    assertPrivateRegularFile(privateKeyFile);
    return;
  }
  const suffix = randomUUID();
  const temporaryCertificate = `${certificateFile}.${suffix}.tmp`;
  const temporaryKey = `${privateKeyFile}.${suffix}.tmp`;
  const openssl = process.platform === "darwin" ? "/usr/bin/openssl" : "openssl";
  const result = spawnSync(openssl, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "3650",
    "-nodes",
    "-keyout",
    temporaryKey,
    "-out",
    temporaryCertificate,
    "-subj",
    "/CN=Codex MCP Bridge Remote Companion"
  ], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024
  });
  if (result.status !== 0) {
    try { unlinkSync(temporaryCertificate); } catch { /* best effort */ }
    try { unlinkSync(temporaryKey); } catch { /* best effort */ }
    throw new Error(`Could not generate the remote TLS identity: ${safeErrorMessage(result.stderr)}`);
  }
  try {
    chmodSync(temporaryCertificate, 0o600);
    chmodSync(temporaryKey, 0o600);
    renameSync(temporaryCertificate, certificateFile);
    renameSync(temporaryKey, privateKeyFile);
  } catch (error) {
    try { unlinkSync(temporaryCertificate); } catch { /* best effort */ }
    try { unlinkSync(temporaryKey); } catch { /* best effort */ }
    throw error;
  }
}

function certificateFingerprint(certificate: string): string {
  return new X509Certificate(certificate).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Remote management directory must be a regular directory.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (typeof uid === "number" && stats.uid !== uid) {
    throw new Error("Remote management directory must be owned by the current user.");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Remote management directory permissions must be 0700.");
  }
}

function assertPrivateRegularFile(file: string): void {
  const stats = lstatSync(file);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Remote management state must use regular files.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (typeof uid === "number" && stats.uid !== uid) {
    throw new Error("Remote management files must be owned by the current user.");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Remote management file permissions must be 0600.");
  }
}

function normalizeEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Remote endpoint must be a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Remote endpoint must be an HTTPS origin without credentials, path, query, or fragment.");
  }
  const port = endpointPort(url.origin);
  if (port < 1 || port > 65_535) throw new Error("Remote endpoint port is invalid.");
  return url.origin;
}

function endpointPort(endpoint: string): number {
  const url = new URL(endpoint);
  return url.port ? Number(url.port) : 443;
}

function publicDevice(device: PersistedRemoteDevice): RemoteCompanionDevice {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    capabilities: [...device.capabilities]
  };
}

function companionMethod(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const method = (payload as Record<string, unknown>).method;
  return typeof method === "string" ? method : undefined;
}

function capabilityForMethod(method: string): string {
  switch (method) {
    case "companion.hello":
    case "dashboard.snapshot":
      return "dashboard.read";
    case "settings.snapshot":
      return "settings.read";
    case "settings.update":
    case "dashboard.history":
      return "settings.write";
    case "runtime.snapshot":
      return "runtime.read";
    default:
      return "unavailable";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestMatches(expected: string, input: string, inputIsDigest = false): boolean {
  const actual = inputIsDigest ? input : digest(input);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new Error("content_type_must_be_application_json");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > REMOTE_MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("request_body_required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Strict-Transport-Security", "max-age=31536000");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > REMOTE_MAX_RESPONSE_BYTES) {
    status = 500;
    body = JSON.stringify({ error: "response_too_large" });
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  response.end(body);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000) || "Remote companion request failed.";
}

function remoteManagementProblem(
  message: string | null
): { code: string; arguments: Record<string, string> } | null {
  if (!message) return null;
  let code = "remote-listener-failed";
  if (message === "Remote endpoint is not configured.") {
    code = "remote-endpoint-not-configured";
  } else if (message.includes("EADDRINUSE")) {
    code = "remote-address-in-use";
  } else if (message.includes("EACCES") || message.includes("EPERM")) {
    code = "remote-listener-permission-denied";
  } else if (
    message.includes("certificate") ||
    message.includes("private key") ||
    message.includes("TLS identity") ||
    message.includes("openssl")
  ) {
    code = "remote-tls-identity-failed";
  }
  return { code, arguments: {} };
}
