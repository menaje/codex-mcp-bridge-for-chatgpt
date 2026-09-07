import { cp, mkdir, mkdtemp, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { CodexRuntimeManager, type RuntimeInstaller } from "../src/codexRuntime.js";
import { MacOSBridgeSupervisor, startMacOSHelperServer, type MacOSHelperController } from "../src/macosHelperServer.js";

// This harness never launches a real Bridge, Tunnel or Codex. It connects the
// production native pane, AppModel, helper protocol and runtime manager to a
// deterministic installer in a private temporary directory. UI actions still
// have to be performed and observed in the native app; building is not a pass.
const repository = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "darwin") throw new Error("Native acceptance requires macOS.");
// macOS's usual temporary directory can exceed sockaddr_un's 104-byte limit.
const root = path.resolve(process.argv[2] || await mkdtemp("/tmp/bridge-native-"));
const socketPath = path.join(root, "codex-mcp-bridge", "run", "helper.sock");
if (Buffer.byteLength(socketPath) >= 104) throw new Error("Choose a shorter temporary path for the native socket.");
await mkdir(root, { recursive: true, mode: 0o700 });
const commandFile = path.join(root, "scenario.json");
try { await readFile(commandFile); } catch { await writeFile(commandFile, JSON.stringify({ name: "missing" })); }
const source = path.join(root, "macos");
await mkdir(source, { recursive: true });
await cp(path.join(repository, "macos", "Sources"), path.join(source, "Sources"), { recursive: true });
await cp(path.join(repository, "macos", "Package.swift"), path.join(source, "Package.swift"));
await mkdir(path.join(source, "Tests", "CodexBridgeKitTests"), { recursive: true });
await writeFile(path.join(source, "Tests", "CodexBridgeKitTests", "Placeholder.swift"), "import XCTest\n");
const mainFile = path.join(source, "Sources", "CodexBridgeMenuBar", "CodexBridgeMenuBarApp.swift");
const main = await readFile(mainFile, "utf8");
if (main.split("@main\nstruct CodexBridgeMenuBarApp").length !== 2) throw new Error("Production entry point changed; review the harness.");
await writeFile(mainFile, main.replace("@main\nstruct CodexBridgeMenuBarApp", "struct CodexBridgeMenuBarApp"));
await cp(path.join(repository, "scripts", "fixtures", "NativeRuntimeAcceptance.swift"),
    path.join(source, "Sources", "CodexBridgeMenuBar", "NativeRuntimeAcceptance.swift"));
execFileSync("swift", ["build", "--package-path", source, "--product", "CodexBridgeMenuBar",
    "-Xswiftc", "-strict-concurrency=complete", "-Xswiftc", "-warnings-as-errors"], { stdio: "inherit" });
