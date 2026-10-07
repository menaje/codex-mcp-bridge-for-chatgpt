import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { issue242Fixture } from "../scripts/issue-242-fixture.js";
import { writeFile } from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { HTTP_DIAGNOSTIC_HEADER } from "../src/httpDiagnostics.js";
import { createIsolatedHttpServer, type ProxyObservation } from "../src/runtimeProcess.js";
import type { BridgeHttpServer } from "../src/server.js";

const redirect = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:http", async importOriginal => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, request: (options: import("node:http").RequestOptions, callback: (res: IncomingMessage) => void) => {
    const fault = typeof options.path === "string" && options.path.startsWith("/mcp?r502=")
      ? new URL(options.path, "http://fixture.invalid").searchParams.get("r502") : undefined;
    const request = actual.request(fault ? { ...options, port: redirect.port } : options, response => {
      callback(response);
      // Deterministically order a late transport error after a complete upstream
      // response. No fault is injected into the operational runtime or tunnel.
      if (fault === "late-error" || fault === "late-response-error" || fault === "late-timeout") response.once("end", () => {
        if (fault === "late-timeout") { request.emit("timeout"); return; }
        if (fault === "late-response-error") {
          response.emit("error", new Error("fixture late response reset"));
          return;
        }
        request.emit("error", Object.assign(new Error("fixture late reset"), { code: "ECONNRESET" }));
      });
    });
    return request;
  } };
});
const { request: callerRequest, Agent } = await vi.importActual<typeof import("node:http")>("node:http");
const callerAgent = new Agent({ keepAlive: true, maxSockets: 1 });
let fixture: Awaited<ReturnType<typeof issue242Fixture>>;
let upstream: Server, bridge: BridgeHttpServer, port: number;
const observations: ProxyObservation[] = [];
const diagnostics = { idleTimeoutMs: 200, observe: (row: ProxyObservation) => observations.push(row) };
const results: unknown[] = [];
const lag = monitorEventLoopDelay({ resolution: 10 });
const upstreamBodies: string[] = [];
const upstreamIds: string[] = [];
let completedActions = 0;
let continueAction: (() => void) | undefined;

beforeAll(async () => {
  fixture = await issue242Fixture(0);
  Object.assign(fixture.environment, { NODE_ENV: "test", CODEX_MCP_BRIDGE_TEST_CONFORMANCE_DELAY_MS: "500" });
  fixture.store.close();
  upstream = createServer((req, res) => {
    const fault = new URL(req.url!, "http://fixture.invalid").searchParams.get("r502");
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.resume();
    req.once("end", () => {
      upstreamBodies.push(body);
      upstreamIds.push(String(req.headers[HTTP_DIAGNOSTIC_HEADER] || ""));
      if (fault === "pre") { req.socket.destroy(); return; }
      if (fault === "post") {
        res.writeHead(200, { "content-type": "application/json", "content-length": 200 });
        res.write('{"partial":');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (fault === "idle" || fault === "caller") return;
      if (fault === "app-timeout") {
        // The application owns this deadline and produces a complete error
        // before any headers, independently of the supervisor's idle timer.
        setTimeout(() => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id,
            error: { code: -32000, message: "Fixture application observation expired",
              data: { code: "RUNTIME_RESPONSE_UNCONFIRMED", outcome: "unknown" } } }));
        }, 20);
        return;
      }
      if (fault === "loop-idle") {
        setTimeout(() => {
          const end = performance.now() + 300;
          while (performance.now() < end) { /* Bounded fixture-only loop stall. */ }
        }, 20);
        return;
      }
      if (fault === "continue") {
        continueAction = () => { completedActions += 1; res.end('{"ok":true}'); };
        return;
      }
      if (fault === "close-after-response") res.setHeader("connection", "close");
      res.setHeader(HTTP_DIAGNOSTIC_HEADER, "fixture-upstream-secret");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, padding: "x".repeat(128 * 1024) }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  redirect.port = (upstream.address() as { port: number }).port;
  bridge = await createIsolatedHttpServer(fixture.config, { childEnvironment: fixture.environment,
    conformanceFixtures: true,
    proxyDiagnostics: diagnostics });
  bridge.on("request", (req, res) => {
    if (!["/mcp?r502=late-error", "/mcp?r502=late-response-error", "/mcp?r502=late-timeout"].includes(req.url!)) return;
    // Hold the final downstream framing to deterministically represent a queued
    // write. Upstream end is observable before the caller has a full response.
    const end = res.end.bind(res);
    res.end = ((...args: Parameters<typeof end>) => {
      setTimeout(() => end(...args), 20);
      return res;
    }) as typeof res.end;
  });
  await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
  port = (bridge.address() as { port: number }).port;
  lag.enable();
}, 30_000);
afterEach(() => { diagnostics.idleTimeoutMs = 200; });
afterAll(async () => {
  lag.disable();
  callerAgent.destroy();
  if (bridge) await new Promise<void>(resolve => bridge.close(() => resolve()));
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
  await fixture?.close();
  if (process.env.ISSUE_242_R502_REPORT) await writeFile(process.env.ISSUE_242_R502_REPORT,
    JSON.stringify({ scope: "isolated exact-baseline R502 fixtures; no production/tunnel injection",
      idleTimeoutOverrideMs: 200, parentEventLoopDelayMs: { max: lag.max / 1e6 }, results }, null, 2));
});

