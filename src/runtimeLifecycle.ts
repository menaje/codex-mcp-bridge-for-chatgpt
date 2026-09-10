import { createHash } from "node:crypto";
import { readPrivateFile, writePrivateFileAtomic } from "../scripts/managed-file.mjs";
import * as z from "zod/v4";

export const lifecycleConfigurationSchema = z.strictObject({
  apiKey: z.string().max(4096).optional(),
  tunnelId: z.string().max(200).optional(),
  defaultBackend: z.literal("app-server").optional(),
  maximumAccess: z.enum(["read-only", "workspace-write", "full-access"]).optional()
});
export const lifecycleRequestSchema = z.strictObject({
  requestId: z.string().uuid(),
  kind: z.enum(["start", "restart", "stop", "configure", "repair", "shutdown", "mode-switch", "helper-replace"]),
  force: z.boolean().default(false),
  configuration: lifecycleConfigurationSchema.optional(),
  candidateId: z.string().regex(/^setup_[a-f0-9]{24}$/).optional(),
  targetBuildId: z.string().min(1).max(200).optional(),
  replacesRequestId: z.string().uuid().optional(),
  applicationLaunchAt: z.iso.datetime().optional()
}).superRefine((value, context) => {
  if (value.kind === "configure" ? !value.configuration && !value.candidateId : value.configuration || value.candidateId) {
    context.addIssue({ code: "custom", message: "Configuration belongs to a configure request." });
  }
  if (value.kind === "helper-replace" && !value.targetBuildId) {
    context.addIssue({ code: "custom", message: "Helper replacement requires its target build." });
  }
  if (value.configuration && value.candidateId) context.addIssue({ code: "custom", message: "Choose explicit settings or a discovered candidate, not both." });
  if (value.targetBuildId && value.kind !== "helper-replace") context.addIssue({ code: "custom", message: "Only helper replacement has a target build." });
  if (value.applicationLaunchAt && (value.kind !== "start" || value.force || value.replacesRequestId)) {
    context.addIssue({ code: "custom", message: "Application launch only requests a non-replacing, graceful start." });
  }
});
export type LifecycleRequest = z.infer<typeof lifecycleRequestSchema>;
export type LifecycleConfiguration = z.infer<typeof lifecycleConfigurationSchema>;
export type LifecyclePhase = "waiting" | "blocked" | "executing" | "reconnecting" | "handoff-ready" | "handing-off" | "completed" | "cancelled" | "failed";
export type LifecycleReason = { code: string; count?: number };
export type LifecycleSnapshot = {
  requestId: string; kind: LifecycleRequest["kind"]; force: boolean; phase: LifecyclePhase;
  createdAt: string; updatedAt: string; reasons: LifecycleReason[]; error: string | null;
  targetBuildId?: string; targetDescription?: string; cancellable: boolean;
};

const recordSchema = z.object({
  request: lifecycleRequestSchema,
  fingerprint: z.string(),
  // Target material is private. Only targetDescription is projected to clients.
  target: z.record(z.string(), z.unknown()).default({}),
  targetDescription: z.string().optional(),
  phase: z.enum(["waiting", "blocked", "executing", "reconnecting", "handoff-ready", "handing-off", "completed", "cancelled", "failed"]),
  createdAt: z.string(), updatedAt: z.string(),
  reasons: z.array(z.object({ code: z.string(), count: z.number().optional() })),
  error: z.string().nullable(), beforeRun: z.string().nullable(),
  // Old RPC callers retain their bounded attempt contract, using this same coordinator.
  deadlineAt: z.number().optional()
});
export type LifecycleRecord = z.infer<typeof recordSchema>;
const stateSchema = z.object({ version: z.literal(1), records: z.array(recordSchema) });
export type LifecycleInspection = { run: string | null; reasons: LifecycleReason[] };
export type LifecycleRecoveryAction = "activate-helper";
export type LifecycleReconciliation = "completed" | "handoff-ready" | "retry" | LifecycleRecoveryAction;
export interface LifecycleDriver {
  prepare(request: LifecycleRequest): Promise<{ request: LifecycleRequest; target: Record<string, unknown>; description?: string }>;
  inspect(record: LifecycleRecord): Promise<LifecycleInspection>;
  execute(record: LifecycleRecord, phase: (phase: "executing" | "reconnecting") => void, recoveryAction?: LifecycleRecoveryAction): Promise<"completed" | "handoff-ready">;
  // Observe only. Any recovered side effect must pass the coordinator's
  // cancellation check and persisted execution claim before execute is called.
  reconcile(record: LifecycleRecord): Promise<LifecycleReconciliation>;
  changed(): void;
  error(error: unknown): string;
  watch?(changed: () => void, signal: AbortSignal): Promise<void>;
}

