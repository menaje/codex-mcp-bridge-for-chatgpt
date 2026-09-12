#!/bin/bash
set -euo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
candidate_file=""
output_file=""
target_architecture=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --candidate)
      candidate_file="${2:-}"
      shift 2
      ;;
    --output)
      output_file="${2:-}"
      shift 2
      ;;
    --architecture)
      target_architecture="${2:-}"
      shift 2
      ;;
    *)
      echo "Usage: promote-release.sh --candidate <dmg> --architecture <arm64|x64> --output <dmg>" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$candidate_file" || -z "$output_file" || -z "$target_architecture" ]]; then
  echo "Usage: promote-release.sh --candidate <dmg> --architecture <arm64|x64> --output <dmg>" >&2
  exit 1
fi

case "$target_architecture" in
  arm64) expected_mach_architecture="arm64" ;;
  x64) expected_mach_architecture="x86_64" ;;
  *)
    echo "--architecture requires arm64 or x64." >&2
    exit 1
    ;;
esac

cd "$repository_root"
candidate_file="$(cd "$(dirname "$candidate_file")" && pwd)/$(basename "$candidate_file")"
requested_output_directory="$(dirname "$output_file")"
mkdir -p "$requested_output_directory"
output_file="$(cd "$requested_output_directory" && pwd)/$(basename "$output_file")"

IFS=$'\t' read -r stable_version source_candidate expected_output_filename expected_candidate_filename minimum_version < <(node --input-type=module - "$target_architecture" <<'NODE'
import { deriveReleaseMetadata, loadReleaseManifest } from "./scripts/release-manifest.mjs";
const architecture = process.argv[2];
const manifest = loadReleaseManifest();
const metadata = deriveReleaseMetadata(manifest);
if (manifest.release.stage !== "stable" || !manifest.release.sourceCandidate) {
  throw new Error("macOS candidate promotion requires a source-RC-backed stable release state.");
}
const output = metadata.macosArchiveFilenames[architecture];
const candidate = metadata.sourceCandidateMacosArchiveFilenames[architecture];
if (!output || !candidate) throw new Error(`Unsupported manifest macOS architecture: ${architecture}`);
console.log([
  manifest.release.version,
  manifest.release.sourceCandidate,
  output,
  candidate,
  manifest.release.targets.macos.minimumVersion
].join("\t"));
NODE
)

if [[ "$(basename "$candidate_file")" != "$expected_candidate_filename" ]]; then
  echo "Source candidate image must be named $expected_candidate_filename." >&2
  exit 1
fi
if [[ "$(basename "$output_file")" != "$expected_output_filename" ]]; then
  echo "Stable macOS image must be named $expected_output_filename." >&2
  exit 1
fi
if [[ ! -f "$candidate_file" ]]; then
  echo "Source candidate image does not exist: $candidate_file" >&2
  exit 1
fi

bundle_version="${MACOS_BUNDLE_VERSION:-1}"
if [[ ! "$bundle_version" =~ ^[1-9][0-9]*$ ]]; then
  echo "MACOS_BUNDLE_VERSION must be a positive integer." >&2
  exit 1
fi

npm run build

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/codex-mcp-bridge-promote.XXXXXX")"
mount_root="$temporary_directory/mount"
staging_directory="$temporary_directory/staging"
mounted="false"
cleanup() {
  if [[ "$mounted" == "true" ]]; then
    hdiutil detach "$mount_root" >/dev/null || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT
mkdir -p "$mount_root" "$staging_directory"

codesign --verify --strict "$candidate_file"
hdiutil attach -nobrowse -readonly -mountpoint "$mount_root" "$candidate_file" >/dev/null
mounted="true"
app_count="$(find "$mount_root" -maxdepth 1 -type d -name '*.app' | wc -l | tr -d ' ')"
if [[ "$app_count" != "1" ]]; then
  echo "Source candidate DMG must contain exactly one app bundle." >&2
  exit 1
fi
candidate_app="$(find "$mount_root" -maxdepth 1 -type d -name '*.app' -print -quit)"
codesign --verify --deep --strict "$candidate_app"

candidate_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$candidate_app/Contents/Info.plist")"
candidate_minimum="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$candidate_app/Contents/Info.plist")"
candidate_architectures="$(lipo -archs "$candidate_app/Contents/MacOS/CodexBridgeMenuBar")"
if [[ "$candidate_version" != "$source_candidate" ]]; then
  echo "Source app version $candidate_version does not match $source_candidate." >&2
  exit 1
fi
if [[ "$candidate_minimum" != "$minimum_version" ]]; then
  echo "Source app minimum macOS $candidate_minimum does not match manifest $minimum_version." >&2
  exit 1
fi
if [[ "$candidate_architectures" != "$expected_mach_architecture" ]]; then
  echo "Source app architecture $candidate_architectures does not match $target_architecture." >&2
  exit 1
fi

candidate_runtime="$candidate_app/Contents/Resources/Runtime"
node - "$candidate_runtime" "$source_candidate" <<'NODE'
const fs = require("node:fs"), path = require("node:path");
const root = process.argv[2], expected = process.argv[3];
const manifest = JSON.parse(fs.readFileSync(path.join(root, "release-manifest.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.release?.stage !== "candidate" || manifest.release?.version !== expected || packageJson.version !== expected) {
  throw new Error("Source app runtime metadata does not match the named release candidate.");
}
NODE

app_bundle="$staging_directory/Codex MCP Bridge for ChatGPT.app"
ditto "$candidate_app" "$app_bundle"
hdiutil detach "$mount_root" >/dev/null
mounted="false"

runtime_directory="$app_bundle/Contents/Resources/Runtime"
cp "$repository_root/package.json" "$repository_root/package-lock.json" "$runtime_directory/"
cp "$repository_root/release-manifest.json" "$runtime_directory/"
cp "$repository_root/dist/build-info.json" "$runtime_directory/dist/build-info.json"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $stable_version" "$app_bundle/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $bundle_version" "$app_bundle/Contents/Info.plist"

codesign --force --deep --sign - "$app_bundle"
codesign --verify --deep --strict "$app_bundle"
ln -s /Applications "$staging_directory/Applications"

rm -f "$output_file"
hdiutil create \
  -volname "Codex MCP Bridge for ChatGPT" \
  -srcfolder "$staging_directory" \
  -format UDZO \
  -ov \
  "$output_file" >/dev/null
codesign --force --sign - "$output_file"
codesign --verify --strict "$output_file"

actual_signature="$(codesign --display --verbose=4 "$output_file" 2>&1)"
if ! grep -q '^Signature=adhoc$' <<< "$actual_signature"; then
  echo "Stable macOS image must use an ad-hoc signature." >&2
  exit 1
fi

echo "$output_file"