async function call(fault: string, chunked = false) {
  const start = observations.length;
  const body = JSON.stringify({ jsonrpc: "2.0", id: "fixture-id", method: "ping" });
  const response = await new Promise<{ status?: number; complete: boolean; body: string; reusedSocket: boolean }>(resolve => {
    const req = callerRequest({ host: "127.0.0.1", port, path: `/mcp?r502=${fault}`, method: "POST",
      agent: callerAgent, headers: { "content-type": "application/json",
        [HTTP_DIAGNOSTIC_HEADER]: "public-forged-secret",
        ...(chunked ? {} : { "content-length": Buffer.byteLength(body) }) } }, res => {
      expect(res.headers[HTTP_DIAGNOSTIC_HEADER]).toBeUndefined();
      let body = "";
      res.on("data", data => { body += data; });
      const finish = () => resolve({ status: res.statusCode, complete: res.complete, body, reusedSocket: req.reusedSocket });
      res.once("end", finish);
      res.once("error", finish);
    });
    req.once("error", () => resolve({ complete: false, body: "", reusedSocket: req.reusedSocket }));
    if (chunked) req.write(body.slice(0, 10));
    req.end(chunked ? body.slice(10) : body);
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const phases = phasesFor(start);
  expect(new Set(phases.map(row => row.requestId)).size).toBe(1);
  expect(phases.filter(row => row.firstTermination)).toHaveLength(1);
  expect(phases.filter(row => row.source === "ingress" && row.phase === "cleanup"))
    .toEqual([expect.objectContaining({ activeRequests: 0, activeBytes: 0 })]);
  expect(JSON.stringify(phases)).not.toMatch(/fixture-id|public-forged-secret|fixture-upstream-secret|partial/);
  results.push({ fault, chunked, status: response.status, complete: response.complete,
    reusedSocket: response.reusedSocket, phases });
  return { response, phases };
}

async function recovery() {
  const { response } = await call("ok");
  expect(response).toMatchObject({ status: 200, complete: true });
  expect((await fetch(`http://127.0.0.1:${port}/readyz`).then(res => res.json()))
    .stateService.inFlight).toBe(0);
}

function phasesFor(start: number) {
  const rows = observations.slice(start);
  const id = rows.find(row => row.source === "ingress" && row.phase === "admitted")?.requestId;
  return rows.filter(row => row.requestId === id);
}

async function disconnect(fault: string, completeBody: boolean) {
  const start = observations.length;
  const before = upstreamBodies.length;
  const req = callerRequest({ host: "127.0.0.1", port, path: `/mcp?r502=${fault}`, method: "POST",
    headers: { "content-length": completeBody ? 2 : 100 } });
  req.on("error", () => {});
  if (completeBody) req.end("{}");
  else req.write("{");
  await vi.waitFor(() => expect(observations.slice(start).some(row =>
    row.phase === (completeBody ? "request-finished" : "dispatch"))).toBe(true));
  if (completeBody) await vi.waitFor(() => expect(upstreamBodies.length).toBe(before + 1));
  req.destroy();
  await vi.waitFor(() => expect(observations.slice(start).some(row => row.phase === "cleanup")).toBe(true));
  const phases = phasesFor(start);
  expect(phases.filter(row => row.firstTermination)).toHaveLength(1);
  expect(phases.find(row => row.firstTermination)?.outcome).toBe(completeBody ? "unknown" : "not-observed");
  expect(phases.filter(row => row.phase === "cleanup")).toEqual([
    expect.objectContaining({ activeRequests: 0, activeBytes: 0 })]);
  results.push({ fault, completeBody, phases });
  return phases;
}

function childTool(signal?: AbortSignal) {
  return fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", signal,
    headers: { accept: "application/json", "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "test_logging_tool" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "private-child-id", method: "tools/call", params: {
      name: "test_logging_tool", arguments: {}, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "r502", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {} } } }) });
}

