import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createConnection } from "node:net";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MacOSBridgeSupervisor } from "../src/macosHelperServer.js";
import { CodexRuntimeManager } from "../src/codexRuntime.js";
import { RuntimeLifecycleCoordinator } from "../src/runtimeLifecycle.js";
import { updateRuntimeEnvFile } from "../scripts/runtime-env.mjs";
import { writeFakeLauncher } from "./fixtures/macosHelperLauncher.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0)) await close(); }
  finally { vi.unstubAllEnvs(); }
});
const coordinator = (s: MacOSBridgeSupervisor) => (s as unknown as { lifecycle(): RuntimeLifecycleCoordinator }).lifecycle();
function fixture(failures = 1, failureCode = "STARTUP_HTTP_TIMEOUT", causeCode?: string, descendant = false, protectWork = false,
  orphanState: "idle" | "protected" | "unknown" | "unreachable" | "missing-owner" | "changed-owner" |
    "admission-race" | "pending-admission" | "lost-drain-ack" | "lost-cancel-ack" | "false-drain-ack" | "restore-held" = "idle",
  processInspectorSpawn?: typeof spawn) {
  const root = mkdtempSync(path.join(tmpdir(), "startup-supervisor-"));
  const bridgeRoot = path.join(root, "runtime"), envFile = path.join(root, "config", ".env");
  const runDirectory = path.join(root, "config", "run"), launcherPath = path.join(bridgeRoot, "launcher.mjs");
  const launchesFile = path.join(root, "launches.jsonl"), descendantFile = path.join(root, "descendant.pid");
  const orphanLauncher = path.join(bridgeRoot, "orphan-bridge.mjs"), requestsFile = path.join(root, "orphan-requests.jsonl");
  const restoreReady = path.join(root, "restore-ready"), restoreRelease = path.join(root, "restore-release");
  writeFileSync(restoreRelease, "0");
  mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true }); writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "");
  writeFakeLauncher(launcherPath, path.join(root, "args.json"), { writeRuntimeLock: true,
    initialStartupFailures: failures, initialStartupTunnelNeverReady: protectWork, activeJobs: protectWork ? 1 : 0, initialStartupFailureCode: failureCode, initialStartupCauseCode: causeCode,
    initialStartupLaunchesFile: launchesFile, initialStartupDescendantPidFile: descendant ? descendantFile : undefined });
  if (descendant) {
    // A real surviving socket service in the same process group, rather than
    // treating launcher exit or an unresponsive child as proof of no work.
    writeFakeLauncher(orphanLauncher, path.join(root, "orphan-args.json"), {
      activeJobs: ["protected", "lost-cancel-ack", "restore-held"].includes(orphanState) ? 1 : 0,
      backgroundProcessUnknownAgents: orphanState === "unknown" ? 1 : 0
    });
    let orphan = readFileSync(orphanLauncher, "utf8");
    orphan = orphan.replace("server.listen(socketPath);", "server.listen(socketPath, () => process.send?.('ready'));");
    orphan = orphan.replace("const result = request.method", `
      appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify({ method: request.method, params: request.params }) + "\\n");
      // Readiness also uses plain snapshots before launcher exit. Inject the
      // fault at cleanup's inspection/drain boundary, not an earlier probe.
      // expectTargetedDrain still rejects snapshot-only cleanup.
      const protectionRead = request.method === "runtime.beginDrain" ||
        (request.method === "runtime.snapshot" && request.params?.inspectBackgroundProcesses === true);
      if (protectionRead && ${JSON.stringify(orphanState === "unreachable")}) { socket.destroy(); return; }
      if (request.method === "runtime.beginDrain" && ${JSON.stringify(orphanState === "lost-drain-ack")}) { socket.destroy(); return; }
      if (request.method === "runtime.cancelDrain" && ${JSON.stringify(orphanState === "lost-cancel-ack")}) { socket.destroy(); return; }
      if (protectionRead && ${JSON.stringify(orphanState === "changed-owner")}) {
        writeFileSync(${JSON.stringify(path.join(runDirectory, "launcher.lock", "owner.json"))}, JSON.stringify({
          pid: process.pid, token: ${JSON.stringify(randomUUID())}, startedAt: new Date().toISOString()
        }) + "\\n");
      }
      const result = request.method`);
    orphan = orphan.replace('if (request.method !== "companion.hello" && admissionFile)', `
      if (request.method !== "companion.hello" && ${JSON.stringify(orphanState === "pending-admission")}) result.pendingAdmissions = 1;
      if (request.method === "runtime.beginDrain" && ${JSON.stringify(orphanState === "false-drain-ack")}) result.acceptingNewJobs = true;
      // Attempt a new admission after the idle result has been built. A plain
      // snapshot permits it; beginDrain's existing synchronous gate rejects it.
      if (protectionRead && ${JSON.stringify(orphanState === "admission-race")}) {
        appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify({ method: "fixture.admission-race", accepted: acceptingNewJobs }) + "\\n");
      }
      if (request.method !== "companion.hello" && admissionFile)`);
    if (orphanState === "restore-held") orphan = orphan.replace('setTimeout(() => {', `
      if (request.method === "runtime.cancelDrain") {
        writeFileSync(${JSON.stringify(restoreReady)}, "ready");
        const release = watch(${JSON.stringify(restoreRelease)}, () => {
          if (readFileSync(${JSON.stringify(restoreRelease)}, "utf8") !== "1") return;
          release.close(); socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
        });
        return;
      }
      setTimeout(() => {`);
    writeFileSync(orphanLauncher, orphan);
    let launcher = readFileSync(launcherPath, "utf8");
    launcher = launcher.replace(/const descendant = spawn\(process\.execPath, \["-e", "[^"\n]*process\.send\('ready'\)[^\n]+/,
      `const descendant = spawn(process.execPath, [${JSON.stringify(orphanLauncher)}, '--env-file', ${JSON.stringify(envFile)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`);
    if (orphanState === "missing-owner") launcher = launcher.replace(
      'descendant.once("message", () => setTimeout(() => process.exit(1), 100));',
      'descendant.once("message", () => { unlinkSync(path.join(runtimeLockDirectory, "owner.json")); rmdirSync(runtimeLockDirectory); setTimeout(() => process.exit(1), 100); });');
    writeFileSync(launcherPath, launcher);
  }
  updateRuntimeEnvFile(envFile, { apiKey: "sk-startup-fixture-1234567890123456", tunnelId: "tunnel_oooooooooooooooooooooooooooooooo" });
  // A developer's default profile may need migration. That intentionally takes
  // the protected legacy path and must not select this startup fixture's path.
  const stateDatabaseFile = path.join(root, "state.sqlite");
  appendFileSync(envFile, `CODEX_MCP_BRIDGE_STATE_DATABASE_FILE=${stateDatabaseFile}\n`);
  // Both supervisor reads and child launchers prefer process.env to .env.
  vi.stubEnv("CODEX_MCP_BRIDGE_STATE_DATABASE_FILE", stateDatabaseFile);
  vi.stubEnv("CODEX_GPT_BRIDGE_STATE_DATABASE_FILE", stateDatabaseFile);
  const options = { bridgeRoot, envFile, launcherPath, bridgeSocketPath: path.join(runDirectory, "bridge.sock"),
    runtimeLockDirectory: path.join(runDirectory, "launcher.lock"),
    codexRuntimeManager: new CodexRuntimeManager({ root: path.join(root, "cli"), discoverExternal: false }),
    registeredProjectRoots: () => [], startupBoot: { id: randomUUID(), startedAt: Date.now() - 60_000 }, autoRestart: false, lifecycleIntervalMs: 20, startTimeoutMs: 5000, processInspectorSpawn };
  const supervisor = new MacOSBridgeSupervisor(options), others: MacOSBridgeSupervisor[] = [];
  cleanups.push(async () => {
    const runtime = descendant && supervisor.lifecycleStatus()?.phase === "failed" ? "preserve" : "force-stop";
    try { await supervisor.close({ runtime }); for (const s of others) await s.close({ runtime }); }
    finally {
      // A preserved orphan deliberately outlives its launcher. Only teardown
      // may kill the exact fixture command; automatic startup must not do so.
      if (descendant) {
        const pid = Number(readFileSync(descendantFile, "utf8"));
        try {
          const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
          if (command.includes(orphanLauncher)) process.kill(pid, "SIGKILL");
        } catch { /* Already stopped by a confirmed idle cleanup. */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, supervisor, envFile, options,
    restorePending: () => existsSync(restoreReady), releaseRestore: () => writeFileSync(restoreRelease, "1"),
    launches: () => readFileSync(launchesFile, "utf8").trim().split("\n").map(row => JSON.parse(row)),
    orphanRequests: () => readFileSync(requestsFile, "utf8").trim().split("\n").map(row => JSON.parse(row)),
    descendant: () => Number(readFileSync(descendantFile, "utf8")),
    recover: () => { const s = new MacOSBridgeSupervisor(options); others.push(s); return s; } };
}

function expectTargetedDrain(f: ReturnType<typeof fixture>, method: "runtime.beginDrain" | "runtime.cancelDrain") {
  const first = f.launches()[0];
  expect(f.orphanRequests()).toEqual(expect.arrayContaining([expect.objectContaining({ method,
    params: expect.objectContaining({ expectedRuntime: expect.objectContaining({ launcherPid: first.pid,
      token: first.token, requestId: first.requestId, attempt: first.attempt }) }) })]));
}

it.each(["CODEX_MCP_BRIDGE_STATE_DATABASE_FILE", "CODEX_GPT_BRIDGE_STATE_DATABASE_FILE"])(
  "isolates startup from an inherited %s database path", async variable => {
    const externalRoot = mkdtempSync(path.join(tmpdir(), "startup-external-state-"));
    const externalFile = path.join(externalRoot, "external.sqlite");
    const sentinel = "external developer state must not be read as a fixture database\n";
    writeFileSync(externalFile, sentinel);
    vi.stubEnv("CODEX_MCP_BRIDGE_STATE_DATABASE_FILE", undefined);
    vi.stubEnv("CODEX_GPT_BRIDGE_STATE_DATABASE_FILE", undefined);
    vi.stubEnv(variable, externalFile);
    try {
      const f = fixture(0);
      await f.supervisor.startOnLaunch();
      expect(f.supervisor.lifecycleStatus()).toMatchObject({ phase: "completed", startup: { attempts: 1 } });
      expect(readFileSync(externalFile, "utf8")).toBe(sentinel);
      expect(readdirSync(externalRoot)).toEqual(["external.sqlite"]);
    } finally {
      cleanups.push(async () => { rmSync(externalRoot, { recursive: true, force: true }); });
    }
  }
);

it("retries the same initial intent only after its owned launcher/group/lock is cleared", async () => {
  const f = fixture(1, "STARTUP_HTTP_TIMEOUT", undefined, true); await f.supervisor.startOnLaunch();
  const first = f.supervisor.lifecycleStatus()!;
  expect(first).toMatchObject({ phase: "waiting", startup: { attempts: 1, failureCode: "STARTUP_HTTP_TIMEOUT" } });
  const descendant = f.descendant(); expect(() => process.kill(descendant, 0)).toThrow();
  expectTargetedDrain(f, "runtime.beginDrain");
  await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("completed"), { timeout: 8000 });
  const status = await f.supervisor.health();
  expect(status).toMatchObject({ phase: "running", bridge: { connected: true }, tunnel: { connected: true } });
  expect(f.supervisor.lifecycleStatus()).toMatchObject({ requestId: first.requestId, startup: { attempts: 2, deadlineAt: first.startup!.deadlineAt } });
  const launches = f.launches(); expect(launches).toHaveLength(2); expect(launches[0].token).not.toBe(launches[1].token);
  expect(() => process.kill(launches[0].pid, 0)).toThrow();
});

it.each(["stop", "cancel", "expired-intent"] as const)("recovery reply waiting during %s preserves work and cannot authorize another attempt", async action => {
  const f = fixture(1, "STARTUP_HTTP_TIMEOUT", undefined, true, false, "restore-held");
  const starting = f.supervisor.startOnLaunch();
  await vi.waitFor(() => expect(f.restorePending()).toBe(true), { timeout: 4000 });
  const requestId = f.supervisor.lifecycleStatus()!.requestId;
  if (action === "stop") await expect(f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "stop", force: false }))
    .rejects.toThrow("INITIAL_START_RETRY_SUPPRESSED");
  else if (action === "cancel") expect(() => f.supervisor.cancelLifecycle(requestId)).toThrow("INITIAL_START_RETRY_SUPPRESSED");
  else await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "start", force: false,
    applicationLaunchAt: new Date(Date.now() - 300_500).toISOString() });
  f.releaseRestore(); await starting;
  expect(f.supervisor.lifecycleStatus()).toMatchObject({ phase: "failed", startup: { attempts: 1 } });
  if (action === "expired-intent") expect(f.supervisor.lifecycleStatus()!.startup!.deadlineAt).toBeLessThanOrEqual(Date.now());
  else expect(f.supervisor.lifecycleStatus()!.startup!.retrySuppressed).toBe(true);
  expect(f.launches()).toHaveLength(1); expect(() => process.kill(f.descendant(), 0)).not.toThrow();
  await f.supervisor.close(); const recovered = f.recover(); await recovered.startOnLaunch();
  expect(recovered.lifecycleStatus()?.requestId).toBe(requestId); expect(f.launches()).toHaveLength(1);
  // Executing stop/cancel keeps the existing rejection contract; this does not
  // assert that the currently protected runtime was stopped or interrupted.
});

