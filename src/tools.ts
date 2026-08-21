import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig, SandboxMode } from "./config.js";
import {
  enforceSandbox,
  findSensitiveFiles,
  MAX_CODEX_TASK_TIMEOUT_MS,
  requireAllowedCwd,
  resolveAllowedCwd
} from "./config.js";
import type {
  CodexModelCatalogProvider,
  CodexModelCatalogSnapshot,
  CodexModelDescriptor
} from "./modelCatalog.js";
import type { TrackedCodexSession } from "./sessionRegistry.js";
import { extractThreadId, SessionRegistry } from "./sessionRegistry.js";
import { registerSettingsCardResource, SETTINGS_CARD_URI } from "./settingsCard.js";
import type { CodexUpstream, ToolResult } from "./upstream.js";
import {
  MIN_AUTO_RESUME_TTL_MS,
  MIN_TASK_TIMEOUT_MS,
  type BridgeUserSettings,
  type BridgeUserSettingsPatch,
  UserSettingsStore
} from "./userSettings.js";

type CodexJobStatus = "running" | "completed" | "failed";
type CodexJobOperation = "start" | "continue";
type SessionMode = "auto" | "new" | "continue";

const bridgeUserSettingsOutputSchema = z.object({
  revision: z.number().int().min(0),
  updatedAt: z.string().nullable(),
  accessStrategy: z.enum(["read-only", "adaptive", "always-full"]),
  defaultModel: z.string().nullable(),
  defaultReasoningEffort: z.string().nullable(),
  defaultCwd: z.string().nullable(),
  defaultSessionMode: z.enum(["auto", "new"]),
  autoResumeTtlMs: z.number().int().positive(),
  taskTimeoutMs: z.number().int().positive(),
  maxConcurrentJobs: z.number().int().positive()
});

const catalogModelOutputSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  defaultReasoningEffort: z.string().optional(),
  supportedReasoningEfforts: z.array(
    z.object({
      effort: z.string(),
      description: z.string().optional()
    })
  ),
  supportedInApi: z.boolean().optional()
});

const settingsViewOutputSchema = z.object({
  settings: bridgeUserSettingsOutputSchema,
  operatorDefaults: bridgeUserSettingsOutputSchema,
  capabilities: z.object({
    availableAccessStrategies: z.array(z.enum(["read-only", "adaptive", "always-full"])),
    allowedRoots: z.array(z.string()),
    minAutoResumeTtlMs: z.number().int().positive(),
    maxAutoResumeTtlMs: z.number().int().positive(),
    minTaskTimeoutMs: z.number().int().positive(),
    maxTaskTimeoutMs: z.number().int().positive(),
    maxConcurrentJobs: z.number().int().positive(),
    allowWorkspaceWrite: z.boolean(),
    allowDangerFullAccess: z.boolean(),
    persistent: z.boolean()
  }),
  catalog: z.object({
    source: z.string().nullable(),
    fetchedAt: z.string().nullable(),
    cached: z.boolean(),
    stale: z.boolean(),
    warning: z.string().nullable(),
    models: z.array(catalogModelOutputSchema)
  }),
  scopeNotice: z.string()
});

type SettingsView = z.infer<typeof settingsViewOutputSchema>;

type SessionDecision = {
  requestedMode: SessionMode;
  action: CodexJobOperation;
  reason:
    | "explicit-new"
    | "explicit-thread"
    | "recent-compatible"
    | "compatible-session-busy"
    | "no-compatible-session";
  threadId?: string;
};

type CodexJob = {
  jobId: string;
  operation: CodexJobOperation;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  sandbox: SandboxMode;
  exclusiveKeys: string[];
  sessionDecision: SessionDecision;
  status: CodexJobStatus;
  result?: ToolResult;
  resultBytes?: number;
  resultOmitted?: boolean;
  error?: string;
  promise: Promise<void>;
};

export class CodexJobRegistry {
  private readonly jobs = new Map<string, CodexJob>();

  constructor(
    private readonly maxConcurrentJobs = 30,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly maxJobs = 100,
    private readonly maxResultBytes = 1024 * 1024
  ) {}

  get size(): number {
    this.prune();
    return this.jobs.size;
  }

  get(jobId: string): CodexJob | undefined {
    this.prune();
    return this.jobs.get(jobId);
  }

