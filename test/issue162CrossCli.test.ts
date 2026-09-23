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

function fakeCli(file: string, id: string, log: string): void {
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
  proxy: Boolean(process.env.HTTPS_PROXY), certificate: Boolean(process.env.SSL_CERT_FILE),
  apiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)}) + "\\n");
if (kind === "version") { console.log("codex-cli 0.153.3"); process.exit(0); }
if (kind === "probe") await import(${JSON.stringify(schema)});
if (kind === "login") process.exit(0);
if (kind === "models") { console.log(JSON.stringify({models:[{slug:"gpt-fixture",display_name:"Fixture",default_reasoning_level:"low",supported_reasoning_levels:[{effort:"low"}],visibility:"list"}]})); process.exit(0); }
if (kind === "task-worker") await import(${JSON.stringify(worker)});
else createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize" ? {userAgent:"fixture",platformFamily:"unix",platformOs:"test"} :
    request.method === "account/read" ? {account:{type:"chatgpt",email:"fixture@example.invalid",planType:"pro"},requiresOpenaiAuth:true} :
    request.method === "account/rateLimits/read" ? {rateLimits:null} : {};
  process.stdout.write(JSON.stringify({id:request.id,result}) + "\\n");
});
`, { mode: 0o700 });
}

function observations(log: string): Array<{ cli: string; kind: string; runtimeHome: string | null;
  proxy: boolean; certificate: boolean; apiKey: boolean }> {
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
    await new CodexRuntimeManager({ root: runtimeHome, environment: { PATH: "" }, appPaths: [selectedCli],
      probe: async () => "0.153.3", protocolProbe: async () => inspectClientRequestContract(protocolContract) }).snapshot();
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

  it.each(["app", "terminal", "bridge"] as const)("uses the %s choice for login, account, model fallback and work", async choice => {
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
    if (choice === "bridge") await selected.install("install", "0.153.3");
    else {
      const command = choice === "app" ? appCli : terminalCli;
      const candidates = await selected.discover();
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
      await supervisor.startLogin();
      await vi.waitFor(() => expect(observations(log).some(item => item.kind === "login" && item.cli === choice)).toBe(true));
      const catalog = createModelCatalog(config, {
        listModels: async () => { throw new Error("fixture App Server catalog unavailable"); }
      } as unknown as CodexUpstream);
      expect((await catalog.getCatalog()).source).toBe("codex-cli");
      await execution.startThread({ backendKind: "app-server", cwd: root, sandbox: "read-only",
        approvalPolicy: "never", ephemeral: false, prompt: "fixture",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "low" } });
      const userCalls = observations(log).filter(item => ["login", "account", "models", "task-worker"].includes(item.kind));
      expect(new Set(userCalls.map(item => item.kind))).toEqual(new Set(["login", "account", "models", "task-worker"]));
      expect(userCalls.every(item => item.cli === choice && item.runtimeHome === `${choice}-runtime` &&
        item.proxy && item.certificate && !item.apiKey)).toBe(true);
    } finally {
      await execution.close();
      await supervisor.close();
    }
  }, 30_000);
});
