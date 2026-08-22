import { createServer, type Server as HttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { NextFunction, Request, Response } from "express";
import type { BridgeConfig } from "./config.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { CodexCliModelCatalog, type CodexModelCatalogProvider } from "./modelCatalog.js";
import type { CodexUpstream } from "./upstream.js";
import { CodexJobRegistry, registerBridgeTools } from "./tools.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { BridgeStateStore } from "./stateStore.js";
import { UserSettingsStore } from "./userSettings.js";

export function createBridgeMcpServer(
  config: BridgeConfig,
  upstream: CodexUpstream,
  sessions = new SessionRegistry({
    allowedRoots: config.allowedRoots,
    autoResumeTtlMs: config.autoResumeTtlMs
  }),
  jobs = new CodexJobRegistry(
    {
      maxConcurrentJobs: config.maxConcurrentJobs,
      ttlMs: config.jobTtlMs,
      maxJobs: config.maxRetainedJobs,
      maxResultBytes: config.maxJobResultBytes,
      staleAfterMs: config.jobStaleAfterMs
    }
  ),
  modelCatalog: CodexModelCatalogProvider = new CodexCliModelCatalog(
    config.codexCommand,
    config.modelCatalogCacheTtlMs,
    config.modelCatalogTimeoutMs,
    undefined,
    undefined,
    config.modelCatalogStateFile
  ),
  userSettings = new UserSettingsStore(config)
): McpServer {
  const server = new McpServer(
    {
      name: "codex-mcp-bridge",
      title: "Codex MCP Bridge",
      version: BRIDGE_BUILD_INFO.version
    },
    {
      instructions:
        "Use codex_settings for saved bridge defaults and codex_models for the live model/effort catalog. Before the first codex_task in each ChatGPT conversation, generate one fresh UUID scopeId and reuse it for every Codex bridge call in that conversation. A copied or branched ChatGPT conversation must use a new scopeId unless the user explicitly requests a handoff. For every logical codex_task turn, generate a fresh UUID requestId and reuse that exact requestId on retries; never reuse it for different arguments. Do not decide in advance whether a conversation is single-threaded or parallel. Start normally; whenever parallel work becomes useful, call codex_task with sessionMode='new' to add another Codex thread under the same scopeId. The same Codex thread is serialized, while different threads in the same scope may run in parallel even in the same cwd. Auto mode continues only when exactly one recent compatible thread exists in the scope. If none exists it starts one; if the only compatible session is starting or busy, wait or deliberately start a new thread; if multiple compatible threads exist, call codex_status with scopeId and retry with the exact intended threadId instead of guessing. Keep each returned threadId and jobId associated with the current scope. Never use the legacy scope for auto selection. A persisted MCP thread with resumeAvailability unavailable-after-worker-restart is history only: do not explicitly continue it; auto starts a new thread because MCP thread context is worker-process local. Set adoptThread=true only with an exact available threadId after the user explicitly requests a cross-chat handoff. Pass scopeId to codex_status so it returns only that conversation's sessions and jobs; follow its pagination metadata when the scope has more records, and use includeAllScopes only for an explicit bridge-wide operator audit. Scope IDs route conversations but are not authentication credentials. Omit ordinary task overrides to use saved defaults; the saved access strategy remains authoritative. Jobs may mutate the same cwd concurrently, so partition overlapping work or request separate worktrees when needed. A running jobId is intermediate, not completion: for an outcome request, keep the turn open and call codex_status with the same scopeId, waitFor='terminal', and bounded waitMs until terminal. Then inspect the result and verify artifacts, diff/status, and relevant tests; continue the exact thread for corrections. A no-progress-observed health value means only that no MCP progress event arrived; process liveness remains unknown, so inspect actual work evidence before deciding whether to wait or call codex_cancel. Cancellation can leave partial filesystem changes. Return a running jobId immediately only for explicit start-only/background requests. Do not request secrets or unrelated broad system access."
    }
  );
  registerBridgeTools(server, config, upstream, sessions, jobs, modelCatalog, userSettings);
  return server;
}

export function createHttpServer(config: BridgeConfig, upstream: CodexUpstream): HttpServer {
  const app = createMcpExpressApp({
    allowedHosts: config.allowedHosts,
    host: config.host
  });
  const stateStore = new BridgeStateStore({ file: config.stateDatabaseFile });
  const sessions = new SessionRegistry({
    stateFile: config.sessionStateFile,
    stateStore,
    allowedRoots: config.allowedRoots,
    autoResumeTtlMs: config.autoResumeTtlMs
  });
  const jobs = new CodexJobRegistry(
    {
      maxConcurrentJobs: config.maxConcurrentJobs,
      ttlMs: config.jobTtlMs,
      maxJobs: config.maxRetainedJobs,
      maxResultBytes: config.maxJobResultBytes,
      staleAfterMs: config.jobStaleAfterMs,
      stateFile: config.jobStateFile,
      stateStore,
      allowedRoots: config.allowedRoots
    }
  );
  const modelCatalog = new CodexCliModelCatalog(
    config.codexCommand,
    config.modelCatalogCacheTtlMs,
    config.modelCatalogTimeoutMs,
    undefined,
    undefined,
    config.modelCatalogStateFile
  );
  const userSettings = new UserSettingsStore(config, {
    stateFile: config.settingsStateFile,
    stateStore
  });

  app.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    (_req: Request, res: Response) => {
      res.status(404).end();
    }
  );

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      name: "codex-mcp-bridge",
      build: BRIDGE_BUILD_INFO
    });
  });

  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    if (isAuthorized(req.headers.authorization, config)) {
      next();
      return;
    }
    res.status(401).json({
      error: "unauthorized"
    });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createBridgeMcpServer(config, upstream, sessions, jobs, modelCatalog, userSettings);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
        console.error("MCP request failed:", error);
      } else {
        console.error("MCP request failed. Set CODEX_MCP_BRIDGE_DEBUG=1 for local diagnostics.");
      }
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error"
          },
          id: null
        });
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });

  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    });
  });

  app.delete("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    });
  });

  const httpServer = createServer(app);
  httpServer.once("close", () => stateStore.close());
  return httpServer;
}

function isAuthorized(header: string | undefined, config: BridgeConfig): boolean {
  if (config.noAuth) {
    return true;
  }
  if (!header || !config.token) {
    return false;
  }
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${config.token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
