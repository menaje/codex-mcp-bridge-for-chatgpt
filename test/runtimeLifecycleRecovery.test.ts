import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { MacOSBridgeSupervisor } from "../src/macosHelperServer.js";
import { CodexRuntimeManager } from "../src/codexRuntime.js";
import { RuntimeLifecycleCoordinator } from "../src/runtimeLifecycle.js";
import { BRIDGE_BUILD_INFO } from "../src/buildInfo.js";
import { updateRuntimeEnvFile } from "../scripts/runtime-env.mjs";
import { writeFakeLauncher } from "./fixtures/macosHelperLauncher.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// These tests exercise the production supervisor with a private fake launcher.
// Access to the coordinator pauses execution exactly at a simulated helper crash.
const coordinator = (supervisor: MacOSBridgeSupervisor): RuntimeLifecycleCoordinator =>
  (supervisor as unknown as { lifecycle(): RuntimeLifecycleCoordinator }).lifecycle();

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-79-review-"));
  const bridgeRoot = path.join(root, "runtime");
  const envFile = path.join(root, "config", ".env");
  const runDirectory = path.join(root, "config", "run");
  const launcherPath = path.join(bridgeRoot, "launcher.mjs");
  const admissionFile = path.join(root, "admission.json");
  mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
  writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "");
  const update = (state: Record<string, number>) => writeFileSync(admissionFile, JSON.stringify(state));
  update({ activeJobs: 0 });
  writeFakeLauncher(launcherPath, path.join(root, "arguments.json"), { admissionFile, writeRuntimeLock: true });
  updateRuntimeEnvFile(envFile, { apiKey: "sk-lifecycle-review-1234567890123456", tunnelId: "tunnel_oooooooooooooooooooooooooooooooo" });
  const manager = new CodexRuntimeManager({ root: path.join(root, "cli"), discoverExternal: false });
  const options = { bridgeRoot, envFile, launcherPath, bridgeSocketPath: path.join(runDirectory, "bridge.sock"),
    runtimeLockDirectory: path.join(runDirectory, "launcher.lock"), codexRuntimeManager: manager,
    registeredProjectRoots: () => [], autoRestart: false, lifecycleIntervalMs: 100_000, startTimeoutMs: 5000 };
  const supervisor = new MacOSBridgeSupervisor(options);
  cleanups.push(async () => { await supervisor.close({ runtime: "force-stop" }); rmSync(root, { recursive: true, force: true }); });
  return { root, runDirectory, manager, supervisor, options, update };
}

it("a new app launch starts after recovering a completed native shutdown without menu interaction", async () => {
  const f = fixture();
  await f.supervisor.start();
  const shutdown = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "shutdown", force: false });
  await coordinator(f.supervisor).settled();
  f.supervisor.acknowledgeLifecycle(shutdown.requestId);
  await f.supervisor.close();
  writeFileSync(path.join(f.runDirectory, "lifecycle-handoff.json"), JSON.stringify({
    requestId: shutdown.requestId, outcome: "completed"
  }), { mode: 0o600 });
  const recovered = new MacOSBridgeSupervisor(f.options);
  try {
    const launch = { requestId: randomUUID(), kind: "start" as const, force: false, applicationLaunchAt: new Date().toISOString() };
    // This is the production app-start path. It reconciles the receipt itself,
    // including when it races ahead of the helper's background startOnLaunch.
    await recovered.requestLifecycle(launch);
    await coordinator(recovered).settled();
    expect(recovered.lifecycleStatus(shutdown.requestId)?.phase).toBe("completed");
    const status = await recovered.health();
    expect(status).toMatchObject({ phase: "running", bridge: { connected: true }, tunnel: { connected: true } });
    expect(status.pid).not.toBeNull();
    await recovered.requestLifecycle(launch);
    await recovered.startOnLaunch();
    expect((await recovered.health()).pid).toBe(status.pid);
  } finally { await recovered.close({ runtime: "force-stop" }); }
});

