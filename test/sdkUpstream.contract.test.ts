import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAppServerUpstreamPool, type CodexAppServerProtocolOptions } from "../src/appServerUpstream.js";
import type { CodexProgress, UpstreamWorkerAssignment } from "../src/upstream.js";
import { sdkEnvironment, sdkRuntimeLock } from "../src/sdkRuntime.js";
import { backendRoutingArgument, CodexBackendRouter } from "../src/upstreamRouter.js";

const python = process.env.CODEX_MCP_BRIDGE_SDK_TEST_PYTHON;
const fixture = fileURLToPath(new URL("./fixtures/sdk-worker-fixture.py", import.meta.url));
function pool(apiAccount = false): CodexAppServerUpstreamPool {
  const transport: NonNullable<CodexAppServerProtocolOptions["transport"]> = {
    backendKind: "codex-sdk", args: ["-s", fixture, process.execPath, ...(apiAccount ? ["--api-account"] : [])],
    env: sdkEnvironment({ ...process.env, OPENAI_API_KEY: "sk-must-not-be-used", CODEX_API_KEY: "sk-must-not-be-used" }),
    verify: async () => sdkRuntimeLock.sdk,
    runtime: { sdk: sdkRuntimeLock.sdk, python: sdkRuntimeLock.python, codex: sdkRuntimeLock.codexRuntime }
  };
  return new CodexAppServerUpstreamPool(python!, 1, { transport, requestTimeoutMs: 3000 });
}

