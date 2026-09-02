import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  Transport,
  TransportSendOptions
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId
} from "@modelcontextprotocol/sdk/types.js";
import type { BridgeConfig } from "./config.js";
import type { CodexModelCatalogProvider } from "./modelCatalog.js";
import { SdkToolDescriptorCoordinator } from "./modelPolicyTransport.js";
import { ScopeResolver } from "./scopeResolver.js";
import {
  createBridgeMcpServer,
  createModelCatalog
} from "./server.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { BridgeStateStore } from "./stateStore.js";
import {
  CodexJobRegistry,
  TaskProjectAvailabilityProjection,
  type BridgeApplicationService
} from "./tools.js";
import type { CodexUpstream } from "./upstream.js";
import { UserSettingsStore } from "./userSettings.js";

const STDIO_CLIENT_SESSION_KEY = "persistent-stdio";

export type BridgeStdioRuntimeOptions = {
  /** Shared production store; when supplied, its lifecycle remains caller-owned. */
  stateStore?: BridgeStateStore;
  /** Optional catalog override used by deterministic integration tests. */
  modelCatalog?: CodexModelCatalogProvider;
  /** Optional caller-owned coordinator for notification/re-list diagnostics. */
  descriptorCoordinator?: SdkToolDescriptorCoordinator;
  /** Custom streams used by byte-level stdio integration tests. */
  input?: Readable;
  output?: Writable;
  /** Deterministic availability reconciliation cadence used by tests. */
  descriptorReconcileIntervalMs?: number;
};

export type BridgeStdioRuntime = {
  readonly applicationService: BridgeApplicationService;
  readonly descriptorCoordinator: SdkToolDescriptorCoordinator;
  start(): Promise<void>;
  close(): Promise<void>;
  reconcileDescriptorAvailability(): void;
};

/**
 * One persistent MCP stdio connection suitable for Secure MCP Tunnel's
 * --mcp-command mode.
 *
 * Application state remains bridge-owned and persisted exactly as in the HTTP
 * runtime. The stdio connection is discovery/transport state only and is never
 * used as a ChatGPT conversation identity or authorization primitive.
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
    stateFile: config.sessionStateFile,
    stateStore,
    allowedRoots: config.allowedRoots
  });
  const jobs = new CodexJobRegistry({
    maxConcurrentJobs: config.maxConcurrentJobs,
    ttlMs: config.jobTtlMs,
    maxJobs: config.maxRetainedJobs,
    maxResultBytes: config.maxJobResultBytes,
    staleAfterMs: config.jobStaleAfterMs,
    stateFile: config.jobStateFile,
    stateStore,
    allowedRoots: config.allowedRoots
  });
  const userSettings = new UserSettingsStore(config, {
    stateFile: config.settingsStateFile,
    stateStore
  });
  const scopeResolver = new ScopeResolver({ stateStore });
  const modelCatalog = options.modelCatalog || createModelCatalog(config, upstream);
  const descriptorCoordinator = options.descriptorCoordinator ||
    new SdkToolDescriptorCoordinator();
  const ownsDescriptorCoordinator = options.descriptorCoordinator === undefined;
  const projectAvailability = new TaskProjectAvailabilityProjection(config);
  const server = createBridgeMcpServer(
    config,
    upstream,
    sessions,
    jobs,
    modelCatalog,
    userSettings,
    scopeResolver,
    descriptorCoordinator,
    projectAvailability
  );
  const transport = new DescriptorObservedStdioTransport(
    new StdioServerTransport(options.input, options.output),
    descriptorCoordinator
  );

  const reconcileDescriptor = () => {
    try {
      descriptorCoordinator.reconcile();
    } catch (error) {
      logStdioReconcileError("descriptor", error);
    }
  };
  const reconcileDescriptorAvailability = () => {
    try {
      if (projectAvailability.observe(userSettings.current, 2)) {
        descriptorCoordinator.reconcile();
      }
    } catch (error) {
      logStdioReconcileError("project availability", error);
    }
  };
  const unsubscribeCatalog = modelCatalog.subscribe?.((event) => {
    if (event.backendKind === config.defaultBackend) reconcileDescriptor();
  });
  const descriptorReconcileTimer = setInterval(
    reconcileDescriptorAvailability,
    options.descriptorReconcileIntervalMs || 15_000
  );
  descriptorReconcileTimer.unref();

  let started = false;
  let closePromise: Promise<void> | undefined;
  return {
    applicationService: server.applicationService,
    descriptorCoordinator,
    async start(): Promise<void> {
      if (started) throw new Error("Persistent stdio bridge is already started.");
      started = true;
      await server.connect(transport);
    },
    close(): Promise<void> {
      if (!closePromise) {
        clearInterval(descriptorReconcileTimer);
        unsubscribeCatalog?.();
        closePromise = server.close().finally(() => {
          descriptorCoordinator.forgetClientSession(STDIO_CLIENT_SESSION_KEY);
          if (ownsDescriptorCoordinator) descriptorCoordinator.dispose();
          if (ownsStateStore) stateStore.close();
        });
      }
      return closePromise;
    },
    reconcileDescriptorAvailability
  };
}

/**
 * Observes a successful tools/list response without claiming that a later host
 * call used the returned descriptor. The coordinator therefore exposes a
 * relist observation while adoption remains explicitly unknown.
 */
class DescriptorObservedStdioTransport implements Transport {
  private readonly pendingToolLists = new Map<string, number>();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: StdioServerTransport,
    private readonly descriptorCoordinator: SdkToolDescriptorCoordinator
  ) {
    this.inner.onclose = () => {
      this.pendingToolLists.clear();
      this.descriptorCoordinator.forgetClientSession(STDIO_CLIENT_SESSION_KEY);
      this.onclose?.();
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message) => {
      if (isToolsListRequest(message)) {
        this.pendingToolLists.set(
          requestKey(message.id),
          this.descriptorCoordinator.status.descriptorEpoch
        );
      }
      this.onmessage?.(message);
    };
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await (this.inner as Transport).send(message, options);
    if (!isJsonRpcResponse(message)) return;
    const key = requestKey(message.id);
    const descriptorEpoch = this.pendingToolLists.get(key);
    if (descriptorEpoch === undefined) return;
    this.pendingToolLists.delete(key);
    if ("result" in message) {
      this.descriptorCoordinator.noteClientRelisted(
        STDIO_CLIENT_SESSION_KEY,
        descriptorEpoch
      );
    }
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

function isToolsListRequest(
  message: JSONRPCMessage
): message is JSONRPCMessage & { id: RequestId; method: "tools/list" } {
  return "id" in message && "method" in message && message.method === "tools/list";
}

function isJsonRpcResponse(
  message: JSONRPCMessage
): message is JSONRPCMessage & { id: RequestId } {
  return "id" in message && ("result" in message || "error" in message);
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function logStdioReconcileError(kind: string, error: unknown): void {
  if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
    console.error(`Codex task ${kind} reconciliation failed:`, error);
  }
}
