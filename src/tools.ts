import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeConfig, SandboxMode } from "./config.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
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
import {
  extractThreadId,
  LEGACY_SCOPE_ID,
  SCOPE_ID_PATTERN,
  SessionRegistry
} from "./sessionRegistry.js";
import { registerSettingsCardResource, SETTINGS_CARD_URI } from "./settingsCard.js";
import type { BridgeStateStore } from "./stateStore.js";
import type { CodexUpstream, ToolResult } from "./upstream.js";
import {
  MIN_AUTO_RESUME_TTL_MS,
  MIN_TASK_TIMEOUT_MS,
  type BridgeUserSettings,
  type BridgeUserSettingsPatch,
  UserSettingsStore
} from "./userSettings.js";

type CodexJobStatus = "running" | "completed" | "failed" | "interrupted" | "cancelled";
type CodexJobOperation = "start" | "continue";
type SessionMode = "auto" | "new" | "continue";
type CodexJobWaitMode = "change" | "terminal";

export const MAX_CODEX_STATUS_WAIT_MS = 60_000;
export const DEFAULT_CODEX_STATUS_WAIT_MS = 55_000;
const JOB_PROGRESS_PERSIST_INTERVAL_MS = 30_000;

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
  warnings: z.array(z.string()),
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

type CodexRouting = {
  scopeId: string;
  requestId: string;
  requestHash: string;
};

type CodexJob = {
  jobId: string;
  operation: CodexJobOperation;
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number;
  version: number;
  cwd: string;
  sandbox: SandboxMode;
  scopeId: string;
  requestId: string;
  requestHash: string;
  requestHashVersion: 1 | 2;
  selectionKey?: string;
  exclusiveKeys: string[];
  sessionDecision: SessionDecision;
  status: CodexJobStatus;
  result?: ToolResult;
  resultBytes?: number;
  resultOmitted?: boolean;
  lastProgress?: Progress;
  cancelRequestedAt?: number;
  error?: string;
  promise: Promise<void>;
  abortController?: AbortController;
};

type PersistedCodexJob = Omit<CodexJob, "promise" | "abortController">;

type PersistedCodexJobState = {
  version: 4;
  jobs: PersistedCodexJob[];
};

export type CodexJobRegistryOptions = {
  maxConcurrentJobs?: number;
  ttlMs?: number;
  maxJobs?: number;
  maxResultBytes?: number;
  staleAfterMs?: number;
  stateFile?: string;
  stateStore?: BridgeStateStore;
  allowedRoots?: string[];
};

type CodexJobWaitResult = {
  job: CodexJob;
  waitFor: CodexJobWaitMode;
  waitedMs: number;
  waitTimedOut: boolean;
  changed: boolean;
};

export class CodexJobRegistry {
  private readonly jobs = new Map<string, CodexJob>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly maxConcurrentJobs: number;
  private readonly ttlMs: number;
  private readonly maxJobs: number;
  private readonly maxResultBytes: number;
  private readonly staleAfterMs: number;
  private readonly stateFile?: string;
  private readonly stateStore?: BridgeStateStore;
  private readonly allowedRoots: string[];
  private persistenceWarningShown = false;
  private lastPersistedAt = 0;

  constructor(options: CodexJobRegistryOptions = {}) {
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 30;
    this.ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
    this.maxJobs = options.maxJobs ?? 100;
    this.maxResultBytes = options.maxResultBytes ?? 1024 * 1024;
    this.staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000;
    this.stateFile = options.stateFile;
    this.stateStore = options.stateStore;
    this.allowedRoots = options.allowedRoots || [];
    this.load();
  }

  get persistent(): boolean {
    return Boolean(this.stateStore?.persistent || this.stateFile);
  }

  get persistencePath(): string | null {
    return this.stateStore?.persistencePath || this.stateFile || null;
  }

  get staleThresholdMs(): number {
    return this.staleAfterMs;
  }

  get size(): number {
    this.pruneAndPersist();
    return this.jobs.size;
  }

  get(jobId: string): CodexJob | undefined {
    this.pruneAndPersist();
    return this.jobs.get(jobId);
  }

  list(limit = 20, offset = 0): CodexJob[] {
    this.pruneAndPersist();
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  }

  listForScope(scopeId: string, limit = 20, offset = 0): CodexJob[] {
    return this.list(this.maxJobs)
      .filter((job) => job.scopeId === scopeId)
      .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  }

  sizeForScope(scopeId: string): number {
    this.pruneAndPersist();
    return [...this.jobs.values()].filter((job) => job.scopeId === scopeId).length;
  }

  runningCount(scopeId?: string): number {
    this.pruneAndPersist();
    return [...this.jobs.values()].filter(
      (job) => job.status === "running" && (!scopeId || job.scopeId === scopeId)
    ).length;
  }

  findRequest(scopeId: string, requestId: string, requestHash: string): CodexJob | undefined {
    this.pruneAndPersist();
    const job = [...this.jobs.values()].find(
      (entry) => entry.scopeId === scopeId && entry.requestId === requestId
    );
    if (job && job.requestHashVersion >= 2 && job.requestHash !== requestHash) {
      throw new Error("requestId was already used for a different Codex task in this scope.");
    }
    return job;
  }

