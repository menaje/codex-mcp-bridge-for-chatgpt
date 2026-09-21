import type { StateMaintenanceSlice } from "./maintenanceScheduler.js";
import type { BridgeStateStore } from "./stateStore.js";

export const OPERATIONAL_STATE_PROTOCOL = "bridge-state-service" as const;
export const OPERATIONAL_STATE_PROTOCOL_VERSION = 2 as const;

export type OperationalStateCommand = {
  operation: "maintain";
  slice: StateMaintenanceSlice;
};

export type OperationalStateResult = {
  operation: "maintain";
  slice: StateMaintenanceSlice;
  changed: number;
  certainty?: "committed";
  commandId?: string;
  replayed?: boolean;
};

export type OperationalStateExecuteOptions = {
  deadlineMs?: number;
  /** Stable logical identity reused after an outcome-unknown response. */
  commandId?: string;
  /** Optional FIFO/versioning identity reserved for aggregate commands. */
  aggregateKey?: string;
};

export type OperationalStateRequestEnvelope = {
  protocol: typeof OPERATIONAL_STATE_PROTOCOL;
  version: typeof OPERATIONAL_STATE_PROTOCOL_VERSION;
  requestId: string;
  commandId: string;
  kind: "command";
  operation: OperationalStateCommand["operation"];
  aggregateKey?: string;
  workerGeneration: string;
  deadlineAt: number;
  payloadSha256: string;
  payload: OperationalStateCommand;
};

export type OperationalStateHealth = {
  ready: boolean;
  reason:
    | "ready"
    | "state-starting"
    | "state-stale"
    | "state-recovering"
    | "state-incompatible"
    | "state-capacity";
  protocolVersion: number;
  generation?: string;
  heartbeatAgeMs?: number;
  inFlight: number;
  capacity: number;
};

/**
 * Semantic asynchronous boundary for authoritative operational state.
 * Callers depend on this contract rather than on a SQLite connection. The
 * initial adapter remains in-process; a child-process implementation can
 * replace it only after every state caller has crossed this boundary.
 */
export interface OperationalStateService {
  execute(
    command: OperationalStateCommand,
    options?: OperationalStateExecuteOptions
  ): Promise<OperationalStateResult>;
}

export class InProcessOperationalStateService implements OperationalStateService {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: BridgeStateStore,
    private readonly options: { maintainJobs?: () => number } = {}
  ) {}

  execute(
    command: OperationalStateCommand,
    _options: OperationalStateExecuteOptions = {}
  ): Promise<OperationalStateResult> {
    const execute = () => this.run(command);
    const result = this.tail.then(execute, execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private run(command: OperationalStateCommand): OperationalStateResult {
    return executeOperationalStateCommand(this.store, command, this.options);
  }
}

/** Synchronous command body used only inside the isolated state's transaction. */
export function executeOperationalStateCommand(
  store: BridgeStateStore,
  command: OperationalStateCommand,
  options: { maintainJobs?: () => number } = {}
): OperationalStateResult {
  let changed: number;
  const slice = command.slice;
  if (slice === "events") {
    const report = store.maintainEventRetention();
    changed = report.expiredJobEventsRemoved + report.expiredActivityEventsRemoved +
      report.expiredResultHoldsRemoved + report.perJobEventsRemoved + report.budgetEventsRemoved;
  } else if (slice === "history") {
    changed = store.maintainHistoryRetention().historyRemoved;
  } else if (slice === "questions") {
    const report = store.maintainQuestionRetention();
    changed = report.expiredQuestionsRemoved + report.deliveredJournalsRemoved +
      report.notificationsMarkedUncertain;
  } else if (slice === "decisions") {
    const report = store.maintainDecisionRetention();
    changed = report.expiredLeasesMarkedUnknown + report.expiredCardsRemoved;
  } else if (slice === "recovery") {
    const report = store.maintainRecoveryRetention();
    changed = report.recordsRemoved + report.incidentsRemoved;
  } else {
    if (!options.maintainJobs) {
      throw new Error("STATE_OPERATION_UNAVAILABLE: Job retention requires the registry compatibility adapter.");
    }
    changed = options.maintainJobs();
  }
  return { operation: "maintain", slice, changed };
}
