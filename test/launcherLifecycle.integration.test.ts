import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const launcherPath = path.join(repositoryRoot, "scripts", "start-codex-mcp-bridge.mjs");

describe("managed launcher lifecycle", () => {
  it("waits for tunnel readiness and shutdown, then reuses only an unchanged profile", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-launcher-lifecycle-"));
    const configDirectory = path.join(root, "config");
    const profileDirectory = path.join(root, "profiles");
    const envFile = path.join(configDirectory, ".env");
    const profileFile = path.join(profileDirectory, "managed.yaml");
    const profileMetadataFile = path.join(configDirectory, "profiles", "managed.json");
    const runtimeStatusFile = path.join(configDirectory, "run", "launcher-status.json");
    const healthURLFile = path.join(configDirectory, "run", "tunnel-health.url");
    const tunnelPIDFile = path.join(configDirectory, "run", "tunnel.pid");
    const initializationLog = path.join(root, "initializations.log");
    const shutdownLog = path.join(root, "shutdown.log");
    const codexEnvironmentLog = path.join(root, "codex-environment.json");
    const fakeCodex = path.join(root, "fake-codex.mjs");
    const fakeTunnel = path.join(root, "fake-tunnel-client.mjs");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(envFile, [
      "CONTROL_PLANE_API_KEY=sk-launcher-test-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_llllllllllllllllllllllllllllllll",
      "OPENAI_API_KEY=sk-platform-key-must-not-be-used-1234567890",
      "AWS_SECRET_ACCESS_KEY=unrelated-secret-must-not-be-inherited",
      ""
    ].join("\n"), { mode: 0o600 });
    writeExecutable(fakeCodex, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(codexEnvironmentLog)}, JSON.stringify({
  openAIAPIKey: process.env.OPENAI_API_KEY ?? null,
  codexAPIKey: process.env.CODEX_API_KEY ?? null,
  unrelatedSecret: process.env.AWS_SECRET_ACCESS_KEY ?? null
}));
if (process.argv.slice(2).join(" ") === "mcp-server --help") process.exit(0);
process.exit(2);
`);
    writeExecutable(fakeTunnel, fakeTunnelSource({
      profileFile,
      initializationLog,
      shutdownLog
    }));

    const first = await runLauncher({
      envFile,
      fakeCodex,
      fakeTunnel,
      profileMetadataFile,
      runtimeStatusFile,
      healthURLFile,
      tunnelPIDFile
    });
    expect(first.output).not.toContain("sk-launcher-test");
    expect(first.output).not.toContain("sk-platform-key");
    expect(JSON.parse(readFileSync(codexEnvironmentLog, "utf8"))).toEqual({
      openAIAPIKey: null,
      codexAPIKey: null,
      unrelatedSecret: null
    });
    expect(initializationCount(initializationLog)).toBe(1);
    expect(readStatus(runtimeStatusFile)).toMatchObject({
      phase: "stopped",
      tunnel: { phase: "stopped", connected: false, processRunning: false }
    });
    expect(readFileSync(shutdownLog, "utf8").trim().split("\n")).toEqual(["SIGINT"]);
    expect(existsSync(path.join(configDirectory, "run", "launcher.lock"))).toBe(false);
    expect(statSync(profileMetadataFile).mode & 0o777).toBe(0o600);
    expect(statSync(runtimeStatusFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(profileFile, "utf8")).toContain(
      "'/usr/bin/env' '-u' 'CONTROL_PLANE_API_KEY'"
    );

    await runLauncher({
      envFile,
      fakeCodex,
      fakeTunnel,
      profileMetadataFile,
      runtimeStatusFile,
      healthURLFile,
      tunnelPIDFile
    });
    expect(initializationCount(initializationLog)).toBe(1);

    appendFileSync(profileFile, "# changed outside the managed launcher\n");
    await runLauncher({
      envFile,
      fakeCodex,
      fakeTunnel,
      profileMetadataFile,
      runtimeStatusFile,
      healthURLFile,
      tunnelPIDFile
    });
    expect(initializationCount(initializationLog)).toBe(2);
  }, 30_000);
});

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, `#!/usr/bin/env node\n${body.trim()}\n`, { mode: 0o700 });
  chmodSync(filePath, 0o700);
}

function fakeTunnelSource(paths: {
  profileFile: string;
  initializationLog: string;
  shutdownLog: string;
}): string {
  return `
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const profileFile = ${JSON.stringify(paths.profileFile)};
const initializationLog = ${JSON.stringify(paths.initializationLog)};
const shutdownLog = ${JSON.stringify(paths.shutdownLog)};
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args[0] === "--version") {
  console.log("fake-tunnel-client 1.0.0");
  process.exit(0);
}
if (args[0] === "profiles" && args[1] === "list") {
  console.log(JSON.stringify(existsSync(profileFile)
    ? [{ name: "managed", path: profileFile }]
    : []));
  process.exit(0);
}
if (args[0] === "init") {
  mkdirSync(path.dirname(profileFile), { recursive: true, mode: 0o700 });
  writeFileSync(profileFile, [
    "profile: managed",
    "tunnel: " + option("--tunnel-id"),
    "command: " + option("--mcp-command"),
    ""
  ].join("\\n"), { mode: 0o600 });
  chmodSync(profileFile, 0o600);
  appendFileSync(initializationLog, "init\\n");
  process.exit(0);
}
if (args[0] === "doctor") process.exit(0);
if (args[0] === "health") {
  try {
    const url = readFileSync(option("--url-file"), "utf8").trim();
    const pid = Number(readFileSync(option("--pid-file"), "utf8").trim());
    process.kill(pid, 0);
    process.exit(url.startsWith("http://127.0.0.1:") ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
if (args[0] === "run") {
  const healthFile = option("--health.url-file");
  const pidFile = option("--pid.file");
  writeFileSync(healthFile, "http://127.0.0.1:43123\\n", { mode: 0o600 });
  writeFileSync(pidFile, String(process.pid) + "\\n", { mode: 0o600 });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      appendFileSync(shutdownLog, signal + "\\n");
      process.exit(0);
    }, 100);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  setInterval(() => undefined, 1_000);
} else {
  process.exit(2);
}
`;
}

async function runLauncher(paths: {
  envFile: string;
  fakeCodex: string;
  fakeTunnel: string;
  profileMetadataFile: string;
  runtimeStatusFile: string;
  healthURLFile: string;
  tunnelPIDFile: string;
}): Promise<{ output: string }> {
  const environment = { ...process.env };
  delete environment.CONTROL_PLANE_API_KEY;
  delete environment.CONTROL_PLANE_TUNNEL_ID;
  delete environment.OPENAI_API_KEY;
  environment.CODEX_MCP_BRIDGE_CODEX = paths.fakeCodex;
  environment.CODEX_MCP_BRIDGE_MANAGED_BY_APP = "1";
  const child = spawn(process.execPath, [
    launcherPath,
    "--mode", "secure",
    "--transport", "stdio",
    "--env-file", paths.envFile,
    "--profile", "managed",
    "--tunnel-client", paths.fakeTunnel,
    "--profile-metadata-file", paths.profileMetadataFile,
    "--runtime-status-file", paths.runtimeStatusFile,
    "--tunnel-health-url-file", paths.healthURLFile,
    "--tunnel-pid-file", paths.tunnelPIDFile,
    "--require-built",
    "--reuse-profile"
  ], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  try {
    await waitForConnectedStatus(paths.runtimeStatusFile, child);
    child.kill("SIGTERM");
    const result = await waitForProcessExit(child, 10_000);
    if (result.code !== 0) {
      throw new Error(`Launcher exited with ${result.code ?? result.signal}: ${output}`);
    }
    return { output };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForProcessExit(child, 2_000).catch(() => undefined);
    }
  }
}

async function waitForConnectedStatus(filePath: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Launcher exited before publishing connected tunnel status.");
    }
    if (existsSync(filePath)) {
      try {
        const status = readStatus(filePath);
        if (status.phase === "running" && status.tunnel?.connected === true) return;
      } catch {
        // Atomic status replacement may be between observations.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the managed tunnel status.");
}

function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("Timed out waiting for launcher exit."));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}

function readStatus(filePath: string): Record<string, any> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
}

function initializationCount(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  return readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).length;
}
