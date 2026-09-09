import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { updateRuntimeEnvFile } from "./runtime-env.mjs";
import { writeFakeLauncher } from "../test/fixtures/macosHelperLauncher.js";

// Real launchd and the built production helper; work/tunnel state and the two
// bundle identities are synthetic. Never load the installed app's label or state.
if (process.platform !== "darwin" || !process.argv.includes("--run-isolated")) {
  throw new Error("Run on macOS with --run-isolated. No installed service is used.");
}
const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync("/tmp/bridge-launchd-");
chmodSync(root, 0o700);
const runtime = path.join(root, "runtime");
const run = path.join(root, "config", "run");
mkdirSync(path.join(runtime, "dist"), { recursive: true, mode: 0o700 });
mkdirSync(path.join(runtime, "scripts"), { recursive: true, mode: 0o700 });
mkdirSync(run, { recursive: true, mode: 0o700 });
writeFileSync(path.join(runtime, "dist", "cli.js"), "");
const helperSocket = path.join(run, "helper.sock");
const bridgeSocket = path.join(run, "bridge.sock");
const lock = path.join(run, "launcher.lock");
const envFile = path.join(root, "config", ".env");
const admissionFile = path.join(root, "admission.json");
const startsFile = path.join(root, "starts.jsonl");
const launcher = path.join(runtime, "scripts", "start-codex-mcp-bridge.mjs");
const label = `com.menaje.bridge-lifecycle-test.${process.pid}.${randomUUID()}`;
const domain = `gui/${process.getuid!()}`;
const service = `${domain}/${label}`;
const plistFile = path.join(root, "helper.plist");
const execute = promisify(execFile);
const previousBuild = "launchd-fixture-previous";
const replacementBuild = "launchd-fixture-replacement";
const checks: string[] = [];
const startedAt = new Date().toISOString();
let loaded = false;
let passed = false;

updateRuntimeEnvFile(envFile, {
  apiKey: "sk-launchd-fixture-1234567890123456",
  tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
});
function writeLauncher(buildId: string) {
  writeFakeLauncher(launcher, path.join(root, "arguments.json"), { admissionFile, writeRuntimeLock: true });
  writeFileSync(launcher, readFileSync(launcher, "utf8").replaceAll('"development"', JSON.stringify(buildId)) +
  `\nappendFileSync(${JSON.stringify(startsFile)}, JSON.stringify({pid:process.pid})+'\\n', {mode:0o600});
// The real launcher refreshes its status while running. A one-shot fixture
// becomes stale during the 61-second wait and must correctly refuse adoption.
setInterval(() => {
  const status = JSON.parse(readFileSync(runtimeStatusFile, 'utf8'));
  status.generatedAt = new Date().toISOString();
  writeFileSync(runtimeStatusFile, JSON.stringify(status), {mode:0o600});
}, 1000);\n`);
}
writeLauncher(previousBuild);

function helperBundle(buildId: string): string {
  const bundle = path.join(root, buildId);
  mkdirSync(bundle, { mode: 0o700 });
  cpSync(path.join(repository, "dist"), path.join(bundle, "dist"), { recursive: true });
  cpSync(path.join(repository, "release-manifest.json"), path.join(bundle, "release-manifest.json"));
  symlinkSync(path.join(repository, "node_modules"), path.join(bundle, "node_modules"));
  symlinkSync(path.join(repository, "scripts"), path.join(bundle, "scripts"));
  writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ type: "module" }));
  const metadataFile = path.join(bundle, "dist", "build-info.json");
  const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  writeFileSync(metadataFile, JSON.stringify({ ...metadata, id: buildId }));
  return path.join(bundle, "dist", "macosHelper.js");
}
const previousHelper = helperBundle(previousBuild);
const replacementHelper = helperBundle(replacementBuild);
const update = (activeJobs: number) => writeFileSync(admissionFile, JSON.stringify({ activeJobs }), { mode: 0o600 });
update(1);
const environment = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  XDG_CONFIG_HOME: path.join(root, "config-home"),
  CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "cli"),
  CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE: path.join(root, "settings.json"),
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite")
};
// Match production KeepAlive, process type, throttle and shutdown grace.
const plist = {
  Label: label,
  ProgramArguments: [process.execPath, previousHelper, "--bridge-root", runtime, "--env-file", envFile,
    "--socket", helperSocket, "--bridge-socket", bridgeSocket, "--runtime-lock-directory", lock],
  WorkingDirectory: runtime, RunAtLoad: true, KeepAlive: true, ProcessType: "Background",
  ThrottleInterval: 10, ExitTimeOut: 45,
  StandardOutPath: path.join(root, "stdout.log"), StandardErrorPath: path.join(root, "stderr.log"),
  EnvironmentVariables: environment
};
async function writePlist() {
  writeFileSync(plistFile, JSON.stringify(plist), { mode: 0o600 });
  await execute("/usr/bin/plutil", ["-convert", "xml1", plistFile]);
}
await writePlist();

