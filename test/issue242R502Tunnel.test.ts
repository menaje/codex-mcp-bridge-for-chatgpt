import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { issue242Fixture } from "../scripts/issue-242-fixture.js";
import { createIsolatedHttpServer } from "../src/runtimeProcess.js";
import type { BridgeHttpServer } from "../src/server.js";

const redirect = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:http", async importOriginal => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, request: (options: import("node:http").RequestOptions, callback: (res: import("node:http").IncomingMessage) => void) =>
    actual.request(options.path === "/mcp?fixture=r502-tunnel" ? { ...options, port: redirect.port } : options, callback) };
});

// Explicit local fixture opt-in. This never launches the production tunnel,
// uses its profiles, reads its logs, or talks to a hosted control plane.
const binary = process.env.ISSUE_242_R502_TUNNEL_BINARY;
let fixture: Awaited<ReturnType<typeof issue242Fixture>>;
let upstream: Server, bridge: BridgeHttpServer;
const tunnelProcesses = new Set<ChildProcess>();
const results: unknown[] = [];
let bridgePort: number;
let version = "";

beforeAll(async () => {
  if (!binary) return;
  version = (await promisify(execFile)(binary, ["--version"], { timeout: 3_000, maxBuffer: 2_048 })).stdout.trim();
  expect(version).toContain("0.0.14+0f870e50a973fa820d4c409000059e181e8d242b");
  fixture = await issue242Fixture(0);
  fixture.store.close();
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.once("end", () => {
      const call = JSON.parse(body || "{}");
      const send = (result: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
      };
      if (call.method === "initialize") {
        send({ protocolVersion: call.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: "r502-fixture", version: "1" } });
      } else if (call.method === "tools/list") {
        send({ tools: [{ name: "r502_fault", description: "Isolated transport fault fixture", inputSchema: {
          type: "object", properties: { mode: { type: "string" } } } }] });
      } else if (call.method === "tools/call") {
        const mode = call.params.arguments.mode;
        if (mode === "pre") req.socket.resetAndDestroy();
        else if (mode === "post") {
          res.writeHead(200, { "content-type": "application/json", "content-length": 200 });
          res.write('{"jsonrpc":"2.0","result":');
          setTimeout(() => req.socket.resetAndDestroy(), 20);
        } else if (mode === "idle") { /* Bounded by proxy/fixture teardown. */ }
        else setTimeout(() => send({ content: [{ type: "text", text: "synthetic" }] }),
          mode === "delay-2500" ? 2500 : mode === "delay-4500" ? 4500 : 0);
      } else if (call.id !== undefined) send({});
      else { res.statusCode = 202; res.end(); }
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  redirect.port = (upstream.address() as { port: number }).port;
  bridge = await createIsolatedHttpServer(fixture.config, { childEnvironment: fixture.environment,
    proxyDiagnostics: { idleTimeoutMs: 200, observe: () => {} } });
  await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
  bridgePort = (bridge.address() as { port: number }).port;
}, 30_000);

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await ended;
  clearTimeout(force);
  tunnelProcesses.delete(child);
}

afterAll(async () => {
  for (const child of tunnelProcesses) await stop(child);
  if (bridge) await new Promise<void>(resolve => bridge.close(() => resolve()));
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
  await fixture?.close();
  if (binary && process.env.ISSUE_242_R502_TUNNEL_REPORT) await writeFile(process.env.ISSUE_242_R502_TUNNEL_REPORT,
    JSON.stringify({ scope: "local dev proxy --backend go; synthetic target and profile/home; no hosted/production tunnel", version, results }, null, 2));
});

async function startTunnel(targetPort: number, label: string) {
  const directory = path.join(fixture.root, label);
  await mkdir(directory);
  const connectionFile = path.join(directory, "connection.json");
  const child = spawn(binary!, ["dev", "proxy", "--backend", "go", "--listen", "127.0.0.1:0",
    "--mcp-server-url", `http://127.0.0.1:${targetPort}/mcp?fixture=r502-tunnel`,
    "--profile-dir", directory, "--duration", "45s", "--response-timeout", "6s",
    "--readiness-timeout", "15s", "--url-file", connectionFile],
  { env: Object.fromEntries(Object.entries(fixture.environment).filter(([key]) => !key.startsWith("TUNNEL_"))), stdio: "ignore" });
  tunnelProcesses.add(child);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const text = await readFile(connectionFile, "utf8").catch(() => undefined);
    if (text) {
      const connection = JSON.parse(text);
      const url = connection.mcp_url ?? connection.mcpUrl ?? connection.url;
      if (typeof url !== "string") throw new Error(`Fixture connection schema: ${Object.keys(connection).join(", ")}`);
      return { child, url };
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Local fixture tunnel did not become ready within its bound.");
}

async function call(url: string, target: string, mode: string) {
  const response = await fetch(url, { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: `fixture-${mode}`, method: "tools/call",
    params: { name: "r502_fault", arguments: { mode } } }) });
  const body = await response.json();
  const failure = body.error?.data?.tunnel_failure;
  const outcome = body.error?.data?.outcome;
  const result = { target, mode, status: response.status,
    ...(["unknown", "not-observed"].includes(outcome) ? { outcome } : {}),
    ...(failure ? { failure: { source: failure.source, transport_error_kind: failure.transport_error_kind,
      upstream_response_received: failure.upstream_response_received, upstream_status: failure.upstream_status } } : {}) };
  results.push(result);
  return result;
}

it.skipIf(!binary)("compares direct resets and bridge responses with the pinned local Go tunnel classification", async () => {
  const direct = await startTunnel(redirect.port, "direct");
  try {
    const pre = await call(direct.url, "direct-fixture", "pre");
    expect(pre).toMatchObject({ status: 502, failure: { source: "transport_closed", upstream_response_received: false } });
    expect((await call(direct.url, "direct-fixture", "ok")).status).toBe(200);
    const post = await call(direct.url, "direct-fixture", "post");
    expect(post).toMatchObject({ status: 502, failure: { upstream_response_received: false } });
    expect((await call(direct.url, "direct-fixture", "ok")).status).toBe(200);
    for (const mode of ["ok", "delay-2500", "delay-4500", "ok"]) {
      expect((await call(direct.url, "direct-fixture", mode)).status).toBe(200);
    }
  } finally { await stop(direct.child); }
  const proxied = await startTunnel(bridgePort, "through-bridge");
  try {
    // The internal pre-header reset/idle paths generate a structured target
    // error; partial-response reset remains a transport loss at public ingress.
    for (const mode of ["pre", "idle", "post"]) {
      const result = await call(proxied.url, "through-bridge", mode);
      expect(result.status).toBe(mode === "post" ? 502 : 503);
      if (mode !== "post") expect(result.outcome).toBe("unknown");
      else expect(result.failure?.upstream_response_received).toBe(false);
      expect((await call(proxied.url, "through-bridge", "ok")).status).toBe(200);
    }
    expect(results.at(-1)).toMatchObject({ mode: "ok", status: 200 });
  } finally { await stop(proxied.child); }
}, 45_000);
