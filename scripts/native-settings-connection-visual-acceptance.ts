import { access, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Requires macOS.");
const repository = fileURLToPath(new URL("..", import.meta.url));
const requestedRoot = process.argv[2];
const root = requestedRoot
  ? path.resolve(requestedRoot)
  : await mkdtemp("/tmp/bridge-settings-visual-");

if (requestedRoot) {
  let exists = true;
  try {
    await access(root, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) throw new Error("The requested acceptance root must not already exist.");
  await mkdir(root, { mode: 0o700 });
}

const source = path.join(root, "macos");
await cp(path.join(repository, "macos", "Sources"), path.join(source, "Sources"), {
  recursive: true
});
await cp(path.join(repository, "macos", "Package.swift"), path.join(source, "Package.swift"));
await mkdir(path.join(source, "Tests", "CodexBridgeKitTests"), { recursive: true });
await writeFile(
  path.join(source, "Tests", "CodexBridgeKitTests", "Placeholder.swift"),
  "import XCTest\n"
);

const mainFile = path.join(
  source,
  "Sources",
  "CodexBridgeMenuBar",
  "CodexBridgeMenuBarApp.swift"
);
const main = await readFile(mainFile, "utf8");
if (main.split("@main\nstruct CodexBridgeMenuBarApp").length !== 2) {
  throw new Error("Review the changed production entry point.");
}
for (const contract of [
  "NavigationSplitView(columnVisibility: $columnVisibility)",
  "ScrollViewReader",
  ".navigationSplitViewStyle(.balanced)",
  "placement: .sidebar",
  "SettingsDefaultSidebarToolbarRemovalModifier",
  "SettingsTitlebarSanitizerView",
  "SettingsSearchIndex",
  "settingsConnectionStatusCard",
  "ConnectionSetupRequiredPopoverView",
  "ConnectionAssistantRootView",
  "ConnectionRecoveryPlan"
]) {
  const files = [
    path.join(source, "Sources", "CodexBridgeMenuBar", "SettingsViews.swift"),
    path.join(source, "Sources", "CodexBridgeMenuBar", "DashboardViews.swift"),
    path.join(source, "Sources", "CodexBridgeMenuBar", "ConnectionAssistantViews.swift")
  ];
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  if (!contents.some((content) => content.includes(contract))) {
    throw new Error(`Production UI contract is missing: ${contract}`);
  }
}
await writeFile(
  mainFile,
  main.replace("@main\nstruct CodexBridgeMenuBarApp", "struct CodexBridgeMenuBarApp")
);
await cp(
  path.join(
    repository,
    "scripts",
    "fixtures",
    "NativeSettingsConnectionVisualAcceptance.swift"
  ),
  path.join(
    source,
    "Sources",
    "CodexBridgeMenuBar",
    "NativeSettingsConnectionVisualAcceptance.swift"
  )
);

execFileSync(
  "swift",
  [
    "build",
    "--package-path",
    source,
    "--product",
    "CodexBridgeMenuBar",
    "-Xswiftc",
    "-strict-concurrency=complete",
    "-Xswiftc",
    "-warnings-as-errors"
  ],
  { stdio: "inherit" }
);
const binaryDirectory = execFileSync(
  "swift",
  ["build", "--package-path", source, "--show-bin-path"],
  { encoding: "utf8" }
).trim();

const app = path.join(root, "Bridge Settings Visual Acceptance.app");
await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
await mkdir(path.join(app, "Contents", "Resources"), { recursive: true });
await cp(
  path.join(binaryDirectory, "CodexBridgeMenuBar"),
  path.join(app, "Contents", "MacOS", "BridgeSettingsVisualAcceptance")
);
const escapedRoot = root.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
await writeFile(
  path.join(app, "Contents", "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.menaje.bridge-settings-visual-acceptance</string>
<key>CFBundleName</key><string>Bridge Settings Visual Acceptance</string>
<key>CFBundleExecutable</key><string>BridgeSettingsVisualAcceptance</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>AcceptanceRoot</key><string>${escapedRoot}</string>
</dict></plist>`
);
execFileSync(
  "xcrun",
  [
    "xcstringstool",
    "compile",
    path.join(repository, "macos", "Resources", "Localization", "Localizable.xcstrings"),
    "--output-directory",
    path.join(app, "Contents", "Resources"),
    "--serialization-format",
    "text"
  ],
  { stdio: "inherit" }
);
execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });

const executable = path.join(app, "Contents", "MacOS", "BridgeSettingsVisualAcceptance");
execFileSync(executable, [], {
  cwd: root,
  env: { ...process.env, CODEX_SETTINGS_VISUAL_ACCEPTANCE_ROOT: root },
  stdio: "inherit",
  timeout: 180_000
});

const report = path.join(root, "artifacts", "report.json");
await access(report, constants.R_OK);
const expectedCaptures = [
  "settings-sidebar-ko-light.png",
  "settings-sidebar-en-light.png",
  "settings-general-bottom-en-light.png",
  "settings-sidebar-en-dark-minimum.png",
  "settings-model-execution-en-light.png",
  "settings-projects-en-light.png",
  "settings-codex-en-light.png",
  "settings-connection-en-light.png",
  "settings-server-en-light.png",
  "settings-titlebar-clean-en-light.png",
  "settings-search-results-en-light.png",
  "connection-setup-first-run-ko-light.png",
  "connection-setup-first-run-en-light.png",
  "connection-setup-first-run-ko-dark.png",
  "connection-setup-first-run-de-light-minimum.png",
  "connection-setup-discovery-en-light.png",
  "connection-setup-credentials-en-light.png",
  "connection-setup-remote-en-light.png",
  "connection-setup-codex-en-light.png",
  "connection-setup-complete-en-light.png",
  "connection-recovery-failures-en-light.png",
  "connection-recovery-ready-en-light.png"
];
for (const capture of expectedCaptures) {
  await access(path.join(root, "artifacts", capture), constants.R_OK);
}
const reportData = JSON.parse(await readFile(report, "utf8")) as {
  captureMethod?: string;
  checks?: Record<string, boolean>;
  captures?: Array<{
    file?: string;
    captureMethod?: string;
    expectedText?: string[];
    recognizedText?: string;
    byteCount?: number;
  }>;
};
if (reportData.captureMethod !== "AppKit scenario render") {
  throw new Error("Visual acceptance did not render the expected AppKit scenarios.");
}
if (!reportData.checks || Object.values(reportData.checks).some((value) => value !== true)) {
  throw new Error("One or more visual acceptance checks did not pass.");
}
const records = reportData.captures ?? [];
for (const file of expectedCaptures) {
  const record = records.find((candidate) => candidate.file === file);
  if (!record || record.captureMethod !== "AppKit scenario render" ||
      !record.recognizedText || !record.expectedText?.length ||
      (record.byteCount ?? 0) <= 10_000) {
    throw new Error(`Visual evidence is incomplete for ${file}.`);
  }
}
console.log(JSON.stringify({ app, root, report }));