  isThreadActive(threadId: string): boolean {
    this.pruneAndPersist();
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
      | "lastProgressAt"
      | "lastProgress"
      | "cancelRequestedAt"
      | "version"
      | "status"
      | "promise"
      | "abortController"
      | "result"
      | "resultBytes"
      | "resultOmitted"
      | "error"
    >,
    run: (onProgress: (progress: Progress) => void, signal: AbortSignal) => Promise<ToolResult>,
    onComplete?: (result: ToolResult) => void | (() => void),
    activeLimit = this.maxConcurrentJobs,
    rejectIfSelectionActive = false
  ): CodexJob {
    this.pruneAndPersist();
    const replay = this.findRequest(input.scopeId, input.requestId, input.requestHash);
    if (replay) return replay;
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
    if (
      rejectIfSelectionActive &&
      input.selectionKey &&
      running.some((job) => job.selectionKey === input.selectionKey)
    ) {
      throw new Error(
        "A compatible Codex session is still starting or running in this conversation scope. Wait for it, or use sessionMode='new' to deliberately start parallel work."
      );
    }
    const now = Date.now();
    const abortController = new AbortController();
    const job: CodexJob = {
      ...input,
      requestHashVersion: input.requestHashVersion || 2,
      jobId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      lastProgressAt: now,
      version: 1,
      status: "running",
      promise: Promise.resolve(),
      abortController
    };
    this.jobs.set(job.jobId, job);
    try {
      this.persistJob(job);
    } catch (error) {
      this.jobs.delete(job.jobId);
      throw error;
    }
    job.promise = Promise.resolve()
      .then(() => run((progress) => this.recordProgress(job, progress), abortController.signal))
      .then((result) => {
        job.abortController = undefined;
        if (job.status === "cancelled") return;
        if (result.isError) throw new Error(toolResultErrorMessage(result));
        const retained = retainBoundedResult(result, this.maxResultBytes, job.sessionDecision);
        let undo: (() => void) | undefined;
        try {
          const finish = () => {
            undo = onComplete?.(result) || undefined;
            job.status = "completed";
            job.result = retained.result;
            job.resultBytes = retained.originalBytes;
            job.resultOmitted = retained.omitted;
            job.updatedAt = Date.now();
            job.version += 1;
            this.persistJob(job);
          };
          if (this.stateStore) this.stateStore.transaction(finish);
          else finish();
          this.notify(job.jobId);
          this.pruneAndPersist();
        } catch (error) {
          undo?.();
          throw error;
        }
      })
      .catch((error: unknown) => {
        job.abortController = undefined;
        if (job.status === "cancelled") return;
        job.status = "failed";
        job.result = undefined;
        job.resultBytes = undefined;
        job.resultOmitted = undefined;
        job.error = error instanceof Error ? error.message : String(error);
        this.recordChange(job);
      });
    this.pruneAndPersist();
    return job;
  }

  cancel(jobId: string): CodexJob {
    const job = this.get(jobId);
    if (!job) throw new Error("Unknown Codex job id. Start a job through codex_task first.");
    if (job.status !== "running") return job;
    job.cancelRequestedAt = Date.now();
    job.status = "cancelled";
    job.error = "The Codex job was cancelled by the bridge caller. Partial filesystem changes may remain.";
    job.abortController?.abort(new Error("Codex job cancelled by caller."));
    job.abortController = undefined;
    this.recordChange(job);
    return job;
  }

  async wait(jobId: string, waitFor: CodexJobWaitMode, waitMs: number): Promise<CodexJobWaitResult> {
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > MAX_CODEX_STATUS_WAIT_MS) {
      throw new Error(`waitMs must be an integer between 1 and ${MAX_CODEX_STATUS_WAIT_MS}.`);
    }
    const initial = this.get(jobId);
    if (!initial) throw new Error("Unknown Codex job id. Start a job through codex_task first.");
    const startedAt = Date.now();
    const initialVersion = initial.version;
    let current = initial;
    let changed = false;

    if (current.status === "running") {
      const deadline = startedAt + waitMs;
      do {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const observedVersion = current.version;
        const didChange = await this.waitForVersion(jobId, observedVersion, remaining);
        changed ||= didChange;
        current = this.get(jobId) || current;
        if (waitFor === "change" && current.version !== initialVersion) break;
      } while (waitFor === "terminal" && current.status === "running");
    }

