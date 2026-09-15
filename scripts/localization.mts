#!/usr/bin/env node
/**
 * Single-source localization generator.
 *
 * `locales/catalog.json` is the only authored translation catalog.  Runtime
 * TypeScript data and the native String Catalog are checked-in derived files so
 * a packaged bridge never tries to load a source JSON file at runtime.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeUtf8Strict, parseJsonUtf8Strict } from "./text-integrity.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(repositoryRoot, "locales", "catalog.json");
const generatedTypeScriptPath = path.join(repositoryRoot, "src", "generated", "localization.ts");
const generatedSwiftPath = path.join(
  repositoryRoot,
  "macos",
  "Sources",
  "CodexBridgeMenuBar",
  "GeneratedLocalization.swift"
);
const generatedXcstringsPath = path.join(
  repositoryRoot,
  "macos",
  "Resources",
  "Localization",
  "Localizable.xcstrings"
);

type Catalog = {
  schemaVersion: number;
  defaultLocale: string;
  locales: Array<{ id: string; label: string }>;
  localeResolution: {
    traditionalChineseRegions: string[];
    traditionalChineseTags: string[];
  };
  ui: {
    translations: Record<string, Record<string, string>>;
    /** Named placeholders have a JSON transport type, not a printf position. */
    parameters: Record<string, Record<string, "string-or-number">>;
  };
  macos: {
    version: string;
    sourceLanguage: string;
    strings: Record<string, {
      localizations?: Record<string, { stringUnit?: { state?: string; value?: string } }>;
    }>;
  };
};

type NativeStringEntry = Catalog["macos"]["strings"][string];
const SEMANTIC_KEY_PATTERN = /^(?:[a-z][A-Za-z0-9-]*)(?:\.[a-z][A-Za-z0-9-]*)+$/;
const LEGACY_NATIVE_KEY_PATTERN = /(?:^|\.)message\d*(?:\.|$)|(?:^|\.)variant\d+(?:\.|$)/;

function readCatalog(): Catalog {
  let parsed: unknown;
  try {
    parsed = parseJsonUtf8Strict(readFileSync(catalogPath), "Localization catalog");
  } catch (error) {
    throw new Error(`Could not read ${relative(catalogPath)}: ${errorMessage(error)}`);
  }
  validateCatalog(parsed);
  return parsed as Catalog;
}

