#!/bin/bash
set -euo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
output_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "--output requires a DMG path." >&2
        exit 1
      fi
      output_file="$2"
      shift 2
      ;;
    *)
      echo "Usage: package-release.sh --output <dmg>" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$output_file" ]]; then
  echo "Usage: package-release.sh --output <dmg>" >&2
  exit 1
fi

cd "$repository_root"
version="$(node -p "require('./release-manifest.json').release.version")"
expected_architecture="$(node -p "require('./release-manifest.json').release.targets.macos.architecture")"
minimum_version="$(node -p "require('./release-manifest.json').release.targets.macos.minimumVersion")"
expected_filename="$(node --input-type=module -e 'import { deriveReleaseMetadata, loadReleaseManifest } from "./scripts/release-manifest.mjs"; process.stdout.write(deriveReleaseMetadata(loadReleaseManifest()).macosArchiveFilename)')"
requested_output_directory="$(dirname "$output_file")"
mkdir -p "$requested_output_directory"
output_file="$(cd "$requested_output_directory" && pwd)/$(basename "$output_file")"

if [[ "$(basename "$output_file")" != "$expected_filename" ]]; then
  echo "macOS release image must be named $expected_filename." >&2
  exit 1
fi

CODE_SIGN_IDENTITY="-"
export CODE_SIGN_IDENTITY
export MACOS_EXPECTED_ARCHITECTURE="$expected_architecture"
"$script_directory/build-app.sh" >/dev/null

app_bundle="$script_directory/build/Codex MCP Bridge for ChatGPT.app"
actual_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_bundle/Contents/Info.plist")"
actual_minimum="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$app_bundle/Contents/Info.plist")"
actual_architectures="$(lipo -archs "$app_bundle/Contents/MacOS/CodexBridgeMenuBar")"
if [[ "$actual_version" != "$version" ]]; then
  echo "App version $actual_version does not match release version $version." >&2
  exit 1
fi
if [[ "$actual_minimum" != "$minimum_version" ]]; then
  echo "App minimum macOS $actual_minimum does not match manifest $minimum_version." >&2
  exit 1
fi
if [[ "$actual_architectures" != "$expected_architecture" ]]; then
  echo "App architecture $actual_architectures does not match manifest $expected_architecture." >&2
  exit 1
fi
codesign --verify --deep --strict "$app_bundle"
app_signature="$(codesign --display --verbose=4 "$app_bundle" 2>&1)"
if ! grep -q '^Signature=adhoc$' <<< "$app_signature"; then
  echo "macOS release app must use an ad-hoc signature." >&2
  exit 1
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/codex-mcp-bridge-dmg.XXXXXX")"
cleanup() {
  rm -rf "$temporary_directory"
}
trap cleanup EXIT
staging_directory="$temporary_directory/staging"
mkdir -p "$staging_directory"
ditto "$app_bundle" "$staging_directory/Codex MCP Bridge for ChatGPT.app"
ln -s /Applications "$staging_directory/Applications"

mkdir -p "$(dirname "$output_file")"
rm -f "$output_file"
hdiutil create \
  -volname "Codex MCP Bridge for ChatGPT" \
  -srcfolder "$staging_directory" \
  -format UDZO \
  -ov \
  "$output_file" >/dev/null

codesign --force --sign - "$output_file"
codesign --verify --strict "$output_file"
dmg_signature="$(codesign --display --verbose=4 "$output_file" 2>&1)"
if ! grep -q '^Signature=adhoc$' <<< "$dmg_signature"; then
  echo "macOS release image must use an ad-hoc signature." >&2
  exit 1
fi

echo "$output_file"
