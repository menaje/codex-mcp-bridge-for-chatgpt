#!/usr/bin/env node
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRuntimeEnvFile } from "../scripts/runtime-env.mjs";
import {
  MacOSBridgeSupervisor,
  startMacOSHelperServer
} from "./macosHelperServer.js";

if (process.platform === "darwin") {
  process.title = "Codex MCP Bridge Helper";
}

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const defaultBridgeRoot = resolve(sourceDirectory, "..");
const args = parseArguments(process.argv.slice(2));
const envFile = path.resolve(args.envFile || defaultRuntimeEnvFile());
const runDirectory = path.join(path.dirname(envFile), "run");
const helperSocketPath = path.resolve(args.socket || path.join(runDirectory, "helper.sock"));
const bridgeSocketPath = path.resolve(
  args.bridgeSocket || path.join(runDirectory, "bridge.sock")
);
const bridgeRoot = path.resolve(args.bridgeRoot || defaultBridgeRoot);
const supervisor = new MacOSBridgeSupervisor({
  bridgeRoot,
  envFile,
  bridgeSocketPath,
  runtimeLockDirectory: args.runtimeLockDirectory
});
const server = await startMacOSHelperServer({
  socketPath: helperSocketPath,
  controller: supervisor
});
let shuttingDown = false;

console.log(`Codex MCP Bridge macOS helper ready at ${server.socketPath}`);
if (!args.noAutoStart) {
  void supervisor.start().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down macOS helper`);
  let code = 0;
  try {
    await supervisor.close();
  } catch (error) {
    code = 1;
    console.error(error instanceof Error ? error.message : String(error));
  }
  try {
    await server.close();
  } catch (error) {
    code = 1;
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

type HelperArguments = {
  socket?: string;
  bridgeSocket?: string;
  bridgeRoot?: string;
  envFile?: string;
  runtimeLockDirectory?: string;
  noAutoStart?: boolean;
};

function parseArguments(raw: string[]): HelperArguments {
  const parsed: HelperArguments = {};
  const valueOptions = new Map<string, keyof HelperArguments>([
    ["--socket", "socket"],
    ["--bridge-socket", "bridgeSocket"],
    ["--bridge-root", "bridgeRoot"],
    ["--env-file", "envFile"],
    ["--runtime-lock-directory", "runtimeLockDirectory"]
  ]);
  for (let index = 0; index < raw.length; index += 1) {
    const argument = raw[index];
    if (argument === "--no-auto-start") {
      parsed.noAutoStart = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) throw new Error(`Unknown macOS helper option: ${argument}`);
    const value = raw[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    (parsed as Record<string, string | boolean | undefined>)[key] = value;
  }
  return parsed;
}