  list(limit = 20): CodexJob[] {
    this.prune();
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, limit));
  }

  isThreadActive(threadId: string): boolean {
    this.prune();
    const exclusiveKey = threadExclusiveKey(threadId);
    return [...this.jobs.values()].some(
      (job) => job.status === "running" && job.exclusiveKeys.includes(exclusiveKey)
    );
  }

  start(
    input: Omit<
      CodexJob,
      | "jobId"
      | "createdAt"
      | "updatedAt"
      | "status"
      | "promise"
      | "result"
      | "resultBytes"
      | "resultOmitted"
      | "error"
    >,
    run: () => Promise<ToolResult>,
    onComplete?: (result: ToolResult) => void,
    activeLimit = this.maxConcurrentJobs
  ): CodexJob {
    this.prune();
    if (!Number.isInteger(activeLimit) || activeLimit < 1 || activeLimit > this.maxConcurrentJobs) {
      throw new Error(`Invalid active Codex job limit: ${activeLimit}.`);
    }
    const running = [...this.jobs.values()].filter((job) => job.status === "running");
    if (running.length >= activeLimit) {
      throw new Error(`Too many Codex jobs are running. The configured limit is ${activeLimit}.`);
    }
    const conflictingKey = input.exclusiveKeys.find((key) =>
      running.some((job) => job.exclusiveKeys.includes(key))
    );
    if (conflictingKey?.startsWith("thread:")) {
      throw new Error("A Codex job is already running for this Codex thread.");
    }
    if (conflictingKey?.startsWith("mutating-cwd:")) {
      throw new Error("A mutating Codex job is already running for this working directory.");
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
        onComplete?.(result);
        const retained = retainBoundedResult(result, this.maxResultBytes, job.sessionDecision);
        job.status = "completed";
        job.result = retained.result;
        job.resultBytes = retained.originalBytes;
        job.resultOmitted = retained.omitted;
        job.updatedAt = Date.now();
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
      if (job.status !== "running" && job.updatedAt < cutoff) this.jobs.delete(jobId);
    }
    if (this.jobs.size <= this.maxJobs) return;
    const sorted = [...this.jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of sorted.filter((entry) => entry.status !== "running").slice(0, this.jobs.size - this.maxJobs)) {
      this.jobs.delete(job.jobId);
    }
  }
}

