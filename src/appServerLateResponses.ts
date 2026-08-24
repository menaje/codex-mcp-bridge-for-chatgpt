import type { CodexAppServerLateResponse } from "./appServerUpstream.js";
import type { BridgeStateStore } from "./stateStore.js";

const META_KEY = "app_server_late_responses_v1";
export const MAX_RETAINED_APP_SERVER_LATE_RESPONSES = 128;

export type AppServerLateResponseOutcome = "success" | "error" | "malformed";
export type AppServerLateResponseReconciliation =
  | "not-applicable"
  | "identifier-recorded"
  | "agent-archived"
  | "agent-restored"
  | "already-consistent"
  | "thread-untracked"
  | "state-conflict"
  | "malformed";

export type AppServerLateResponseRecord = {
  requestId: number;
  method: string;
  outcome: AppServerLateResponseOutcome;
  timedOutAt: number;
  receivedAt: number;
  latencyAfterTimeoutMs: number;
  workerId: string;
  workerGeneration: number;
  errorCode?: number;
  threadId?: string;
  turnId?: string;
  reconciliation: AppServerLateResponseReconciliation;
};

type AppServerLateResponseTotals = {
  observed: number;
  success: number;
  error: number;
  malformed: number;
  identified: number;
  stateReconciled: number;
  stateConflicts: number;
  untracked: number;
  evicted: number;
};

type PersistedLateResponseState = {
  version: 1;
  totals: AppServerLateResponseTotals;
  records: AppServerLateResponseRecord[];
};

export type AppServerLateResponseStatus = {
  durable: boolean;
  retentionLimit: number;
  retained: number;
  totals: Readonly<AppServerLateResponseTotals>;
  latest: null | {
    method: string;
    outcome: AppServerLateResponseOutcome;
    reconciliation: AppServerLateResponseReconciliation;
  };
};

/**
 * Durable, bounded ledger for App Server responses that arrive after the
 * bridge has already returned a timeout. Only protocol identifiers, outcome
 * class, numeric error code, and timing are retained; result/error payloads,
 * prompts, cwd values, command output, and error messages are never persisted.
 */
export class AppServerLateResponseJournal {
  private readonly retentionLimit: number;

  constructor(
    private readonly stateStore: BridgeStateStore,
    options: { retentionLimit?: number } = {}
  ) {
    const retentionLimit = options.retentionLimit ?? MAX_RETAINED_APP_SERVER_LATE_RESPONSES;
    if (
      !Number.isSafeInteger(retentionLimit) ||
      retentionLimit <= 0 ||
      retentionLimit > MAX_RETAINED_APP_SERVER_LATE_RESPONSES
    ) {
      throw new Error(
        `App Server late-response retention must be between 1 and ${MAX_RETAINED_APP_SERVER_LATE_RESPONSES}.`
      );
    }
    this.retentionLimit = retentionLimit;
    this.stateStore.transaction(() => {
      if (this.stateStore.getMeta(META_KEY) === undefined) return;
      const state = this.loadState();
      this.compact(state);
      this.saveState(state);
    });
  }

  observe(response: CodexAppServerLateResponse): AppServerLateResponseRecord {
    return this.stateStore.transaction(() => {
      const interpreted = interpretLateResponse(response);
      const reconciliation = this.reconcile(interpreted);
      const record: AppServerLateResponseRecord = { ...interpreted, reconciliation };
      const state = this.loadState();
      increment(state.totals, "observed");
      increment(state.totals, record.outcome);
      if (record.threadId || record.turnId) increment(state.totals, "identified");
      if (reconciliation === "agent-archived" || reconciliation === "agent-restored") {
        increment(state.totals, "stateReconciled");
      } else if (reconciliation === "state-conflict") {
        increment(state.totals, "stateConflicts");
      } else if (reconciliation === "thread-untracked") {
        increment(state.totals, "untracked");
      }
      state.records.push(record);
      this.compact(state);
      this.saveState(state);
      return { ...record };
    });
  }

  status(): AppServerLateResponseStatus {
    const state = this.loadState();
    const latest = state.records.at(-1);
    return {
      durable: this.stateStore.persistent,
      retentionLimit: this.retentionLimit,
      retained: state.records.length,
      totals: { ...state.totals },
      latest: latest
        ? {
            method: latest.method,
            outcome: latest.outcome,
            reconciliation: latest.reconciliation
          }
        : null
    };
  }

