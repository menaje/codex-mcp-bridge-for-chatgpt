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
  maxTargets: 32, maxRoundTrips: 384, maxContinuousMs: 25, yieldEvery: 8
};
export const CONNECTION_WORK_LIMITS: BackgroundWorkLimits = {
  maxTargets: 32, maxRoundTrips: 192, maxContinuousMs: 25, yieldEvery: 8
};

export class BackgroundWorkSlice {
  readonly startedAt = performance.now();
  targets = 0;
  roundTrips = 0;
  constructor(readonly limits: BackgroundWorkLimits) {}

  take(estimatedRoundTrips: number): boolean {
    if (this.targets >= this.limits.maxTargets ||
        this.roundTrips + estimatedRoundTrips > this.limits.maxRoundTrips ||
        this.targets > 0 && performance.now() - this.startedAt >= this.limits.maxContinuousMs) return false;
    this.targets++;
    this.roundTrips += estimatedRoundTrips;
    return true;
  }

  async yieldIfNeeded(): Promise<void> {
    if (this.targets % this.limits.yieldEvery === 0) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  get durationMs(): number { return performance.now() - this.startedAt; }
}
