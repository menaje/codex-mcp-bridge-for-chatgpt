import {
  SUPPORTED_UI_LOCALES,
  UI_LANGUAGE_LABELS,
  UI_LOCALE_PREFERENCES,
  UI_LOCALE_RESOLUTION,
  UI_TRANSLATION_PARAMETERS,
  UI_TRANSLATIONS,
  type SupportedUiLocale,
  type UiLocalePreference,
  type UiTranslationBundle,
  type UiTranslationKey
} from "./generated/localization.js";

// The catalog is generated from locales/catalog.json. Keep this facade small:
// it owns runtime presentation rules, while no translation text is authored in
// TypeScript any more.
export {
  SUPPORTED_UI_LOCALES,
  UI_LANGUAGE_LABELS,
  UI_LOCALE_PREFERENCES,
  UI_LOCALE_RESOLUTION,
  UI_TRANSLATION_PARAMETERS,
  UI_TRANSLATIONS,
  type SupportedUiLocale,
  type UiLocalePreference,
  type UiTranslationBundle,
  type UiTranslationKey
};

// These labels belonged to the retired Activity card. Keep old retained
// snapshots readable in memory, but never ship the labels in a current card.
const RETIRED_ACTIVITY_CARD_TRANSLATION_KEYS = new Set<string>([
  "settings.cardVisibility",
  "settings.cardVisibility.always",
  "settings.cardVisibility.background",
  "settings.handoff",
  "settings.handoff.off",
  "settings.handoff.auto",
  "settings.handoffRequiresCard",
  "activity.followUpSent",
  "activity.prompt.handoff",
  "activity.superseded",
  "activity.historicalSnapshot",
  "activity.restoredSnapshot",
  "activity.enrichmentFailed",
  "activity.refreshFailedRetained",
  "activity.openLive"
]);

