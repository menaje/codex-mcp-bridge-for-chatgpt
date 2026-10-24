import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTunnelHealthObserver } from "../scripts/tunnel-health.mjs";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(expectedPid = process.pid, timeoutMs = 2000) {
  const root = mkdtempSync(join(tmpdir(), "issue-242-health-"));
  const urlFile = join(root, "url"), pidFile = join(root, "pid");
  const state = { delay: 0, metricsDelay: 0, healthStatus: 200, readyStatus: 200, metricsStatus: 200,
    timestamp: Date.now() / 1000, reset: false, body: "", requests: 0, hangBody: false };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((request, response) => {
    state.requests++;
    if (state.reset) { request.socket.destroy(); return; }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (response.destroyed) return;
      response.statusCode = request.url === "/healthz" ? state.healthStatus : request.url === "/readyz" ? state.readyStatus : state.metricsStatus;
      if (state.hangBody) { response.writeHead(response.statusCode); response.write("partial"); return; }
      response.end(request.url === "/metrics" ? state.body ||
        `commands_poll_last_successful_timestamp_seconds ${state.timestamp}\n` : "sk-do-not-publish-this-body");
    }, request.url === "/metrics" ? state.metricsDelay : state.delay);
    timers.add(timer);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(urlFile, base, { mode: 0o600 });
  writeFileSync(pidFile, String(expectedPid), { mode: 0o600 });
  const observer = createTunnelHealthObserver({ urlFile, pidFile, expectedPid, timeoutMs });
  cleanups.push(async () => {
    observer.close(); timers.forEach(clearTimeout); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  });
  return { state, observer, root, urlFile, pidFile, base };
}