const terminal = (phase: LifecyclePhase) => ["completed", "cancelled", "failed"].includes(phase);
const cancellable = (phase: LifecyclePhase) => ["waiting", "blocked", "handoff-ready"].includes(phase);
const handoffKinds = new Set<LifecycleRequest["kind"]>(["shutdown", "mode-switch", "helper-replace"]);
export const isLifecycleHandoff = (kind: LifecycleRequest["kind"]) => handoffKinds.has(kind);

/** Owns intent independently of a socket or window. Events invalidate observations;
 * only a fresh inspection and the driver's final admission fence allow execution. */
export class RuntimeLifecycleCoordinator {
  private records: LifecycleRecord[];
  private revision = 0;
  private submission: Promise<unknown> = Promise.resolve();
  private evaluation?: Promise<void>;
  private reevaluate = false;
  private timer?: NodeJS.Timeout;
  private watcher?: AbortController;
  private recovery = new Set<string>();
  private closed = false;

  constructor(private readonly file: string, private readonly driver: LifecycleDriver,
    private readonly options: { intervalMs?: number; now?: () => number } = {}) {
    try {
      this.records = stateSchema.parse(JSON.parse(readPrivateFile(file, { encoding: "utf8" }))).records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.records = [];
    }
    for (const record of this.records) if (!terminal(record.phase)) this.recovery.add(record.request.requestId);
  }

  get active(): LifecycleSnapshot | null {
    const record = [...this.records].reverse().find(record => !terminal(record.phase));
    return record ? this.project(record) : null;
  }
  get latest(): LifecycleSnapshot | null { return this.records.length ? this.project(this.records.at(-1)!) : null; }
  snapshot(requestId?: string): LifecycleSnapshot | null {
    const record = requestId ? this.records.find(record => record.request.requestId === requestId) : this.records.at(-1);
    return record ? this.project(record) : null;
  }

  async submit(input: LifecycleRequest, deadlineMs?: number): Promise<LifecycleSnapshot> {
    const request = lifecycleRequestSchema.parse(input);
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const operation = this.submission.then(async () => {
      if (this.closed) throw new Error("LIFECYCLE_CLOSED: The helper is shutting down.");
      const existing = this.records.find(record => record.request.requestId === request.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("LIFECYCLE_ID_CONFLICT: This request ID already belongs to another operation.");
        return this.project(existing);
      }
      const active = [...this.records].reverse().find(record => !terminal(record.phase));
      if (request.applicationLaunchAt) {
        const latest = this.records.at(-1);
        if (latest) {
          const launchedAt = Date.parse(request.applicationLaunchAt);
          const priorShutdownCompleted = latest.request.kind === "shutdown" && latest.phase === "completed" &&
            Date.parse(latest.createdAt) < launchedAt;
          // A new app launch may start after yesterday's completed stop/shutdown.
          // It must never override pending work, a newer user command, or a
          // cancellation/failure encountered while recovering this launch.
          if (active || latest.request.kind === "mode-switch" ||
              Date.parse(latest.createdAt) >= launchedAt ||
              (Date.parse(latest.updatedAt) >= launchedAt && !priorShutdownCompleted)) {
            return this.project(active ?? latest);
          }
        }
      }
      if (active && (request.replacesRequestId !== active.request.requestId || !cancellable(active.phase))) {
        throw new Error("LIFECYCLE_BUSY: Cancel or replace the current reservation before submitting another operation.");
      }
      if (!active && request.replacesRequestId) throw new Error("LIFECYCLE_STALE: The reservation to replace is no longer pending.");
      // Resolve credentials and freeze configuration/CLI identity before accepting intent.
      const prepared = await this.driver.prepare(request);
      if (this.closed) throw new Error("LIFECYCLE_CLOSED: The helper is shutting down.");
      if (active && (!cancellable(active.phase) || terminal(active.phase))) throw new Error("LIFECYCLE_STALE: The reservation changed while preparing its replacement.");
      const now = this.now();
      const record: LifecycleRecord = {
        request: prepared.request, fingerprint, target: prepared.target, targetDescription: prepared.description,
        phase: "waiting", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
        reasons: [], error: null, beforeRun: null,
        ...(deadlineMs !== undefined ? { deadlineAt: now + deadlineMs } : {})
      };
      const previous = this.records.map(item => ({ ...item }));
      if (active) { active.phase = "cancelled"; active.updatedAt = record.createdAt; active.reasons = []; }
      this.records.push(record);
      try { this.persist(); } catch (error) { this.records = previous; throw error; }
      this.driver.changed();
      this.resume();
      return this.project(record);
    });
    this.submission = operation.catch(() => undefined);
    return operation;
  }

