import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig, SandboxMode } from "./config.js";
import { enforceSandbox, findSensitiveFiles, resolveAllowedCwd } from "./config.js";
import type { CodexUpstream, ToolResult } from "./upstream.js";
import { extractThreadId, SessionRegistry } from "./sessionRegistry.js";

type CodexJobStatus = "running" | "completed" | "failed";

type CodexJob = {
  jobId: string;
  operation: "codex_read" | "codex_run" | "codex_reply";
  createdAt: number;
  updatedAt: number;
  cwd?: string;
  sandbox?: SandboxMode;
  activeKey: string;
  status: CodexJobStatus;
  result?: ToolResult;
  error?: string;
  promise: Promise<void>;
};

export class CodexJobRegistry {
  private readonly jobs = new Map<string, CodexJob>();

  constructor(
    private readonly maxConcurrentJobs = 2,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly maxJobs = 1000
  ) {}

  get size(): number {
    this.prune();
    return this.jobs.size;
  }

  get(jobId: string): CodexJob | undefined {
    this.prune();
    return this.jobs.get(jobId);
  }

  start(
    input: Omit<CodexJob, "jobId" | "createdAt" | "updatedAt" | "status" | "promise" | "result" | "error">,
    run: () => Promise<ToolResult>,
    onComplete?: (result: ToolResult) => void
  ): CodexJob {
    this.prune();
    const running = [...this.jobs.values()].filter((job) => job.status === "running");
    if (running.length >= this.maxConcurrentJobs) {
      throw new Error(`Too many Codex jobs are running. The configured limit is ${this.maxConcurrentJobs}.`);
    }
    if (running.some((job) => job.activeKey === input.activeKey)) {
      throw new Error("A Codex job is already running for this working directory.");
    }
    const now = Date.now();
    const job: CodexJob = {
      ...input,
      jobId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "running",
      promise: Promise.resolve()
    };
    job.promise = Promise.resolve()
      .then(run)
      .then((result) => {
        job.status = "completed";
        job.result = result;
        job.updatedAt = Date.now();
        onComplete?.(result);
      })
      .catch((error: unknown) => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.updatedAt = Date.now();
      });
    this.jobs.set(job.jobId, job);
    this.prune();
    return job;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [jobId, job] of this.jobs) {
      if (job.status !== "running" && job.updatedAt < cutoff) {
        this.jobs.delete(jobId);
      }
    }
    if (this.jobs.size <= this.maxJobs) return;
    const sorted = [...this.jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of sorted.filter((job) => job.status !== "running").slice(0, this.jobs.size - this.maxJobs)) {
      this.jobs.delete(job.jobId);
    }
  }
}