export function registerBridgeTools(
  server: McpServer,
  config: BridgeConfig,
  upstream: CodexUpstream,
  sessions: SessionRegistry,
  jobs: CodexJobRegistry,
  modelCatalog: CodexModelCatalogProvider,
  userSettings: UserSettingsStore
): void {
  registerSettingsCardResource(server);

  server.registerTool(
    "codex_status",
    {
      title: "Codex Bridge Status",
      description:
        "Read bridge policy, durable Codex session summaries, and recent jobs. Pass a jobId to retrieve one long-running codex_task result. This tool does not start Codex or read project files.",
      inputSchema: {
        jobId: z.string().trim().min(1).optional().describe("Optional job id returned by codex_task."),
        sessionLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum recent session summaries to return when jobId is omitted. Defaults to 10.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      if (args.jobId) {
        const job = jobs.get(args.jobId);
        if (!job) throw new Error("Unknown Codex job id. Start a job through codex_task first.");
        return textResult(formatJobStatus(job));
      }

      let upstreamTools: unknown = null;
      let upstreamError: string | null = null;
      try {
        upstreamTools = await upstream.listTools();
      } catch (error) {
        upstreamError = error instanceof Error ? error.message : String(error);
      }
      const now = Date.now();
      const preferences = userSettings.current;
      return textResult({
        bridge: "codex-mcp-bridge",
        auth: config.token && !config.noAuth ? "bearer-token" : "none",
        allowedRoots: config.allowedRoots,
        defaultCwd: preferences.defaultCwd,
        defaultSandbox: userSettings.resolveSandbox(),
        accessStrategy: preferences.accessStrategy,
        allowWorkspaceWrite: config.allowWorkspaceWrite,
        allowDangerFullAccess: config.allowDangerFullAccess,
        defaultApprovalPolicy: config.defaultApprovalPolicy,
        defaultModel: preferences.defaultModel,
        defaultReasoningEffort: preferences.defaultReasoningEffort,
        defaultSessionMode: preferences.defaultSessionMode,
        dynamicModelCatalog: true,
        modelCatalogCacheTtlMs: config.modelCatalogCacheTtlMs,
        fastReturnMs: config.fastReturnMs,
        upstreamTimeoutMs: preferences.taskTimeoutMs,
        upstreamTimeoutHardLimitMs: config.upstreamTimeoutMs,
        upstreamPoolSize: config.upstreamPoolSize,
        maxConcurrentJobs: preferences.maxConcurrentJobs,
        maxConcurrentJobsHardLimit: config.maxConcurrentJobs,
        maxRetainedJobs: config.maxRetainedJobs,
        maxJobResultBytes: config.maxJobResultBytes,
        concurrencyPolicy: {
          sameWorkingDirectory: {
            readOnly: "allowed",
            workspaceWrite: "serialized",
            dangerFullAccess: "serialized"
          },
          sameThread: "serialized"
        },
        maxPromptChars: config.maxPromptChars,
        sessionPolicy: {
          persistent: sessions.persistent,
          stateFile: sessions.persistencePath,
          autoResumeTtlMs: preferences.autoResumeTtlMs,
          selection: "most-recent-compatible"
        },
        settingsPolicy: {
          persistent: userSettings.persistent,
          stateFile: userSettings.persistencePath,
          revision: preferences.revision,
          scope: "shared-bridge-instance"
        },
        sessions: sessions.list(args.sessionLimit || 10).map((session) => ({
          ...session,
          createdAt: new Date(session.createdAt).toISOString(),
          lastUsedAt: new Date(session.lastUsedAt).toISOString(),
          autoResumeEligible: now - session.lastUsedAt <= preferences.autoResumeTtlMs
        })),
        jobs: jobs.list(Math.min(Math.max(20, preferences.maxConcurrentJobs), 100)).map(formatJobSummary),
        upstreamTools,
        upstreamError
      });
    }
  );

  server.registerTool(
    "codex_models",
    {
      title: "List Codex Models",
      description:
        "Return the current selectable models and each model's supported reasoning efforts directly from the installed Codex CLI. Call this before presenting model or reasoning-effort choices instead of relying on a hard-coded list.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Force an immediate catalog refresh. Omit to use the short-lived cache when available.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (args) => {
      const catalog = await modelCatalog.getCatalog({ refresh: args.refresh });
      const preferences = userSettings.current;
      return textResult({
        source: catalog.source,
        fetchedAt: catalog.fetchedAt,
        cached: catalog.cached,
        stale: catalog.stale,
        warning: catalog.warning,
        defaultModel: preferences.defaultModel,
        defaultReasoningEffort: preferences.defaultReasoningEffort,
        models: catalog.models
      });
    }
  );

  server.registerTool(
    "codex_settings",
    {
      title: "Open Codex Bridge Settings",
      description:
        "Open an interactive settings card and return the saved bridge defaults, owner-enforced limits, allowed roots, and current dynamic Codex model/effort catalog. Use this whenever the user asks where or how to configure the MacBook Air Codex bridge.",
      inputSchema: {
        refreshModels: z
          .boolean()
          .optional()
          .describe("Force a fresh Codex model catalog lookup before rendering the card.")
      },
      outputSchema: settingsViewOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      _meta: {
        ui: {
          resourceUri: SETTINGS_CARD_URI,
          visibility: ["model", "app"]
        },
        "openai/outputTemplate": SETTINGS_CARD_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Codex Bridge 설정을 불러오는 중…",
        "openai/toolInvocation/invoked": "Codex Bridge 설정을 열었습니다."
      }
    },
    async (args) => settingsViewResult(await buildSettingsView(config, userSettings, modelCatalog, args.refreshModels))
  );

  server.registerTool(
    "codex_update_settings",
    {
      title: "Save Codex Bridge Settings",
      description:
        "Validate and persist user-configurable bridge defaults. This action is intended for the Codex settings card; owner security capabilities and allowed roots cannot be changed here.",
      inputSchema: {
        expectedRevision: z.number().int().min(0).optional(),
        reset: z.boolean().optional(),
        accessStrategy: z.enum(["read-only", "adaptive", "always-full"]).optional(),
        defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
        defaultReasoningEffort: z.string().trim().min(1).max(100).nullable().optional(),
        defaultCwd: z.string().trim().min(1).nullable().optional(),
        defaultSessionMode: z.enum(["auto", "new"]).optional(),
        autoResumeTtlMs: z
          .number()
          .int()
          .min(MIN_AUTO_RESUME_TTL_MS)
          .max(userSettings.maxAutoResumeTtlMs)
          .optional(),
        taskTimeoutMs: z
          .number()
          .int()
          .min(MIN_TASK_TIMEOUT_MS)
          .max(config.upstreamTimeoutMs)
          .optional(),
        maxConcurrentJobs: z.number().int().min(1).max(config.maxConcurrentJobs).optional()
      },
      outputSchema: settingsViewOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      _meta: {
        ui: {
          visibility: ["app"]
        },
        "openai/widgetAccessible": true,
        "openai/visibility": "private",
        "openai/toolInvocation/invoking": "Codex Bridge 설정을 저장하는 중…",
        "openai/toolInvocation/invoked": "Codex Bridge 설정을 저장했습니다."
      }
    },
    async (args) => {
      const settingKeys = [
        "accessStrategy",
        "defaultModel",
        "defaultReasoningEffort",
        "defaultCwd",
        "defaultSessionMode",
        "autoResumeTtlMs",
        "taskTimeoutMs",
        "maxConcurrentJobs"
      ] as const;
      if (args.reset) {
        if (settingKeys.some((key) => args[key] !== undefined)) {
          throw new Error("reset cannot be combined with individual setting values.");
        }
        userSettings.reset(args.expectedRevision);
      } else {
        if (!settingKeys.some((key) => args[key] !== undefined)) {
          throw new Error("Provide at least one setting value, or use reset=true.");
        }
        const current = userSettings.current;
        const patch: BridgeUserSettingsPatch = {};
        for (const key of settingKeys) {
          if (args[key] !== undefined) {
            (patch as Record<string, unknown>)[key] = args[key];
          }
        }
        const candidateModel = patch.defaultModel === undefined ? current.defaultModel : patch.defaultModel;
        const candidateEffort =
          patch.defaultReasoningEffort === undefined
            ? patch.defaultModel === null
              ? null
              : current.defaultReasoningEffort
            : patch.defaultReasoningEffort;
        const modelChanged =
          candidateModel !== current.defaultModel || candidateEffort !== current.defaultReasoningEffort;
        if (modelChanged) {
          await resolveModelSelection(
            modelCatalog,
            candidateModel || undefined,
            candidateEffort || undefined
          );
        }
        userSettings.update(patch, args.expectedRevision);
      }
      return settingsViewResult(await buildSettingsView(config, userSettings, modelCatalog));
    }
  );

  server.registerTool(
    "codex_task",
    {
      title: "Run or Continue Codex Task",
      description:
        "Run Codex using saved bridge defaults unless this call overrides them. The saved access strategy is authoritative: read-only forces read-only, adaptive accepts an owner-permitted sandbox choice, and always-full forces danger-full-access. The saved session mode is auto or new. Auto continues the most recently used compatible idle session for the same cwd, effective sandbox, model, and effort inside the saved auto-resume window, or starts a new one. Read-only sessions may run concurrently in one cwd. Mutating jobs are serialized per cwd, and turns on the same thread are serialized. Use new for fresh context or model/effort changes; use continue with an exact threadId for a chosen persisted session.",
      inputSchema: {
        prompt: z.string().min(1).max(config.maxPromptChars).describe("Instruction for Codex."),
        sessionMode: z
          .enum(["auto", "new", "continue"])
          .optional()
          .describe("Session behavior. Omit it to use the saved auto-or-new default."),
        threadId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Exact durable thread id. Required for continue; optional in auto to force that thread."),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Absolute working directory inside the configured allowed roots. Omit it to use the saved default."),
        sandbox: sandboxSchema(config)
          .optional()
          .describe("Requested Codex sandbox for adaptive mode. A saved read-only or always-full strategy overrides it."),
        model: modelSchema(),
        reasoningEffort: reasoningEffortSchema(),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(Math.min(MAX_CODEX_TASK_TIMEOUT_MS, config.upstreamTimeoutMs))
          .optional()
          .describe("Codex MCP inactivity timeout in milliseconds. Omit it to use the saved default; owner maximum is three hours.")
      },
      annotations: codexToolAnnotations(config)
    },
    async (args) => {
      const preferences = userSettings.current;
      const requestedMode = (args.sessionMode || preferences.defaultSessionMode) as SessionMode;

      if (requestedMode === "new") {
        if (args.threadId) throw new Error("threadId cannot be used with sessionMode='new'.");
        return startNewSession({
          args,
          requestedMode,
          reason: "explicit-new",
          config,
          upstream,
          sessions,
          jobs,
          modelCatalog,
          preferences
        });
      }

      if (requestedMode === "continue") {
        if (!args.threadId) throw new Error("sessionMode='continue' requires threadId from codex_status or a prior codex_task result.");
        return continueSession({
          args,
          requestedMode,
          reason: "explicit-thread",
          config,
          upstream,
          sessions,
          jobs,
          preferences
        });
      }

      if (args.threadId) {
        return continueSession({
          args,
          requestedMode,
          reason: "explicit-thread",
          config,
          upstream,
          sessions,
          jobs,
          preferences
        });
      }

      const cwd = resolveTaskCwd(config, preferences, args.cwd);
      const sandbox = resolveTaskSandbox(config, preferences, args.sandbox as SandboxMode | undefined);
      const requestedSelection = taskModelSelection(args, preferences);
      const selection = await resolveModelSelection(
        modelCatalog,
        requestedSelection.model,
        requestedSelection.reasoningEffort
      );
      const recent = sessions.findMostRecentCompatible(
        { cwd, sandbox, ...selection },
        preferences.autoResumeTtlMs
      );
      if (recent && !jobs.isThreadActive(recent.threadId)) {
        return continueTrackedSession({
          prompt: args.prompt,
          timeoutMs: args.timeoutMs,
          requestedMode,
          reason: "recent-compatible",
          session: recent,
          config,
          upstream,
          sessions,
          jobs,
          requestedSandbox: effectiveContinuationSandbox(preferences, args.sandbox as SandboxMode | undefined),
          preferences
        });
      }

      return startNewSession({
        args,
        requestedMode,
        reason: recent ? "compatible-session-busy" : "no-compatible-session",
        config,
        upstream,
        sessions,
        jobs,
        modelCatalog,
        preferences,
        resolved: { cwd, sandbox, selection }
      });
    }
  );
}

