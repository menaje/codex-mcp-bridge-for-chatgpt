import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeManager } from "../src/codexRuntime.js";
import { loadConfig } from "../src/config.js";
import { MacOSBridgeSupervisor } from "../src/macosHelperServer.js";
import { createModelCatalog } from "../src/server.js";
import type { CodexUpstream } from "../src/upstream.js";
import { updateRuntimeEnvFile } from "../scripts/runtime-env.mjs";
import { inspectClientRequestContract } from "../src/cliProtocol.js";
import protocolContract from "./fixtures/app-server-request-contract.json";
import { writeFakeLauncher } from "./fixtures/macosHelperLauncher.js";

const roots: string[] = [];
const originalHome = process.env.HOME;
const originalRuntimeHome = process.env.CODEX_MCP_BRIDGE_RUNTIME_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRuntimeHome === undefined) delete process.env.CODEX_MCP_BRIDGE_RUNTIME_HOME;
  else process.env.CODEX_MCP_BRIDGE_RUNTIME_HOME = originalRuntimeHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function savedChoice(root: string, command: string): Promise<void> {
  await new CodexRuntimeManager({
    root,
    environment: { PATH: "" },
    appPaths: [command],
    probe: async () => "0.153.3",
    protocolProbe: async () => inspectClientRequestContract(protocolContract)
  }).snapshot();
}

