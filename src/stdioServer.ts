import type { Readable, Writable } from "node:stream";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { BridgeConfig } from "./config.js";
import type { CodexModelCatalogProvider } from "./modelCatalog.js";
import { ScopeResolver } from "./scopeResolver.js";
import { createBridgeMcpServer, createModelCatalog } from "./server.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { BridgeStateStore } from "./stateStore.js";
import {
  CodexJobRegistry,
  TaskProjectAvailabilityProjection,
  type BridgeApplicationService
} from "./tools.js";
import type { CodexUpstream } from "./upstream.js";
import { UserSettingsStore } from "./userSettings.js";

export type BridgeStdioRuntimeOptions = {
  /** Shared production store; when supplied, its lifecycle remains caller-owned. */
  stateStore?: BridgeStateStore;
  /** Optional catalog override used by deterministic integration tests. */
  modelCatalog?: CodexModelCatalogProvider;
  /** Custom streams used by byte-level stdio integration tests. */
  input?: Readable;
  output?: Writable;
};

export type BridgeStdioRuntime = {
  readonly applicationService: BridgeApplicationService;
  start(): Promise<void>;
  close(): Promise<void>;
};

/**
 * One modern MCP stdio connection for Secure MCP Tunnel's --mcp-command mode.
 * The tunnel owns the pipe; bridge state stays in the same durable stores as
 * HTTP and is never derived from a transport session identifier.
 */
export function createStdioBridgeRuntime(
  config: BridgeConfig,
  upstream: CodexUpstream,
  options: BridgeStdioRuntimeOptions = {}
): BridgeStdioRuntime {
  const stateStore = options.stateStore || new BridgeStateStore({
    file: config.stateDatabaseFile
  });
  const ownsStateStore = options.stateStore === undefined;
  const sessions = new SessionRegistry({
    stateStore,
    allowedRoots: config.allowedRoots
  });
  const jobs = new CodexJobRegistry({
    maxConcurrentJobs: config.maxConcurrentJobs,
    ttlMs: config.jobTtlMs,
    maxJobs: config.maxRetainedJobs,
    maxResultBytes: config.maxJobResultBytes,
    staleAfterMs: config.jobStaleAfterMs,
    stateStore,
    allowedRoots: config.allowedRoots
  });
  const userSettings = new UserSettingsStore(config, { stateStore });
  const scopeResolver = new ScopeResolver({ stateStore });
  const modelCatalog = options.modelCatalog || createModelCatalog(config, upstream);
  const projectAvailability = new TaskProjectAvailabilityProjection(config);
  const server = createBridgeMcpServer(
    config,
    upstream,
    sessions,
    jobs,
    modelCatalog,
    userSettings,
    scopeResolver,
    projectAvailability
  );
  const transport = new StdioServerTransport(options.input, options.output);
  let handle: StdioServerHandle | undefined;
  let started = false;
  let closePromise: Promise<void> | undefined;
  return {
    applicationService: server.applicationService,
    async start(): Promise<void> {
      if (started) throw new Error("MCP stdio bridge is already started.");
      started = true;
      stateStore.markServiceOpen("stdio");
      handle = serveStdio(
        () => server,
        {
          legacy: "reject",
          transport,
          onerror: (error) => logStdioError(error)
        }
      );
    },
    close(): Promise<void> {
      if (!closePromise) {
        closePromise = Promise.all([
          handle?.close() || server.close(),
          jobs.closeThreadConnections()
        ]).then(() => {
          if (ownsStateStore) stateStore.close();
        });
      }
      return closePromise;
    }
  };
}

function logStdioError(error: unknown): void {
  if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
    console.error("MCP stdio request failed:", error);
  } else {
    console.error("MCP stdio request failed. Set CODEX_MCP_BRIDGE_DEBUG=1 for local diagnostics.");
  }
}