it("owner and socket service replacement while ps is pending cannot close replacement admission", async () => {
  let f: ReturnType<typeof fixture>;
  let replacement: ChildProcess | undefined;
  let intercepted = false;
  const inspector = ((command: string, args: string[], options: SpawnOptions) => {
    if (intercepted) return spawn(command, args, options);
    intercepted = true;
    const observation = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    queueMicrotask(() => { void (async () => {
      const first = f.launches()[0], oldDescendant = f.descendant();
      const replacementFile = path.join(f.root, "replacement.mjs");
      writeFakeLauncher(replacementFile, path.join(f.root, "replacement-args.json"));
      writeFileSync(replacementFile, readFileSync(replacementFile, "utf8").replace("server.listen(socketPath);", "server.listen(socketPath, () => process.send?.('ready'))"));
      const environment = { ...process.env };
      for (const key of Object.keys(environment)) if (key.startsWith("CODEX_MCP_BRIDGE_INITIAL_START_")) delete environment[key];
      const token = randomUUID();
      Object.assign(environment, { CODEX_MCP_BRIDGE_COMPANION_SOCKET: f.options.bridgeSocketPath,
        CODEX_MCP_BRIDGE_INITIAL_START_REQUEST: randomUUID(), CODEX_MCP_BRIDGE_INITIAL_START_TOKEN: token,
        CODEX_MCP_BRIDGE_INITIAL_START_ATTEMPT: "1", CODEX_MCP_BRIDGE_INITIAL_START_DEADLINE: String(Date.now() + 60_000) });
      replacement = spawn(process.execPath, [replacementFile, "--env-file", f.envFile], { env: environment,
        detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      await new Promise<void>((resolve, reject) => { replacement!.once("message", () => resolve()); replacement!.once("error", reject); });
      writeFileSync(path.join(f.options.runtimeLockDirectory, "owner.json"), JSON.stringify({ pid: replacement.pid,
        token, startedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
      observation.stdout.write(`${oldDescendant} 1 ${first.pid}\n`); observation.emit("close", 0);
    })().catch(error => observation.emit("error", error)); });
    return observation as unknown as ChildProcess;
  }) as typeof spawn;
  f = fixture(1, "STARTUP_HTTP_TIMEOUT", undefined, true, false, "idle", inspector);
  try {
    await f.supervisor.startOnLaunch();
    expect(f.supervisor.lifecycleStatus()).toMatchObject({ phase: "failed", startup: { attempts: 1 } });
    expect(f.launches()).toHaveLength(1); expect(() => process.kill(f.descendant(), 0)).not.toThrow();
    const admission = await new Promise<{ acceptingNewJobs: boolean }>((resolve, reject) => {
      const socket = createConnection(f.options.bridgeSocketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("replacement observation timeout")); }, 1000);
      socket.on("error", error => { clearTimeout(timer); reject(error); });
      socket.on("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: "read-only-proof", method: "runtime.snapshot", params: {} }) + "\n"));
      socket.on("data", data => { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(data.toString()).result); });
    });
    expect(admission.acceptingNewJobs).toBe(true);
  } finally { if (replacement?.exitCode === null && replacement.signalCode === null) replacement.kill("SIGKILL"); }
});

it.each([
  ["protected", "STARTUP_WORK_PROTECTED"],
  ["unknown", "STARTUP_RUNTIME_STATE_UNCONFIRMED"],
  ["unreachable", "STARTUP_RUNTIME_STATE_UNCONFIRMED"],
  ["missing-owner", "STARTUP_OWNERSHIP_UNCONFIRMED"],
  ["changed-owner", "STARTUP_OWNERSHIP_UNCONFIRMED"],
  ["pending-admission", "STARTUP_WORK_PROTECTED"],
  ["lost-drain-ack", "STARTUP_RUNTIME_STATE_UNCONFIRMED"],
  ["lost-cancel-ack", "STARTUP_WORK_PROTECTED"],
  ["false-drain-ack", "STARTUP_RUNTIME_STATE_UNCONFIRMED"]
] as const)("preserves the %s orphan after launcher exit and forbids another automatic spawn", async (state, code) => {
  const f = fixture(1, "STARTUP_HTTP_TIMEOUT", undefined, true, false, state);
  await f.supervisor.startOnLaunch();
  const first = f.supervisor.lifecycleStatus()!;
  expect(first).toMatchObject({ phase: "failed", startup: { attempts: 1, failureCode: code } });
  expect(first.error).toContain("STARTUP_HTTP_TIMEOUT");
  expect(() => process.kill(f.descendant(), 0)).not.toThrow();
  expect(() => process.kill(f.launches()[0].pid, 0)).toThrow();
  if (state !== "missing-owner") {
    expectTargetedDrain(f, "runtime.beginDrain");
    if (state === "changed-owner") {
      expect(f.orphanRequests().some(request => request.method === "runtime.cancelDrain")).toBe(false);
    } else {
      expectTargetedDrain(f, "runtime.cancelDrain");
    }
    if (state === "lost-cancel-ack") expect(first.error).toContain("STARTUP_DRAIN_CANCEL_UNCONFIRMED");
  }
  await coordinator(f.supervisor).settled();
  await f.supervisor.close(); const recovered = f.recover(); await recovered.startOnLaunch();
  expect(recovered.lifecycleStatus()).toMatchObject({ requestId: first.requestId, phase: "failed", startup: { attempts: 1, failureCode: code } });
  expect(f.launches()).toHaveLength(1);
  expect(() => process.kill(f.descendant(), 0)).not.toThrow();
});

it("closes admission before an idle orphan response can race a new Job, then cleans up and retries", async () => {
  const f = fixture(1, "STARTUP_HTTP_TIMEOUT", undefined, true, false, "admission-race");
  await f.supervisor.startOnLaunch();
  expect(f.supervisor.lifecycleStatus()).toMatchObject({ phase: "waiting", startup: { attempts: 1 } });
  expectTargetedDrain(f, "runtime.beginDrain");
  expect(f.orphanRequests().filter(request => request.method === "fixture.admission-race"))
    .toEqual([{ method: "fixture.admission-race", accepted: false }]);
  expect(() => process.kill(f.descendant(), 0)).toThrow();
  await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("completed"), { timeout: 8000 });
  expect(f.launches()).toHaveLength(2);
});

it("preserves backoff, deadline and attempt count when only the helper re-enters", async () => {
  const f = fixture(); await f.supervisor.startOnLaunch(); const first = f.supervisor.lifecycleStatus()!;
  await f.supervisor.close(); const recovered = f.recover(); await recovered.startOnLaunch();
  expect(recovered.lifecycleStatus()?.requestId).toBe(first.requestId);
  await vi.waitFor(() => expect(recovered.lifecycleStatus()?.phase).toBe("completed"), { timeout: 8000 });
  expect(recovered.lifecycleStatus()).toMatchObject({ startup: { attempts: 2, deadlineAt: first.startup!.deadlineAt } });
  expect(f.launches()).toHaveLength(2);
});

it("a user stop during startup backoff stays stopped after replay and helper-only respawn", async () => {
  const f = fixture(); await f.supervisor.startOnLaunch(); const first = f.supervisor.lifecycleStatus()!;
  const stop = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "stop", force: false, replacesRequestId: first.requestId });
  await coordinator(f.supervisor).settled(); expect(f.supervisor.lifecycleStatus()?.phase).toBe("completed");
  await f.supervisor.close(); const recovered = f.recover(); await recovered.startOnLaunch();
  expect(recovered.lifecycleStatus()?.requestId).toBe(stop.requestId); expect((await recovered.health()).pid).toBeNull();
  expect(f.launches()).toHaveLength(1);
});