describe("owned tunnel observation", () => {
  it("accepts 700ms endpoint latency with a complete first snapshot and never exposes bodies", async () => {
    const f = await fixture(); f.state.delay = 700;
    const start = performance.now(); const result = await f.observer.probe();
    expect(performance.now() - start).toBeGreaterThanOrEqual(700);
    expect(result).toMatchObject({ connected: true, processRunning: true, reason: null,
      observation: { healthz: { status: 200, failure: null }, readyz: { status: 200, failure: null },
        controlPlanePoll: { fresh: true, failure: null }, failure: null } });
    expect(JSON.stringify(result)).not.toContain("sk-do-not");
  });

  it("retains recent external success after a multi-second API timeout without inventing endpoint success", async () => {
    const f = await fixture(); await f.observer.probe(); f.state.delay = 3000;
    const start = performance.now(); const result = await f.observer.probe();
    expect(performance.now() - start).toBeLessThan(2700);
    expect(result).toMatchObject({ connected: true, processRunning: true, reason: "timeout",
      observation: { healthz: { status: null, failure: "timeout" }, readyz: { status: null, failure: "timeout" },
        controlPlanePoll: { fresh: true, failure: null }, failure: "timeout" } });
    f.state.delay = 0; expect((await f.observer.probe()).observation.failure).toBeNull();
  });

  it("does not establish startup readiness from a timestamp and missing first endpoints, including restart", async () => {
    const f = await fixture(process.pid, 100); f.state.delay = 3000;
    expect(await f.observer.probe()).toMatchObject({ connected: false, processRunning: true,
      observation: { controlPlanePoll: { fresh: true }, failure: "timeout" } });
    f.state.delay = 0; expect((await f.observer.probe()).connected).toBe(true);
    f.observer.close();
    const replacement = createTunnelHealthObserver({ urlFile: f.urlFile, pidFile: f.pidFile, expectedPid: process.pid, timeoutMs: 100 });
    try { f.state.delay = 3000; expect((await replacement.probe()).connected).toBe(false); }
    finally { replacement.close(); }
  });

  it("expires cached success after 75 seconds of failed observations", async () => {
    const f = await fixture(); const first = await f.observer.probe(); f.state.reset = true;
    expect(await f.observer.probe()).toMatchObject({ connected: true, processRunning: true,
      observation: { failure: "transport-error" } });
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 75_001);
    const result = await f.observer.probe();
    expect(result).toMatchObject({ connected: false, processRunning: true, reason: "poll-stale-or-unverified",
      observation: { controlPlanePoll: { fresh: false, lastSuccessfulAt: first.observation.controlPlanePoll.lastSuccessfulAt } } });
  });

  it.each(["ready", "health", "external"])("immediately rejects explicit %s failure despite recent success", async kind => {
    const f = await fixture(); await f.observer.probe();
    if (kind === "ready") f.state.readyStatus = 503;
    if (kind === "health") f.state.healthStatus = 503;
    if (kind === "external") f.state.timestamp = 0;
    const result = await f.observer.probe();
    expect(result.connected).toBe(false); expect(result.processRunning).toBe(true);
    // A subsequent missing observation cannot erase a known negative.
    f.state.reset = true; expect((await f.observer.probe()).connected).toBe(false);
    f.state.reset = false; f.state.readyStatus = 200; f.state.healthStatus = 200; f.state.timestamp = Date.now()/1000;
    expect((await f.observer.probe()).connected).toBe(true);
  });

  it("bounds an external control-plane outage with a frozen last-success metric while local APIs remain healthy", async () => {
    const f = await fixture(); const first = await f.observer.probe();
    // Failed external attempts do not advance the exposed last-success metric.
    const now = Date.now(); const clock = vi.spyOn(Date,"now");
    clock.mockReturnValue(now+35_000);
    expect(await f.observer.probe()).toMatchObject({ connected:true, processRunning:true,
      observation:{controlPlanePoll:{fresh:true,lastSuccessfulAt:first.observation.controlPlanePoll.lastSuccessfulAt},failure:null} });
    clock.mockReturnValue(now+76_000);
    expect(await f.observer.probe()).toMatchObject({ connected:false, processRunning:true,
      observation:{healthz:{status:200},readyz:{status:200},controlPlanePoll:{fresh:false},failure:"poll-stale-or-unverified"} });
  });

  it("rejects a stale or implausibly future metric despite HTTP 200", async () => {
    const f = await fixture();
    f.state.timestamp = (Date.now() - 76_000) / 1000;
    expect((await f.observer.probe()).connected).toBe(false);
    f.state.timestamp = (Date.now() + 6_000) / 1000;
    expect((await f.observer.probe()).connected).toBe(false);
  });

  it("shares physical probes and releases singleflight after timeout and cancellation", async () => {
    const f = await fixture(process.pid, 100); f.state.delay = 3000;
    const first = f.observer.probe(), second = f.observer.probe(); expect(first).toBe(second);
    await Promise.all([first, second]); expect(f.state.requests).toBe(3);
    const cancellation = new AbortController();
    const pending = f.observer.probe({ signal: cancellation.signal });
    cancellation.abort(); expect((await pending).reason).toBe("aborted");
    f.state.delay = 0; expect((await f.observer.probe()).connected).toBe(true);
  });

  it("does not treat terminating a health command subprocess as daemon death", async () => {
    const f = await fixture(); await f.observer.probe();
    const error = await new Promise<NodeJS.ErrnoException | null>(resolve =>
      execFile(process.execPath, ["-e", "setInterval(()=>{},1000)"],
        { timeout: 100, killSignal: "SIGKILL" }, error => resolve(error)));
    expect(error).toMatchObject({ killed: true, signal: "SIGKILL" });
    expect(await f.observer.probe()).toMatchObject({ processRunning: true, connected: true });
  });

  it("overrides cached success on actual daemon exit, including exit during a probe", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    try {
      const f = await fixture(child.pid!); await f.observer.probe(); f.state.delay = 150;
      const pending = f.observer.probe(); child.kill("SIGTERM"); await once(child, "exit");
      expect(await pending).toMatchObject({ connected: false, processRunning: false, reason: "process-exited",
        observation: { controlPlanePoll: { fresh: false, lastSuccessfulAt: null } } });
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child,"exit"); } }
  });

  it("fences PID mismatch and locator replacement before and after requests", async () => {
    const f = await fixture(); await f.observer.probe();
    writeFileSync(f.pidFile, String(process.ppid));
    expect(await f.observer.probe()).toMatchObject({ connected: false, processRunning: true, reason: "pid-mismatch" });
    writeFileSync(f.pidFile, String(process.pid)); f.state.delay = 150;
    const pending = f.observer.probe();
    setTimeout(() => writeFileSync(f.urlFile, `${f.base}/healthz`), 10); // Equivalent locator is allowed.
    expect((await pending).connected).toBe(true);
    const changed = f.observer.probe(); setTimeout(() => writeFileSync(f.urlFile, "http://127.0.0.1:1"), 10);
    expect(await changed).toMatchObject({ connected: false, reason: "locator-changed" });
  });

  it.each(["https://127.0.0.1:1", "http://example.test:1", "http://user:secret@127.0.0.1:1", "http://127.0.0.1:1/other"])("rejects unexpected locator %s without sending requests", async url => {
    const f = await fixture(); writeFileSync(f.urlFile, url);
    expect((await f.observer.probe()).reason).toBe("locator-invalid"); expect(f.state.requests).toBe(0);
  });

  it("rejects symlink locator and redirect rather than following them", async () => {
    const f = await fixture(); const target = join(f.root,"target"); writeFileSync(target,f.base,{mode:0o600});
    rmSync(f.urlFile); symlinkSync(target,f.urlFile);
    expect((await f.observer.probe()).reason).toBe("locator-invalid");
    rmSync(f.urlFile);writeFileSync(f.urlFile,f.base,{mode:0o600}); f.state.healthStatus = 302;
    expect((await f.observer.probe()).connected).toBe(false);
  });

  it("does not hide a known HTTP failure behind a stalled body and fresh external success", async () => {
    const f = await fixture(process.pid, 100); await f.observer.probe();
    f.state.readyStatus = 503; f.state.hangBody = true;
    const result = await f.observer.probe();
    expect(result).toMatchObject({ connected: false, processRunning: true,
      observation: { readyz: { status: 503, failure: "endpoint-failed" }, failure: "endpoint-failed" } });
    f.state.readyStatus = 200;
    expect((await f.observer.probe()).connected).toBe(false);
  });

  it("bounds a stalled body and a too-large metric line and parses labelled metrics", async () => {
    const f = await fixture(process.pid,100); f.state.hangBody = true;
    expect((await f.observer.probe()).connected).toBe(false);
    f.state.hangBody = false; f.state.body = "x".repeat(1024*1024+1);
    expect((await f.observer.probe()).observation.controlPlanePoll.failure).toBe("metrics-line-limit");
    f.state.body = `# HELP ignored\ncommands_poll_last_successful_timestamp_seconds_other 999\ncommands_poll_last_successful_timestamp_seconds{scope="fixture"} ${Date.now()/1000}\n`;
    expect((await f.observer.probe()).connected).toBe(true);
  });

  it("rejects success delivered after an absolute deadline under event-loop delay", async () => {
    const f = await fixture(process.pid,100); f.state.delay = 20;
    const pending = f.observer.probe();
    setTimeout(() => { const until = performance.now()+200; while(performance.now()<until) {} }, 5);
    expect(await pending).toMatchObject({ connected:false, processRunning:true, reason:"timeout" });
    f.state.delay=0;expect((await f.observer.probe()).connected).toBe(true);
  });
});