type CodexTaskArgs = {
  prompt: string;
  sessionMode?: SessionMode;
  threadId?: string;
  cwd?: string;
  sandbox?: SandboxMode;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
};

async function startNewSession(input: {
  args: CodexTaskArgs;
  requestedMode: SessionMode;
  reason: SessionDecision["reason"];
  config: BridgeConfig;
  upstream: CodexUpstream;
  sessions: SessionRegistry;
  jobs: CodexJobRegistry;
  modelCatalog: CodexModelCatalogProvider;
  preferences: BridgeUserSettings;
  resolved?: { cwd: string; sandbox: SandboxMode; selection: ResolvedModelSelection };
}): Promise<ToolResult> {
  const cwd = input.resolved?.cwd || resolveTaskCwd(input.config, input.preferences, input.args.cwd);
  const sandbox =
    input.resolved?.sandbox || resolveTaskSandbox(input.config, input.preferences, input.args.sandbox);
  const selection =
    input.resolved?.selection ||
    (await resolveModelSelection(input.modelCatalog, ...modelSelectionTuple(input.args, input.preferences)));
  const timeoutMs = input.args.timeoutMs || input.preferences.taskTimeoutMs;
  await enforceSensitiveFilePreflight(input.config, cwd, "run Codex");

  const payload: Record<string, unknown> = {
    prompt: input.args.prompt,
    cwd,
    sandbox,
    "approval-policy": input.config.defaultApprovalPolicy
  };
  applyModelSelection(payload, selection);
  const decision: SessionDecision = {
    requestedMode: input.requestedMode,
    action: "start",
    reason: input.reason
  };
  return runCodexWithFastReturn({
    jobs: input.jobs,
    config: input.config,
    preferences: input.preferences,
    timeoutMs,
    operation: "start",
    cwd,
    sandbox,
    sessionDecision: decision,
    exclusiveKeys: isMutatingSandbox(sandbox) ? [mutatingWorkingDirectoryExclusiveKey(cwd)] : [],
    run: () => input.upstream.callTool("codex", payload, timeoutMs),
    onComplete: (result) => {
      const threadId = extractThreadId(result);
      if (!threadId) return;
      decision.threadId = threadId;
      const now = Date.now();
      input.sessions.record({
        threadId,
        cwd,
        sandbox,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        createdAt: now,
        lastUsedAt: now
      });
    }
  });
}

