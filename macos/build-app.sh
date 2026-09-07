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
bundle_version="${MACOS_BUNDLE_VERSION:-1}"
target_architecture="${MACOS_TARGET_ARCHITECTURE:-}"

if [[ -z "$target_architecture" && -n "${MACOS_EXPECTED_ARCHITECTURE:-}" ]]; then
  case "$MACOS_EXPECTED_ARCHITECTURE" in
    arm64) target_architecture="arm64" ;;
    x64|x86_64) target_architecture="x64" ;;
    *)
      echo "Unsupported MACOS_EXPECTED_ARCHITECTURE: $MACOS_EXPECTED_ARCHITECTURE" >&2
      exit 1
      ;;
  esac
fi

if [[ -z "$target_architecture" ]]; then
  case "$(uname -m)" in
    arm64) target_architecture="arm64" ;;
    x86_64) target_architecture="x64" ;;
    *)
      echo "Unsupported macOS host architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
fi

case "$target_architecture" in
  arm64)
    swift_architecture="arm64"
    node_architecture="arm64"
    ;;
  x64)
    swift_architecture="x86_64"
    node_architecture="x64"
    ;;
  *)
    echo "MACOS_TARGET_ARCHITECTURE must be arm64 or x64." >&2
    exit 1
    ;;
esac

if [[ "$(uname -m)" != "$swift_architecture" ]]; then
  echo "macOS release apps must be built natively: requested $target_architecture, host $(uname -m)." >&2
  exit 1
fi

actual_node_architecture="$(node -p 'process.arch')"
if [[ "$actual_node_architecture" != "$node_architecture" ]]; then
  echo "Node.js architecture $actual_node_architecture does not match requested macOS target $target_architecture." >&2
  exit 1
fi

if [[ "${CODE_SIGN_IDENTITY:--}" != "-" ]]; then
  echo "This project supports ad-hoc macOS signing only." >&2
  exit 1
fi

if [[ ! "$bundle_version" =~ ^[1-9][0-9]*$ ]]; then
  echo "MACOS_BUNDLE_VERSION must be a positive integer." >&2
  exit 1
fi

cd "$repository_root"
npm run build
npm run macos:localizations:check
swift test --package-path "$script_directory" --arch "$swift_architecture" \
  --disable-swift-testing \
  -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
swift build --package-path "$script_directory" -c release --arch "$swift_architecture" \
  --product CodexBridgeMenuBar \
  -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
swift_binary_directory="$(swift build --package-path "$script_directory" -c release \
  --arch "$swift_architecture" --show-bin-path)"

rm -rf "$app_bundle"
rm -rf "$app_iconset_directory"
mkdir -p "$contents_directory/MacOS" "$runtime_directory/scripts" "$app_iconset_directory"
cp "$swift_binary_directory/CodexBridgeMenuBar" "$contents_directory/MacOS/CodexBridgeMenuBar"
cp "$script_directory/Info.plist" "$contents_directory/Info.plist"
xcrun xcstringstool compile \
  "$script_directory/Resources/Localization/Localizable.xcstrings" \
  --output-directory "$resources_directory" \
  --serialization-format text

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
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $bundle_version" "$contents_directory/Info.plist"

(
  cd "$runtime_directory"
  npm ci --omit=dev --no-audit --no-fund
)

app_architectures="$(lipo -archs "$contents_directory/MacOS/CodexBridgeMenuBar")"
if [[ "$app_architectures" != "$swift_architecture" ]]; then
  echo "Expected one $swift_architecture app binary; built: $app_architectures" >&2
  exit 1
fi

sqlite_prebuild="$runtime_directory/node_modules/better-sqlite3/prebuilds/darwin-$node_architecture.node"
if [[ ! -f "$sqlite_prebuild" ]]; then
  echo "Missing better-sqlite3 prebuild for macOS $target_architecture: $sqlite_prebuild" >&2
  exit 1
fi
sqlite_architectures="$(lipo -archs "$sqlite_prebuild")"
if [[ "$sqlite_architectures" != "$swift_architecture" ]]; then
  echo "Expected better-sqlite3 $swift_architecture prebuild; found: $sqlite_architectures" >&2
  exit 1
fi
(
  cd "$runtime_directory"
  node --input-type=commonjs -e '
    const Database = require("better-sqlite3");
    const database = new Database(":memory:");
    try {
      const result = database.prepare("SELECT 1 AS loaded").get();
      if (result.loaded !== 1) throw new Error("unexpected SQLite result");
    } finally {
      database.close();
    }
  '
)

codesign --force --deep --sign - "$app_bundle"
codesign --verify --deep --strict "$app_bundle"
echo "$app_bundle"
