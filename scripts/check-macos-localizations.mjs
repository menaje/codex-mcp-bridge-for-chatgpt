import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { decodeUtf8Strict, parseJsonUtf8Strict } from "./text-integrity.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(
  repositoryRoot,
  "macos/Resources/Localization/Localizable.xcstrings"
);
const sourceCatalogPath = path.join(repositoryRoot, "locales/catalog.json");
const swiftSourcesPath = path.join(
  repositoryRoot,
  "macos/Sources/CodexBridgeMenuBar"
);
const infoPlistPath = path.join(repositoryRoot, "macos/Info.plist");
const errors = [];
const semanticKeyPattern = /^(?:[a-z][A-Za-z0-9-]*)(?:\.[a-z][A-Za-z0-9-]*)+$/;

function readJson(filePath) {
  return parseJsonUtf8Strict(
    fs.readFileSync(filePath),
    `JSON file ${path.relative(repositoryRoot, filePath)}`
  );
}

function simpleQuotedStrings(source) {
  return [...source.matchAll(/"([^"\\\r\n]*)"/g)].map((match) => match[1]);
}

function placeholderSignature(value) {
  return [...value.matchAll(/%(?:(\d+)\$)?(?:ll|l)?([@diuoxXfFeEgGaAcCsSp])/g)]
    .map((match, index) => `${match[1] || String(index + 1)}:${match[2]}`)
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

function nativeCatalogStrings(sourceCatalog) {
  const locales = Array.isArray(sourceCatalog.locales) ? sourceCatalog.locales : [];
  const shared = Object.fromEntries(
    Object.keys(sourceCatalog.ui?.translations?.[sourceCatalog.defaultLocale] || {}).map((key) => [
      key,
      {
        localizations: Object.fromEntries(locales.map(({ id }) => [id, {
          stringUnit: {
            state: "translated",
            value: sourceCatalog.ui.translations[id][key]
          }
        }]))
      }
    ])
  );
  return { ...shared, ...(sourceCatalog.macos?.strings || {}) };
}

const sourceCatalog = readJson(sourceCatalogPath);
const expectedNativeStrings = nativeCatalogStrings(sourceCatalog);
const expectedLocales = Array.isArray(sourceCatalog.locales)
  ? sourceCatalog.locales.map((entry) => entry?.id).filter((entry) => typeof entry === "string")
  : [];
const sourceLanguage = sourceCatalog.macos?.sourceLanguage;
const translatedLocales = expectedLocales.filter((locale) => locale !== sourceLanguage);
if (!expectedLocales.length || new Set(expectedLocales).size !== expectedLocales.length) {
  errors.push("locales/catalog.json must define unique supported locale identifiers.");
}
if (sourceCatalog.defaultLocale !== "en") {
  errors.push(`locales/catalog.json defaultLocale must be en, found ${sourceCatalog.defaultLocale ?? "missing"}.`);
}
if (sourceLanguage !== "ko") {
  errors.push(`locales/catalog.json macOS source language must be ko, found ${sourceLanguage ?? "missing"}.`);
}

const catalog = readJson(catalogPath);
if (catalog.sourceLanguage !== sourceLanguage) {
  errors.push(
    `Localizable.xcstrings sourceLanguage differs from locales/catalog.json: ${catalog.sourceLanguage ?? "missing"}.`
  );
}
const actualKeys = Object.keys(catalog.strings ?? {}).sort();
const expectedKeys = Object.keys(expectedNativeStrings).sort();
if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
  errors.push("Localizable.xcstrings keys differ from the generated union of shared UI and native-only catalog keys.");
}