it("a helper-only respawn leaves a recovered shutdown stopped until a fresh app launch", async () => {
  const f = fixture();
  const shutdown = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "shutdown", force: false });
  await coordinator(f.supervisor).settled();
  f.supervisor.acknowledgeLifecycle(shutdown.requestId);
  await f.supervisor.close();
  writeFileSync(path.join(f.runDirectory, "lifecycle-handoff.json"), JSON.stringify({
    requestId: shutdown.requestId, outcome: "completed"
  }), { mode: 0o600 });
  const recovered = new MacOSBridgeSupervisor(f.options);
  try {
    expect((await recovered.startOnLaunch()).pid).toBeNull();
    expect(recovered.lifecycleStatus()?.phase).toBe("completed");
    // Even another restart after the shutdown record is terminal is not a new app launch.
    expect((await recovered.startOnLaunch()).pid).toBeNull();
    await recovered.requestLifecycle({ requestId: randomUUID(), kind: "start", force: false,
      applicationLaunchAt: new Date().toISOString() });
    await coordinator(recovered).settled();
    expect((await recovered.health()).phase).toBe("running");
  } finally { await recovered.close({ runtime: "force-stop" }); }
});

it("an app launch observes a failed shutdown recovery without silently starting", async () => {
  const f = fixture();
  const shutdown = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "shutdown", force: false });
  await coordinator(f.supervisor).settled();
  f.supervisor.acknowledgeLifecycle(shutdown.requestId);
  await f.supervisor.close();
  const launchAt = new Date().toISOString();
  writeFileSync(path.join(f.runDirectory, "lifecycle-handoff.json"), JSON.stringify({
    requestId: shutdown.requestId, outcome: "failed", failureCode: "HELPER_SHUTDOWN_FAILED"
  }), { mode: 0o600 });
  const recovered = new MacOSBridgeSupervisor(f.options);
  try {
    const result = await recovered.requestLifecycle({ requestId: randomUUID(), kind: "start", force: false, applicationLaunchAt: launchAt });
    expect(result).toMatchObject({ requestId: shutdown.requestId, phase: "failed" });
    expect((await recovered.startOnLaunch()).pid).toBeNull();
  } finally { await recovered.close({ runtime: "force-stop" }); }
});

it("publishes a failed native handoff before acknowledgement and accepts an explicit retry", async () => {
  const f = fixture();
  const request = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "shutdown", force: false });
  await coordinator(f.supervisor).settled();
  expect(f.supervisor.lifecycleStatus()?.phase).toBe("handoff-ready");
  // AppModel writes this receipt if flushing settings/status validation fails.
  writeFileSync(path.join(f.runDirectory, "lifecycle-handoff.json"), JSON.stringify({
    requestId: request.requestId, outcome: "failed", failureCode: "LIFECYCLE_HANDOFF_CONNECTION_FAILED"
  }), { mode: 0o600 });
  // No manual signal: the receipt file event must beat the 100-second fallback.
  await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("failed"));
  expect(f.supervisor.lifecycleStatus()?.error).toContain("LIFECYCLE_HANDOFF_CONNECTION_FAILED");
  const retry = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "shutdown", force: false });
  await coordinator(f.supervisor).settled();
  expect(f.supervisor.lifecycleStatus()).toMatchObject({ requestId: retry.requestId, phase: "handoff-ready" });
});

it("an acknowledged native handoff consumes a failure receipt", async () => {
  const f = fixture();
  const request = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "shutdown", force: false });
  await coordinator(f.supervisor).settled();
  f.supervisor.acknowledgeLifecycle(request.requestId);
  await coordinator(f.supervisor).settled();
  writeFileSync(path.join(f.runDirectory, "lifecycle-handoff.json"), JSON.stringify({
    requestId: request.requestId, outcome: "failed"
  }), { mode: 0o600 });
  coordinator(f.supervisor).signal(); await coordinator(f.supervisor).settled();
  expect(f.supervisor.lifecycleStatus()?.phase).toBe("failed");
});

