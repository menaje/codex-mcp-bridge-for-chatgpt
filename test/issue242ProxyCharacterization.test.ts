import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { issue242Fixture } from "../scripts/issue-242-fixture.js";
import { createIsolatedHttpServer, type ProxyObservation } from "../src/runtimeProcess.js";
import type { BridgeHttpServer } from "../src/server.js";

const redirect = vi.hoisted(() => ({ port: 0 }));
// Only the parent's internal HTTP request is redirected. The real proxy and supervised
// fixture runtime remain in use; no production listener or runtime is contacted.
vi.mock("node:http", async importOriginal => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, request: (options: import("node:http").RequestOptions, callback: (res: import("node:http").IncomingMessage) => void) =>
    actual.request(typeof options.path === "string" && options.path.startsWith("/mcp?issue242=")
      ? { ...options, port: redirect.port } : options, callback) };
});
const { request: callerRequest, Agent } = await vi.importActual<typeof import("node:http")>("node:http");
const callerAgent = new Agent({ keepAlive: true, maxSockets: 1 });

let fixture: Awaited<ReturnType<typeof issue242Fixture>>;
let upstream: Server, bridge: BridgeHttpServer;
let port: number;
const observations: ProxyObservation[] = [];
const results: unknown[] = [];
const lag = monitorEventLoopDelay({ resolution: 10 });
beforeAll(async () => {
  fixture = await issue242Fixture(0);
  // The supervised runtime must be the sole operational database owner.
  fixture.store.close();
  upstream = createServer((req, res) => {
    const fault = new URL(req.url!, "http://fixture.invalid").searchParams.get("issue242");
    req.resume();
    req.once("end", () => {
      if (fault === "pre") req.socket.destroy();
      else if (fault === "post") {
        res.writeHead(200, { "content-type": "application/json", "content-length": 200 });
        res.write('{"partial":');
        setTimeout(() => res.destroy(), 30);
      } else if (fault === "idle" || fault === "caller") { /* Fixture intentionally withholds a response. */ }
      else {
        const timer = setTimeout(() => res.end('{"ok":true}'), fault === "delay" ? 100 : 0);
        res.once("close", () => clearTimeout(timer));
      }
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  redirect.port = (upstream.address() as { port: number }).port;
  bridge = await createIsolatedHttpServer(fixture.config, { childEnvironment: fixture.environment,
    proxyDiagnostics: { idleTimeoutMs: 200, observe: row => {
      if (observations.length < 128) observations.push(row);
      // Observer failure must have no effect on transport.
      throw new Error("fixture observer failure");
    } } });
  await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
  port = (bridge.address() as { port: number }).port;
  lag.enable();
}, 30_000);

afterAll(async () => {
  lag.disable();
  callerAgent.destroy();
  if (bridge) await new Promise<void>(resolve => bridge.close(() => resolve()));
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
  await fixture?.close();
  if (process.env.ISSUE_242_PROXY_REPORT) await writeFile(process.env.ISSUE_242_PROXY_REPORT, JSON.stringify({
    scope: "latest-dev internal proxy with isolated injected upstream; no installed tunnel",
    idleTimeoutOverrideMs: 200, results, parentEventLoopDelayMs: {
      p50: lag.percentile(50) / 1e6, p95: lag.percentile(95) / 1e6, max: lag.max / 1e6 }
  }, null, 2));
});

async function call(fault: string) {
  const start = observations.length;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const response = await new Promise<{ status?: number; complete: boolean; body: string; reusedSocket: boolean }>((resolve, reject) => {
    const req = callerRequest({ host: "127.0.0.1", port, path: `/mcp?issue242=${fault}`, method: "POST",
      agent: callerAgent, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, res => {
      let body = "";
      res.on("data", data => { body += data; });
      res.once("end", () => resolve({ status: res.statusCode, complete: res.complete, body, reusedSocket: req.reusedSocket }));
      res.once("error", () => resolve({ status: res.statusCode, complete: res.complete, body, reusedSocket: req.reusedSocket }));
    });
    req.once("error", reject);
    req.end(body);
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const phases = observations.slice(start);
  results.push({ fault, status: response.status, complete: response.complete, reusedSocket: response.reusedSocket, phases });
  expect(new Set(phases.map(row => row.requestId)).size).toBe(1);
  expect(phases.filter(row => row.firstTermination)).toHaveLength(1);
  expect(JSON.stringify(phases)).not.toContain(fixture.root);
  return { response, phases };
}

describe("issue 242 internal proxy termination boundaries", () => {
  it("returns a structured unavailable result for reset before headers", async () => {
    const { response, phases } = await call("pre");
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error.data.outcome).toBe("unknown");
    expect(phases.find(row => row.firstTermination)).toMatchObject({ phase: "upstream-request-error", responseStarted: false });
  });
  it("destroys a partial response after headers without turning it into a complete error", async () => {
    const { response, phases } = await call("post");
    expect(response).toMatchObject({ status: 200, complete: false });
    expect(phases.find(row => row.firstTermination)).toMatchObject({ phase: "upstream-response-error", responseStarted: true, headersSent: true });
  });
  it("distinguishes internal idle expiry", async () => {
    const { response, phases } = await call("idle");
    expect(response.status).toBe(503);
    expect(phases.find(row => row.firstTermination)?.phase).toBe("idle-timeout");
    expect(JSON.parse(response.body).error.data.outcome).toBe("unknown");
  });
  it("records caller-first disconnect after a complete request body", async () => {
    const start = observations.length;
    const req = callerRequest({ host: "127.0.0.1", port, method: "POST", path: "/mcp?issue242=caller",
      headers: { "content-length": 2 } });
    req.on("error", () => {});
    req.end("{}");
    await vi.waitFor(() => expect(observations.slice(start).some(row => row.phase === "request-finished")).toBe(true));
    req.destroy();
    await vi.waitFor(() => expect(observations.slice(start).some(row => row.firstTermination)).toBe(true));
    const phases = observations.slice(start);
    expect(phases.find(row => row.firstTermination)?.phase).toBe("caller-closed");
    results.push({ fault: "caller", phases });
  });
  it("recovers after faults and accepts a valid delayed response", async () => {
    for (const fault of ["ok", "delay", "ok"]) {
      const { response, phases } = await call(fault);
      expect(response).toMatchObject({ status: 200, complete: true });
      if (fault === "delay") expect(response.reusedSocket).toBe(true);
      expect(phases.find(row => row.firstTermination)?.phase).toBe("response-end");
    }
  });
});