  cancel(requestId: string): LifecycleSnapshot {
    if (this.closed) throw new Error("LIFECYCLE_CLOSED: The helper is shutting down.");
    const record = this.records.find(item => item.request.requestId === requestId);
    if (!record) throw new Error("LIFECYCLE_UNKNOWN: This reservation no longer exists.");
    if (record.phase === "cancelled") return this.project(record);
    if (!cancellable(record.phase)) throw new Error("LIFECYCLE_NOT_CANCELLABLE: The operation has already begun or finished.");
    // A prepared handoff has already stopped the runtime; cancellation does not restart it.
    this.transition(record, "cancelled", [], null);
    this.stopWatchingIfIdle();
    return this.project(record);
  }

  acknowledge(requestId: string): LifecycleSnapshot {
    if (this.closed) throw new Error("LIFECYCLE_CLOSED: The helper is shutting down.");
    const record = this.records.find(item => item.request.requestId === requestId);
    if (!record) throw new Error("LIFECYCLE_UNKNOWN: This reservation no longer exists.");
    if (["completed", "handing-off"].includes(record.phase)) return this.project(record);
    if (record.phase !== "handoff-ready") throw new Error("LIFECYCLE_NOT_READY: Shutdown preparation has not completed.");
    // Acceptance is not completion. The owner verifies the external action and
    // writes a private receipt; recovery reconciles that receipt with live state.
    this.transition(record, "handing-off", [], null);
    this.signal();
    return this.project(record);
  }

  completeLegacyHandoff(requestId: string): void {
    const record = this.records.find(item => item.request.requestId === requestId);
    if (!record || record.deadlineAt === undefined || record.phase !== "handoff-ready") throw new Error("LIFECYCLE_NOT_READY");
    this.transition(record, "completed", [], null);
    this.stopWatchingIfIdle();
  }

  resume(): void {
    if (this.closed || !this.active) return;
    if (!this.timer) {
      this.timer = setInterval(() => this.signal(), this.options.intervalMs ?? 5000);
      this.timer.unref();
    }
    this.startWatching();
    this.signal();
  }

  private startWatching(): void {
    if (!this.closed && !this.watcher && this.driver.watch && ["waiting", "blocked"].includes(this.active?.phase || "")) {
      const watcher = this.watcher = new AbortController();
      void this.driver.watch(() => this.signal(), watcher.signal).catch(() => undefined).finally(() => {
        if (this.watcher === watcher) this.watcher = undefined;
      });
    }
  }

  signal(): void {
    if (this.closed) return;
    this.reevaluate = true;
    if (this.evaluation) return;
    this.evaluation = (async () => {
      while (this.reevaluate && !this.closed) {
        this.reevaluate = false;
        await this.evaluate();
      }
    })().catch(() => undefined).finally(() => {
      this.evaluation = undefined;
      this.stopWatchingIfIdle();
    });
  }