async function launchctl(...args: string[]) {
  return execute("/bin/launchctl", args, { timeout: 55_000, maxBuffer: 512 * 1024 });
}
async function bootstrap() {
  // Even a timed-out launchctl call may have loaded this unique service.
  // Keep cleanup responsible for it until bootout has been verified.
  loaded = true;
  await launchctl("bootstrap", domain, plistFile);
}
async function bootout() {
  await launchctl("bootout", service);
  loaded = false;
  await until(() => assert.equal(existsSync(helperSocket), false), "helper socket removal");
}
async function helperPid(): Promise<number> {
  const { stdout } = await launchctl("print", service);
  const pid = /^\s*pid = (\d+)\s*$/m.exec(stdout)?.[1];
  assert.ok(pid, "launchd reports a helper PID");
  return Number(pid);
}
async function until(check: () => unknown | Promise<unknown>, name: string, timeout = 30_000) {
  const end = Date.now() + timeout;
  let last: unknown;
  do {
    try { return await check(); } catch (error) { last = error; }
    await delay(200);
  } while (Date.now() < end);
  throw new Error(`${name}: ${String(last)}`);
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function starts(): number[] {
  return existsSync(startsFile) ? readFileSync(startsFile, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line).pid as number) : [];
}
function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(helperSocket);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Helper RPC timeout")), 5000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: method, method, params }) + "\n"));
    socket.on("error", error => finish(error));
    socket.on("close", () => { if (!settled) finish(new Error("Helper RPC closed before response")); });
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.split("\n")[0]);
        finish(response.error ? new Error(response.error.message) : undefined, response.result);
      } catch (error) { finish(error as Error); }
    });
  });
}
const health = () => rpc("helper.health");
const request = (kind: string, extra: Record<string, unknown> = {}) =>
  rpc("lifecycle.request", { requestId: randomUUID(), kind, force: false, ...extra });
async function waiting(requestId: string, runtimePid: number) {
  await until(async () => {
    const value = await health();
    assert.equal(value.pid, runtimePid);
    assert.equal(value.lifecycle.requestId, requestId);
    assert.equal(value.lifecycle.phase, "waiting");
    assert.ok(value.lifecycle.reasons.some((reason: { code: string }) => reason.code === "active-jobs"));
  }, "reservation with active work");
}
async function ready(requestId?: string): Promise<number> {
  return await until(async () => {
    const value = await health();
    assert.equal(value.phase, "running");
    assert.equal(value.bridge.connected, true);
    assert.equal(value.tunnel.connected, true);
    assert.equal(value.lifecycle.phase, "completed");
    if (requestId) assert.equal(value.lifecycle.requestId, requestId);
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 1);
    return value.pid as number;
  }, "runtime readiness") as number;
}
function record(check: string) { checks.push(check); console.log(`PASS: ${check}`); }

