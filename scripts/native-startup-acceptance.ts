import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { updateRuntimeEnvFile } from "./runtime-env.mjs";
import { writeFakeLauncher } from "../test/fixtures/macosHelperLauncher.js";

// Run the unmodified native application entry point and production helper in
// private directories. Only the launcher/Tunnel/workload and Codex CLI are fake.
// No menu interaction, installed service, real account or real task is needed.
if (process.platform !== "darwin") throw new Error("Requires macOS.");
const repository = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp("/tmp/bridge-startup-");
const runtime = path.join(root, "runtime");
const configuration = path.join(root, "codex-mcp-bridge");
const run = path.join(configuration, "run");
const socket = path.join(run, "helper.sock");
const environmentFile = path.join(configuration, ".env");
const startsFile = path.join(root, "starts.jsonl");
await mkdir(path.join(root, "tmp"), { recursive: true });
await mkdir(path.join(runtime, "scripts"), { recursive: true });
await cp(path.join(repository, "dist"), path.join(runtime, "dist"), { recursive: true });
await cp(path.join(repository, "scripts"), path.join(runtime, "scripts"), { recursive: true });
await cp(path.join(repository, "package.json"), path.join(runtime, "package.json"));
await cp(path.join(repository, "release-manifest.json"), path.join(runtime, "release-manifest.json"));
await symlink(path.join(repository, "node_modules"), path.join(runtime, "node_modules"), "dir");
const build = JSON.parse(await readFile(path.join(runtime, "dist/build-info.json"), "utf8"));
const launcher = path.join(runtime, "scripts/start-codex-mcp-bridge.mjs");
writeFakeLauncher(launcher, path.join(root, "launcher-arguments.json"), { writeRuntimeLock: true });
await writeFile(launcher, (await readFile(launcher, "utf8")).replaceAll('"development"', JSON.stringify(build.id)) +
  `\nappendFileSync(${JSON.stringify(startsFile)}, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\\n");\n`);
updateRuntimeEnvFile(environmentFile, {
  apiKey: "sk-native-acceptance-1234567890123456", tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
});
const codex = path.join(root, "fixture-codex");
await writeFile(codex, '#!/bin/sh\nprintf "codex-cli 0.153.3\\n"\n', { mode: 0o700 });
execFileSync("swift", ["build", "--package-path", "macos", "--product", "CodexBridgeMenuBar",
  "-Xswiftc", "-strict-concurrency=complete", "-Xswiftc", "-warnings-as-errors"], { cwd: repository, stdio: "inherit" });
