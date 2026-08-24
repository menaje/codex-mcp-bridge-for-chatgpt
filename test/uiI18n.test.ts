import { describe, expect, it } from "vitest";
import { ACTIVITY_CARD_HTML } from "../src/activityCard.js";
import { PRODUCT_INFO } from "../src/productInfo.js";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import {
  isUiLocalePreference,
  missingReasoningEffortTranslations,
  reasoningEffortPresentation,
  resolvePreferredUiLocale,
  resolveUiLocale,
  serializedUiTranslations,
  SUPPORTED_UI_LOCALES,
  UI_LOCALE_PREFERENCES,
  UI_TRANSLATIONS
} from "../src/uiI18n.js";

const PROJECT_TRANSLATION_KEYS = [
  "settings.projects",
  "settings.projectsHint",
  "settings.allowedRoots",
  "settings.allowedRootsHint",
  "settings.addProject",
  "settings.noProjects",
  "settings.projectId",
  "settings.projectIdHint",
  "settings.projectLabel",
  "settings.projectCwd",
  "settings.defaultProject",
  "settings.defaultProjectHint",
  "settings.defaultProjectNone",
  "settings.projectAvailable",
  "settings.projectUnavailable",
  "settings.projectNew",
  "settings.removeProject",
  "settings.projectInvalidId",
  "settings.projectInvalidLabel",
  "settings.projectInvalidCwd",
  "settings.projectDuplicateId",
  "settings.projectDuplicatePath",
  "settings.projectDefaultMissing",
  "settings.projectUnavailableSave",
  "settings.projectLimit",
  "settings.projectError"
] as const;

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
      for (const key of [
        "settings.cardVisibility.always",
        "settings.cardVisibility.background",
        "settings.cardVisibility.never",
        "activity.superseded"
      ] as const) {
        expect(UI_TRANSLATIONS[locale][key]).not.toBe(UI_TRANSLATIONS.en[key]);
      }
      expect(UI_TRANSLATIONS[locale]["settings.conflict"]).not.toBe(
        UI_TRANSLATIONS.en["settings.conflict"]
      );
      for (const key of PROJECT_TRANSLATION_KEYS) {
        expect(UI_TRANSLATIONS[locale][key]).not.toBe(UI_TRANSLATIONS.en[key]);
      }
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
    expect(UI_TRANSLATIONS.ko["settings.fullWarning"]).toBe(
      "전체 접근은 이 macOS 사용자의 파일시스템·네트워크 권한으로 Codex를 실행합니다. 허용 루트는 시작 폴더만 제한하며 OS 격리가 아닙니다."
    );
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

  it("separates dynamic effort availability from localized labels and safe unknown-effort fallback", () => {
    expect(reasoningEffortPresentation("high", "ko", "English upstream description")).toEqual({
      effort: "high",
      label: "높음",
      description: "복잡한 작업을 더 깊게 검토하지만 응답 시간이 늘어날 수 있습니다.",
      descriptionSource: "localized"
    });
    expect(reasoningEffortPresentation("high", "en", "Upstream high description")).toMatchObject({
      label: "High",
      description: "Upstream high description",
      descriptionSource: "upstream"
    });
    expect(reasoningEffortPresentation("breakthrough", "ko", "Unlocalized upstream prose")).toEqual({
      effort: "breakthrough",
      label: "breakthrough",
      description: UI_TRANSLATIONS.ko["settings.effortFallbackDescription"],
      descriptionSource: "fallback"
    });
    expect(missingReasoningEffortTranslations(["high", "breakthrough", "breakthrough", "novel"]))
      .toEqual(["breakthrough", "novel"]);
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
    expect(SETTINGS_CARD_HTML).toContain('id="use-priority-service-tier" type="checkbox"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="policy-service-tier"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="activity-card-view"');
    expect(SETTINGS_CARD_HTML).not.toContain("activityCardView");
    expect(ACTIVITY_CARD_HTML).not.toContain("viewMode");
    expect(serialized).not.toContain("settings.cardView");
    expect(SETTINGS_CARD_HTML).toContain('id="completion-handoff"');
    expect(SETTINGS_CARD_HTML).toContain('id="projects-title"');
    expect(SETTINGS_CARD_HTML).toContain('id="project-list"');
    expect(SETTINGS_CARD_HTML).toContain('id="add-project" type="button"');
    expect(SETTINGS_CARD_HTML).toContain('id="default-project"');
    expect(SETTINGS_CARD_HTML).toContain('id="allowed-root-list"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="default-cwd"');
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
    expect(SETTINGS_CARD_HTML).toContain(
      'id="policy-effort" required aria-describedby="effort-description effort-compatibility"'
    );
    expect(SETTINGS_CARD_HTML).toContain('id="effort-description" aria-live="polite"');
    expect(SETTINGS_CARD_HTML).toContain("option(effort,effortPresentation(effort).label)");
    expect(SETTINGS_CARD_HTML).toContain('id="allowed-models"');
    expect(SETTINGS_CARD_HTML).toContain('id="effort-groups"');
    expect(SETTINGS_CARD_HTML).toContain("usePriorityServiceTier:elements.priority.checked");
    expect(SETTINGS_CARD_HTML).toContain("projects:projectSettings.projects");
    expect(SETTINGS_CARD_HTML).toContain("defaultProjectId:projectSettings.defaultProjectId");
    expect(SETTINGS_CARD_HTML).toContain("limits.projectAvailability");
    expect(SETTINGS_CARD_HTML).toContain('id.readOnly=persisted');
    expect(SETTINGS_CARD_HTML).toContain("PROJECT_DUPLICATE_ID");
    expect(SETTINGS_CARD_HTML).toContain("PROJECT_DUPLICATE_PATH");
    expect(SETTINGS_CARD_HTML).toContain("normalizedPathKey");
    expect(SETTINGS_CARD_HTML).not.toContain('document.createElement("details")');
    expect(SETTINGS_CARD_HTML).toContain('<fieldset class="choice-group"><legend');
    expect(SETTINGS_CARD_HTML).toContain('document.createElement("fieldset")');
    expect(SETTINGS_CARD_HTML).toContain('document.createElement("legend")');
    expect(SETTINGS_CARD_HTML).toContain('all.dataset.action="all-efforts"');
    expect(SETTINGS_CARD_HTML).toContain("all.indeterminate=");
    expect(SETTINGS_CARD_HTML).toContain('all.indeterminate?"mixed"');
    expect(SETTINGS_CARD_HTML).toContain('id="selection-count" aria-live="polite"');
    expect(SETTINGS_CARD_HTML).toContain('id="retry-models" type="button"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="refresh"');
    expect(SETTINGS_CARD_HTML).toContain('aria-describedby="access-hint full-warning"');
    expect(SETTINGS_CARD_HTML).toContain('elements.fullWarning.classList.toggle("show",value==="always-full")');
    expect(SETTINGS_CARD_HTML.indexOf('id="full-warning"')).toBeLessThan(
      SETTINGS_CARD_HTML.indexOf('id="model-policy-mode"')
    );
    expect(SETTINGS_CARD_HTML).toContain('elements.retryModels.hidden=!catalogProblem');
    expect(SETTINGS_CARD_HTML).not.toContain("setInterval(");
    expect(ACTIVITY_CARD_HTML).toContain('aria-live="polite"');
    expect(ACTIVITY_CARD_HTML).not.toContain('document.createElement("datalist")');
    expect(ACTIVITY_CARD_HTML).not.toContain("<details");
    expect(ACTIVITY_CARD_HTML).toContain("<body hidden>");
    expect(ACTIVITY_CARD_HTML).toContain(".card{border:0;border-radius:0;background:transparent}");
    expect(ACTIVITY_CARD_HTML).toContain("next.feed");
    expect(ACTIVITY_CARD_HTML).toContain('renderGroup("completed"');
    expect(ACTIVITY_CARD_HTML).toContain("renderHistoryRow(item,kind,showWorkspace)");
    expect(ACTIVITY_CARD_HTML).toContain("Boolean(next.feed.showWorkspaceLabels)");
    expect(ACTIVITY_CARD_HTML).toContain("summary.push(...(item.workspaceLabels||[]))");
    expect(ACTIVITY_CARD_HTML).toContain('aria-expanded');
    expect(ACTIVITY_CARD_HTML).toContain("activity.currentActivities");
    expect(ACTIVITY_CARD_HTML).not.toContain('next.viewMode==="activity-summary"');
    expect(ACTIVITY_CARD_HTML).not.toContain("renderActivities(next)");
    expect(ACTIVITY_CARD_HTML).not.toContain("renderAgents(next)");
    expect(ACTIVITY_CARD_HTML).not.toContain('callTool("codex_agent"');
    expect(ACTIVITY_CARD_HTML).toContain('callTool("codex_background_process_terminate"');
    expect(ACTIVITY_CARD_HTML).toContain("expectedAgentVersion:control.agentVersion");
    expect(ACTIVITY_CARD_HTML).toContain('rpcRequest("ui/message"');
    expect(ACTIVITY_CARD_HTML).toContain("sendFollowUpMessage");
    expect(ACTIVITY_CARD_HTML).toContain('callTool("codex_activity_snapshot",{card:cardProof(),limit:viewLimit}');
    expect(ACTIVITY_CARD_HTML).toContain('callTool("codex_interaction_respond"');
    expect(ACTIVITY_CARD_HTML).toContain('callTool("codex_activity_handoff",{action:"claim-batch"');
    expect(ACTIVITY_CARD_HTML).not.toContain('callTool("codex_status",Object.assign({activityView:true');
    expect(ACTIVITY_CARD_HTML).toContain("consumeToolOutput");
    expect(ACTIVITY_CARD_HTML).toContain('value.method==="ui/notifications/tool-input"');
    expect(ACTIVITY_CARD_HTML).toContain("next.bridgeActivity||next.activityTracking");
    expect(ACTIVITY_CARD_HTML).toContain("presentation.shouldRenderActivityCard");
    expect(ACTIVITY_CARD_HTML).toContain('presentation.presentationKind!=="automatic"');
    expect(ACTIVITY_CARD_HTML).toContain("activityPresentationId");
    expect(ACTIVITY_CARD_HTML).toContain("next.watcherPolicy.live===false");
    expect(ACTIVITY_CARD_HTML).toContain("snapshot.watcherPolicy.ownsCompletionHandoff===false");
    expect(ACTIVITY_CARD_HTML).not.toContain('callTool("codex_activity"');
    expect(ACTIVITY_CARD_HTML).toContain("Activity card unmounted");
    expect(ACTIVITY_CARD_HTML).toContain("next.uiLocalePreference");
  });
});