    return {
      job: current,
      waitFor,
      waitedMs: Date.now() - startedAt,
      waitTimedOut:
        current.status === "running" &&
        (waitFor === "terminal" || current.version === initialVersion),
      changed: changed || current.version !== initialVersion
    };
  }

  private recordProgress(job: CodexJob, progress: Progress): void {
    if (job.status !== "running") return;
    const now = Date.now();
    job.lastProgress = sanitizeProgress(progress);
    job.lastProgressAt = now;
    job.updatedAt = now;
    job.version += 1;
    this.notify(job.jobId);
    if (now - this.lastPersistedAt >= JOB_PROGRESS_PERSIST_INTERVAL_MS) {
      this.persistJobBestEffort(job);
    }
  }

  private recordChange(job: CodexJob): void {
    job.updatedAt = Date.now();
    job.version += 1;
    this.notify(job.jobId);
    const beforePrune = new Map(this.jobs);
    const removed = this.prune();
    if (!this.persistJobBestEffort(job, removed)) {
      for (const jobId of removed) {
        const previous = beforePrune.get(jobId);
        if (previous) this.jobs.set(jobId, previous);
      }
    }
  }

  private waitForVersion(jobId: string, version: number, waitMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const listeners = this.waiters.get(jobId) || new Set<() => void>();
      this.waiters.set(jobId, listeners);
      const finish = (changed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listeners.delete(onChange);
        if (listeners.size === 0) this.waiters.delete(jobId);
        resolve(changed);
      };
      const onChange = () => finish((this.jobs.get(jobId)?.version || version) !== version);
      const timer = setTimeout(() => finish(false), waitMs);
      listeners.add(onChange);
      if ((this.jobs.get(jobId)?.version || version) !== version) finish(true);
    });
  }

  private notify(jobId: string): void {
    for (const listener of [...(this.waiters.get(jobId) || [])]) listener();
  }

  private prune(): string[] {
    const removed: string[] = [];
    const cutoff = Date.now() - this.ttlMs;
    for (const [jobId, job] of this.jobs) {
      if (job.status !== "running" && job.updatedAt < cutoff) {
        this.jobs.delete(jobId);
        removed.push(jobId);
      }
    }
    if (this.jobs.size <= this.maxJobs) return removed;
    const sorted = [...this.jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of sorted.filter((entry) => entry.status !== "running").slice(0, this.jobs.size - this.maxJobs)) {
      this.jobs.delete(job.jobId);
      removed.push(job.jobId);
    }
    return removed;
  }

  private load(): void {
    if (this.stateStore) {
      const stored = this.stateStore.listJobs();
      const changed = this.loadJobs(stored, 4);
      if (changed || this.jobs.size !== stored.length) {
        this.stateStore.replaceJobs(this.persistedJobs());
      }
      this.importLegacyState();
      return;
    }
    this.loadJsonState();
  }

  private loadJsonState(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read Codex job state at ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      !isRecord(parsed) ||
      (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4) ||
      !Array.isArray(parsed.jobs)
    ) {
      throw new Error(`Invalid Codex job state format at ${this.stateFile}.`);
    }

    const stateVersion = parsed.version as 1 | 2 | 3 | 4;
    const changed = this.loadJobs(parsed.jobs, stateVersion);
    if (changed || stateVersion !== 4) this.persist();
  }

  private loadJobs(values: unknown[], stateVersion: 1 | 2 | 3 | 4): boolean {
    const now = Date.now();
    let changed = stateVersion !== 4;
    const valid = values
      .map((job) => readPersistedJob(job, stateVersion))
      .filter((job): job is PersistedCodexJob => Boolean(job))
      .filter((job) => this.isAllowedCwd(job.cwd))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    const byRequest = new Map<string, PersistedCodexJob>();
    for (const job of valid) {
      byRequest.set(`${job.scopeId}\0${job.requestId}`, job);
    }
    const loaded = [...byRequest.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    if (loaded.length !== valid.length) changed = true;
    for (const persisted of loaded) {
      const requestConflict = [...this.jobs.values()].find(
        (job) =>
          job.jobId !== persisted.jobId &&
          job.scopeId === persisted.scopeId &&
          job.requestId === persisted.requestId
      );
      if (requestConflict) {
        changed = true;
        if (requestConflict.updatedAt >= persisted.updatedAt) continue;
        this.jobs.delete(requestConflict.jobId);
      }
      const job: CodexJob = { ...persisted, promise: Promise.resolve() };
      if (job.status === "running") {
        job.status = "interrupted";
        job.error = "The bridge restarted before this Codex job reached a terminal state.";
        job.updatedAt = now;
        job.version += 1;
        changed = true;
      } else if (job.status === "completed" && job.result?.isError) {
        job.status = "failed";
        job.error = toolResultErrorMessage(job.result);
        job.result = undefined;
        job.resultBytes = undefined;
        job.resultOmitted = undefined;
        job.updatedAt = now;
        job.version += 1;
        changed = true;
      }
      this.jobs.set(job.jobId, job);
    }
    changed = this.prune().length > 0 || changed || loaded.length !== values.length;
    return changed;
  }

  private importLegacyState(): void {
    if (!this.stateStore || !this.stateFile || !existsSync(this.stateFile)) return;
    const marker = `legacy_jobs_imported:${this.stateFile}`;
    if (this.stateStore.getMeta(marker)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read Codex job state at ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      !isRecord(parsed) ||
      (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4) ||
      !Array.isArray(parsed.jobs)
    ) {
      throw new Error(`Invalid Codex job state format at ${this.stateFile}.`);
    }
    const stateVersion = parsed.version as 1 | 2 | 3 | 4;
    const existing = new Set(this.jobs.keys());
    const candidates = parsed.jobs.filter((value) => {
      const id = isRecord(value) && typeof value.jobId === "string" ? value.jobId : undefined;
      return id ? !existing.has(id) : true;
    });
    this.stateStore.transaction(() => {
      this.loadJobs(candidates, stateVersion);
      this.stateStore?.replaceJobs(this.persistedJobs());
      this.stateStore?.setMeta(marker, new Date().toISOString());
    });
  }

  private persist(): void {
    if (this.stateStore) {
      this.stateStore.replaceJobs(this.persistedJobs());
      this.lastPersistedAt = Date.now();
      this.persistenceWarningShown = false;
      return;
    }
    if (!this.stateFile) return;
    const directory = path.dirname(this.stateFile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    const state: PersistedCodexJobState = {
      version: 4,
      jobs: this.persistedJobs()
    };
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    renameSync(temporary, this.stateFile);
    chmodSync(this.stateFile, 0o600);
    this.lastPersistedAt = Date.now();
    this.persistenceWarningShown = false;
  }

  private persistedJobs(): PersistedCodexJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ promise: _promise, abortController: _abortController, ...job }) => job);
  }

  private persistJob(job: CodexJob, removed: string[] = []): void {
    if (!this.stateStore) {
      this.persist();
      return;
    }
    const { promise: _promise, abortController: _abortController, ...persisted } = job;
    this.stateStore.transaction(() => {
      this.stateStore?.upsertJob(persisted);
      for (const jobId of removed) this.stateStore?.deleteJob(jobId);
    });
    this.lastPersistedAt = Date.now();
    this.persistenceWarningShown = false;
  }

  private persistJobBestEffort(job: CodexJob, removed: string[] = []): boolean {
    try {
      this.persistJob(job, removed);
      return true;
    } catch (error) {
      if (!this.persistenceWarningShown) {
        console.error(
          `Could not persist Codex job state: ${error instanceof Error ? error.message : String(error)}`
        );
        this.persistenceWarningShown = true;
      }
      return false;
    }
  }

  private pruneAndPersist(): void {
    const beforePrune = new Map(this.jobs);
    const removed = this.prune();
    if (removed.length === 0) return;
    try {
      if (this.stateStore) {
        this.stateStore.transaction(() => {
          for (const jobId of removed) this.stateStore?.deleteJob(jobId);
        });
      } else {
        this.persist();
      }
    } catch (error) {
      this.jobs.clear();
      for (const [jobId, job] of beforePrune) this.jobs.set(jobId, job);
      if (!this.persistenceWarningShown) {
        console.error(
          `Could not persist Codex job pruning: ${error instanceof Error ? error.message : String(error)}`
        );
        this.persistenceWarningShown = true;
      }
    }
  }

  private isAllowedCwd(cwd: string): boolean {
    if (this.allowedRoots.length === 0) return true;
    return this.allowedRoots.some((root) => cwd === root || cwd.startsWith(root + path.sep));
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
        "Read bridge policy plus Codex sessions and jobs for one ChatGPT conversation scope. Reuse the same scopeId that was sent to codex_task. Pass a jobId to retrieve or wait for one long-running result. Omit scopeId only for policy-only status, or set includeAllScopes only when the user explicitly requests a bridge-wide operator audit.",
      inputSchema: {
        scopeId: scopeIdSchema()
          .optional()
          .describe("Conversation-scope UUID used by codex_task. It filters session and job details."),
        includeAllScopes: z
          .boolean()
          .optional()
          .describe("Operator audit view across every scope. Use only when the user explicitly requests it."),
        jobId: z.string().trim().min(1).optional().describe("Optional job id returned by codex_task."),
        waitFor: z
          .enum(["change", "terminal"])
          .optional()
          .describe(
            "With jobId, wait for the next progress/status change or for a terminal completed/failed/interrupted/cancelled status."
          ),
        waitMs: z
          .number()
          .int()
          .min(1)
          .max(MAX_CODEX_STATUS_WAIT_MS)
          .optional()
          .describe(
            `Bounded long-poll duration when waitFor is set. Defaults to ${DEFAULT_CODEX_STATUS_WAIT_MS} and cannot exceed ${MAX_CODEX_STATUS_WAIT_MS} milliseconds.`
          ),
        sessionLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum session summaries in this page. Defaults to 10; use sessionOffset for later pages."),
        sessionOffset: z.number().int().min(0).optional().describe("Zero-based session page offset."),
        jobLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum job summaries in this page. Defaults to the active-job limit, at least 20."),
        jobOffset: z.number().int().min(0).optional().describe("Zero-based job page offset.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      if (args.scopeId && args.includeAllScopes) {
        throw new Error("scopeId and includeAllScopes cannot be used together.");
      }
      if ((args.waitFor || args.waitMs) && !args.jobId) {
        throw new Error("waitFor and waitMs require a jobId returned by codex_task.");
      }
      if (args.waitMs && !args.waitFor) {
        throw new Error("waitMs requires waitFor='change' or waitFor='terminal'.");
      }
      if (args.jobId) {
        if (!args.scopeId && !args.includeAllScopes) {
          throw new Error("A scopeId is required to read a job unless includeAllScopes is explicitly requested.");
        }
        const initial = jobs.get(args.jobId);
        if (!initial) throw new Error("Unknown Codex job id. Start a job through codex_task first.");
        if (!args.includeAllScopes && initial.scopeId !== args.scopeId) {
          throw new Error("The requested Codex job belongs to another conversation scope.");
        }
        const wait = args.waitFor
          ? await jobs.wait(args.jobId, args.waitFor, args.waitMs || DEFAULT_CODEX_STATUS_WAIT_MS)
          : undefined;
        const job = wait?.job || initial;
        return textResult(formatJobStatus(job, jobs.staleThresholdMs, wait));
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
      const sessionLimit = args.sessionLimit ?? 10;
      const sessionOffset = args.sessionOffset ?? 0;
      const jobLimit = args.jobLimit ?? Math.min(Math.max(20, preferences.maxConcurrentJobs), 100);
      const jobOffset = args.jobOffset ?? 0;
      const visibleSessions = args.includeAllScopes
        ? sessions.list(sessionLimit, sessionOffset)
        : args.scopeId
          ? sessions.listForScope(args.scopeId, sessionLimit, sessionOffset)
          : [];
      const visibleJobs = args.includeAllScopes
        ? jobs.list(jobLimit, jobOffset)
        : args.scopeId
          ? jobs.listForScope(args.scopeId, jobLimit, jobOffset)
          : [];
      const scopedSessionCount = args.includeAllScopes
        ? sessions.size()
        : args.scopeId
          ? sessions.sizeForScope(args.scopeId)
          : 0;
      const scopedJobCount = args.includeAllScopes
        ? jobs.size
        : args.scopeId
          ? jobs.sizeForScope(args.scopeId)
          : 0;
      const scopedRunningCount = args.includeAllScopes
        ? jobs.runningCount()
        : args.scopeId
          ? jobs.runningCount(args.scopeId)
          : 0;
      const persistencePaths = [sessions.persistencePath, jobs.persistencePath, userSettings.persistencePath];
      const sharedPersistencePath =
        persistencePaths[0] && persistencePaths.every((entry) => entry === persistencePaths[0])
          ? persistencePaths[0]
          : null;
      const persistenceBackend = sharedPersistencePath === config.stateDatabaseFile
        ? "sqlite"
        : persistencePaths.every((entry) => entry === null)
          ? "memory"
          : "split-json";
      return textResult({
        bridge: "codex-mcp-bridge",
        build: BRIDGE_BUILD_INFO,
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
        stateStorage: {
          backend: persistenceBackend,
          persistencePath: sharedPersistencePath,
          transactional: persistenceBackend === "sqlite"
        },
        jobPolicy: {
          persistent: jobs.persistent,
          persistencePath: jobs.persistencePath,
          retentionMs: config.jobTtlMs,
          staleAfterMs: jobs.staleThresholdMs,
          maxStatusWaitMs: MAX_CODEX_STATUS_WAIT_MS,
          defaultStatusWaitMs: DEFAULT_CODEX_STATUS_WAIT_MS
        },
        concurrencyPolicy: {
          sameWorkingDirectory: {
            readOnly: "allowed",
            workspaceWrite: "allowed",
            dangerFullAccess: "allowed"
          },
          sameThread: "serialized",
          sameScopeDifferentThreads: "allowed",
          parallelism: "dynamic-per-thread",
          mutationCoordination: "caller-managed"
        },
        maxPromptChars: config.maxPromptChars,
        sessionPolicy: {
          persistent: sessions.persistent,
          persistencePath: sessions.persistencePath,
          autoResumeTtlMs: preferences.autoResumeTtlMs,
          selection: "scope-compatible-only-when-unambiguous",
          scopeIdRequiredForTasks: true,
          legacyScopeId: LEGACY_SCOPE_ID,
          legacyAutoResume: false,
          scopeIsAuthentication: false,
          mcpThreadLifetime: "active-upstream-worker-generation",
          restartBehavior: "persist-history-but-start-a-new-thread-on-auto"
        },
        scopeView: args.includeAllScopes
          ? { mode: "all" }
          : args.scopeId
            ? { mode: "scoped", scopeId: args.scopeId }
            : { mode: "policy-only", scopeIdRequiredForDetails: true },
        scopeCounts: {
          sessions: scopedSessionCount,
          jobs: scopedJobCount,
          runningJobs: scopedRunningCount
        },
        pagination: {
          sessions: pageSummary(sessionOffset, sessionLimit, visibleSessions.length, scopedSessionCount),
          jobs: pageSummary(jobOffset, jobLimit, visibleJobs.length, scopedJobCount)
        },
        settingsPolicy: {
          persistent: userSettings.persistent,
          persistencePath: userSettings.persistencePath,
          revision: preferences.revision,
          scope: "shared-bridge-instance",
          warnings: userSettings.loadWarnings
        },
        sessions: visibleSessions.map((session) => ({
          ...session,
          createdAt: new Date(session.createdAt).toISOString(),
          lastUsedAt: new Date(session.lastUsedAt).toISOString(),
          autoResumeEligible:
            now - session.lastUsedAt <= preferences.autoResumeTtlMs &&
            upstream.canResumeThread?.(session.threadId) !== false,
          resumeAvailability:
            upstream.canResumeThread?.(session.threadId) === false
              ? "unavailable-after-worker-restart"
              : upstream.canResumeThread?.(session.threadId) === true
                ? "available"
                : "unknown"
        })),
        jobs: visibleJobs.map((job) => formatJobSummary(job, jobs.staleThresholdMs)),
        upstreamTools,
        upstreamError
      });
    }
  );

  server.registerTool(
    "codex_cancel",
    {
      title: "Cancel Codex Job",
      description:
        "Cancel one running Codex job in the current ChatGPT conversation scope. Cancellation is idempotent, but partial filesystem changes made before cancellation may remain and must be inspected.",
      inputSchema: {
        scopeId: scopeIdSchema().describe("Conversation scope that owns the job."),
        jobId: z.string().trim().min(1).describe("Running job id returned by codex_task.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const existing = jobs.get(args.jobId);
      if (!existing) throw new Error("Unknown Codex job id. Start a job through codex_task first.");
      if (existing.scopeId !== args.scopeId) {
        throw new Error("The requested Codex job belongs to another conversation scope.");
      }
      return textResult(formatJobStatus(jobs.cancel(args.jobId), jobs.staleThresholdMs));
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
        "Run Codex inside one explicit ChatGPT conversation scope. Generate a fresh UUID scopeId once per ChatGPT conversation and reuse it; use a new scope after copying or branching a chat unless the user requests a handoff. Generate one UUID requestId per logical turn and reuse it for retries. A scope may acquire any number of Codex threads over time: use sessionMode='new' when parallel work becomes useful, and use exact threadId values for follow-ups once multiple compatible threads exist. Auto resumes only when the compatible thread inside the scope is unambiguous. Cross-scope continuation requires an exact threadId plus adoptThread=true and explicit user intent.",
      inputSchema: {
        scopeId: scopeIdSchema().describe(
          "Stable UUID for this ChatGPT conversation. Generate once per chat and reuse on every Codex bridge call."
        ),
        requestId: scopeIdSchema().describe(
          "Unique UUID for this logical Codex turn. Reuse the exact value only when retrying the same call."
        ),
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
        adoptThread: z
          .boolean()
          .optional()
          .describe(
            "Move an exact thread from another scope into this one. Use only after the user explicitly requests a cross-chat handoff."
          ),
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
      const routing = resolveTaskRouting(args);
      const replay = jobs.findRequest(routing.scopeId, routing.requestId, routing.requestHash);
      if (replay) return resultForJob(replay, config.jobStaleAfterMs);

      if (args.adoptThread && !args.threadId) {
        throw new Error("adoptThread requires an exact threadId.");
      }
      if (routing.scopeId === LEGACY_SCOPE_ID && (!args.threadId || requestedMode === "new")) {
        throw new Error(
          "The legacy scope cannot start or auto-select sessions. Continue an exact legacy thread or adopt it into a new scope."
        );
      }

      if (requestedMode === "new") {
        if (args.threadId) throw new Error("threadId cannot be used with sessionMode='new'.");
        if (args.adoptThread) throw new Error("adoptThread cannot be used with sessionMode='new'.");
        return startNewSession({
          args,
          routing,
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
          routing,
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
          routing,
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
      await enforceSensitiveFilePreflight(config, cwd, "run Codex");
      const compatible = sessions.findCompatible(
        {
          scopeId: routing.scopeId,
          cwd,
          sandbox,
          ...selection
        },
        preferences.autoResumeTtlMs
      ).filter((session) => upstream.canResumeThread?.(session.threadId) !== false);
      if (compatible.length > 1) {
        const candidates = compatible
          .slice(0, 10)
          .map((session) => session.threadId)
          .join(", ");
        throw new Error(
          `Multiple compatible Codex threads exist in this conversation scope (${candidates}). Call codex_status with scopeId and retry with an exact threadId, or use sessionMode='new' to start another thread.`
        );
      }
      const recent = compatible[0];
      if (recent && jobs.isThreadActive(recent.threadId)) {
        throw new Error(
          "The compatible Codex thread in this conversation scope is busy. Wait for it, or use sessionMode='new' to start parallel work on another thread."
        );
      }
      if (recent) {
        return continueTrackedSession({
          prompt: args.prompt,
          timeoutMs: args.timeoutMs,
          requestedMode,
          reason: "recent-compatible",
          session: recent,
          routing,
          config,
          upstream,
          sessions,
          jobs,
          requestedSandbox: effectiveContinuationSandbox(preferences, args.sandbox as SandboxMode | undefined),
          preferences,
          preflightDone: true,
          rejectIfSelectionActive: true
        });
      }

      return startNewSession({
        args,
        routing,
        requestedMode,
        reason: "no-compatible-session",
        config,
        upstream,
        sessions,
        jobs,
        modelCatalog,
        preferences,
        resolved: { cwd, sandbox, selection },
        preflightDone: true,
        rejectIfSelectionActive: true
      });
    }
  );
}

type CodexTaskArgs = {
  scopeId: string;
  requestId: string;
  prompt: string;
  sessionMode?: SessionMode;
  threadId?: string;
  adoptThread?: boolean;
  cwd?: string;
  sandbox?: SandboxMode;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
};

async function startNewSession(input: {
  args: CodexTaskArgs;
  routing: CodexRouting;
  requestedMode: SessionMode;
  reason: SessionDecision["reason"];
  config: BridgeConfig;
  upstream: CodexUpstream;
  sessions: SessionRegistry;
  jobs: CodexJobRegistry;
  modelCatalog: CodexModelCatalogProvider;
  preferences: BridgeUserSettings;
  resolved?: { cwd: string; sandbox: SandboxMode; selection: ResolvedModelSelection };
  preflightDone?: boolean;
  rejectIfSelectionActive?: boolean;
}): Promise<ToolResult> {
  const cwd = input.resolved?.cwd || resolveTaskCwd(input.config, input.preferences, input.args.cwd);
  const sandbox =
    input.resolved?.sandbox || resolveTaskSandbox(input.config, input.preferences, input.args.sandbox);
  const selection =
    input.resolved?.selection ||
    (await resolveModelSelection(input.modelCatalog, ...modelSelectionTuple(input.args, input.preferences)));
  const timeoutMs = input.args.timeoutMs || input.preferences.taskTimeoutMs;
  if (!input.preflightDone) await enforceSensitiveFilePreflight(input.config, cwd, "run Codex");

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
    routing: input.routing,
    selectionKey: selectionKeyFor(input.routing.scopeId, cwd, sandbox, selection),
    rejectIfSelectionActive: input.rejectIfSelectionActive,
    sessionDecision: decision,
    run: (onProgress, signal) => input.upstream.callTool("codex", payload, timeoutMs, onProgress, signal),
    onComplete: (result) => {
      const threadId = extractThreadId(result);
      if (!threadId) return;
      const previous = input.sessions.get(threadId);
      decision.threadId = threadId;
      const now = Date.now();
      input.sessions.record({
        threadId,
        scopeId: input.routing.scopeId,
        cwd,
        sandbox,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        createdAt: now,
        lastUsedAt: now
      });
      return () => {
        delete decision.threadId;
        input.sessions.restoreInMemory(threadId, previous);
      };
    }
  });
}

async function continueSession(input: {
  args: CodexTaskArgs;
  routing: CodexRouting;
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
  if (input.upstream.canResumeThread?.(session.threadId) === false) {
    throw new Error(
      "The selected Codex thread belongs to an earlier MCP worker generation and cannot be resumed. Use sessionMode='new' to start a new thread."
    );
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
  const adopting = session.scopeId !== input.routing.scopeId;
  if (adopting) {
    if (!input.args.adoptThread) {
      throw new Error(
        "The selected Codex thread belongs to another conversation scope. Use adoptThread=true only after the user explicitly requests a handoff."
      );
    }
    if (input.jobs.isThreadActive(session.threadId)) {
      throw new Error("A running Codex thread cannot be adopted into another conversation scope.");
    }
  } else if (input.args.adoptThread) {
    throw new Error("adoptThread is unnecessary because the thread already belongs to this conversation scope.");
  }
  return continueTrackedSession({
    prompt: input.args.prompt,
    timeoutMs: input.args.timeoutMs,
    requestedMode: input.requestedMode,
    reason: input.reason,
    session,
    routing: input.routing,
    config: input.config,
    upstream: input.upstream,
    sessions: input.sessions,
    jobs: input.jobs,
    requestedSandbox: effectiveContinuationSandbox(input.preferences, input.args.sandbox),
    preferences: input.preferences,
    adoptOnComplete: adopting
  });
}

async function continueTrackedSession(input: {
  prompt: string;
  timeoutMs?: number;
  requestedMode: SessionMode;
  reason: SessionDecision["reason"];
  session: TrackedCodexSession;
  routing: CodexRouting;
  config: BridgeConfig;
  upstream: CodexUpstream;
  sessions: SessionRegistry;
  jobs: CodexJobRegistry;
  requestedSandbox?: SandboxMode;
  preferences: BridgeUserSettings;
  adoptOnComplete?: boolean;
  preflightDone?: boolean;
  rejectIfSelectionActive?: boolean;
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
  if (!input.preflightDone) {
    await enforceSensitiveFilePreflight(input.config, currentCwd, "continue Codex");
  }
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
    routing: input.routing,
    selectionKey: selectionKeyFor(input.routing.scopeId, input.session.cwd, input.session.sandbox, {
      model: input.session.model,
      reasoningEffort: input.session.reasoningEffort
    }),
    rejectIfSelectionActive: input.rejectIfSelectionActive,
    sessionDecision: decision,
    exclusiveKeys: [threadExclusiveKey(input.session.threadId)],
    run: (onProgress, signal) =>
      input.upstream.callTool(
        "codex-reply",
        { threadId: input.session.threadId, prompt: input.prompt },
        timeoutMs,
        onProgress,
        signal
      ),
    onComplete: () => {
      const previous = input.sessions.get(input.session.threadId);
      if (input.adoptOnComplete) {
        input.sessions.adopt(input.session.threadId, input.routing.scopeId);
      } else {
        input.sessions.touch(input.session.threadId);
      }
      return () => input.sessions.restoreInMemory(input.session.threadId, previous);
    }
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
  routing: CodexRouting;
  sessionDecision: SessionDecision;
  selectionKey: string;
  rejectIfSelectionActive?: boolean;
  exclusiveKeys?: string[];
  run: (onProgress: (progress: Progress) => void, signal: AbortSignal) => Promise<ToolResult>;
  onComplete?: (result: ToolResult) => void | (() => void);
}): Promise<ToolResult> {
  const job = input.jobs.start(
    {
      operation: input.operation,
      cwd: input.cwd,
      sandbox: input.sandbox,
      scopeId: input.routing.scopeId,
      requestId: input.routing.requestId,
      requestHash: input.routing.requestHash,
      requestHashVersion: 2,
      selectionKey: input.selectionKey,
      exclusiveKeys: input.exclusiveKeys || [],
      sessionDecision: input.sessionDecision
    },
    input.run,
    input.onComplete,
    input.preferences.maxConcurrentJobs,
    input.rejectIfSelectionActive
  );
  const fastReturnMs = Math.min(input.config.fastReturnMs, input.timeoutMs);
  const state = await Promise.race([
    job.promise.then(() => "settled" as const),
    delay(fastReturnMs).then(() => "running" as const)
  ]);
  if (state === "running") {
    return textResult(formatJobStatus(job, input.config.jobStaleAfterMs));
  }
  if (job.status === "completed" && job.result) return forwardResult(job.result, job);
  throw new Error(job.error || "Codex job failed.");
}

function resultForJob(job: CodexJob, staleAfterMs: number): ToolResult {
  if (job.status === "completed" && job.result) return forwardResult(job.result, job);
  return textResult(formatJobStatus(job, staleAfterMs));
}

function pageSummary(offset: number, limit: number, returned: number, total: number) {
  return {
    offset,
    limit,
    returned,
    total,
    hasMore: offset + returned < total,
    nextOffset: offset + returned < total ? offset + returned : null
  };
}

function formatJobStatus(
  job: CodexJob,
  staleAfterMs: number,
  wait?: CodexJobWaitResult
): Record<string, unknown> {
  const activity = formatJobActivity(job, staleAfterMs);
  const common = {
    status: job.status,
    terminal: job.status !== "running",
    jobId: job.jobId,
    version: job.version,
    operation: job.operation,
    cwd: job.cwd,
    sandbox: job.sandbox,
    scopeId: job.scopeId,
    requestId: job.requestId,
    session: job.sessionDecision,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    cancelRequestedAt: job.cancelRequestedAt ? new Date(job.cancelRequestedAt).toISOString() : null,
    ageMs: Math.max(0, Date.now() - job.createdAt),
    ...activity,
    ...(wait
      ? {
          wait: {
            waitFor: wait.waitFor,
            waitedMs: wait.waitedMs,
            timedOut: wait.waitTimedOut,
            changed: wait.changed
          }
        }
      : {})
  };
  if (job.status === "running") {
    return {
      ...common,
      nextCheck: {
        tool: "codex_status",
        arguments: {
          scopeId: job.scopeId,
          jobId: job.jobId,
          waitFor: "terminal",
          waitMs: DEFAULT_CODEX_STATUS_WAIT_MS
        }
      },
      message:
        activity.health === "no-progress-observed"
          ? "No MCP progress event has been observed within the configured window. Process liveness is unknown; inspect actual work evidence, wait, or explicitly cancel the job."
          : "Codex is still running. For outcome-oriented work, keep the request open and wait through codex_status; do not report completion yet."
    };
  }
  if (job.status === "failed" || job.status === "interrupted" || job.status === "cancelled") {
    return {
      ...common,
      error:
        job.error ||
        (job.status === "interrupted"
          ? "The Codex job was interrupted before completion."
          : job.status === "cancelled"
            ? "The Codex job was cancelled. Partial filesystem changes may remain."
          : "Codex job failed.")
    };
  }
  return {
    ...common,
    result: job.result,
    resultBytes: job.resultBytes,
    resultOmitted: job.resultOmitted || false,
    message:
      "Codex reached a completed state. Inspect the result and verify the requested outcome and relevant artifacts before reporting completion."
  };
}

function formatJobSummary(job: CodexJob, staleAfterMs: number): Record<string, unknown> {
  return {
    jobId: job.jobId,
    status: job.status,
    operation: job.operation,
    cwd: job.cwd,
    sandbox: job.sandbox,
    scopeId: job.scopeId,
    requestId: job.requestId,
    session: job.sessionDecision,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    version: job.version,
    terminal: job.status !== "running",
    ...formatJobActivity(job, staleAfterMs),
    resultBytes: job.resultBytes,
    resultOmitted: job.resultOmitted || false,
    ...(job.status === "failed" || job.status === "interrupted" || job.status === "cancelled"
      ? { error: job.error }
      : {})
  };
}

function formatJobActivity(
  job: CodexJob,
  staleAfterMs: number
): {
  health: "running" | "no-progress-observed" | "terminal";
  processLiveness: "unknown";
  lastProgressAt: string;
  idleMs: number;
  progressObserved: boolean;
  lastProgress?: Progress;
  staleAfterMs: number;
} {
  const idleMs = Math.max(0, Date.now() - job.lastProgressAt);
  return {
    health:
      job.status !== "running"
        ? "terminal"
        : idleMs >= staleAfterMs
          ? "no-progress-observed"
          : "running",
    processLiveness: "unknown",
    lastProgressAt: new Date(job.lastProgressAt).toISOString(),
    idleMs,
    progressObserved: Boolean(job.lastProgress),
    ...(job.lastProgress ? { lastProgress: job.lastProgress } : {}),
    staleAfterMs
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function threadExclusiveKey(threadId: string): string {
  return `thread:${threadId}`;
}

function selectionKeyFor(
  scopeId: string,
  cwd: string,
  sandbox: SandboxMode,
  selection: ResolvedModelSelection
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        scopeId,
        cwd,
        sandbox,
        model: selection.model || null,
        reasoningEffort: selection.reasoningEffort || null
      })
    )
    .digest("hex");
}

function scopeIdSchema() {
  return z
    .string()
    .trim()
    .regex(SCOPE_ID_PATTERN, "Expected a UUID-formatted conversation or request id.")
    .transform((value) => value.toLowerCase());
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

function resolveTaskRouting(args: CodexTaskArgs): CodexRouting {
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        scopeId: args.scopeId,
        sessionMode: args.sessionMode || null,
        prompt: args.prompt,
        threadId: args.threadId || null,
        adoptThread: args.adoptThread || false,
        cwd: args.cwd || null,
        sandbox: args.sandbox || null,
        model: args.model || null,
        reasoningEffort: args.reasoningEffort || null,
        timeoutMs: args.timeoutMs || null
      })
    )
    .digest("hex");
  return {
    scopeId: args.scopeId,
    requestId: args.requestId,
    requestHash
  };
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
    warnings: userSettings.loadWarnings,
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
            warnings: view.warnings,
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

function sanitizeProgress(progress: Progress): Progress {
  return {
    progress: Number.isFinite(progress.progress) ? progress.progress : 0,
    ...(typeof progress.total === "number" && Number.isFinite(progress.total)
      ? { total: progress.total }
      : {}),
    ...(typeof progress.message === "string" ? { message: progress.message.slice(0, 500) } : {})
  };
}

function readPersistedJob(value: unknown, stateVersion: 1 | 2 | 3 | 4): PersistedCodexJob | undefined {
  if (!isRecord(value)) return undefined;
  const operation = value.operation;
  const sandbox = value.sandbox;
  const status = value.status;
  const sessionDecision = readSessionDecision(value.sessionDecision);
  const lastProgress = readProgress(value.lastProgress);
  const scopeId = stateVersion === 1 ? LEGACY_SCOPE_ID : value.scopeId;
  const requestId = stateVersion === 1 ? `legacy:${String(value.jobId || "unknown")}` : value.requestId;
  const requestHash = stateVersion === 1
    ? createHash("sha256").update(String(requestId)).digest("hex")
    : value.requestHash;
  const requestHashVersion = stateVersion === 4 ? value.requestHashVersion : 1;
  if (
    typeof value.jobId !== "string" ||
    !value.jobId ||
    (operation !== "start" && operation !== "continue") ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isTimestamp(value.lastProgressAt) ||
    !Number.isInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.cwd !== "string" ||
    !path.isAbsolute(value.cwd) ||
    path.normalize(value.cwd) !== value.cwd ||
    (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") ||
    typeof scopeId !== "string" ||
    !SCOPE_ID_PATTERN.test(scopeId) ||
    typeof requestId !== "string" ||
    !requestId ||
    typeof requestHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(requestHash) ||
    (requestHashVersion !== 1 && requestHashVersion !== 2) ||
    !isOptionalString(value.selectionKey) ||
    !Array.isArray(value.exclusiveKeys) ||
    !value.exclusiveKeys.every((entry) => typeof entry === "string") ||
    !sessionDecision ||
    (status !== "running" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "interrupted" &&
      status !== "cancelled") ||
    !isOptionalFiniteNumber(value.resultBytes) ||
    !isOptionalBoolean(value.resultOmitted) ||
    !isOptionalFiniteNumber(value.cancelRequestedAt) ||
    !isOptionalString(value.error) ||
    (value.result !== undefined && !isRecord(value.result)) ||
    (value.lastProgress !== undefined && !lastProgress)
  ) {
    return undefined;
  }
  return {
    jobId: value.jobId,
    operation,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastProgressAt: value.lastProgressAt,
    version: value.version as number,
    cwd: value.cwd,
    sandbox,
    scopeId: scopeId.toLowerCase(),
    requestId,
    requestHash,
    requestHashVersion,
    selectionKey: value.selectionKey,
    exclusiveKeys: [...value.exclusiveKeys],
    sessionDecision,
    status,
    result: value.result as ToolResult | undefined,
    resultBytes: value.resultBytes,
    resultOmitted: value.resultOmitted,
    lastProgress,
    cancelRequestedAt: value.cancelRequestedAt,
    error: value.error
  };
}

function readSessionDecision(value: unknown): SessionDecision | undefined {
  if (!isRecord(value)) return undefined;
  const requestedMode = value.requestedMode;
  const action = value.action;
  const reason = value.reason;
  if (
    (requestedMode !== "auto" && requestedMode !== "new" && requestedMode !== "continue") ||
    (action !== "start" && action !== "continue") ||
    (reason !== "explicit-new" &&
      reason !== "explicit-thread" &&
      reason !== "recent-compatible" &&
      reason !== "compatible-session-busy" &&
      reason !== "no-compatible-session") ||
    !isOptionalString(value.threadId)
  ) {
    return undefined;
  }
  return {
    requestedMode,
    action,
    reason,
    threadId: value.threadId
  };
}

function readProgress(value: unknown): Progress | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.progress !== "number" ||
    !Number.isFinite(value.progress) ||
    !isOptionalFiniteNumber(value.total) ||
    !isOptionalString(value.message)
  ) {
    return undefined;
  }
  return sanitizeProgress({
    progress: value.progress,
    total: value.total,
    message: value.message
  });
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function toolResultErrorMessage(result: ToolResult): string {
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      const message = item.text.trim();
      if (message) return message.slice(0, 4_000);
    }
  }
  return "Codex upstream returned an error tool result.";
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

function forwardResult(result: ToolResult, job: CodexJob): ToolResult {
  const forwarded = Array.isArray(result.content) ? result : textResult(result);
  const structured = isRecord((forwarded as { structuredContent?: unknown }).structuredContent)
    ? (forwarded as { structuredContent: Record<string, unknown> }).structuredContent
    : {};
  return {
    ...forwarded,
    structuredContent: {
      ...structured,
      threadId: extractThreadId(forwarded) || job.sessionDecision.threadId,
      bridgeSession: {
        ...job.sessionDecision,
        scopeId: job.scopeId,
        requestId: job.requestId
      }
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