const bin = execFileSync("swift", ["build", "--package-path", "macos", "--show-bin-path"], { cwd: repository, encoding: "utf8" }).trim();
const app = path.join(root, "Bridge Startup Acceptance.app");
const executable = path.join(app, "Contents/MacOS/CodexBridgeMenuBar");
await mkdir(path.dirname(executable), { recursive: true });
await cp(path.join(bin, "CodexBridgeMenuBar"), executable);
await writeFile(path.join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.menaje.bridge-startup-acceptance</string>
<key>CFBundleName</key><string>Bridge Startup Acceptance</string><key>CFBundleExecutable</key><string>CodexBridgeMenuBar</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/></dict></plist>`);
execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });
const children: ChildProcess[] = [];
const runtimePids = new Set<number>();
const events: unknown[] = [];
const launch = () => {
  const child = spawn(executable, [], { cwd: runtime, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, TMPDIR: path.join(root, "tmp"), XDG_CONFIG_HOME: root, XDG_STATE_HOME: path.join(root, "state"),
    CODEX_MCP_BRIDGE_ROOT: runtime, CODEX_MCP_BRIDGE_NODE: process.execPath,
    CODEX_MCP_BRIDGE_ENV_FILE: environmentFile, CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT: "1",
    CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "cli"), CODEX_MCP_BRIDGE_CODEX: codex,
    CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE: path.join(root, "settings.json")
  } });
  child.stdout?.on("data", data => process.stdout.write(data));
  child.stderr?.on("data", data => process.stderr.write(data));
  child.once("exit", (code, signal) => events.push({ event: "app-exited", pid: child.pid, code, signal }));
  children.push(child);
  events.push({ event: "app-launched", pid: child.pid, at: new Date().toISOString() });
  return child;
};
const starts = async () => (await readFile(startsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const journal = async () => JSON.parse(await readFile(path.join(run, "lifecycle.json"), "utf8"));
async function ready() {
  let status: any;
  await until(async () => {
    status = await rpc("helper.health");
    return status.phase === "running" && status.pid && status.bridge.connected && status.tunnel.connected &&
      status.lifecycle?.phase === "completed";
  }, "native app did not automatically prepare the runtime");
  runtimePids.add(status.pid);
  events.push({ event: "runtime-ready", pid: status.pid, at: new Date().toISOString(), lifecycle: status.lifecycle });
  return status;
}
async function shutdown(child: ChildProcess) {
  const request = await rpc("lifecycle.request", { requestId: randomUUID(), kind: "shutdown", force: false });
  await until(async () => child.exitCode !== null || child.signalCode !== null, "native app did not finish its shutdown handoff");
  assert.equal(child.exitCode, 0);
  const receipt = JSON.parse(await readFile(path.join(run, "lifecycle-handoff.json"), "utf8"));
  assert.equal(receipt.requestId, request.requestId);
  assert.equal(receipt.outcome, "completed");
  events.push({ event: "app-shutdown-completed", pid: child.pid, at: new Date().toISOString(), receipt });
  return request.requestId;
}
try {
  const first = launch();
  const firstStatus = await ready();
  assert.equal((await starts()).length, 1);
  const duplicate = launch();
  await until(async () => duplicate.exitCode === 0, "duplicate app did not exit");
  assert.equal((await starts()).length, 1);
  const previousShutdown = await shutdown(first);
  const second = launch();
  const secondStatus = await ready();
  assert.notEqual(secondStatus.pid, firstStatus.pid);
  assert.equal((await starts()).length, 2);
  const records = (await journal()).records;
  assert.equal(records.find((record: any) => record.request.requestId === previousShutdown).phase, "completed");
  assert.ok(records.at(-1).request.applicationLaunchAt, "relaunch must carry the native application's new start intent");
  const stop = await rpc("lifecycle.request", { requestId: randomUUID(), kind: "stop", force: false });
  await until(async () => (await rpc("lifecycle.status", { requestId: stop.requestId })).operation.phase === "completed", "manual stop failed");
  const stableUntil = Date.now() + 6500;
  while (Date.now() < stableUntil) {
    const status = await rpc("helper.health");
    assert.equal(status.pid, null);
    assert.equal(status.phase, "stopped");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal((await starts()).length, 2);
  events.push({ event: "manual-stop-stayed-stopped", at: new Date().toISOString() });
  await shutdown(second);
  const report = { passed: true, root, runtimeBuild: build.id, nativeEntryPoint: "CodexBridgeMenuBarApp",
    scope: "real native application and helper; synthetic launcher/Tunnel/workload and CLI; no menu interaction", events };
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ root, events, journal: await journal().catch(() => null) }, null, 2));
  throw error;
} finally {
  // Only processes created by this private fixture are candidates for cleanup.
  for (const record of await starts().catch(() => [])) runtimePids.add(record.pid);
  for (const pid of runtimePids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  for (const child of children) if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
}

async function until(predicate: () => Promise<unknown>, message: string) {
  const end = Date.now() + 30000;
  let error: unknown;
  while (Date.now() < end) {
    try { if (await predicate()) return; } catch (caught) { error = caught; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message, { cause: error });
}
function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket); let buffer = "";
    const timer = setTimeout(() => { connection.destroy(); reject(new Error(`RPC timeout: ${method}`)); }, 5000);
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write(JSON.stringify({ jsonrpc: "2.0", id: method, method, params }) + "\n"));
    connection.on("error", error => { clearTimeout(timer); reject(error); });
    connection.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      clearTimeout(timer); connection.destroy();
      try { const response = JSON.parse(buffer.split("\n")[0]);
        if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
      } catch (error) { reject(error); }
    });
  });
}
