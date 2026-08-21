import { describe, expect, it } from "vitest";
import {
  CodexStdioUpstream,
  CodexUpstreamPool,
  type CodexConnectionFactory,
  type CodexMcpClient,
  type ToolResult
} from "../src/upstream.js";

describe("CodexStdioUpstream", () => {
  it("keeps the current connection after an isolated request timeout", async () => {
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

    await expect(upstream.callTool("timeout", {}, 10)).rejects.toMatchObject({ code: -32001 });
    await expect(upstream.callTool("next", {}, 10)).resolves.toMatchObject({
      structuredContent: { threadId: "same-connection" }
    });
    expect(factoryCalls).toBe(1);
    expect(clientCloses).toBe(0);

    await upstream.close();
    expect(clientCloses).toBe(1);
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

    const slowCall = upstream.callTool("slow", {}, 1000);
    const failedCall = upstream.callTool("fail", {}, 1000);
    await expect(failedCall).rejects.toThrow("transport failed");
    expect(clientCloses).toEqual([]);

    await expect(upstream.callTool("next", {}, 1000)).resolves.toMatchObject({
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

    const first = pool.callTool("first", {}, 1000);
    const second = pool.callTool("second", {}, 1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([["first"], ["second"]]);

    pending[0]!.resolve(result("first-thread"));
    pending[1]!.resolve(result("second-thread"));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
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
