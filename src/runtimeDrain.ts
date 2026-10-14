import * as z from "zod/v4";
import { initialStartupContext } from "../scripts/runtime-status.mjs";
import { INITIAL_START_CLEANUP_MS } from "./runtimeLifecycle.js";

export const runtimeDrainTargetSchema = z.strictObject({
  launcherPid: z.number().int().positive(), token: z.string().uuid(),
  requestId: z.string().uuid(), attempt: z.number().int().min(1).max(3),
  deadlineAt: z.number().int().positive()
});
export type RuntimeDrainTarget = z.infer<typeof runtimeDrainTargetSchema>;
type Binding = Readonly<RuntimeDrainTarget>;

/** Captured once in the state-owner, from the launcher's inherited context. */
export function initialRuntimeDrainBinding(environment = process.env): Binding | null {
  const context = initialStartupContext(environment);
  const launcherPid = Number(environment.CODEX_MCP_BRIDGE_INITIAL_START_LAUNCHER_PID);
  if (!context || !Number.isSafeInteger(launcherPid) || launcherPid <= 0) return null;
  return Object.freeze({ ...context, launcherPid, deadlineAt: context.deadlineAt + INITIAL_START_CLEANUP_MS });
}

function sameTarget(a: RuntimeDrainTarget, b: RuntimeDrainTarget): boolean {
  return a.launcherPid === b.launcherPid && a.token === b.token &&
    a.requestId === b.requestId && a.attempt === b.attempt;
}

/** Shares the existing Job admission gate; check and mutation have no await. */
export class RuntimeDrainGate {
  private owner?: RuntimeDrainTarget;
  /** Cancelled or superseded initial target: a delayed begin cannot revive it. */
  private cancelled?: RuntimeDrainTarget;
  private readonly binding: Binding | null;
  constructor(private readonly admission: { acceptingNewJobs: boolean }, binding: Binding | null,
    private readonly now = Date.now) {
    this.binding = binding ? Object.freeze({ ...binding }) : null;
  }
  private validate(target: RuntimeDrainTarget): RuntimeDrainTarget {
    const parsed = runtimeDrainTargetSchema.parse(target);
    if (!this.binding || !sameTarget(this.binding, parsed)) throw new Error("RUNTIME_DRAIN_TARGET_CHANGED");
    const deadline = Math.min(parsed.deadlineAt, this.owner?.deadlineAt ?? Infinity, this.cancelled?.deadlineAt ?? Infinity);
    if (parsed.deadlineAt > this.binding.deadlineAt || this.now() >= deadline) throw new Error("RUNTIME_DRAIN_DEADLINE");
    return { ...parsed, deadlineAt: deadline };
  }
  begin(target?: RuntimeDrainTarget): void {
    if (!target) {
      // A later ordinary stop/drain/force/handoff now owns the closed gate.
      // Retire A before clearing its ownership, including a delayed A begin
      // that has not arrived yet. An old cancel cannot release this new drain.
      const retired = this.owner ?? this.cancelled ?? this.binding;
      if (retired) this.cancelled = { ...retired };
      this.owner = undefined;
      this.admission.acceptingNewJobs = false;
      return;
    }
    const checked = this.validate(target);
    if (this.cancelled && sameTarget(this.cancelled, checked)) throw new Error("RUNTIME_DRAIN_NOT_OWNED");
    if (this.owner ? !sameTarget(this.owner, checked) : !this.admission.acceptingNewJobs) {
      throw new Error("RUNTIME_DRAIN_NOT_OWNED");
    }
    this.owner = checked;
    this.admission.acceptingNewJobs = false;
  }
  cancel(target?: RuntimeDrainTarget): void {
    if (!target) {
      // Without a newer ordinary begin, ordinary cancellation does not own
      // A's active targeted fence. After supersession owner is already clear.
      if (this.owner) throw new Error("RUNTIME_DRAIN_NOT_OWNED");
      this.admission.acceptingNewJobs = true; return;
    }
    const checked = this.validate(target);
    if (this.owner ? !sameTarget(this.owner, checked) : !this.admission.acceptingNewJobs) {
      throw new Error("RUNTIME_DRAIN_NOT_OWNED");
    }
    this.owner = undefined;
    this.cancelled = checked;
    this.admission.acceptingNewJobs = true;
    // Cancellation received before a delayed begin is also a tombstone: the
    // stale begin cannot close this same service after restoration.
  }
}
