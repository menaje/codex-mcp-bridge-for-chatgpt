import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { codexChildEnvironment, codexChildEnvironmentFingerprint } from "../scripts/runtime-env.mjs";
import { CodexRuntimeManager } from "../src/codexRuntime.js";
import { inspectClientRequestContract } from "../src/cliProtocol.js";
import protocolContract from "./fixtures/app-server-request-contract.json";

function fixtureCli(file: string, id: string, log: string): void {
  const schema = new URL("./fixtures/app-server-schema-fixture.mjs", import.meta.url).href;
  const worker = new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url).href;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const kind = args.includes("--version") ? "version" : args.includes("generate-json-schema") ? "probe" :
  args[0] === "debug" ? "models" : args[0] === "app-server" && args.includes("-c") ? "worker" : "account";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({cli:${JSON.stringify(id)},kind,
  runtimeHome:process.env.CODEX_MCP_BRIDGE_RUNTIME_HOME?.split("/").at(-1) || null,
  proxy:Boolean(process.env.HTTPS_PROXY),certificate:Boolean(process.env.SSL_CERT_FILE),
  apiKey:Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
  tunnel:Boolean(process.env.CONTROL_PLANE_API_KEY || process.env.CONTROL_PLANE_TUNNEL_ID ||
    process.env.CLOUDFLARED_TUNNEL_TOKEN || process.env.TUNNEL_CLIENT_CONFIG || process.env.CODEX_MCP_BRIDGE_TOKEN)}) + "\\n");
if (kind === "version") { console.log("codex-cli 0.153.3"); process.exit(0); }
if (kind === "probe") await import(${JSON.stringify(schema)});
if (kind === "worker") await import(${JSON.stringify(worker)});
if (kind === "models") { console.log(JSON.stringify({models:[{slug:"gpt-fixture",display_name:"Fixture",default_reasoning_level:"low",supported_reasoning_levels:[{effort:"low"}],visibility:"list"}]})); process.exit(0); }
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

it("runs the built launcher and MCP model path against the private-file runtime home", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "issue162-launcher-"));
  const privateDirectory = path.join(root, "private");
  const envFile = path.join(privateDirectory, ".env");
  const runtimeHome = path.join(root, "configured-runtime");
  const defaultHome = path.join(root, ".codex-mcp-bridge", "runtimes");
  const statusFile = path.join(privateDirectory, "launcher-status.json");
  const log = path.join(root, "invocations.jsonl");
  const selectedCli = path.join(root, "selected", "codex");
  const otherCli = path.join(root, "other", "codex");
  fixtureCli(selectedCli, "selected", log);
  fixtureCli(otherCli, "default", log);
  const seed = async (runtime: string, command: string) => {
    await new CodexRuntimeManager({ root: runtime, environment: { PATH: "" }, appPaths: [command],
      probe: async () => "0.153.3", protocolProbe: async () => inspectClientRequestContract(protocolContract) }).snapshot();
  };
  await seed(runtimeHome, selectedCli);
  await seed(defaultHome, otherCli);
  mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(envFile, [
    `CODEX_MCP_BRIDGE_RUNTIME_HOME=${runtimeHome}`,
    `CODEX_HOME=${path.join(root, "codex-home")}`,
    "HTTPS_PROXY=http://proxy.fixture.invalid",
    `SSL_CERT_FILE=${path.join(root, "fixture-ca.pem")}`,
    "CONTROL_PLANE_API_KEY=sk-fixture-1234567890123456",
    "CONTROL_PLANE_TUNNEL_ID=tunnel_ffffffffffffffffffffffffffffffff",
    "CLOUDFLARED_TUNNEL_TOKEN=fixture-tunnel-only",
    "CODEX_MCP_BRIDGE_TOKEN=fixture-bridge-only",
    `CODEX_MCP_BRIDGE_STATE_DATABASE_FILE=${path.join(root, "state.sqlite")}`,
    `CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE=${path.join(root, "models.json")}`,
    `CODEX_MCP_BRIDGE_SKILLS_DIRECTORY=${path.join(root, "skills")}`,
    ""
  ].join("\n"), { mode: 0o600 });
  const portServer = createServer();
  await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const environment = {
    HOME: root, PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: process.env.TMPDIR,
    CODEX_MCP_BRIDGE_MANAGED_BY_APP: "1"
  };
  const child = spawn(process.execPath, [path.resolve("scripts/start-codex-mcp-bridge.mjs"),
    "--mode", "local", "--port", String(port), "--env-file", envFile,
    "--runtime-status-file", statusFile, "--runtime-lock-directory", path.join(root, "launcher.lock"),
    "--require-built"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk).slice(0, 4_000); });
  child.stderr.on("data", chunk => { output += String(chunk).slice(0, 4_000); });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const client = new Client({ name: "issue162-launcher", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    for (let index = 0; index < 200 && !output.includes("listening on http://"); index++) {
      if (child.exitCode !== null) throw new Error(output);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(output).toContain("listening on http://");
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const result = await client.callTool({ name: "codex_models", arguments: { refresh: true } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const settings = await client.callTool({ name: "codex_ui_read", arguments: { view: "settings", refreshModels: true } });
    expect(settings.isError, JSON.stringify(settings.content)).not.toBe(true);
    expect(settings.structuredContent).toMatchObject({ catalog: { source: "codex-cli", models: [{ id: "gpt-fixture" }] } });
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) as Array<{
      cli: string; kind: string; runtimeHome: string; proxy: boolean; certificate: boolean; apiKey: boolean; tunnel: boolean }>;
    const userCalls = calls.filter(item => item.kind === "worker" || item.kind === "account" || item.kind === "models");
    expect(userCalls.length).toBeGreaterThan(0);
    // The isolated execution child intentionally strips Bridge-only paths.
    expect(userCalls.every(item => item.cli === "selected" &&
      (item.kind === "worker" ? item.runtimeHome === null : item.runtimeHome === "configured-runtime") &&
      item.proxy && item.certificate && !item.apiKey && !item.tunnel), JSON.stringify(userCalls)).toBe(true);
    const status = JSON.parse(readFileSync(statusFile, "utf8"));
    const appliedEnvironment = { ...environment, ...codexChildEnvironment(envFile, environment) };
    expect(status.codexEnvironmentFingerprint).toBe(codexChildEnvironmentFingerprint(appliedEnvironment));
  } finally {
    await client.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000);
    await exited;
    clearTimeout(force);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
