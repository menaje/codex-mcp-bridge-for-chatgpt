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
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { PRODUCT_INFO } from "./productInfo.js";
import type {
  BridgeApplicationService,
  BridgeSettingsMutationInput
} from "./tools.js";

export const COMPANION_PROTOCOL_NAME = "codex-mcp-bridge-companion";
export const COMPANION_PROTOCOL_VERSION = 1;
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
    "dashboard.snapshot",
    "settings.snapshot",
    "settings.update",
    "runtime.snapshot",
    "runtime.beginDrain",
    "runtime.cancelDrain"
  ]),
  params: z.unknown().optional()
});

const emptyParamsSchema = z.strictObject({});
const dashboardParamsSchema = z.strictObject({
  limit: z.number().int().min(5).max(50).optional(),
  terminalOffset: z.number().int().min(0).max(1_000_000_000).optional(),
  idleOffset: z.number().int().min(0).max(1_000_000_000).optional()
});
const settingsSnapshotParamsSchema = z.strictObject({
  refreshModels: z.boolean().optional()
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
};

export type PrivateJsonLineServerOptions = {
  socketPath: string;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxClients?: number;
  dispatch(line: string): Promise<Record<string, unknown>>;
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
  return startPrivateJsonLineServer({
    socketPath: options.socketPath,
    maxRequestBytes: COMPANION_MAX_REQUEST_BYTES,
    maxResponseBytes: COMPANION_MAX_RESPONSE_BYTES,
    maxClients: COMPANION_MAX_CLIENTS,
    dispatch: (line) => dispatchLine(line, options.applicationService),
    requestTooLarge: () => errorResponse(null, -32600, "Companion request is too large."),
    internalError: (error) => errorResponse(null, -32603, safeErrorMessage(error))
  });
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
        .then(() => options.dispatch(line))
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
  applicationService: BridgeApplicationService
): Promise<Record<string, unknown>> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return errorResponse(null, -32700, "Invalid JSON.");
  }
  const parsed = requestSchema.safeParse(decoded);
  if (!parsed.success) {
    return errorResponse(requestId(decoded), -32600, "Invalid companion request.");
  }
  const request = parsed.data;
  try {
    const result = await dispatchRequest(request, applicationService);
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    return errorResponse(request.id, -32602, safeErrorMessage(error));
  }
}

async function dispatchRequest(
  request: CompanionRequest,
  applicationService: BridgeApplicationService
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
          "settings.read",
          "settings.write",
          "runtime.drain"
        ]
      };
    case "dashboard.snapshot": {
      const params = dashboardParamsSchema.parse(request.params || {});
      return applicationService.dashboardSnapshot({
        ...params,
        inspectRuntime: true
      });
    }
    case "settings.snapshot": {
      const params = settingsSnapshotParamsSchema.parse(request.params || {});
      return applicationService.settingsSnapshot(params);
    }
    case "settings.update":
      return applicationService.updateSettings(
        request.params as BridgeSettingsMutationInput
      );
    case "runtime.snapshot":
      emptyParamsSchema.parse(request.params || {});
      return applicationService.runtimeSnapshot();
    case "runtime.beginDrain":
      emptyParamsSchema.parse(request.params || {});
      return applicationService.beginDrain();
    case "runtime.cancelDrain":
      emptyParamsSchema.parse(request.params || {});
      return applicationService.cancelDrain();
  }
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
