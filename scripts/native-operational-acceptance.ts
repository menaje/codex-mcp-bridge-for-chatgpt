import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Builds a separate local app. Real production views, notification delivery and
// accessibility are exercised against synthetic socket data; no user service starts.
if (process.platform !== "darwin") throw new Error("Requires macOS.");
const repository = fileURLToPath(new URL("..", import.meta.url));
const live = process.argv.includes("--connect-installed");
const root = path.resolve(process.argv.slice(2).find(value => !value.startsWith("--")) || await mkdtemp("/tmp/bridge-operations-"));
const source = path.join(root, "macos");
const run = path.join(root, "codex-mcp-bridge", "run");
if (Buffer.byteLength(path.join(run, "helper.sock")) >= 104) throw new Error("Choose a shorter temporary path.");
await mkdir(run, { recursive: true, mode: 0o700 });
await cp(path.join(repository, "macos", "Sources"), path.join(source, "Sources"), { recursive: true });
await cp(path.join(repository, "macos", "Package.swift"), path.join(source, "Package.swift"));
await mkdir(path.join(source, "Tests", "CodexBridgeKitTests"), { recursive: true });
await writeFile(path.join(source, "Tests", "CodexBridgeKitTests", "Placeholder.swift"), "import XCTest\n");
const mainFile = path.join(source, "Sources", "CodexBridgeMenuBar", "CodexBridgeMenuBarApp.swift");
const main = await readFile(mainFile, "utf8");
if (main.split("@main\nstruct CodexBridgeMenuBarApp").length !== 2) throw new Error("Review the changed production entry point.");
await writeFile(mainFile, main.replace("@main\nstruct CodexBridgeMenuBarApp", "struct CodexBridgeMenuBarApp"));
const fixture = live ? "NativeLiveAcceptance.swift" : "NativeOperationalAcceptance.swift";
await cp(path.join(repository, "scripts", "fixtures", fixture),
    path.join(source, "Sources", "CodexBridgeMenuBar", fixture));
await cp(path.join(repository, "macos", "Tests", "CodexBridgeKitTests", "NativeRPCFixture.swift"),
    path.join(source, "Sources", "CodexBridgeMenuBar", "NativeRPCFixture.swift"));
execFileSync("swift", ["build", "--package-path", source, "--product", "CodexBridgeMenuBar",
    "-Xswiftc", "-strict-concurrency=complete", "-Xswiftc", "-warnings-as-errors"], { stdio: "inherit" });
const binaryDirectory = execFileSync("swift", ["build", "--package-path", source, "--show-bin-path"], { encoding: "utf8" }).trim();
// macOS rejects notification authorization for applications under /tmp.
// Keep only the socket/state directory there; the test bundle stays in ignored build output.
const appName = live ? "Bridge Live Acceptance" : "Bridge Operations Acceptance";
const app = path.join(repository, "macos", "build", "acceptance", `${appName}.app`);
await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
await cp(path.join(binaryDirectory, "CodexBridgeMenuBar"), path.join(app, "Contents", "MacOS", "BridgeOperationsAcceptance"));
const escapedRoot = root.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
await writeFile(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.menaje.bridge-${live ? "live" : "operations"}-acceptance</string>
<key>CFBundleName</key><string>${appName}</string><key>CFBundleExecutable</key><string>BridgeOperationsAcceptance</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>AcceptanceRoot</key><string>${escapedRoot}</string></dict></plist>`);
execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });
console.log(JSON.stringify({ app, root, scope: live
    ? "production native views connected to the installed helper; operator actions affect the installed service"
    : "real native views and system notifications; synthetic local socket state" }));
