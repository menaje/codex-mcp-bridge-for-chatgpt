import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUPPORTED_CODEX_CLI_VERSION } from "../src/appServerCompatibility.js";
import {
  AppServerLateResponseJournal,
  MAX_RETAINED_APP_SERVER_LATE_RESPONSES
} from "../src/appServerLateResponses.js";
import {
  CodexAppServerUpstreamPool,
  type CodexAppServerLateResponse
} from "../src/appServerUpstream.js";
import { BridgeStateStore } from "../src/stateStore.js";

const SCOPE_ID = "11111111-1111-4111-8111-111111111111";
const FIXTURE = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server-late-reconciliation.mjs", import.meta.url)
);

describe("AppServerLateResponseJournal", () => {
  it("records late identifiers without replaying upstream archive state into logical Agents", async () => {
    const store = new BridgeStateStore({ file: stateFile() });
    const archiveAgent = store.createAgent({ scopeId: SCOPE_ID, agentName: "Late Archive" });
    store.linkAgentThread({
      agentId: archiveAgent.agentId,
      threadId: "late-archive-success",
      backendKind: "app-server",
      cwd: "/tmp/repository",
      sandbox: "read-only",
      contextMode: "fresh"
    });
    const restoreAgent = store.createAgent({ scopeId: SCOPE_ID, agentName: "Late Restore" });
    store.linkAgentThread({
      agentId: restoreAgent.agentId,
      threadId: "late-unarchive-success",
      backendKind: "app-server",
      cwd: "/tmp/repository",
      sandbox: "read-only",
      contextMode: "fresh"
    });
    store.archiveAgent(restoreAgent.agentId);

    const journal = new AppServerLateResponseJournal(store, { retentionLimit: 16 });
    const pool = new CodexAppServerUpstreamPool(
      FIXTURE,
      1,
      {
        initializeTimeoutMs: 2_000,
        requestTimeoutMs: 30,
        onLateResponse: (response) => journal.observe(response)
      },
      { versionProbe: async () => SUPPORTED_CODEX_CLI_VERSION }
    );

    try {
      await expect(pool.archiveThread!("late-archive-success", "app-server")).rejects.toMatchObject({
        code: -32001,
        method: "thread/archive"
      });
      await eventually(() => journal.status().totals.observed === 1);
      expect(store.getAgent(archiveAgent.agentId)?.lifecycle).toBe("idle");

      await expect(pool.archiveThread!("late-archive-error", "app-server")).rejects.toMatchObject({
        code: -32001,
        method: "thread/archive"
      });
      await eventually(() => journal.status().totals.error === 1);

      await expect(pool.restoreThread!("late-unarchive-success", "app-server")).rejects.toMatchObject({
        code: -32001,
        method: "thread/unarchive"
      });
      await eventually(() => journal.status().totals.observed === 3);
      expect(store.getAgent(restoreAgent.agentId)?.lifecycle).toBe("archived");

      await expect(pool.startThread!({
        backendKind: "app-server",
        prompt: "late thread identifier",
        cwd: process.cwd(),
        sandbox: "read-only",
        approvalPolicy: "on-request",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      })).rejects.toMatchObject({ code: -32001, method: "thread/start" });

      await expect(pool.continueThread!({
        backendKind: "app-server",
        threadId: "late-turn-thread",
        prompt: "late turn identifier",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      })).rejects.toMatchObject({ code: -32001, method: "turn/start" });

      await eventually(() => journal.status().totals.observed === 5);
      expect(journal.status()).toMatchObject({
        durable: true,
        retentionLimit: 16,
        retained: 5,
        totals: {
          observed: 5,
          success: 4,
          error: 1,
          malformed: 0,
          identified: 5,
          stateReconciled: 0,
          stateConflicts: 2,
          untracked: 0,
          evicted: 0
        }
      });

      const records = journal.listRecords();
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "thread/archive",
          threadId: "late-archive-success",
          outcome: "success",
          reconciliation: "state-conflict"
        }),
        expect.objectContaining({
          method: "thread/archive",
          threadId: "late-archive-error",
          outcome: "error",
          errorCode: -32055,
          reconciliation: "not-applicable"
        }),
        expect.objectContaining({
          method: "thread/unarchive",
          threadId: "late-unarchive-success",
          outcome: "success",
          reconciliation: "state-conflict"
        }),
        expect.objectContaining({
          method: "thread/start",
          threadId: "late-created-thread",
          outcome: "success",
          reconciliation: "identifier-recorded"
        }),
        expect.objectContaining({
          method: "turn/start",
          threadId: "late-turn-thread",
          turnId: "late-created-turn",
          outcome: "success",
          reconciliation: "identifier-recorded"
        })
      ]));
      expect(JSON.stringify(records)).not.toMatch(
        /SECRET_LATE_SUCCESS_PAYLOAD|SECRET_LATE_ERROR_MESSAGE|SECRET_LATE_ERROR_DATA/
      );
      expect(store.getMeta("app_server_late_responses_v1")).not.toMatch(
        /SECRET_LATE_SUCCESS_PAYLOAD|SECRET_LATE_ERROR_MESSAGE|SECRET_LATE_ERROR_DATA/
      );
      expect(Object.keys(journal.status().latest || {}).sort()).toEqual([
        "method",
        "outcome",
        "reconciliation"
      ]);
    } finally {
      await pool.close();
      store.close();
    }
  }, 10_000);

  it("retains a bounded sanitized ledger and preserves aggregate counters across restart", () => {
    const file = stateFile();
    const firstStore = new BridgeStateStore({ file });
    expect(
      () => new AppServerLateResponseJournal(firstStore, {
        retentionLimit: MAX_RETAINED_APP_SERVER_LATE_RESPONSES + 1
      })
    ).toThrow(`between 1 and ${MAX_RETAINED_APP_SERVER_LATE_RESPONSES}`);
    const first = new AppServerLateResponseJournal(firstStore, { retentionLimit: 3 });
    for (let requestId = 1; requestId <= 5; requestId += 1) {
      first.observe(syntheticLateResponse(requestId, requestId % 2 === 0 ? "error" : "success"));
    }
    expect(first.status()).toMatchObject({
      retained: 3,
      totals: { observed: 5, success: 3, error: 2, evicted: 2 }
    });
    expect(first.listRecords().map((record) => record.requestId)).toEqual([3, 4, 5]);
    expect(firstStore.getMeta("app_server_late_responses_v1")).not.toContain("SECRET_SYNTHETIC_PAYLOAD");
    firstStore.close();

    const reopenedStore = new BridgeStateStore({ file });
    const reopened = new AppServerLateResponseJournal(reopenedStore, { retentionLimit: 3 });
    expect(reopened.status()).toMatchObject({
      durable: true,
      retained: 3,
      totals: { observed: 5, success: 3, error: 2, evicted: 2 }
    });
    expect(reopened.listRecords().map((record) => record.requestId)).toEqual([3, 4, 5]);
    expect(JSON.stringify(reopened.listRecords())).not.toContain("SECRET_SYNTHETIC_PAYLOAD");
    reopenedStore.close();
  });

  it("records a conflict instead of archiving an Agent whose current state changed", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const agent = store.createAgent({ scopeId: SCOPE_ID, agentName: "Busy Late Archive" });
    store.linkAgentThread({
      agentId: agent.agentId,
      threadId: "busy-thread",
      backendKind: "app-server",
      cwd: "/tmp/repository",
      sandbox: "read-only",
      contextMode: "fresh"
    });
    store.setAgentExecutionState(agent.agentId, "active", { currentJobId: "job-now-active" });
    const journal = new AppServerLateResponseJournal(store);

    const response = syntheticLateResponse(1, "success", "thread/archive", "busy-thread");
    expect(journal.observe(response)).toMatchObject({ reconciliation: "state-conflict" });
    expect(store.getAgent(agent.agentId)?.lifecycle).toBe("active");
    expect(journal.status().totals.stateConflicts).toBe(1);
    store.close();
  });
});

function syntheticLateResponse(
  requestId: number,
  outcome: "success" | "error",
  method = "model/list",
  threadId?: string
): CodexAppServerLateResponse {
  return {
    requestId,
    method,
    timeoutMs: 25,
    timedOutAt: 1_000 + requestId,
    receivedAt: 1_100 + requestId,
    ...(threadId ? { lateResponseContext: { threadId } } : {}),
    response: outcome === "success"
      ? { id: requestId, result: { secret: "SECRET_SYNTHETIC_PAYLOAD" } }
      : {
          id: requestId,
          error: {
            code: -32099,
            message: "SECRET_SYNTHETIC_PAYLOAD",
            data: { secret: "SECRET_SYNTHETIC_PAYLOAD" }
          }
        },
    workerId: "app-0",
    workerGeneration: 1
  };
}

function stateFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "app-server-late-response-")), "state.sqlite");
}

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true before timeout.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