function validateCatalog(value: unknown): asserts value is Catalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.defaultLocale !== "string" ||
    !Array.isArray(value.locales) || !isRecord(value.localeResolution) || !isRecord(value.ui) ||
    !isRecord(value.ui.translations) || !isRecord(value.ui.parameters) ||
    !isRecord(value.macos) || !isRecord(value.macos.strings)) {
    throw new Error("Localization catalog has an invalid top-level structure.");
  }
  const localeIds = value.locales.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.label !== "string" ||
      !entry.id || !entry.label) {
      throw new Error("Localization catalog locale metadata is invalid.");
    }
    return entry.id;
  });
  if (new Set(localeIds).size !== localeIds.length || !localeIds.includes(value.defaultLocale)) {
    throw new Error("Localization catalog locales must be unique and include its default locale.");
  }
  if (!Array.isArray(value.localeResolution.traditionalChineseRegions) ||
    !Array.isArray(value.localeResolution.traditionalChineseTags) ||
    !value.localeResolution.traditionalChineseRegions.every((entry) => typeof entry === "string") ||
    !value.localeResolution.traditionalChineseTags.every((entry) => typeof entry === "string")) {
    throw new Error("Localization catalog locale-resolution metadata is invalid.");
  }

  const translations = value.ui.translations;
  if (!sameSet(Object.keys(translations), localeIds)) {
    throw new Error("UI translations must define exactly every supported locale.");
  }
  const base = translations[value.defaultLocale];
  if (!isRecord(base) || Object.keys(base).length === 0) {
    throw new Error("The default UI locale must contain translations.");
  }
  const baseKeys = Object.keys(base).sort();
  for (const locale of localeIds) {
    const bundle = translations[locale];
    if (!isRecord(bundle) || !sameValues(Object.keys(bundle).sort(), baseKeys)) {
      throw new Error(`UI translation keys for ${locale} differ from ${value.defaultLocale}.`);
    }
    for (const key of baseKeys) {
      const message = bundle[key];
      if (typeof message !== "string" || !message) {
        throw new Error(`UI translation ${locale}.${key} is missing.`);
      }
      if (!sameValues(placeholderSignature(message), placeholderSignature(base[key] as string))) {
        throw new Error(`UI translation placeholder mismatch at ${locale}.${key}.`);
      }
    }
  }
  for (const [key, parameters] of Object.entries(value.ui.parameters)) {
    if (!baseKeys.includes(key) || !isRecord(parameters)) {
      throw new Error(`UI parameter declaration ${JSON.stringify(key)} is invalid.`);
    }
    const expected = placeholderSignature(base[key] as string);
    if (!sameValues(Object.keys(parameters).sort(), [...new Set(expected)].sort())) {
      throw new Error(`UI parameter declaration differs from placeholders at ${key}.`);
    }
    for (const [name, type] of Object.entries(parameters)) {
      if (type !== "string-or-number") {
        throw new Error(`UI parameter ${key}.${name} has an unsupported transport type.`);
      }
    }
  }
  for (const key of baseKeys) {
    const expected = placeholderSignature(base[key] as string);
    if (expected.length > 0 && !Object.hasOwn(value.ui.parameters, key)) {
      throw new Error(`UI parameter declaration is missing for ${key}.`);
    }
  }

  const macos = value.macos;
  if (macos.sourceLanguage !== "ko" || typeof macos.version !== "string") {
    throw new Error("Native localization metadata is invalid.");
  }
  for (const [key, entry] of Object.entries(macos.strings)) {
    if (!SEMANTIC_KEY_PATTERN.test(key) || !isRecord(entry) || !isRecord(entry.localizations)) {
      throw new Error(`Native localization entry ${JSON.stringify(key)} is invalid.`);
    }
    if (LEGACY_NATIVE_KEY_PATTERN.test(key)) {
      throw new Error(`Native localization entry ${JSON.stringify(key)} uses a legacy generated key name.`);
    }
    if (Object.hasOwn(translations[value.defaultLocale], key)) {
      throw new Error(`Native key ${JSON.stringify(key)} duplicates a shared UI key; keep its translation only in ui.translations.`);
    }
    const source = stringUnitValue(entry.localizations[macos.sourceLanguage]);
    if (!source) {
      throw new Error(`Native source-language translation is missing for ${JSON.stringify(key)}.`);
    }
    const sourceSignature = printfSignature(source);
    for (const locale of localeIds) {
      const translated = stringUnitValue(entry.localizations[locale]);
      if (locale === macos.sourceLanguage && !translated) continue;
      if (!translated) throw new Error(`Native ${locale} translation is missing for ${JSON.stringify(key)}.`);
      if (!sameValues(printfSignature(translated), sourceSignature)) {
        throw new Error(`Native placeholder mismatch at ${locale}.${JSON.stringify(key)}.`);
      }
    }
  }

  // The generated native catalog is the union of shared UI keys and native-only
  // keys. It makes a server-provided semantic UI key displayable by macOS too.
  for (const [key, entry] of Object.entries(nativeCatalogStrings(value as Catalog))) {
    const source = stringUnitValue(entry.localizations?.[macos.sourceLanguage]);
    if (!source) throw new Error(`Generated native source translation is missing for ${JSON.stringify(key)}.`);
  }
}

/**
 * Build the native String Catalog source from the two authored domains. Shared
 * UI messages retain their existing semantic key; native-only messages live in
 * `macos.*`. This deliberately avoids aliases chosen by English text equality
 * at runtime, which allowed platform translations to diverge.
 */
function nativeCatalogStrings(catalog: Catalog): Record<string, NativeStringEntry> {
  const shared = Object.fromEntries(Object.keys(catalog.ui.translations[catalog.defaultLocale]).map((key) => [
    key,
    {
      localizations: Object.fromEntries(catalog.locales.map(({ id }) => [id, {
        stringUnit: { state: "translated", value: catalog.ui.translations[id]![key]! }
      }]))
    } satisfies NativeStringEntry
  ]));
  return { ...shared, ...catalog.macos.strings };
}

