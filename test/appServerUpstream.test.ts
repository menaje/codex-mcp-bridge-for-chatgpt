import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_SERVER_CLIENT_INFO,
  CodexAppServerUpstreamPool,
  type CodexAppServerLateResponse
} from "../src/appServerUpstream.js";
import { SUPPORTED_CODEX_CLI_VERSION } from "../src/appServerCompatibility.js";
import { BRIDGE_BUILD_INFO } from "../src/buildInfo.js";
import type { JsonRpcProcessIdentity } from "../src/jsonRpcProcess.js";
import { PRODUCT_INFO } from "../src/productInfo.js";
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

const protocolFixture = (name: string): string => path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  `fake-codex-app-server-${name}.mjs`
);

describe("CodexAppServerUpstreamPool", () => {
  it("uses stable release client identity for every App Server handshake", () => {
    expect(APP_SERVER_CLIENT_INFO).toEqual({
      name: PRODUCT_INFO.runtimeName,
      title: PRODUCT_INFO.displayName,
      version: BRIDGE_BUILD_INFO.version
    });
    expect(Object.isFrozen(APP_SERVER_CLIENT_INFO)).toBe(true);
  });

  it("reports only aggregate App Server worker and resume health", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1, {}, {
      workerMetricsProbe: async () => ({ rssKb: 4_096, fdCount: 12 })
    });
    try {
      await expect(pool.listTools()).resolves.toMatchObject({
        backendKind: "app-server",
        experimental: true,
        workerHealth: {
          configured: 1,
          live: 0,
          starting: 0,
          activeCalls: 0,
          stickyThreads: 0
        },
        resumeEvidence: { available: 0, unavailable: 0 }
      });
      await pool.listModels();
      await expect(pool.listTools()).resolves.toMatchObject({
        workerHealth: {
          configured: 1,
          live: 1,
          activeCalls: 0,
          resources: {
            observedWorkers: 1,
            rssKb: { samples: 1, total: 4_096, max: 4_096 },
            fdCount: { samples: 1, total: 12, max: 12 }
          },
          startup: {
            spawnCount: 1,
            failureCount: 0,
            latencyMs: { samples: 1, average: expect.any(Number) }
          },
          crashes: { count: 0, ratePerSpawn: 0 },
          initialization: {
            protocol: { ready: 1 },
            config: { ready: 1, warning: 0 },
            mcpServers: { observed: 1, ready: 1, failed: 0 }
          }
        }
      });
      expect(JSON.stringify(await pool.listTools())).not.toContain("fake-thread");
    } finally {
      await pool.close();
    }
  });

  it("rejects an unsupported configured CLI before admitting an App Server worker", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1, {}, {
      versionProbe: async () => "0.144.0"
    });
    try {
      await expect(pool.listModels()).rejects.toThrow(
        `Configured Codex executable ${JSON.stringify(FIXTURE)} reported version 0.144.0; ` +
        `this bridge supports exactly Codex CLI ${SUPPORTED_CODEX_CLI_VERSION}`
      );
    } finally {
      await pool.close();
    }
  });

  it("deduplicates concurrent version probes for one worker admission", async () => {
    let probes = 0;
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1, {}, {
      versionProbe: async () => {
        probes += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return SUPPORTED_CODEX_CLI_VERSION;
      }
    });
    try {
      await Promise.all([pool.listModels(), pool.listModels()]);
      expect(probes).toBe(1);
    } finally {
      await pool.close();
    }
  });

  it("cancels an in-flight executable admission check when the pool closes", async () => {
    let observedSignal: AbortSignal | undefined;
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1, {}, {
      versionProbe: async (_command, _timeoutMs, signal) => {
        observedSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("fixture admission aborted")), { once: true });
        });
      }
    });
    const rejected = expect(pool.listModels()).rejects.toThrow(/could not be verified with --version/);
    await eventually(() => Boolean(observedSignal));
    await pool.close();
    await rejected;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("closes a starting worker immediately and clears its initialize request", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    const pool = new CodexAppServerUpstreamPool(
      protocolFixture("init-timeout"),
      1,
      { initializeTimeoutMs: 750, requestTimeoutMs: 2_000 },
      { versionProbe: async () => SUPPORTED_CODEX_CLI_VERSION }
    );
    const running = pool.listModels();
    const settled = running.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const workers = (pool as unknown as {
      workers: Array<{
        startingConnection?: {
          rpc: {
            identity?: JsonRpcProcessIdentity;
            pendingRequestCount: number;
          };
        };
      }>;
    }).workers;

    try {
      await eventually(() => workers[0]?.startingConnection?.rpc.pendingRequestCount === 1);
      const rpc = workers[0]!.startingConnection!.rpc;
      const identity = rpc.identity;
      expect(identity).toBeDefined();

      const closing = pool.close();
      await eventually(() => rpc.pendingRequestCount === 0);
      await closing;

      const result = await settled;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toContain("process was closed");
      }
      expect(rpc.pendingRequestCount).toBe(0);
      await eventually(() => !processIdentityAlive(identity!));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      await pool.close();
    }
  }, 5_000);

  it.each([
    ["init-error", 2_000, "fixture initialization rejected"],
    ["init-timeout", 25, "initialize timed out after 25ms"],
    ["init-incompatible", 2_000, "missing string field(s): platformFamily, platformOs"]
  ])(
    "terminates the worker process group when %s prevents startup",
    async (fixtureName, initializeTimeoutMs, expectedMessage) => {
      const pool = new CodexAppServerUpstreamPool(protocolFixture(fixtureName), 1, {
        initializeTimeoutMs,
        requestTimeoutMs: 2_000
      });
      try {
        let failure: unknown;
        try {
          await pool.listModels();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain(expectedMessage);
        const identity = (failure as Error & { processIdentity?: JsonRpcProcessIdentity }).processIdentity;
        expect(identity).toMatchObject({
          pid: expect.any(Number),
          processGroupId: process.platform === "win32" ? null : expect.any(Number)
        });
        await eventually(() => !processIdentityAlive(identity!));
      } finally {
        await pool.close();
      }
    },
    5_000
  );

  it("reports late bounded control responses without corrupting newer requests", async () => {
    const lateResponses: CodexAppServerLateResponse[] = [];
    const pool = new CodexAppServerUpstreamPool(protocolFixture("late-control"), 1, {
      initializeTimeoutMs: 2_000,
      requestTimeoutMs: 100,
      onLateResponse: (response) => lateResponses.push(response)
    });
    try {
      await expect(pool.listModels()).rejects.toMatchObject({
        code: -32001,
        requestId: 2,
        method: "model/list",
        timeoutMs: 100
      });
      await expect(pool.listModels()).resolves.toEqual({ data: [], nextCursor: null });
      await eventually(() => lateResponses.length === 1);
      expect(lateResponses[0]).toMatchObject({
        workerId: "app-0",
        workerGeneration: 1,
        requestId: 2,
        method: "model/list",
        response: { id: 2, result: { data: [], nextCursor: null } }
      });
    } finally {
      await pool.close();
    }
  });

  it("rejects invalid protocol timeouts before starting a worker", () => {
    expect(
      () => new CodexAppServerUpstreamPool(FIXTURE, 1, { requestTimeoutMs: 0 })
    ).toThrow("requestTimeoutMs must be an integer between 1");
  });

  it("exposes the backend model catalog and applies exact turn-level continuation overrides", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    try {
      const catalog = await pool.listModels() as { data: Array<Record<string, unknown>> };
      expect(catalog.data[0]).toMatchObject({
        model: "gpt-5.6-sol",
        defaultReasoningEffort: "max",
        isDefault: true
      });
      const started = await pool.startThread!({
        backendKind: "app-server",
        prompt: "report selection",
        cwd: process.cwd(),
        sandbox: "read-only",
        approvalPolicy: "on-request",
        selection: {
          model: "gpt-5.6-sol",
          reasoningEffort: "max",
          serviceTier: "priority"
        }
      });
      expect(started.content).toEqual([
        {
          type: "text",
          text: 'SELECTION:{"model":"gpt-5.6-sol","effort":"max","serviceTier":"priority"}'
        }
      ]);
      const threadId = (started.structuredContent as { threadId: string }).threadId;
      const continued = await pool.continueThread!({
        backendKind: "app-server",
        threadId,
        prompt: "report selection",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      });
      expect(continued.content).toEqual([
        {
          type: "text",
          text: 'SELECTION:{"model":"gpt-5.6-terra","effort":"high","serviceTier":null}'
        }
      ]);
    } finally {
      await pool.close();
    }
  }, 15_000);

  it("creates hidden App Server starts and forks as ephemeral threads", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    try {
      const hidden = await pool.startThread!({
        backendKind: "app-server",
        prompt: "report ephemeral start",
        cwd: process.cwd(),
        sandbox: "read-only",
        approvalPolicy: "on-request",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        ephemeral: true
      });
      expect(hidden.content).toEqual([{ type: "text", text: "EPHEMERAL:true" }]);

      const visible = await pool.startThread!({
        backendKind: "app-server",
        prompt: "report ephemeral default",
        cwd: process.cwd(),
        sandbox: "read-only",
        approvalPolicy: "on-request",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      });
      expect(visible.content).toEqual([{ type: "text", text: "EPHEMERAL:false" }]);

      const sourceThreadId = (visible.structuredContent as { threadId: string }).threadId;
      const hiddenFork = await pool.forkThread!({
        backendKind: "app-server",
        threadId: sourceThreadId,
        prompt: "report ephemeral fork",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
        ephemeral: true
      });
      expect(hiddenFork.content).toEqual([{ type: "text", text: "EPHEMERAL:true" }]);
    } finally {
      await pool.close();
    }
  }, 15_000);

  it("fails closed with actionable structured recovery for context-window exhaustion", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    try {
      const result = await pool.startThread!({
        backendKind: "app-server",
        prompt: "context window exceeded",
        cwd: process.cwd(),
        sandbox: "read-only",
        approvalPolicy: "on-request",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          turnStatus: "failed",
          error: {
            code: "CONTEXT_WINDOW_EXCEEDED",
            retryable: true,
            upstreamKind: "contextWindowExceeded",
            nextActions: expect.arrayContaining([
              expect.stringContaining("context='fresh'"),
              expect.stringContaining("larger context window")
            ])
          }
        }
      });
    } finally {
      await pool.close();
    }
  });

  it("recovers a durable thread after worker crash, pool reassignment, terminal cleanup, and pool restart", async () => {
    const fixture = protocolFixture("crash-resume");
    const pool = new CodexAppServerUpstreamPool(fixture, 1, {}, {
      workerMetricsProbe: async () => ({ rssKb: 8_192, fdCount: 24 })
    });
    let assignment: UpstreamWorkerAssignment | undefined;
    try {
      await expect(pool.startThread!({
        backendKind: "app-server",
        prompt: "crash worker",
        cwd: process.cwd(),
        sandbox: "read-only",
        approvalPolicy: "on-request",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      }, undefined, (value) => {
        assignment = value;
      })).rejects.toThrow(/exited|closed/i);
      expect(assignment).toMatchObject({
        workerId: "app-0",
        workerGeneration: 1,
        threadId: "durable-crash-thread"
      });
      await expect(pool.listTools()).resolves.toMatchObject({
        workerHealth: { crashes: { count: 1 } }
      });

      const resumed = await pool.continueThread!({
        backendKind: "app-server",
        threadId: "durable-crash-thread",
        prompt: "resume on replacement worker",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      });
      expect(resumed).toMatchObject({
        content: [{ type: "text", text: "RESUMED AFTER CRASH" }],
        structuredContent: {
          threadId: "durable-crash-thread",
          sessionId: "durable-crash-session",
          turnStatus: "completed"
        }
      });
      await expect(pool.listBackgroundTerminals("durable-crash-thread")).resolves.toHaveLength(1);
      await expect(
        pool.terminateBackgroundTerminal("durable-crash-thread", "durable-background-1")
      ).resolves.toEqual({ terminated: true });
      await expect(pool.listTools()).resolves.toMatchObject({
        workerHealth: {
          startup: { spawnCount: 2, failureCount: 0 },
          crashes: { count: 1, ratePerSpawn: 0.5 },
          resources: { rssKb: { max: 8_192 }, fdCount: { max: 24 } }
        }
      });
    } finally {
      await pool.close();
    }

    const restarted = new CodexAppServerUpstreamPool(fixture, 1);
    try {
      await expect(restarted.continueThread!({
        backendKind: "app-server",
        threadId: "durable-crash-thread",
        prompt: "resume after bridge restart",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      })).resolves.toMatchObject({
        content: [{ type: "text", text: "RESUMED AFTER CRASH" }],
        structuredContent: {
          threadId: "durable-crash-thread",
          sessionId: "durable-crash-session"
        }
      });
    } finally {
      await restarted.close();
    }
  }, 15_000);

  it("forks, archives, restores, and resumes exact App Server threads", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    try {
      const started = await pool.startThread!({
        backendKind: "app-server",
        prompt: "source context",
        cwd: process.cwd(),
        sandbox: "read-only",
        approvalPolicy: "on-request",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      });
      const sourceThreadId = (started.structuredContent as { threadId: string }).threadId;
      const forked = await pool.forkThread!({
        backendKind: "app-server",
        threadId: sourceThreadId,
        prompt: "forked context",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      });
      const forkedThreadId = (forked.structuredContent as { threadId: string }).threadId;
      expect(sourceThreadId).toBe("fake-thread-1");
      expect(forkedThreadId).toBe("fake-thread-2");
      expect(started.structuredContent).toMatchObject({ sessionId: "fake-session-1" });
      expect(forked.structuredContent).toMatchObject({
        backendKind: "app-server",
        turnStatus: "completed",
        sessionId: "fake-session-1",
        forkedFromThreadId: sourceThreadId
      });

      await expect(pool.archiveThread!(forkedThreadId, "app-server")).resolves.toBeUndefined();
      await expect(pool.restoreThread!(forkedThreadId, "app-server")).resolves.toBeUndefined();
      await expect(pool.listBackgroundTerminals!(forkedThreadId, "app-server")).resolves.toEqual([]);
      await expect(pool.archiveThread!(forkedThreadId, "app-server")).resolves.toBeUndefined();
      await expect(pool.restoreThread!(forkedThreadId, "app-server")).resolves.toBeUndefined();
      await expect(pool.continueThread!({
        backendKind: "app-server",
        threadId: forkedThreadId,
        prompt: "resumed after restore",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      })).resolves.toMatchObject({
        structuredContent: { threadId: forkedThreadId, turnStatus: "completed" }
      });
    } finally {
      await pool.close();
    }
  }, 15_000);

  it("classifies exact thread/read runtime state without orphaning transient activity", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    try {
      await expect(pool.probeThread("missing-thread")).resolves.toEqual({
        state: "orphaned",
        reason: "missing",
        threadId: "missing-thread",
        retryable: false
      });
      expect(pool.canResumeThread("missing-thread")).toBe(false);

      const started = await pool.callTool("codex", task("probe idle"));
      const threadId = (started.structuredContent as { threadId: string }).threadId;
      await expect(pool.probeThread(threadId)).resolves.toEqual({
        state: "resumable",
        runtimeStatus: "idle",
        threadId,
        sessionId: "fake-session-1"
      });

      await pool.archiveThread(threadId);
      await pool.restoreThread(threadId);
      await expect(pool.probeThread(threadId)).resolves.toEqual({
        state: "resumable",
        runtimeStatus: "notLoaded",
        threadId,
        sessionId: "fake-session-1"
      });

      let assignment: UpstreamWorkerAssignment | undefined;
      const active = pool.callTool(
        "codex-reply",
        { ...task("hold for probe"), threadId },
        undefined,
        (value) => { assignment = value; }
      );
      await eventually(() => Boolean(assignment?.upstreamRequestId));
      await expect(pool.probeThread(threadId)).resolves.toEqual({
        state: "busy",
        runtimeStatus: "active",
        threadId,
        retryable: true,
        sessionId: "fake-session-1"
      });
      expect(pool.canResumeThread(threadId)).toBe(true);
      await pool.forceTerminateWorker(assignment!, {
        kind: "cancellation-intent",
        intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        source: "operator",
        reasonCode: "test-interrupt"
      });
      await active;

      const corrupt = await pool.callTool("codex", task("mark thread system error"));
      const corruptThreadId = (corrupt.structuredContent as { threadId: string }).threadId;
      await expect(pool.probeThread(corruptThreadId)).resolves.toEqual({
        state: "orphaned",
        reason: "system-error",
        threadId: corruptThreadId,
        retryable: false
      });
      expect(pool.canResumeThread(corruptThreadId)).toBe(false);
    } finally {
      await pool.close();
    }
  }, 15_000);

  it("lists and terminates exact background terminals after a turn completes", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    try {
      const result = await pool.startThread!({
        backendKind: "app-server",
        prompt: "leave background terminal",
        cwd: process.cwd(),
        sandbox: "read-only",
        approvalPolicy: "on-request",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      });
      const threadId = (result.structuredContent as { threadId: string }).threadId;
      await expect(pool.listBackgroundTerminals!(threadId, "app-server")).resolves.toEqual([
        expect.objectContaining({
          processId: "background-process-1",
          itemId: "background-item-1",
          osPid: 43210
        })
      ]);
      await expect(
        pool.terminateBackgroundTerminal!(threadId, "background-process-1", "app-server")
      ).resolves.toEqual({ terminated: true });
      await expect(pool.listBackgroundTerminals!(threadId, "app-server")).resolves.toEqual([]);
      await expect(
        pool.terminateBackgroundTerminal!(threadId, "background-process-1", "app-server")
      ).resolves.toEqual({ terminated: false });
    } finally {
      await pool.close();
    }
  }, 15_000);

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
        expect.arrayContaining([
          "turn",
          "plan",
          "agent-message",
          "command",
          "file-change",
          "warning",
          "model",
          "context",
          "mcp",
          "collaboration",
          "usage"
        ])
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "command", phase: "completed" }),
          expect.objectContaining({ type: "file-change", phase: "completed" }),
          expect.objectContaining({ type: "agent-message", phase: "updated" })
        ])
      );
      expect(JSON.stringify(events)).not.toContain("PRIVATE_REASONING_MUST_NEVER_APPEAR");
      expect(JSON.stringify(events)).not.toContain("PRIVATE_MCP_ARGUMENT_MUST_NEVER_APPEAR");
      expect(JSON.stringify(events)).not.toContain("PRIVATE_MCP_RESULT_MUST_NEVER_APPEAR");
      expect(JSON.stringify(events)).not.toContain("PRIVATE_COLLAB_PROMPT_MUST_NEVER_APPEAR");
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

  it("interrupts and forgets a turn when assignment persistence fails", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    const assignmentFailure = new Error("fixture assignment persistence failed");
    let assignment: UpstreamWorkerAssignment | undefined;
    try {
      const failedCall = pool.callTool(
        "codex",
        task("hold for assignment persistence failure with delayed interrupt"),
        undefined,
        (value) => {
          assignment = value;
          if (value.upstreamRequestId) throw assignmentFailure;
        }
      );
      const observedFailure = failedCall.then(
        () => undefined,
        (error: unknown) => error
      );

      await eventually(() => Boolean(assignment?.upstreamRequestId));

      expect(assignment).toMatchObject({
        threadId: "fake-thread-1",
        upstreamRequestId: "fake-turn-1"
      });
      await expect(
        pool.callTool("codex-reply", {
          ...task("must remain serialized until interrupted completion"),
          threadId: assignment!.threadId
        })
      ).rejects.toThrow("already active for this thread");
      expect(await observedFailure).toBe(assignmentFailure);
      await expect(pool.steerThread(assignment!.threadId!, "should not steer")).rejects.toThrow(
        "has no active turn to steer"
      );
      await expect(
        pool.callTool("codex-reply", {
          ...task("report interrupt count"),
          threadId: assignment!.threadId
        })
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "INTERRUPTS:1" }],
        structuredContent: {
          threadId: assignment!.threadId,
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
      expect(command).toMatchObject({
        reason: "Fixture network approval",
        cwdLabel: path.basename(process.cwd()),
        networkContext: { host: "example.test", protocol: "https" },
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
        commandActions: [{ type: "read", pathLabel: "fixture.txt" }],
        proposedAmendments: {
          execPolicy: ["echo", "approved"],
          networkPolicy: [{ host: "example.test", action: "allow" }]
        }
      });
      await pool.respondToInteraction(command.interactionId, { decision: "accept" });

      const file = await nextInteraction(interactions, "file-approval");
      expect(file.interactionId).toContain("902");
      expect(file.grantRootLabel).toBe(path.basename(process.cwd()));
      await pool.respondToInteraction(file.interactionId, { decision: "decline" });

      const input = await nextInteraction(interactions, "user-input");
      expect(input.questions).toEqual([
        expect.objectContaining({ id: "color", question: "Choose a color" })
      ]);
      await pool.respondToInteraction(input.interactionId, { answers: { color: ["blue"] } });

      const permission = await nextInteraction(interactions, "permission-approval");
      expect(permission.summary).toContain("Need fixture access");
      expect(permission.requestedPermissions).toMatchObject({
        networkEnabled: true,
        filesystemRead: [path.basename(process.cwd())],
        filesystemWrite: [path.basename(process.cwd())]
      });
      await pool.respondToInteraction(permission.interactionId, { decision: "acceptForSession" });

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

  it("clears an automatically resolved server request without sending a duplicate response", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    const interactions: CodexPendingInteraction[] = [];
    const events: CodexPublicEvent[] = [];
    try {
      const running = pool.callTool("codex", task("auto resolve input"), (progress) => {
        if (progress.event) events.push(progress.event);
        const interaction = progress.event?.details?.interaction;
        if (isInteraction(interaction)) interactions.push(interaction);
      });
      const input = await nextInteraction(interactions, "user-input");
      expect(input).toMatchObject({
        autoResolutionMs: 100,
        expiresAt: expect.any(Number)
      });
      await expect(running).resolves.toMatchObject({
        content: [{ type: "text", text: "AUTO INPUT RESOLVED" }],
        structuredContent: { turnStatus: "completed" }
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "input-required",
          phase: "completed",
          details: {
            resolvedInteractionId: input.interactionId,
            resolution: "server-resolved"
          }
        })
      ]));
      await expect(
        pool.respondToInteraction(input.interactionId, { answers: { auto: ["late"] } })
      ).rejects.toThrow("Unknown or already resolved");
    } finally {
      await pool.close();
    }
  }, 15_000);

  it("expires a timed user-input request locally when the resolved notification is absent", async () => {
    const pool = new CodexAppServerUpstreamPool(FIXTURE, 1);
    const interactions: CodexPendingInteraction[] = [];
    const events: CodexPublicEvent[] = [];
    try {
      const running = pool.callTool("codex", task("expire input locally"), (progress) => {
        if (progress.event) events.push(progress.event);
        const interaction = progress.event?.details?.interaction;
        if (isInteraction(interaction)) interactions.push(interaction);
      });
      const input = await nextInteraction(interactions, "user-input");
      expect(input.autoResolutionMs).toBe(20);
      await expect(running).resolves.toMatchObject({
        content: [{ type: "text", text: "LOCAL INPUT EXPIRED" }],
        structuredContent: { turnStatus: "completed" }
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "input-required",
          phase: "completed",
          details: {
            resolvedInteractionId: input.interactionId,
            resolution: "expired"
          }
        })
      ]));
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
      await eventually(() => Boolean(assignment?.upstreamRequestId));
      expect(pool.canSteerThread(assignment!.threadId!)).toBe(true);
      await expect(pool.steerThread(assignment!.threadId!, "new direction")).resolves.toEqual({
        turnId: assignment!.upstreamRequestId
      });
      await expect(running).resolves.toMatchObject({
        content: [{ type: "text", text: "STEERED:new direction" }],
        structuredContent: { threadId: assignment!.threadId, turnStatus: "completed" }
      });
      expect(pool.canSteerThread(assignment!.threadId!)).toBe(false);

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
      await expect(
        pool.forceTerminateWorker(assignment!, undefined as never)
      ).rejects.toThrow(/TERMINATION_PROVENANCE_REQUIRED/);
      await expect(pool.forceTerminateWorker(assignment!, {
        kind: "cancellation-intent",
        intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        source: "operator",
        reasonCode: "test-interrupt"
      }, 100)).resolves.toMatchObject({
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

function processIdentityAlive(identity: JsonRpcProcessIdentity): boolean {
  try {
    process.kill(identity.processGroupId === null ? identity.pid : -identity.processGroupId, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}
