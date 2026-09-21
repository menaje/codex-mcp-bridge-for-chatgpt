import { performance } from "node:perf_hooks";
import type { BridgeStateStore } from "./stateStore.js";

export const STATE_MAINTENANCE_SLICES = [
  "events",
  "history",
  "questions",
  "decisions",
  "recovery",
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
  private readonly observations: StateMaintenanceObservation[] = [];

  constructor(
    private readonly store: BridgeStateStore,
    private readonly options: {
      intervalMs?: number;
      now?: () => number;
      maintainJobs?: () => number;
      changed?: () => void;
      shouldDefer?: () => boolean;
      maxDeferMs?: number;
    } = {}
  ) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { this.sweep(); }, this.options.intervalMs ?? 5_000);
    this.timer.unref();
    this.sweep();
  }

  sweep(slice?: StateMaintenanceSlice): StateMaintenanceObservation | undefined {
    if (this.closed || this.pending) return;
    this.pending = true;
    const selected = slice || STATE_MAINTENANCE_SLICES[this.cursor % STATE_MAINTENANCE_SLICES.length]!;
    const startedAt = (this.options.now || Date.now)();
    const maxDeferMs = Math.max(0, this.options.maxDeferMs ?? 60_000);
    if (!slice && this.options.shouldDefer?.()) {
      this.deferredSince ??= startedAt;
      if (startedAt - this.deferredSince < maxDeferMs) {
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
    try {
      changed = this.run(selected);
      this.lastError = undefined;
      if (changed > 0) this.options.changed?.();
    } catch (error) {
      failed = true;
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

  private run(slice: StateMaintenanceSlice): number {
    if (slice === "events") {
      const report = this.store.maintainEventRetention();
      return report.expiredJobEventsRemoved + report.expiredActivityEventsRemoved +
        report.expiredResultHoldsRemoved + report.perJobEventsRemoved + report.budgetEventsRemoved;
    }
    if (slice === "history") return this.store.maintainHistoryRetention().historyRemoved;
    if (slice === "questions") {
      const report = this.store.maintainQuestionRetention();
      return report.expiredQuestionsRemoved + report.deliveredJournalsRemoved +
        report.notificationsMarkedUncertain;
    }
    if (slice === "decisions") {
      const report = this.store.maintainDecisionRetention();
      return report.expiredLeasesMarkedUnknown + report.expiredCardsRemoved;
    }
    if (slice === "recovery") {
      const report = this.store.maintainRecoveryRetention();
      return report.recordsRemoved + report.incidentsRemoved;
    }
    return this.options.maintainJobs?.() || 0;
  }

  private record(observation: StateMaintenanceObservation): StateMaintenanceObservation {
    this.observations.push(observation);
    if (this.observations.length > 120) this.observations.shift();
    return observation;
  }
}
