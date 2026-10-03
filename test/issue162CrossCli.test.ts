import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexChildEnvironment } from "../scripts/runtime-env.mjs";
import { inspectClientRequestContract } from "../src/cliProtocol.js";
import { loadConfig } from "../src/config.js";
import { CodexRuntimeManager } from "../src/codexRuntime.js";
import { createExecutionRuntime } from "../src/executionRuntime.js";
import { MacOSBridgeSupervisor } from "../src/macosHelperServer.js";
import { createModelCatalog } from "../src/server.js";
import type { CodexUpstream } from "../src/upstream.js";
import protocolContract from "./fixtures/app-server-request-contract.json";
import { syntheticIdToken } from "./fixtures/syntheticAuth.js";

const roots: string[] = [];
const environmentNames = ["HOME", "PATH", "CODEX_MCP_BRIDGE_RUNTIME_HOME", "CODEX_MCP_BRIDGE_CODEX",
  "CODEX_GPT_BRIDGE_CODEX", "CODEX_HOME", "HTTPS_PROXY", "SSL_CERT_FILE"] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of environmentNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeCli(file: string, id: string, log: string, authMode: "chatgpt" | "apiKey" = "chatgpt"): void {
  const schema = new URL("./fixtures/app-server-schema-fixture.mjs", import.meta.url).href;
  const worker = new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url).href;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const kind = args.includes("--version") ? "version" : args.includes("generate-json-schema") ? "probe" :
  args[0] === "login" ? "login" : args[0] === "debug" ? "models" :
  args[0] === "app-server" && args.includes("-c") ? "task-worker" : "account";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({cli:${JSON.stringify(id)},kind,
  runtimeHome: process.env.CODEX_MCP_BRIDGE_RUNTIME_HOME?.split("/").at(-1) || null,
  codexHome: process.env.CODEX_HOME || null,
  proxy: Boolean(process.env.HTTPS_PROXY), certificate: Boolean(process.env.SSL_CERT_FILE),
  apiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)}) + "\\n");
