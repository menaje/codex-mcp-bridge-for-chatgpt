import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type {
  OperationalStateCommand,
  OperationalStateResult,
  OperationalStateService
} from "./stateService.js";

export const STATE_MAINTENANCE_SLICES = [
  "events",
  "history",
  "questions",
  "recovery",
  "receipts",
  "jobs"
] as const;

export type StateMaintenanceSlice = (typeof STATE_MAINTENANCE_SLICES)[number];
export type StateMaintenanceObservation = {
  slice: StateMaintenanceSlice;
  startedAt: number;
  durationMs: number;
  changed: number;
  failed: boolean;
  deferred: boolean;
};

/**
 * Runs one bounded storage concern at a time. It deliberately owns a timer
 * independent of thread release and automatic recovery controllers, so a
 * connection lifecycle cannot accidentally become the database GC clock.
 */
export class StateMaintenanceScheduler {
  lastError?: string;
  private timer?: NodeJS.Timeout;
  private pending = false;
  private closed = false;
  private cursor = 0;
  private deferredSince?: number;
  private readonly uncertainCommands = new Map<
    StateMaintenanceSlice,
    { commandId: string; command: OperationalStateCommand }
  >();
  private readonly observations: StateMaintenanceObservation[] = [];

  constructor(
    private readonly stateService: OperationalStateService,
    private readonly options: {
      intervalMs?: number;
      now?: () => number;
      changed?: () => void;
      shouldDefer?: () => boolean;
      maxDeferMs?: number;
      command?: (slice: StateMaintenanceSlice) => OperationalStateCommand;
      completed?: (
        command: OperationalStateCommand,
        result: OperationalStateResult
      ) => void;
    } = {}
  ) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, this.options.intervalMs ?? 5_000);
    this.timer.unref();
    void this.sweep();
  }

  async sweep(slice?: StateMaintenanceSlice): Promise<StateMaintenanceObservation | undefined> {
    if (this.closed || this.pending) return;
    this.pending = true;
    const selected = slice || STATE_MAINTENANCE_SLICES[this.cursor % STATE_MAINTENANCE_SLICES.length]!;
    const startedAt = (this.options.now || Date.now)();
    const maxDeferMs = this.options.maxDeferMs === undefined
      ? undefined
      : Math.max(0, this.options.maxDeferMs);
    if (!slice && this.options.shouldDefer?.()) {
      this.deferredSince ??= startedAt;
      if (maxDeferMs === undefined || startedAt - this.deferredSince < maxDeferMs) {
        this.pending = false;
        return this.record({
          slice: selected,
          startedAt,
          durationMs: 0,
          changed: 0,
          failed: false,
          deferred: true
        });
      }
    }
    if (!slice) {
      this.deferredSince = undefined;
      this.cursor++;
    }
    const started = performance.now();
    let changed = 0;
    let failed = false;
    const uncertain = this.uncertainCommands.get(selected);
    const commandId = uncertain?.commandId ?? randomUUID();
    const wasUncertain = uncertain !== undefined;
    let command = uncertain?.command;
    let committed = false;
    try {
      command ||= this.options.command?.(selected) ?? defaultMaintenanceCommand(selected);
      const result = await this.stateService.execute(
        command,
        { commandId, aggregateKey: `maintenance:${selected}` }
      );
      committed = true;
      this.options.completed?.(command, result);
      changed = result.changed;
      this.uncertainCommands.delete(selected);
      this.lastError = undefined;
      if (changed > 0) this.options.changed?.();
    } catch (error) {
      failed = true;
      if (
        command &&
        (wasUncertain || committed || stateProcessErrorCode(error) === "STATE_OUTCOME_UNKNOWN")
      ) {
        this.uncertainCommands.set(selected, { commandId, command });
      } else {
        this.uncertainCommands.delete(selected);
      }
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.pending = false;
    }
    const observation = {
      slice: selected,
      startedAt,
      durationMs: Math.max(0, performance.now() - started),
      changed,
      failed,
      deferred: false
    };
    return this.record(observation);
  }

  diagnostics(): readonly StateMaintenanceObservation[] {
    return this.observations;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private record(observation: StateMaintenanceObservation): StateMaintenanceObservation {
    this.observations.push(observation);
    if (this.observations.length > 120) this.observations.shift();
    return observation;
  }
}

function defaultMaintenanceCommand(slice: StateMaintenanceSlice): OperationalStateCommand {
  if (slice === "jobs") {
    throw new Error("STATE_JOB_RETENTION_PLAN_REQUIRED: Job retention requires a bounded registry plan.");
  }
  return { operation: "maintain", slice };
}

function stateProcessErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
