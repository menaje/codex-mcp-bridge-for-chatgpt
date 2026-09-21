import type { StateMaintenanceSlice } from "./maintenanceScheduler.js";
import type { BridgeStateStore } from "./stateStore.js";

export type OperationalStateCommand = {
  operation: "maintain";
  slice: StateMaintenanceSlice;
};

export type OperationalStateResult = {
  operation: "maintain";
  slice: StateMaintenanceSlice;
  changed: number;
};

/**
 * Semantic asynchronous boundary for authoritative operational state.
 * Callers depend on this contract rather than on a SQLite connection. The
 * initial adapter remains in-process; a child-process implementation can
 * replace it only after every state caller has crossed this boundary.
 */
export interface OperationalStateService {
  execute(command: OperationalStateCommand): Promise<OperationalStateResult>;
}

export class InProcessOperationalStateService implements OperationalStateService {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: BridgeStateStore,
    private readonly options: { maintainJobs?: () => number } = {}
  ) {}

  execute(command: OperationalStateCommand): Promise<OperationalStateResult> {
    const execute = () => this.run(command);
    const result = this.tail.then(execute, execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private run(command: OperationalStateCommand): OperationalStateResult {
    const changed = this.runMaintenance(command.slice);
    return { operation: "maintain", slice: command.slice, changed };
  }

  private runMaintenance(slice: StateMaintenanceSlice): number {
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
}
