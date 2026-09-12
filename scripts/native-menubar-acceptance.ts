import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Build the actual MenuBarExtra popover in an isolated application. The helper,
// work rows and actions are synthetic; no installed service or user task is used.
if (process.platform !== "darwin") throw new Error("Requires macOS.");
const repository = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(process.argv[2] || await mkdtemp("/tmp/bridge-menu-"));
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
await cp(path.join(repository, "scripts", "fixtures", "NativeMenuBarAcceptance.swift"),
  path.join(source, "Sources", "CodexBridgeMenuBar", "NativeMenuBarAcceptance.swift"));
await cp(path.join(repository, "macos", "Tests", "CodexBridgeKitTests", "NativeRPCFixture.swift"),
  path.join(source, "Sources", "CodexBridgeMenuBar", "NativeRPCFixture.swift"));

const observed = new Date().toISOString();
const row = (id: number, status: string) => ({ rowKey: `fixture-${id}`, activityKey: `activity-${id}`,
  conversationKey: `conversation-${id}`, sessionAlias: `fixture-${id}`, bucket: status === "failed" ? "terminal" : "active",
  projectKey: "fixture-project", projectName: "메뉴바 검증", agentName: `작업 ${id}`,
  activityTitle: status === "running" ? `진행 중인 작업 ${id}` : status === "failed" ? "종료된 실패 작업" : "승인을 기다리는 작업",
  status, createdAt: observed, updatedAt: observed, elapsedMs: 5000, backgroundProcessCount: 0 });
const activeRows = [row(1, "running"), row(2, "approval-required")];
const terminalRows = [row(3, "failed")];
const page = (total: number) => ({ offset: 0, limit: 12, returned: total, total,
  returnedConversations: total, conversationTotal: total, hasPrevious: false, hasNext: false });
const countNames = ["trackedProjects", "trackedConversations", "retainedJobs", "active", "running", "inputRequired",
  "approvalRequired", "terminating", "needsAttention", "backgroundProcesses", "backgroundProcessAgents", "runtimeUnknownAgents",
  "runtimeProbeSkippedAgents", "completed", "failed", "interrupted", "cancelled", "idleAgents", "orphanedAgents"];
const counts = { ...Object.fromEntries(countNames.map(key => [key, 0])), running: 1, approvalRequired: 1, responseRequired: 1,
  active: 2, failed: 1, problems: 1, needsAttention: 2 };
await writeFile(path.join(root, "state.json"), JSON.stringify({
  helper: { kind: "helper-status", generatedAt: observed, phase: "running", restartAttempt: 0,
    configuration: { path: "/private/fixture/.env", exists: true, valid: true, hasApiKey: true, hasTunnelId: true },
    bridge: { socketPath: path.join(run, "bridge.sock"), connected: true },
    tunnel: { phase: "connected", doctorPassed: true, processRunning: true, connected: true } },
  auth: { installed: true, authenticated: true, summary: "Synthetic fixture" },
  dashboard: { kind: "dashboard", generatedAt: observed, scope: "bridge-wide", statusSource: "codex-runtime-only", coverage: "complete",
    counts, activeRows, terminalRows, idleRows: [], pagination: { active: page(2), terminal: page(1), idle: page(0) }, uiLocalePreference: "ko",
    weeklyUsage: { source: "fixture", limitId: "codex", usedPercent: 25, remainingPercent: 75, resetsAt: new Date(Date.now() + 86400000).toISOString(),
      windowDurationMins: 10080, observedAt: observed },
    historyPolicy: { retentionDays: 30, issueAttentionDays: 7, lastCleanupCount: 0, totalRemoved: 0, automaticRecovery: true },
    problems: { query: { review: "pending", kind: "all", offset: 0, view: "actionable" }, revision: "fixture-problems",
      pendingCount: 1, acknowledgedCount: 0, reviewableCount: 0, historyCount: 1, automaticCount: 0,
      rows: [{ problemKey: "fixture-problem", revision: "fixture-revision", kind: "unknown", source: "runtime", review: "pending",
        observedAt: observed, reason: "합성 실행 상태를 확인할 수 없습니다.", canAcknowledge: false, canUnacknowledge: false,
        canRecheck: true, canRetryStop: false, row: { ...row(4, "unknown"), activityTitle: "상태 확인이 필요한 작업" } }],
      page: { offset: 0, limit: 12, total: 1, returned: 1, hasPrevious: false, hasNext: false } } }
}, null, 2), { mode: 0o600 });

execFileSync("swift", ["build", "--package-path", source, "--product", "CodexBridgeMenuBar",
  "-Xswiftc", "-strict-concurrency=complete", "-Xswiftc", "-warnings-as-errors"], { stdio: "inherit" });
const binaryDirectory = execFileSync("swift", ["build", "--package-path", source, "--show-bin-path"], { encoding: "utf8" }).trim();
const app = path.join(repository, "macos", "build", "acceptance", "Bridge Menu Acceptance.app");
await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
await mkdir(path.join(app, "Contents", "Resources"), { recursive: true });
await cp(path.join(binaryDirectory, "CodexBridgeMenuBar"), path.join(app, "Contents", "MacOS", "BridgeMenuAcceptance"));
const escapedRoot = root.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
await writeFile(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.menaje.bridge-menu-acceptance</string>
<key>CFBundleName</key><string>Bridge Menu Acceptance</string><key>CFBundleExecutable</key><string>BridgeMenuAcceptance</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/><key>AcceptanceRoot</key><string>${escapedRoot}</string></dict></plist>`);
execFileSync("xcrun", ["xcstringstool", "compile", path.join(repository, "macos/Resources/Localization/Localizable.xcstrings"),
  "--output-directory", path.join(app, "Contents", "Resources"), "--serialization-format", "text"]);
execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });
console.log(JSON.stringify({ app, root, scope: "real native menu bar popover; synthetic work and socket state" }));