function renderTypeScript(catalog: Catalog): string {
  const localeIds = catalog.locales.map(({ id }) => id);
  const labels = Object.fromEntries(catalog.locales.map(({ id, label }) => [id, label]));
  return `// Generated by scripts/localization.mts from locales/catalog.json. Do not edit.\n` +
    `export const SUPPORTED_UI_LOCALES = ${JSON.stringify(localeIds, null, 2)} as const;\n\n` +
    `export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number];\n` +
    `export const UI_LOCALE_PREFERENCES = ["auto", ...SUPPORTED_UI_LOCALES] as const;\n` +
    `export type UiLocalePreference = (typeof UI_LOCALE_PREFERENCES)[number];\n\n` +
    `export const UI_LANGUAGE_LABELS: Record<SupportedUiLocale, string> = ${JSON.stringify(labels, null, 2)};\n\n` +
    `export const UI_LOCALE_RESOLUTION = ${JSON.stringify(catalog.localeResolution, null, 2)} as const;\n\n` +
    `export const UI_TRANSLATION_PARAMETERS = ${JSON.stringify(catalog.ui.parameters, null, 2)} as const;\n\n` +
    `const translations = ${JSON.stringify(catalog.ui.translations, null, 2)} as const;\n\n` +
    `export type UiTranslationKey = keyof typeof translations.en;\n` +
    `export type UiTranslationBundle = Readonly<Record<UiTranslationKey, string>>;\n` +
    `export const UI_TRANSLATIONS = translations as unknown as Record<SupportedUiLocale, UiTranslationBundle>;\n`;
}

function renderXcstrings(catalog: Catalog): string {
  // Every entry has an explicit source-language value. Semantic identifiers
  // must never be used as display fallback text.
  const strings = Object.fromEntries(Object.entries(nativeCatalogStrings(catalog)).map(([key, entry]) => [
    key,
    {
      ...entry,
      localizations: {
        ...(entry.localizations || {})
      }
    }
  ]));
  return `${JSON.stringify({
    sourceLanguage: catalog.macos.sourceLanguage,
    strings,
    version: catalog.macos.version
  }, null, 2)}\n`;
}

function renderSwift(catalog: Catalog): string {
  const defaultStrings: Record<string, string> = {};
  for (const [key, entry] of Object.entries(nativeCatalogStrings(catalog))) {
    const english = stringUnitValue(entry.localizations?.[catalog.defaultLocale]);
    if (!english) continue;
    defaultStrings[key] = english;
  }
  const localeIds = catalog.locales.map(({ id }) => id);
  return `// Generated by scripts/localization.mts from locales/catalog.json. Do not edit.\n` +
    `import Foundation\n\n` +
    `enum BridgeGeneratedLocalization {\n` +
    `    static let supportedLanguageCodes = [${localeIds.map(swiftLiteral).join(", ")}]\n` +
    `    static let defaultLanguageCode = ${swiftLiteral(catalog.defaultLocale)}\n` +
    `    static let traditionalChineseRegions = [${catalog.localeResolution.traditionalChineseRegions.map(swiftLiteral).join(", ")}]\n` +
    `    static let traditionalChineseTags = [${catalog.localeResolution.traditionalChineseTags.map(swiftLiteral).join(", ")}]\n` +
    `    static let defaultStrings: [String: String] = [\n${swiftDictionary(defaultStrings)}\n    ]\n` +
    `    static let unavailableFallback = ${swiftLiteral("Localized text is unavailable.")}\n` +
    `}\n`;
}

function swiftDictionary(values: Record<string, string>): string {
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `        ${swiftLiteral(key)}: ${swiftLiteral(value)},`).join("\n");
}