async function continueSession(input: {
  args: CodexTaskArgs;
  requestedMode: SessionMode;
  reason: SessionDecision["reason"];
  config: BridgeConfig;
  upstream: CodexUpstream;
  sessions: SessionRegistry;
  jobs: CodexJobRegistry;
  preferences: BridgeUserSettings;
}): Promise<ToolResult> {
  const session = input.sessions.get(input.args.threadId || "");
  if (!session) {
    throw new Error("Unknown Codex thread id. Use codex_status to select a persisted session, or start a new codex_task.");
  }
  if (input.args.model || input.args.reasoningEffort) {
    throw new Error("Model and reasoning effort cannot change on a continued thread. Use sessionMode='new'.");
  }
  if (input.args.cwd && resolveTaskCwd(input.config, input.preferences, input.args.cwd) !== session.cwd) {
    throw new Error("cwd does not match the selected Codex thread. Use sessionMode='new' for another working directory.");
  }
  const forcedSandbox = forcedSandboxForStrategy(input.preferences);
  if (forcedSandbox && session.sandbox !== forcedSandbox) {
    throw new Error(
      `The saved ${input.preferences.accessStrategy} access strategy cannot continue a ${session.sandbox} thread. Use sessionMode='new'.`
    );
  }
  if (
    input.preferences.accessStrategy === "adaptive" &&
    input.args.sandbox &&
    enforceSandbox(input.config, input.args.sandbox) !== session.sandbox
  ) {
    throw new Error("sandbox does not match the selected Codex thread. Use sessionMode='new' to change permissions.");
  }
  return continueTrackedSession({
    prompt: input.args.prompt,
    timeoutMs: input.args.timeoutMs,
    requestedMode: input.requestedMode,
    reason: input.reason,
    session,
    config: input.config,
    upstream: input.upstream,
    sessions: input.sessions,
    jobs: input.jobs,
    requestedSandbox: effectiveContinuationSandbox(input.preferences, input.args.sandbox),
    preferences: input.preferences
  });
}