  listRecords(): AppServerLateResponseRecord[] {
    return this.loadState().records.map((record) => ({ ...record }));
  }

  private reconcile(
    record: Omit<AppServerLateResponseRecord, "reconciliation">
  ): AppServerLateResponseReconciliation {
    if (record.outcome === "malformed") return "malformed";
    if (record.outcome !== "success") return "not-applicable";
    if (record.method !== "thread/archive" && record.method !== "thread/unarchive") {
      return record.threadId || record.turnId ? "identifier-recorded" : "not-applicable";
    }
    if (!record.threadId) return "malformed";

    const agent = this.stateStore.getAgentForThread(record.threadId);
    if (!agent) return "thread-untracked";
    // Logical Agent archive/restore is deliberately bridge-local. A timed-out
    // upstream archive response can still reveal that upstream state changed,
    // but it must never replay that side effect into the Agent lifecycle. Mark
    // every tracked late archive/unarchive success for explicit reconciliation.
    return "state-conflict";
  }

  private loadState(): PersistedLateResponseState {
    const raw = this.stateStore.getMeta(META_KEY);
    if (raw === undefined) return emptyState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Stored App Server late-response telemetry is invalid JSON.");
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.totals) || !Array.isArray(parsed.records)) {
      throw new Error("Stored App Server late-response telemetry has an unsupported format.");
    }
    return {
      version: 1,
      totals: readTotals(parsed.totals),
      records: parsed.records.map(readRecord)
    };
  }

  private compact(state: PersistedLateResponseState): void {
    const excess = Math.max(0, state.records.length - this.retentionLimit);
    if (excess === 0) return;
    state.records.splice(0, excess);
    add(state.totals, "evicted", excess);
  }

  private saveState(state: PersistedLateResponseState): void {
    this.stateStore.setMeta(META_KEY, JSON.stringify(state));
  }
}

function interpretLateResponse(
  response: CodexAppServerLateResponse
): Omit<AppServerLateResponseRecord, "reconciliation"> {
  const responseError = isRecord(response.response.error) ? response.response.error : undefined;
  const hasError = responseError !== undefined;
  const hasResult = Object.prototype.hasOwnProperty.call(response.response, "result");
  const method = protocolMethod(response.method);
  let outcome: AppServerLateResponseOutcome = hasError === hasResult
    ? "malformed"
    : hasError
      ? "error"
      : method === "unknown"
        ? "malformed"
        : "success";
  const contextThreadId = safeIdentifier(response.lateResponseContext?.threadId);
  const result = isRecord(response.response.result) ? response.response.result : undefined;
  const resultThread = result && isRecord(result.thread) ? result.thread : undefined;
  const resultTurn = result && isRecord(result.turn) ? result.turn : undefined;
  const resultThreadId = safeIdentifier(resultThread?.id);
  const resultTurnId = safeIdentifier(resultTurn?.id) || safeIdentifier(result?.turnId);
  let threadId = contextThreadId;
  let turnId: string | undefined;

  if (outcome === "success") {
    if (method === "thread/start" || method === "thread/fork") {
      threadId = resultThreadId;
      if (!threadId) outcome = "malformed";
    } else if (method === "thread/resume" || method === "thread/unarchive") {
      if (resultThreadId && contextThreadId && resultThreadId !== contextThreadId) {
        threadId = undefined;
        outcome = "malformed";
      } else {
        threadId = resultThreadId || contextThreadId;
        if (!threadId) outcome = "malformed";
      }
    } else if (method === "thread/archive") {
      if (!threadId) outcome = "malformed";
    } else if (method === "turn/start") {
      turnId = resultTurnId;
      if (!threadId || !turnId) outcome = "malformed";
    }
  }

  const errorCode = responseError && Number.isSafeInteger(responseError.code)
    ? Number(responseError.code)
    : undefined;
  return {
    requestId: safeNonNegativeInteger(response.requestId, "request id"),
    method,
    outcome,
    timedOutAt: safeNonNegativeInteger(response.timedOutAt, "timeout timestamp"),
    receivedAt: safeNonNegativeInteger(response.receivedAt, "receive timestamp"),
    latencyAfterTimeoutMs: Math.max(0, response.receivedAt - response.timedOutAt),
    workerId: safeIdentifier(response.workerId) || "unknown",
    workerGeneration: safeNonNegativeInteger(response.workerGeneration, "worker generation"),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {})
  };
}