try {
  await bootstrap();
  const original = await ready();
  const cancelled = await request("restart");
  await waiting(cancelled.requestId, original);
  const waitStarted = Date.now();
  console.log("Waiting 61 seconds with an active synthetic Job and a durable restart reservation.");
  await delay(30_500);
  await waiting(cancelled.requestId, original);
  await delay(Math.max(1, 61_000 - (Date.now() - waitStarted)));
  await waiting(cancelled.requestId, original);
  assert.ok(Date.now() - waitStarted >= 61_000);
  record("launchd-managed helper preserves work and reservation beyond 60 seconds");
  assert.equal((await rpc("lifecycle.cancel", { requestId: cancelled.requestId })).phase, "cancelled");
  assert.equal((await health()).pid, original);
  record("cancelling the waiting reservation preserves the running work");

  const restart = await request("restart");
  await waiting(restart.requestId, original);
  const crashedHelper = await helperPid();
  await launchctl("kill", "SIGKILL", service);
  await until(async () => assert.notEqual(await helperPid(), crashedHelper), "launchd crash respawn");
  await waiting(restart.requestId, original);
  assert.deepEqual(starts(), [original]);
  record("SIGKILL respawn adopts the same runtime and reservation without a duplicate launch");
  update(0);
  const restarted = await ready(restart.requestId);
  assert.notEqual(restarted, original);
  await until(() => assert.equal(alive(original), false), "original runtime exit");
  assert.deepEqual(starts(), [original, restarted]);
  record("completion event applies the reservation once and verifies reconnection");

  update(1);
  const replacement = await request("helper-replace", { targetBuildId: replacementBuild });
  await waiting(replacement.requestId, restarted);
  await bootout();
  assert.equal(alive(restarted), true);
  await bootstrap();
  await waiting(replacement.requestId, restarted);
  record("launchd bootout and bootstrap preserve active work and replacement intent");
  update(0);
  await until(async () => assert.equal((await health()).lifecycle.phase, "handoff-ready"), "replacement preparation");
  await rpc("lifecycle.acknowledge", { requestId: replacement.requestId });
  await bootout();
  plist.ProgramArguments[1] = replacementHelper;
  writeLauncher(replacementBuild);
  await writePlist();
  await bootstrap();
  const replaced = await ready(replacement.requestId);
  assert.notEqual(replaced, restarted);
  assert.deepEqual(starts(), [original, restarted, replaced]);
  record("replacement completes after the new helper observes bridge and tunnel readiness");

  for (const kind of ["shutdown", "mode-switch"]) {
    const intent = await request(kind);
    await until(async () => {
      const value = await health();
      assert.equal(value.lifecycle.phase, "handoff-ready");
      assert.equal(value.pid, null);
    }, `${kind} preparation`);
    await rpc("lifecycle.acknowledge", { requestId: intent.requestId });
    await bootout();
    const before = starts();
    // This receipt models the native caller's completed final action. No real
    // app preference or connection mode is changed by this transport check.
    writeFileSync(path.join(run, "lifecycle-handoff.json"), JSON.stringify({
      requestId: intent.requestId, outcome: "completed"
    }), { mode: 0o600 });
    await bootstrap();
    await until(async () => {
      const value = await health();
      assert.equal(value.phase, "stopped");
      assert.equal(value.pid, null);
      assert.equal(value.lifecycle.requestId, intent.requestId);
      assert.equal(value.lifecycle.phase, "completed");
    }, `${kind} receipt recovery`);
    assert.deepEqual(starts(), before);
    record(`${kind} receipt survives re-entry without an automatic runtime launch`);
    if (kind === "shutdown") await ready((await request("start")).requestId);
  }
  await bootout();
  await until(() => { for (const pid of starts()) assert.equal(alive(pid), false); }, "fixture processes exit");
  assert.equal(existsSync(bridgeSocket), false);
  assert.equal(existsSync(lock), false);
  await assert.rejects(launchctl("print", service));
  record("test LaunchAgent, sockets, runtime processes and lock are removed");
  passed = true;
} finally {
  if (loaded) {
    update(0);
    await request("stop").then(intent => until(async () =>
      assert.equal((await health()).lifecycle.requestId === intent.requestId && (await health()).lifecycle.phase === "completed", true), "cleanup stop"))
      .catch(() => undefined);
    await bootout().catch(() => undefined);
  }
  for (const pid of starts()) if (alive(pid)) process.kill(pid, "SIGTERM");
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`Private fixture diagnostics retained at ${root}`);
}
console.log(JSON.stringify({ startedAt, outcome: "pass", checks,
  evidence: "real launchd and production helper; synthetic work/tunnel and native handoff receipt",
  installedRuntimeTouched: false, nativeUiVerified: false }, null, 2));
