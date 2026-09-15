import { access, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Builds the production Bridge skill window in an isolated application and
// captures its AppKit backing views. The capture does not depend on the screen
// compositor, so it remains usable while the login session is locked.
if (process.platform !== "darwin") throw new Error("Requires macOS.");
const repository = fileURLToPath(new URL("..", import.meta.url));
const requestedRoot = process.argv[2];
const root = requestedRoot
  ? path.resolve(requestedRoot)
  : await mkdtemp("/tmp/bridge-skill-visual-");
if (requestedRoot) {
  let alreadyExists = true;
  try {
    await access(root, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    alreadyExists = false;
  }
  if (alreadyExists) throw new Error("The requested acceptance root must not already exist.");
  await mkdir(root, { mode: 0o700 });
}
const source = path.join(root, "macos");
const run = path.join(root, "codex-mcp-bridge", "run");
if (Buffer.byteLength(path.join(run, "bridge.sock")) >= 104) {
  throw new Error("Choose a shorter temporary path.");
}
await mkdir(run, { recursive: true, mode: 0o700 });
await cp(path.join(repository, "macos", "Sources"), path.join(source, "Sources"), { recursive: true });
await cp(path.join(repository, "macos", "Package.swift"), path.join(source, "Package.swift"));
await mkdir(path.join(source, "Tests", "CodexBridgeKitTests"), { recursive: true });
await writeFile(path.join(source, "Tests", "CodexBridgeKitTests", "Placeholder.swift"), "import XCTest\n");

const mainFile = path.join(source, "Sources", "CodexBridgeMenuBar", "CodexBridgeMenuBarApp.swift");
const main = await readFile(mainFile, "utf8");
if (main.split("@main\nstruct CodexBridgeMenuBarApp").length !== 2) {
  throw new Error("Review the changed production entry point.");
}
for (const shortcut of ["n", "o", "s", "f", "e"]) {
  if (!main.includes(`.keyboardShortcut(\"${shortcut}\", modifiers: .command)`)) {
    throw new Error(`Production Bridge skill shortcut is missing: Command-${shortcut.toUpperCase()}`);
  }
}
for (const windowContract of [
  "styleMask: [.titled, .closable, .miniaturizable, .resizable]",
  'setFrameAutosaveName("CodexBridgeSkillsLibraryWindow")',
  "skillsWindow.contentMinSize = NSSize(width: 820, height: 600)"
]) {
  if (!main.includes(windowContract)) throw new Error(`Production skill window contract is missing: ${windowContract}`);
}
await writeFile(mainFile, main.replace("@main\nstruct CodexBridgeMenuBarApp", "struct CodexBridgeMenuBarApp"));

// The review sheet is deliberately private production UI. Widen access only
// inside the copied acceptance source so the harness can render that exact view.
const skillsFile = path.join(source, "Sources", "CodexBridgeMenuBar", "SkillsLibraryViews.swift");
const skills = await readFile(skillsFile, "utf8");
const reviewDeclaration = "private struct BridgeSkillImportReviewSheet: View";
if (skills.split(reviewDeclaration).length !== 2) {
  throw new Error("Review the changed Bridge skill import sheet declaration.");
}
for (const label of [
  "macos.skills.bridgeSkillList",
  "macos.skills.skillDocumentFileTree",
  "macos.skills.fullMarkdownSourceOfSelectedFile"
]) {
  if (!skills.includes(`.accessibilityLabel(\"${label}\")`)) {
    throw new Error(`Production accessibility label is missing: ${label}`);
  }
}
for (const importContract of [
  ".onDrop(of: [UTType.fileURL.identifier]",
  "BridgeSkillDropLoader.urls(from: providers)",
  "BridgeSkillImportRouter.route(urls: urls)"
]) {
  if (!skills.includes(importContract)) throw new Error(`Production drop/import contract is missing: ${importContract}`);
}
await writeFile(skillsFile, skills.replace(reviewDeclaration, "struct BridgeSkillImportReviewSheet: View"));

await cp(
  path.join(repository, "scripts", "fixtures", "NativeSkillLibraryVisualAcceptance.swift"),
  path.join(source, "Sources", "CodexBridgeMenuBar", "NativeSkillLibraryVisualAcceptance.swift")
);
await cp(
  path.join(repository, "macos", "Tests", "CodexBridgeKitTests", "NativeRPCFixture.swift"),
  path.join(source, "Sources", "CodexBridgeMenuBar", "NativeRPCFixture.swift")
);

execFileSync("swift", [
  "build", "--package-path", source, "--product", "CodexBridgeMenuBar",
  "-Xswiftc", "-strict-concurrency=complete", "-Xswiftc", "-warnings-as-errors"
], { stdio: "inherit" });
const binaryDirectory = execFileSync(
  "swift", ["build", "--package-path", source, "--show-bin-path"], { encoding: "utf8" }
).trim();
const app = path.join(root, "Bridge Skill Visual Acceptance.app");
await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
await mkdir(path.join(app, "Contents", "Resources"), { recursive: true });
await cp(
  path.join(binaryDirectory, "CodexBridgeMenuBar"),
  path.join(app, "Contents", "MacOS", "BridgeSkillVisualAcceptance")
);
const escapedRoot = root.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
await writeFile(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.menaje.bridge-skill-visual-acceptance</string>
<key>CFBundleName</key><string>Bridge Skill Visual Acceptance</string>
<key>CFBundleExecutable</key><string>BridgeSkillVisualAcceptance</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/><key>AcceptanceRoot</key><string>${escapedRoot}</string></dict></plist>`);
execFileSync("xcrun", [
  "xcstringstool", "compile",
  path.join(repository, "macos", "Resources", "Localization", "Localizable.xcstrings"),
  "--output-directory", path.join(app, "Contents", "Resources"),
  "--serialization-format", "text"
], { stdio: "inherit" });
execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });

const executable = path.join(app, "Contents", "MacOS", "BridgeSkillVisualAcceptance");
execFileSync(executable, [], {
  cwd: root,
  env: { ...process.env, CODEX_SKILL_VISUAL_ACCEPTANCE_ROOT: root },
  stdio: "inherit",
  timeout: 120_000
});
const report = path.join(root, "artifacts", "report.json");
await access(report, constants.R_OK);
console.log(JSON.stringify({ app, root, report, scope: "production native Bridge skill views; synthetic socket state" }));