async function continueTrackedSession(input: {
  prompt: string;
  timeoutMs?: number;
  requestedMode: SessionMode;
  reason: SessionDecision["reason"];
  session: TrackedCodexSession;
  config: BridgeConfig;
  upstream: CodexUpstream;
  sessions: SessionRegistry;
  jobs: CodexJobRegistry;
  requestedSandbox?: SandboxMode;
  preferences: BridgeUserSettings;
}): Promise<ToolResult> {
  if (isMutatingSandbox(input.session.sandbox) && input.requestedSandbox !== input.session.sandbox) {
    throw new Error(
      `Continuing a ${input.session.sandbox} thread requires sandbox='${input.session.sandbox}' on this call.`
    );
  }
  const currentCwd = resolveAllowedCwd(input.session.cwd, input.config.allowedRoots);
  if (currentCwd !== input.session.cwd) {
    throw new Error("The selected Codex thread no longer resolves to its recorded allowed working directory.");
  }
  await enforceSensitiveFilePreflight(input.config, currentCwd, "continue Codex");
  const timeoutMs = input.timeoutMs || input.preferences.taskTimeoutMs;
  const decision: SessionDecision = {
    requestedMode: input.requestedMode,
    action: "continue",
    reason: input.reason,
    threadId: input.session.threadId
  };
  return runCodexWithFastReturn({
    jobs: input.jobs,
    config: input.config,
    preferences: input.preferences,
    timeoutMs,
    operation: "continue",
    cwd: input.session.cwd,
    sandbox: input.session.sandbox,
    sessionDecision: decision,
    exclusiveKeys: [
      threadExclusiveKey(input.session.threadId),
      ...(isMutatingSandbox(input.session.sandbox)
        ? [mutatingWorkingDirectoryExclusiveKey(input.session.cwd)]
        : [])
    ],
    run: () =>
      input.upstream.callTool(
        "codex-reply",
        { threadId: input.session.threadId, prompt: input.prompt },
        timeoutMs
      ),
    onComplete: () => input.sessions.touch(input.session.threadId)
  });
}

async function runCodexWithFastReturn(input: {
  jobs: CodexJobRegistry;
  config: BridgeConfig;
  preferences: BridgeUserSettings;
  timeoutMs: number;
  operation: CodexJobOperation;
  cwd: string;
  sandbox: SandboxMode;
  sessionDecision: SessionDecision;
  exclusiveKeys?: string[];
  run: () => Promise<ToolResult>;
  onComplete?: (result: ToolResult) => void;
}): Promise<ToolResult> {
  const job = input.jobs.start(
    {
      operation: input.operation,
      cwd: input.cwd,
      sandbox: input.sandbox,
      exclusiveKeys: input.exclusiveKeys || [],
      sessionDecision: input.sessionDecision
    },
    input.run,
    input.onComplete,
    input.preferences.maxConcurrentJobs
  );
  const fastReturnMs = Math.min(input.config.fastReturnMs, input.timeoutMs);
  const state = await Promise.race([
    job.promise.then(() => "settled" as const),
    delay(fastReturnMs).then(() => "running" as const)
  ]);
  if (state === "running") {
    return textResult({
      status: "running",
      jobId: job.jobId,
      operation: job.operation,
      session: job.sessionDecision,
      message: "Codex is still running. Call codex_status with this jobId until status is completed or failed."
    });
  }
  if (job.status === "completed" && job.result) return forwardResult(job.result, job.sessionDecision);
  throw new Error(job.error || "Codex job failed.");
}

function formatJobStatus(job: CodexJob): Record<string, unknown> {
  if (job.status === "running") {
    return {
      status: "running",
      jobId: job.jobId,
      operation: job.operation,
      session: job.sessionDecision,
      createdAt: new Date(job.createdAt).toISOString(),
      ageMs: Date.now() - job.createdAt,
      message: "Codex is still running. Call codex_status again with this jobId."
    };
  }
  if (job.status === "failed") {
    return {
      status: "failed",
      jobId: job.jobId,
      operation: job.operation,
      session: job.sessionDecision,
      error: job.error || "Codex job failed."
    };
  }
  return {
    status: "completed",
    jobId: job.jobId,
    operation: job.operation,
    session: job.sessionDecision,
    result: job.result,
    resultBytes: job.resultBytes,
    resultOmitted: job.resultOmitted || false
  };
}

