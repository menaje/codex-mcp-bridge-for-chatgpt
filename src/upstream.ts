import type { CallToolResult, Progress } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolResultSchema,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS
} from "@modelcontextprotocol/sdk/types.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import type { CodexBackendKind } from "./config.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  JsonRpcProcess,
  type JsonRpcProcessIdentity,
  type JsonRpcTerminationResult
} from "./jsonRpcProcess.js";

export type ToolResult = CallToolResult;

export type CodexPublicEvent = {
  eventId: string;
  type:
    | "agent-message"
    | "plan"
    | "command"
    | "file-change"
    | "approval-required"
    | "input-required"
    | "turn";
  phase: "started" | "updated" | "completed" | "waiting";
  createdAt: number;
  summary: string;
  details?: Record<string, unknown>;
};

export type CodexProgress = Progress & { event?: CodexPublicEvent };

export type CodexPendingInteraction = {
  interactionId: string;
  kind: "command-approval" | "file-approval" | "permission-approval" | "user-input";
  threadId: string;
  turnId: string;
  itemId: string;
  summary: string;
  questions?: Array<{
    id: string;
    header: string;
    question: string;
    isSecret: boolean;
    options?: Array<{ label: string; description: string }>;
  }>;
};

export type UpstreamWorkerAssignment = {
  backendKind: "mcp-server" | "app-server";
  workerId: string;
  workerGeneration: number;
  workerPid?: number;
  processGroupId?: number;
  upstreamRequestId?: string;
  threadId?: string;
};

export type CodexUpstream = {
  listTools(): Promise<unknown>;
  canResumeThread?(threadId: string, backendKind?: CodexBackendKind): boolean | undefined;
  callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult>;
  forceTerminateWorker?(
    assignment: UpstreamWorkerAssignment,
    graceMs?: number
  ): Promise<JsonRpcTerminationResult>;
  respondToInteraction?(
    interactionId: string,
    response: { decision?: "accept" | "decline" | "cancel"; answers?: Record<string, string[]> }
  ): Promise<void>;
  steerThread?(threadId: string, prompt: string): Promise<{ turnId: string }>;
  close(): Promise<void>;
};

export type CodexMcpClient = {
  listTools(): Promise<unknown>;
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: {
      resetTimeoutOnProgress: boolean;
      onprogress?: (progress: Progress) => void;
    }
  ): Promise<ToolResult>;
  close(): Promise<void>;
};

export type CodexMcpTransport = {
  readonly identity?: JsonRpcProcessIdentity;
  forceTerminate?(graceMs?: number): Promise<JsonRpcTerminationResult>;
  close(): Promise<void>;
};

export type CodexConnectionFactory = () => Promise<{
  client: CodexMcpClient;
  transport: CodexMcpTransport;
}>;

type ManagedConnection = {
  client: CodexMcpClient;
  transport: CodexMcpTransport;
  activeCalls: number;
  retired: boolean;
  generation: number;
  closePromise?: Promise<void>;
};

export class CodexStdioUpstream implements CodexUpstream {
  private current?: ManagedConnection;
  private connecting?: Promise<ManagedConnection>;
  private readonly connections = new Set<ManagedConnection>();
  private closing = false;
  private nextGeneration = 1;

  constructor(
    private readonly codexCommand: string,
    private readonly connectionFactory?: CodexConnectionFactory,
    private readonly workerId = "mcp-0"
  ) {}

  async listTools(): Promise<unknown> {
    return this.withConnection((client) => client.listTools());
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.withConnection((client, connection) => {
      onAssigned?.(this.assignmentFor(connection));
      return client.callTool(
        { name, arguments: args },
        undefined,
        { resetTimeoutOnProgress: true, onprogress: onProgress }
      );
    });
  }

  async forceTerminateWorker(
    assignment: UpstreamWorkerAssignment,
    graceMs = 1_500
  ): Promise<JsonRpcTerminationResult> {
    if (assignment.workerId !== this.workerId) {
      throw new Error(`Worker identity mismatch: expected ${this.workerId}, received ${assignment.workerId}.`);
    }
    const connection = [...this.connections].find(
      (candidate) => candidate.generation === assignment.workerGeneration
    );
    if (!connection) throw new Error("The selected Codex worker generation is no longer active.");
    const identity = connection.transport.identity;
    if (!identity || !connection.transport.forceTerminate) {
      throw new Error("The selected Codex worker does not expose supervised process identity.");
    }
    if (
      (assignment.workerPid !== undefined && assignment.workerPid !== identity.pid) ||
      (assignment.processGroupId !== undefined && assignment.processGroupId !== identity.processGroupId)
    ) {
      throw new Error("The selected Codex worker process identity changed; refresh status before force-stopping it.");
    }
    connection.retired = true;
    if (this.current === connection) this.current = undefined;
    const result = await connection.transport.forceTerminate(graceMs);
    if (result.exited) await this.closeConnection(connection, true);
    return result;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.current = undefined;
    const pending = this.connecting;
    this.connecting = undefined;
    if (pending) {
      try {
        await pending;
      } catch {
        // A failed connection has no live resources left to close here.
      }
    }
    for (const connection of this.connections) connection.retired = true;
    await Promise.all([...this.connections].map((connection) => this.closeConnection(connection, true)));
  }

