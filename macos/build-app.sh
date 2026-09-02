#!/bin/bash
set -euo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
output_directory="$script_directory/build"
app_bundle="$output_directory/Codex MCP Bridge for ChatGPT.app"
contents_directory="$app_bundle/Contents"
runtime_directory="$contents_directory/Resources/Runtime"

cd "$repository_root"
npm run build
swift test --package-path "$script_directory"
swift build --package-path "$script_directory" -c release --product CodexBridgeMenuBar
swift_binary_directory="$(swift build --package-path "$script_directory" -c release --show-bin-path)"

rm -rf "$app_bundle"
mkdir -p "$contents_directory/MacOS" "$runtime_directory/scripts"
cp "$swift_binary_directory/CodexBridgeMenuBar" "$contents_directory/MacOS/CodexBridgeMenuBar"
cp "$script_directory/Info.plist" "$contents_directory/Info.plist"
cp -R "$repository_root/dist" "$runtime_directory/dist"
cp "$repository_root/package.json" "$repository_root/package-lock.json" "$runtime_directory/"
cp "$repository_root/release-manifest.json" "$runtime_directory/"
cp "$repository_root/scripts/build-fingerprint.mjs" "$runtime_directory/scripts/"
cp "$repository_root/scripts/child-shutdown.mjs" "$runtime_directory/scripts/"
cp "$repository_root/scripts/launcher-options.mjs" "$runtime_directory/scripts/"
cp "$repository_root/scripts/managed-file.mjs" "$runtime_directory/scripts/"
cp "$repository_root/scripts/managed-file.d.mts" "$runtime_directory/scripts/"
cp "$repository_root/scripts/runtime-env.mjs" "$runtime_directory/scripts/"
cp "$repository_root/scripts/runtime-lock.mjs" "$runtime_directory/scripts/"
cp "$repository_root/scripts/runtime-status.mjs" "$runtime_directory/scripts/"
cp "$repository_root/scripts/runtime-status.d.mts" "$runtime_directory/scripts/"
cp "$repository_root/scripts/start-codex-mcp-bridge.mjs" "$runtime_directory/scripts/"
cp "$repository_root/scripts/tunnel-profile.mjs" "$runtime_directory/scripts/"

package_version="$(node -p "require('./package.json').version")"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $package_version" "$contents_directory/Info.plist"

(
  cd "$runtime_directory"
  npm ci --omit=dev --no-audit --no-fund
)

codesign --force --deep --sign - "$app_bundle"
echo "$app_bundle"