function formatJobSummary(job: CodexJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    status: job.status,
    operation: job.operation,
    cwd: job.cwd,
    sandbox: job.sandbox,
    session: job.sessionDecision,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    resultBytes: job.resultBytes,
    resultOmitted: job.resultOmitted || false
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function threadExclusiveKey(threadId: string): string {
  return `thread:${threadId}`;
}

function mutatingWorkingDirectoryExclusiveKey(cwd: string): string {
  return `mutating-cwd:${cwd}`;
}

function sandboxSchema(config: BridgeConfig) {
  const allowed: [SandboxMode, ...SandboxMode[]] = ["read-only"];
  if (config.allowWorkspaceWrite) allowed.push("workspace-write");
  if (config.allowDangerFullAccess) allowed.push("danger-full-access");
  return z.enum(allowed);
}

function isMutatingSandbox(sandbox: SandboxMode): boolean {
  return sandbox !== "read-only";
}

function modelSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Optional exact model id for a new session. Omit it to use the bridge or Codex default.");
}

function reasoningEffortSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional effort for a new session. Call codex_models to discover supported values.");
}

async function buildSettingsView(
  config: BridgeConfig,
  userSettings: UserSettingsStore,
  modelCatalog: CodexModelCatalogProvider,
  refreshModels = false
): Promise<SettingsView> {
  let catalog: CodexModelCatalogSnapshot | undefined;
  let catalogError: string | undefined;
  try {
    catalog = await modelCatalog.getCatalog({ refresh: refreshModels });
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error);
  }
  const availableAccessStrategies: SettingsView["capabilities"]["availableAccessStrategies"] = [
    "read-only",
    "adaptive"
  ];
  if (config.allowDangerFullAccess) availableAccessStrategies.push("always-full");
  return {
    settings: userSettings.current,
    operatorDefaults: userSettings.defaults,
    capabilities: {
      availableAccessStrategies,
      allowedRoots: [...config.allowedRoots],
      minAutoResumeTtlMs: MIN_AUTO_RESUME_TTL_MS,
      maxAutoResumeTtlMs: userSettings.maxAutoResumeTtlMs,
      minTaskTimeoutMs: MIN_TASK_TIMEOUT_MS,
      maxTaskTimeoutMs: config.upstreamTimeoutMs,
      maxConcurrentJobs: config.maxConcurrentJobs,
      allowWorkspaceWrite: config.allowWorkspaceWrite,
      allowDangerFullAccess: config.allowDangerFullAccess,
      persistent: userSettings.persistent
    },
    catalog: {
      source: catalog?.source || null,
      fetchedAt: catalog?.fetchedAt || null,
      cached: catalog?.cached || false,
      stale: catalog?.stale || false,
      warning: catalog?.warning || catalogError || null,
      models: (catalog?.models || []) as CodexModelDescriptor[]
    },
    scopeNotice:
      "이 설정은 ChatGPT 계정별 값이 아니라 이 MacBook Air 브리지 연결을 사용하는 모든 대화에 공유됩니다. 운영자 보안정책은 카드에서 변경할 수 없습니다."
  };
}

function settingsViewResult(view: SettingsView): ToolResult {
  return {
    structuredContent: view,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            settings: view.settings,
            capabilities: view.capabilities,
            catalog: view.catalog,
            scopeNotice: view.scopeNotice
          },
          null,
          2
        )
      }
    ]
  };
}

function resolveTaskCwd(
  config: BridgeConfig,
  preferences: BridgeUserSettings,
  requested?: string
): string {
  if (requested) return requireAllowedCwd(requested, config.allowedRoots);
  if (preferences.defaultCwd) return requireAllowedCwd(preferences.defaultCwd, config.allowedRoots);
  return resolveAllowedCwd(undefined, config.allowedRoots);
}

function resolveTaskSandbox(
  config: BridgeConfig,
  preferences: BridgeUserSettings,
  requested?: SandboxMode
): SandboxMode {
  const forced = forcedSandboxForStrategy(preferences);
  return forced ? enforceSandbox(config, forced) : enforceSandbox(config, requested);
}

function forcedSandboxForStrategy(preferences: BridgeUserSettings): SandboxMode | undefined {
  if (preferences.accessStrategy === "read-only") return "read-only";
  if (preferences.accessStrategy === "always-full") return "danger-full-access";
  return undefined;
}

function effectiveContinuationSandbox(
  preferences: BridgeUserSettings,
  requested?: SandboxMode
): SandboxMode | undefined {
  return forcedSandboxForStrategy(preferences) || requested;
}

type ResolvedModelSelection = {
  model?: string;
  reasoningEffort?: string;
};

