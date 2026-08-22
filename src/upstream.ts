import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Progress } from "@modelcontextprotocol/sdk/types.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";

export type ToolResult = CallToolResult;

export type CodexUpstream = {
  listTools(): Promise<unknown>;
  /**
   * Whether a Codex thread is still bound to a live upstream worker in this
   * bridge process. `undefined` means the upstream cannot determine it.
   */
  canResumeThread?(threadId: string): boolean | undefined;
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    onProgress?: (progress: Progress) => void,
    signal?: AbortSignal
  ): Promise<ToolResult>;
  close(): Promise<void>;
};

export type CodexMcpClient = {
  listTools(): Promise<unknown>;
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: {
      timeout: number;
      signal?: AbortSignal;
      resetTimeoutOnProgress: boolean;
      onprogress?: (progress: Progress) => void;
    }
  ): Promise<ToolResult>;
  close(): Promise<void>;
};

export type CodexMcpTransport = {
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
  closePromise?: Promise<void>;
};

export class CodexStdioUpstream implements CodexUpstream {
  private current?: ManagedConnection;
  private connecting?: Promise<ManagedConnection>;
  private readonly connections = new Set<ManagedConnection>();
  private closing = false;

  constructor(
    private readonly codexCommand: string,
    private readonly connectionFactory?: CodexConnectionFactory
  ) {}

  async listTools(): Promise<unknown> {
    return this.withConnection((client) => client.listTools());
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    onProgress?: (progress: Progress) => void,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    return this.withConnection((client) =>
      client.callTool(
        {
          name,
          arguments: args
        },
        undefined,
        {
          timeout: timeoutMs,
          signal,
          resetTimeoutOnProgress: true,
          onprogress: onProgress
        }
      )
    );
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

  private async withConnection<T>(operation: (client: CodexMcpClient) => Promise<T>): Promise<T> {
    const connection = await this.getConnection();
    connection.activeCalls += 1;
    try {
      return await operation(connection.client);
    } catch (error) {
      // A request timeout is cancelled independently by the MCP SDK. For other
      // failures, retire this generation for future calls without closing it
      // underneath unrelated calls that are still in flight.
      if (!isRequestTimeout(error)) this.retire(connection);
      throw error;
    } finally {
      connection.activeCalls -= 1;
      if (connection.retired && connection.activeCalls === 0) {
        await this.closeConnection(connection);
      }
    }
  }

  private retire(connection: ManagedConnection): void {
    connection.retired = true;
    if (this.current === connection) this.current = undefined;
  }

  private async getConnection(): Promise<ManagedConnection> {
    if (this.closing) throw new Error("Codex MCP upstream is closed.");
    if (this.current && !this.current.retired) {
      return this.current;
    }
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
    const connection = this.connectionFactory
      ? await this.connectionFactory()
      : await this.createStdioConnection();
    return {
      ...connection,
      activeCalls: 0,
      retired: false
    };
  }

  private async createStdioConnection(): Promise<{
    client: CodexMcpClient;
    transport: CodexMcpTransport;
  }> {
    const transport = new StdioClientTransport({
      command: this.codexCommand,
      args: ["mcp-server"],
      stderr: "pipe"
    });
    transport.stderr?.on("data", (chunk) => {
      if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
        process.stderr.write(`[codex-mcp] ${chunk.toString()}`);
      }
    });

    const client = new Client(
      {
        name: "codex-mcp-bridge",
        version: BRIDGE_BUILD_INFO.version
      },
      {
        capabilities: {}
      }
    );
    try {
      await client.connect(transport);
      return {
        client: client as unknown as CodexMcpClient,
        transport
      };
    } catch (error) {
      await Promise.allSettled([client.close(), transport.close()]);
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
      upstream: new CodexStdioUpstream(codexCommand, connectionFactoryForWorker?.(index)),
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
    timeoutMs: number,
    onProgress?: (progress: Progress) => void,
    signal?: AbortSignal
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
          return upstream.callTool(name, args, timeoutMs, onProgress, signal);
        },
        boundWorker
      );
      if (name === "codex" && !result.isError && selectedWorker) {
        const createdThreadId = readResultThreadId(result);
        if (createdThreadId) this.threadWorkers.set(createdThreadId, selectedWorker.index);
      }
      return result;
    } catch (error) {
      if (selectedWorker && !isRequestTimeout(error)) {
        this.forgetWorkerThreads(selectedWorker.index);
      }
      throw error;
    }
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

function readResultThreadId(result: ToolResult): string | undefined {
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const threadId = (structured as Record<string, unknown>).threadId;
  return typeof threadId === "string" && threadId ? threadId : undefined;
}

function isRequestTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === -32001;
}