export function registerBridgeTools(
  server: McpServer,
  config: BridgeConfig,
  upstream: CodexUpstream,
  sessions: SessionRegistry,
  jobs: CodexJobRegistry
): void {
  server.registerTool(
    "bridge_status",
    {
      title: "Bridge Status",
      description:
        "Read-only status check. Returns bridge safety policy, allowed local roots, tracked session count, and upstream Codex MCP tool availability. Does not start Codex and does not read project files.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const tools = await upstream.listTools();
      return textResult({
        bridge: "codex-mcp-bridge",
        auth: config.token && !config.noAuth ? "bearer-token" : "none",
        allowedRoots: config.allowedRoots,
        defaultSandbox: config.defaultSandbox,
        allowWorkspaceWrite: config.allowWorkspaceWrite,
        defaultCwd: config.allowedRoots.length === 1 ? config.allowedRoots[0] : null,
        defaultApprovalPolicy: config.defaultApprovalPolicy,
        fastReturnMs: config.fastReturnMs,
        trackedSessions: sessions.size(),
        trackedJobs: jobs.size,
        maxConcurrentJobs: config.maxConcurrentJobs,
        maxPromptChars: config.maxPromptChars,
        upstreamTools: tools
      });
    }
  );

  server.registerTool(
    "codex_read",
    {
      title: "Read Project With Codex",
      description:
        "Run a read-only local Codex inspection in an allowed working directory. The bridge forces Codex read-only and does not permit file modifications. If Codex does not finish before the bridge fast-return deadline, this tool returns a jobId; call codex_job_status with that jobId until it completes.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(config.maxPromptChars)
          .describe("Read-only inspection or analysis prompt for Codex."),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Absolute working directory inside the configured allowed roots. Defaults to the only allowed root."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(30 * 60 * 1000)
          .optional()
          .describe("Request timeout in milliseconds.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const cwd = resolveAllowedCwd(args.cwd, config.allowedRoots);
      enforceSensitiveFilePreflight(config, cwd, "run Codex");
      const sandbox: SandboxMode = "read-only";
      const payload: Record<string, unknown> = {
        prompt: args.prompt,
        cwd,
        sandbox,
        "approval-policy": config.defaultApprovalPolicy
      };
      return runCodexWithFastReturn({
        jobs,
        config,
        operation: "codex_read",
        cwd,
        sandbox,
        run: () => upstream.callTool("codex", payload, args.timeoutMs || config.upstreamTimeoutMs),
        onComplete: (result) => {
          const threadId = extractThreadId(result);
          if (threadId) {
            sessions.record({
              threadId,
              cwd,
              sandbox,
              createdAt: Date.now(),
              lastUsedAt: Date.now()
            });
          }
        }
      });
    }
  );

  server.registerTool(
    "codex_run",
    {
      title: "Run Codex",
      description:
        "Start a local Codex session in an allowed working directory using the bridge sandbox policy. Prefer codex_read for read-only project inspections. If Codex does not finish before the bridge fast-return deadline, this tool returns a jobId; call codex_job_status with that jobId until it completes.",
      inputSchema: {
        prompt: z.string().min(1).max(config.maxPromptChars).describe("Task prompt for Codex."),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Absolute working directory inside the configured allowed roots. Defaults to the only allowed root."),
        sandbox: sandboxSchema(config).optional().describe("Codex sandbox mode. Defaults to bridge policy."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(30 * 60 * 1000)
          .optional()
          .describe("Request timeout in milliseconds.")
      },
      annotations: codexToolAnnotations(config)
    },
    async (args) => {
      const cwd = resolveAllowedCwd(args.cwd, config.allowedRoots);
      enforceSensitiveFilePreflight(config, cwd, "run Codex");
      const sandbox = enforceSandbox(config, args.sandbox as SandboxMode | undefined);
      const payload: Record<string, unknown> = {
        prompt: args.prompt,
        cwd,
        sandbox,
        "approval-policy": config.defaultApprovalPolicy
      };
      return runCodexWithFastReturn({
        jobs,
        config,
        operation: "codex_run",
        cwd,
        sandbox,
        run: () => upstream.callTool("codex", payload, args.timeoutMs || config.upstreamTimeoutMs),
        onComplete: (result) => {
          const threadId = extractThreadId(result);
          if (threadId) {
            sessions.record({
              threadId,
              cwd,
              sandbox,
              createdAt: Date.now(),
              lastUsedAt: Date.now()
            });
          }
        }
      });
    }
  );

  server.registerTool(
    "codex_reply",
    {
      title: "Reply To Codex",
      description:
        "Continue a Codex session that was first created through this bridge. If Codex does not finish before the bridge fast-return deadline, this tool returns a jobId; call codex_job_status with that jobId until it completes.",
      inputSchema: {
        threadId: z.string().min(1).describe("Thread id returned by codex_read or codex_run."),
        prompt: z.string().min(1).max(config.maxPromptChars).describe("Follow-up prompt for the same Codex session."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(30 * 60 * 1000)
          .optional()
          .describe("Request timeout in milliseconds.")
      },
      annotations: codexToolAnnotations(config)
    },
    async (args) => {
      const session = sessions.get(args.threadId);
      if (!session) {
        throw new Error("Unknown Codex thread id. Start the session through codex_read or codex_run on this bridge first.");
      }
      enforceSensitiveFilePreflight(config, session.cwd, "continue Codex");
      return runCodexWithFastReturn({
        jobs,
        config,
        operation: "codex_reply",
        cwd: session.cwd,
        sandbox: session.sandbox,
        run: () =>
          upstream.callTool(
            "codex-reply",
            {
              threadId: args.threadId,
              prompt: args.prompt
            },
            args.timeoutMs || config.upstreamTimeoutMs
          ),
        onComplete: () => sessions.touch(args.threadId)
      });
    }
  );

  server.registerTool(
    "codex_job_status",
    {
      title: "Codex Job Status",
      description:
        "Check a long-running codex_read, codex_run, or codex_reply job that previously returned a jobId. Poll this tool until status is completed or failed.",
      inputSchema: {
        jobId: z.string().min(1).describe("Job id returned by codex_read, codex_run, or codex_reply.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const job = jobs.get(args.jobId);
      if (!job) {
        throw new Error("Unknown Codex job id. Start a long-running job through codex_read, codex_run, or codex_reply first.");
      }
      if (job.status === "running") {
        return textResult({
          status: "running",
          jobId: job.jobId,
          operation: job.operation,
          createdAt: new Date(job.createdAt).toISOString(),
          ageMs: Date.now() - job.createdAt,
          message: "Codex is still running. Call codex_job_status again with this jobId."
        });
      }
      if (job.status === "failed") {
        return textResult({
          status: "failed",
          jobId: job.jobId,
          operation: job.operation,
          error: job.error || "Codex job failed."
        });
      }
      return textResult({
        status: "completed",
        jobId: job.jobId,
        operation: job.operation,
        result: job.result
      });
    }
  );
}

async function runCodexWithFastReturn(input: {
  jobs: CodexJobRegistry;
  config: BridgeConfig;
  operation: "codex_read" | "codex_run" | "codex_reply";
  cwd: string;
  sandbox: SandboxMode;
  activeKey?: string;
  run: () => Promise<ToolResult>;
  onComplete?: (result: ToolResult) => void;
}): Promise<ToolResult> {
  const job = input.jobs.start(
    {
      operation: input.operation,
      cwd: input.cwd,
      sandbox: input.sandbox,
      activeKey: input.activeKey || `cwd:${input.cwd}`
    },
    input.run,
    input.onComplete
  );
  const fastReturnMs = Math.min(input.config.fastReturnMs, input.config.upstreamTimeoutMs);
  const state = await Promise.race([job.promise.then(() => "settled" as const), delay(fastReturnMs).then(() => "running" as const)]);
  if (state === "running") {
    return textResult({
      status: "running",
      jobId: job.jobId,
      operation: job.operation,
      message: "Codex is still running. Call codex_job_status with this jobId until status is completed or failed."
    });
  }
  if (job.status === "completed" && job.result) {
    return forwardResult(job.result);
  }
  throw new Error(job.error || "Codex job failed.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sandboxSchema(config: BridgeConfig) {
  return config.allowWorkspaceWrite ? z.enum(["read-only", "workspace-write"]) : z.enum(["read-only"]);
}

function enforceSensitiveFilePreflight(config: BridgeConfig, cwd: string, operation: "run Codex" | "continue Codex"): void {
  if (!config.secretScan) {
    return;
  }
  const sensitiveFiles = findSensitiveFiles(cwd);
  if (sensitiveFiles.length > 0) {
    throw new Error(
      `Refusing to ${operation} because ${sensitiveFiles.length} sensitive-looking file(s) were found under the allowed root. Move them outside the root or set CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN=1 if you accept the risk.`
    );
  }
}

function codexToolAnnotations(config: BridgeConfig) {
  const readOnly =
    config.defaultSandbox === "read-only" &&
    !config.allowWorkspaceWrite;

  return {
    readOnlyHint: readOnly,
    destructiveHint: config.allowWorkspaceWrite,
    idempotentHint: false,
    openWorldHint: false
  };
}

function forwardResult(result: ToolResult): ToolResult {
  if (Array.isArray(result.content)) {
    return result;
  }
  return textResult(result);
}

function textResult(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