export function uiTranslation(
  locale: SupportedUiLocale,
  key: UiTranslationKey,
  parameters: Readonly<Record<string, string | number>> = {}
): string {
  let message = UI_TRANSLATIONS[locale][key];
  for (const [name, value] of Object.entries(parameters)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}

export type SettingsWarningPresentation = {
  key: UiTranslationKey;
  parameters: Record<string, string | number>;
};

const settingsMessage = (
  key: UiTranslationKey,
  parameters: Record<string, string | number> = {}
): SettingsWarningPresentation => ({ key, parameters });

/**
 * Compatibility mapping for legacy diagnostic text. New server-owned
 * diagnostics should create this stable descriptor at their source so every
 * client can re-render it without parsing translated prose.
 */
export function settingsWarningPresentation(
  warning: string,
  context: { catalog?: boolean; stale?: boolean } = {}
): SettingsWarningPresentation {
  if (context.catalog) {
    return settingsMessage(context.stale ? "settings.warning.catalogStale" : "settings.warning.catalogUnavailable");
  }

  if (warning.startsWith("CODEX_MCP_BRIDGE_ROOTS ")) {
    return settingsMessage("settings.warning.legacyRoots");
  }
  if (warning.startsWith("CODEX_MCP_BRIDGE_FAST_RETURN_MS ")) {
    return settingsMessage("settings.warning.fastReturnRetired");
  }
  if (warning.startsWith("CODEX_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS ")) {
    return settingsMessage("settings.warning.upstreamTimeoutRetired");
  }
  if (warning.startsWith("CODEX_MCP_BRIDGE_DEFAULT_SESSION_MODE ")) {
    return settingsMessage("settings.warning.defaultSessionRetired");
  }
  if (warning.startsWith("CODEX_MCP_BRIDGE_AUTO_RESUME_TTL_MS ")) {
    return settingsMessage("settings.warning.autoResumeRetired");
  }
  if (warning.startsWith("Legacy project IDs/default aliases ")) {
    return settingsMessage("settings.warning.legacyProjects");
  }
  if (warning.startsWith("Automatic model policy was missing an exact fallback")) {
    return settingsMessage("settings.warning.automaticFallbackSeeded");
  }
  if (warning.startsWith("A retired automatic model default was removed")) {
    return settingsMessage("settings.warning.automaticFallbackRemoved");
  }
  if (
    warning.startsWith("Saved full-access mode was downgraded") ||
    warning.startsWith("Saved full-access mode is retained but inactive")
  ) {
    return settingsMessage("settings.warning.fullAccessDowngraded");
  }
  if (warning.startsWith("Saved concurrent-job limit was reduced")) {
    return settingsMessage("settings.warning.concurrentLimitReduced");
  }

  const unavailableProject = warning.match(
    /^PROJECT_UNAVAILABLE:\s*Saved project ["“](.+?)["”] is unavailable/i
  )?.[1];
  if (unavailableProject) {
    return settingsMessage("settings.warning.projectUnavailable", { project: unavailableProject });
  }

  const legacyModel = warning.match(/^Legacy model-only preference '(.+?)' remains active/i)?.[1];
  if (legacyModel) {
    return settingsMessage("settings.warning.legacyModel", { model: legacyModel });
  }
  if (warning.startsWith("Legacy automatic model policy has no exact saved omission fallback")) {
    return settingsMessage("settings.warning.legacyAutomatic");
  }

  if (warning.includes("Ultra is disabled and no saved model and reasoning choice can currently run")) {
    return settingsMessage("settings.ultraNoSelection");
  }
  if (warning.includes("Ultra is disabled. Choose another reasoning level for the fixed model")) {
    return settingsMessage("settings.ultraFixedConflict");
  }
  const policyCode = warning.match(/\b(MODEL_[A-Z_]+|THREAD_OVERRIDE_UNSUPPORTED)\b/)?.[1];
  if (policyCode || /model policy|Priority/i.test(warning)) {
    return settingsMessage("settings.warning.modelPolicy", { codeSuffix: policyCode ? ` (${policyCode})` : "" });
  }
  return settingsMessage("settings.warning.generic");
}

export function localizeSettingsWarning(
  warning: string,
  locale: SupportedUiLocale,
  context: { catalog?: boolean; stale?: boolean } = {}
): string {
  const presentation = settingsWarningPresentation(warning, context);
  return uiTranslation(locale, presentation.key, presentation.parameters);
}

/** Resolve an IETF language tag using the catalog's one shared rule set. */
export function resolveUiLocale(input?: string | null): SupportedUiLocale {
  const locale = (input || "en").trim().replace(/_/g, "-").toLowerCase();
  if (locale === "ko" || locale.startsWith("ko-")) return "ko";
  if (locale === "ja" || locale.startsWith("ja-")) return "ja";
  if (
    UI_LOCALE_RESOLUTION.traditionalChineseTags.some(
      (tag) => locale === tag || locale.startsWith(`${tag}-`)
    ) ||
    UI_LOCALE_RESOLUTION.traditionalChineseRegions.some(
      (region) => new RegExp(`^zh-${region}(-|$)`).test(locale)
    )
  ) return "zh-Hant";
  if (locale === "zh" || locale === "zh-hans" || locale.startsWith("zh-")) return "zh-Hans";
  for (const candidate of ["es", "fr", "de", "pt"] as const) {
    if (locale === candidate || locale.startsWith(`${candidate}-`)) return candidate;
  }
  return "en";
}

export function isUiLocalePreference(value: unknown): value is UiLocalePreference {
  return typeof value === "string" && (UI_LOCALE_PREFERENCES as readonly string[]).includes(value);
}

export function resolvePreferredUiLocale(
  preference: UiLocalePreference,
  hostLocale?: string | null
): SupportedUiLocale {
  return preference === "auto" ? resolveUiLocale(hostLocale) : preference;
}

/**
 * Select the host locale exposed to an embedded card without mistaking the
 * bridge's computed `openai/locale` fallback for host-provided context.
 * This function remains self-contained because its source is embedded in cards.
 */
export function resolveHostUiLocaleTag(
  exposedLocale: unknown,
  metadata: unknown,
  fallbackLocale: unknown
): string {
  const record = metadata && typeof metadata === "object"
    ? metadata as Record<string, unknown>
    : null;
  const exposed = typeof exposedLocale === "string" && exposedLocale.trim()
    ? exposedLocale.trim()
    : null;
  if (exposed) return exposed;
  const hostValue = record?.hostLocale;
  const host = typeof hostValue === "string" && hostValue.trim() ? hostValue.trim() : null;
  if (host) return host;
  const legacyHostValue = record?.["webplus/i18n"];
  const legacyHost = typeof legacyHostValue === "string" && legacyHostValue.trim()
    ? legacyHostValue.trim()
    : null;
  if (legacyHost) return legacyHost;
  if (record && !Object.prototype.hasOwnProperty.call(record, "hostLocale")) {
    const legacyOpenAiLocaleValue = record["openai/locale"];
    const legacyOpenAiLocale = typeof legacyOpenAiLocaleValue === "string" &&
      legacyOpenAiLocaleValue.trim() ? legacyOpenAiLocaleValue.trim() : null;
    if (legacyOpenAiLocale) return legacyOpenAiLocale;
  }
  return typeof fallbackLocale === "string" && fallbackLocale.trim() ? fallbackLocale.trim() : "en";
}

export function serializedUiTranslations(namespaces?: readonly string[]): string {
  const select = (bundle: UiTranslationBundle) => Object.fromEntries(
    Object.entries(bundle).filter(([key]) =>
      !RETIRED_ACTIVITY_CARD_TRANSLATION_KEYS.has(key) &&
      (!namespaces || namespaces.length === 0 || namespaces.some(
        (namespace) => key === namespace || key.startsWith(`${namespace}.`)
      ))
    )
  );
  const selected = Object.fromEntries(
    Object.entries(UI_TRANSLATIONS).map(([locale, bundle]) => [locale, select(bundle)])
  );
  return JSON.stringify(selected).replaceAll("<", "\\u003c");
}

const KNOWN_REASONING_EFFORTS = new Set([
  "minimal", "low", "medium", "high", "xhigh", "max", "ultra"
]);

export type ReasoningEffortPresentation = {
  effort: string;
  label: string;
  description: string;
  descriptionSource: "localized" | "upstream" | "fallback";
};

export function reasoningEffortPresentation(
  effort: string,
  locale: SupportedUiLocale,
  upstreamDescription?: string
): ReasoningEffortPresentation {
  const canonical = effort.trim().toLowerCase();
  const bundle = UI_TRANSLATIONS[locale] || UI_TRANSLATIONS.en;
  const known = KNOWN_REASONING_EFFORTS.has(canonical);
  const descriptionKey = `effort.${canonical}.description` as UiTranslationKey;
  if (locale === "en" && upstreamDescription?.trim()) {
    return { effort: canonical, label: canonical, description: upstreamDescription.trim(), descriptionSource: "upstream" };
  }
  if (known) {
    return { effort: canonical, label: canonical, description: bundle[descriptionKey], descriptionSource: "localized" };
  }
  return {
    effort: canonical,
    label: canonical,
    description: bundle["settings.effortFallbackDescription"],
    descriptionSource: "fallback"
  };
}

export function missingReasoningEffortTranslations(efforts: Iterable<string>): string[] {
  return [...new Set(efforts)].filter((effort) => !KNOWN_REASONING_EFFORTS.has(effort)).sort();
}
