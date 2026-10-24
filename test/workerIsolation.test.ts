import path from "node:path";
import { expect, it } from "vitest";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import type { CodexPendingInteraction, UpstreamWorkerAssignment } from "../src/upstream.js";

it("reserves A during failed registration/cleanup while B answers and free worker C completes", async () => {
  let rejectRegistration!: (error: Error) => void;
  let releaseCleanup!: () => void;
  const registration = new Promise<void>((_resolve, reject) => { rejectRegistration = reject; });
  const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const spawned: number[] = [];
  let cleaning = false;
  const pool = new CodexAppServerUpstreamPool(path.resolve("test/fixtures/fake-codex-app-server.mjs"), 3, {
    environment: { ...process.env, CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1" },
    onWorkerProcessStarted: async identity => {
      spawned.push(identity.pid);
      if (spawned.length === 1) await registration;
    },
    onWorkerProcessExited: async identity => {
      if (identity.pid === spawned[0]) { cleaning = true; await cleanup; }
    }
  });
  const args = (prompt: string) => ({ prompt, cwd: process.cwd(), sandbox: "read-only", "approval-policy": "on-request" });
  const a = pool.callTool("codex", args("hold failed registration")).catch(error => error);
  let b: Promise<unknown> | undefined;
  try {
    await until(() => spawned.length === 1);
    let interaction: CodexPendingInteraction | undefined;
    let assignment: UpstreamWorkerAssignment | undefined;
    b = pool.callTool("codex", args("elicitation form"), progress => {
      interaction = progress.event?.details?.interaction as CodexPendingInteraction || interaction;
    }, value => { assignment = value; });
    await until(() => Boolean(interaction && assignment));
    rejectRegistration(new Error("injected worker A registration failure"));
    await until(() => cleaning);
    let cAssignment: UpstreamWorkerAssignment | undefined;
    await expect(pool.callTool("codex", args("independent C"), undefined,
      value => { cAssignment = value; })).resolves.toHaveProperty("content");
    expect(cAssignment!.workerId).toBe("app-2");
    expect(assignment!.workerId).toBe("app-1");
    expect(spawned).toHaveLength(3);
    await pool.respondToInteraction(interaction!.interactionId, { elicitation: {
      action: "accept", content: { color: "blue", count: 2, enabled: false, tags: ["b"] }
    } });
    await expect(b).resolves.toMatchObject({ content: [{ text: "ELICITATION COMPLETE" }] });
    // Several more jobs cannot replace the unconfirmed A generation.
    for (let index = 0; index < 3; index++) await pool.callTool("codex", args(`healthy capacity ${index}`));
    expect(spawned).toHaveLength(3);
  } finally {
    rejectRegistration(new Error("test teardown")); releaseCleanup();
    await a;
    await pool.close();
    await b?.catch(() => {});
  }
}, 20_000);

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("condition timeout"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
