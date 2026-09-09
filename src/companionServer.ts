import { dashboardHistoryActionInput } from "./workHistory.js";
import { problemActionSchema, problemQuerySchema } from "./problemReview.js";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  unlinkSync
} from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket
} from "node:net";
import path from "node:path";
import * as z from "zod/v4";
import { DASHBOARD_STATUS_FILTERS } from "./dashboardPresentation.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { ChangeSignal, changeWaitParamsSchema } from "./changeSignal.js";
import { PRODUCT_INFO } from "./productInfo.js";
import type {
  BridgeApplicationService,
  BridgeSettingsMutationInput
} from "./tools.js";
import { localizeSettingsView } from "./settingsLocalization.js";

export const COMPANION_PROTOCOL_NAME = "codex-mcp-bridge-companion";
export const COMPANION_PROTOCOL_VERSION = 2;
export const COMPANION_MAX_REQUEST_BYTES = 1024 * 1024;
export const COMPANION_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const COMPANION_MAX_CLIENTS = 8;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

const requestIdSchema = z.union([
  z.string().min(1).max(128),
  z.number().int().safe()
]);

const requestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema,
  method: z.enum([
    "companion.hello",
    "changes.wait",
    "dashboard.snapshot",
    "dashboard.history",
    "dashboard.problem",
    "thread.handoff",
    "settings.snapshot",
    "settings.update",
    "runtime.snapshot",
    "runtime.health",
    "runtime.beginDrain",
    "runtime.cancelDrain",
    "remote.status",
    "remote.configure",
    "remote.pairing.begin",
    "remote.devices.revoke"
  ]),
  params: z.unknown().optional()
});

const emptyParamsSchema = z.strictObject({});
const dashboardParamsSchema = z.strictObject({
  problems: problemQuerySchema.optional(),
  statusFilter: z.enum(DASHBOARD_STATUS_FILTERS).optional(),
  limit: z.number().int().min(5).max(50).optional(),
  terminalOffset: z.number().int().min(0).max(1_000_000_000).optional(),
  idleOffset: z.number().int().min(0).max(1_000_000_000).optional(),
  enrich: z.boolean().optional()
});
const settingsSnapshotParamsSchema = z.strictObject({
  refreshModels: z.boolean().optional(),
  locale: z.string().min(1).max(100).optional()
});
const runtimeSnapshotParamsSchema = z.strictObject({
  inspectBackgroundProcesses: z.boolean().optional()
});
const remoteConfigureParamsSchema = z.strictObject({
  enabled: z.boolean(),
  endpoint: z.string().min(1).max(2_048),
  displayName: z.string().min(1).max(120)
});
const remotePairingParamsSchema = z.strictObject({
  expiresInSeconds: z.number().int().min(60).max(900).optional()
});
const remoteRevokeParamsSchema = z.strictObject({
  deviceId: z.string().uuid()
});

type CompanionRequest = z.infer<typeof requestSchema>;
type JsonRpcId = z.infer<typeof requestIdSchema> | null;

export type BridgeCompanionServer = {
  readonly socketPath: string;
  close(): Promise<void>;
};

export type BridgeCompanionServerOptions = {
  socketPath: string;
  applicationService: BridgeApplicationService;
  remoteManagement?: RemoteCompanionControl;
};

export type RemoteCompanionDevice = {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  capabilities: string[];
};

export type RemoteCompanionStatus = {
  enabled: boolean;
  listening: boolean;
  endpoint: string | null;
  displayName: string;
  serverId: string;
  certificateSha256: string | null;
  lastError: string | null;
  lastProblem?: {
    code: string;
    arguments: Record<string, string>;
  } | null;
  devices: RemoteCompanionDevice[];
};

export type RemotePairingInvitation = {
  invitation: string;
  endpoint: string;
  serverId: string;
  certificateSha256: string;
  expiresAt: string;
};