it("retains a permanent child storage cause without treating it as readiness timeout", async () => {
  const f = fixture(1, "STARTUP_STATE_FAILED", "STATE_STORAGE_CORRUPT"); await f.supervisor.startOnLaunch();
  expect(f.supervisor.lifecycleStatus()).toMatchObject({ phase: "failed", startup: { attempts: 1, failureCode: "STARTUP_STATE_FAILED" } });
  expect(f.supervisor.lifecycleStatus()?.error).toContain("STATE_STORAGE_CORRUPT");
  await f.supervisor.close(); const recovered = f.recover(); await recovered.startOnLaunch();
  expect(f.launches()).toHaveLength(1); expect((await recovered.health()).pid).toBeNull();
});

it("a changed configuration during backoff fails the frozen target without another spawn", async () => {
  const f = fixture(); await f.supervisor.startOnLaunch();
  writeFileSync(f.envFile, readFileSync(f.envFile, "utf8") + "\nLOG_LEVEL=warn\n", { mode: 0o600 });
  await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("failed"), { timeout: 4000 });
  expect(f.supervisor.lifecycleStatus()?.error).toContain("LIFECYCLE_TARGET_CHANGED");
  expect(f.launches()).toHaveLength(1);
});

it("refuses a new spawn or cleanup when a different live owner takes the lock during backoff", async () => {
  const f = fixture(); await f.supervisor.startOnLaunch();
  mkdirSync(f.options.runtimeLockDirectory, { mode: 0o700 });
  const file = path.join(f.options.runtimeLockDirectory, "owner.json");
  const foreign = JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }) + "\n";
  writeFileSync(file, foreign, { mode: 0o600 });
  try {
    await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("failed"), { timeout: 4000 });
    expect(f.supervisor.lifecycleStatus()?.error).toContain("STARTUP_OWNERSHIP_CONFLICT");
    expect(f.launches()).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(foreign);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  } finally { rmSync(f.options.runtimeLockDirectory, { recursive: true }); }
});