const infoPlistSource = decodeUtf8Strict(
  fs.readFileSync(infoPlistPath),
  "macOS Info.plist"
);
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
  if (!semanticKeyPattern.test(key)) {
    errors.push(`Native localization key is not semantic: ${JSON.stringify(key)}.`);
  }
  const sourceUnit = entry.localizations?.[sourceLanguage]?.stringUnit;
  if (!sourceUnit || sourceUnit.state !== "translated" ||
    typeof sourceUnit.value !== "string" || !sourceUnit.value.trim()) {
    errors.push(`The source-language value is missing for ${JSON.stringify(key)}.`);
  }
  const sourceSignature = placeholderSignature(sourceUnit?.value || "");
  const expectedEntry = expectedNativeStrings[key];
  if (!expectedEntry) {
    errors.push(`Generated native catalog has an unexpected key: ${JSON.stringify(key)}.`);
  }
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
    const expectedValue = expectedEntry?.localizations?.[locale]?.stringUnit?.value;
    if (typeof expectedValue !== "string" || unit.value !== expectedValue) {
      errors.push(`${locale} differs from locales/catalog.json for ${JSON.stringify(key)}.`);
    }
  }
  const expectedSource = expectedEntry?.localizations?.[sourceLanguage]?.stringUnit?.value;
  if (typeof expectedSource !== "string" || sourceUnit?.value !== expectedSource) {
    errors.push(`${sourceLanguage} differs from locales/catalog.json for ${JSON.stringify(key)}.`);
  }
}

const compiledDirectoryFlag = process.argv.indexOf("--compiled-directory");
if (compiledDirectoryFlag >= 0) {
  const compiledDirectoryArgument = process.argv[compiledDirectoryFlag + 1];
  if (!compiledDirectoryArgument) {
    errors.push("--compiled-directory requires a path.");
  } else {
    const compiledDirectory = path.resolve(compiledDirectoryArgument);
    for (const locale of expectedLocales) {
      const localizationFile = path.join(compiledDirectory, `${locale}.lproj`, "Localizable.strings");
      if (!fs.existsSync(localizationFile)) {
        errors.push(`Compiled localization is missing ${locale}.lproj/Localizable.strings.`);
        continue;
      }
      let compiled;
      try {
        compiled = parseJsonUtf8Strict(execFileSync(
          "plutil",
          ["-convert", "json", "-o", "-", localizationFile],
          { encoding: "buffer" }
        ), `compiled ${locale} localization`);
      } catch (error) {
        errors.push(`Could not read compiled ${locale} localization: ${String(error)}.`);
        continue;
      }
      for (const key of Object.keys(catalog.strings ?? {})) {
        if (typeof compiled[key] !== "string" || !compiled[key].trim()) {
          errors.push(`Compiled ${locale} localization is missing ${JSON.stringify(key)}.`);
          continue;
        }
        const expectedValue = expectedNativeStrings[key]?.localizations?.[locale]?.stringUnit?.value;
        if (typeof expectedValue !== "string" || compiled[key] !== expectedValue) {
          errors.push(`Compiled ${locale} localization differs from locales/catalog.json for ${JSON.stringify(key)}.`);
        }
      }
    }
  }
}

const helperPattern = /BridgeAppLocalization\.(?:string|format)\(\s*"((?:\\.|[^"\\])*)"/gs;
const allowedUncataloguedKoreanLiterals = new Set([
  " 이전 helper 복구에도 실패했습니다: ",
  "[가-힣]",
  "백엔드 라우팅:",
  "한국어"
]);
for (const swiftFile of walkSwiftFiles(swiftSourcesPath)) {
  const source = decodeUtf8Strict(
    fs.readFileSync(swiftFile),
    `Swift source ${path.relative(repositoryRoot, swiftFile)}`
  );
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
  for (const key of new Set(simpleQuotedStrings(source))) {
    if (
      /[가-힣]/.test(key) &&
      !catalog.strings[key] &&
      !allowedUncataloguedKoreanLiterals.has(key)
    ) {
      errors.push(
        `${path.relative(repositoryRoot, swiftFile)} contains an uncatalogued Korean UI string: ` +
          `${JSON.stringify(key)}.`
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
