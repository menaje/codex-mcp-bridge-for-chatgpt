import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import type {
  CodexPendingInteraction,
  CodexPublicEvent,
  UpstreamWorkerAssignment
} from "../src/upstream.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-app-server.mjs"
);

describe("CodexAppServerUpstreamPool", () => {
  it("uses the safe App Server handshake and emits only allowlisted public events", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    const events: CodexPublicEvent[] = [];
    try {
      const result = await pool.callTool(
        "codex",
        task("rich progress"),
        (progress) => {
          if (progress.event) events.push(progress.event);
        }
      );

      expect(result).toMatchObject({
        content: [{ type: "text", text: "APP SERVER" }],
        structuredContent: {
          threadId: "fake-thread-1",
          turnId: "fake-turn-1",
          turnStatus: "completed",
          backendKind: "app-server"
        }
      });
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["turn", "plan", "agent-message", "command", "file-change"])
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "command", phase: "completed" }),
          expect.objectContaining({ type: "file-change", phase: "completed" }),
          expect.objectContaining({ type: "agent-message", phase: "updated" })
        ])
      );
      expect(JSON.stringify(events)).not.toContain("PRIVATE_REASONING_MUST_NEVER_APPEAR");
    } finally {
      await pool.close();
    }
  }, 15_000);

  it("registers a returned turn before consuming batched immediate notifications", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    try {
      await expect(pool.callTool("codex", task("batched completion"))).resolves.toMatchObject({
        content: [{ type: "text", text: "BATCHED COMPLETE" }],
        structuredContent: {
          threadId: "fake-thread-1",
          turnId: "fake-turn-1",
          turnStatus: "completed"
        }
      });
    } finally {
      await pool.close();
    }
  }, 15_000);

  it("round-trips command, file, input, and permission requests by exact request ID", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    const interactions: CodexPendingInteraction[] = [];
    try {
      const running = pool.callTool("codex", task("interactions"), (progress) => {
        const interaction = progress.event?.details?.interaction;
        if (isInteraction(interaction)) interactions.push(interaction);
      });

      const command = await nextInteraction(interactions, "command-approval");
      expect(command.interactionId).toContain("request-command-17");
      await pool.respondToInteraction(command.interactionId, { decision: "accept" });

      const file = await nextInteraction(interactions, "file-approval");
      expect(file.interactionId).toContain("902");
      await pool.respondToInteraction(file.interactionId, { decision: "decline" });

      const input = await nextInteraction(interactions, "user-input");
      expect(input.questions).toEqual([
        expect.objectContaining({ id: "color", question: "Choose a color" })
      ]);
      await pool.respondToInteraction(input.interactionId, { answers: { color: ["blue"] } });

      const permission = await nextInteraction(interactions, "permission-approval");
      expect(permission.summary).toContain("Need fixture access");
      await pool.respondToInteraction(permission.interactionId, { decision: "accept" });

      await expect(running).resolves.toMatchObject({
        content: [{ type: "text", text: "INTERACTIONS COMPLETE" }],
        structuredContent: { turnStatus: "completed" }
      });
      expect(interactions.map((interaction) => interaction.kind)).toEqual([
        "command-approval",
        "file-approval",
        "user-input",
        "permission-approval"
      ]);
    } finally {
      await pool.close();
    }
  }, 15_000);

  it("steers only the exact active turn and keeps the thread resumable", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    let assignment: UpstreamWorkerAssignment | undefined;
    try {
      const running = pool.callTool(
        "codex",
        task("hold for steering"),
        undefined,
        (value) => { assignment = value; }
      );
      await eventually(() => Boolean(assignment?.threadId));
      await expect(pool.steerThread(assignment!.threadId!, "new direction")).resolves.toEqual({
        turnId: assignment!.upstreamRequestId
      });
      await expect(running).resolves.toMatchObject({
        content: [{ type: "text", text: "STEERED:new direction" }],
        structuredContent: { threadId: assignment!.threadId, turnStatus: "completed" }
      });

      await expect(
        pool.callTool("codex-reply", {
          ...task("resume normally"),
          threadId: assignment!.threadId
        })
      ).resolves.toMatchObject({
        structuredContent: { threadId: assignment!.threadId, turnStatus: "completed" }
      });
      expect(pool.canResumeThread(assignment!.threadId!)).toBe(true);
    } finally {
      await pool.close();
    }
  }, 15_000);

  it("confirms exact turn interruption before falling back to process termination", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    let assignment: UpstreamWorkerAssignment | undefined;
    try {
      const running = pool.callTool(
        "codex",
        task("hold for interrupt"),
        undefined,
        (value) => { assignment = value; }
      );
      await eventually(() => Boolean(assignment?.upstreamRequestId));
      await expect(pool.forceTerminateWorker(assignment!, 100)).resolves.toMatchObject({
        exited: true,
        escalated: false,
        mode: "turn-interrupt",
        workerExited: false
      });
      await expect(running).resolves.toMatchObject({
        content: [{ type: "text", text: "INTERRUPTED" }],
        structuredContent: { turnStatus: "interrupted" }
      });
    } finally {
      await pool.close();
    }
  }, 15_000);
});

function task(prompt: string): Record<string, unknown> {
  return {
    prompt,
    cwd: process.cwd(),
    sandbox: "read-only",
    "approval-policy": "on-request"
  };
}

function isInteraction(value: unknown): value is CodexPendingInteraction {
  return typeof value === "object" && value !== null && typeof (value as CodexPendingInteraction).interactionId === "string";
}

async function nextInteraction(
  interactions: CodexPendingInteraction[],
  kind: CodexPendingInteraction["kind"]
): Promise<CodexPendingInteraction> {
  await eventually(() => interactions.some((interaction) => interaction.kind === kind));
  return interactions.find((interaction) => interaction.kind === kind)!;
}

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true before timeout.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