it("a near-expiry initial intent preserves freshly confirmed protected work instead of killing it to retry", async () => {
  const f = fixture(0, "STARTUP_HTTP_TIMEOUT", undefined, false, true);
  // A real old launch timestamp exercises remaining-budget admission. This is
  // a stale-intent boundary, not an accelerated endurance/boot acceptance run.
  await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "start", force: false,
    applicationLaunchAt: new Date(Date.now() - 292_000).toISOString() });
  await coordinator(f.supervisor).settled();
  const record = f.supervisor.lifecycleStatus()!;
  expect(record).toMatchObject({ phase: "failed", startup: { attempts: 1, failureCode: "STARTUP_WORK_PROTECTED", failureStage: "tunnel" } });
  expect(record.error).toContain("STARTUP_ATTEMPT_TIMEOUT");
  const status = await f.supervisor.health();
  expect(status.bridge.activeJobs).toBe(1); expect(status.pid).not.toBeNull();
  expect(() => process.kill(status.pid!, 0)).not.toThrow();
  expect(f.launches()).toHaveLength(1);
});

it("adopts a completed initial runtime on helper-only re-entry without resetting its receipt or budget", async () => {
  const f = fixture(0); await f.supervisor.startOnLaunch();
  const original = f.supervisor.lifecycleStatus()!; const pid = (await f.supervisor.health()).pid;
  await f.supervisor.close(); const recovered = f.recover(); await recovered.startOnLaunch();
  expect(recovered.lifecycleStatus()).toMatchObject({ requestId: original.requestId, startup: original.startup });
  expect((await recovered.health()).pid).toBe(pid); expect(f.launches()).toHaveLength(1);
});