const binaryDirectory = execFileSync("swift", ["build", "--package-path", source, "--show-bin-path"], { encoding: "utf8" }).trim();
const app = path.join(root, "Bridge Runtime Acceptance.app");
await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
await cp(path.join(binaryDirectory, "CodexBridgeMenuBar"), path.join(app, "Contents", "MacOS", "BridgeRuntimeAcceptance"));
const escapedRoot = root.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
await writeFile(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.menaje.bridge-runtime-acceptance</string>
<key>CFBundleName</key><string>Bridge Runtime Acceptance</string><key>CFBundleExecutable</key><string>BridgeRuntimeAcceptance</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>AcceptanceRoot</key><string>${escapedRoot}</string></dict></plist>`);
execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });

let key = "";
let manager: CodexRuntimeManager;
let supervisor: MacOSBridgeSupervisor;
let release: (() => Promise<void>) | undefined;
let preparing: Promise<void> | undefined;
const log = async (value: unknown) => appendFile(path.join(root, "actions.jsonl"), JSON.stringify(value) + "\n");
async function prepare() {
    const scenario = JSON.parse(await readFile(commandFile, "utf8")) as { name: string; generation?: number; gate?: string };
    if (!["missing", "update", "damaged", "pending", "failed", "recovery", "cleanup", "external"].includes(scenario.name) ||
        (scenario.generation !== undefined && (!Number.isSafeInteger(scenario.generation) || scenario.generation < 0))) {
        throw new Error("Choose a documented scenario name and a nonnegative generation integer.");
    }
    const nextKey = `${scenario.name}-${scenario.generation || 0}`;
    if (key === nextKey) return;
    await release?.(); release = undefined;
    const directory = path.join(root, "scenarios", nextKey);
    const bin = path.join(directory, "bin");
    await mkdir(bin, { recursive: true });
    const installer: RuntimeInstaller = async ({ directory: target, version, onProgress }) => {
        const current = JSON.parse(await readFile(commandFile, "utf8"));
        if (key && current.gate === "fail") throw new Error("Acceptance installer failure");
        if (key && current.gate === "wait") {
            await onProgress("downloading", 50, 100);
            while (JSON.parse(await readFile(commandFile, "utf8")).gate === "wait") await new Promise(resolve => setTimeout(resolve, 150));
        }
        await onProgress("verifying");
        const command = path.join(target, "codex");
        await writeFile(command, `version=${version}`, { mode: 0o700 });
        return command;
    };
    manager = new CodexRuntimeManager({ root: path.join(directory, "managed"), environment: { PATH: bin }, appPaths: [],
        probe: command => readFile(command, "utf8").then(value => /^version=(\d+\.\d+\.\d+)$/.exec(value)?.[1] || null).catch(() => null),
        installer, defaultVersion: "0.153.3", latestVersion: async () => {
            if (JSON.parse(await readFile(commandFile, "utf8")).gate === "check-fail") throw new Error("Acceptance update service failure");
            return "0.153.4";
        } });
    const initialized = path.join(directory, "initialized");
    let alreadyInitialized = false;
    try { await readFile(initialized); alreadyInitialized = true; } catch { /* first visit */ }
    key = "";
    if (!alreadyInitialized) {
        if (scenario.name !== "missing") await manager.install();
        if (["update", "pending", "recovery", "cleanup", "failed", "damaged", "external"].includes(scenario.name)) await manager.checkUpdates();
        if (["pending", "recovery", "cleanup"].includes(scenario.name)) {
            if (scenario.name === "pending") release = await manager.lease(await manager.resolve());
            await manager.install("update");
        }
        if (scenario.name === "cleanup") {
            await rm((await manager.resolve()).command);
            await manager.install("reinstall");
        }
        if (scenario.name === "damaged") await appendFile((await manager.resolve()).command, "\ndamaged");
        if (scenario.name === "external") {
            await writeFile(path.join(bin, "codex"), "version=0.153.4", { mode: 0o700 });
            const candidate = (await manager.discover()).find(value => value.source === "terminal")!;
            await manager.select(candidate.id);
        }
        if (scenario.name === "failed") {
            key = nextKey;
            await writeFile(commandFile, JSON.stringify({ ...scenario, gate: "fail" }));
            await manager.install("update").catch(() => undefined);
        }
        await writeFile(initialized, "ready");
    }
    key = nextKey;
    supervisor = new MacOSBridgeSupervisor({ bridgeRoot: repository, envFile: path.join(directory, ".env"),
        bridgeSocketPath: path.join(directory, "bridge.sock"), codexRuntimeManager: manager, autoRestart: false });
    await log({ scenario: key, initialized: true });
}
const controller = new Proxy({} as MacOSHelperController, { get: (_, property) => {
    if (property === "subscribeChanges") return undefined; // Use the ordinary visibility-aware status poll.
    if (property === "logs") return () => [];
    return async (...args: unknown[]) => {
        await (preparing ||= prepare().finally(() => { preparing = undefined; }));
        if (property === "codexRuntime") {
            const request = args[0] as Parameters<MacOSBridgeSupervisor["codexRuntime"]>[0];
            if (request.action !== "status") await log({ scenario: key, request });
            // Account access is outside this UI fixture; no executable is run.
            const value = await supervisor.codexRuntime({ ...request, includeAccount: false });
            await writeFile(path.join(root, "snapshot.json"), JSON.stringify(value, null, 2));
            return value;
        }
        if (property === "restart") {
            await log({ scenario: key, action: "restart" });
            await release?.(); release = undefined;
            await manager.applyPending();
            return supervisor.health();
        }
        if (["health", "snapshot"].includes(String(property))) return supervisor.health();
        throw new Error(`Acceptance harness does not run ${String(property)}.`);
    };
} });
const server = await startMacOSHelperServer({ socketPath, controller });
console.log(JSON.stringify({ root, app, scenarioFile: commandFile, scope: "native UI with fixture downloads and runtime leases; no live runtime or deployment" }));
process.on("SIGTERM", () => { void server.close().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void server.close().finally(() => process.exit(0)); });
