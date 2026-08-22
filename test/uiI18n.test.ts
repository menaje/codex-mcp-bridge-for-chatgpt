import { describe, expect, it } from "vitest";
import { ACTIVITY_CARD_HTML } from "../src/activityCard.js";
import { PRODUCT_INFO } from "../src/productInfo.js";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import {
  isUiLocalePreference,
  resolvePreferredUiLocale,
  resolveUiLocale,
  serializedUiTranslations,
  SUPPORTED_UI_LOCALES,
  UI_LOCALE_PREFERENCES,
  UI_TRANSLATIONS
} from "../src/uiI18n.js";

describe("human-facing UI localization", () => {
  it("ships complete, shared bundles for every supported locale", () => {
    expect(SUPPORTED_UI_LOCALES).toEqual([
      "en",
      "ko",
      "ja",
      "zh-Hans",
      "zh-Hant",
      "es",
      "fr",
      "de",
      "pt"
    ]);
    const englishKeys = Object.keys(UI_TRANSLATIONS.en).sort();
    for (const locale of SUPPORTED_UI_LOCALES) {
      expect(Object.keys(UI_TRANSLATIONS[locale]).sort()).toEqual(englishKeys);
      for (const value of Object.values(UI_TRANSLATIONS[locale])) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
    for (const locale of SUPPORTED_UI_LOCALES.filter((entry) => entry !== "en")) {
      expect(UI_TRANSLATIONS[locale]["common.loading"]).not.toBe(UI_TRANSLATIONS.en["common.loading"]);
      expect(UI_TRANSLATIONS[locale]["activity.forceStop"]).not.toBe(UI_TRANSLATIONS.en["activity.forceStop"]);
      expect(UI_TRANSLATIONS[locale]["settings.language"]).not.toBe(UI_TRANSLATIONS.en["settings.language"]);
      expect(UI_TRANSLATIONS[locale]["settings.cardVisibility"]).not.toBe(
        UI_TRANSLATIONS.en["settings.cardVisibility"]
      );
      expect(UI_TRANSLATIONS[locale]["settings.conflict"]).not.toBe(
        UI_TRANSLATIONS.en["settings.conflict"]
      );
      expect(UI_TRANSLATIONS[locale]["job.interrupted"]).not.toBe(UI_TRANSLATIONS.en["job.interrupted"]);
      expect(UI_TRANSLATIONS[locale]["waiting.orchestrator"]).not.toBe(UI_TRANSLATIONS.en["waiting.orchestrator"]);
    }

    const settingsText = SUPPORTED_UI_LOCALES.flatMap((locale) =>
      Object.entries(UI_TRANSLATIONS[locale])
        .filter(([key]) => key.startsWith("settings."))
        .map(([, value]) => value)
    ).join("\n");
    expect(settingsText).not.toMatch(/\boperator\b|운영자|管理者|管理员|管理員|operador|opérateur|Betreiber/i);
    expect(UI_TRANSLATIONS.ko["settings.reset"]).toBe("기본 설정으로 복원");
  });

  it("supports automatic host language and fixed saved language preferences", () => {
    expect(UI_LOCALE_PREFERENCES).toEqual([
      "auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"
    ]);
    expect(isUiLocalePreference("auto")).toBe(true);
    expect(isUiLocalePreference("ko")).toBe(true);
    expect(isUiLocalePreference("it")).toBe(false);
    expect(resolvePreferredUiLocale("auto", "ko-KR")).toBe("ko");
    expect(resolvePreferredUiLocale("ja", "ko-KR")).toBe("ja");
    for (const preference of UI_LOCALE_PREFERENCES.filter((entry) => entry !== "auto")) {
      expect(resolvePreferredUiLocale(preference, "en-US")).toBe(preference);
    }
  });

  it("resolves BCP 47 language/script fallbacks without location inference", () => {
    expect(resolveUiLocale("ko-KR")).toBe("ko");
    expect(resolveUiLocale("ja_JP")).toBe("ja");
    expect(resolveUiLocale("zh-TW")).toBe("zh-Hant");
    expect(resolveUiLocale("zh-HK-x-private")).toBe("zh-Hant");
    expect(resolveUiLocale("zh-CN")).toBe("zh-Hans");
    expect(resolveUiLocale("es-MX")).toBe("es");
    expect(resolveUiLocale("fr-CA")).toBe("fr");
    expect(resolveUiLocale("de-DE")).toBe("de");
    expect(resolveUiLocale("pt-BR")).toBe("pt");
    expect(resolveUiLocale("ar-SA")).toBe("en");
    expect(resolveUiLocale("not a locale")).toBe("en");
    expect(resolveUiLocale(null)).toBe("en");
  });

  it("serializes bundles safely into both self-contained cards", () => {
    const serialized = serializedUiTranslations();
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toEqual(UI_TRANSLATIONS);
    expect(SETTINGS_CARD_HTML).toContain(serialized);
    expect(ACTIVITY_CARD_HTML).toContain(serialized);
    expect(SETTINGS_CARD_HTML).toContain(PRODUCT_INFO.displayName);
    expect(SETTINGS_CARD_HTML).not.toContain('data-i18n="settings.sessionManaged"');
    expect(SETTINGS_CARD_HTML).not.toContain('data-i18n="settings.unlimited"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="revision"');
    expect(SETTINGS_CARD_HTML).toContain('id="activity-card-visibility"');
    expect(SETTINGS_CARD_HTML).toContain('id="completion-handoff"');
    expect(SETTINGS_CARD_HTML).toContain("SETTINGS_REVISION_CONFLICT");
    expect(`${SETTINGS_CARD_HTML}${ACTIVITY_CARD_HTML}${serialized}`).not.toContain("MacBook Air");
  });

  it("supports host locale updates, accessible controls, and standard/fallback app messaging", () => {
    for (const html of [SETTINGS_CARD_HTML, ACTIVITY_CARD_HTML]) {
      expect(html).toContain('dir="auto"');
      expect(html).toContain('initialMetadata["openai/locale"]');
      expect(html).toContain('initialMetadata["webplus/i18n"]');
      expect(html).toContain('window.openai.locale');
      expect(html).toContain('openai:set_globals');
      expect(html).not.toContain("openai/userLocation");
      expect(html).not.toMatch(/geolocation|navigator\.geolocation/i);
    }
    expect(SETTINGS_CARD_HTML).toContain('role="status"');
    expect(SETTINGS_CARD_HTML).toContain('id="ui-language"');
    expect(SETTINGS_CARD_HTML).toContain("uiLocalePreference");
    expect(SETTINGS_CARD_HTML).toContain("Settings card unmounted");
    expect(ACTIVITY_CARD_HTML).toContain('aria-live="polite"');
    expect(ACTIVITY_CARD_HTML).toContain('document.createElement("datalist")');
    expect(ACTIVITY_CARD_HTML).toContain('rpcRequest("ui/message"');
    expect(ACTIVITY_CARD_HTML).toContain("sendFollowUpMessage");
    expect(ACTIVITY_CARD_HTML).toContain('callTool("codex_status",{activityView:true');
    expect(ACTIVITY_CARD_HTML).toContain("Activity card unmounted");
    expect(ACTIVITY_CARD_HTML).toContain("next.uiLocalePreference");
  });
});
