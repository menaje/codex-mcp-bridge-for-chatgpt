import { describe, expect, it, vi } from "vitest";
import { classifyMemoryOnlyThreadImpact } from "../src/runtimeAdmission.js";

describe("runtime admission memory-only impact", () => {
  it("protects only resumable Bridge contexts with unfinished work", () => {
    const sessions = [
      { threadId: "active-ephemeral", backendKind: "app-server" as const, persistence: "ephemeral" as const },
      { threadId: "idle-ephemeral", backendKind: "app-server" as const, persistence: "ephemeral" as const },
      { threadId: "hidden-unknown", backendKind: "app-server" as const, persistence: "unknown" as const, visibleInCodexApp: false },
      { threadId: "visible-persistent", backendKind: "app-server" as const, persistence: "persistent" as const, visibleInCodexApp: true },
      { threadId: "unloaded-ephemeral", backendKind: "app-server" as const, persistence: "ephemeral" as const },
      { threadId: "sdk-session", backendKind: "codex-sdk" as const, persistence: "unknown" as const }
    ];
    const resumable = new Set([
      "active-ephemeral",
      "idle-ephemeral",
      "hidden-unknown",
      "visible-persistent",
      "external-codex-task"
    ]);
    const unfinished = new Set(["active-ephemeral", "external-codex-task"]);
    const queriedForWork = vi.fn((threadId: string) => unfinished.has(threadId));

    expect(classifyMemoryOnlyThreadImpact(
      sessions,
      threadId => resumable.has(threadId),
      queriedForWork
    )).toEqual({
      memoryOnlyThreads: 3,
      protectedMemoryOnlyThreads: 1,
      discardableMemoryOnlyThreads: 2
    });
    expect(queriedForWork.mock.calls.map(([threadId]) => threadId)).toEqual([
      "active-ephemeral",
      "idle-ephemeral",
      "hidden-unknown"
    ]);
    expect(queriedForWork).not.toHaveBeenCalledWith("external-codex-task");
  });
});