describe("issue 162 product context", () => {
  it("rejects a model read without the selected execution context while allowing structural projections", async () => {
    const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_CODEX: "/fixture/explicit-cli" });
    const catalog = createModelCatalog(config, {} as CodexUpstream);
    expect(catalog.getCachedCatalog?.()).toBeUndefined();
    await expect(catalog.getCatalog()).rejects.toThrow("CODEX_CONTEXT_REQUIRED");
  });
  it("uses a private-env-only runtime home for the helper's applied CLI selection", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "issue162-context-"));
    roots.push(root);
    process.env.HOME = root;
    delete process.env.CODEX_MCP_BRIDGE_RUNTIME_HOME;
    const configuredHome = path.join(root, "configured-runtimes");
    const defaultHome = path.join(root, ".codex-mcp-bridge", "runtimes");
    const configDirectory = path.join(root, "private");
    const envFile = path.join(configDirectory, ".env");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    const schemaFixture = new URL("./fixtures/app-server-schema-fixture.mjs", import.meta.url).href;
    const createCli = (name: string) => {
      const file = path.join(root, name);
      writeFileSync(file, `#!/usr/bin/env node\nimport ${JSON.stringify(schemaFixture)};\nif (process.argv.includes("--version")) console.log("codex-cli 0.153.3");\n`, { mode: 0o700 });
      chmodSync(file, 0o700);
      return file;
    };
    const defaultCli = createCli("default-cli.mjs");
    const configuredCli = createCli("configured-cli.mjs");
    await savedChoice(defaultHome, defaultCli);
    await savedChoice(configuredHome, configuredCli);
    writeFileSync(envFile, `CODEX_MCP_BRIDGE_RUNTIME_HOME=${configuredHome}\n`, { mode: 0o600 });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot: root,
      envFile,
      bridgeSocketPath: path.join(root, "private", "run", "bridge.sock"),
      runtimeLockDirectory: path.join(root, "locks", "launcher.lock"),
      autoRestart: false,
      registeredProjectRoots: () => []
    });
    try {
      const status = await supervisor.codexRuntime({ action: "status", includeAccount: false });
      expect(status.selection?.command).toBe(configuredCli);
      writeFileSync(envFile, `CODEX_MCP_BRIDGE_RUNTIME_HOME=${defaultHome}\n`, { mode: 0o600 });
      const changed = await supervisor.codexRuntime({ action: "status", includeAccount: false });
      expect(changed.selection?.command).toBe(defaultCli);
    } finally {
      await supervisor.close();
    }
  });

  it("marks a changed file environment pending while the old launcher still runs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "issue162-pending-"));
    roots.push(root);
    process.env.HOME = root;
    delete process.env.CODEX_MCP_BRIDGE_RUNTIME_HOME;
    const bridgeRoot = path.join(root, "bridge");
    const privateDirectory = path.join(root, "private");
    const envFile = path.join(privateDirectory, ".env");
    const launcherPath = path.join(bridgeRoot, "launcher.mjs");
    const appliedHome = path.join(root, "applied-runtime");
    const requestedHome = path.join(root, "requested-runtime");
    const accountCalls = path.join(root, "account-calls.txt");
    const schemaFixture = new URL("./fixtures/app-server-schema-fixture.mjs", import.meta.url).href;
    const createCli = (name: string) => {
      const file = path.join(root, `${name}-cli.mjs`);
      writeFileSync(file, `#!/usr/bin/env node
import ${JSON.stringify(schemaFixture)};
if (process.argv.includes("--version")) { console.log("codex-cli 0.153.3"); process.exit(0); }
if (process.argv.includes("app-server")) {
  const {appendFileSync} = await import("node:fs");
  appendFileSync(${JSON.stringify(accountCalls)}, ${JSON.stringify(name + "\n")});
  const {createInterface} = await import("node:readline");
  createInterface({input:process.stdin}).on("line", line => {
    const request=JSON.parse(line); if(request.id===undefined)return;
    const result=request.method==="initialize" ? {userAgent:"fixture",platformFamily:"unix",platformOs:"macos"}
      : request.method==="account/read" ? {account:{type:"chatgpt",email:"fixture@example.invalid",planType:"plus"}}
      : {rateLimits:null};
    process.stdout.write(JSON.stringify({id:request.id,result})+"\\n");
  });
}
`, { mode: 0o700 });
      return file;
    };
    const appliedCli = createCli("applied");
    const requestedCli = createCli("requested");
    await savedChoice(appliedHome, appliedCli);
    await savedChoice(requestedHome, requestedCli);
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "");
    writeFakeLauncher(launcherPath, path.join(root, "launcher-args.json"), {
      writeRuntimeLock: true
    });
    updateRuntimeEnvFile(envFile, {
      apiKey: "sk-fixture-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    writeFileSync(envFile, `${readFileSync(envFile, "utf8")}CODEX_MCP_BRIDGE_RUNTIME_HOME=${appliedHome}\n`, { mode: 0o600 });
    const supervisor = new MacOSBridgeSupervisor({ bridgeRoot, envFile, launcherPath,
      bridgeSocketPath: path.join(privateDirectory, "run", "bridge.sock"),
      runtimeStatusFile: path.join(privateDirectory, "run", "launcher-status.json"),
      runtimeLockDirectory: path.join(privateDirectory, "run", "launcher.lock"),
      autoRestart: false, registeredProjectRoots: () => [], startTimeoutMs: 5_000 });
    let releaseLease: (() => Promise<void>) | undefined;
    try {
      await supervisor.start();
      const manager = new CodexRuntimeManager({ root: appliedHome, environment: { PATH: "" }, appPaths: [appliedCli],
        probe: async () => "0.153.3", protocolProbe: async () => inspectClientRequestContract(protocolContract) });
      releaseLease = (await manager.acquire()).release;
      const before = await supervisor.codexRuntime({ action: "status", includeAccount: true });
      expect(before.environmentPending).toBe(false);
      expect(before.selection?.command).toBe(appliedCli);
      const statusFile = path.join(privateDirectory, "run", "launcher-status.json");
      const modernStatus = readFileSync(statusFile, "utf8");
      const legacyStatus = JSON.parse(modernStatus) as Record<string, unknown>;
      delete legacyStatus.codexEnvironment;
      writeFileSync(statusFile, JSON.stringify(legacyStatus), { mode: 0o600 });
      expect((await supervisor.codexRuntime({ action: "status", includeAccount: false })).selection?.command).toBe(appliedCli);
      writeFileSync(envFile, readFileSync(envFile, "utf8").replace(appliedHome, requestedHome), { mode: 0o600 });
      await expect(supervisor.codexRuntime({ action: "status", includeAccount: false }))
        .rejects.toThrow("CODEX_APPLIED_CONTEXT_UNAVAILABLE");
      writeFileSync(statusFile, modernStatus, { mode: 0o600 });
      const pending = await supervisor.codexRuntime({ action: "status", includeAccount: true });
      expect(pending.environmentPending).toBe(true);
      expect(pending.selection?.command).toBe(appliedCli);
      expect(pending.runningVersions).toEqual(["0.153.3"]);
      expect(pending.appliedEnvironment?.runtimeHome).toBe(realpathSync(appliedHome));
      expect(pending.runningEnvironment?.runtimeHome).toBe(realpathSync(appliedHome));
      expect(pending.requestedEnvironment?.runtimeHome).toBe(realpathSync(requestedHome));
      expect(pending.requestedEnvironment?.selection?.command).toBe(requestedCli);
      expect(pending.account?.authMode).toBe("chatgpt");
      expect((await supervisor.authStatus()).authenticated).toBe(true);
      expect(readFileSync(accountCalls, "utf8").trim().split("\n").every(name => name === "applied")).toBe(true);
      const requestedStateFile = path.join(requestedHome, "cli-state.json");
      const savedRequestedState = readFileSync(requestedStateFile, "utf8");
      writeFileSync(requestedStateFile, "{invalid", { mode: 0o600 });
      const invalidRequested = await supervisor.codexRuntime({ action: "status", includeAccount: true });
      expect(invalidRequested).toMatchObject({ environmentPending: true,
        selection: { command: appliedCli }, account: { authMode: "chatgpt" },
        requestedEnvironment: { runtimeHome: realpathSync(requestedHome), selection: null },
        requestedEnvironmentProblem: { code: "codex-requested-state-invalid" } });
      expect(invalidRequested.runningVersions).toEqual(["0.153.3"]);
      const recovered = new MacOSBridgeSupervisor({ bridgeRoot, envFile, launcherPath,
        bridgeSocketPath: path.join(privateDirectory, "run", "bridge.sock"),
        runtimeStatusFile: path.join(privateDirectory, "run", "launcher-status.json"),
        runtimeLockDirectory: path.join(privateDirectory, "run", "launcher.lock"),
        autoRestart: false, registeredProjectRoots: () => [], startTimeoutMs: 5_000 });
      try {
        await recovered.start();
        const adopted = await recovered.codexRuntime({ action: "status", includeAccount: false });
        expect(adopted.environmentPending).toBe(true);
        expect(adopted.selection?.command).toBe(appliedCli);
        expect(adopted.requestedEnvironmentProblem?.code).toBe("codex-requested-state-invalid");
      } finally {
        await recovered.close();
      }
      rmSync(requestedStateFile);
      mkdirSync(requestedStateFile);
      const unreadableRequested = await supervisor.codexRuntime({ action: "status", includeAccount: true });
      expect(unreadableRequested.selection?.command).toBe(appliedCli);
      expect(unreadableRequested.account?.authMode).toBe("chatgpt");
      expect(unreadableRequested.requestedEnvironmentProblem?.code).toBe("codex-requested-state-invalid");
      rmSync(requestedStateFile, { recursive: true });
      writeFileSync(requestedStateFile, savedRequestedState, { mode: 0o600 });
      chmodSync(envFile, 0o644);
      const invalidFile = await supervisor.codexRuntime({ action: "status", includeAccount: true });
      expect(invalidFile.selection?.command).toBe(appliedCli);
      expect(invalidFile.account?.authMode).toBe("chatgpt");
      expect(invalidFile.environmentPending).toBe(true);
      expect(invalidFile.requestedEnvironment).toBeNull();
      expect(invalidFile.requestedEnvironmentProblem?.code).toBe("runtime-env-permissions-too-broad");
      expect((await supervisor.authStatus()).authenticated).toBe(true);
      const recoveredWithInvalidFile = new MacOSBridgeSupervisor({ bridgeRoot, envFile, launcherPath,
        bridgeSocketPath: path.join(privateDirectory, "run", "bridge.sock"),
        runtimeStatusFile: path.join(privateDirectory, "run", "launcher-status.json"),
        runtimeLockDirectory: path.join(privateDirectory, "run", "launcher.lock"),
        autoRestart: false, registeredProjectRoots: () => [], startTimeoutMs: 5_000 });
      try {
        await recoveredWithInvalidFile.start();
        const adopted = await recoveredWithInvalidFile.codexRuntime({ action: "status", includeAccount: true });
        expect(adopted.selection?.command).toBe(appliedCli);
        expect(adopted.account?.authMode).toBe("chatgpt");
        expect(adopted.requestedEnvironmentProblem?.code).toBe("runtime-env-permissions-too-broad");
      } finally {
        await recoveredWithInvalidFile.close();
      }
      chmodSync(envFile, 0o600);
      expect((await supervisor.codexRuntime({ action: "status", includeAccount: false })).requestedEnvironment?.selection?.command)
        .toBe(requestedCli);
      expect((await supervisor.codexRuntime({ action: "preferences", preferences: { notifications: false } })).preferences.notifications).toBe(false);
      const checkUpdates = vi.spyOn(CodexRuntimeManager.prototype, "checkUpdates")
        .mockImplementation(function (this: CodexRuntimeManager) { return this.snapshot(); });
      try {
        expect((await supervisor.codexRuntime({ action: "check-updates" })).selection?.command).toBe(appliedCli);
      } finally {
        checkUpdates.mockRestore();
      }
      await expect(supervisor.codexRuntime({ action: "remove-billing" })).resolves.toMatchObject({ billing: { configured: false } });
      await expect(supervisor.codexRuntime({ action: "select", selectionId: "different" })).rejects.toThrow("CODEX_ENVIRONMENT_PENDING");
      await expect(supervisor.startLogin()).rejects.toThrow("CODEX_ENVIRONMENT_PENDING");
    } finally {
      await releaseLease?.();
      await supervisor.close({ runtime: "force-stop" });
    }
  }, 30_000);
});
