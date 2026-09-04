#!/bin/bash
set -euo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
localization_check_directory="$(mktemp -d /tmp/codex-bridge-localization-check.XXXXXX)"
extracted_catalog="$localization_check_directory/Localizable.xcstrings"
compiled_directory="$localization_check_directory/compiled"

cleanup() {
  rm -rf "$localization_check_directory"
}
trap cleanup EXIT

cd "$repository_root"
swift build --package-path "$script_directory" --target CodexBridgeMenuBar \
  -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors \
  -Xswiftc -emit-localized-strings \
  -Xswiftc -emit-localized-strings-path \
  -Xswiftc "$localization_check_directory"

stringsdata_files=("$localization_check_directory"/*.stringsdata)
if [[ ! -e "${stringsdata_files[0]}" ]]; then
  echo "Swift did not emit localization source data." >&2
  exit 1
fi

cp "$script_directory/Resources/Localization/Localizable.xcstrings" "$extracted_catalog"
xcrun xcstringstool sync "$extracted_catalog" \
  --stringsdata "${stringsdata_files[@]}" \
  --skip-marking-strings-stale

node scripts/check-macos-localizations.mjs \
  --extracted-catalog "$extracted_catalog"

mkdir -p "$compiled_directory"
xcrun xcstringstool compile \
  "$script_directory/Resources/Localization/Localizable.xcstrings" \
  --output-directory "$compiled_directory" \
  --serialization-format text

for locale in en ko ja zh-Hans zh-Hant es fr de pt; do
  localization_file="$compiled_directory/$locale.lproj/Localizable.strings"
  if [[ ! -f "$localization_file" ]]; then
    echo "Compiled localization is missing $locale.lproj/Localizable.strings." >&2
    exit 1
  fi
  plutil -lint "$localization_file" >/dev/null
done
