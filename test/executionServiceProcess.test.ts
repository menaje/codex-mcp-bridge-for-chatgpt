import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ChildProcessCodexExecutionService } from "../src/executionServiceProcess.js";
import type { CodexPendingInteraction, UpstreamWorkerAssignment } from "../src/upstream.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-app-server.mjs"
);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("isolated Codex execution process", () => {
  it("runs turns, progress, account reads, and steering outside the state owner", async () => {
    const service = await createService();
    let assignment: UpstreamWorkerAssignment | undefined;
    const progress: unknown[] = [];
    try {
      expect(service.processId).toEqual(expect.any(Number));
      expect(service.processId).not.toBe(process.pid);
      expect(service.health()).toMatchObject({ status: "ready", inFlight: 0 });
      await expect(service.readAccountRateLimits()).resolves.toMatchObject({
        limitId: "codex",
        windowDurationMins: 10_080
      });

      const running = service.callTool(
        "codex",
        task("hold for steering"),
        value => progress.push(value),
        value => { assignment = value; }
      );
      await eventually(() => Boolean(assignment?.threadId));
      expect(service.canSteerThread(assignment!.threadId!)).toBe(true);
      await expect(service.steerThread(assignment!.threadId!, "isolated direction"))
        .resolves.toMatchObject({ turnId: assignment!.upstreamRequestId });
      await expect(running).resolves.toMatchObject({
        content: [{ text: "STEERED:isolated direction" }],
        structuredContent: {
          threadId: assignment!.threadId,
          turnStatus: "completed"
        }
      });
      expect(progress.length).toBeGreaterThan(0);
      expect(service.canSteerThread(assignment!.threadId!)).toBe(false);
      expect(service.canResumeThread(assignment!.threadId!)).toBe(true);
    } finally {
      await service.close();
    }
  }, 20_000);

  it("keeps private interaction input in the execution process proxy only", async () => {
    const service = await createService();
    let interaction: CodexPendingInteraction | undefined;
    try {
      const running = service.callTool("codex", task("elicitation form"), value => {
        const candidate = value.event?.details?.interaction as CodexPendingInteraction | undefined;
        if (candidate?.interactionId) interaction = candidate;
      });
      await eventually(() => Boolean(interaction));
      expect(service.interactionInput(interaction!.interactionId)).toHaveProperty("requestedSchema");
      await service.respondToInteraction(interaction!.interactionId, {
        elicitation: {
          action: "accept",
          content: { color: "blue", count: 2, enabled: false, tags: ["b"] }
        }
      });
      await expect(running).resolves.toMatchObject({ content: [{ text: "ELICITATION COMPLETE" }] });
      expect(service.interactionInput(interaction!.interactionId)).toBeUndefined();
    } finally {
      await service.close();
    }
  }, 20_000);

  it("restarts after a process crash without restarting the state owner", async () => {
    const service = await createService();
    try {
      const first = service.processId;
      const interrupted = service.callTool("codex", task("hold for steering"));
      await eventually(() => service.health().inFlight === 1);
      expect(service.terminate("SIGKILL")).toBe(true);
      await expect(interrupted).rejects.toThrow(/CODEX_WORKER_LOST/);
      await eventually(() => service.processId !== undefined && service.processId !== first &&
        service.health().status === "ready", 10_000);
      await expect(service.callTool("codex", task("after execution restart")))
        .resolves.toMatchObject({ structuredContent: { turnStatus: "completed" } });
    } finally {
      await service.close();
    }
  }, 20_000);

  it("rechecks authoritative release eligibility across the process boundary", async () => {
    const service = await createService({ CODEX_TEST_UNSUBSCRIBE_UNLOAD: "1" });
    let assignment: UpstreamWorkerAssignment | undefined;
    let checks = 0;
    try {
      await service.callTool(
        "codex",
        task("release after completion"),
        undefined,
        value => { assignment = value; }
      );
      expect(assignment?.threadId).toBeTypeOf("string");
      await expect(service.releaseThreadConnection(assignment!.threadId!, {
        canRelease: threadId => {
          checks += 1;
          return threadId === assignment!.threadId;
        },
        eligibleThreadIds: [assignment!.threadId!],
        previousWorkerPid: assignment!.workerPid
      })).resolves.toMatchObject({ phase: "released", evidence: "thread-unloaded" });
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(service.canResumeThread(assignment!.threadId!)).toBe(false);
    } finally {
      await service.close();
    }
  }, 20_000);

  it("does not grant the execution process Bridge database or listener authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "execution-environment-"));
    roots.push(root);
    const observation = path.join(root, "environment.json");
    const service = await createService({
      CODEX_TEST_APP_SERVER_ENV_OBSERVATION: observation,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
      CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
      CODEX_MCP_BRIDGE_ENV_FILE: path.join(root, "bridge.env"),
      CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_TOKEN: "must-not-cross-execution-boundary"
    });
    try {
      await service.readAccountSnapshot();
      const environment = JSON.parse(await readFile(observation, "utf8")) as {
        stateDatabaseFile: string | null;
        telemetryDatabaseFile: string | null;
        bridgeToken: string | null;
        runtimeHome: string | null;
        environmentFile: string | null;
        allowedRoots: string | null;
        codexHome: string | null;
      };
      expect(environment).toMatchObject({
        stateDatabaseFile: null,
        telemetryDatabaseFile: null,
        bridgeToken: null,
        runtimeHome: null,
        environmentFile: null,
        allowedRoots: null,
        codexHome: expect.any(String)
      });
    } finally {
      await service.close();
    }
  }, 20_000);

  it("continues Codex work while the state-owner event loop is blocked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "execution-owner-stall-"));
    roots.push(root);
    const completionLog = path.join(root, "completion.log");
    const service = await createService({
      CODEX_TEST_TURN_COMPLETION_LOG: completionLog
    });
    try {
      const running = service.callTool(
        "codex",
        task("delayed isolated completion")
      );
      await eventually(() => service.health().inFlight === 1);
      const blockedAt = Date.now();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      const resumedAt = Date.now();
      const completedAt = Number((await readFile(completionLog, "utf8")).trim());
      expect(completedAt).toBeGreaterThanOrEqual(blockedAt);
      expect(completedAt).toBeLessThan(resumedAt);
      await expect(running).resolves.toMatchObject({
        content: [{ text: "ISOLATED COMPLETION" }],
        structuredContent: { turnStatus: "completed" }
      });
    } finally {
      await service.close();
    }
  }, 20_000);

  it("bounds executor progress IPC while the state owner cannot receive messages", async () => {
    const service = await createService();
    const progress: unknown[] = [];
    try {
      const running = service.callTool(
        "codex",
        task("execution progress flood"),
        value => progress.push(value)
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      await expect(running).resolves.toMatchObject({
        content: [{ text: "EXECUTION PROGRESS FLOOD COMPLETE" }],
        structuredContent: { turnStatus: "completed" }
      });
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.length).toBeLessThan(100);
    } finally {
      await service.close();
    }
  }, 20_000);
});

async function createService(
  extraEnvironment: NodeJS.ProcessEnv = {}
): Promise<ChildProcessCodexExecutionService> {
  const home = await mkdtemp(path.join(tmpdir(), "execution-service-"));
  roots.push(home);
  return ChildProcessCodexExecutionService.start({
    command: fixture,
    poolSize: 1,
    environment: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      ...extraEnvironment
    }
  });
}

function task(prompt: string): Record<string, unknown> {
  return {
    prompt,
    cwd: process.cwd(),
    sandbox: "read-only",
    "approval-policy": "on-request"
  };
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true before timeout.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