it("helper shutdown preserves a graceful reservation and its active runtime", async () => {
  const f = fixture();
  f.update({ activeJobs: 1 });
  const started = await f.supervisor.start();
  const request = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
  await coordinator(f.supervisor).settled();
  expect(f.supervisor.lifecycleStatus()?.reasons).toContainEqual({ code: "active-jobs", count: 1 });
  // macosHelper.ts SIGTERM/SIGINT call exactly this production method.
  await f.supervisor.close();
  const journal = JSON.parse(readFileSync(path.join(f.runDirectory, "lifecycle.json"), "utf8"));
  expect(journal.records.find((r: any) => r.request.requestId === request.requestId).phase).toBe("waiting");
  let alive = true;
  try { process.kill(started.pid!, 0); } catch { alive = false; }
  expect(alive, "the active runtime must survive its supervisor closing").toBe(true);
});

it("cancelling recovered helper replacement must prevent recovery from starting a runtime", async () => {
  const f = fixture();
  const request = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "helper-replace", force: false, targetBuildId: BRIDGE_BUILD_INFO.id });
  await coordinator(f.supervisor).settled();
  expect(f.supervisor.lifecycleStatus()?.phase).toBe("handoff-ready");
  await coordinator(f.supervisor).close();
  const recovered = new MacOSBridgeSupervisor(f.options);
  const originalTarget = await f.manager.activationTarget();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { entered = resolve; });
  const target = vi.spyOn(f.manager, "activationTarget").mockImplementationOnce(async () => {
    entered(); await gate; return originalTarget;
  });
  try {
    const startup = recovered.startOnLaunch();
    await observed;
    expect(recovered.cancelLifecycle(request.requestId).phase).toBe("cancelled");
    release();
    await startup;
    expect(recovered.lifecycleStatus()?.phase).toBe("cancelled");
    expect((await recovered.health()).pid, "cancelled recovery must have no side effects").toBeNull();
  } finally { release(); target.mockRestore(); await recovered.close({ runtime: "force-stop" }); }
});

it("a replacement stop cancels old helper recovery before it can start a runtime", async () => {
  const f = fixture();
  const request = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "helper-replace", force: false, targetBuildId: BRIDGE_BUILD_INFO.id });
  await coordinator(f.supervisor).settled(); await coordinator(f.supervisor).close();
  const recovered = new MacOSBridgeSupervisor(f.options);
  const originalTarget = await f.manager.activationTarget();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { entered = resolve; });
  const target = vi.spyOn(f.manager, "activationTarget").mockImplementationOnce(async () => {
    entered(); await gate; return originalTarget;
  });
  try {
    const startup = recovered.startOnLaunch(); await observed;
    const stop = await recovered.requestLifecycle({ requestId: randomUUID(), kind: "stop", force: false, replacesRequestId: request.requestId });
    release(); await startup; await coordinator(recovered).settled();
    expect(recovered.lifecycleStatus(request.requestId)?.phase).toBe("cancelled");
    expect(recovered.lifecycleStatus()).toMatchObject({ requestId: stop.requestId, phase: "completed" });
    expect((await recovered.health()).pid).toBeNull();
  } finally { release(); target.mockRestore(); await recovered.close({ runtime: "force-stop" }); }
});

it("a new helper claims execution and completes replacement only after the runtime is ready", async () => {
  const f = fixture();
  const request = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "helper-replace", force: false, targetBuildId: BRIDGE_BUILD_INFO.id });
  await coordinator(f.supervisor).settled(); await coordinator(f.supervisor).close();
  const recovered = new MacOSBridgeSupervisor(f.options);
  const originalApply = f.manager.applyPending.bind(f.manager);
  const apply = vi.spyOn(f.manager, "applyPending").mockImplementationOnce(async expected => {
    expect(recovered.lifecycleStatus()).toMatchObject({ phase: "executing", cancellable: false });
    expect(() => recovered.cancelLifecycle(request.requestId)).toThrow("LIFECYCLE_NOT_CANCELLABLE");
    await originalApply(expected);
  });
  try {
    const status = await recovered.startOnLaunch();
    expect(status).toMatchObject({ phase: "running", bridge: { connected: true }, tunnel: { connected: true },
      lifecycle: { requestId: request.requestId, phase: "completed" } });
    expect(apply).toHaveBeenCalledTimes(1);
  } finally { apply.mockRestore(); await recovered.close({ runtime: "force-stop" }); }
});