if (kind === "version") { console.log("codex-cli 0.153.3"); process.exit(0); }
if (kind === "probe") await import(${JSON.stringify(schema)});
if (kind === "login") process.exit(0);
if (kind === "models") { console.log(JSON.stringify({models:[{slug:"gpt-fixture",display_name:"Fixture",default_reasoning_level:"low",supported_reasoning_levels:[{effort:"low"}],visibility:"list"}]})); process.exit(0); }
if (kind === "task-worker") {
  if (${JSON.stringify(authMode)} === "apiKey") process.argv.push("--api-account");
  await import(${JSON.stringify(worker)});
}
else createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "account/rateLimits/read") appendFileSync(${JSON.stringify(log)},
    JSON.stringify({cli:${JSON.stringify(id)},kind:"usage",codexHome:process.env.CODEX_HOME || null}) + "\\n");
  const result = request.method === "initialize" ? {userAgent:"fixture",platformFamily:"unix",platformOs:"test"} :
    request.method === "account/read" ? {account:${authMode === "apiKey" ? '{type:"apiKey"}' : '{type:"chatgpt",email:"fixture@example.invalid",planType:"pro"}'},requiresOpenaiAuth:true} :
    request.method === "model/list" ? {data:[{id:"gpt-fixture"}],nextCursor:null} :
    request.method === "account/rateLimits/read" ? {rateLimits:null} : {};
  process.stdout.write(JSON.stringify({id:request.id,result}) + "\\n");
});
`, { mode: 0o700 });
}

function observations(log: string): Array<{ cli: string; kind: string; runtimeHome: string | null;
  codexHome: string | null; proxy: boolean; certificate: boolean; apiKey: boolean }> {
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

describe("issue 162 selected CLI across product entry points", () => {
  it("reports a removed saved CLI without running the different CLI on PATH", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "issue162-missing-"));
    roots.push(root);
    const log = path.join(root, "invocations.jsonl");
    const bin = path.join(root, "bin");
    const selectedCli = path.join(root, "selected", "codex");
    const otherCli = path.join(root, "other", "codex");
    const runtimeHome = path.join(root, "runtime");
    const privateDirectory = path.join(root, "private");
    const envFile = path.join(privateDirectory, ".env");
    fakeCli(selectedCli, "saved", log);
    fakeCli(otherCli, "path", log);
    mkdirSync(bin, { recursive: true });
    mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    symlinkSync(otherCli, path.join(bin, "codex"));
    writeFileSync(envFile, `CODEX_MCP_BRIDGE_RUNTIME_HOME=${runtimeHome}\n`, { mode: 0o600 });
    const manager = new CodexRuntimeManager({ root: runtimeHome, environment: { PATH: "" }, appPaths: [selectedCli],
      probe: async () => "0.153.3", protocolProbe: async () => inspectClientRequestContract(protocolContract) });
    await manager.select((await manager.discover()).find(candidate => candidate.command === selectedCli)!.id);
    rmSync(selectedCli);
    process.env.HOME = root;
    process.env.PATH = `${bin}${path.delimiter}${originalEnvironment.PATH || "/usr/bin:/bin"}`;
    for (const name of ["CODEX_MCP_BRIDGE_RUNTIME_HOME", "CODEX_MCP_BRIDGE_CODEX", "CODEX_GPT_BRIDGE_CODEX"]) delete process.env[name];
    const supervisor = new MacOSBridgeSupervisor({ bridgeRoot: root, envFile,
      bridgeSocketPath: path.join(privateDirectory, "run", "bridge.sock"),
      runtimeLockDirectory: path.join(root, "locks", "launcher.lock"), autoRestart: false,
      registeredProjectRoots: () => [] });
    const environment = { HOME: root, PATH: process.env.PATH, ...codexChildEnvironment(envFile, process.env) };
    const execution = createExecutionRuntime(loadConfig({ ...environment, CODEX_MCP_BRIDGE_NO_AUTH: "1" }), {}, environment);
    try {
      await expect(supervisor.authStatus()).rejects.toThrow("CODEX_SELECTION_UNAVAILABLE");
      await expect(execution.prepareExecution({ backendKind: "app-server", contextMode: "fresh" }))
        .rejects.toThrow("CODEX_SELECTION_UNAVAILABLE");
      const userCalls = observations(log).filter(item => ["login", "account", "models", "task-worker"].includes(item.kind));
      expect(userCalls).toEqual([]);
    } finally {
      await execution.close();
      await supervisor.close();
    }
  }, 30_000);

  it.each(["app", "terminal", "bridge"] as const)("keeps the selected auth source for %s account, model fallback, and work while blocking shared login", async choice => {
    const root = mkdtempSync(path.join(tmpdir(), `issue162-${choice}-`));
    roots.push(root);
    const log = path.join(root, "invocations.jsonl");
    const bin = path.join(root, "bin");
    const runtimeHome = path.join(root, `${choice}-runtime`);
    const codexHome = path.join(root, "codex-home");
    const configDirectory = path.join(root, "private");
    const envFile = path.join(configDirectory, ".env");
    const appCli = path.join(root, "Codex.app", "Contents", "Resources", "codex");
    const terminalCli = path.join(root, "terminal", "codex");
    fakeCli(appCli, "app", log);
    fakeCli(terminalCli, "terminal", log);
    mkdirSync(bin, { recursive: true });
    symlinkSync(terminalCli, path.join(bin, "codex"));
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(codexHome, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "synthetic-issue-162-account", id_token: syntheticIdToken("fixture-user", "synthetic-issue-162-account") } }), { mode: 0o600 });
    writeFileSync(envFile, [
      `CODEX_MCP_BRIDGE_RUNTIME_HOME=${runtimeHome}`,
      `CODEX_HOME=${codexHome}`,
      "HTTPS_PROXY=http://proxy.fixture.invalid",
      `SSL_CERT_FILE=${path.join(root, "fixture-ca.pem")}`,
      ""
    ].join("\n"), { mode: 0o600 });
    process.env.HOME = root;
    process.env.PATH = `${bin}${path.delimiter}${originalEnvironment.PATH || "/usr/bin:/bin"}`;
    for (const name of ["CODEX_MCP_BRIDGE_RUNTIME_HOME", "CODEX_MCP_BRIDGE_CODEX", "CODEX_GPT_BRIDGE_CODEX",
      "CODEX_HOME", "HTTPS_PROXY", "SSL_CERT_FILE"]) delete process.env[name];

    const selected = new CodexRuntimeManager({
      root: runtimeHome,
      environment: { HOME: root, PATH: process.env.PATH },
      appPaths: [appCli],
      probe: async () => "0.153.3",
      protocolProbe: async () => inspectClientRequestContract(protocolContract),
      installer: async ({ directory }) => {
        const command = path.join(directory, "codex");
        fakeCli(command, "bridge", log);
        return command;
      },
      validateInstall: async () => {}
    });
    await selected.install("install", "0.153.3");
    const candidates = await selected.discover();
    expect(new Set(candidates.map(item => item.source))).toEqual(new Set(["app", "terminal", "bridge"]));
    if (choice !== "bridge") {
      const command = choice === "app" ? appCli : terminalCli;
      const candidate = candidates.find(item => item.physicalPath === realpathSync(command));
      expect(candidate).toBeDefined();
      await selected.select(candidate!.id);
    }

    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot: root,
      envFile,
      bridgeSocketPath: path.join(configDirectory, "run", "bridge.sock"),
      runtimeLockDirectory: path.join(root, "locks", "launcher.lock"),
      autoRestart: false,
      registeredProjectRoots: () => []
    });
    const environment = { HOME: root, PATH: process.env.PATH, ...codexChildEnvironment(envFile, process.env) };
    const config = loadConfig({ ...environment, CODEX_MCP_BRIDGE_NO_AUTH: "1" });
    config.upstreamPoolSize = 1;
    const execution = createExecutionRuntime(config, {}, environment);
    try {
      expect((await supervisor.codexRuntime({ action: "status", includeAccount: true })).selection?.source).toBe(choice);
      await expect(supervisor.startLogin()).rejects.toThrow("CODEX_SHARED_LOGIN_DISABLED");
      await expect(supervisor.codexRuntime({ action: "login" })).rejects.toThrow("CODEX_SHARED_LOGIN_DISABLED");
      const catalog = createModelCatalog(config, {
        listModels: async () => { throw new Error("fixture App Server catalog unavailable"); }
      } as unknown as CodexUpstream);
      expect((await catalog.getCatalog()).source).toBe("codex-cli");
      await execution.startThread({ backendKind: "app-server", cwd: root, sandbox: "read-only",
        approvalPolicy: "never", ephemeral: false, prompt: "fixture",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "low" } });
      const userCalls = observations(log).filter(item => ["login", "account", "models", "task-worker"].includes(item.kind));
      expect(new Set(userCalls.map(item => item.kind))).toEqual(new Set(["account", "models", "task-worker"]));
      expect(userCalls.every(item => item.cli === choice && item.runtimeHome === `${choice}-runtime` &&
        item.codexHome === codexHome && item.proxy && item.certificate && !item.apiKey)).toBe(true);

      // Once the explicit override is removed, the previously used home is a
      // selectable credential source for any of the three installed CLIs.
      writeFileSync(envFile, [
        `CODEX_MCP_BRIDGE_RUNTIME_HOME=${runtimeHome}`,
        "HTTPS_PROXY=http://proxy.fixture.invalid",
        `SSL_CERT_FILE=${path.join(root, "fixture-ca.pem")}`,
        ""
      ].join("\n"), { mode: 0o600 });
      const selectable = (await supervisor.codexRuntime({ action: "status", includeAccount: false })).authSelection!;
      const homeId = selectable.knownHomes.find(item => item.home === codexHome)?.id;
      expect(homeId).toBeDefined();
      const callsBefore = observations(log).length;
      const staged = await supervisor.codexRuntime({ action: "auth-apply", authKind: "external",
        authHomeId: homeId, authRevision: selectable.revision });
      expect(staged.authSelection?.pending).toEqual({ kind: "external", homeId });
      const probeCalls = observations(log).slice(callsBefore);
      expect(probeCalls.some(item => ["account", "task-worker"].includes(item.kind) && item.cli === choice &&
        item.codexHome === codexHome && !item.apiKey)).toBe(true);
      expect(probeCalls.some(item => item.kind === "login")).toBe(false);
    } finally {
      await execution.close();
      await supervisor.close();
    }
  }, 30_000);

  it.each([
    ["app", "bridge-chatgpt"], ["terminal", "bridge-chatgpt"], ["bridge", "bridge-chatgpt"],
    ["app", "bridge-api"], ["terminal", "bridge-api"], ["bridge", "bridge-api"]
  ] as const)("uses the %s CLI with a saved %s profile without switching auth sources", async (choice, kind) => {
    const root = mkdtempSync(path.join(tmpdir(), `issue210-${choice}-`));
    roots.push(root);
    const log = path.join(root, "invocations.jsonl");
    const bin = path.join(root, "bin");
    const runtimeHome = path.join(root, "runtime");
    const profileId = "11111111-1111-4111-8111-111111111111";
    const codexHome = path.join(runtimeHome, "auth-profiles", profileId);
    const configDirectory = path.join(root, "private");
    const envFile = path.join(configDirectory, ".env");
    const appCli = path.join(root, "Codex.app", "Contents", "Resources", "codex");
    const terminalCli = path.join(root, "terminal", "codex");
    const authMode = kind === "bridge-api" ? "apiKey" : "chatgpt";
    fakeCli(appCli, "app", log, authMode);
    fakeCli(terminalCli, "terminal", log, authMode);
    mkdirSync(bin, { recursive: true });
    symlinkSync(terminalCli, path.join(bin, "codex"));
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(kind === "bridge-api"
      ? { auth_mode: "apiKey", OPENAI_API_KEY: "sk-synthetic-owned-profile" }
      : { auth_mode: "chatgpt", tokens: {
        account_id: "owned-workspace", id_token: syntheticIdToken("owned-user", "owned-workspace")
      } }), { mode: 0o600 });
    writeFileSync(envFile, `CODEX_MCP_BRIDGE_RUNTIME_HOME=${runtimeHome}\n`, { mode: 0o600 });
    process.env.HOME = root;
    process.env.PATH = `${bin}${path.delimiter}${originalEnvironment.PATH || "/usr/bin:/bin"}`;
    for (const name of ["CODEX_MCP_BRIDGE_RUNTIME_HOME", "CODEX_MCP_BRIDGE_CODEX", "CODEX_GPT_BRIDGE_CODEX", "CODEX_HOME"]) delete process.env[name];

    const selected = new CodexRuntimeManager({
      root: runtimeHome, environment: { HOME: root, PATH: process.env.PATH }, appPaths: [appCli],
      probe: async () => "0.153.3",
      protocolProbe: async () => inspectClientRequestContract(protocolContract),
      installer: async ({ directory }) => {
        const command = path.join(directory, "codex");
        fakeCli(command, "bridge", log, authMode);
        return command;
      },
      validateInstall: async () => {}
    });
    await selected.install("install", "0.153.3");
    writeFileSync(path.join(runtimeHome, "auth-selection.json"), JSON.stringify({
      schemaVersion: 1, revision: 1, generation: 1,
      applied: { kind, profileId }, pending: null, candidate: null
    }), { mode: 0o600 });
    const candidates = await selected.discover();
    expect(new Set(candidates.map(item => item.source))).toEqual(new Set(["app", "terminal", "bridge"]));
    if (choice !== "bridge") {
      const command = choice === "app" ? appCli : terminalCli;
      await selected.select(candidates.find(item => item.physicalPath === realpathSync(command))!.id);
    }

    const supervisor = new MacOSBridgeSupervisor({ bridgeRoot: root, envFile,
      bridgeSocketPath: path.join(configDirectory, "run", "bridge.sock"),
      runtimeLockDirectory: path.join(root, "locks", "launcher.lock"), autoRestart: false,
      registeredProjectRoots: () => [] });
    const environment = { HOME: root, PATH: process.env.PATH, ...codexChildEnvironment(envFile, process.env) };
    expect(environment).toMatchObject({ CODEX_HOME: codexHome,
      CODEX_MCP_BRIDGE_AUTH_SOURCE: kind, CODEX_MCP_BRIDGE_AUTH_GENERATION: "1" });
    const config = loadConfig({ ...environment, CODEX_MCP_BRIDGE_NO_AUTH: "1" });
    config.upstreamPoolSize = 1;
    const execution = createExecutionRuntime(config, {}, environment);
    try {
      const status = await supervisor.codexRuntime({ action: "status", includeAccount: true });
      expect(status.selection?.source).toBe(choice);
      expect(status.authSelection?.effective).toEqual({ kind, profileId });
      expect(status.account?.authMode).toBe(kind === "bridge-api" ? "api-key" : "chatgpt");
      expect(status.account?.billing?.kind).toBe(kind === "bridge-api" ? "api" : "chatgpt-plan");
      const usageCalls = observations(log).filter(item => item.kind === "usage");
      if (kind === "bridge-chatgpt") {
        expect(usageCalls.some(item => item.cli === choice && item.codexHome === codexHome)).toBe(true);
      } else {
        // API billing is distinct from ChatGPT plan limits; do not infer costs
        // by reading the selected CLI's plan-usage endpoint.
        expect(usageCalls).toEqual([]);
      }
      const catalog = createModelCatalog(config, {
        listModels: async () => { throw new Error("fixture App Server catalog unavailable"); }
      } as unknown as CodexUpstream);
      expect((await catalog.getCatalog()).source).toBe("codex-cli");
      await execution.startThread({ backendKind: "app-server", cwd: root, sandbox: "read-only",
        approvalPolicy: "never", ephemeral: false, prompt: "fixture",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "low" } });
      const userCalls = observations(log).filter(item => ["login", "account", "models", "task-worker"].includes(item.kind));
      expect(new Set(userCalls.map(item => item.kind))).toEqual(new Set(["account", "models", "task-worker"]));
      expect(userCalls.every(item => item.cli === choice && item.codexHome === codexHome && !item.apiKey)).toBe(true);
    } finally {
      await execution.close();
      await supervisor.close();
    }
  }, 30_000);
});
