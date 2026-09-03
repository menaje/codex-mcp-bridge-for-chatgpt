#!/bin/bash
set -euo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
output_directory="$script_directory/build"
app_bundle="$output_directory/Codex MCP Bridge for ChatGPT.app"
contents_directory="$app_bundle/Contents"
resources_directory="$contents_directory/Resources"
runtime_directory="$resources_directory/Runtime"
app_icon_source="$script_directory/Resources/AppIcon/app-icon-1024.png"
app_iconset_directory="$output_directory/AppIcon.iconset"

cd "$repository_root"
npm run build
npm run macos:check
swift build --package-path "$script_directory" -c release --product CodexBridgeMenuBar \
  -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
swift_binary_directory="$(swift build --package-path "$script_directory" -c release --show-bin-path)"

rm -rf "$app_bundle"
rm -rf "$app_iconset_directory"
mkdir -p "$contents_directory/MacOS" "$runtime_directory/scripts" "$app_iconset_directory"
cp "$swift_binary_directory/CodexBridgeMenuBar" "$contents_directory/MacOS/CodexBridgeMenuBar"
cp "$script_directory/Info.plist" "$contents_directory/Info.plist"

if [[ ! -f "$app_icon_source" ]]; then
  echo "Missing app icon source: $app_icon_source" >&2
  exit 1
fi

/usr/bin/sips -z 16 16 "$app_icon_source" --out "$app_iconset_directory/icon_16x16.png" >/dev/null
/usr/bin/sips -z 32 32 "$app_icon_source" --out "$app_iconset_directory/icon_16x16@2x.png" >/dev/null
/usr/bin/sips -z 32 32 "$app_icon_source" --out "$app_iconset_directory/icon_32x32.png" >/dev/null
/usr/bin/sips -z 64 64 "$app_icon_source" --out "$app_iconset_directory/icon_32x32@2x.png" >/dev/null
/usr/bin/sips -z 128 128 "$app_icon_source" --out "$app_iconset_directory/icon_128x128.png" >/dev/null
/usr/bin/sips -z 256 256 "$app_icon_source" --out "$app_iconset_directory/icon_128x128@2x.png" >/dev/null
/usr/bin/sips -z 256 256 "$app_icon_source" --out "$app_iconset_directory/icon_256x256.png" >/dev/null
/usr/bin/sips -z 512 512 "$app_icon_source" --out "$app_iconset_directory/icon_256x256@2x.png" >/dev/null
/usr/bin/sips -z 512 512 "$app_icon_source" --out "$app_iconset_directory/icon_512x512.png" >/dev/null
cp "$app_icon_source" "$app_iconset_directory/icon_512x512@2x.png"
/usr/bin/iconutil -c icns "$app_iconset_directory" -o "$resources_directory/AppIcon.icns"
rm -rf "$app_iconset_directory"

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