function swiftLiteral(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

async function bootstrap(): Promise<void> {
  if (existsSync(catalogPath)) {
    throw new Error(`${relative(catalogPath)} already exists; refusing to overwrite the authored catalog.`);
  }
  // This migration-only import captures the existing final override result,
  // rather than carrying its historical override layering into the new source.
  const legacy = await import("../src/uiI18n.ts");
  const native = parseJsonUtf8Strict(readFileSync(generatedXcstringsPath), "Generated native localization catalog") as {
    version: string;
    sourceLanguage: string;
    strings: Catalog["macos"]["strings"];
  };
  const catalog: Catalog = {
    schemaVersion: 1,
    defaultLocale: "en",
    locales: [
      { id: "en", label: "English" },
      { id: "ko", label: "한국어" },
      { id: "ja", label: "日本語" },
      { id: "zh-Hans", label: "简体中文" },
      { id: "zh-Hant", label: "繁體中文" },
      { id: "es", label: "Español" },
      { id: "fr", label: "Français" },
      { id: "de", label: "Deutsch" },
      { id: "pt", label: "Português" }
    ],
    localeResolution: {
      traditionalChineseRegions: ["tw", "hk", "mo"],
      traditionalChineseTags: ["zh-hant"]
    },
    ui: { translations: legacy.UI_TRANSLATIONS, parameters: parameterDeclarations(legacy.UI_TRANSLATIONS.en) },
    macos: {
      version: native.version,
      sourceLanguage: native.sourceLanguage,
      strings: native.strings
    }
  };
  const migration = migrateLegacyNativeStrings(catalog);
  catalog.macos.strings = migration.strings;
  validateCatalog(catalog);
  mkdirSync(path.dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  rewriteSwiftLocalizationKeys(migration.keys);
  console.log(`Created ${relative(catalogPath)} from the legacy localization sources.`);
}

type NativeKeyMigration = {
  strings: Record<string, NativeStringEntry>;
  keys: Record<string, string>;
};

/**
 * One-time migration from source-language text keys to stable semantic keys.
 * Existing UI semantic keys take precedence only when the English message is
 * unique on both sides. The catalog stores the resulting IDs, so later wording
 * changes never regenerate or rename a key.
 */
function migrateLegacyNativeStrings(catalog: Catalog): NativeKeyMigration {
  const original = catalog.macos.strings;
  const nativeEnglishCounts = new Map<string, number>();
  for (const [key, entry] of Object.entries(original)) {
    const english = stringUnitValue(entry.localizations?.[catalog.defaultLocale]) || key;
    nativeEnglishCounts.set(english, (nativeEnglishCounts.get(english) || 0) + 1);
  }
  const uiKeysByEnglish = new Map<string, string[]>();
  for (const [key, value] of Object.entries(catalog.ui.translations[catalog.defaultLocale])) {
    uiKeysByEnglish.set(value, [...(uiKeysByEnglish.get(value) || []), key]);
  }

  const reserved = new Set(Object.keys(catalog.ui.translations[catalog.defaultLocale]));
  const strings: Record<string, NativeStringEntry> = {};
  const keys: Record<string, string> = {};
  for (const [legacyKey, entry] of Object.entries(original)) {
    const english = stringUnitValue(entry.localizations?.[catalog.defaultLocale]) || legacyKey;
    const shared = uiKeysByEnglish.get(english) || [];
    const semantic = nativeEnglishCounts.get(english) === 1 && shared.length === 1
      ? shared[0]!
      : nextNativeSemanticKey(english, reserved);
    keys[legacyKey] = semantic;
    reserved.add(semantic);
    if (shared.length === 1 && semantic === shared[0]) continue;
    const source = stringUnitValue(entry.localizations?.[catalog.macos.sourceLanguage]) || legacyKey;
    strings[semantic] = {
      ...entry,
      localizations: {
        ...(entry.localizations || {}),
        [catalog.macos.sourceLanguage]: {
          stringUnit: { state: "translated", value: source }
        }
      }
    };
  }
  return { strings, keys };
}

function nextNativeSemanticKey(message: string, reserved: Set<string>): string {
  const words = message
    .replace(/%\d*\$?(?:ll|l)?[@diuoxXfFeEgGaAcCsSp]/g, " ")
    .replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  const rawStem = words.join("") || "nativeText";
  const stem = /^[a-z]/.test(rawStem) ? rawStem : `nativeText${rawStem}`;
  const base = `macos.${stem}`;
  if (!reserved.has(base)) return base;
  for (let alternative = 2; ; alternative += 1) {
    const candidate = `${base}.alternative${alternative}`;
    if (!reserved.has(candidate)) return candidate;
  }
}

function walkSwiftFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkSwiftFiles(file);
    return entry.isFile() && entry.name.endsWith(".swift") && entry.name !== "GeneratedLocalization.swift" ? [file] : [];
  });
}

function rewriteSwiftLocalizationKeys(keys: Record<string, string>): number {
  let replacements = 0;
  const sourceDirectory = path.join(repositoryRoot, "macos", "Sources", "CodexBridgeMenuBar");
  for (const file of walkSwiftFiles(sourceDirectory)) {
    const source = decodeUtf8Strict(readFileSync(file), `Swift localization source ${relative(file)}`);
    const next = source.replace(/"((?:\\.|[^"\\\r\n])*)"/g, (literal, body: string) => {
      let value: string;
      try { value = JSON.parse(`"${body}"`); } catch { return literal; }
      const semantic = keys[value];
      if (!semantic) return literal;
      replacements += 1;
      return swiftLiteral(semantic);
    });
    if (next !== source) writeFileSync(file, next);
  }
  return replacements;
}