  async settled(): Promise<void> { await this.submission; await this.evaluation; }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.watcher?.abort();
    this.watcher = undefined;
    await this.settled();
  }

  private async evaluate(): Promise<void> {
    const record = [...this.records].reverse().find(item => !terminal(item.phase));
    if (!record) return;
    const revision = this.revision;
    const current = () => !this.closed && revision === this.revision && !terminal(record.phase);
    try {
      if (this.recovery.has(record.request.requestId) || ["handoff-ready", "handing-off"].includes(record.phase)) {
        const result = await this.driver.reconcile(record);
        if (!current()) return;
        this.recovery.delete(record.request.requestId);
        if (result === "activate-helper") {
          await this.execute(record, result);
          return;
        }
        if (result !== "retry") { this.transition(record, result, [], null); return; }
        if (["handoff-ready", "handing-off"].includes(record.phase)) return;
        this.transition(record, "waiting", [], null);
        this.startWatching();
        this.signal();
        return;
      }
      if (record.deadlineAt !== undefined && this.now() >= record.deadlineAt) {
        this.transition(record, "failed", [], "DRAIN_TIMEOUT: The bounded legacy attempt expired. Existing work was preserved.");
        return;
      }
      const inspection = await this.driver.inspect(record);
      if (!current()) return;
      if (!record.request.force && inspection.reasons.length) {
        if (record.deadlineAt !== undefined) {
          const legacyErrors: Record<string, string> = {
            "memory-only-threads": "CODEX_MEMORY_THREADS_ACTIVE", "pending-interactions": "CODEX_INTERACTIONS_PENDING",
            "background-processes": "BACKGROUND_PROCESSES_ACTIVE", "background-state-unknown": "BACKGROUND_PROCESS_STATE_UNKNOWN",
            "runtime-unreachable": "CODEX_APPLY_PENDING"
          };
          const blocked = inspection.reasons.find(reason => legacyErrors[reason.code]);
          if (blocked) throw new Error(`${legacyErrors[blocked.code]}: The current runtime was preserved.`);
        }
        if (record.deadlineAt === undefined) {
          const phase = inspection.reasons.some(reason => !["active-jobs", "pending-admissions"].includes(reason.code)) ? "blocked" : "waiting";
          this.transition(record, phase, inspection.reasons, null);
          return;
        }
      }
      record.beforeRun = inspection.run;
      await this.execute(record);
    } catch (error) {
      if (this.closed || terminal(record.phase)) return;
      const message = this.driver.error(error);
      if (/DRAIN_TIMEOUT|BACKGROUND_PROCESS|CODEX_APPLY_PENDING|CODEX_MEMORY_THREADS_ACTIVE|CODEX_INTERACTIONS_PENDING/.test(message)
          && !/DRAIN_CANCEL_FAILED|CONFIG_ROLLBACK_FAILED|CONFIG_ROLLBACK_RESTART_FAILED/.test(message)
          && !record.request.force && record.deadlineAt === undefined) {
        this.transition(record, "blocked", [{ code: "recheck-required" }], message);
        this.startWatching();
      } else {
        this.transition(record, "failed", [], message);
      }
    }
  }

  private async execute(record: LifecycleRecord, recoveryAction?: LifecycleRecoveryAction): Promise<void> {
    // No await between the caller's revision check and this execution claim.
    this.transition(record, "executing", [], null);
    // Do not leave our own long-poll socket holding up companion shutdown.
    this.watcher?.abort();
    this.watcher = undefined;
    const result = await this.driver.execute(record, phase => this.transition(record, phase, [], null), recoveryAction);
    this.transition(record, result, [], null);
  }

  private transition(record: LifecycleRecord, phase: LifecyclePhase, reasons: LifecycleReason[], error: string | null): void {
    if (record.phase === phase && JSON.stringify(record.reasons) === JSON.stringify(reasons) && record.error === error) return;
    const before = { ...record };
    Object.assign(record, { phase, reasons, error, updatedAt: new Date(this.now()).toISOString() });
    try { this.persist(); } catch (failure) { Object.assign(record, before); throw failure; }
    this.driver.changed();
  }
  private persist(): void {
    const records = this.records.map(record => terminal(record.phase) && record.request.configuration
      ? { ...record, request: { ...record.request, configuration: { ...record.request.configuration, apiKey: undefined } } }
      : record);
    writePrivateFileAtomic(this.file, JSON.stringify({ version: 1, records }) + "\n", { encoding: "utf8" });
    this.revision++;
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private project(record: LifecycleRecord): LifecycleSnapshot {
    return {
      requestId: record.request.requestId, kind: record.request.kind, force: record.request.force,
      phase: record.phase, createdAt: record.createdAt, updatedAt: record.updatedAt, reasons: record.reasons.map(reason => ({ ...reason })),
      error: record.error, targetBuildId: record.request.targetBuildId, targetDescription: record.targetDescription,
      cancellable: cancellable(record.phase)
    };
  }
  private stopWatchingIfIdle(): void {
    if (this.active) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.watcher?.abort();
    this.watcher = undefined;
  }
}
