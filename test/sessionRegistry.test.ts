import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const SCOPE_B = "22222222-2222-4222-8222-222222222222";

describe("SessionRegistry", () => {
  it("persists only structured session metadata and restores it from SQLite", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bridge-root-")));
    const databaseFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "state.sqlite");
    const firstStore = new BridgeStateStore({ file: databaseFile });
    const project = firstStore.applyProjectOperations(
      [{ kind: "add", project: { name: "Codex MCP Bridge", cwd: root } }],
      0,
      [root]
    ).projects[0]!;
    const first = new SessionRegistry({ stateStore: firstStore, allowedRoots: [root] });
    first.record({
      threadId: "thread-1",
      sessionId: "session-tree-1",
      forkedFromThreadId: "thread-parent",
      scopeId: SCOPE_A,
      cwd: root,
      projectId: project.id,
      projectName: project.name,
      sandbox: "read-only",
      selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      policyRevision: 3,
      backendKind: "app-server",
      visibleInCodexApp: true,
      updatedAt: 200,
      createdAt: 100,
      lastUsedAt: 200
    });
    firstStore.close();

    const serialized = readFileSync(databaseFile);
    expect(serialized.includes(Buffer.from("thread-1"))).toBe(true);
    expect(statSync(databaseFile).mode & 0o777).toBe(0o600);

    const reopenedStore = new BridgeStateStore({ file: databaseFile });
    const restored = new SessionRegistry({ stateStore: reopenedStore, allowedRoots: [root] });
    expect(restored.get("thread-1")).toMatchObject({
      scopeId: SCOPE_A,
      cwd: root,
      projectId: project.id,
      projectName: "Codex MCP Bridge",
      sandbox: "read-only",
      selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      policyRevision: 3,
      updatedAt: 200,
      backendKind: "app-server",
      visibleInCodexApp: true
    });
    expect(restored.get("thread-1")).not.toHaveProperty("payload");
    expect(restored.get("thread-1")).not.toHaveProperty("prompt");
    reopenedStore.close();
  });

  it("restores an explicitly tracked danger-full-access session", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const databaseFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "state.sqlite");
    const firstStore = new BridgeStateStore({ file: databaseFile });
    const writer = new SessionRegistry({ stateStore: firstStore, allowedRoots: [root] });
    writer.record(session("full-thread", root, "danger-full-access", undefined, undefined, 100));
    firstStore.close();

    const reopenedStore = new BridgeStateStore({ file: databaseFile });
    const restored = new SessionRegistry({ stateStore: reopenedStore, allowedRoots: [root] });
    expect(restored.get("full-thread")).toMatchObject({
      cwd: root,
      sandbox: "danger-full-access"
    });
    reopenedStore.close();
  });

  it("keeps model execution state out of thread compatibility identity", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    let now = 10_000;
    const sessions = new SessionRegistry({ now: () => now });
    sessions.record(session("older", root, "read-only", "gpt-5.6-sol", "max", 9_200));
    sessions.record(session("newer", root, "read-only", "gpt-5.6-sol", "max", 9_800));
    sessions.record(session("write", root, "workspace-write", "gpt-5.6-sol", "max", 9_900));

    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only"
      }).map((session) => session.threadId)
    ).toEqual(["newer", "older"]);
    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only"
      }).map((session) => session.threadId)
    ).toEqual(["newer", "older"]);

    sessions.record(session("cli-default", root, "read-only", undefined, undefined, 9_950));
    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only"
      }).map((session) => session.threadId)
    ).toEqual(["cli-default", "newer", "older"]);
    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only"
      }).map((session) => session.threadId)
    ).toEqual(["cli-default", "newer", "older"]);

    now = 11_001;
    expect(
      sessions.findCompatible({
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only"
      }).map((session) => session.threadId)
    ).toEqual(["cli-default", "newer", "older"]);
    expect(sessions.get("newer")?.threadId).toBe("newer");
  });

  it("quarantines SQLite sessions outside temporary roots without deleting them", () => {
    const allowed = mkdtempSync(path.join(tmpdir(), "bridge-allowed-"));
    const outside = mkdtempSync(path.join(tmpdir(), "bridge-outside-"));
    const databaseFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "state.sqlite");
    const firstStore = new BridgeStateStore({ file: databaseFile });
    const writer = new SessionRegistry({ stateStore: firstStore });
    writer.record(session("allowed", allowed, "read-only", undefined, undefined, 100));
    writer.record(session("outside", outside, "read-only", undefined, undefined, 200));
    firstStore.close();

    const narrowedStore = new BridgeStateStore({ file: databaseFile });
    const narrowed = new SessionRegistry({ stateStore: narrowedStore, allowedRoots: [allowed] });
    expect(narrowed.list().map((entry) => entry.threadId)).toEqual(["allowed"]);
    expect(narrowedStore.countSessions()).toBe(2);
    narrowedStore.close();

    const restoredStore = new BridgeStateStore({ file: databaseFile });
    const restored = new SessionRegistry({ stateStore: restoredStore, allowedRoots: [outside] });
    expect(restored.list().map((entry) => entry.threadId)).toEqual(["outside"]);
    expect(restoredStore.countSessions()).toBe(2);
    restoredStore.close();
  });

  it("still enforces the global SQLite session retention limit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const databaseFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "state.sqlite");
    const firstStore = new BridgeStateStore({ file: databaseFile });
    const writer = new SessionRegistry({ stateStore: firstStore });
    writer.record(session("oldest", root, "read-only", undefined, undefined, 100));
    writer.record(session("middle", root, "read-only", undefined, undefined, 200));
    writer.record(session("newest", root, "read-only", undefined, undefined, 300));
    firstStore.close();

    const limitedStore = new BridgeStateStore({ file: databaseFile });
    const limited = new SessionRegistry({ stateStore: limitedStore, maxSessions: 2 });
    expect(limited.list().map((entry) => entry.threadId)).toEqual(["newest", "middle"]);
    expect(limitedStore.countSessions()).toBe(2);
    limitedStore.close();
  });

  it("touch moves a session to the front and persists its last-used time", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const databaseFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "state.sqlite");
    let now = 500;
    const firstStore = new BridgeStateStore({ file: databaseFile });
    const sessions = new SessionRegistry({ stateStore: firstStore, now: () => now });
    sessions.record(session("first", root, "read-only", undefined, undefined, 100));
    sessions.record(session("second", root, "read-only", undefined, undefined, 200));
    now = 600;
    sessions.touch("first");
    expect(sessions.list().map((entry) => entry.threadId)).toEqual(["first", "second"]);
    firstStore.close();

    const reopenedStore = new BridgeStateStore({ file: databaseFile });
    const restored = new SessionRegistry({ stateStore: reopenedStore });
    expect(restored.get("first")?.lastUsedAt).toBe(600);
    reopenedStore.close();
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

  it("updates mutable execution state without replacing thread identity", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    let now = 2_000;
    const sessions = new SessionRegistry({ now: () => now });
    sessions.record(session("thread-1", root, "read-only", "gpt-5.6-sol", "max", 1_000));
    now = 2_500;

    expect(sessions.updateExecution(
      "thread-1",
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
      9
    )).toMatchObject({
      threadId: "thread-1",
      scopeId: SCOPE_A,
      backendKind: "mcp-server",
      selection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      policyRevision: 9,
      updatedAt: 2_500,
      lastUsedAt: 2_500
    });
  });

  it("keeps an admitted project when later session evidence omits project metadata", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const sessions = new SessionRegistry();
    sessions.record({
      ...session("thread-1", root, "read-only", undefined, undefined, 1_000),
      projectId: "33333333-3333-4333-8333-333333333333",
      projectName: "Retained project"
    });

    sessions.record(session("thread-1", root, "read-only", undefined, undefined, 2_000));

    expect(sessions.get("thread-1")).toMatchObject({
      projectId: "33333333-3333-4333-8333-333333333333",
      projectName: "Retained project"
    });
  });

  it("projects the current registered name without restarting the session registry", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bridge-session-project-")));
    const state = new BridgeStateStore({ file: ":memory:" });
    const project = state.applyProjectOperations(
      [{ kind: "add", project: { name: "Original name", cwd: root } }],
      0,
      []
    ).projects[0]!;
    const sessions = new SessionRegistry({ stateStore: state });
    sessions.record({
      ...session("thread-1", root, "read-only", undefined, undefined, 1_000),
      projectId: project.id,
      projectName: project.name
    });

    state.applyProjectOperations(
      [{ kind: "rename", projectId: project.id, name: "Current name" }],
      1,
      []
    );

    expect(sessions.get("thread-1")).toMatchObject({
      projectId: project.id,
      projectName: "Current name"
    });
    expect(sessions.list()).toEqual([
      expect.objectContaining({ projectId: project.id, projectName: "Current name" })
    ]);
    state.close();
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
    ...(model && reasoningEffort
      ? { selection: { model, reasoningEffort }, policyRevision: 1 }
      : {}),
    backendKind: "mcp-server" as const,
    updatedAt: lastUsedAt,
    createdAt: lastUsedAt,
    lastUsedAt
  };
}
