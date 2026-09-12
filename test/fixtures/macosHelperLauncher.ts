import { writeFileSync } from "node:fs";

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
  } = {}
): void {
  writeFileSync(file, `
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
const socketPath = process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET;
const statusIndex = process.argv.indexOf("--runtime-status-file");
const runtimeStatusFile = statusIndex >= 0 ? process.argv[statusIndex + 1] : null;
const envIndex = process.argv.indexOf("--env-file");
const envFile = envIndex >= 0 ? process.argv[envIndex + 1] : null;
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
    token: "00000000-0000-4000-8000-000000000001",
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
    phase: "running",
    runtimeBuildId: "development",
    tunnel: {
      phase: "connected",
      profile: ${JSON.stringify(options.runtimeProfile || null)} || profile,
      transport: ${JSON.stringify(options.runtimeTransport || null)} || transport,
      doctorPassed: true,
      processRunning: true,
      connected: true,
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      lastProblem: null
    }
  }), { mode: 0o600 });
}
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
      protocol: { name: "codex-mcp-bridge-companion", version: 2 },
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
`, { mode: 0o700 });
}
