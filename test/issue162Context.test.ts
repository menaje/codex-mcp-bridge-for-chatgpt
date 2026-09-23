import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "");
    writeFakeLauncher(launcherPath, path.join(root, "launcher-args.json"), {
      writeRuntimeLock: true, recordCodexEnvironmentFingerprint: true
    });
    updateRuntimeEnvFile(envFile, {
      apiKey: "sk-fixture-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({ bridgeRoot, envFile, launcherPath,
      bridgeSocketPath: path.join(privateDirectory, "run", "bridge.sock"),
      runtimeStatusFile: path.join(privateDirectory, "run", "launcher-status.json"),
      runtimeLockDirectory: path.join(privateDirectory, "run", "launcher.lock"),
      autoRestart: false, registeredProjectRoots: () => [], startTimeoutMs: 5_000 });
    try {
      await supervisor.start();
      expect((await supervisor.codexRuntime({ action: "status", includeAccount: false })).environmentPending).toBe(false);
      writeFileSync(envFile, `${readFileSync(envFile, "utf8")}CODEX_MCP_BRIDGE_RUNTIME_HOME=${path.join(root, "next-runtime")}\n`, { mode: 0o600 });
      expect((await supervisor.codexRuntime({ action: "status", includeAccount: false })).environmentPending).toBe(true);
      await expect(supervisor.authStatus()).rejects.toThrow("CODEX_ENVIRONMENT_PENDING");
      await expect(supervisor.startLogin()).rejects.toThrow("CODEX_ENVIRONMENT_PENDING");
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  }, 15_000);
});