export type RemoteCompanionControl = {
  status(): RemoteCompanionStatus;
  configure(input: {
    enabled: boolean;
    endpoint: string;
    displayName: string;
  }): Promise<RemoteCompanionStatus>;
  beginPairing(expiresInSeconds?: number): Promise<RemotePairingInvitation>;
  revokeDevice(deviceId: string): Promise<RemoteCompanionStatus>;
};

export const REMOTE_COMPANION_APPLICATION_METHODS = new Set([
  "companion.hello",
  "dashboard.snapshot",
  "dashboard.history",
  "dashboard.problem",
  "settings.snapshot",
  "settings.update",
  "runtime.snapshot"
]);

export type PrivateJsonLineServerOptions = {
  socketPath: string;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxClients?: number;
  dispatch(line: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  requestTooLarge(): Record<string, unknown>;
  internalError(error: unknown): Record<string, unknown>;
};

/**
 * Start a per-user, line-delimited JSON-RPC control socket for the native app.
 * The socket grants only the explicit companion methods above; it is not an MCP
 * endpoint and carries no mounted-card capability.
 */
export async function startBridgeCompanionServer(
  options: BridgeCompanionServerOptions
): Promise<BridgeCompanionServer> {
  const changes = new ChangeSignal(["dashboard", "settings", "enrichment"]);
  const unsubscribe = options.applicationService.subscribeChanges?.(topic => changes.notify(topic));
  const server = await startPrivateJsonLineServer({
    socketPath: options.socketPath,
    maxRequestBytes: COMPANION_MAX_REQUEST_BYTES,
    maxResponseBytes: COMPANION_MAX_RESPONSE_BYTES,
    maxClients: COMPANION_MAX_CLIENTS,
    dispatch: (line, signal) => dispatchLine(
      line,
      options.applicationService,
      options.remoteManagement,
      unsubscribe ? changes : undefined,
      signal
    ),
    requestTooLarge: () => errorResponse(null, -32600, "Companion request is too large."),
    internalError: (error) => errorResponse(null, -32603, safeErrorMessage(error))
  }).catch(error => { unsubscribe?.(); changes.close(); throw error; });
  return { socketPath: server.socketPath, close: async () => { unsubscribe?.(); changes.close(); await server.close(); } };
}

/** Shared transport hardening for the bridge and helper's distinct RPC surfaces. */
export async function startPrivateJsonLineServer(
  options: PrivateJsonLineServerOptions
): Promise<BridgeCompanionServer> {
  const socketPath = validateSocketPath(options.socketPath);
  prepareSocketDirectory(socketPath);
  await removeStaleSocket(socketPath);

  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    serveClient(socket, options);
  });
  server.maxConnections = options.maxClients || COMPANION_MAX_CLIENTS;
  await listen(server, socketPath);
  chmodSync(socketPath, 0o600);
  const identity = socketIdentity(socketPath);

  let closePromise: Promise<void> | undefined;
  return {
    socketPath,
    close(): Promise<void> {
      if (!closePromise) {
        for (const client of clients) client.destroy();
        closePromise = closeServer(server).finally(() => {
          removeOwnedSocket(socketPath, identity);
        });
      }
      return closePromise;
    }
  };
}

function serveClient(socket: Socket, options: PrivateJsonLineServerOptions): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let requestQueue = Promise.resolve();
  const cancellation = new AbortController();
  socket.once("close", () => cancellation.abort());

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > options.maxRequestBytes) {
      writeResponse(socket, options.requestTooLarge(), options.maxResponseBytes);
      socket.destroy();
      return;
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      requestQueue = requestQueue
        .then(() => {
          if (cancellation.signal.aborted) throw new Error("CONNECTION_CLOSED");
          return options.dispatch(line, cancellation.signal);
        })
        .then((response) => writeResponse(socket, response, options.maxResponseBytes))
        .catch((error) => {
          writeResponse(socket, options.internalError(error), options.maxResponseBytes);
        });
    }
  });
  socket.on("error", () => undefined);
}

