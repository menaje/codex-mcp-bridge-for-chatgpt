import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? "/tmp/Bridge Input Acceptance.app");
execFileSync("swift", ["build", "--package-path", path.join(root, "macos"),
  "-Xswiftc", "-strict-concurrency=complete", "-Xswiftc", "-warnings-as-errors"], { stdio: "inherit" });
const build = path.join(root, "macos/.build/debug");
const objects = readdirSync(path.join(build, "CodexBridgeKit.build"))
  .filter((file) => file.endsWith(".o")).map((file) => path.join(build, "CodexBridgeKit.build", file));
const production = path.join(root, "macos/Sources/CodexBridgeMenuBar");
const sources = [path.join(root, "scripts/native-input-acceptance.swift"),
  ...["TextInputViews.swift", "EditSession.swift", "AppLocalization.swift", "GeneratedLocalization.swift"].map((file) => path.join(production, file))];
const sourceHash = createHash("sha256");
for (const source of sources) { sourceHash.update(path.basename(source)); sourceHash.update(readFileSync(source)); }
const fingerprint = sourceHash.digest("hex");
const binary = path.join(output, "Contents/MacOS/BridgeInputAcceptance");
mkdirSync(path.dirname(binary), { recursive: true });
execFileSync("swiftc", ["-parse-as-library", "-swift-version", "5", "-strict-concurrency=complete", "-warnings-as-errors", "-I", path.join(build, "Modules"), ...sources,
  ...objects, "-o", binary], { stdio: "inherit" });
writeFileSync(path.join(output, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.bridge.input-acceptance</string>
<key>CFBundleName</key><string>Bridge Input Acceptance</string>
<key>CFBundleExecutable</key><string>BridgeInputAcceptance</string>
<key>NSHighResolutionCapable</key><true/>
<key>BridgeAcceptanceSourceHash</key><string>${fingerprint}</string>
</dict></plist>\n`);
console.log(`Built ${output}; launch through the UI and use actual installed IME keys.`);
