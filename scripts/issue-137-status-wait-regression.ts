import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexJobRegistry } from "../src/tools.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexProgress, ToolResult } from "../src/upstream.js";

const root = await mkdtemp(path.join(tmpdir(), "bridge-issue-137-"));
const store = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
const registry = new CodexJobRegistry({ stateStore: store, allowedRoots: [root] });

try {
  let emitProgress: ((progress: CodexProgress) => void) | undefined;
  let complete: ((result: ToolResult) => void) | undefined;
  const job = registry.start({
    operation: "start",
    cwd: root,
    sandbox: "read-only",
    scopeId: "11111111-1111-4111-8111-111111111111",
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requestHash: "a".repeat(64),
    requestHashVersion: 2,
    selectionKey: "issue-137-regression",
    executionDecision: {
      policyRevision: 1,
      catalogFingerprint: "c".repeat(64),
      catalogValidation: "valid",
      backendKind: "app-server",
      effectiveSelection: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      source: "fixed",
      appliedAt: "thread-start",
      reason: "Issue #137 deterministic regression fixture."
    },
    exclusiveKeys: [],
    sessionDecision: {
      requestedMode: "new",
      action: "start",
      reason: "explicit-new"
    }
  }, async (progress) => {
    emitProgress = progress;
    return new Promise<ToolResult>((resolve) => { complete = resolve; });
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(emitProgress);
  assert.ok(complete);

  const modelWait = registry.wait(
    job.jobId, "terminal", 5_000, undefined, "model-status"
  );
  const dashboardWait = registry.wait(
    job.jobId, "terminal", 5_000, undefined, "dashboard-completion"
  );
  await Promise.resolve();

  const originalIdentityRead = store.listActivityProjectIdentities.bind(store);
  let identityReadsDuringProgress = 0;
  store.listActivityProjectIdentities = () => {
    identityReadsDuringProgress += 1;
    return originalIdentityRead();
  };

  for (let index = 0; index < 100; index += 1) {
    emitProgress({
      progress: index / 100,
      event: {
        eventId: `issue-137-progress-${index}`,
        type: "command",
        phase: "updated",
        createdAt: Date.now(),
        summary: `Synthetic public progress ${index}`
      }
    });
  }

  const active = registry.waitDiagnostics();
  const progressIdentityReads = identityReadsDuringProgress;
  assert.equal(progressIdentityReads, 0);
  assert.equal(active.active.total, 2);
  assert.equal(active.wakes.total, 0);
  assert.equal(active.maintenance.telemetryTransaction.count, 100);

  complete({
    content: [{ type: "text", text: "Issue #137 regression completed." }],
    structuredContent: { threadId: "issue-137-regression-thread" }
  });
  await job.promise;
  const [modelResult, dashboardResult] = await Promise.all([modelWait, dashboardWait]);
  assert.equal(modelResult.job.status, "completed");
  assert.equal(dashboardResult.job.status, "completed");

  const terminal = registry.waitDiagnostics();
  assert.equal(terminal.wakes.progress, 0);
  assert.equal(terminal.wakes.terminal, 2);
  assert.equal(terminal.active.total, 0);

  process.stdout.write(`${JSON.stringify({
    issue: 137,
    workload: {
      publicProgressEvents: 100,
      terminalWaiters: 2,
      sources: ["model-status", "dashboard-completion"]
    },
    evidence: {
      identityReadsDuringProgress: progressIdentityReads,
      progressTriggeredWakes: terminal.wakes.progress,
      terminalTriggeredWakes: terminal.wakes.terminal,
      telemetryTransactions: terminal.maintenance.telemetryTransaction,
      pruneAndPersist: terminal.maintenance.pruneAndPersist,
      activeWaitersAfterTerminal: terminal.active.total
    },
    result: "pass"
  }, null, 2)}\n`);
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