function taskModelSelection(
  args: Pick<CodexTaskArgs, "model" | "reasoningEffort">,
  preferences: BridgeUserSettings
): ResolvedModelSelection {
  const model = args.model || preferences.defaultModel || undefined;
  const useSavedEffort = !args.model || args.model === preferences.defaultModel;
  const reasoningEffort =
    args.reasoningEffort || (useSavedEffort ? preferences.defaultReasoningEffort || undefined : undefined);
  return { model, reasoningEffort };
}

function modelSelectionTuple(
  args: Pick<CodexTaskArgs, "model" | "reasoningEffort">,
  preferences: BridgeUserSettings
): [string | undefined, string | undefined] {
  const selection = taskModelSelection(args, preferences);
  return [selection.model, selection.reasoningEffort];
}

async function resolveModelSelection(
  modelCatalog: CodexModelCatalogProvider,
  model: string | undefined,
  reasoningEffort: string | undefined
): Promise<ResolvedModelSelection> {
  if (!model && !reasoningEffort) return {};
  if (!model) {
    throw new Error(
      "reasoningEffort requires an explicit model or CODEX_MCP_BRIDGE_DEFAULT_MODEL so the bridge can validate compatibility."
    );
  }

  const catalog = await modelCatalog.getCatalog();
  const selectedModel = catalog.models.find((entry) => entry.id === model);
  if (!selectedModel) {
    const available = catalog.models.map((entry) => entry.id).join(", ");
    throw new Error(`Unknown or unavailable Codex model '${model}'. Call codex_models to refresh the list. Available: ${available}`);
  }
  if (
    reasoningEffort &&
    !selectedModel.supportedReasoningEfforts.some((entry) => entry.effort === reasoningEffort)
  ) {
    const available = selectedModel.supportedReasoningEfforts.map((entry) => entry.effort).join(", ");
    throw new Error(
      `Codex model '${model}' does not support reasoning effort '${reasoningEffort}'. Supported values: ${available}`
    );
  }
  return { model, reasoningEffort };
}

function applyModelSelection(payload: Record<string, unknown>, selection: ResolvedModelSelection): void {
  if (selection.model) payload.model = selection.model;
  if (selection.reasoningEffort) payload.config = { model_reasoning_effort: selection.reasoningEffort };
}

async function enforceSensitiveFilePreflight(
  config: BridgeConfig,
  cwd: string,
  operation: "run Codex" | "continue Codex"
): Promise<void> {
  if (!config.secretScan) return;
  const sensitiveFiles = await findSensitiveFiles(cwd);
  if (sensitiveFiles.length > 0) {
    throw new Error(
      `Refusing to ${operation} because ${sensitiveFiles.length} sensitive-looking file(s) were found under the allowed root. Move them outside the root or set CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN=1 if you accept the risk.`
    );
  }
}

function retainBoundedResult(
  result: ToolResult,
  maxBytes: number,
  session: SessionDecision
): { result: ToolResult; originalBytes: number; omitted: boolean } {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    serialized = undefined;
  }
  const originalBytes = serialized === undefined ? -1 : Buffer.byteLength(serialized, "utf8");
  if (originalBytes >= 0 && originalBytes <= maxBytes) {
    return { result, originalBytes, omitted: false };
  }

  const threadId = extractThreadId(result) || session.threadId;
  const summary = {
    status: "completed",
    resultOmitted: true,
    originalBytes: originalBytes >= 0 ? originalBytes : null,
    maxRetainedBytes: maxBytes,
    threadId: threadId || null,
    message: "Codex completed, but its result exceeded the bridge retention limit and was omitted. Retry with a narrower prompt or raise CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES."
  };
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary
    },
    originalBytes,
    omitted: true
  };
}

function codexToolAnnotations(config: BridgeConfig) {
  const exposesMutation = config.allowWorkspaceWrite || config.allowDangerFullAccess;
  const readOnly = config.defaultSandbox === "read-only" && !exposesMutation;
  return {
    readOnlyHint: readOnly,
    destructiveHint: exposesMutation,
    idempotentHint: false,
    openWorldHint: config.allowDangerFullAccess
  };
}

function forwardResult(result: ToolResult, session: SessionDecision): ToolResult {
  const forwarded = Array.isArray(result.content) ? result : textResult(result);
  const structured = isRecord((forwarded as { structuredContent?: unknown }).structuredContent)
    ? (forwarded as { structuredContent: Record<string, unknown> }).structuredContent
    : {};
  return {
    ...forwarded,
    structuredContent: {
      ...structured,
      threadId: extractThreadId(forwarded) || session.threadId,
      bridgeSession: session
    }
  };
}

function textResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
