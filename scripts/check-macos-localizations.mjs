import fs from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(
  repositoryRoot,
  "macos/Resources/Localization/Localizable.xcstrings"
);
const swiftLocalizationPath = path.join(
  repositoryRoot,
  "macos/Sources/CodexBridgeMenuBar/AppLocalization.swift"
);
const swiftSourcesPath = path.join(
  repositoryRoot,
  "macos/Sources/CodexBridgeMenuBar"
);
const typescriptLocalizationPath = path.join(repositoryRoot, "src/uiI18n.ts");
const infoPlistPath = path.join(repositoryRoot, "macos/Info.plist");
const expectedLocales = ["en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"];
const translatedLocales = expectedLocales.filter((locale) => locale !== "ko");
const errors = [];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function quotedStrings(source) {
  return [...source.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((match) =>
    JSON.parse(`"${match[1]}"`)
  );
}

function arrayAfter(source, marker, terminator) {
  const start = source.indexOf(marker);
  if (start < 0) return [];
  const end = source.indexOf(terminator, start + marker.length);
  if (end < 0) return [];
  return quotedStrings(source.slice(start + marker.length, end));
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function placeholderSignature(value) {
  const matches = value.match(/%(?:\d+\$)?(?:ll|l)?[@diuoxXfFeEgGaAcCsSp]/g) ?? [];
  return matches
    .map((placeholder) => placeholder.replace(/^%\d+\$/, "%"))
    .sort()
    .join(",");
}

function walkSwiftFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkSwiftFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".swift")) files.push(entryPath);
  }
  return files;
}

const catalog = readJson(catalogPath);
if (catalog.sourceLanguage !== "ko") {
  errors.push(`Localizable.xcstrings sourceLanguage must be ko, found ${catalog.sourceLanguage ?? "missing"}.`);
}

const typescriptSource = fs.readFileSync(typescriptLocalizationPath, "utf8");
const typescriptLocales = arrayAfter(
  typescriptSource,
  "export const SUPPORTED_UI_LOCALES = [",
  "] as const;"
);
if (!sameValues(typescriptLocales, expectedLocales)) {
  errors.push(`src/uiI18n.ts locale order differs: ${typescriptLocales.join(", ")}.`);
}

const swiftLocalizationSource = fs.readFileSync(swiftLocalizationPath, "utf8");
const swiftLocales = arrayAfter(
  swiftLocalizationSource,
  "static let supportedLanguageCodes = [",
  "]"
);
if (!sameValues(swiftLocales, expectedLocales)) {
  errors.push(`AppLocalization.swift locale order differs: ${swiftLocales.join(", ")}.`);
}

const infoPlistSource = fs.readFileSync(infoPlistPath, "utf8");
const plistLocaleMatch = infoPlistSource.match(
  /<key>CFBundleLocalizations<\/key>\s*<array>([\s\S]*?)<\/array>/
);
const plistLocales = plistLocaleMatch
  ? [...plistLocaleMatch[1].matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1])
  : [];
if (
  plistLocales.length !== expectedLocales.length ||
  !expectedLocales.every((locale) => plistLocales.includes(locale))
) {
  errors.push(`Info.plist localizations differ: ${plistLocales.join(", ")}.`);
}
if (!/<key>CFBundleDevelopmentRegion<\/key>\s*<string>en<\/string>/.test(infoPlistSource)) {
  errors.push("Info.plist CFBundleDevelopmentRegion must be en.");
}

for (const [key, entry] of Object.entries(catalog.strings ?? {})) {
  const sourceSignature = placeholderSignature(key);
  for (const locale of translatedLocales) {
    const unit = entry.localizations?.[locale]?.stringUnit;
    if (!unit || unit.state !== "translated" || typeof unit.value !== "string" || !unit.value.trim()) {
      errors.push(`${locale} is missing a completed translation for ${JSON.stringify(key)}.`);
      continue;
    }
    if (/[가-힣]/.test(unit.value)) {
      errors.push(`${locale} still contains Korean text for ${JSON.stringify(key)}.`);
    }
    const translatedSignature = placeholderSignature(unit.value);
    if (translatedSignature !== sourceSignature) {
      errors.push(
        `${locale} placeholder mismatch for ${JSON.stringify(key)}: ` +
          `${sourceSignature || "none"} != ${translatedSignature || "none"}.`
      );
    }
  }
}

const helperPattern = /BridgeAppLocalization\.(?:string|format)\(\s*"((?:\\.|[^"\\])*)"/gs;
for (const swiftFile of walkSwiftFiles(swiftSourcesPath)) {
  const source = fs.readFileSync(swiftFile, "utf8");
  for (const match of source.matchAll(helperPattern)) {
    let key;
    try {
      key = JSON.parse(`"${match[1]}"`);
    } catch {
      errors.push(`Could not parse localization key in ${path.relative(repositoryRoot, swiftFile)}.`);
      continue;
    }
    if (!catalog.strings[key]) {
      errors.push(
        `${path.relative(repositoryRoot, swiftFile)} references a missing localization key: ${JSON.stringify(key)}.`
      );
    }
  }
}

const extractedCatalogFlag = process.argv.indexOf("--extracted-catalog");
if (extractedCatalogFlag >= 0) {
  const extractedCatalogArgument = process.argv[extractedCatalogFlag + 1];
  if (!extractedCatalogArgument) {
    errors.push("--extracted-catalog requires a path.");
  } else {
    const extractedCatalog = readJson(path.resolve(extractedCatalogArgument));
    const missingSourceKeys = Object.keys(extractedCatalog.strings ?? {}).filter(
      (key) => key.length > 0 && !catalog.strings[key]
    );
    for (const key of missingSourceKeys) {
      errors.push(`Swift source contains an uncatalogued localized string: ${JSON.stringify(key)}.`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  console.error(`macOS localization validation failed with ${errors.length} error(s).`);
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${Object.keys(catalog.strings).length} macOS strings across ${expectedLocales.length} languages.`
  );
}