describe.skipIf(!python)("exact Python SDK public API contract (fake Codex transport, no billable calls)", () => {
  it.skipIf(process.env.CODEX_MCP_BRIDGE_SDK_LONG_TEST !== "1")("completes over ten minutes without an implicit SDK or bridge cancellation", async () => {
    const sdk = pool();
    const started = Date.now();
    try {
      await expect(sdk.callTool("codex", { prompt: "sdk long completion", cwd: "/tmp", sandbox: "read-only", "approval-policy": "never" }))
        .resolves.toMatchObject({ content: [{ text: "SDK LONG COMPLETE" }], structuredContent: { turnStatus: "completed" } });
      expect(Date.now() - started).toBeGreaterThan(600_000);
    } finally { await sdk.close(); }
  }, 660_000);
  it("delivers per-turn progress and completion, preserves SDK identities, resumes and forks without spawning a worker per turn", async () => {
    const sdk = pool();
    const router = new CodexBackendRouter("codex-sdk", new Map([["codex-sdk", sdk]]));
    const events: CodexProgress[] = [], assignments: UpstreamWorkerAssignment[] = [];
    try {
      const started = await router.callTool("codex", { prompt: "sdk stream", cwd: "/tmp", model: "gpt-5.4-mini", sandbox: "read-only", "approval-policy": "never" },
        event => events.push(event), assignment => assignments.push(assignment));
      expect(started.structuredContent).toMatchObject({ backendKind: "codex-sdk", turnStatus: "completed", runtime: { sdk: "0.147.0" } });
      expect(events.some(event => event.event?.type === "agent-message")).toBe(true);
      expect(assignments.every(value => value.backendKind === "codex-sdk" && value.workerId === "sdk-0")).toBe(true);
      const threadId = (started.structuredContent as { threadId: string }).threadId;
      await router.callTool("codex-reply", { threadId, prompt: "continue", ...backendRoutingArgument("codex-sdk") }, undefined, value => assignments.push(value));
      expect(new Set(assignments.map(value => value.workerPid)).size).toBe(1);
      expect(await router.probeThread(threadId, "codex-sdk")).toMatchObject({ state: "resumable" });
      await router.archiveThread(threadId, "codex-sdk");
      await router.restoreThread(threadId, "codex-sdk");
      const forked = await router.forkThread({ backendKind: "codex-sdk", threadId, prompt: "forked context", selection: { model: "gpt-5.4-mini" } });
      expect(forked.structuredContent).toMatchObject({ backendKind: "codex-sdk", turnStatus: "completed", forkedFromThreadId: threadId });
      expect((forked.structuredContent as { threadId: string }).threadId).not.toBe(threadId);
      expect(sdk.capabilities().supportsBackgroundTerminals).toBe(false);
    } finally { await router.close(); }
  }, 15_000);

  it("retains immediate completion delivered in the same transport batch as turn/start", async () => {
    const sdk = pool();
    try {
      await expect(sdk.callTool("codex", { prompt: "batched completion", cwd: "/tmp", sandbox: "read-only", "approval-policy": "never" })).resolves.toMatchObject({
        content: [{ type: "text", text: "BATCHED COMPLETE" }], structuredContent: { turnStatus: "completed" }
      });
    } finally { await sdk.close(); }
  }, 10_000);

  it("steers and interrupts only the identified turn with explicit cancellation provenance", async () => {
    const sdk = pool();
    let assignment: UpstreamWorkerAssignment | undefined;
    try {
      const first = sdk.callTool("codex", { prompt: "hold for steering", cwd: "/tmp", sandbox: "read-only", "approval-policy": "never" }, undefined, value => { assignment = value; });
      await expect.poll(() => assignment?.upstreamRequestId, { timeout: 5000 }).toBeTruthy();
      await expect(sdk.steerThread(assignment!.threadId!, "new direction")).resolves.toEqual({ turnId: assignment!.upstreamRequestId });
      await expect(first).resolves.toMatchObject({ content: [{ text: "STEERED:new direction" }] });
      const threadId = assignment!.threadId;
      assignment = undefined;
      const second = sdk.callTool("codex-reply", { prompt: "hold for interrupt", threadId }, undefined, value => { assignment = value; });
      await expect.poll(() => assignment?.upstreamRequestId, { timeout: 5000 }).toBeTruthy();
      await expect(sdk.forceTerminateWorker(assignment!, undefined as never)).rejects.toThrow("TERMINATION_PROVENANCE_REQUIRED");
      await expect(sdk.forceTerminateWorker(assignment!, {
        kind: "cancellation-intent", intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        source: "operator", reasonCode: "test-interrupt"
      }, 500)).resolves.toMatchObject({ exited: true, escalated: false, mode: "turn-interrupt", workerExited: false });
      await expect(second).resolves.toMatchObject({ structuredContent: { backendKind: "codex-sdk", turnStatus: "interrupted" } });
    } finally { await sdk.close(); }
  });

  it("round-trips approvals and user input through public SDK callbacks", async () => {
    const sdk = pool();
    const interactions: any[] = [];
    try {
      const running = sdk.callTool("codex", { prompt: "interactions", cwd: "/tmp", sandbox: "read-only", "approval-policy": "on-request" }, event => {
        const interaction = event.event?.details?.interaction;
        if (interaction) interactions.push(interaction);
      });
      const kinds = ["command-approval", "file-approval", "user-input", "permission-approval"];
      for (const kind of kinds) {
        await expect.poll(() => interactions.some(item => item.kind === kind), { timeout: 5000 }).toBe(true);
        const interaction = interactions.find(item => item.kind === kind);
        await sdk.respondToInteraction(interaction.interactionId, kind === "user-input" ? { answers: { color: ["blue"] } } : { decision: kind === "file-approval" ? "decline" : kind === "permission-approval" ? "acceptForSession" : "accept" });
      }
      await expect(running).resolves.toMatchObject({ content: [{ text: "INTERACTIONS COMPLETE" }] });
      expect(interactions.map(item => item.kind)).toEqual(kinds);
    } finally { await sdk.close(); }
  }, 15_000);

  it("rejects API credentials in ChatGPT mode before model or turn execution, without exposing the account or key", async () => {
    const sdk = pool(true);
    try {
      await expect(sdk.listModels()).rejects.toThrow("SDK_AUTH_REQUIRED");
      await expect(sdk.listModels()).rejects.not.toThrow("private-fixture@example.com");
    } finally { await sdk.close(); }
  });

  // SDK 0.147.0 invokes approval_handler on its sole reader thread. A server-owned
  // expiry suppresses the bridge reply, leaving that reader blocked; see #29 and the audit.
  // Opt in to reproduce without billing; keep the expected behavior as a regression target.
  it.skipIf(process.env.CODEX_MCP_BRIDGE_SDK_EXPIRY_REPRO !== "1")("expires unanswered SDK input and rejects a late response", async () => {
    const sdk = pool();
    const events: CodexProgress[] = [];
    try {
      const result = await sdk.callTool("codex", {
        prompt: "expire input locally", cwd: "/tmp", sandbox: "read-only", "approval-policy": "on-request"
      }, event => events.push(event));
      expect(result).toMatchObject({ content: [{ text: "LOCAL INPUT EXPIRED" }], structuredContent: { turnStatus: "completed" } });
      const interaction = events.map(event => event.event?.details?.interaction).find(Boolean) as { interactionId: string; autoResolutionMs: number };
      expect(interaction.autoResolutionMs).toBe(20);
      expect(events.some(event => event.event?.details?.resolution === "expired")).toBe(true);
      await expect(sdk.respondToInteraction(interaction.interactionId, { answers: { auto: ["late"] } }))
        .rejects.toThrow("Unknown or already resolved");
    } finally { await sdk.close(); }
  }, 15_000);

  it("fails closed for unsupported SDK methods and retains the same worker after a supported request", async () => {
    const sdk = pool();
    try {
      expect(await sdk.listModels()).toHaveProperty("data");
      await expect(sdk.callTool("codex", { prompt: "ephemeral", cwd: "/tmp", sandbox: "read-only", "approval-policy": "never", ephemeral: true })).rejects.toThrow("SDK_EPHEMERAL_UNSUPPORTED");
      expect(sdk.capabilities().supportsEphemeralThreads).toBe(false);
      await expect(sdk.listBackgroundTerminals("thread-missing")).rejects.toThrow();
      expect(await sdk.listModels()).toHaveProperty("data");
    } finally { await sdk.close(); }
  });
});