async function dispatchLine(
  line: string,
  applicationService: BridgeApplicationService,
  remoteManagement?: RemoteCompanionControl,
  changes?: ChangeSignal,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return errorResponse(null, -32700, "Invalid JSON.");
  }
  return dispatchCompanionPayload(decoded, applicationService, remoteManagement, changes, signal);
}

export async function dispatchCompanionPayload(
  decoded: unknown,
  applicationService: BridgeApplicationService,
  remoteManagement?: RemoteCompanionControl,
  changes?: ChangeSignal,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const parsed = requestSchema.safeParse(decoded);
  if (!parsed.success) {
    return errorResponse(requestId(decoded), -32600, "Invalid companion request.");
  }
  const request = parsed.data;
  try {
    const result = request.method === "changes.wait"
      ? await (() => {
          if (!changes) throw new Error("CHANGES_UNSUPPORTED");
          const params = changeWaitParamsSchema.parse(request.params || {});
          return changes.wait(params.after, params.waitMs, signal);
        })()
      : await dispatchRequest(request, applicationService, remoteManagement);
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    return errorResponse(request.id, -32602, safeErrorMessage(error));
  }
}

async function dispatchRequest(
  request: CompanionRequest,
  applicationService: BridgeApplicationService,
  remoteManagement?: RemoteCompanionControl
): Promise<unknown> {
  switch (request.method) {
    case "companion.hello":
      emptyParamsSchema.parse(request.params || {});
      return {
        protocol: {
          name: COMPANION_PROTOCOL_NAME,
          version: COMPANION_PROTOCOL_VERSION
        },
        bridge: {
          name: PRODUCT_INFO.runtimeName,
          title: PRODUCT_INFO.displayName,
          version: BRIDGE_BUILD_INFO.version,
          buildId: BRIDGE_BUILD_INFO.id
        },
        capabilities: [
          "dashboard.read",
          ...(applicationService.historyAction ? ["dashboard.history"] : []),
          ...(applicationService.problemAction ? ["dashboard.problems"] : []),
          "settings.read",
          "settings.write",
          "runtime.drain",
          ...(applicationService.threadHandoff ? ["thread.handoff"] : []),
          ...(remoteManagement
            ? [
                "remote-management.configure",
                "remote-management.pair",
                "remote-management.devices.revoke"
              ]
            : [])
        ]
      };
    case "dashboard.history": {
      if (!applicationService.historyAction) throw new Error("HISTORY_UNSUPPORTED");
      return applicationService.historyAction(dashboardHistoryActionInput.parse(request.params));
    }
    case "dashboard.problem": {
      if (!applicationService.problemAction) throw new Error("PROBLEMS_UNSUPPORTED");
      return applicationService.problemAction(problemActionSchema.parse(request.params));
    }
    case "thread.handoff": {
      const params = z.strictObject({ rowKey: z.string().regex(/^[0-9a-f]{32}$/),
        codexThreadUrl: z.string().regex(/^codex:\/\/threads\/[0-9a-f-]{36}$/),
        action: z.enum(["request", "cancel", "status"]) }).parse(request.params);
      if (!applicationService.threadHandoff) throw new Error("THREAD_HANDOFF_UNSUPPORTED");
      return applicationService.threadHandoff(params);
    }
    case "dashboard.snapshot": {
      const params = dashboardParamsSchema.parse(request.params || {});
      return applicationService.dashboardSnapshot({
        problems: params.problems,
        statusFilter: params.statusFilter,
        limit: params.limit,
        terminalOffset: params.terminalOffset,
        idleOffset: params.idleOffset,
        // Older native clients omit enrich and retain their prior all-in-one
        // snapshot behavior. The current client sends false explicitly.
        inspectRuntime: params.enrich !== false
      });
    }
    case "settings.snapshot": {
      const params = settingsSnapshotParamsSchema.parse(request.params || {});
      const view = await applicationService.settingsSnapshot({
        refreshModels: params.refreshModels
      });
      return localizeSettingsView(view, params.locale);
    }
    case "settings.update": {
      const view = await applicationService.updateSettings(
        request.params as BridgeSettingsMutationInput
      );
      return localizeSettingsView(view);
    }
    case "runtime.health":
      emptyParamsSchema.parse(request.params || {});
      if (!applicationService.runtimeHealth) throw new Error("RUNTIME_HEALTH_UNAVAILABLE");
      return applicationService.runtimeHealth();
    case "runtime.snapshot":
      return applicationService.runtimeSnapshot(
        runtimeSnapshotParamsSchema.parse(request.params || {})
      );
    case "runtime.beginDrain":
      return applicationService.beginDrain(
        runtimeSnapshotParamsSchema.parse(request.params || {})
      );
    case "runtime.cancelDrain":
      emptyParamsSchema.parse(request.params || {});
      return applicationService.cancelDrain();
    case "remote.status":
      emptyParamsSchema.parse(request.params || {});
      return requireRemoteManagement(remoteManagement).status();
    case "remote.configure":
      return requireRemoteManagement(remoteManagement).configure(
        remoteConfigureParamsSchema.parse(request.params || {})
      );
    case "remote.pairing.begin": {
      const params = remotePairingParamsSchema.parse(request.params || {});
      return requireRemoteManagement(remoteManagement).beginPairing(
        params.expiresInSeconds
      );
    }
    case "remote.devices.revoke": {
      const params = remoteRevokeParamsSchema.parse(request.params || {});
      return requireRemoteManagement(remoteManagement).revokeDevice(params.deviceId);
    }
  }
}

