import { describe, expect, it } from "vitest";
import type { CodexBackendKind } from "../src/config.js";
import type { CodexUpstream, ToolResult, UpstreamWorkerAssignment } from "../src/upstream.js";
import { backendRoutingArgument, CodexBackendRouter } from "../src/upstreamRouter.js";

describe("CodexBackendRouter", () => {
  it("forwards ephemeral only for App Server thread starts", async () => {
    const app = fakeBackend("app-server");
    const router = new CodexBackendRouter("app-server", app.backend);
    const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" };

    await router.startThread?.({
      backendKind: "app-server",
      prompt: "hidden",
      cwd: "/tmp/project",
      sandbox: "read-only",
      approvalPolicy: "never",
      selection,
      ephemeral: true
    });
    expect(app.calls.at(-1)?.args).toMatchObject({
      prompt: "hidden",
      ephemeral: true
    });

    await router.close();
  });

  it("uses the configured backend for new threads and pins every continuation", async () => {
    const app = fakeBackend("app-server");
    const router = new CodexBackendRouter("app-server", app.backend);

    const started = await router.callTool("codex", { prompt: "start" });
    expect(started.structuredContent).toMatchObject({ threadId: "app-server-thread-1" });
    expect(app.calls).toEqual([{ name: "codex", args: { prompt: "start" } }]);

    await router.callTool("codex-reply", {
      threadId: "app-server-thread-1",
      prompt: "continue",
      ...backendRoutingArgument("app-server")
    });
    expect(app.calls.at(-1)).toEqual({
      name: "codex-reply",
      args: { threadId: "app-server-thread-1", prompt: "continue" }
    });
    await router.close();
  });

  it("reads account rate limits from App Server regardless of the task backend", async () => {
    const app = fakeBackend("app-server");
    const router = new CodexBackendRouter("app-server", app.backend);

    await expect(router.readAccountRateLimits()).resolves.toMatchObject({
      limitId: "codex",
      remainingPercent: 75,
      windowDurationMins: 10_080
    });
    expect(app.rateLimitReads).toHaveLength(1);
    await router.close();
  });

  it.each(["mcp-server", "codex-sdk"] as const)("keeps %s history pinned while rejecting execution and silent migration", async kind => {
    const app = fakeBackend("app-server");
    const router = new CodexBackendRouter("app-server", app.backend);
    router.bindThread("retired-thread", kind);
    await expect(router.continueThread({ backendKind: kind, threadId: "retired-thread", prompt: "resume" })).rejects.toThrow("CODEX_BACKEND_RETIRED");
    await expect(router.forkThread({ backendKind: kind, threadId: "retired-thread", prompt: "fork" })).rejects.toThrow("CODEX_BACKEND_RETIRED");
    await expect(router.callTool("codex-reply", { threadId: "retired-thread", prompt: "wrong backend", ...backendRoutingArgument("app-server") })).rejects.toThrow("pinned to backend");
    expect(router.canResumeThread("retired-thread")).toBe(false);
    expect(router.canSteerThread("retired-thread")).toBe(false);
    await router.archiveThread("retired-thread");
    expect(app.calls).toHaveLength(0);
    expect(() => new CodexBackendRouter(kind, app.backend)).toThrow("CODEX_BACKEND_RETIRED");
    await router.close();
  });

  it("routes force-stop and App Server controls without exposing the internal marker", async () => {
    const app = fakeBackend("app-server");
    const router = new CodexBackendRouter("app-server", app.backend);
    router.bindThread("app-thread", "app-server");
    const assignment: UpstreamWorkerAssignment = {
      backendKind: "app-server",
      workerId: "app-0",
      workerGeneration: 1,
      upstreamRequestId: "turn-1"
    };

    await expect(router.forceTerminateWorker(assignment, {
      kind: "cancellation-intent",
      intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      source: "operator",
      reasonCode: "test-interrupt"
    })).resolves.toMatchObject({
      mode: "turn-interrupt"
    });
    await expect(router.steerThread("app-thread", "guide")).resolves.toEqual({ turnId: "turn-1" });
    expect(router.canSteerThread("app-thread")).toBe(true);
    router.bindThread("mcp-thread", "mcp-server");
    expect(router.canSteerThread("mcp-thread")).toBe(false);
    await router.callTool("codex-reply", { threadId: "app-thread", prompt: "continue" });
    await router.respondToInteraction("app-server-0:1:interaction-1", { decision: "accept" });
    expect(app.forceAssignments).toEqual([assignment]);
    expect(app.steers).toEqual([{ threadId: "app-thread", prompt: "guide" }]);
    expect(app.interactions).toEqual([{ interactionId: "app-server-0:1:interaction-1", response: { decision: "accept" } }]);
    await router.close();
  });
});

function fakeBackend(kind: CodexBackendKind) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const forceAssignments: UpstreamWorkerAssignment[] = [];
  const interactions: Array<{ interactionId: string; response: Record<string, unknown> }> = [];
  const steers: Array<{ threadId: string; prompt: string }> = [];
  const rateLimitReads: number[] = [];
  let sequence = 0;
  const backend: CodexUpstream = {
    async listTools() {
      return { kind };
    },
    canResumeThread() {
      return true;
    },
    canSteerThread() {
      return kind === "app-server";
    },
    async readAccountRateLimits() {
      rateLimitReads.push(Date.now());
      return {
        limitId: "codex",
        usedPercent: 25,
        remainingPercent: 75,
        windowDurationMins: 10_080,
        resetsAt: 1_900_604_800,
        observedAt: 1_900_000_000_000
      };
    },
    async callTool(name, args, _progress, assigned): Promise<ToolResult> {
      calls.push({ name, args });
      const threadId = name === "codex-reply"
        ? String(args.threadId)
        : `${kind}-thread-${++sequence}`;
      assigned?.({
        backendKind: kind,
        workerId: `${kind}-0`,
        workerGeneration: 1,
        threadId
      });
      return {
        content: [{ type: "text", text: threadId }],
        structuredContent: { threadId }
      };
    },
    async forceTerminateWorker(assignment) {
      forceAssignments.push(assignment);
      return {
        pid: 1,
        processGroupId: 1,
        exited: true,
        escalated: false,
        signal: null,
        mode: kind === "app-server" ? "turn-interrupt" : "process-group",
        workerExited: kind !== "app-server"
      };
    },
    async respondToInteraction(interactionId, response) {
      interactions.push({ interactionId, response });
    },
    async steerThread(threadId, prompt) {
      steers.push({ threadId, prompt });
      return { turnId: "turn-1" };
    },
    async close() {}
  };
  return { backend, calls, forceAssignments, interactions, steers, rateLimitReads };
}
