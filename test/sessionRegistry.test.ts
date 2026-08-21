import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/sessionRegistry.js";

describe("SessionRegistry", () => {
  it("persists only session metadata and restores it after restart", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-state-")), "sessions.json");
    const first = new SessionRegistry({ stateFile, allowedRoots: [root] });
    first.record({
      threadId: "thread-1",
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

  it("selects only the most recent compatible session inside the auto-resume window", () => {
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
      sessions.findMostRecentCompatible({
        cwd: root,
        sandbox: "read-only",
        model: "gpt-5.6-sol",
        reasoningEffort: "max"
      })?.threadId
    ).toBe("newer");
    expect(
      sessions.findMostRecentCompatible({
        cwd: root,
        sandbox: "read-only",
        model: "gpt-5.6-terra",
        reasoningEffort: "max"
      })
    ).toBeUndefined();

    sessions.record(session("cli-default", root, "read-only", undefined, undefined, 9_950));
    expect(sessions.findMostRecentCompatible({ cwd: root, sandbox: "read-only" })?.threadId).toBe(
      "cli-default"
    );
    expect(
      sessions.findMostRecentCompatible({
        cwd: root,
        sandbox: "read-only",
        model: "gpt-5.6-sol",
        reasoningEffort: undefined
      })
    ).toBeUndefined();

    now = 11_001;
    expect(
      sessions.findMostRecentCompatible({ cwd: root, sandbox: "read-only", model: "gpt-5.6-sol" })
    ).toBeUndefined();
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
});

function session(
  threadId: string,
  cwd: string,
  sandbox: "read-only" | "workspace-write" | "danger-full-access",
  model: string | undefined,
  reasoningEffort: string | undefined,
  lastUsedAt: number
) {
  return {
    threadId,
    cwd,
    sandbox,
    model,
    reasoningEffort,
    createdAt: lastUsedAt,
    lastUsedAt
  };
}
