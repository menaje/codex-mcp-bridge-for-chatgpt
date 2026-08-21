import { createServer, type Server as HttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { NextFunction, Request, Response } from "express";
import type { BridgeConfig } from "./config.js";
import { CodexCliModelCatalog, type CodexModelCatalogProvider } from "./modelCatalog.js";
import type { CodexUpstream } from "./upstream.js";
import { CodexJobRegistry, registerBridgeTools } from "./tools.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { UserSettingsStore } from "./userSettings.js";

export function createBridgeMcpServer(
  config: BridgeConfig,
  upstream: CodexUpstream,
  sessions = new SessionRegistry({
    allowedRoots: config.allowedRoots,
    autoResumeTtlMs: config.autoResumeTtlMs
  }),
  jobs = new CodexJobRegistry(
    config.maxConcurrentJobs,
    config.jobTtlMs,
    config.maxRetainedJobs,
    config.maxJobResultBytes
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
      version: "0.1.0"
    },
    {
      instructions:
        "Use codex_settings when the user asks to view or change bridge defaults; it renders the interactive settings card. Use codex_models whenever the user asks to view or choose a model or reasoning effort; never rely on a hard-coded model list. Use codex_task for every Codex prompt. Omit per-call fields to use the saved defaults. The saved access strategy is authoritative: read-only forces inspection mode, adaptive lets you choose an owner-permitted sandbox for the user's task, and always-full forces danger-full-access for new work. Keep the saved session mode unless the user requests fresh context, a model/effort change, or an exact persisted thread. Auto mode resumes only the most recent compatible idle session for the same cwd, effective sandbox, model, and effort inside the saved window. When a compatible read-only session is busy, auto starts a new session. Read-only sessions may run concurrently in the same cwd, but mutating jobs are serialized per cwd and turns on the same thread are always serialized. Use codex_status for bridge/session summaries and long-running job results. Do not request secrets or unrelated broad system access."
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
  const sessions = new SessionRegistry({
    stateFile: config.sessionStateFile,
    allowedRoots: config.allowedRoots,
    autoResumeTtlMs: config.autoResumeTtlMs
  });
  const jobs = new CodexJobRegistry(
    config.maxConcurrentJobs,
    config.jobTtlMs,
    config.maxRetainedJobs,
    config.maxJobResultBytes
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
    stateFile: config.settingsStateFile
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
      name: "codex-mcp-bridge"
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

  return createServer(app);
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
