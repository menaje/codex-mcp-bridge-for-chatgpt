import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import { UserSettingsStore } from "../src/userSettings.js";

describe("BridgeStateStore", () => {
  it("commits session and job changes atomically and keeps the database private", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });

    expect(() =>
      store.transaction(() => {
        store.upsertSession(session("thread-rollback"));
        store.upsertJob(job("job-rollback", "request-rollback"));
        throw new Error("force rollback");
      })
    ).toThrow(/force rollback/);
    expect(store.countSessions()).toBe(0);
    expect(store.countJobs()).toBe(0);

    store.transaction(() => {
      store.upsertSession(session("thread-committed"));
      store.upsertJob(job("job-committed", "request-committed"));
    });
    expect(store.countSessions(SCOPE_A)).toBe(1);
    expect(store.countJobs(SCOPE_A, "completed")).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${file}-shm`).mode & 0o777).toBe(0o600);
    store.close();

    const reopened = new BridgeStateStore({ file });
    expect(reopened.listSessions()).toEqual([session("thread-committed")]);
    expect(reopened.listJobs()).toEqual([
      expect.objectContaining({
        ...job("job-committed", "request-committed"),
        activityId: expect.any(String),
        executionMode: "background",
        backendKind: "mcp-server",
        terminalVersion: 1
      })
    ]);
    reopened.close();
  });

  it("rejects an unknown future schema instead of overwriting its version", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    store.setMeta("schema_version", "999");
    store.close();

    expect(() => new BridgeStateStore({ file })).toThrow(/Unsupported bridge state database schema version: 999/);
  });

  it("imports each legacy JSON registry once into the shared database", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-migration-root-"));
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-migration-state-"));
    const sessionFile = path.join(stateDirectory, "sessions.json");
    const jobFile = path.join(stateDirectory, "jobs.json");
    const settingsFile = path.join(stateDirectory, "settings.json");
    const databaseFile = path.join(stateDirectory, "state.sqlite");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root
    });
    const legacySessions = new SessionRegistry({ stateFile: sessionFile, allowedRoots: [root] });
    legacySessions.record({
      threadId: "legacy-thread",
      scopeId: SCOPE_A,
      cwd: root,
      sandbox: "read-only",
      backendKind: "mcp-server",
      createdAt: 1,
      lastUsedAt: 2
    });
    const legacyJobs = registry(jobFile, root);
    const legacyJob = legacyJobs.start(jobInput(root), async () => ({
      content: [{ type: "text", text: "done" }],
      structuredContent: { threadId: "legacy-thread" }
    }));
    await legacyJob.promise;
    const legacySettings = new UserSettingsStore(config, { stateFile: settingsFile });
    legacySettings.update({ uiLocalePreference: "ko" });

    const store = new BridgeStateStore({ file: databaseFile });
    const importedSessions = new SessionRegistry({
      stateFile: sessionFile,
      stateStore: store,
      allowedRoots: [root]
    });
    const importedJobs = registry(jobFile, root, store);
    const importedSettings = new UserSettingsStore(config, { stateFile: settingsFile, stateStore: store });

    expect(importedSessions.get("legacy-thread")).toBeDefined();
    expect(importedJobs.get(legacyJob.jobId)).toMatchObject({ status: "completed" });
    expect(importedSettings.current).toMatchObject({ revision: 1, uiLocalePreference: "ko" });
    expect(store.countSessions()).toBe(1);
    expect(store.countJobs()).toBe(1);
    store.close();

    writeFileSync(sessionFile, JSON.stringify({ version: 3, sessions: [
      {
        threadId: "must-not-reimport",
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only",
        createdAt: 3,
        lastUsedAt: 4
      }
    ] }));
    writeFileSync(jobFile, JSON.stringify({ version: 4, jobs: [] }));

    const reopened = new BridgeStateStore({ file: databaseFile });
    const restoredSessions = new SessionRegistry({
      stateFile: sessionFile,
      stateStore: reopened,
      allowedRoots: [root]
    });
    const restoredJobs = registry(jobFile, root, reopened);
    expect(restoredSessions.get("legacy-thread")).toBeDefined();
    expect(restoredSessions.get("must-not-reimport")).toBeUndefined();
    expect(restoredJobs.get(legacyJob.jobId)).toMatchObject({ status: "completed" });
    reopened.close();
  });
});

const SCOPE_A = "11111111-1111-4111-8111-111111111111";

function stateFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "bridge-sqlite-state-")), "private", "state.sqlite");
}

function session(threadId: string) {
  return {
    threadId,
    scopeId: SCOPE_A,
    cwd: "/tmp/repository",
    lastUsedAt: 1
  };
}

function job(jobId: string, requestId: string) {
  return {
    jobId,
    scopeId: SCOPE_A,
    requestId,
    status: "completed",
    updatedAt: 2
  };
}

function registry(stateFile: string, root: string, stateStore?: BridgeStateStore): CodexJobRegistry {
  return new CodexJobRegistry({
    stateFile,
    stateStore,
    allowedRoots: [root],
    maxConcurrentJobs: 30,
    ttlMs: 6 * 60 * 60 * 1000,
    maxJobs: 100,
    maxResultBytes: 1024 * 1024,
    staleAfterMs: 10 * 60 * 1000
  });
}

function jobInput(root: string) {
  return {
    operation: "start" as const,
    cwd: root,
    sandbox: "read-only" as const,
    scopeId: SCOPE_A,
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requestHash: "a".repeat(64),
    requestHashVersion: 2 as const,
    selectionKey: "legacy-selection",
    exclusiveKeys: [],
    sessionDecision: {
      requestedMode: "new" as const,
      action: "start" as const,
      reason: "explicit-new" as const
    }
  };
}
