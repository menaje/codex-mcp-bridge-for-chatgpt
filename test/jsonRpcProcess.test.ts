import { describe, expect, it } from "vitest";
import { JsonRpcProcess } from "../src/jsonRpcProcess.js";

const FAKE_SERVER = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let heldId;
let parentId;
let omitted = false;
const send = (message) => process.stdout.write(JSON.stringify(omitted ? message : { jsonrpc: "2.0", ...message }) + "\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  omitted = message.jsonrpc === undefined;
  if (message.method === "echo") return send({ id: message.id, result: message.params });
  if (message.method === "hold") { heldId = message.id; return; }
  if (message.method === "release") {
    send({ id: message.id, result: {} });
    if (heldId !== undefined) { send({ id: heldId, result: { released: true } }); heldId = undefined; }
    return;
  }
  if (message.method === "ask-client") {
    parentId = message.id;
    return send({ id: "server-request-7", method: "approval", params: { exact: true } });
  }
  if (message.id === "server-request-7") {
    return send({ id: parentId, result: { clientResponse: message.result } });
  }
  if (message.method === "spawn-child") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    return send({ id: message.id, result: { childPid: child.pid } });
  }
});
`;

function processFor(options: {
  omitJsonRpcHeader?: boolean;
  onRequest?: (method: string, params: unknown, requestId: number | string) => unknown;
  onExit?: (error: Error) => void;
} = {}) {
  return new JsonRpcProcess({
    command: process.execPath,
    args: ["-e", FAKE_SERVER],
    debugLabel: "fake-jsonrpc",
    ...options
  });
}

describe("JsonRpcProcess", () => {
  it("supports regular JSON-RPC and Codex App Server's headerless JSONL dialect", async () => {
    const regular = processFor();
    const headerless = processFor({ omitJsonRpcHeader: true });
    try {
      await expect(regular.request("echo", { mode: "mcp" }, { timeoutMs: 2_000 })).resolves.toEqual({ mode: "mcp" });
      await expect(headerless.request("echo", { mode: "app" }, { timeoutMs: 2_000 })).resolves.toEqual({ mode: "app" });
    } finally {
      await Promise.all([regular.close(), headerless.close()]);
    }
  });

  it("preserves exact server request IDs on the bidirectional path", async () => {
    const observed: Array<number | string> = [];
    const rpc = processFor({
      omitJsonRpcHeader: true,
      onRequest(method, params, requestId) {
        observed.push(requestId);
        return { method, params, requestId };
      }
    });
    try {
      await expect(rpc.request("ask-client", {}, { timeoutMs: 2_000 })).resolves.toEqual({
        clientResponse: {
          method: "approval",
          params: { exact: true },
          requestId: "server-request-7"
        }
      });
      expect(observed).toEqual(["server-request-7"]);
    } finally {
      await rpc.close();
    }
  });

  it("keeps a turn request pending without a deadline until the backend completes it", async () => {
    const rpc = processFor({ omitJsonRpcHeader: true });
    try {
      const held = rpc.request<{ released: boolean }>("hold");
      const early = await Promise.race([
        held.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100))
      ]);
      expect(early).toBe("pending");
      await rpc.request("release", {}, { timeoutMs: 2_000 });
      await expect(held).resolves.toEqual({ released: true });
    } finally {
      await rpc.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "force-stops the exact detached process group, including descendants",
    async () => {
      const rpc = processFor({ omitJsonRpcHeader: true });
      const identity = await rpc.start();
      const { childPid } = await rpc.request<{ childPid: number }>("spawn-child", {}, { timeoutMs: 2_000 });
      expect(processAlive(identity.pid)).toBe(true);
      expect(processAlive(childPid)).toBe(true);

      const terminated = await rpc.forceTerminate(1_000);
      expect(terminated).toMatchObject({
        pid: identity.pid,
        processGroupId: identity.processGroupId,
        exited: true,
        mode: "process-group",
        workerExited: true
      });
      await eventually(() => !processAlive(childPid));
      expect(rpc.exited).toBe(true);
    }
  );

  it("rejects timer-free pending work when the supervised process exits", async () => {
    const exits: string[] = [];
    const rpc = processFor({
      omitJsonRpcHeader: true,
      onExit: (error) => exits.push(error.message)
    });
    const held = rpc.request("hold");
    const rejected = expect(held).rejects.toThrow(/exited/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rpc.forceTerminate(500);
    await rejected;
    expect(exits).toHaveLength(1);
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true before timeout.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
