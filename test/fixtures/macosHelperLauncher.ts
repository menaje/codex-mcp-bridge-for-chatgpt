import { writeFileSync } from "node:fs";
import { COMPANION_PROTOCOL_VERSION } from "../../src/companionServer.js";

export function writeFakeLauncher(
  file: string,
  argumentsFile: string,
  options: {
    activeJobs?: number;
    backgroundProcesses?: number;
    backgroundProcessUnknownAgents?: number;
    failTunnelId?: string;
    mutateEnvOnDrain?: string;
    failSnapshotAfterDrain?: boolean;
    memoryOnlyAfterDrain?: number;
    splitRuntimeSecret?: boolean;
    writeRuntimeLock?: boolean;
    runtimeProfile?: string;
    runtimeTransport?: string;
    detachedDescendantPidFile?: string;
    snapshotDelayFile?: string;
    healthDelayFile?: string;
    admissionFile?: string;
    failAuthenticationActivation?: boolean;
    initialStartupFailures?: number;
    initialStartupTunnelNeverReady?: boolean;
    initialStartupFailureCode?: string;
    initialStartupCauseCode?: string;
    initialStartupDescendantPidFile?: string;
    initialStartupLaunchesFile?: string;
  } = {}
): void {
  const runtimeEnvModule = new URL("../../scripts/runtime-env.mjs", import.meta.url).href;
  writeFileSync(file, `
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { codexAppliedEnvironment, codexChildEnvironment, codexChildEnvironmentFingerprint } from ${JSON.stringify(runtimeEnvModule)};
const socketPath = process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET;
const initialAttempt = process.env.CODEX_MCP_BRIDGE_INITIAL_START_REQUEST ? {
  requestId: process.env.CODEX_MCP_BRIDGE_INITIAL_START_REQUEST,
  token: process.env.CODEX_MCP_BRIDGE_INITIAL_START_TOKEN,
  attempt: Number(process.env.CODEX_MCP_BRIDGE_INITIAL_START_ATTEMPT),
  deadlineAt: Number(process.env.CODEX_MCP_BRIDGE_INITIAL_START_DEADLINE),
  stage: "ready", failureCode: null
} : null;
if (initialAttempt && !process.env.CODEX_MCP_BRIDGE_INITIAL_START_LAUNCHER_PID) process.env.CODEX_MCP_BRIDGE_INITIAL_START_LAUNCHER_PID = String(process.pid);
const drainIdentity = initialAttempt ? { ...initialAttempt, launcherPid: Number(process.env.CODEX_MCP_BRIDGE_INITIAL_START_LAUNCHER_PID) } : null;
let drainOwner = null;
let drainCancelled = false;
const initialFails = initialAttempt && initialAttempt.attempt <= ${JSON.stringify(options.initialStartupFailures || 0)};
if (initialAttempt && ${JSON.stringify(options.initialStartupLaunchesFile || "")}) appendFileSync(
  ${JSON.stringify(options.initialStartupLaunchesFile || "")}, JSON.stringify({ pid: process.pid, ...initialAttempt }) + "\\n");
const statusIndex = process.argv.indexOf("--runtime-status-file");
const runtimeStatusFile = statusIndex >= 0 ? process.argv[statusIndex + 1] : null;
const envIndex = process.argv.indexOf("--env-file");
const envFile = envIndex >= 0 ? process.argv[envIndex + 1] : null;
if (${JSON.stringify(Boolean(options.failAuthenticationActivation))} && process.env.CODEX_MCP_BRIDGE_AUTH_ACTIVATION_ID) process.exit(7);
Object.assign(process.env, codexChildEnvironment(envFile, process.env));
const lockIndex = process.argv.indexOf("--runtime-lock-directory");
const runtimeLockDirectory = lockIndex >= 0 ? process.argv[lockIndex + 1] : null;
const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : null;
const transportIndex = process.argv.indexOf("--transport");
const transport = transportIndex >= 0 ? process.argv[transportIndex + 1] : null;
let mutatedEnv = false;
let acceptingNewJobs = true;
let failedSnapshotAfterDrain = false;
if (${JSON.stringify(options.detachedDescendantPidFile || "")}) {
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore"
  });
  descendant.unref();
  writeFileSync(${JSON.stringify(options.detachedDescendantPidFile || "")}, String(descendant.pid));
}
if (${JSON.stringify(Boolean(options.splitRuntimeSecret))}) {
  process.stdout.write("credential=sk-split.secret+");
  setTimeout(() => process.stdout.write("1234567890123456=suffix\\n"), 50);
}
if (
  envFile &&
  ${JSON.stringify(options.failTunnelId || "")} &&
  readFileSync(envFile, "utf8").includes(${JSON.stringify(options.failTunnelId || "")})
) {
  process.exit(7);
}
mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
try { unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (${JSON.stringify(Boolean(options.writeRuntimeLock))} && runtimeLockDirectory) {
  mkdirSync(runtimeLockDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(runtimeLockDirectory, "owner.json"), JSON.stringify({
    pid: process.pid,
    token: initialAttempt?.token || "00000000-0000-4000-8000-000000000001",
    startedAt: new Date().toISOString()
  }) + "\\n", { mode: 0o600 });
}
writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv.slice(2)));
if (runtimeStatusFile) {
  writeFileSync(runtimeStatusFile, JSON.stringify({
    protocol: "codex-mcp-bridge-launcher-status",
    version: 1,
    generatedAt: new Date().toISOString(),
    launcherPid: process.pid,
    phase: initialFails ? "failed" : ${JSON.stringify(Boolean(options.initialStartupTunnelNeverReady))} ? "starting" : "running",
    ...(initialAttempt ? { startup: { ...initialAttempt,
      stage: initialFails ? "http" : ${JSON.stringify(Boolean(options.initialStartupTunnelNeverReady))} ? "tunnel" : "ready",
      failureCode: initialFails ? ${JSON.stringify(options.initialStartupFailureCode || "STARTUP_HTTP_TIMEOUT")} : null,
      causeCode: initialFails ? ${JSON.stringify(options.initialStartupCauseCode || null)} : null } } : {}),
    runtimeBuildId: "development",
    codexEnvironmentFingerprint: codexChildEnvironmentFingerprint(process.env),
    codexEnvironment: codexAppliedEnvironment(process.env),
    tunnel: {
      phase: "connected",
      profile: ${JSON.stringify(options.runtimeProfile || null)} || profile,
      transport: ${JSON.stringify(options.runtimeTransport || null)} || transport,
      doctorPassed: true,
      processRunning: true,
      connected: !${JSON.stringify(Boolean(options.initialStartupTunnelNeverReady))},
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      lastProblem: null
    }
  }), { mode: 0o600 });
}
if (initialFails) {
  if (${JSON.stringify(options.initialStartupDescendantPidFile || "")}) {
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    writeFileSync(${JSON.stringify(options.initialStartupDescendantPidFile || "")}, String(descendant.pid));
    descendant.once("message", () => setTimeout(() => process.exit(1), 100));
    descendant.unref();
  } else setTimeout(() => process.exit(1), 100);
} else {
const server = createServer((socket) => {
  socket.on("error", () => undefined);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    const admissionFile = ${JSON.stringify(options.admissionFile || "")};
    if (request.method === "changes.wait" && admissionFile) {
      let watcher, timer;
      const respond = () => {
        watcher?.close(); clearTimeout(timer);
        const revision = readFileSync(admissionFile, "utf8");
        socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id,
          result: { revision, topics: revision === request.params.after ? [] : ["dashboard"] } }) + "\\n");
      };
      if (readFileSync(admissionFile, "utf8") !== request.params.after) respond();
      else {
        watcher = watch(admissionFile, respond);
        timer = setTimeout(respond, 25000);
        socket.on("close", () => { watcher?.close(); clearTimeout(timer); });
        if (readFileSync(admissionFile, "utf8") !== request.params.after) respond();
      }
      return;
    }
    const draining = request.method === "runtime.beginDrain";
    const cancelling = request.method === "runtime.cancelDrain";
    const expected = request.params?.expectedRuntime;
    if ((draining || cancelling) && expected) {
      const matches = drainIdentity && ["launcherPid", "token", "requestId", "attempt"].every(key => expected[key] === drainIdentity[key]);
      if (!matches || Date.now() >= expected.deadlineAt || expected.deadlineAt > drainIdentity.deadlineAt + 7000 ||
          (draining && drainCancelled) || (!drainOwner && !acceptingNewJobs)) {
        socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "RUNTIME_DRAIN_TARGET_CHANGED" } }) + "\\n"); return;
      }
      if (draining) drainOwner = expected;
      else { drainOwner = null; drainCancelled = true; }
    } else if (cancelling && drainOwner) {
      socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "RUNTIME_DRAIN_NOT_OWNED" } }) + "\\n"); return;
    }
    if (draining && !expected) { drainOwner = null; if (drainIdentity) drainCancelled = true; }
    if (draining) acceptingNewJobs = false;
    if (request.method === "runtime.cancelDrain") acceptingNewJobs = true;
    if (draining && envFile && !mutatedEnv && ${JSON.stringify(Boolean(options.mutateEnvOnDrain))}) {
      appendFileSync(envFile, ${JSON.stringify(`${options.mutateEnvOnDrain || ""}\n`)});
      mutatedEnv = true;
    }
    if (
      request.method === "runtime.snapshot" &&
      !acceptingNewJobs &&
      !failedSnapshotAfterDrain &&
      ${JSON.stringify(Boolean(options.failSnapshotAfterDrain))}
    ) {
      failedSnapshotAfterDrain = true;
      socket.destroy();
      return;
    }
    const result = request.method === "companion.hello" ? {
      protocol: { name: "codex-mcp-bridge-companion", version: ${COMPANION_PROTOCOL_VERSION} },
      bridge: { buildId: "development" }
    } : {
      acceptingNewJobs,
      activeJobs: ${options.activeJobs || 0},
      pendingAdmissions: 0,
      memoryOnlyThreads: acceptingNewJobs ? 0 : ${options.memoryOnlyAfterDrain || 0},
      pendingInteractions: 0,
      backgroundProcessState: ${options.backgroundProcessUnknownAgents || 0} > 0 ? "unknown" : "confirmed",
      backgroundProcesses: ${options.backgroundProcesses || 0},
      backgroundProcessAgents: ${options.backgroundProcesses || 0} > 0 ? 1 : 0,
      backgroundProcessUnknownAgents: ${options.backgroundProcessUnknownAgents || 0}
    };
    if (request.method !== "companion.hello" && admissionFile) Object.assign(result, JSON.parse(readFileSync(admissionFile, "utf8")));
    const delayFile = request.method === "runtime.health"
      ? ${JSON.stringify(options.healthDelayFile || "")}
      : request.method === "runtime.snapshot" ? ${JSON.stringify(options.snapshotDelayFile || "")} : "";
    const responseDelay = delayFile
      ? Number(readFileSync(delayFile, "utf8")) : 0;
    setTimeout(() => {
      if (!socket.destroyed) socket.end(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result
      }) + "\\n");
    }, responseDelay);
  });
});
server.listen(socketPath);
const stop = () => server.close(() => {
  if (${JSON.stringify(Boolean(options.writeRuntimeLock))} && runtimeLockDirectory) {
    try { unlinkSync(path.join(runtimeLockDirectory, "owner.json")); } catch {}
    try { rmdirSync(runtimeLockDirectory); } catch {}
  }
  process.exit(0);
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
}
`, { mode: 0o700 });
}
