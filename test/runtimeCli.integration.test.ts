import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";

it.each(["cli", "stdio"])("starts native and remote app connections in the built %s entrypoint", async (entrypoint) => {
  const root = mkdtempSync(path.join(tmpdir(), "cb-cli-"));
  const socketPath = path.join(root, "run", "b.sock");
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, [path.resolve(process.env.CODEX_BRIDGE_TEST_RUNTIME_DIST || "dist", `${entrypoint}.js`)], {
    env: {
      PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
      CODEX_MCP_BRIDGE_PORT: String(port), CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
      CODEX_MCP_BRIDGE_COMPANION_SOCKET: socketPath,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
      CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE: path.join(root, "settings.json"),
      CODEX_MCP_BRIDGE_SESSION_STATE_FILE: path.join(root, "sessions.json"),
      CODEX_MCP_BRIDGE_JOB_STATE_FILE: path.join(root, "jobs.json"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const client = new Client({ name: "built-http-native", version: "0.0.0" });
  try {
    for (let count = 0; count < 100; count++) {
      const ready = entrypoint === "cli" ? output.includes("listening on http://") : output.includes("persistent stdio ready");
      if (ready && existsSync(socketPath)) break;
      if (child.exitCode !== null) throw new Error(output);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(existsSync(socketPath), output).toBe(true);
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    expect(await rpc(socketPath, "companion.hello")).toMatchObject({ protocol: { name: "codex-mcp-bridge-companion", version: 2 } });
    expect(await rpc(socketPath, "remote.status")).toMatchObject({ enabled: false, listening: false });
    const native = await rpc(socketPath, "dashboard.snapshot", { enrich: false });
    expect(native).toMatchObject({ enrichment: { state: "structural" }, counts: { trackedConversations: 0 } });
    if (entrypoint === "cli") {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const card = await client.callTool({ name: "codex_dashboard_snapshot", arguments: { widgetInstanceId: randomUUID(), enrich: false } });
      expect(card.isError).not.toBe(true);
      expect(card.structuredContent?.counts).toEqual(native.counts);
    }
    expect(await rpc(socketPath, "runtime.beginDrain")).toMatchObject({ acceptingNewJobs: false, activeJobs: 0, pendingAdmissions: 0 });
    expect(await rpc(socketPath, "runtime.cancelDrain")).toMatchObject({ acceptingNewJobs: true });
    child.kill("SIGTERM");
    expect(await exited, output).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
  } finally {
    await client.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000);
    await exited;
    clearTimeout(force);
  }
}, 15000);

async function rpc(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setTimeout(5000, () => socket.destroy(new Error(`${method} timed out`)));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      socket.end();
      const response = JSON.parse(buffer.split("\n")[0]);
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    });
  });
}
