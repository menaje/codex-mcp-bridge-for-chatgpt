import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_SCOPE_ID, SessionRegistry } from "../src/sessionRegistry.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const SCOPE_B = "22222222-2222-4222-8222-222222222222";

describe("SessionRegistry", () => {
  it("persists only session metadata and restores it after restart", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "sessions.json");
    const first = new SessionRegistry({ stateFile, allowedRoots: [root] });
    first.record({
      threadId: "thread-1",
      scopeId: SCOPE_A,
      cwd: root,
      sandbox: "read-only",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      createdAt: 100,
      lastUsedAt: 200
    });

    const serialized = readFileSync(stateFile, "utf8");
    expect(serialized).toContain("thread-1");
    expect(serialized).not.toContain("prompt");
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);

    const restored = new SessionRegistry({ stateFile, allowedRoots: [root] });
    expect(restored.get("thread-1")).toMatchObject({
      scopeId: SCOPE_A,
      cwd: root,
      sandbox: "read-only",
      model: "gpt-5.6-sol",
      reasoningEffort: "max"
    });
  });

  it("restores an explicitly tracked danger-full-access session", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "sessions.json");
    const writer = new SessionRegistry({ stateFile, allowedRoots: [root] });
    writer.record(session("full-thread", root, "danger-full-access", undefined, undefined, 100));

    const restored = new SessionRegistry({ stateFile, allowedRoots: [root] });
    expect(restored.get("full-thread")).toMatchObject({
      cwd: root,
      sandbox: "danger-full-access"
    });
  });

  it("returns every compatible session inside the auto-resume window", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    let now = 10_000;
    const sessions = new SessionRegistry({
      autoResumeTtlMs: 1_000,
      now: () => now
    });
    sessions.record(session("older", root, "read-only", "gpt-5.6-sol", "max", 9_200));
    sessions.record(session("newer", root, "read-only", "gpt-5.6-sol", "max", 9_800));
    sessions.record(session("write", root, "workspace-write", "gpt-5.6-sol", "max", 9_900));

    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only",
        model: "gpt-5.6-sol",
        reasoningEffort: "max"
      }).map((session) => session.threadId)
    ).toEqual(["newer", "older"]);
    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only",
        model: "gpt-5.6-terra",
        reasoningEffort: "max"
      })
    ).toEqual([]);

    sessions.record(session("cli-default", root, "read-only", undefined, undefined, 9_950));
    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only"
      }).map((session) => session.threadId)
    ).toEqual(["cli-default"]);
    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only",
        model: "gpt-5.6-sol",
        reasoningEffort: undefined
      })
    ).toEqual([]);

    now = 11_001;
    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only",
        model: "gpt-5.6-sol"
      })
    ).toEqual([]);
    expect(sessions.get("newer")?.threadId).toBe("newer");
  });

  it("does not restore persisted sessions outside the current allowed roots", () => {
    const allowed = mkdtempSync(path.join(tmpdir(), "bridge-allowed-"));
    const outside = mkdtempSync(path.join(tmpdir(), "bridge-outside-"));
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "sessions.json");
    const writer = new SessionRegistry({ stateFile });
    writer.record(session("allowed", allowed, "read-only", undefined, undefined, 100));
    writer.record(session("outside", outside, "read-only", undefined, undefined, 200));

    const reader = new SessionRegistry({ stateFile, allowedRoots: [allowed] });
    expect(reader.list().map((entry) => entry.threadId)).toEqual(["allowed"]);
  });

  it("touch moves a session to the front and persists its last-used time", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "sessions.json");
    let now = 500;
    const sessions = new SessionRegistry({ stateFile, now: () => now });
    sessions.record(session("first", root, "read-only", undefined, undefined, 100));
    sessions.record(session("second", root, "read-only", undefined, undefined, 200));
    now = 600;
    sessions.touch("first");

    expect(sessions.list().map((entry) => entry.threadId)).toEqual(["first", "second"]);
    const restored = new SessionRegistry({ stateFile });
    expect(restored.get("first")?.lastUsedAt).toBe(600);
  });

  it("groups all related sessions by conversation scope", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const sessions = new SessionRegistry({ now: () => 1_000 });
    sessions.record(session("scope-a-first", root, "read-only", undefined, undefined, 900));
    sessions.record(
      session("scope-b", root, "read-only", undefined, undefined, 950, SCOPE_B)
    );
    sessions.record(
      session("scope-a-second", root, "read-only", undefined, undefined, 975, SCOPE_A)
    );

    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only"
      }).map((session) => session.threadId)
    ).toEqual(["scope-a-second", "scope-a-first"]);
    expect(
      sessions.findCompatible({
        scopeId: SCOPE_B,
        cwd: root,
        sandbox: "read-only"
      }).map((session) => session.threadId)
    ).toEqual(["scope-b"]);
  });

  it("moves a thread only when it is explicitly adopted", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const sessions = new SessionRegistry({ now: () => 2_000 });
    sessions.record(session("thread-1", root, "read-only", undefined, undefined, 1_000));

    expect(sessions.adopt("thread-1", SCOPE_B)).toMatchObject({
      scopeId: SCOPE_B,
      lastUsedAt: 2_000
    });
  });

  it("migrates version 1 state into a quarantined legacy scope", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "sessions.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            threadId: "legacy-thread",
            cwd: root,
            sandbox: "read-only",
            createdAt: 100,
            lastUsedAt: 200
          }
        ]
      })
    );

    const sessions = new SessionRegistry({ stateFile, allowedRoots: [root] });
    expect(sessions.get("legacy-thread")).toMatchObject({
      scopeId: LEGACY_SCOPE_ID
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ version: 3 });
  });

  it("migrates version 2 task lanes into ordinary sessions under one scope", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "sessions.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 2,
        sessions: [
          {
            threadId: "v2-thread",
            scopeId: SCOPE_A,
            taskKey: "review",
            cwd: root,
            sandbox: "read-only",
            createdAt: 100,
            lastUsedAt: 200
          }
        ]
      })
    );

    const sessions = new SessionRegistry({ stateFile, allowedRoots: [root] });
    expect(sessions.get("v2-thread")).toMatchObject({ scopeId: SCOPE_A });
    expect(sessions.get("v2-thread")).not.toHaveProperty("taskKey");
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ version: 3 });
  });
});

function session(
  threadId: string,
  cwd: string,
  sandbox: "read-only" | "workspace-write" | "danger-full-access",
  model: string | undefined,
  reasoningEffort: string | undefined,
  lastUsedAt: number,
  scopeId = SCOPE_A
) {
  return {
    threadId,
    scopeId,
    cwd,
    sandbox,
    model,
    reasoningEffort,
    createdAt: lastUsedAt,
    lastUsedAt
  };
}
