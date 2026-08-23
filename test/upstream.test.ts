import { describe, expect, it } from "vitest";
import {
  CodexStdioUpstream,
  CodexUpstreamPool,
  type CodexConnectionFactory,
  type CodexMcpClient,
  type ToolResult
} from "../src/upstream.js";

describe("CodexStdioUpstream", () => {
  it("maps exact selections into the MCP start contract and rejects continuation overrides", async () => {
    let observed: { name: string; arguments: Record<string, unknown> } | undefined;
    const upstream = new CodexStdioUpstream("codex", async () => ({
      client: {
        async listTools() {
          return { tools: [] };
        },
        async callTool(input) {
          observed = input;
          return result("selection-thread");
        },
        async close() {}
      },
      transport: { async close() {} }
    }));

    await upstream.startThread!({
      backendKind: "mcp-server",
      prompt: "start",
      cwd: "/tmp/project",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      selection: {
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        serviceTier: "priority"
      }
    });
    expect(observed).toMatchObject({
      name: "codex",
      arguments: {
        model: "gpt-5.6-sol",
        config: { model_reasoning_effort: "max", service_tier: "priority" }
      }
    });
    expect(observed?.arguments).not.toHaveProperty("serviceTier");
    await expect(upstream.continueThread!({
      backendKind: "mcp-server",
      threadId: "selection-thread",
      prompt: "continue",
      selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
    })).rejects.toThrow(/cannot override model selection/);
    await upstream.close();
  });

  it("forwards MCP progress notifications to the job observer", async () => {
    let observedOptions: Record<string, unknown> | undefined;
    const progress: Array<{ progress: number; total?: number; message?: string }> = [];
    const upstream = new CodexStdioUpstream("codex", async () => ({
      client: {
        async listTools() {
          return { tools: [] };
        },
        async callTool(_input, _schema, options) {
          observedOptions = options;
          options?.onprogress?.({ progress: 2, total: 5, message: "working" });
          return result("progress-thread");
        },
        async close() {}
      },
      transport: { async close() {} }
    }));

    await upstream.callTool("progress", {}, (update) => progress.push(update));

    expect(observedOptions).toMatchObject({ resetTimeoutOnProgress: true });
    expect(observedOptions).not.toHaveProperty("timeout");
    expect(progress).toEqual([{ progress: 2, total: 5, message: "working" }]);
    await upstream.close();
  });

  it("retires a connection after a transport-level request failure", async () => {
    let factoryCalls = 0;
    let clientCloses = 0;
    const factory: CodexConnectionFactory = async () => {
      factoryCalls += 1;
      const client: CodexMcpClient = {
        async listTools() {
          return { tools: [] };
        },
        async callTool(input) {
          if (input.name === "timeout") throw Object.assign(new Error("timed out"), { code: -32001 });
          return result("same-connection");
        },
        async close() {
          clientCloses += 1;
        }
      };
      return { client, transport: { async close() {} } };
    };
    const upstream = new CodexStdioUpstream("codex", factory);

    await expect(upstream.callTool("timeout", {})).rejects.toMatchObject({ code: -32001 });
    await expect(upstream.callTool("next", {})).resolves.toMatchObject({
      structuredContent: { threadId: "same-connection" }
    });
    expect(factoryCalls).toBe(2);
    expect(clientCloses).toBe(1);

    await upstream.close();
    expect(clientCloses).toBe(2);
  });

  it("retires a failed connection without closing it under unrelated in-flight calls", async () => {
    const slow = deferred<ToolResult>();
    const clientCloses: number[] = [];
    let factoryCalls = 0;
    const factory: CodexConnectionFactory = async () => {
      const generation = ++factoryCalls;
      const client: CodexMcpClient = {
        async listTools() {
          return { tools: [] };
        },
        async callTool(input) {
          if (generation === 1 && input.name === "slow") return slow.promise;
          if (generation === 1 && input.name === "fail") throw new Error("transport failed");
          return result(`generation-${generation}`);
        },
        async close() {
          clientCloses.push(generation);
        }
      };
      return { client, transport: { async close() {} } };
    };
    const upstream = new CodexStdioUpstream("codex", factory);

    const slowCall = upstream.callTool("slow", {});
    const failedCall = upstream.callTool("fail", {});
    await expect(failedCall).rejects.toThrow("transport failed");
    expect(clientCloses).toEqual([]);

    await expect(upstream.callTool("next", {})).resolves.toMatchObject({
      structuredContent: { threadId: "generation-2" }
    });
    expect(factoryCalls).toBe(2);
    expect(clientCloses).toEqual([]);

    slow.resolve(result("slow-complete"));
    await expect(slowCall).resolves.toMatchObject({ structuredContent: { threadId: "slow-complete" } });
    expect(clientCloses).toEqual([1]);

    await upstream.close();
    expect(clientCloses).toEqual([1, 2]);
  });

  it("waits for and closes a connection that completes while shutdown is in progress", async () => {
    const pendingConnection = deferred<Awaited<ReturnType<CodexConnectionFactory>>>();
    let clientCloses = 0;
    let transportCloses = 0;
    const upstream = new CodexStdioUpstream("codex", () => pendingConnection.promise);

    const call = upstream.listTools();
    const close = upstream.close();
    pendingConnection.resolve({
      client: {
        async listTools() {
          return { tools: [] };
        },
        async callTool() {
          return result("unused");
        },
        async close() {
          clientCloses += 1;
        }
      },
      transport: {
        async close() {
          transportCloses += 1;
        }
      }
    });

    await expect(call).rejects.toThrow("closed while connecting");
    await close;
    expect(clientCloses).toBe(1);
    expect(transportCloses).toBe(1);
  });

  it("distributes concurrent calls across lazy upstream workers", async () => {
    const pending = [deferred<ToolResult>(), deferred<ToolResult>()];
    const calls: string[][] = [[], []];
    const pool = new CodexUpstreamPool("codex", 2, (index) => async () => ({
      client: {
        async listTools() {
          return { tools: [] };
        },
        async callTool(input) {
          calls[index]?.push(input.name);
          return pending[index]!.promise;
        },
        async close() {}
      },
      transport: { async close() {} }
    }));

    const first = pool.callTool("first", {});
    const second = pool.callTool("second", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([["first"], ["second"]]);

    pending[0]!.resolve(result("first-thread"));
    pending[1]!.resolve(result("second-thread"));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await pool.close();
  });

  it("routes every reply back to the worker that created its thread", async () => {
    const starts = [deferred<ToolResult>(), deferred<ToolResult>()];
    const calls: Array<Array<{ name: string; threadId?: unknown }>> = [[], []];
    const pool = new CodexUpstreamPool("codex", 2, (index) => async () => ({
      client: {
        async listTools() {
          return { tools: [] };
        },
        async callTool(input) {
          calls[index]?.push({ name: input.name, threadId: input.arguments.threadId });
          if (input.name === "codex") return starts[index]!.promise;
          const expected = `thread-${index}`;
          if (input.arguments.threadId !== expected) {
            return {
              isError: true,
              content: [{ type: "text", text: `Session not found: ${String(input.arguments.threadId)}` }]
            };
          }
          return result(expected);
        },
        async close() {}
      },
      transport: { async close() {} }
    }));

    const first = pool.callTool("codex", { prompt: "first" });
    const second = pool.callTool("codex", { prompt: "second" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    starts[0]!.resolve(result("thread-0"));
    starts[1]!.resolve(result("thread-1"));
    await Promise.all([first, second]);

    expect(pool.canResumeThread("thread-0")).toBe(true);
    expect(pool.canResumeThread("thread-1")).toBe(true);
    await expect(
      pool.callTool("codex-reply", { threadId: "thread-1", prompt: "continue second" })
    ).resolves.toMatchObject({ structuredContent: { threadId: "thread-1" } });
    await expect(
      pool.callTool("codex-reply", { threadId: "thread-0", prompt: "continue first" })
    ).resolves.toMatchObject({ structuredContent: { threadId: "thread-0" } });
    expect(calls[0]?.at(-1)).toMatchObject({ name: "codex-reply", threadId: "thread-0" });
    expect(calls[1]?.at(-1)).toMatchObject({ name: "codex-reply", threadId: "thread-1" });
    await pool.close();
  });

  it("refuses a persisted thread that has no binding in the active worker generation", async () => {
    const pool = new CodexUpstreamPool("codex", 1, () => async () => ({
      client: {
        async listTools() {
          return { tools: [] };
        },
        async callTool() {
          return result("unused");
        },
        async close() {}
      },
      transport: { async close() {} }
    }));

    expect(pool.canResumeThread("persisted-thread")).toBe(false);
    await expect(
      pool.callTool("codex-reply", { threadId: "persisted-thread", prompt: "continue" })
    ).rejects.toThrow(/not available in the active MCP worker generation/);
    await pool.close();
  });
});

function result(threadId: string): ToolResult {
  return {
    content: [{ type: "text", text: threadId }],
    structuredContent: { threadId }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