async function childCompleted(start: number) {
  await vi.waitFor(() => {
    const phases = phasesFor(start);
    expect(phases.some(row => row.source === "child" && row.phase === "application-response")).toBe(true);
    expect(phases.some(row => row.source === "child" && row.phase === "application-complete")).toBe(true);
    expect(phases.some(row => row.source === "child" && row.phase === "cleanup")).toBe(true);
    expect(phases.some(row => row.source === "ingress" && row.phase === "cleanup")).toBe(true);
  }, { timeout: 5_000 });
  const phases = phasesFor(start);
  expect(phases.filter(row => row.source === "child" && row.phase === "application-dispatch")).toHaveLength(1);
  expect(phases.filter(row => row.source === "child" && row.phase === "application-response")).toHaveLength(1);
  expect(phases.filter(row => row.source === "child" && row.phase === "application-complete")).toHaveLength(1);
  const child = phases.filter(row => row.source === "child");
  expect(child.find(row => row.phase === "application-start")!.elapsedMs)
    .toBeLessThan(child.find(row => row.phase === "caller-closed")!.elapsedMs);
  expect(child.find(row => row.phase === "application-complete")!.elapsedMs)
    .toBeGreaterThan(child.find(row => row.phase === "caller-closed")!.elapsedMs);
  expect(phases.filter(row => row.source === "ingress" && row.phase === "cleanup"))
    .toEqual([expect.objectContaining({ activeRequests: 0, activeBytes: 0 })]);
  expect(phases.filter(row => row.firstTermination)).toHaveLength(1);
  return phases;
}

