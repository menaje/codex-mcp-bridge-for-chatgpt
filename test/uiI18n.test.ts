import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_CARD_HTML,
  shouldShowHistoricalActivityTitle
} from "../src/activityCard.js";
import {
  dispatchDashboardExternalUrl,
  DASHBOARD_CARD_CONTENT_METADATA,
  DASHBOARD_CARD_HTML
} from "../src/dashboardCard.js";
import { PRODUCT_INFO } from "../src/productInfo.js";
import { htmlForUiResource } from "../src/uiResources.js";
import {
  SETTINGS_CARD_HTML,
  uiBridgeErrorMessage
} from "../src/settingsCard.js";
import {
  isUiLocalePreference,
  localizeSettingsWarning,
  missingReasoningEffortTranslations,
  reasoningEffortPresentation,
  resolveHostUiLocaleTag,
  resolvePreferredUiLocale,
  resolveUiLocale,
  serializedUiTranslations,
  SUPPORTED_UI_LOCALES,
  UI_LOCALE_PREFERENCES,
  UI_TRANSLATIONS,
  uiTranslation
} from "../src/uiI18n.js";

const PROJECT_TRANSLATION_KEYS = [
  "settings.projects",
  "settings.projectsHint",
  "settings.allowedRoots",
  "settings.allowedRootsHint",
  "settings.addProject",
  "settings.addFirstProject",
  "settings.noProjects",
  "settings.projectLabel",
  "settings.projectCwd",
  "settings.projectAvailable",
  "settings.projectUnavailable",
  "settings.projectNew",
  "settings.archiveProject",
  "settings.restoreProject",
  "settings.deleteProject",
  "settings.cancelDeleteProject",
  "settings.deleteProjectConfirm",
  "settings.projectArchived",
  "settings.projectArchivePending",
  "settings.projectRestorePending",
  "settings.projectDeletePending",
  "settings.projectInvalidLabel",
  "settings.projectInvalidCwd",
  "settings.projectDuplicatePath",
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
        "settings.codexAppThreads",
        "settings.codexAppThreadsHint",
        "settings.codexAppThreadsMcpHint"
      ] as const) {
        expect(UI_TRANSLATIONS[locale][key]).not.toBe(UI_TRANSLATIONS.en[key]);
      }
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
    expect(UI_TRANSLATIONS.ko["settings.reset"]).toBe("일반 설정 기본값 복원");
    expect(UI_TRANSLATIONS.ko["settings.resetHint"]).toContain("프로젝트와 순서는 유지");
    expect(UI_TRANSLATIONS.ko["settings.fullWarning"]).toBe(
      "전체 접근은 이 macOS 사용자의 파일시스템·네트워크 권한으로 Codex를 실행합니다. 프로젝트 폴더는 작업 시작 위치를 정할 뿐 OS 격리가 아닙니다."
    );
    expect(UI_TRANSLATIONS.ko["activity.currentExecution"]).toBe("현재 실행");
    expect(UI_TRANSLATIONS.ko["activity.latestExecution"]).toBe("최근 실행");
    expect(UI_TRANSLATIONS.ko["activity.reasoningEffort"]).toBe("에포트");
    expect(UI_TRANSLATIONS.ko["activity.workComplete"]).toBe("작업 완료");
    expect(UI_TRANSLATIONS.ko["dashboard.title"]).toBe("Codex 전체 현황");
    expect(UI_TRANSLATIONS.ko["dashboard.restoreFailed"]).toContain("다시 열어");
    expect(UI_TRANSLATIONS.ko["dashboard.status.completed"]).toBe("Codex turn 완료");
    expect(UI_TRANSLATIONS.ko["dashboard.status.background-process-running"])
      .toBe("백그라운드 프로세스 실행 중");
    expect(UI_TRANSLATIONS.ko["dashboard.history.show"]).toBe("이력 {count}건 펼치기");
    expect(UI_TRANSLATIONS.ko["dashboard.openConversation"]).toBe("대화 열기");
    expect(UI_TRANSLATIONS.ko["dashboard.attention"]).toBe("주의 상태");
    expect(UI_TRANSLATIONS.ko["dashboard.loadMore"]).toBe("더 보기");
    expect(UI_TRANSLATIONS.en["dashboard.loadMore"]).toBe("Show more");
    expect(UI_TRANSLATIONS.ko["dashboard.view.project"]).toBe("프로젝트별");
    expect(UI_TRANSLATIONS.ko["dashboard.view.conversation"]).toBe("대화별");
    expect(UI_TRANSLATIONS.ko["dashboard.view.status"]).toBe("상태별");
    expect(UI_TRANSLATIONS.ko["dashboard.conversationCurrent"])
      .toBe("활성 및 최근 GPT 대화");
    expect(UI_TRANSLATIONS.ko["dashboard.idleConversations"]).toBe("유휴 GPT 대화");
    expect(UI_TRANSLATIONS.ko["dashboard.idleProjects"]).toBe("유휴 프로젝트");
    expect(UI_TRANSLATIONS.ko["dashboard.unknownProject"]).toBe("프로젝트 미확인");
    expect(UI_TRANSLATIONS.ko["settings.deleteProject"]).toBe("삭제");
    expect(UI_TRANSLATIONS.ko["settings.deleteProjectConfirm"])
      .toContain("실제 폴더와 파일");
    expect(UI_TRANSLATIONS.ko["dashboard.idleAgentDisclosure"])
      .toBe("유휴 에이전트 {count}개 펼치기");
    expect(UI_TRANSLATIONS.ko["dashboard.agentShownCount"]).toBe("현재 페이지 {count}개");
    expect(UI_TRANSLATIONS.ko["dashboard.sectionCount"])
      .toBe("대화 {conversations}개 · 에이전트 {agents}개");
    expect(UI_TRANSLATIONS.ko["dashboard.time.duration"]).toBe("소요 {duration}");
    expect(UI_TRANSLATIONS.ko["dashboard.time.terminal"]).toBe("{relative} {status}");
    expect(UI_TRANSLATIONS.ko["dashboard.scopeNotice"]).toContain("전체 ChatGPT 기록은 아닙니다");
    expect(UI_TRANSLATIONS.ko["dashboard.runtimeOnly"]).toContain("GPT의 검증·완료 판단은 사용하지 않습니다");
    for (const locale of SUPPORTED_UI_LOCALES) {
      expect(UI_TRANSLATIONS[locale]["waiting.orchestrator"]).toBe(
        UI_TRANSLATIONS[locale]["activity.workComplete"]
      );
    }
    expect(UI_TRANSLATIONS.ko["settings.appServerExperimental"]).toContain(
      "개인·개발 환경에서만 사용"
    );
    expect(UI_TRANSLATIONS.ko["settings.allowedScope.catalog"]).toBe(
      "사용 가능한 모든 모델·에포트"
    );
    expect(UI_TRANSLATIONS.ko["settings.allowedScope.explicit"]).toBe(
      "직접 선택한 모델·에포트만"
    );
    expect(UI_TRANSLATIONS.ko["settings.preferredModel"]).toBe("GPT 미지정 시 기본 모델");
    expect(UI_TRANSLATIONS.ko["settings.preferredEffort"]).toBe("GPT 미지정 시 기본 추론 수준");
    expect(UI_TRANSLATIONS.ko["settings.cardVisibility.always"]).toBe(
      "모든 Codex 작업에 자동 표시"
    );
    expect(UI_TRANSLATIONS.ko["settings.cardVisibility.background"]).toBe(
      "백그라운드 Codex 작업에만 자동 표시"
    );
    expect(UI_TRANSLATIONS.ko["settings.codexAppThreads"]).toBe(
      "브리지 스레드를 Codex 앱에 표시"
    );
    expect(UI_TRANSLATIONS.ko["settings.codexAppThreadsHint"]).toContain(
      "Codex 앱 목록에 나타나지 않으며"
    );
    expect(UI_TRANSLATIONS.ko["settings.codexAppThreadsMcpHint"]).toContain(
      "MCP Server 백엔드는 스레드를 숨길 수 없습니다"
    );
    expect(UI_TRANSLATIONS.ko["settings.developerModeRefreshRequired"]).toContain(
      "정적 도구 계약도 변경"
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

  it("localizes audited settings warnings without exposing raw English diagnostics", () => {
    const backendWarning =
      "Backend routing: app-server applies only to new or deliberately fresh Agent threads. " +
      "Existing Agent threads remain pinned to their original backend. To cross backends, " +
      "choose the existing Agent with context='fresh' and provide an explicit handoffSummary; " +
      "the prior transcript and backend state are not copied.";
    expect(localizeSettingsWarning(backendWarning, "ko")).toContain(
      "기존 Agent 스레드는 처음 사용한 백엔드에 계속 고정"
    );
    expect(localizeSettingsWarning(backendWarning, "ko")).not.toContain(
      "Existing Agent threads remain pinned"
    );
    expect(localizeSettingsWarning(
      'PROJECT_UNAVAILABLE: Saved project "샘플" is unavailable and cannot admit new work.',
      "ko"
    )).toBe("저장된 프로젝트 ‘샘플’을(를) 사용할 수 없어 새 작업을 받을 수 없습니다.");
    expect(localizeSettingsWarning("upstream socket detail", "ko", {
      catalog: true,
      stale: true
    })).toBe(UI_TRANSLATIONS.ko["settings.warning.catalogStale"]);
    expect(localizeSettingsWarning("unrecognized upstream prose", "ja"))
      .toBe(UI_TRANSLATIONS.ja["settings.warning.generic"]);
    expect(uiTranslation("de", "common.errorCode", { code: "MODEL_UNAVAILABLE" }))
      .toContain("MODEL_UNAVAILABLE");
  });

  it("keeps audited UI text translated and preserves every template placeholder", () => {
    const allowedSameAsEnglish = new Set([
      "activity.defaultAgent",
      "activity.threads",
      "dashboard.page",
      "dashboard.conversationCount"
    ]);
    for (const locale of SUPPORTED_UI_LOCALES.filter((entry) => entry !== "en")) {
      for (const key of Object.keys(UI_TRANSLATIONS.en) as Array<keyof typeof UI_TRANSLATIONS.en>) {
        const audited = key.startsWith("settings.warning.") ||
          key.startsWith("dashboard.") ||
          key.startsWith("activity.prompt.") ||
          [
            "settings.modelPolicy",
            "settings.modelPolicy.fixed",
            "settings.modelPolicy.automatic",
            "settings.allowDelegation",
            "settings.serviceTier",
            "settings.serviceTier.default",
            "settings.fixedNotice",
            "settings.preferredSelection",
            "settings.selectionRequired",
            "settings.explicitRequired",
            "settings.developerModeRefreshRequired",
            "activity.approveSession"
          ].includes(key);
        if (audited && !allowedSameAsEnglish.has(key)) {
          expect(UI_TRANSLATIONS[locale][key], `${locale}:${key}`)
            .not.toBe(UI_TRANSLATIONS.en[key]);
        }
        const placeholders = (value: string) =>
          [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)]
            .map((match) => match[1])
            .sort();
        expect(placeholders(UI_TRANSLATIONS[locale][key]), `${locale}:${key}`)
          .toEqual(placeholders(UI_TRANSLATIONS.en[key]));
      }
    }
  });

  it("does not treat a synthesized effective locale as the automatic host locale", () => {
    expect(resolveHostUiLocaleTag.toString()).not.toContain("__name");
    expect(resolveHostUiLocaleTag(undefined, {
      hostLocale: null,
      "openai/locale": "en"
    }, "ko-KR")).toBe("ko-KR");
    expect(resolveHostUiLocaleTag(undefined, {
      hostLocale: "ko-KR",
      "openai/locale": "ko"
    }, "en-US")).toBe("ko-KR");
    expect(resolveHostUiLocaleTag("ja-JP", {
      hostLocale: "ko-KR"
    }, "en-US")).toBe("ja-JP");
    expect(resolveHostUiLocaleTag(undefined, {
      "openai/locale": "fr-FR"
    }, "ko-KR")).toBe("fr-FR");
    expect(resolveHostUiLocaleTag(undefined, {}, "")).toBe("en");
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
    expect(DASHBOARD_CARD_HTML).toContain(serialized);
    expect(SETTINGS_CARD_HTML).toContain(PRODUCT_INFO.displayName);
    expect(SETTINGS_CARD_HTML).toContain('document.title=t["settings.title"]');
    expect(ACTIVITY_CARD_HTML).toContain('document.title=t["activity.title"]');
    expect(DASHBOARD_CARD_HTML).toContain('document.title=t["dashboard.title"]');
    expect(DASHBOARD_CARD_HTML).not.toContain('aria-label="Overview counts"');
    expect(DASHBOARD_CARD_HTML).toContain('t["dashboard.countsLabel"]');
    expect(ACTIVITY_CARD_HTML).toContain('localizedText("activity.prompt.handoff"');
    expect(SETTINGS_CARD_HTML).not.toContain('data-i18n="settings.sessionManaged"');
    expect(SETTINGS_CARD_HTML).not.toContain('data-i18n="settings.unlimited"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="revision"');
    expect(SETTINGS_CARD_HTML).toContain('id="activity-card-visibility"');
    expect(SETTINGS_CARD_HTML).toContain('id="use-priority-service-tier" type="checkbox"');
    expect(SETTINGS_CARD_HTML).toContain(
      'id="show-bridge-threads-in-codex-app" type="checkbox"'
    );
    expect(SETTINGS_CARD_HTML).toContain(
      "showBridgeThreadsInCodexApp:elements.codexAppThreads.checked"
    );
    expect(SETTINGS_CARD_HTML).toContain(
      "elements.codexAppThreads.checked=settings.showBridgeThreadsInCodexApp===true"
    );
    expect(SETTINGS_CARD_HTML).toContain(
      'view.capabilities.defaultBackend==="app-server"'
    );
    expect(SETTINGS_CARD_HTML).not.toContain('id="policy-service-tier"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="activity-card-view"');
    expect(SETTINGS_CARD_HTML).not.toContain("activityCardView");
    expect(ACTIVITY_CARD_HTML).not.toContain("let viewMode=");
    expect(serialized).not.toContain("settings.cardView");
    expect(SETTINGS_CARD_HTML).toContain('id="completion-handoff"');
    expect(SETTINGS_CARD_HTML).toContain('id="projects-title"');
    expect(SETTINGS_CARD_HTML).toContain('id="project-list"');
    expect(SETTINGS_CARD_HTML).toContain('id="add-project" type="button"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="default-project"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="allowed-root-list"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="allowed-roots"');
    expect(SETTINGS_CARD_HTML).toContain('data-i18n="settings.resetHint"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="default-cwd"');
    expect(SETTINGS_CARD_HTML).not.toContain('className="project-id-input"');
    expect(SETTINGS_CARD_HTML).not.toContain('projectField("settings.projectId"');
    expect(serialized).not.toContain('settings.projectId');
    expect(serialized).not.toContain('settings.defaultProject');
    expect(serialized).not.toContain('settings.cwd');
    expect(SETTINGS_CARD_HTML).toContain("SETTINGS_REVISION_CONFLICT");
    expect(`${SETTINGS_CARD_HTML}${ACTIVITY_CARD_HTML}${DASHBOARD_CARD_HTML}${serialized}`)
      .not.toContain("MacBook Air");
  });

  it("localizes the stale-card recovery page from the browser locale", () => {
    const staleHtml = htmlForUiResource(
      "settings",
      "ui://codex-mcp-bridge/settings/not-retained.html",
      SETTINGS_CARD_HTML
    );
    expect(staleHtml).toContain("플러그인 새로고침 필요");
    expect(staleHtml).toContain('document.title=t["stale.title"]');
    expect(staleHtml).toContain("navigator.language");
    expect(staleHtml).not.toContain('<html lang="en">');
    expect(staleHtml).not.toContain("<title>Plugin refresh required</title>");
  });

  it("supports host locale updates, accessible controls, and standard/fallback app messaging", () => {
    for (const html of [SETTINGS_CARD_HTML, ACTIVITY_CARD_HTML, DASHBOARD_CARD_HTML]) {
      expect(html).toContain('dir="auto"');
      expect(html).toContain('"openai/locale"');
      expect(html).toContain('"webplus/i18n"');
      expect(html).toContain('window.openai.locale');
      expect(html).toContain("resolveHostUiLocaleTag(");
      expect(html).toContain('openai:set_globals');
      expect(html).not.toContain("openai/userLocation");
      expect(html).not.toMatch(/geolocation|navigator\.geolocation/i);
    }
    for (const html of [SETTINGS_CARD_HTML, ACTIVITY_CARD_HTML, DASHBOARD_CARD_HTML]) {
      expect(html).toContain("initialMetadata,navigator.language)");
    }
    expect(DASHBOARD_CARD_HTML).toContain('callTool("codex_dashboard_snapshot"');
    expect(DASHBOARD_CARD_HTML).toContain('id="dashboard-content" hidden');
    expect(DASHBOARD_CARD_HTML).toContain('data-i18n="common.loading"');
    expect(DASHBOARD_CARD_HTML).toContain("function normalizeHostToolResult");
    expect(DASHBOARD_CARD_HTML).toContain("mcp_tool_result");
    expect(DASHBOARD_CARD_HTML).toContain("standardBridgeReady=");
    expect(DASHBOARD_CARD_HTML).toContain("standardBridgeReady=beginStandardBridge()");
    expect(DASHBOARD_CARD_HTML).toContain("function standardToolCall(name,args)");
    expect(DASHBOARD_CARD_HTML).toContain("function callUiToolWithFallback");
    expect(DASHBOARD_CARD_HTML).toContain("STANDARD_CALL_BUDGET_MS");
    expect(DASHBOARD_CARD_HTML).toContain("compatibilityTimeoutMs:TOOL_CALL_TIMEOUT_MS");
    expect(DASHBOARD_CARD_HTML).not.toContain('typeof window.openai.callTool==="function"?Promise.resolve(false)');
    expect(DASHBOARD_CARD_HTML).not.toContain("__name");
    expect(DASHBOARD_CARD_HTML).toContain('message.method==="ui/notifications/tool-result"');
    expect(DASHBOARD_CARD_HTML).toContain("function render(next,localeReady=false,priority=0)");
    expect(DASHBOARD_CARD_HTML).toContain("async function reload(manual=false)");
    expect(DASHBOARD_CARD_HTML).not.toContain("projectOffset");
    expect(DASHBOARD_CARD_HTML).not.toContain("conversationOffset");
    expect(DASHBOARD_CARD_HTML).toContain("dashboard.refreshFailedRetained");
    expect(DASHBOARD_CARD_HTML).toContain("MCP_TOOL_CALL_DISPATCH_TIMEOUT");
    expect(DASHBOARD_CARD_HTML).not.toContain('id="view-project"');
    expect(DASHBOARD_CARD_HTML).not.toContain('id="view-conversation"');
    expect(DASHBOARD_CARD_HTML).not.toContain('id="view-status"');
    expect(DASHBOARD_CARD_HTML).not.toContain('id="project-view"');
    expect(DASHBOARD_CARD_HTML).not.toContain('id="conversation-view"');
    expect(DASHBOARD_CARD_HTML).not.toContain('id="status-view"');
    expect(DASHBOARD_CARD_HTML).toContain('id="status-idle-panel" hidden');
    expect(DASHBOARD_CARD_HTML).toContain("statusIdleExpanded=false");
    expect(DASHBOARD_CARD_HTML).toContain('id="status-idle-toggle"');
    expect(DASHBOARD_CARD_HTML).toContain('aria-expanded="false"');
    expect(DASHBOARD_CARD_HTML).toContain('id="terminal-more"');
    expect(DASHBOARD_CARD_HTML).toContain('id="idle-more"');
    expect(DASHBOARD_CARD_HTML).toContain('data-i18n="dashboard.loadMore"');
    expect(DASHBOARD_CARD_HTML).not.toContain('data-i18n="dashboard.previous"');
    expect(DASHBOARD_CARD_HTML).not.toContain('data-i18n="dashboard.next"');
    expect(DASHBOARD_CARD_HTML).toContain("async function loadMore(bucket)");
    expect(DASHBOARD_CARD_HTML).toContain("function mergeRows(current,incoming)");
    expect(DASHBOARD_CARD_HTML).toContain("function reconcileDashboardPageCaches(");
    expect(DASHBOARD_CARD_HTML).toContain("next.terminalPagination.offset > 0");
    expect(DASHBOARD_CARD_HTML).toContain("next.idlePagination.offset > 0");
    expect(DASHBOARD_CARD_HTML).not.toContain("dashboardViewMode");
    expect(DASHBOARD_CARD_HTML).not.toContain("api.setWidgetState");
    expect(DASHBOARD_CARD_HTML).toContain("render(unwrap(message.params),false,1)");
    expect(DASHBOARD_CARD_HTML).toContain('message.method==="ui/resource-teardown"');
    expect(DASHBOARD_CARD_HTML).toContain('window.addEventListener("pagehide"');
    expect(DASHBOARD_CARD_HTML).toContain('rpcNotification("ui/notifications/size-changed"');
    expect(DASHBOARD_CARD_HTML).toContain("notifyIntrinsicHeight");
    expect(DASHBOARD_CARD_HTML).toContain("new ResizeObserver");
    expect(DASHBOARD_CARD_HTML).toContain("new Intl.RelativeTimeFormat");
    expect(DASHBOARD_CARD_HTML).toContain("expandedHistories");
    expect(DASHBOARD_CARD_HTML).toContain('node("details","history")');
    expect(DASHBOARD_CARD_HTML).toContain(
      "function renderHistoryTurn(turn,key,showActivityTitle)"
    );
    expect(DASHBOARD_CARD_HTML).toContain("activityTitle!==previousActivityTitle");
    expect(DASHBOARD_CARD_HTML).toContain(
      'if(active)return turn.durationMs===null?t["dashboard.time.durationUnknown"]'
    );
    expect(DASHBOARD_CARD_HTML).not.toContain(
      'updated=t["dashboard.time.updated"].replace'
    );
    expect(DASHBOARD_CARD_HTML).toContain('else if(row.bucket!=="active")');
    expect(DASHBOARD_CARD_HTML).toContain("function renderAgentRows(parent,rows)");
    expect(DASHBOARD_CARD_HTML).toContain("function appendRowContext(parent,row)");
    expect(ACTIVITY_CARD_HTML).toContain(
      "function summaryText(row,includeUpdatedAt=false)"
    );
    expect(ACTIVITY_CARD_HTML).toContain(
      "renderActivityRow(row,showWorkspace,true)"
    );
    expect(ACTIVITY_CARD_HTML).toContain(
      "shouldShowHistoricalActivityTitle(activityTitle,item.latestActivityId,visibleActivityIds)"
    );
    expect(ACTIVITY_CARD_HTML).toContain(
      'rows.map((row)=>String(row&&row.activityId||"").trim())'
    );
    expect(DASHBOARD_CARD_HTML).not.toContain("function conversationGroups(rows)");
    expect(DASHBOARD_CARD_HTML).not.toContain("function projectGroups(rows)");
    expect(DASHBOARD_CARD_HTML).not.toContain("function renderConversationGroups");
    expect(DASHBOARD_CARD_HTML).not.toContain("function renderProjectGroups");
    expect(DASHBOARD_CARD_HTML).not.toContain('node("section","conversation-group")');
    expect(DASHBOARD_CARD_HTML).toContain('node("a","conversation-link"');
    expect(DASHBOARD_CARD_HTML).toContain(
      'node("a","conversation-link codex-session-link"'
    );
    expect(DASHBOARD_CARD_HTML).toContain('link.rel="noopener noreferrer"');
    expect(DASHBOARD_CARD_HTML).toContain("function dispatchDashboardExternalUrl(");
    expect(DASHBOARD_CARD_HTML).toContain(
      "dispatchDashboardExternalUrl(event,url,window.openai,openConversationFallback)"
    );
    expect(DASHBOARD_CARD_HTML).toContain("safeConversationUrl(row.conversationUrl)");
    expect(DASHBOARD_CARD_HTML).toContain("safeCodexThreadUrl(row.codexThreadUrl)");
    expect(DASHBOARD_CARD_HTML).not.toContain("const values=[row.sessionAlias,row.projectName]");
    expect(DASHBOARD_CARD_HTML).toContain("turn.durationMs");
    expect(DASHBOARD_CARD_HTML).toContain("lastRenderedAt");
    expect(DASHBOARD_CARD_HTML).toContain("lastRenderPriority");
    expect(DASHBOARD_CARD_HTML).toContain('window.addEventListener("pageshow"');
    expect(DASHBOARD_CARD_HTML).toContain('role="status" aria-live="polite"');
    expect(DASHBOARD_CARD_HTML).not.toContain("setInterval(");
    expect(DASHBOARD_CARD_HTML).not.toContain("localStorage");
    expect(DASHBOARD_CARD_CONTENT_METADATA["openai/widgetCSP"].redirect_domains)
      .toEqual(["https://chatgpt.com", "codex://threads"]);
    expect(DASHBOARD_CARD_HTML.indexOf('data-i18n="dashboard.active"'))
      .toBeLessThan(DASHBOARD_CARD_HTML.indexOf('data-i18n="dashboard.recent"'));
    expect(DASHBOARD_CARD_HTML.indexOf('data-i18n="dashboard.recent"'))
      .toBeLessThan(DASHBOARD_CARD_HTML.indexOf('data-i18n="dashboard.idle"'));
    expect(SETTINGS_CARD_HTML).toContain('role="status"');
    expect(SETTINGS_CARD_HTML).toContain('id="ui-language"');
    expect(SETTINGS_CARD_HTML).toContain(
      'class="notice experimental-notice" data-i18n="settings.appServerExperimental"'
    );
    expect(SETTINGS_CARD_HTML).toContain("uiLocalePreference");
    expect(SETTINGS_CARD_HTML).toContain("Settings card unmounted");
    expect(SETTINGS_CARD_HTML).toContain('rpcRequest("ui/initialize"');
    expect(SETTINGS_CARD_HTML).toContain('rpcNotification("ui/notifications/initialized"');
    expect(SETTINGS_CARD_HTML).toContain('message.method==="ui/notifications/host-context-changed"');
    expect(SETTINGS_CARD_HTML).toContain("new Error(uiBridgeErrorMessage(message.error");
    expect(SETTINGS_CARD_HTML).not.toContain("new Error(message.error.message");
    expect(SETTINGS_CARD_HTML).toContain(
      'id="policy-effort" required aria-describedby="effort-description effort-compatibility"'
    );
    expect(SETTINGS_CARD_HTML).toContain('id="effort-description" aria-live="polite"');
    expect(SETTINGS_CARD_HTML).toContain("option(effort,effortPresentation(effort).label)");
    expect(SETTINGS_CARD_HTML).toContain('id="allowed-models"');
    expect(SETTINGS_CARD_HTML).toContain('id="effort-groups"');
    expect(SETTINGS_CARD_HTML).toContain('id="preferred-model" required');
    expect(SETTINGS_CARD_HTML).toContain('id="preferred-effort" required');
    expect(SETTINGS_CARD_HTML).not.toContain('id="preferred-selection"');
    expect(SETTINGS_CARD_HTML).toContain("currentPreferredSelection()");
    expect(SETTINGS_CARD_HTML).toContain("if(!fallbackSelection)throw new Error");
    expect(SETTINGS_CARD_HTML).not.toContain('preferredModel.replaceChildren(option(""');
    expect(SETTINGS_CARD_HTML).toContain("modelDisplayName(modelId)");
    expect(SETTINGS_CARD_HTML).not.toContain('selection.model+"]"');
    expect(SETTINGS_CARD_HTML).toContain("usePriorityServiceTier:elements.priority.checked");
    expect(SETTINGS_CARD_HTML).toContain("projectOperations=buildProjectOperations(projectSettings.projects)");
    expect(SETTINGS_CARD_HTML).not.toContain("defaultProjectId");
    expect(SETTINGS_CARD_HTML).toContain('operation:{kind:"patch",settings}');
    expect(SETTINGS_CARD_HTML).toContain("limits.projectAvailability");
    expect(SETTINGS_CARD_HTML).not.toContain("allocateProjectId");
    expect(SETTINGS_CARD_HTML).toContain("if(project.id)row.dataset.projectId=project.id");
    expect(SETTINGS_CARD_HTML).toContain('row.querySelector(".project-label-input").focus()');
    expect(SETTINGS_CARD_HTML).not.toContain("PROJECT_DUPLICATE_ID");
    expect(SETTINGS_CARD_HTML).toContain("PROJECT_CWD_CONFLICT");
    expect(SETTINGS_CARD_HTML).toContain('{kind:"archive",projectId:project.id}');
    expect(SETTINGS_CARD_HTML).toContain('{kind:"restore",projectId:project.id');
    expect(SETTINGS_CARD_HTML).toContain('{kind:"delete",projectId:project.id}');
    expect(SETTINGS_CARD_HTML).toContain('confirm(t["settings.deleteProjectConfirm"])');
    expect(SETTINGS_CARD_HTML).toContain('t["settings.removeProject"]');
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
    expect(SETTINGS_CARD_HTML).toContain('id="catalog-status" role="status"');
    expect(SETTINGS_CARD_HTML).toContain('id="catalog-status-label"');
    expect(SETTINGS_CARD_HTML).toContain('id="catalog-status-source"');
    expect(SETTINGS_CARD_HTML).toContain('elements.catalogStatus.dataset.state=catalogState');
    expect(UI_TRANSLATIONS.en["settings.catalogStatus.valid"]).toBe("Model catalog valid");
    expect(UI_TRANSLATIONS.ko["settings.catalogStatus.valid"]).toBe("모델 카탈로그 정상");
    expect(SETTINGS_CARD_HTML).not.toContain('id="refresh"');
    expect(SETTINGS_CARD_HTML).toContain('aria-describedby="access-hint full-warning"');
    expect(SETTINGS_CARD_HTML).toContain('elements.fullWarning.classList.toggle("show",value==="always-full")');
    expect(SETTINGS_CARD_HTML.indexOf('id="full-warning"')).toBeLessThan(
      SETTINGS_CARD_HTML.indexOf('id="model-policy-mode"')
    );
    expect(SETTINGS_CARD_HTML).toContain('elements.retryModels.hidden=!catalogProblem');
    expect(SETTINGS_CARD_HTML).toContain(
      "next.policyActivation.developerModeRefreshRequired"
    );
    expect(SETTINGS_CARD_HTML).toContain('t["settings.developerModeRefreshRequired"]');
    expect(SETTINGS_CARD_HTML).not.toContain("setInterval(");
    expect(ACTIVITY_CARD_HTML).toContain("function displayAgentName(value)");
    expect(ACTIVITY_CARD_HTML).toContain('t["activity.defaultAgent"]:name');
    expect(ACTIVITY_CARD_HTML).toContain('return model+" · "+execution.reasoningEffort');
    expect(ACTIVITY_CARD_HTML).toContain('text=prefix+executionText(execution)');
    expect(ACTIVITY_CARD_HTML).not.toContain(
      't["activity.reasoningEffort"]+" "+execution.reasoningEffort'
    );
    expect(ACTIVITY_CARD_HTML).not.toContain('prefix+label+" · "+executionText(execution)');
    expect(ACTIVITY_CARD_HTML).toContain('aria-live="polite"');
    expect(ACTIVITY_CARD_HTML).not.toContain('document.createElement("datalist")');
    expect(ACTIVITY_CARD_HTML).not.toContain("<details");
    expect(ACTIVITY_CARD_HTML).toContain("<body hidden>");
    expect(ACTIVITY_CARD_HTML).toContain(".card{border:0;border-radius:0;background:transparent}");
    expect(ACTIVITY_CARD_HTML).toContain("next.feed");
    expect(ACTIVITY_CARD_HTML).toContain("renderHistorySummary(next.feed)");
    expect(ACTIVITY_CARD_HTML).toContain("renderFullHistory(next.feed,showWorkspace)");
    expect(ACTIVITY_CARD_HTML).toContain('renderGroup("idle",feed.idleAgents');
    expect(ACTIVITY_CARD_HTML).not.toContain('renderGroup("completed",next.feed.completed');
    expect(ACTIVITY_CARD_HTML).not.toContain('renderGroup("ended",next.feed.ended');
    expect(ACTIVITY_CARD_HTML).toContain(
      "renderHistoryRow(item,kind,showWorkspace,visibleActivityIds)"
    );
    expect(ACTIVITY_CARD_HTML).toContain("Boolean(next.feed.showWorkspaceLabels)");
    expect(ACTIVITY_CARD_HTML).toContain("summary.push(...(item.workspaceLabels||[]))");
    expect(ACTIVITY_CARD_HTML).toContain("appendExecutions(identity,agents,agents.length>1)");
    expect(ACTIVITY_CARD_HTML).toContain("appendExecutions(content,[item],false)");
    expect(ACTIVITY_CARD_HTML).toContain(
      'if(value==="waiting-gpt"||value==="verification")return t["activity.workComplete"]'
    );
    expect(ACTIVITY_CARD_HTML).toContain(
      '["completed","waiting-gpt","verification"].includes(state))return"completed"'
    );
    expect(ACTIVITY_CARD_HTML).not.toContain(
      'row.displayState==="waiting-gpt")parts.push(t["waiting.orchestrator"]'
    );
    expect(ACTIVITY_CARD_HTML).not.toContain('parts.push(t["activity.gptVerificationNeeded"])');
    expect(ACTIVITY_CARD_HTML).toContain("execution.modelDisplayName||execution.model");
    expect(ACTIVITY_CARD_HTML).toContain(
      "execution.reroutedModelDisplayName||execution.reroutedModel"
    );
    expect(ACTIVITY_CARD_HTML).not.toContain('t["activity.reasoningEffort"]');
    expect(ACTIVITY_CARD_HTML).toContain(".execution-list{");
    expect(ACTIVITY_CARD_HTML).toContain('aria-expanded');
    expect(ACTIVITY_CARD_HTML).toContain("activity.currentActivities");
    expect(ACTIVITY_CARD_HTML).toContain("activity.allActivities");
    expect(ACTIVITY_CARD_HTML).toContain("activity.previousPage");
    expect(ACTIVITY_CARD_HTML).toContain("activity.nextPage");
    expect(ACTIVITY_CARD_HTML).toContain("function previousFailureText(row)");
    expect(ACTIVITY_CARD_HTML).toContain('count>0&&row.displayState!=="failed"');
    expect(UI_TRANSLATIONS.ko["activity.previousFailures"]).toBe("이전 실패 {count}건");
    expect(UI_TRANSLATIONS.ko["activity.forceStop"]).toBe("에이전트 강제 종료…");
    expect(UI_TRANSLATIONS.ko["activity.stopBackground"]).toBe("백그라운드 프로세스 종료…");
    for (const locale of SUPPORTED_UI_LOCALES) {
      expect(UI_TRANSLATIONS[locale]["activity.previousFailures"]).toContain("{count}");
    }
    expect(UI_TRANSLATIONS.ko["activity.pastRecords"]).toBe("지난 기록");
    expect(UI_TRANSLATIONS.ko["activity.completedActivities"]).toBe("완료 작업");
    expect(ACTIVITY_CARD_HTML).not.toContain('next.viewMode==="activity-summary"');
    expect(ACTIVITY_CARD_HTML).not.toContain("renderActivities(next)");
    expect(ACTIVITY_CARD_HTML).not.toContain("renderAgents(next)");
    expect(ACTIVITY_CARD_HTML).not.toContain('callTool("codex_agent"');
    expect(ACTIVITY_CARD_HTML).toContain('callTool("codex_background_process_terminate"');
    expect(ACTIVITY_CARD_HTML).toContain("expectedAgentVersion:control.agentVersion");
    expect(ACTIVITY_CARD_HTML).toContain('rpcRequest("ui/message"');
    expect(ACTIVITY_CARD_HTML).toContain("sendFollowUpMessage");
    expect(ACTIVITY_CARD_HTML).toContain('async function reload(){const card=cardProof(),args={card,limit:viewLimit}');
    expect(ACTIVITY_CARD_HTML).toContain('if(card.presentation.kind==="explicit"&&historyCursor)args.cursor=historyCursor');
    expect(ACTIVITY_CARD_HTML).toContain(
      'callTool("codex_activity_rehydrate",{jobId:correlation.jobId'
    );
    expect(ACTIVITY_CARD_HTML).toContain('callTool("codex_interaction_respond"');
    expect(ACTIVITY_CARD_HTML).toContain('callTool("codex_activity_handoff",{action:"claim-batch"');
    expect(ACTIVITY_CARD_HTML).toContain("For every listed Job ID");
    expect(ACTIVITY_CARD_HTML).toContain("Activity and overview queries never contain Job answers");
    expect(ACTIVITY_CARD_HTML).toContain("Do not start another codex_task merely to reconstruct");
    expect(ACTIVITY_CARD_HTML).not.toContain('callTool("codex_status",Object.assign({activityView:true');
    expect(ACTIVITY_CARD_HTML).toContain("consumeToolOutput");
    expect(ACTIVITY_CARD_HTML).toContain("codex/activityBootstrap@11");
    expect(ACTIVITY_CARD_HTML).toContain("codex/activityView@11");
    expect(ACTIVITY_CARD_HTML).toContain('bootstrap.kind!=="codex/activityBootstrap"');
    expect(ACTIVITY_CARD_HTML).toContain('view.kind==="codex/activityView"');
    expect(ACTIVITY_CARD_HTML).toContain("return{requestId:correlation.requestId,bridgeActivity:");
    expect(ACTIVITY_CARD_HTML).toContain("privateOutput||result&&result.structuredContent||result");
    expect(ACTIVITY_CARD_HTML).toContain(
      "if(initialPrivateOutput)consumeToolOutput(initialPrivateOutput);else if"
    );
    expect(ACTIVITY_CARD_HTML).toContain('rpcRequest("ui/initialize"');
    expect(ACTIVITY_CARD_HTML).toContain('rpcNotification("ui/notifications/initialized"');
    expect(ACTIVITY_CARD_HTML).toContain('rpcNotification("ui/notifications/size-changed",{width,height})');
    expect(ACTIVITY_CARD_HTML).toContain("widgetInstanceId=crypto.randomUUID()");
    expect(ACTIVITY_CARD_HTML).toContain("Object.assign({},args,{widgetInstanceId})");
    expect(ACTIVITY_CARD_HTML).toContain('dataset.collapsed=visible?"false":"true"');
    expect(ACTIVITY_CARD_HTML).toContain('dataset.collapsed==="true")return 1');
    expect(ACTIVITY_CARD_HTML).toContain('value.method==="ui/notifications/tool-input"');
    expect(ACTIVITY_CARD_HTML).toContain("rememberToolInput");
    expect(ACTIVITY_CARD_HTML).toContain("taskInputRequestId!==outputRequestId");
    expect(ACTIVITY_CARD_HTML).toContain('next.kind==="task"');
    expect(ACTIVITY_CARD_HTML).toContain('const key="historical\\u0000"+next.jobId');
    expect(ACTIVITY_CARD_HTML).toContain(
      'historicalCorrelation={jobId:next.jobId,requestId:next.requestId}'
    );
    expect(ACTIVITY_CARD_HTML).toContain("next.bridgeSession.requestId");
    expect(ACTIVITY_CARD_HTML).toContain("next.bridgeActivity||next.activityTracking");
    expect(ACTIVITY_CARD_HTML).toContain("presentation.shouldRenderActivityCard");
    expect(ACTIVITY_CARD_HTML).toContain("AUTOMATIC_BOOTSTRAP_REASONS.has(presentation.renderReason)");
    expect(ACTIVITY_CARD_HTML).toContain('"render-reserved","render-confirmed","active-lease"');
    expect(ACTIVITY_CARD_HTML).toContain('"render-retry","render-latest"');
    expect(ACTIVITY_CARD_HTML).toContain("activityPresentationId+\"\\u0000\"");
    expect(ACTIVITY_CARD_HTML).toContain("if(taskBootstrapKey===key)return true");
    expect(ACTIVITY_CARD_HTML).toContain("setCardVisible(false);void reload().catch(showError)");
    expect(ACTIVITY_CARD_HTML).toContain('presentation.presentationKind!=="automatic"');
    expect(ACTIVITY_CARD_HTML).toContain("activityPresentationId");
    expect(ACTIVITY_CARD_HTML).toContain("reservationOwnerId");
    expect(ACTIVITY_CARD_HTML).toContain("next.watcherPolicy.live===false");
    expect(ACTIVITY_CARD_HTML).toContain(
      'next.watcherPolicy.stopReason==="presentation-duplicate"'
    );
    expect(ACTIVITY_CARD_HTML).toContain(
      "snapshot=null;historicalCorrelation=null;historyCursor=null;setCardVisible(false);return"
    );
    expect(ACTIVITY_CARD_HTML).toContain('presentation.kind==="historical"');
    expect(ACTIVITY_CARD_HTML).toContain('readOnly=historicalView()');
    expect(ACTIVITY_CARD_HTML).toContain('message.textContent=historicalView()?t["activity.historicalSnapshot"]');
    expect(ACTIVITY_CARD_HTML).toContain('const action=historicalView()?promoteHistorical():reload()');
    expect(ACTIVITY_CARD_HTML).toContain('presentation:{kind:"explicit"}');
    expect(ACTIVITY_CARD_HTML).toContain("snapshot.watcherPolicy.ownsCompletionHandoff===false");
    expect(ACTIVITY_CARD_HTML).not.toContain('callTool("codex_activity"');
    expect(ACTIVITY_CARD_HTML).toContain("Activity card unmounted");
    expect(ACTIVITY_CARD_HTML).toContain("next.uiLocalePreference");
    expect(UI_TRANSLATIONS.en["activity.historicalSnapshot"]).toContain("Historical snapshot");
    expect(UI_TRANSLATIONS.ko["activity.openLive"]).toBe("실시간 Activity 열기");
  });

  it("deduplicates historical Activity titles by Activity identity, not title text", () => {
    const visibleActivityIds = new Set(["activity-visible"]);
    expect(shouldShowHistoricalActivityTitle(
      "Repeated title",
      "activity-visible",
      visibleActivityIds
    )).toBe(false);
    expect(shouldShowHistoricalActivityTitle(
      "Repeated title",
      "different-activity",
      visibleActivityIds
    )).toBe(true);
    expect(shouldShowHistoricalActivityTitle(
      "Repeated title",
      undefined,
      visibleActivityIds
    )).toBe(true);
    expect(shouldShowHistoricalActivityTitle("", "different-activity", visibleActivityIds))
      .toBe(false);
  });

  it("dispatches Dashboard deep links through the host and falls back on host failure", async () => {
    const url = "codex://threads/41414141-4141-4141-8141-414141414141";
    const preventDefault = vi.fn();
    const fallback = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);

    expect(dispatchDashboardExternalUrl(
      { preventDefault },
      url,
      { openExternal },
      fallback
    )).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith({ href: url, redirectUrl: false });
    expect(fallback).not.toHaveBeenCalled();

    const rejectedFallback = vi.fn();
    dispatchDashboardExternalUrl(
      { preventDefault: vi.fn() },
      url,
      { openExternal: () => Promise.reject(new Error("host rejected deep link")) },
      rejectedFallback
    );
    await vi.waitFor(() => expect(rejectedFallback).toHaveBeenCalledWith(url));

    const nativeNavigation = { preventDefault: vi.fn() };
    expect(dispatchDashboardExternalUrl(nativeNavigation, url, undefined, fallback)).toBe(false);
    expect(nativeNavigation.preventDefault).not.toHaveBeenCalled();
  });

  it("preserves nested host and project errors instead of rendering object coercions", () => {
    expect(uiBridgeErrorMessage({
      code: -32603,
      message: {
        code: "PROJECT_CWD_NOT_ALLOWED",
        message: "The selected folder is unavailable."
      }
    }, "fallback")).toBe(
      "PROJECT_CWD_NOT_ALLOWED: The selected folder is unavailable."
    );
    expect(uiBridgeErrorMessage({
      error: {
        content: [{ type: "text", text: "PROJECT_CWD_CONFLICT: Duplicate project cwd." }]
      }
    }, "fallback")).toBe("PROJECT_CWD_CONFLICT: Duplicate project cwd.");
    expect(uiBridgeErrorMessage(new Error("[object Object]"), "fallback")).toBe("fallback");

    const circular: Record<string, unknown> = {};
    circular.error = circular;
    expect(uiBridgeErrorMessage(circular, "fallback")).toBe("fallback");
  });
});