function requireRemoteManagement(
  controller: RemoteCompanionControl | undefined
): RemoteCompanionControl {
  if (!controller) throw new Error("REMOTE_MANAGEMENT_UNAVAILABLE");
  return controller;
}

function writeResponse(
  socket: Socket,
  response: Record<string, unknown>,
  maxResponseBytes: number
): void {
  if (socket.destroyed || !socket.writable) return;
  let serialized = JSON.stringify(response);
  if (Buffer.byteLength(serialized, "utf8") > maxResponseBytes) {
    serialized = JSON.stringify(
      errorResponse(response.id as JsonRpcId, -32603, "Companion response is too large.")
    );
  }
  socket.write(`${serialized}\n`);
}

function errorResponse(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  };
}

function requestId(value: unknown): JsonRpcId {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return requestIdSchema.safeParse(id).success ? id as JsonRpcId : null;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000) || "Companion request failed.";
}

function validateSocketPath(value: string): string {
  if (!value || !path.isAbsolute(value)) {
    throw new Error("Companion socket path must be absolute.");
  }
  const resolved = path.resolve(value);
  if (Buffer.byteLength(resolved, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("Companion socket path is too long.");
  }
  return resolved;
}

function prepareSocketDirectory(socketPath: string): void {
  const directory = path.dirname(socketPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Companion socket directory must be a regular directory.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (typeof uid === "number" && stats.uid !== uid) {
    throw new Error("Companion socket directory must be owned by the current user.");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Companion socket directory permissions must be 0700.");
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const stats = lstatSync(socketPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stats.isSocket()) {
    throw new Error("Companion socket path already exists and is not a socket.");
  }
  if (typeof uid === "number" && stats.uid !== uid) {
    throw new Error("Companion socket path is owned by another user.");
  }
  const state = await probeSocket(socketPath);
  if (state === "active") {
    throw new Error("A companion server is already running.");
  }
  if (state !== "refused") {
    throw new Error("Could not safely determine whether the companion socket is stale.");
  }
  unlinkSync(socketPath);
}

function probeSocket(socketPath: string): Promise<"active" | "refused" | "unknown"> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (state: "active" | "refused" | "unknown") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish("unknown"), 250);
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "refused" : "unknown");
    });
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
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
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function socketIdentity(socketPath: string): { dev: number; ino: number } {
  const stats = lstatSync(socketPath);
  return { dev: stats.dev, ino: stats.ino };
}

function removeOwnedSocket(
  socketPath: string,
  identity: { dev: number; ino: number }
): void {
  try {
    const current = lstatSync(socketPath);
    if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
      unlinkSync(socketPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
