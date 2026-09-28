import { performance } from "node:perf_hooks";

/** Shared planning envelope for non-user work in the state owner. Round trips
 * are conservative charges for synchronous lookups; traceSql audits the actual
 * statement count in scale tests. An awaited external operation starts a new
 * event-loop turn and never extends a synchronous decision slice. */
export type BackgroundWorkLimits = {
  maxTargets: number;
  maxRoundTrips: number;
  maxContinuousMs: number;
  yieldEvery: number;
};

export const RECOVERY_WORK_LIMITS: BackgroundWorkLimits = {
  maxTargets: 16, maxRoundTrips: 384, maxContinuousMs: 25, yieldEvery: 8
};
export const CONNECTION_WORK_LIMITS: BackgroundWorkLimits = {
  maxTargets: 32, maxRoundTrips: 192, maxContinuousMs: 25, yieldEvery: 8
};

export class BackgroundWorkSlice {
  readonly startedAt = performance.now();
  private continuousStartedAt = this.startedAt;
  targets = 0;
  roundTrips = 0;
  constructor(readonly limits: BackgroundWorkLimits) {}

  take(estimatedRoundTrips: number): boolean {
    if (this.targets >= this.limits.maxTargets || !this.reserve(estimatedRoundTrips)) return false;
    this.targets++;
    return true;
  }

  reserve(estimatedRoundTrips: number): boolean {
    if (this.roundTrips + estimatedRoundTrips > this.limits.maxRoundTrips ||
        this.targets > 0 && performance.now() - this.continuousStartedAt >= this.limits.maxContinuousMs) return false;
    this.roundTrips += estimatedRoundTrips;
    return true;
  }

  async yieldIfNeeded(): Promise<void> {
    if (this.targets % this.limits.yieldEvery === 0) {
      await new Promise<void>(resolve => setImmediate(resolve));
      this.continuousStartedAt = performance.now();
    }
  }

  /** Resume on a new event-loop turn, so neither a slow await nor a promise
   * resolved in a microtask can extend a synchronous decision slice. */
  async awaitExternal<T>(operation: Promise<T> | T): Promise<T> {
    try { return await operation; }
    finally {
      await new Promise<void>(resolve => setImmediate(resolve));
      this.continuousStartedAt = performance.now();
    }
  }

  get durationMs(): number { return performance.now() - this.startedAt; }
}
