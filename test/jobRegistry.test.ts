import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexJobRegistry } from "../src/tools.js";
import { LEGACY_SCOPE_ID } from "../src/sessionRegistry.js";
import type { ToolResult } from "../src/upstream.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("CodexJobRegistry persistence", () => {
  it("retains completed results across bridge registry restarts", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => result("thread-completed"));

    await job.promise;
    const restored = persistentRegistry(root, stateFile);
    const loaded = restored.get(job.jobId);

    expect(loaded).toMatchObject({
      status: "completed",
      result: { structuredContent: { threadId: "thread-completed" } }
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ version: 5 });
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
  });

  it("marks jobs that were running at restart as interrupted", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(
      jobInput(root),
      async () => new Promise<ToolResult>(() => undefined)
    );
    await Promise.resolve();

    const restored = persistentRegistry(root, stateFile);
    const loaded = restored.get(job.jobId);

    expect(loaded).toMatchObject({
      status: "interrupted",
      version: 2,
      error: "The bridge restarted before this Codex job reached a terminal state."
    });
  });

  it("treats resolved MCP error results as failed jobs", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => ({
      isError: true,
      content: [{ type: "text", text: "Session not found for thread_id: stale-thread" }]
    }));

    await job.promise;
    expect(registry.get(job.jobId)).toMatchObject({
      status: "failed",
      error: "Session not found for thread_id: stale-thread"
    });
    expect(registry.get(job.jobId)?.result).toBeUndefined();
  });

  it("repairs legacy completed jobs whose retained MCP result is an error", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => result("thread-before-repair"));
    await job.promise;
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.jobs[0].result = {
      isError: true,
      content: [{ type: "text", text: "Session not found for thread_id: thread-before-repair" }]
    };
    writeFileSync(stateFile, JSON.stringify(state));

    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({
      status: "failed",
      error: "Session not found for thread_id: thread-before-repair"
    });
    expect(restored.get(job.jobId)?.result).toBeUndefined();
  });

  it("drops persisted jobs whose cwd is outside the configured roots", async () => {
    const firstRoot = temporaryRoot();
    const secondRoot = temporaryRoot();
    const stateFile = path.join(firstRoot, "private", "jobs.json");
    const registry = persistentRegistry(firstRoot, stateFile);
    const job = registry.start(jobInput(firstRoot), async () => result("thread-one"));
    await job.promise;

    const restored = persistentRegistry(secondRoot, stateFile);

    expect(restored.get(job.jobId)).toBeUndefined();
    expect(restored.size).toBe(0);
  });

  it("migrates version 1 jobs into a quarantined legacy scope", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => result("legacy-thread"));
    await job.promise;

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.version = 1;
    delete state.jobs[0].scopeId;
    delete state.jobs[0].taskKey;
    delete state.jobs[0].requestId;
    delete state.jobs[0].requestHash;
    writeFileSync(stateFile, JSON.stringify(state));

    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({
      scopeId: LEGACY_SCOPE_ID
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ version: 5 });
  });

  it("migrates version 2 task-lane jobs without retaining taskKey", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => result("v2-thread"));
    await job.promise;

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.version = 2;
    state.jobs[0].taskKey = "review";
    state.jobs[0].requestHash = "b".repeat(64);
    delete state.jobs[0].requestHashVersion;
    delete state.jobs[0].selectionKey;
    writeFileSync(stateFile, JSON.stringify(state));

    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({ scopeId: SCOPE_A });
    expect(restored.get(job.jobId)).not.toHaveProperty("taskKey");
    expect(restored.findRequest(SCOPE_A, REQUEST_A, "a".repeat(64))?.jobId).toBe(job.jobId);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ version: 5 });
  });

  it("keeps only the newest legacy record for a duplicated scope request", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const original = registry.start(jobInput(root), async () => result("older-thread"));
    await original.promise;
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const duplicate = structuredClone(state.jobs[0]);
    duplicate.jobId = "newer-duplicate-job";
    duplicate.updatedAt += 1;
    duplicate.result = result("newer-thread");
    state.jobs.push(duplicate);
    writeFileSync(stateFile, JSON.stringify(state));

    const restored = persistentRegistry(root, stateFile);
    expect(restored.size).toBe(1);
    expect(restored.get("newer-duplicate-job")).toMatchObject({
      status: "completed",
      result: { structuredContent: { threadId: "newer-thread" } }
    });
    expect(restored.get(original.jobId)).toBeUndefined();
  });
});

function persistentRegistry(root: string, stateFile: string): CodexJobRegistry {
  return new CodexJobRegistry({
    maxConcurrentJobs: 30,
    ttlMs: 6 * 60 * 60 * 1000,
    maxJobs: 100,
    maxResultBytes: 1024 * 1024,
    staleAfterMs: 10 * 60 * 1000,
    stateFile,
    allowedRoots: [root]
  });
}

function jobInput(root: string) {
  return {
    operation: "start" as const,
    cwd: root,
    sandbox: "read-only" as const,
    scopeId: SCOPE_A,
    requestId: REQUEST_A,
    requestHash: "a".repeat(64),
    requestHashVersion: 2 as const,
    selectionKey: "selection-a",
    exclusiveKeys: [],
    sessionDecision: {
      requestedMode: "new" as const,
      action: "start" as const,
      reason: "explicit-new" as const
    }
  };
}

function result(threadId: string): ToolResult {
  return {
    content: [{ type: "text", text: threadId }],
    structuredContent: { threadId }
  };
}

function temporaryRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "bridge-job-state-"));
}