  private assignmentFor(connection: ManagedConnection): UpstreamWorkerAssignment {
    const identity = connection.transport.identity;
    return {
      backendKind: "mcp-server",
      workerId: this.workerId,
      workerGeneration: connection.generation,
      ...(identity ? { workerPid: identity.pid } : {}),
      ...(identity?.processGroupId !== null && identity?.processGroupId !== undefined
        ? { processGroupId: identity.processGroupId }
        : {})
    };
  }

  private async withConnection<T>(
    operation: (client: CodexMcpClient, connection: ManagedConnection) => Promise<T>
  ): Promise<T> {
    const connection = await this.getConnection();
    connection.activeCalls += 1;
    try {
      return await operation(connection.client, connection);
    } catch (error) {
      this.retire(connection);
      throw error;
    } finally {
      connection.activeCalls -= 1;
      if (connection.retired && connection.activeCalls === 0) await this.closeConnection(connection);
    }
  }

  private retire(connection: ManagedConnection): void {
    connection.retired = true;
    if (this.current === connection) this.current = undefined;
  }

  private async getConnection(): Promise<ManagedConnection> {
    if (this.closing) throw new Error("Codex MCP upstream is closed.");
    if (this.current && !this.current.retired) return this.current;
    if (!this.connecting) {
      this.connecting = this.createConnection().then(async (connection) => {
        this.connections.add(connection);
        if (this.closing) {
          connection.retired = true;
          await this.closeConnection(connection, true);
          throw new Error("Codex MCP upstream closed while connecting.");
        }
        this.current = connection;
        return connection;
      });
    }
    const pending = this.connecting;
    try {
      return await pending;
    } finally {
      if (this.connecting === pending) this.connecting = undefined;
    }
  }

  private async createConnection(): Promise<ManagedConnection> {
    const generation = this.nextGeneration++;
    const connection = this.connectionFactory
      ? await this.connectionFactory()
      : await this.createStdioConnection(generation);
    return { ...connection, activeCalls: 0, retired: false, generation };
  }