it("a real helper SIGTERM preserves active work, then a new helper adopts and finishes the reservation", async () => {
  const f = fixture(); f.update({ activeJobs: 1 });
  const helperSocket = path.join(f.runDirectory, "helper.sock");
  mkdirSync(path.join(f.options.bridgeRoot, "scripts"), { recursive: true });
  writeFakeLauncher(path.join(f.options.bridgeRoot, "scripts", "start-codex-mcp-bridge.mjs"),
    path.join(f.root, "arguments.json"), { admissionFile: path.join(f.root, "admission.json"), writeRuntimeLock: true });
  const children: ChildProcess[] = [];
  const startHelper = () => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("src/macosHelper.ts"),
      "--bridge-root", f.options.bridgeRoot, "--env-file", f.options.envFile,
      "--socket", helperSocket, "--bridge-socket", f.options.bridgeSocketPath,
      "--runtime-lock-directory", f.options.runtimeLockDirectory], {
      cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(f.root, "cli"),
        CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE: path.join(f.root, "settings.json"), CODEX_HOME: path.join(f.root, "codex-home") }
    });
    child.stdout?.resume(); child.stderr?.resume(); children.push(child); return child;
  };
  try {
    const first = startHelper();
    let originalPid: number;
    await vi.waitFor(async () => {
      const health = await rpc(helperSocket, "helper.health");
      expect(health.phase).toBe("running");
      expect(health.lifecycle?.phase).toBe("completed"); originalPid = health.pid;
    }, { timeout: 8000, interval: 50 });
    const intent = await rpc(helperSocket, "lifecycle.request", { requestId: randomUUID(), kind: "restart", force: false });
    await vi.waitFor(async () => expect((await rpc(helperSocket, "lifecycle.status")).operation.reasons)
      .toContainEqual({ code: "active-jobs", count: 1 }));
    first.kill("SIGTERM");
    expect(await exitCode(first)).toBe(0);
    expect(() => process.kill(originalPid!, 0)).not.toThrow();
    startHelper();
    await vi.waitFor(async () => {
      const health = await rpc(helperSocket, "helper.health");
      expect(health).toMatchObject({ pid: originalPid!, phase: "running", lifecycle: { requestId: intent.requestId, phase: "waiting" } });
    }, { timeout: 8000, interval: 50 });
    f.update({ activeJobs: 0 });
    await vi.waitFor(async () => {
      const health = await rpc(helperSocket, "helper.health");
      expect(health.lifecycle).toMatchObject({ requestId: intent.requestId, phase: "completed" });
      expect(health.pid).not.toBe(originalPid!);
      expect(health.bridge.connected).toBe(true);
      expect(health.tunnel.connected).toBe(true);
    }, { timeout: 8000, interval: 50 });
    const shutdown = await rpc(helperSocket, "lifecycle.request", { requestId: randomUUID(), kind: "shutdown", force: false });
    await vi.waitFor(async () => expect((await rpc(helperSocket, "lifecycle.status")).operation.phase).toBe("handoff-ready"), { timeout: 6000 });
    await rpc(helperSocket, "lifecycle.acknowledge", { requestId: shutdown.requestId });
    children[1].kill("SIGTERM"); expect(await exitCode(children[1])).toBe(0);
    writeFileSync(path.join(f.runDirectory, "lifecycle-handoff.json"), JSON.stringify({ requestId: shutdown.requestId, outcome: "completed" }), { mode: 0o600 });
    startHelper();
    await vi.waitFor(async () => {
      const health = await rpc(helperSocket, "helper.health");
      expect(health).toMatchObject({ phase: "stopped", pid: null,
        lifecycle: { requestId: shutdown.requestId, phase: "completed" } });
    }, { timeout: 8000, interval: 50 });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM"); await exitCode(child);
    }
  }
}, 25_000);

function rpc(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("RPC timeout")); }, 6000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: method, method, params }) + "\n"));
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      clearTimeout(timer); socket.destroy();
      try { const response = JSON.parse(buffer.split("\n")[0]);
        if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
      } catch (error) { reject(error); }
    });
  });
}

function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Helper did not exit")); }, 5000);
    child.once("exit", code => { clearTimeout(timeout); resolve(code); });
  });
}