describe("R502 deterministic lifecycle races", () => {
  it.each(["late-error", "late-response-error", "late-timeout"])("preserves queued response framing after %s follows upstream end", async fault => {
    const { response, phases } = await call(fault);
    expect(phases.some(row => row.phase === "response-end")).toBe(true);
    expect(response).toMatchObject({ status: 200, complete: true });
    expect(JSON.parse(response.body).ok).toBe(true);
    await recovery();
  });
  it("returns structured unavailable before headers, then recovers", async () => {
    const { response, phases } = await call("pre");
    expect(response).toMatchObject({ status: 503, complete: true });
    expect(JSON.parse(response.body)).toMatchObject({ id: "fixture-id", error: { data: { outcome: "unknown" } } });
    expect(phases.find(row => row.firstTermination)?.phase).toBe("upstream-request-error");
    await recovery();
  });
  it("leaves partial responses incomplete, then recovers", async () => {
    const { response, phases } = await call("post");
    expect(response).toMatchObject({ status: 200, complete: false });
    expect(response.body).toBe('{"partial":');
    expect(phases.find(row => row.firstTermination)?.phase).toBe("upstream-response-error");
    await recovery();
  });
  it("expires an upstream that never responds before headers exactly once", async () => {
    const { response, phases } = await call("idle");
    expect(response).toMatchObject({ status: 503, complete: true });
    expect(phases.find(row => row.firstTermination)?.phase).toBe("idle-timeout");
    expect(JSON.parse(response.body).error.data.outcome).toBe("unknown");
    await recovery();
  });
  it("preserves a complete application-owned timeout response before headers", async () => {
    const { response, phases } = await call("app-timeout");
    expect(response).toMatchObject({ status: 503, complete: true });
    expect(JSON.parse(response.body)).toMatchObject({ id: "fixture-id",
      error: { data: { code: "RUNTIME_RESPONSE_UNCONFIRMED", outcome: "unknown" } } });
    expect(phases.find(row => row.firstTermination)?.phase).toBe("response-end");
    expect(phases.some(row => row.phase === "idle-timeout" || row.phase === "upstream-request-error")).toBe(false);
    await recovery();
  });
  it("releases a caller disconnected during its incomplete body", async () => {
    const phases = await disconnect("caller", false);
    expect(phases.find(row => row.firstTermination)?.phase).toBe("caller-aborted");
    await recovery();
  });
  it("detaches a complete-body caller while its application action continues once", async () => {
    const before = completedActions;
    const phases = await disconnect("continue", true);
    expect(phases.find(row => row.firstTermination)?.phase).toBe("caller-closed");
    expect(completedActions).toBe(before);
    expect(continueAction).toBeTypeOf("function");
    continueAction!();
    continueAction = undefined;
    expect(completedActions).toBe(before + 1);
    await recovery();
    expect(completedActions).toBe(before + 1);
  });
  it("preserves a completed response through normal socket close and connection reuse", async () => {
    for (const fault of ["ok", "ok", "close-after-response", "ok"]) {
      const { response, phases } = await call(fault);
      expect(response).toMatchObject({ status: 200, complete: true });
      expect(phases.find(row => row.firstTermination)?.phase).toBe("response-end");
      expect(phases.some(row => row.phase === "response-complete" && row.callerComplete)).toBe(true);
    }
    const { response, phases } = await call("ok");
    expect(response.reusedSocket).toBe(true);
    expect(phases.find(row => row.phase === "request-finished")?.reusedSocket).toBe(true);
    const failed = await call("pre");
    expect(failed.response.status).toBe(503);
    await recovery();
  });
  it("returns capacity exactly once after an idle expiry delayed by a high event-loop stall", async () => {
    const { response, phases } = await call("loop-idle");
    expect(response).toMatchObject({ status: 503, complete: true });
    expect(phases.find(row => row.firstTermination)?.phase).toBe("idle-timeout");
    expect(lag.max / 1e6).toBeGreaterThan(200);
    await recovery();
  });
  it("correlates admitted/queued/dispatch and strips a caller-supplied trace id", async () => {
    const { response, phases } = await call("ok", true);
    expect(response.complete).toBe(true);
    expect(phases.slice(0, 3).map(row => row.phase)).toEqual(["admitted", "queued", "dispatch"]);
    expect(upstreamIds.at(-1)).toBe(phases[0].requestId);
    expect(phases.every(row => Number.isSafeInteger(row.atUnixMs) && row.elapsedMs >= 0)).toBe(true);
    expect(phases.length).toBeLessThanOrEqual(32);
  });
  it("joins public ingress with the real supervised child and application response", async () => {
    diagnostics.idleTimeoutMs = 2_000;
    const start = observations.length;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST",
      headers: { accept: "application/json", "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "private-id", method: "tools/list", params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "r502", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {} } } }) });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    // Handler cleanup and the HTTP finish event cross IPC independently. Both
    // must arrive before inspecting the complete diagnostic phase set.
    await vi.waitFor(() => {
      const childPhases = observations.slice(start).filter(row => row.source === "child").map(row => row.phase);
      expect(childPhases).toContain("cleanup");
      expect(childPhases).toContain("response-complete");
    });
    const phases = phasesFor(start);
    expect(new Set(phases.map(row => row.requestId)).size).toBe(1);
    expect(phases.filter(row => row.source === "child").map(row => row.phase)).toEqual(expect.arrayContaining([
      "admitted", "request-finished", "application-dispatch", "application-response", "response-headers", "response-complete", "cleanup" ]));
    expect(JSON.stringify(phases)).not.toContain("private-id");
    results.push({ fault: "real-child", phases });
    diagnostics.idleTimeoutMs = 200;
  });
  it("returns structured unavailable for a real child response exceeding the idle budget before headers", async () => {
    const start = observations.length;
    const response = await childTool();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ id: "private-child-id", error: { data: { outcome: "unknown" } } });
    const phases = await childCompleted(start);
    expect(phases.find(row => row.firstTermination)?.phase).toBe("idle-timeout");
    results.push({ fault: "child-response-idle-expiry", phases });
    await recovery();
  });
  it("observes the real child's later response after its complete-body caller disconnects", async () => {
    diagnostics.idleTimeoutMs = 2_000;
    const start = observations.length;
    const controller = new AbortController();
    const pending = childTool(controller.signal).catch(error => error);
    await vi.waitFor(() => expect(phasesFor(start).some(row =>
      row.source === "child" && row.phase === "application-start")).toBe(true), { timeout: 2_000 });
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    const phases = await childCompleted(start);
    expect(phases.find(row => row.firstTermination)).toMatchObject({ phase: "caller-closed", outcome: "unknown" });
    expect(phases.some(row => row.source === "child" && row.phase === "caller-closed")).toBe(true);
    results.push({ fault: "real-child-caller-disconnect", phases });
    diagnostics.idleTimeoutMs = 200;
    await recovery();
  });
});