function emptyState(): PersistedLateResponseState {
  return {
    version: 1,
    totals: {
      observed: 0,
      success: 0,
      error: 0,
      malformed: 0,
      identified: 0,
      stateReconciled: 0,
      stateConflicts: 0,
      untracked: 0,
      evicted: 0
    },
    records: []
  };
}

function readTotals(value: Record<string, unknown>): AppServerLateResponseTotals {
  return {
    observed: counter(value.observed, "observed"),
    success: counter(value.success, "success"),
    error: counter(value.error, "error"),
    malformed: counter(value.malformed, "malformed"),
    identified: counter(value.identified, "identified"),
    stateReconciled: counter(value.stateReconciled, "stateReconciled"),
    stateConflicts: counter(value.stateConflicts, "stateConflicts"),
    untracked: counter(value.untracked, "untracked"),
    evicted: counter(value.evicted, "evicted")
  };
}

function readRecord(value: unknown): AppServerLateResponseRecord {
  if (!isRecord(value)) throw new Error("Stored App Server late-response record is invalid.");
  const outcome = value.outcome;
  const reconciliation = value.reconciliation;
  if (outcome !== "success" && outcome !== "error" && outcome !== "malformed") {
    throw new Error("Stored App Server late-response outcome is invalid.");
  }
  if (!isReconciliation(reconciliation)) {
    throw new Error("Stored App Server late-response reconciliation is invalid.");
  }
  const timedOutAt = safeNonNegativeInteger(value.timedOutAt, "stored timeout timestamp");
  const receivedAt = safeNonNegativeInteger(value.receivedAt, "stored receive timestamp");
  const errorCode = value.errorCode === undefined
    ? undefined
    : safeInteger(value.errorCode, "stored error code");
  const threadId = value.threadId === undefined ? undefined : requiredSafeIdentifier(value.threadId);
  const turnId = value.turnId === undefined ? undefined : requiredSafeIdentifier(value.turnId);
  return {
    requestId: safeNonNegativeInteger(value.requestId, "stored request id"),
    method: protocolMethod(value.method),
    outcome,
    timedOutAt,
    receivedAt,
    latencyAfterTimeoutMs: Math.max(0, receivedAt - timedOutAt),
    workerId: requiredSafeIdentifier(value.workerId),
    workerGeneration: safeNonNegativeInteger(value.workerGeneration, "stored worker generation"),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    reconciliation
  };
}

function isReconciliation(value: unknown): value is AppServerLateResponseReconciliation {
  return value === "not-applicable" || value === "identifier-recorded" ||
    value === "agent-archived" || value === "agent-restored" ||
    value === "already-consistent" || value === "thread-untracked" ||
    value === "state-conflict" || value === "malformed";
}

function protocolMethod(value: unknown): string {
  if (typeof value !== "string" || value.length > 120 || !/^[a-z][a-zA-Z0-9/]*$/.test(value)) {
    return "unknown";
  }
  return value;
}

function requiredSafeIdentifier(value: unknown): string {
  const identifier = safeIdentifier(value);
  if (!identifier) throw new Error("Stored App Server late-response identifier is invalid.");
  return identifier;
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const identifier = value.trim();
  if (!identifier || identifier.length > 200 || /[\u0000-\u001f\u007f]/.test(identifier)) return undefined;
  return identifier;
}

function counter(value: unknown, label: string): number {
  return safeNonNegativeInteger(value, `stored ${label} counter`);
}

function safeNonNegativeInteger(value: unknown, label: string): number {
  const result = safeInteger(value, label);
  if (result < 0) throw new Error(`Invalid App Server late-response ${label}.`);
  return result;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid App Server late-response ${label}.`);
  return Number(value);
}

function increment<K extends keyof AppServerLateResponseTotals>(
  totals: AppServerLateResponseTotals,
  key: K
): void {
  add(totals, key, 1);
}

function add<K extends keyof AppServerLateResponseTotals>(
  totals: AppServerLateResponseTotals,
  key: K,
  value: number
): void {
  totals[key] = Math.min(Number.MAX_SAFE_INTEGER, totals[key] + value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