  private async createStdioConnection(generation: number): Promise<{
    client: CodexMcpClient;
    transport: CodexMcpTransport;
  }> {
    const rpc = new JsonRpcProcess({
      command: this.codexCommand,
      args: ["mcp-server"],
      debugLabel: `codex-mcp:${this.workerId}:g${generation}`
    });
    const transport = new ProcessMcpTransport(rpc);
    const client = new ProcessMcpClient(rpc);
    try {
      await client.initialize();
      return { client, transport };
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  private closeConnection(connection: ManagedConnection, force = false): Promise<void> {
    if (!force && connection.activeCalls > 0) return Promise.resolve();
    if (!connection.closePromise) {
      connection.closePromise = (async () => {
        await Promise.allSettled([connection.client.close(), connection.transport.close()]);
        this.connections.delete(connection);
        if (this.current === connection) this.current = undefined;
      })();
    }
    return connection.closePromise;
  }
}

type UpstreamWorker = {
  upstream: CodexStdioUpstream;
  activeCalls: number;
  index: number;
};

export class CodexUpstreamPool implements CodexUpstream {
  private readonly workers: UpstreamWorker[];
  private readonly threadWorkers = new Map<string, number>();

  constructor(
    codexCommand: string,
    poolSize = 4,
    connectionFactoryForWorker?: (index: number) => CodexConnectionFactory | undefined
  ) {
    if (!Number.isInteger(poolSize) || poolSize <= 0) {
      throw new Error("Codex upstream pool size must be a positive integer.");
    }
    this.workers = Array.from({ length: poolSize }, (_, index) => ({
      upstream: new CodexStdioUpstream(codexCommand, connectionFactoryForWorker?.(index), `mcp-${index}`),
      activeCalls: 0,
      index
    }));
  }

  async listTools(): Promise<unknown> {
    return this.withWorker((upstream) => upstream.listTools());
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const requestedThreadId =
      name === "codex-reply" && typeof args.threadId === "string" && args.threadId
        ? args.threadId
        : undefined;
    const boundWorker = requestedThreadId
      ? this.workers[this.threadWorkers.get(requestedThreadId) ?? -1]
      : undefined;
    if (requestedThreadId && !boundWorker) {
      throw new Error(
        `Codex thread ${requestedThreadId} is not available in the active MCP worker generation. Start a new session instead.`
      );
    }

    let selectedWorker: UpstreamWorker | undefined;
    try {
      const result = await this.withWorker(
        (upstream, worker) => {
          selectedWorker = worker;
          return upstream.callTool(name, args, onProgress, onAssigned);
        },
        boundWorker
      );
      if (name === "codex" && !result.isError && selectedWorker) {
        const createdThreadId = readResultThreadId(result);
        if (createdThreadId) this.threadWorkers.set(createdThreadId, selectedWorker.index);
      }
      return result;
    } catch (error) {
      if (selectedWorker) this.forgetWorkerThreads(selectedWorker.index);
      throw error;
    }
  }

  async forceTerminateWorker(
    assignment: UpstreamWorkerAssignment,
    graceMs?: number
  ): Promise<JsonRpcTerminationResult> {
    const worker = this.workers.find((candidate) => `mcp-${candidate.index}` === assignment.workerId);
    if (!worker) throw new Error("The selected Codex worker is not part of this bridge pool.");
    const result = await worker.upstream.forceTerminateWorker(assignment, graceMs);
    if (result.exited) this.forgetWorkerThreads(worker.index);
    return result;
  }

  canResumeThread(threadId: string): boolean {
    return this.threadWorkers.has(threadId);
  }

  async close(): Promise<void> {
    this.threadWorkers.clear();
    await Promise.all(this.workers.map((worker) => worker.upstream.close()));
  }

  private async withWorker<T>(
    operation: (upstream: CodexStdioUpstream, worker: UpstreamWorker) => Promise<T>,
    preferredWorker?: UpstreamWorker
  ): Promise<T> {
    const worker =
      preferredWorker ||
      this.workers.reduce((selected, candidate) =>
        candidate.activeCalls < selected.activeCalls ||
        (candidate.activeCalls === selected.activeCalls && candidate.index < selected.index)
          ? candidate
          : selected
      );
    worker.activeCalls += 1;
    try {
      return await operation(worker.upstream, worker);
    } finally {
      worker.activeCalls -= 1;
    }
  }

  private forgetWorkerThreads(workerIndex: number): void {
    for (const [threadId, index] of this.threadWorkers) {
      if (index === workerIndex) this.threadWorkers.delete(threadId);
    }
  }
}

class ProcessMcpClient implements CodexMcpClient {
  private protocolVersion?: string;

  constructor(private readonly rpc: JsonRpcProcess) {}

  async initialize(): Promise<void> {
    const raw = await this.rpc.request(
      "initialize",
      {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: PRODUCT_INFO.runtimeName, version: BRIDGE_BUILD_INFO.version }
      },
      { timeoutMs: 30_000 }
    );
    const result = InitializeResultSchema.parse(raw);
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
      throw new Error(`Unsupported Codex MCP protocol version: ${result.protocolVersion}.`);
    }
    this.protocolVersion = result.protocolVersion;
    await this.rpc.notify("notifications/initialized");
  }

  async listTools(): Promise<unknown> {
    this.assertInitialized();
    return ListToolsResultSchema.parse(await this.rpc.request("tools/list", {}, { timeoutMs: 30_000 }));
  }

  async callTool(
    input: { name: string; arguments: Record<string, unknown> },
    _resultSchema?: undefined,
    options?: { resetTimeoutOnProgress: boolean; onprogress?: (progress: Progress) => void }
  ): Promise<ToolResult> {
    this.assertInitialized();
    const result = await this.rpc.request("tools/call", input, {
      progress: true,
      onProgress: (value) => {
        if (options?.onprogress && isProgress(value)) options.onprogress(value);
      }
    });
    return CallToolResultSchema.parse(result);
  }

  async close(): Promise<void> {
    // The transport owns the supervised process lifetime.
  }

  private assertInitialized(): void {
    if (!this.protocolVersion) throw new Error("Codex MCP client is not initialized.");
  }
}

class ProcessMcpTransport implements CodexMcpTransport {
  constructor(private readonly rpc: JsonRpcProcess) {}

  get identity(): JsonRpcProcessIdentity | undefined {
    return this.rpc.identity;
  }

  forceTerminate(graceMs?: number): Promise<JsonRpcTerminationResult> {
    return this.rpc.forceTerminate(graceMs);
  }

  close(): Promise<void> {
    return this.rpc.close();
  }
}

function readResultThreadId(result: ToolResult): string | undefined {
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const threadId = (structured as Record<string, unknown>).threadId;
  return typeof threadId === "string" && threadId ? threadId : undefined;
}

function isProgress(value: unknown): value is Progress {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).progress === "number";
}