function migrateNativeKeys(): void {
  const raw = parseJsonUtf8Strict(readFileSync(catalogPath), "Localization catalog") as Catalog;
  if (!isRecord(raw) || !isRecord(raw.macos) || !isRecord(raw.macos.strings)) {
    throw new Error("Localization catalog does not contain a native String Catalog.");
  }
  if (Object.keys(raw.macos.strings).every((key) => SEMANTIC_KEY_PATTERN.test(key))) {
    throw new Error("Native String Catalog keys are already semantic; refusing to regenerate stable IDs.");
  }
  const migration = migrateLegacyNativeStrings(raw);
  raw.macos.strings = migration.strings;
  validateCatalog(raw);
  writeFileSync(catalogPath, `${JSON.stringify(raw, null, 2)}\n`);
  const replacements = rewriteSwiftLocalizationKeys(migration.keys);
  console.log(`Migrated ${Object.keys(migration.keys).length} native keys and rewrote ${replacements} Swift key references.`);
}

function generate(checkOnly = false): void {
  const catalog = readCatalog();
  const outputs = new Map<string, string>([
    [generatedTypeScriptPath, renderTypeScript(catalog)],
    [generatedSwiftPath, renderSwift(catalog)],
    [generatedXcstringsPath, renderXcstrings(catalog)]
  ]);
  const stale = [...outputs].filter(([file, content]) =>
    !existsSync(file) || decodeUtf8Strict(readFileSync(file), `Generated localization ${relative(file)}`) !== content
  );
  if (checkOnly) {
    if (stale.length > 0) {
      throw new Error(`Generated localization files are stale: ${stale.map(([file]) => relative(file)).join(", ")}. Run npm run localization:generate.`);
    }
    console.log("Localization catalog and generated files are synchronized.");
    return;
  }
  for (const [file, content] of outputs) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  console.log(`Generated ${outputs.size} localization artifacts.`);
}

function stringUnitValue(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.stringUnit) || value.stringUnit.state !== "translated" ||
    typeof value.stringUnit.value !== "string" || !value.stringUnit.value) return undefined;
  return value.stringUnit.value;
}

function placeholderSignature(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
    .map((match) => match[1] as string)
    .sort();
}

function printfSignature(value: string): string[] {
  const values = [...value.matchAll(/%(?:(\d+)\$)?(?:ll|l)?([@diuoxXfFeEgGaAcCsSp])/g)]
    .map((match, index) => `${match[1] || String(index + 1)}:${match[2]}`)
    .sort();
  return values;
}

function parameterDeclarations(bundle: Record<string, string>): Record<string, Record<string, "string-or-number">> {
  return Object.fromEntries(
    Object.entries(bundle).flatMap(([key, value]) => {
      const names = [...new Set(placeholderSignature(value))].sort();
      return names.length ? [[key, Object.fromEntries(names.map((name) => [name, "string-or-number"]))]] : [];
    })
  );
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relative(file: string): string {
  return path.relative(repositoryRoot, file) || ".";
}

async function main(): Promise<void> {
  const command = process.argv[2] || "check";
  if (command === "bootstrap") return bootstrap();
  if (command === "migrate-native-keys") return migrateNativeKeys();
  if (command === "generate") return generate(false);
  if (command === "check") return generate(true);
  if (command === "annotate-parameters") {
    const raw = parseJsonUtf8Strict(readFileSync(catalogPath), "Localization catalog");
    if (!isRecord(raw) || !isRecord(raw.ui) || !isRecord(raw.ui.translations) || !isRecord(raw.ui.translations.en)) {
      throw new Error("Localization catalog does not contain an English UI translation bundle.");
    }
    raw.ui.parameters = parameterDeclarations(raw.ui.translations.en as Record<string, string>);
    writeFileSync(catalogPath, `${JSON.stringify(raw, null, 2)}\n`);
    console.log("Added UI named-placeholder declarations to locales/catalog.json.");
    return;
  }
  throw new Error("Usage: tsx scripts/localization.mts [bootstrap|migrate-native-keys|generate|check|annotate-parameters]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
