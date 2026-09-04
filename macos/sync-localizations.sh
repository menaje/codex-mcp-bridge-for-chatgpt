#!/bin/bash
set -euo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
localization_sync_directory="$(mktemp -d /tmp/codex-bridge-localization-sync.XXXXXX)"
catalog="$script_directory/Resources/Localization/Localizable.xcstrings"

cleanup() {
  rm -rf "$localization_sync_directory"
}
trap cleanup EXIT

cd "$repository_root"
swift build --package-path "$script_directory" --target CodexBridgeMenuBar \
  -Xswiftc -emit-localized-strings \
  -Xswiftc -emit-localized-strings-path \
  -Xswiftc "$localization_sync_directory"

stringsdata_files=("$localization_sync_directory"/*.stringsdata)
if [[ ! -e "${stringsdata_files[0]}" ]]; then
  echo "Swift did not emit localization source data." >&2
  exit 1
fi

xcrun xcstringstool sync "$catalog" \
  --stringsdata "${stringsdata_files[@]}" \
  --skip-marking-strings-stale

echo "Updated $catalog from Swift source. Add translations for new entries, then run npm run macos:localizations:check."
