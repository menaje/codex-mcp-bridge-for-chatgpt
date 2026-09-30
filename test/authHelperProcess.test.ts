import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

type Selection = {
  revision: number; applied: { kind: string }; pending: unknown;
  candidate: { id: string; status: string } | null;
  profiles: { id: string; status: string }[];
};
type RuntimeReply = { authSelection: Selection };

async function rpc<T>(socketPath: string, method: string, params: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(45_000, () => { socket.destroy(); reject(new Error("Synthetic Helper RPC timed out")); });
    socket.once("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.end();
      const reply = JSON.parse(buffer.slice(0, end));
      if (reply.error) reject(new Error(reply.error.message));
      else resolve(reply.result as T);
    });
    socket.once("error", reject);
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "auth-helper-"));
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const run = path.join(config, "run");
  const authRoot = path.join(root, "auth-runtime");
  const envFile = path.join(config, ".env");
  const release = path.join(root, "release-old-login");
  const command = path.join(root, "fake-codex.mjs");
  await mkdir(path.join(home, ".codex"), { recursive: true, mode: 0o700 });
  await mkdir(run, { recursive: true, mode: 0o700 });
  const sharedFile = path.join(home, ".codex", "auth.json");
  const sharedAuth = JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "shared-test-user" } });
  await writeFile(sharedFile, sharedAuth, { mode: 0o600 });
  const upstream = new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url).href;
  await writeFile(command, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
if (process.argv[2] === "login") {
  const home = process.env.CODEX_HOME;
  process.on("SIGTERM", () => {});
  writeFileSync(path.join(home, "login-observation.json"), JSON.stringify({
    pid: process.pid, parentPid: process.ppid, home, args: process.argv.slice(2)
  }));
  const writeAuth = key => {
    writeFileSync(path.join(home, "auth.json"), JSON.stringify(key
      ? { auth_mode: "apikey", OPENAI_API_KEY: key }
      : { auth_mode: "chatgpt", tokens: { account_id: "late-old-test-user" } }));
    process.exit(0);
  };
  const waitForRelease = key => setInterval(() => {
    if (existsSync(${JSON.stringify(release)})) writeAuth(key);
  }, 10);
  if (process.argv.includes("--with-api-key")) {
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const key = input.trim();
      if (key === "sk-timeout-old-helper-synthetic") waitForRelease(key);
      else writeAuth(key);
    });
  } else waitForRelease(null);
} else await import(${JSON.stringify(upstream)});
`, { mode: 0o700 });
  await writeFile(envFile, [
    "CONTROL_PLANE_API_KEY=sk-helper-process-synthetic-12345678",
    "CONTROL_PLANE_TUNNEL_ID=tunnel_ffffffffffffffffffffffffffffffff",
    `CODEX_MCP_BRIDGE_CODEX=${command}`,
    `CODEX_MCP_BRIDGE_RUNTIME_HOME=${authRoot}`,
    `CODEX_MCP_BRIDGE_STATE_DATABASE_FILE=${path.join(root, "state.sqlite")}`,
    `CODEX_MCP_BRIDGE_PROJECTS_REGISTRY_FILE=${path.join(root, "projects.json")}`,
    ""
  ].join("\n"), { mode: 0o600 });
  const children: { child: ChildProcess; output: () => string }[] = [];
  const loginPids = new Set<number>();
  const startHelper = async (name: string) => {
    const socket = path.join(run, `${name}.sock`);
    let output = "";
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/macosHelper.ts", import.meta.url)),
      "--env-file", envFile, "--socket", socket, "--bridge-socket", path.join(run, "bridge.sock"),
      "--runtime-lock-directory", path.join(run, "launcher.lock"), "--no-auto-start"], {
      env: { HOME: home, PATH: process.env.PATH, LANG: "C", LC_ALL: "C",
        CODEX_MCP_BRIDGE_RUNTIME_HOME: authRoot,
        CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite") },
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout!.on("data", chunk => { output += chunk.toString(); });
    child.stderr!.on("data", chunk => { output += chunk.toString(); });
    children.push({ child, output: () => output });
    await vi.waitFor(async () => {
      expect(child.exitCode).toBeNull();
      expect((await rpc<{ protocol: { name: string } }>(socket, "helper.hello")).protocol.name)
        .toBe("codex-mcp-bridge-macos-helper");
    }, { timeout: 10_000 });
    const action = (params: object) => rpc<RuntimeReply>(socket, "codex.runtime", params);
    return { child, socket, action, snapshot: async () => (await action({ action: "status", includeAccount: false })).authSelection };
  };
  const observeLogin = async (id: string) => {
    let observed!: { pid: number; parentPid: number; home: string; args: string[] };
    await vi.waitFor(async () => {
      observed = JSON.parse(await readFile(path.join(authRoot, "auth-profiles", id, "login-observation.json"), "utf8"));
      expect(observed.pid).toBeGreaterThan(0);
    }, { timeout: 5_000 });
    loginPids.add(observed.pid);
    return observed;
  };
  const stopHelper = async (child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 5_000 });
  };
  const cleanup = async () => {
    await writeFile(release, "finish");
    for (const pid of loginPids) {
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
    }
    for (const { child } of children) await stopHelper(child);
    await rm(root, { recursive: true, force: true });
  };
  return { root, home, authRoot, release, sharedFile, sharedAuth, children, startHelper, stopHelper, observeLogin, cleanup };
}

it("preserves a replacement Helper's API candidate when an older Helper receives a late browser-login exit", async () => {
  const f = await fixture();
  try {
    const old = await f.startHelper("old");
    const first = (await old.action({ action: "auth-prepare", authKind: "bridge-chatgpt", authRevision: 0 })).authSelection.candidate!;
    await old.action({ action: "auth-login", authCandidateId: first.id });
    const writer = await f.observeLogin(first.id);
    expect(writer.parentPid).toBe(old.child.pid);
    const replacement = await f.startHelper("replacement");
    expect(replacement.child.pid).not.toBe(old.child.pid);
    const unresolved = await replacement.snapshot();
    expect(unresolved.candidate).toMatchObject({ id: first.id, status: "login-unconfirmed" });
    await expect(replacement.action({ action: "auth-verify", authCandidateId: first.id }))
      .rejects.toThrow("CODEX_AUTH_LOGIN_UNCONFIRMED");
    await replacement.action({ action: "auth-cancel", authCandidateId: first.id, authRevision: unresolved.revision });
    const next = (await replacement.action({ action: "auth-prepare", authKind: "bridge-api",
      authRevision: (await replacement.snapshot()).revision })).authSelection.candidate!;
    await replacement.action({ action: "auth-api-key", authCandidateId: next.id, authApiKey: "sk-replacement-helper-synthetic" });
    const nextFile = path.join(f.authRoot, "auth-profiles", next.id, "auth.json");
    const nextAuth = await readFile(nextFile, "utf8");
    const stateFile = path.join(f.authRoot, "auth-selection.json");
    const stateBefore = await readFile(stateFile, "utf8");
    const modifiedBefore = (await stat(stateFile)).mtimeMs;
    expect(() => process.kill(writer.pid, 0)).not.toThrow();
    await writeFile(f.release, "finish");
    await vi.waitFor(async () => expect((await stat(stateFile)).mtimeMs).toBeGreaterThan(modifiedBefore), { timeout: 5_000 });
    expect(await readFile(stateFile, "utf8")).toBe(stateBefore);
    expect(await replacement.snapshot()).toMatchObject({ applied: { kind: "shared" }, pending: null,
      candidate: { id: next.id, status: "login-completed" },
      profiles: [{ id: first.id, status: "login-unconfirmed" }, { id: next.id, status: "available" }] });
    expect(await readFile(nextFile, "utf8")).toBe(nextAuth);
    expect(await readFile(f.sharedFile, "utf8")).toBe(f.sharedAuth);
    for (const child of f.children) expect(child.output()).not.toContain("sk-replacement-helper-synthetic");
  } finally { await f.cleanup(); }
}, 25_000);

it("keeps a real API timeout quarantined across Helper process loss and replacement", async () => {
  const f = await fixture();
  try {
    const old = await f.startHelper("helper");
    const first = (await old.action({ action: "auth-prepare", authKind: "bridge-api", authRevision: 0 })).authSelection.candidate!;
    const startedAt = Date.now();
    const outcome = old.action({ action: "auth-api-key", authCandidateId: first.id,
      authApiKey: "sk-timeout-old-helper-synthetic" }).then(() => null, error => error as Error);
    const writer = await f.observeLogin(first.id);
    expect(writer.parentPid).toBe(old.child.pid);
    expect((await outcome)?.message).toContain("CODEX_AUTH_LOGIN_UNCONFIRMED");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(29_000);
    expect(() => process.kill(writer.pid, 0)).not.toThrow();
    expect((await old.snapshot()).candidate?.status).toBe("login-unconfirmed");
    await f.stopHelper(old.child, "SIGKILL");
    const replacement = await f.startHelper("helper");
    expect(replacement.child.pid).not.toBe(old.child.pid);
    const unresolved = await replacement.snapshot();
    expect(unresolved.candidate?.status).toBe("login-unconfirmed");
    await expect(replacement.action({ action: "auth-verify", authCandidateId: first.id }))
      .rejects.toThrow("CODEX_AUTH_LOGIN_UNCONFIRMED");
    await expect(replacement.action({ action: "auth-api-key", authCandidateId: first.id, authApiKey: "sk-forbidden-retry-synthetic" }))
      .rejects.toThrow("CODEX_AUTH_LOGIN_ALREADY_ATTEMPTED");
    await replacement.action({ action: "auth-cancel", authCandidateId: first.id, authRevision: unresolved.revision });
    const next = (await replacement.action({ action: "auth-prepare", authKind: "bridge-api",
      authRevision: (await replacement.snapshot()).revision })).authSelection.candidate!;
    await replacement.action({ action: "auth-api-key", authCandidateId: next.id, authApiKey: "sk-replacement-after-timeout-synthetic" });
    const nextFile = path.join(f.authRoot, "auth-profiles", next.id, "auth.json");
    const nextAuth = await readFile(nextFile, "utf8");
    const stateFile = path.join(f.authRoot, "auth-selection.json");
    const stateBefore = await readFile(stateFile, "utf8");
    await writeFile(f.release, "finish");
    await vi.waitFor(() => expect(() => process.kill(writer.pid, 0)).toThrow(), { timeout: 5_000 });
    expect(await readFile(stateFile, "utf8")).toBe(stateBefore);
    expect(await readFile(nextFile, "utf8")).toBe(nextAuth);
    expect(await readFile(f.sharedFile, "utf8")).toBe(f.sharedAuth);
    expect(await replacement.snapshot()).toMatchObject({ applied: { kind: "shared" }, pending: null,
      candidate: { id: next.id, status: "login-completed" },
      profiles: [{ id: first.id, status: "login-unconfirmed" }, { id: next.id, status: "available" }] });
    for (const child of f.children) {
      expect(child.output()).not.toContain("sk-timeout-old-helper-synthetic");
      expect(child.output()).not.toContain("sk-replacement-after-timeout-synthetic");
    }
  } finally { await f.cleanup(); }
}, 60_000);