it("a proven new OS boot after completed startup establishes a distinct initial intent", async () => {
  const f = fixture(0); await f.supervisor.startOnLaunch(); const original = f.supervisor.lifecycleStatus()!;
  await f.supervisor.close({ runtime: "force-stop" });
  const next = new MacOSBridgeSupervisor({ ...f.options, startupBoot: { id: randomUUID(), startedAt: Date.now() } });
  try {
    await next.startOnLaunch();
    expect(next.lifecycleStatus()?.requestId).not.toBe(original.requestId);
    expect(next.lifecycleStatus()).toMatchObject({ phase: "completed", startup: { attempts: 1, source: "helper-launch" } });
    expect(f.launches()).toHaveLength(2);
  } finally { await next.close({ runtime: "force-stop" }); }
});

it("startup diagnostics expose fixed stage/count/timing fields and no private owner identity", async () => {
  vi.stubEnv("CODEX_MCP_BRIDGE_STARTUP_DIAGNOSTICS", "1");
  try {
    const f = fixture(0); await f.supervisor.startOnLaunch();
    const rows = f.supervisor.logs(200).filter(row => row.message.startsWith("[bridge-startup] "))
      .map(row => JSON.parse(row.message.slice("[bridge-startup] ".length)));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["attempt", "cpuSystemMs", "cpuUserMs", "elapsedMs", "pid", "role", "stage"]);
      expect(row.attempt).toBe(1); expect(row.role).toBe("helper");
      expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  } finally { vi.unstubAllEnvs(); }
});
