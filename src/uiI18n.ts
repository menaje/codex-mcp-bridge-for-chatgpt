export const SUPPORTED_UI_LOCALES = [
  "en",
  "ko",
  "ja",
  "zh-Hans",
  "zh-Hant",
  "es",
  "fr",
  "de",
  "pt"
] as const;

export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number];
export const UI_LOCALE_PREFERENCES = ["auto", ...SUPPORTED_UI_LOCALES] as const;
export type UiLocalePreference = (typeof UI_LOCALE_PREFERENCES)[number];

const ENGLISH = {
  "common.loading": "Loading…",
  "common.refresh": "Refresh",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.error": "The request failed.",
  "settings.title": "Codex Bridge settings",
  "settings.scope": "Shared by every conversation using this bridge connection.",
  "settings.access": "Access strategy",
  "settings.access.readOnly": "Always read-only",
  "settings.access.adaptive": "GPT chooses per task",
  "settings.access.full": "Always full access",
  "settings.access.readOnlyHint": "Every new task is forced to read-only.",
  "settings.access.adaptiveHint": "GPT may choose read-only, workspace write, or full access within the allowed limits.",
  "settings.access.fullHint": "Every new task is forced to danger-full-access.",
  "settings.fullWarning": "Full access runs Codex with this macOS user's filesystem and network permissions. Allowed roots limit only the starting directory; they are not OS isolation.",
  "settings.modelPolicy": "Execution model policy",
  "settings.modelPolicy.fixed": "Fixed",
  "settings.modelPolicy.automatic": "Automatic selection",
  "settings.allowDelegation": "Allow Ultra reasoning and subagent delegation",
  "settings.model": "Model",
  "settings.modelDefault": "Codex default model",
  "settings.modelHint": "Exact identifier from the active backend catalog.",
  "settings.savedModel": "currently saved",
  "settings.effort": "Reasoning effort",
  "settings.effortDefault": "Model default effort",
  "settings.effortHint": "Only values supported by the selected model are shown.",
  "settings.effortFallbackDescription": "A newly available reasoning level. Availability and behavior come from the current Codex model catalog.",
  "settings.unsupportedEffort": "The saved reasoning level is no longer supported. Suggested model default:",
  "effort.minimal.label": "Minimal", "effort.minimal.description": "Fastest responses with only essential reasoning.",
  "effort.low.label": "Low", "effort.low.description": "Quick responses with lighter reasoning.",
  "effort.medium.label": "Medium", "effort.medium.description": "Balanced reasoning depth and response time.",
  "effort.high.label": "High", "effort.high.description": "Deeper review for complex work with a longer response time.",
  "effort.xhigh.label": "Extra high", "effort.xhigh.description": "Very deep reasoning for difficult tasks; responses can take substantially longer.",
  "effort.max.label": "Maximum", "effort.max.description": "Maximum available reasoning depth for demanding work.",
  "effort.ultra.label": "Ultra", "effort.ultra.description": "Extended reasoning and delegation for the most demanding work.",
  "settings.serviceTier": "Service tier",
  "settings.serviceTier.default": "Backend default tier",
  "settings.usePriority": "Use Priority (Fast processing)",
  "settings.usePriorityHint": "Applied privately by the bridge when Codex is called. GPT selects only the model and reasoning effort.",
  "settings.fixedNotice": "This exact selection is enforced for Codex turns admitted after saving. An already active turn keeps its admission-time decision.",
  "settings.allowedScope": "Allowed range",
  "settings.allowedScope.catalog": "All catalog-visible selections",
  "settings.allowedScope.explicit": "Explicit exact selections",
  "settings.allowedExactSelections": "Select models first, then choose the reasoning efforts allowed for each model.",
  "settings.allowedModels": "Models",
  "settings.effortsByModel": "Reasoning efforts by selected model",
  "settings.selectAllEfforts": "All",
  "settings.partialEffortsSelected": "Some efforts are selected.",
  "settings.additionalServiceTiers": "Additional service-tier variants",
  "settings.selectionCount": "{count} exact selections",
  "settings.preferredSelection": "Preferred selection",
  "settings.preferred.none": "Validated backend default",
  "settings.automaticNotice": "GPT may select only a model and reasoningEffort from this range. Priority is applied privately by the bridge and is never exposed as a GPT choice. Catalog-visible mode automatically includes newly discovered model/effort choices.",
  "settings.selectionRequired": "Choose an exact model and reasoning effort.",
  "settings.explicitRequired": "Select at least one allowed exact selection.",
  "settings.modelEffortRequired": "Choose at least one reasoning effort for {model}.",
  "settings.cwd": "Default working folder",
  "settings.cwdHint": "Only allowed working roots can be saved:",
  "settings.projects": "Projects",
  "settings.projectsHint": "Register named folders here. Project IDs are stable routing keys; labels and folders can be edited.",
  "settings.allowedRoots": "Bridge-allowed roots",
  "settings.allowedRootsHint": "Projects must resolve inside one of these security ceilings. Registering a project cannot widen them.",
  "settings.addProject": "Add project",
  "settings.noProjects": "No projects are registered. Add one before starting new work when no compatibility default is available.",
  "settings.projectId": "Project ID",
  "settings.projectIdHint": "Saved project IDs are stable. Remove and add a project only when a new identity is intended.",
  "settings.projectLabel": "Display label",
  "settings.projectCwd": "Absolute folder",
  "settings.defaultProject": "Optional default project",
  "settings.defaultProjectHint": "With multiple projects, this is the compatibility default. Choosing none requires an explicit project once project-aware task routing is enabled.",
  "settings.defaultProjectNone": "No default project",
  "settings.projectAvailable": "Available",
  "settings.projectUnavailable": "Needs recovery",
  "settings.projectNew": "New",
  "settings.removeProject": "Remove",
  "settings.projectInvalidId": "Use 1–64 lowercase ASCII letters or digits separated by hyphens. Spaces and underscores are normalized.",
  "settings.projectInvalidLabel": "Enter 1–120 printable Unicode characters for the project label.",
  "settings.projectInvalidCwd": "Enter an existing absolute folder inside a bridge-allowed root.",
  "settings.projectDuplicateId": "Project IDs must be unique after normalization.",
  "settings.projectDuplicatePath": "Each project must use a different canonical folder.",
  "settings.projectDefaultMissing": "Choose a default that still exists in the project list, or choose no default.",
  "settings.projectUnavailableSave": "Fix or remove every project that needs recovery before saving.",
  "settings.projectLimit": "At most 100 projects can be registered.",
  "settings.projectError": "Review the Projects section and correct the highlighted values.",
  "settings.language": "Interface language",
  "settings.language.auto": "Automatic",
  "settings.languageHint": "Automatic follows the host application's language.",
  "settings.concurrency": "Maximum concurrent jobs",
  "settings.cardVisibility": "Activity card",
  "settings.cardVisibility.always": "One card per GPT response",
  "settings.cardVisibility.background": "One card per response with background work",
  "settings.cardVisibility.never": "No automatic cards",
  "settings.handoff": "Completion handoff",
  "settings.handoff.off": "Off",
  "settings.handoff.auto": "Automatic GPT handoff while card is open",
  "settings.handoffRequiresCard": "Automatic handoff requires a visible Activity card.",
  "settings.conflict": "Settings changed elsewhere. The latest values were loaded; review them and save again.",
  "settings.save": "Save settings",
  "settings.refreshModels": "Retry model lookup",
  "settings.reset": "Restore default settings",
  "settings.saving": "Saving…",
  "settings.saved": "Saved.",
  "settings.refreshing": "Retrying model lookup…",
  "settings.refreshed": "Model list loaded.",
  "settings.resetting": "Restoring…",
  "settings.resetDone": "Default settings restored.",
  "settings.invalidResponse": "The settings tool returned an invalid response.",
  "settings.sharedNotice": "These settings are shared by all conversations using this bridge instance, not stored per ChatGPT account. Bridge security policy cannot be changed here.",
  "activity.title": "Codex activities",
  "activity.currentActivities": "Current activity",
  "activity.noCurrent": "No current Codex activity in this conversation.",
  "activity.completedCodex": "Completed Codex",
  "activity.completedWork": "Completed work",
  "activity.idleCodex": "Idle Codex",
  "activity.endedCodex": "Ended Codex",
  "activity.turns": "turns",
  "activity.continued": "Continued work",
  "activity.reviewComplete": "Review complete",
  "activity.workComplete": "Codex work complete",
  "activity.gptVerificationNeeded": "GPT verification needed",
  "activity.verify": "Verify",
  "activity.retry": "Retry",
  "activity.followUpSent": "A GPT follow-up was added to this conversation.",
  "activity.moreActivities": "Additional completed activities:",
  "activity.running": "Running",
  "activity.attention": "Needs attention",
  "activity.verification": "Ready for verification",
  "activity.failed": "Failed",
  "activity.empty": "No activities in this conversation yet.",
  "activity.forceStop": "Force stop…",
  "activity.forceConfirmTitle": "Force-stop Codex?",
  "activity.forceConfirm": "This sends TERM and automatically escalates to KILL for the exact tracked worker process group. Shared-worker jobs may be interrupted, and filesystem changes are not rolled back.",
  "activity.forceStopping": "Force-stopping…",
  "activity.forceStopped": "Worker termination was confirmed.",
  "activity.viewDetails": "View details",
  "activity.hideDetails": "Hide details",
  "activity.updated": "Updated",
  "activity.noSignal": "No recent progress signal; process liveness is unknown.",
  "activity.terminating": "Confirming worker process exit…",
  "activity.terminationFailed": "Worker termination could not be confirmed.",
  "activity.unread": "Unread completion",
  "activity.manualRefresh": "Live updates paused; refresh manually.",
  "activity.superseded": "A newer Activity card now owns live updates. This snapshot will remain available.",
  "activity.partialChanges": "Force stop does not roll back changes already written to disk.",
  "activity.jobs": "jobs",
  "activity.threads": "threads",
  "activity.events": "Recent activity",
  "activity.noEvents": "No public progress events yet.",
  "activity.approval": "Codex needs your approval",
  "activity.approve": "Approve",
  "activity.decline": "Decline",
  "activity.answer": "Send answer",
  "activity.steer": "Guide active turn",
  "activity.steerPlaceholder": "Add guidance to this active Codex turn…",
  "activity.orphaned": "The bridge restarted and can no longer track the original execution.",
  "activity.workerLost": "The tracked worker process exited.",
  "activity.inputRequired": "Input required",
  "activity.agents": "Codex agents",
  "activity.noAgents": "No Codex agents in this conversation yet.",
  "activity.idleAgents": "Idle agents",
  "activity.archivedAgents": "Archived agents",
  "activity.temporaryJob": "Starting agent",
  "activity.currentActivity": "Current Activity",
  "activity.elapsed": "Elapsed",
  "activity.lastChanged": "Last changed",
  "activity.showMore": "Show more",
  "activity.archive": "Archive",
  "activity.restore": "Restore",
  "activity.rename": "Rename",
  "activity.detach": "Detach from Activity",
  "activity.renamePrompt": "Enter a new agent name.",
  "activity.archiveConfirm": "Archive this idle agent? Its thread history is preserved.",
  "activity.archiveConflict": "This agent cannot be archived while a turn, approval, or input request is active.",
  "activity.backgroundProcesses": "Background processes still running",
  "activity.backgroundUnavailable": "Background process state is unavailable",
  "activity.stopBackground": "Stop background processes…",
  "activity.backgroundConfirm": "Stop all background processes left by this agent? Filesystem changes are not rolled back.",
  "activity.backgroundArchiveConflict": "Stop remaining background processes before archiving this agent.",
  "activity.agentId": "Agent ID",
  "agent.idle": "Idle", "agent.active": "Active", "agent.waiting-input": "Waiting for input", "agent.archived": "Archived", "agent.orphaned": "Thread unavailable",
  "kind.discussion": "Discussion", "kind.investigation": "Investigation", "kind.review": "Review", "kind.implementation": "Implementation", "kind.other": "Other",
  "lifecycle.open": "Open", "lifecycle.sealed": "Sealed", "lifecycle.terminating": "Terminating", "lifecycle.completed": "Completed", "lifecycle.cancelled": "Cancelled", "lifecycle.abandoned": "Abandoned",
  "waiting.none": "No pending owner", "waiting.codex": "Waiting for Codex", "waiting.orchestrator": "Waiting for GPT", "waiting.user": "Waiting for user", "waiting.verification": "Waiting for verification",
  "verification.not-required": "Verification not required", "verification.pending": "Verification pending", "verification.verifying": "Verifying", "verification.verified": "Verified", "verification.failed": "Verification failed",
  "job.running": "Running", "job.terminating": "Force-stopping", "job.termination-failed": "Termination unconfirmed", "job.completed": "Completed", "job.failed": "Failed", "job.interrupted": "Interrupted", "job.cancelled": "Cancelled"
} as const;

type UiTranslationKey = keyof typeof ENGLISH;
type UiTranslationBundle = Record<UiTranslationKey, string>;

const OVERRIDES: Record<Exclude<SupportedUiLocale, "en">, Partial<UiTranslationBundle>> = {
  ko: {
    "settings.usePriority": "Priority 빠른 처리 사용",
    "settings.usePriorityHint": "Codex 호출 시 브리지가 내부적으로 적용합니다. GPT는 모델과 추론 에포트만 선택합니다.",
    "settings.language": "인터페이스 언어", "settings.language.auto": "자동", "settings.languageHint": "자동은 호스트 앱의 언어를 따릅니다.",
    "common.loading": "불러오는 중…", "common.refresh": "새로고침", "common.cancel": "취소", "common.confirm": "확인", "common.error": "요청에 실패했습니다.",
    "settings.title": "Codex Bridge 설정", "settings.scope": "이 브리지 연결을 사용하는 모든 대화에 공유됩니다.", "settings.access": "접근 전략", "settings.access.readOnly": "항상 읽기 전용", "settings.access.adaptive": "GPT가 작업별 판단", "settings.access.full": "항상 전체 접근", "settings.access.readOnlyHint": "모든 새 작업을 읽기 전용으로 고정합니다.", "settings.access.adaptiveHint": "GPT가 허용된 범위 안에서 읽기 전용·작업공간 쓰기·전체 접근을 판단합니다.", "settings.access.fullHint": "모든 새 작업을 danger-full-access로 고정합니다.", "settings.fullWarning": "전체 접근은 이 macOS 사용자의 파일시스템·네트워크 권한으로 Codex를 실행합니다. 허용 루트는 시작 폴더만 제한하며 OS 격리가 아닙니다.",
    "settings.modelPolicy": "실행 모델 정책", "settings.modelPolicy.fixed": "고정", "settings.modelPolicy.automatic": "자동 선택", "settings.allowDelegation": "Ultra 추론과 하위 에이전트 위임 허용", "settings.model": "모델", "settings.modelDefault": "Codex 기본 모델", "settings.modelHint": "활성 백엔드 카탈로그의 정확한 식별자입니다.", "settings.savedModel": "현재 저장됨", "settings.effort": "추론 에포트", "settings.effortDefault": "모델 기본 에포트", "settings.effortHint": "선택한 모델이 지원하는 값만 표시합니다.", "settings.serviceTier": "서비스 티어", "settings.serviceTier.default": "백엔드 기본 티어", "settings.fixedNotice": "저장 이후 접수되는 Codex turn에는 이 exact selection이 강제됩니다. 이미 실행 중인 turn은 접수 시점 결정을 유지합니다.", "settings.allowedScope": "허용 범위", "settings.allowedScope.catalog": "카탈로그에 보이는 전체 selection", "settings.allowedScope.explicit": "명시적 exact selection", "settings.allowedExactSelections": "허용할 정확한 모델 / 추론 에포트 / 서비스 티어 조합", "settings.preferredSelection": "선호 selection", "settings.preferred.none": "검증된 백엔드 기본값", "settings.automaticNotice": "GPT는 허용 범위의 정확한 model과 reasoningEffort 조합만 전달할 수 있습니다. 표시 이름을 별칭으로 저장하지 않으며, 카탈로그 전체 모드는 새 selection을 자동 반영합니다.", "settings.selectionRequired": "정확한 모델과 추론 에포트를 선택하세요.", "settings.explicitRequired": "허용할 exact selection을 하나 이상 선택하세요.", "settings.cwd": "기본 작업 폴더", "settings.cwdHint": "허용된 작업 루트만 저장할 수 있습니다:", "settings.concurrency": "최대 동시 작업 수", "settings.cardVisibility": "Activity 카드", "settings.cardVisibility.always": "항상 표시", "settings.cardVisibility.background": "백그라운드 작업만 표시", "settings.cardVisibility.never": "자동으로 표시하지 않음", "settings.handoff": "완료 인계", "settings.handoff.off": "사용 안 함", "settings.handoff.auto": "카드가 열려 있을 때 GPT 자동 인계", "settings.handoffRequiresCard": "GPT 자동 인계에는 표시되는 Activity 카드가 필요합니다.", "settings.conflict": "다른 곳에서 설정이 변경되었습니다. 최신 값을 불러왔으니 확인한 뒤 다시 저장하세요.", "settings.save": "설정 저장", "settings.refreshModels": "모델 목록 새로고침", "settings.reset": "기본 설정으로 복원", "settings.saving": "저장 중…", "settings.saved": "저장했습니다.", "settings.refreshing": "새로고침 중…", "settings.refreshed": "모델 목록을 새로고침했습니다.", "settings.resetting": "복원 중…", "settings.resetDone": "기본 설정으로 복원했습니다.", "settings.invalidResponse": "설정 도구가 올바른 응답을 반환하지 않았습니다.", "settings.sharedNotice": "이 설정은 ChatGPT 계정별 값이 아니라 이 브리지 인스턴스를 사용하는 모든 대화에 공유됩니다. 브리지 보안 정책은 여기서 변경할 수 없습니다.",
    "activity.title": "Codex 활동", "activity.running": "진행 중", "activity.attention": "확인 필요", "activity.verification": "검증 대기", "activity.failed": "실패", "activity.empty": "이 대화에는 아직 Activity가 없습니다.", "activity.forceStop": "강제 종료…", "activity.forceConfirmTitle": "Codex를 강제 종료할까요?", "activity.forceConfirm": "추적 중인 정확한 worker process group에 TERM을 보내고 필요하면 KILL로 자동 승격합니다. 같은 worker의 작업이 함께 중단될 수 있고 파일 변경은 되돌리지 않습니다.", "activity.forceStopping": "강제 종료 중…", "activity.forceStopped": "worker 종료를 확인했습니다.", "activity.viewDetails": "상세 보기", "activity.hideDetails": "상세 닫기", "activity.updated": "업데이트", "activity.noSignal": "최근 진행 신호가 없습니다. 프로세스 생존 여부는 알 수 없습니다.", "activity.terminating": "worker 프로세스 종료를 확인 중…", "activity.terminationFailed": "worker 종료를 확인하지 못했습니다.", "activity.unread": "읽지 않은 완료", "activity.manualRefresh": "실시간 갱신을 멈췄습니다. 직접 새로고침하세요.", "activity.partialChanges": "강제 종료는 디스크에 이미 기록된 변경을 되돌리지 않습니다.", "activity.jobs": "작업", "activity.threads": "스레드", "activity.events": "최근 활동", "activity.noEvents": "아직 공개된 진행 이벤트가 없습니다.", "activity.approval": "Codex가 승인을 요청했습니다", "activity.approve": "승인", "activity.decline": "거부", "activity.answer": "답변 보내기", "activity.steer": "진행 중인 turn에 지시 추가", "activity.steerPlaceholder": "이 Codex turn에 추가할 지시…", "activity.orphaned": "브리지가 재시작되어 기존 실행을 더 이상 추적할 수 없습니다.", "activity.workerLost": "추적하던 worker 프로세스가 종료되었습니다.", "activity.inputRequired": "입력 필요"
  },
  ja: {
    "settings.language": "インターフェース言語", "settings.language.auto": "自動", "settings.languageHint": "自動ではホストアプリの言語に従います。",
    "common.loading": "読み込み中…", "common.refresh": "更新", "common.cancel": "キャンセル", "common.confirm": "確認", "settings.title": "Codex Bridge 設定", "settings.scope": "このブリッジ接続を使うすべての会話で共有されます。", "settings.access": "アクセス方式", "settings.model": "既定モデル", "settings.effort": "既定エフォート", "settings.cwd": "既定の作業フォルダー", "settings.concurrency": "最大同時ジョブ数", "settings.save": "設定を保存", "settings.refreshModels": "モデル一覧を更新", "settings.reset": "既定の設定に戻す", "activity.title": "Codex アクティビティ", "activity.running": "実行中", "activity.attention": "要確認", "activity.verification": "検証待ち", "activity.failed": "失敗", "activity.empty": "この会話にはまだアクティビティがありません。", "activity.forceStop": "強制終了…", "activity.forceConfirmTitle": "Codex を強制終了しますか？", "activity.forceConfirm": "追跡対象の worker process group に TERM を送り、必要なら KILL に自動昇格します。共有 worker のジョブが中断され、ファイル変更は元に戻りません。", "activity.forceStopping": "強制終了中…", "activity.viewDetails": "詳細を表示", "activity.hideDetails": "詳細を閉じる"
  },
  "zh-Hans": {
    "settings.language": "界面语言", "settings.language.auto": "自动", "settings.languageHint": "自动模式跟随宿主应用的语言。",
    "common.loading": "正在加载…", "common.refresh": "刷新", "common.cancel": "取消", "common.confirm": "确认", "settings.title": "Codex Bridge 设置", "settings.scope": "由使用此桥接连接的所有对话共享。", "settings.access": "访问策略", "settings.model": "默认模型", "settings.effort": "默认推理强度", "settings.cwd": "默认工作文件夹", "settings.concurrency": "最大并发任务数", "settings.save": "保存设置", "settings.refreshModels": "刷新模型列表", "settings.reset": "恢复默认设置", "activity.title": "Codex 活动", "activity.running": "运行中", "activity.attention": "需要处理", "activity.verification": "等待验证", "activity.failed": "失败", "activity.empty": "此对话中还没有活动。", "activity.forceStop": "强制停止…", "activity.forceConfirmTitle": "强制停止 Codex？", "activity.forceConfirm": "将向被跟踪的准确 worker process group 发送 TERM，并在需要时自动升级为 KILL。共享 worker 的任务可能中断，文件更改不会回滚。", "activity.forceStopping": "正在强制停止…", "activity.viewDetails": "查看详情", "activity.hideDetails": "收起详情"
  },
  "zh-Hant": {
    "settings.language": "介面語言", "settings.language.auto": "自動", "settings.languageHint": "自動模式會跟隨主控應用程式的語言。",
    "common.loading": "載入中…", "common.refresh": "重新整理", "common.cancel": "取消", "common.confirm": "確認", "settings.title": "Codex Bridge 設定", "settings.scope": "由使用此橋接連線的所有對話共用。", "settings.access": "存取策略", "settings.model": "預設模型", "settings.effort": "預設推理強度", "settings.cwd": "預設工作資料夾", "settings.concurrency": "最大並行工作數", "settings.save": "儲存設定", "settings.refreshModels": "重新整理模型清單", "settings.reset": "還原預設設定", "activity.title": "Codex 活動", "activity.running": "執行中", "activity.attention": "需要處理", "activity.verification": "等待驗證", "activity.failed": "失敗", "activity.empty": "此對話中尚無活動。", "activity.forceStop": "強制停止…", "activity.forceConfirmTitle": "強制停止 Codex？", "activity.forceConfirm": "將向追蹤中的正確 worker process group 傳送 TERM，必要時自動升級為 KILL。共用 worker 的工作可能中斷，檔案變更不會復原。", "activity.forceStopping": "正在強制停止…", "activity.viewDetails": "檢視詳細資料", "activity.hideDetails": "隱藏詳細資料"
  },
  es: {
    "settings.language": "Idioma de la interfaz", "settings.language.auto": "Automático", "settings.languageHint": "El modo automático sigue el idioma de la aplicación anfitriona.",
    "common.loading": "Cargando…", "common.refresh": "Actualizar", "common.cancel": "Cancelar", "common.confirm": "Confirmar", "settings.title": "Configuración de Codex Bridge", "settings.scope": "Compartida por todas las conversaciones que usan este puente.", "settings.access": "Estrategia de acceso", "settings.model": "Modelo predeterminado", "settings.effort": "Esfuerzo predeterminado", "settings.cwd": "Carpeta de trabajo predeterminada", "settings.concurrency": "Máximo de trabajos simultáneos", "settings.save": "Guardar configuración", "settings.refreshModels": "Actualizar modelos", "settings.reset": "Restaurar configuración predeterminada", "activity.title": "Actividades de Codex", "activity.running": "En curso", "activity.attention": "Requiere atención", "activity.verification": "Listo para verificar", "activity.failed": "Falló", "activity.empty": "Aún no hay actividades en esta conversación.", "activity.forceStop": "Forzar detención…", "activity.forceConfirmTitle": "¿Forzar la detención de Codex?", "activity.forceStopping": "Deteniendo…", "activity.viewDetails": "Ver detalles", "activity.hideDetails": "Ocultar detalles"
  },
  fr: {
    "settings.language": "Langue de l’interface", "settings.language.auto": "Automatique", "settings.languageHint": "Le mode automatique suit la langue de l’application hôte.",
    "common.loading": "Chargement…", "common.refresh": "Actualiser", "common.cancel": "Annuler", "common.confirm": "Confirmer", "settings.title": "Paramètres de Codex Bridge", "settings.scope": "Partagés par toutes les conversations utilisant ce pont.", "settings.access": "Stratégie d’accès", "settings.model": "Modèle par défaut", "settings.effort": "Effort par défaut", "settings.cwd": "Dossier de travail par défaut", "settings.concurrency": "Nombre maximal de tâches simultanées", "settings.save": "Enregistrer", "settings.refreshModels": "Actualiser les modèles", "settings.reset": "Rétablir les paramètres par défaut", "activity.title": "Activités Codex", "activity.running": "En cours", "activity.attention": "Attention requise", "activity.verification": "Prêt à vérifier", "activity.failed": "Échec", "activity.empty": "Aucune activité dans cette conversation.", "activity.forceStop": "Forcer l’arrêt…", "activity.forceConfirmTitle": "Forcer l’arrêt de Codex ?", "activity.forceStopping": "Arrêt forcé…", "activity.viewDetails": "Voir les détails", "activity.hideDetails": "Masquer les détails"
  },
  de: {
    "settings.language": "Oberflächensprache", "settings.language.auto": "Automatisch", "settings.languageHint": "Automatisch folgt der Sprache der Host-Anwendung.",
    "common.loading": "Wird geladen…", "common.refresh": "Aktualisieren", "common.cancel": "Abbrechen", "common.confirm": "Bestätigen", "settings.title": "Codex-Bridge-Einstellungen", "settings.scope": "Für alle Unterhaltungen mit dieser Bridge-Verbindung gemeinsam.", "settings.access": "Zugriffsstrategie", "settings.model": "Standardmodell", "settings.effort": "Standardaufwand", "settings.cwd": "Standard-Arbeitsordner", "settings.concurrency": "Maximale parallele Jobs", "settings.save": "Einstellungen speichern", "settings.refreshModels": "Modellliste aktualisieren", "settings.reset": "Standardeinstellungen wiederherstellen", "activity.title": "Codex-Aktivitäten", "activity.running": "Läuft", "activity.attention": "Aufmerksamkeit erforderlich", "activity.verification": "Bereit zur Prüfung", "activity.failed": "Fehlgeschlagen", "activity.empty": "Noch keine Aktivitäten in dieser Unterhaltung.", "activity.forceStop": "Stopp erzwingen…", "activity.forceConfirmTitle": "Codex zwangsweise stoppen?", "activity.forceStopping": "Stopp wird erzwungen…", "activity.viewDetails": "Details anzeigen", "activity.hideDetails": "Details ausblenden"
  },
  pt: {
    "settings.language": "Idioma da interface", "settings.language.auto": "Automático", "settings.languageHint": "O modo automático segue o idioma do aplicativo host.",
    "common.loading": "Carregando…", "common.refresh": "Atualizar", "common.cancel": "Cancelar", "common.confirm": "Confirmar", "settings.title": "Configurações do Codex Bridge", "settings.scope": "Compartilhadas por todas as conversas que usam esta ponte.", "settings.access": "Estratégia de acesso", "settings.model": "Modelo padrão", "settings.effort": "Esforço padrão", "settings.cwd": "Pasta de trabalho padrão", "settings.concurrency": "Máximo de trabalhos simultâneos", "settings.save": "Salvar configurações", "settings.refreshModels": "Atualizar modelos", "settings.reset": "Restaurar configurações padrão", "activity.title": "Atividades do Codex", "activity.running": "Em execução", "activity.attention": "Requer atenção", "activity.verification": "Pronto para verificar", "activity.failed": "Falhou", "activity.empty": "Ainda não há atividades nesta conversa.", "activity.forceStop": "Forçar parada…", "activity.forceConfirmTitle": "Forçar a parada do Codex?", "activity.forceStopping": "Forçando parada…", "activity.viewDetails": "Ver detalhes", "activity.hideDetails": "Ocultar detalhes"
  }
};

const ISSUE19_OVERRIDES: Record<Exclude<SupportedUiLocale, "en">, Partial<UiTranslationBundle>> = {
  ko: {
    "settings.effortFallbackDescription": "현재 Codex 모델 카탈로그에서 제공된 새 추론 단계입니다.", "settings.unsupportedEffort": "저장된 추론 단계는 더 이상 지원되지 않습니다. 권장 모델 기본값:",
    "effort.minimal.label": "최소", "effort.minimal.description": "필수 추론만 사용해 가장 빠르게 응답합니다.", "effort.low.label": "낮음", "effort.low.description": "가벼운 추론으로 빠르게 응답합니다.", "effort.medium.label": "중간", "effort.medium.description": "추론 깊이와 응답 시간의 균형을 맞춥니다.", "effort.high.label": "높음", "effort.high.description": "복잡한 작업을 더 깊게 검토하지만 응답 시간이 늘어날 수 있습니다.", "effort.xhigh.label": "매우 높음", "effort.xhigh.description": "어려운 작업을 매우 깊게 추론하므로 응답이 상당히 오래 걸릴 수 있습니다.", "effort.max.label": "최대", "effort.max.description": "까다로운 작업에 사용할 수 있는 최대 추론 깊이입니다.", "effort.ultra.label": "울트라", "effort.ultra.description": "가장 까다로운 작업을 위해 확장 추론과 위임을 사용합니다.",
    "activity.agents": "Codex 에이전트", "activity.noAgents": "이 대화에는 아직 Codex 에이전트가 없습니다.", "activity.idleAgents": "대기 중인 에이전트", "activity.archivedAgents": "보관된 에이전트", "activity.temporaryJob": "에이전트 시작 중", "activity.currentActivity": "현재 Activity", "activity.elapsed": "경과 시간", "activity.lastChanged": "마지막 변경", "activity.showMore": "더 보기", "activity.archive": "보관", "activity.restore": "복원", "activity.rename": "이름 변경", "activity.detach": "Activity에서 해제", "activity.renamePrompt": "새 에이전트 이름을 입력하세요.", "activity.archiveConfirm": "이 유휴 에이전트를 보관할까요? 스레드 이력은 유지됩니다.", "activity.archiveConflict": "turn·승인·입력 요청이 활성 상태인 동안에는 에이전트를 보관할 수 없습니다.", "activity.backgroundProcesses": "백그라운드 프로세스 실행 중", "activity.agentId": "에이전트 ID",
    "agent.idle": "유휴", "agent.active": "실행 중", "agent.waiting-input": "입력 대기", "agent.archived": "보관됨", "agent.orphaned": "스레드 사용 불가"
  },
  ja: {
    "settings.effortFallbackDescription": "現在の Codex モデルカタログで提供される新しい推論レベルです。", "settings.unsupportedEffort": "保存済みの推論レベルはサポートされなくなりました。推奨されるモデル既定値:",
    "effort.minimal.label": "最小", "effort.minimal.description": "必要最小限の推論で最速に応答します。", "effort.low.label": "低", "effort.low.description": "軽い推論で素早く応答します。", "effort.medium.label": "中", "effort.medium.description": "推論の深さと応答時間のバランスを取ります。", "effort.high.label": "高", "effort.high.description": "複雑な作業を深く検討しますが応答時間が長くなる場合があります。", "effort.xhigh.label": "非常に高い", "effort.xhigh.description": "難しい作業を非常に深く推論するため、応答にかなり時間がかかる場合があります。", "effort.max.label": "最大", "effort.max.description": "要求の高い作業に利用できる最大の推論深度です。", "effort.ultra.label": "ウルトラ", "effort.ultra.description": "最も難しい作業に拡張推論と委任を使用します。",
    "activity.agents": "Codex エージェント", "activity.noAgents": "この会話にはまだ Codex エージェントがありません。", "activity.idleAgents": "待機中のエージェント", "activity.archivedAgents": "アーカイブ済みエージェント", "activity.temporaryJob": "エージェントを開始中", "activity.currentActivity": "現在の Activity", "activity.elapsed": "経過時間", "activity.lastChanged": "最終変更", "activity.showMore": "さらに表示", "activity.archive": "アーカイブ", "activity.restore": "復元", "activity.rename": "名前を変更", "activity.detach": "Activity から解除", "activity.renamePrompt": "新しいエージェント名を入力してください。", "activity.archiveConfirm": "この待機中エージェントをアーカイブしますか？スレッド履歴は保持されます。", "activity.archiveConflict": "turn、承認、入力要求が有効な間はアーカイブできません。", "activity.backgroundProcesses": "バックグラウンドプロセス実行中", "activity.agentId": "エージェント ID", "agent.idle": "待機中", "agent.active": "実行中", "agent.waiting-input": "入力待ち", "agent.archived": "アーカイブ済み", "agent.orphaned": "スレッド利用不可"
  },
  "zh-Hans": {
    "settings.effortFallbackDescription": "这是当前 Codex 模型目录提供的新推理级别。", "settings.unsupportedEffort": "已保存的推理级别不再受支持。建议的模型默认值：", "effort.minimal.label": "最小", "effort.minimal.description": "仅使用必要推理，响应最快。", "effort.low.label": "低", "effort.low.description": "使用较轻推理快速响应。", "effort.medium.label": "中", "effort.medium.description": "平衡推理深度和响应时间。", "effort.high.label": "高", "effort.high.description": "更深入检查复杂任务，但响应可能更慢。", "effort.xhigh.label": "极高", "effort.xhigh.description": "对困难任务进行非常深入的推理，响应可能明显更慢。", "effort.max.label": "最大", "effort.max.description": "为高难度任务提供最大推理深度。", "effort.ultra.label": "超高", "effort.ultra.description": "为最困难的任务使用扩展推理和委派。", "activity.agents": "Codex 代理", "activity.noAgents": "此对话中还没有 Codex 代理。", "activity.idleAgents": "空闲代理", "activity.archivedAgents": "已归档代理", "activity.temporaryJob": "正在启动代理", "activity.currentActivity": "当前 Activity", "activity.elapsed": "已用时间", "activity.lastChanged": "最后更改", "activity.showMore": "显示更多", "activity.archive": "归档", "activity.restore": "恢复", "activity.rename": "重命名", "activity.detach": "从 Activity 分离", "activity.renamePrompt": "输入新的代理名称。", "activity.archiveConfirm": "归档此空闲代理？线程历史将保留。", "activity.archiveConflict": "turn、审批或输入请求处于活动状态时无法归档。", "activity.backgroundProcesses": "后台进程仍在运行", "activity.agentId": "代理 ID", "agent.idle": "空闲", "agent.active": "活动", "agent.waiting-input": "等待输入", "agent.archived": "已归档", "agent.orphaned": "线程不可用"
  },
  "zh-Hant": {
    "settings.effortFallbackDescription": "這是目前 Codex 模型目錄提供的新推理層級。", "settings.unsupportedEffort": "已儲存的推理層級已不再支援。建議的模型預設值：", "effort.minimal.label": "最小", "effort.minimal.description": "只使用必要推理，回應最快。", "effort.low.label": "低", "effort.low.description": "以較輕量的推理快速回應。", "effort.medium.label": "中", "effort.medium.description": "平衡推理深度與回應時間。", "effort.high.label": "高", "effort.high.description": "更深入檢查複雜工作，但回應可能較慢。", "effort.xhigh.label": "極高", "effort.xhigh.description": "對困難工作進行非常深入的推理，回應可能明顯較慢。", "effort.max.label": "最大", "effort.max.description": "為高難度工作提供最大的推理深度。", "effort.ultra.label": "超高", "effort.ultra.description": "為最困難的工作使用擴充推理與委派。", "activity.agents": "Codex 代理程式", "activity.noAgents": "此對話中尚無 Codex 代理程式。", "activity.idleAgents": "閒置代理程式", "activity.archivedAgents": "已封存代理程式", "activity.temporaryJob": "正在啟動代理程式", "activity.currentActivity": "目前 Activity", "activity.elapsed": "經過時間", "activity.lastChanged": "最後變更", "activity.showMore": "顯示更多", "activity.archive": "封存", "activity.restore": "還原", "activity.rename": "重新命名", "activity.detach": "從 Activity 卸離", "activity.renamePrompt": "輸入新的代理程式名稱。", "activity.archiveConfirm": "要封存此閒置代理程式嗎？執行緒歷程會保留。", "activity.archiveConflict": "turn、核准或輸入要求仍在作用時無法封存。", "activity.backgroundProcesses": "背景程序仍在執行", "activity.agentId": "代理程式 ID", "agent.idle": "閒置", "agent.active": "執行中", "agent.waiting-input": "等待輸入", "agent.archived": "已封存", "agent.orphaned": "執行緒無法使用"
  },
  es: {
    "settings.effortFallbackDescription": "Un nuevo nivel de razonamiento ofrecido por el catálogo actual de Codex.", "settings.unsupportedEffort": "El nivel guardado ya no es compatible. Valor predeterminado sugerido:", "effort.minimal.label": "Mínimo", "effort.minimal.description": "Respuesta más rápida con solo el razonamiento esencial.", "effort.low.label": "Bajo", "effort.low.description": "Respuestas rápidas con razonamiento ligero.", "effort.medium.label": "Medio", "effort.medium.description": "Equilibra profundidad de razonamiento y tiempo de respuesta.", "effort.high.label": "Alto", "effort.high.description": "Revisión más profunda para tareas complejas, con mayor tiempo de respuesta.", "effort.xhigh.label": "Muy alto", "effort.xhigh.description": "Razonamiento muy profundo para tareas difíciles; puede tardar bastante más.", "effort.max.label": "Máximo", "effort.max.description": "Máxima profundidad de razonamiento disponible para tareas exigentes.", "effort.ultra.label": "Ultra", "effort.ultra.description": "Razonamiento ampliado y delegación para las tareas más exigentes.", "activity.agents": "Agentes Codex", "activity.noAgents": "Aún no hay agentes Codex en esta conversación.", "activity.idleAgents": "Agentes inactivos", "activity.archivedAgents": "Agentes archivados", "activity.temporaryJob": "Iniciando agente", "activity.currentActivity": "Activity actual", "activity.elapsed": "Transcurrido", "activity.lastChanged": "Último cambio", "activity.showMore": "Mostrar más", "activity.archive": "Archivar", "activity.restore": "Restaurar", "activity.rename": "Cambiar nombre", "activity.detach": "Desvincular de Activity", "activity.renamePrompt": "Introduce un nuevo nombre de agente.", "activity.archiveConfirm": "¿Archivar este agente inactivo? Se conservará el historial.", "activity.archiveConflict": "No se puede archivar mientras haya un turno, aprobación o solicitud de entrada activos.", "activity.backgroundProcesses": "Procesos en segundo plano activos", "activity.agentId": "ID de agente", "agent.idle": "Inactivo", "agent.active": "Activo", "agent.waiting-input": "Esperando entrada", "agent.archived": "Archivado", "agent.orphaned": "Hilo no disponible"
  },
  fr: {
    "settings.effortFallbackDescription": "Un nouveau niveau de raisonnement fourni par le catalogue Codex actuel.", "settings.unsupportedEffort": "Le niveau enregistré n’est plus pris en charge. Valeur par défaut suggérée :", "effort.minimal.label": "Minimal", "effort.minimal.description": "Réponse la plus rapide avec le raisonnement essentiel uniquement.", "effort.low.label": "Faible", "effort.low.description": "Réponses rapides avec un raisonnement léger.", "effort.medium.label": "Moyen", "effort.medium.description": "Équilibre profondeur du raisonnement et temps de réponse.", "effort.high.label": "Élevé", "effort.high.description": "Examen approfondi des tâches complexes, avec un temps de réponse accru.", "effort.xhigh.label": "Très élevé", "effort.xhigh.description": "Raisonnement très approfondi pour les tâches difficiles ; la réponse peut être nettement plus longue.", "effort.max.label": "Maximum", "effort.max.description": "Profondeur de raisonnement maximale pour les tâches exigeantes.", "effort.ultra.label": "Ultra", "effort.ultra.description": "Raisonnement étendu et délégation pour les tâches les plus exigeantes.", "activity.agents": "Agents Codex", "activity.noAgents": "Aucun agent Codex dans cette conversation.", "activity.idleAgents": "Agents inactifs", "activity.archivedAgents": "Agents archivés", "activity.temporaryJob": "Démarrage de l’agent", "activity.currentActivity": "Activity actuelle", "activity.elapsed": "Durée", "activity.lastChanged": "Dernière modification", "activity.showMore": "Afficher plus", "activity.archive": "Archiver", "activity.restore": "Restaurer", "activity.rename": "Renommer", "activity.detach": "Détacher de l’Activity", "activity.renamePrompt": "Saisissez un nouveau nom d’agent.", "activity.archiveConfirm": "Archiver cet agent inactif ? L’historique sera conservé.", "activity.archiveConflict": "Impossible d’archiver pendant un turn, une approbation ou une demande de saisie.", "activity.backgroundProcesses": "Processus en arrière-plan actifs", "activity.agentId": "ID de l’agent", "agent.idle": "Inactif", "agent.active": "Actif", "agent.waiting-input": "En attente de saisie", "agent.archived": "Archivé", "agent.orphaned": "Thread indisponible"
  },
  de: {
    "settings.effortFallbackDescription": "Eine neue Reasoning-Stufe aus dem aktuellen Codex-Modellkatalog.", "settings.unsupportedEffort": "Die gespeicherte Reasoning-Stufe wird nicht mehr unterstützt. Empfohlener Modellstandard:", "effort.minimal.label": "Minimal", "effort.minimal.description": "Schnellste Antworten mit nur dem nötigen Reasoning.", "effort.low.label": "Niedrig", "effort.low.description": "Schnelle Antworten mit leichtem Reasoning.", "effort.medium.label": "Mittel", "effort.medium.description": "Ausgewogenes Verhältnis von Reasoning-Tiefe und Antwortzeit.", "effort.high.label": "Hoch", "effort.high.description": "Tiefere Prüfung komplexer Aufgaben mit längerer Antwortzeit.", "effort.xhigh.label": "Sehr hoch", "effort.xhigh.description": "Sehr tiefes Reasoning für schwierige Aufgaben; Antworten können deutlich länger dauern.", "effort.max.label": "Maximum", "effort.max.description": "Maximale verfügbare Reasoning-Tiefe für anspruchsvolle Aufgaben.", "effort.ultra.label": "Ultra", "effort.ultra.description": "Erweitertes Reasoning und Delegation für besonders anspruchsvolle Aufgaben.", "activity.agents": "Codex-Agenten", "activity.noAgents": "Noch keine Codex-Agenten in dieser Unterhaltung.", "activity.idleAgents": "Inaktive Agenten", "activity.archivedAgents": "Archivierte Agenten", "activity.temporaryJob": "Agent wird gestartet", "activity.currentActivity": "Aktuelle Activity", "activity.elapsed": "Vergangen", "activity.lastChanged": "Letzte Änderung", "activity.showMore": "Mehr anzeigen", "activity.archive": "Archivieren", "activity.restore": "Wiederherstellen", "activity.rename": "Umbenennen", "activity.detach": "Von Activity lösen", "activity.renamePrompt": "Geben Sie einen neuen Agentennamen ein.", "activity.archiveConfirm": "Diesen inaktiven Agenten archivieren? Der Threadverlauf bleibt erhalten.", "activity.archiveConflict": "Während eines aktiven Turns, einer Genehmigung oder Eingabeanforderung ist Archivieren nicht möglich.", "activity.backgroundProcesses": "Hintergrundprozesse laufen", "activity.agentId": "Agenten-ID", "agent.idle": "Inaktiv", "agent.active": "Aktiv", "agent.waiting-input": "Wartet auf Eingabe", "agent.archived": "Archiviert", "agent.orphaned": "Thread nicht verfügbar"
  },
  pt: {
    "settings.effortFallbackDescription": "Um novo nível de raciocínio fornecido pelo catálogo atual do Codex.", "settings.unsupportedEffort": "O nível salvo não é mais compatível. Padrão sugerido do modelo:", "effort.minimal.label": "Mínimo", "effort.minimal.description": "Resposta mais rápida usando apenas o raciocínio essencial.", "effort.low.label": "Baixo", "effort.low.description": "Respostas rápidas com raciocínio leve.", "effort.medium.label": "Médio", "effort.medium.description": "Equilibra profundidade de raciocínio e tempo de resposta.", "effort.high.label": "Alto", "effort.high.description": "Revisão mais profunda de tarefas complexas, com maior tempo de resposta.", "effort.xhigh.label": "Muito alto", "effort.xhigh.description": "Raciocínio muito profundo para tarefas difíceis; a resposta pode demorar bem mais.", "effort.max.label": "Máximo", "effort.max.description": "Profundidade máxima de raciocínio para tarefas exigentes.", "effort.ultra.label": "Ultra", "effort.ultra.description": "Raciocínio ampliado e delegação para as tarefas mais exigentes.", "activity.agents": "Agentes Codex", "activity.noAgents": "Ainda não há agentes Codex nesta conversa.", "activity.idleAgents": "Agentes ociosos", "activity.archivedAgents": "Agentes arquivados", "activity.temporaryJob": "Iniciando agente", "activity.currentActivity": "Activity atual", "activity.elapsed": "Decorrido", "activity.lastChanged": "Última alteração", "activity.showMore": "Mostrar mais", "activity.archive": "Arquivar", "activity.restore": "Restaurar", "activity.rename": "Renomear", "activity.detach": "Desvincular da Activity", "activity.renamePrompt": "Digite um novo nome para o agente.", "activity.archiveConfirm": "Arquivar este agente ocioso? O histórico será preservado.", "activity.archiveConflict": "Não é possível arquivar enquanto houver turn, aprovação ou solicitação de entrada ativa.", "activity.backgroundProcesses": "Processos em segundo plano ativos", "activity.agentId": "ID do agente", "agent.idle": "Ocioso", "agent.active": "Ativo", "agent.waiting-input": "Aguardando entrada", "agent.archived": "Arquivado", "agent.orphaned": "Thread indisponível"
  }
};

const REMAINDER: Record<Exclude<SupportedUiLocale, "en" | "ko">, Partial<UiTranslationBundle>> = {
  ja: {
    "common.error": "リクエストに失敗しました。",
    "settings.access.readOnly": "常に読み取り専用",
    "settings.access.adaptive": "タスクごとに GPT が選択",
    "settings.access.full": "常にフルアクセス",
    "settings.access.readOnlyHint": "すべての新規タスクを読み取り専用に固定します。",
    "settings.access.adaptiveHint": "GPT が許可された範囲で読み取り専用、ワークスペース書き込み、フルアクセスを選択できます。",
    "settings.access.fullHint": "すべての新規タスクを danger-full-access に固定します。",
    "settings.fullWarning": "フルアクセスでは、この macOS ユーザーのファイルシステム権限とネットワーク権限で Codex が実行されます。許可ルートは開始フォルダーだけを制限し、OS レベルの隔離ではありません。",
    "settings.modelDefault": "Codex の既定モデル",
    "settings.modelHint": "インストール済みの Codex CLI から取得します。",
    "settings.savedModel": "保存済み",
    "settings.effortDefault": "モデルの既定エフォート",
    "settings.effortHint": "選択したモデルが対応する値だけを表示します。",
    "settings.cwdHint": "許可されたルートだけを保存できます:",


    "settings.cardVisibility": "Activity カード",
    "settings.cardVisibility.always": "常に表示",
    "settings.cardVisibility.background": "バックグラウンド作業のみ",
    "settings.cardVisibility.never": "自動表示しない",
    "settings.handoff": "完了時の引き継ぎ",
    "settings.handoff.off": "オフ",
    "settings.handoff.auto": "カード表示中に GPT へ自動引き継ぎ",
    "settings.handoffRequiresCard": "自動引き継ぎには表示中の Activity カードが必要です。",
    "settings.conflict": "別の場所で設定が変更されました。最新の値を確認して、もう一度保存してください。",
    "settings.saving": "保存中…",
    "settings.saved": "保存しました。",
    "settings.refreshing": "更新中…",
    "settings.refreshed": "モデル一覧を更新しました。",
    "settings.resetting": "復元中…",
    "settings.resetDone": "既定の設定を復元しました。",
    "settings.invalidResponse": "設定ツールから無効な応答が返されました。",
    "settings.sharedNotice": "この設定は ChatGPT アカウント別ではなく、このブリッジインスタンスを使用するすべての会話で共有されます。ブリッジのセキュリティポリシーはここでは変更できません。",
    "activity.forceStopped": "worker の終了を確認しました。",
    "activity.updated": "更新日時",
    "activity.noSignal": "最近の進行シグナルがありません。プロセスが動作中かどうかは不明です。",
    "activity.terminating": "worker プロセスの終了を確認中…",
    "activity.terminationFailed": "worker の終了を確認できませんでした。",
    "activity.unread": "未読の完了",
    "activity.manualRefresh": "自動更新を停止しました。手動で更新してください。",
    "activity.partialChanges": "強制終了しても、ディスクに書き込まれた変更は元に戻りません。",
    "activity.jobs": "ジョブ",
    "activity.threads": "スレッド",
    "activity.events": "最近のアクティビティ",
    "activity.noEvents": "公開された進行イベントはまだありません。",
    "activity.approval": "Codex が承認を求めています",
    "activity.approve": "承認",
    "activity.decline": "拒否",
    "activity.answer": "回答を送信",
    "activity.steer": "実行中の turn に指示",
    "activity.steerPlaceholder": "この Codex turn に追加する指示…",
    "activity.orphaned": "ブリッジが再起動したため、元の実行を追跡できません。",
    "activity.workerLost": "追跡していた worker プロセスが終了しました。",
    "activity.inputRequired": "入力が必要"
  },
  "zh-Hans": {
    "common.error": "请求失败。",
    "settings.access.readOnly": "始终只读",
    "settings.access.adaptive": "由 GPT 按任务选择",
    "settings.access.full": "始终完全访问",
    "settings.access.readOnlyHint": "所有新任务都强制为只读。",
    "settings.access.adaptiveHint": "GPT 可在允许的范围内选择只读、工作区写入或完全访问。",
    "settings.access.fullHint": "所有新任务都强制使用 danger-full-access。",
    "settings.fullWarning": "完全访问会使用此 macOS 用户的文件系统和网络权限运行 Codex。允许的根目录只限制起始文件夹，并不提供操作系统隔离。",
    "settings.modelDefault": "Codex 默认模型",
    "settings.modelHint": "从已安装的 Codex CLI 加载。",
    "settings.savedModel": "当前已保存",
    "settings.effortDefault": "模型默认推理强度",
    "settings.effortHint": "仅显示所选模型支持的值。",
    "settings.cwdHint": "只能保存允许的根目录：",


    "settings.cardVisibility": "Activity 卡片",
    "settings.cardVisibility.always": "始终显示",
    "settings.cardVisibility.background": "仅后台任务",
    "settings.cardVisibility.never": "不自动显示",
    "settings.handoff": "完成交接",
    "settings.handoff.off": "关闭",
    "settings.handoff.auto": "卡片打开时自动交接给 GPT",
    "settings.handoffRequiresCard": "自动交接需要显示 Activity 卡片。",
    "settings.conflict": "设置已在其他位置更改。已加载最新值，请检查后再次保存。",
    "settings.saving": "正在保存…",
    "settings.saved": "已保存。",
    "settings.refreshing": "正在刷新…",
    "settings.refreshed": "模型列表已刷新。",
    "settings.resetting": "正在恢复…",
    "settings.resetDone": "已恢复默认设置。",
    "settings.invalidResponse": "设置工具返回了无效响应。",
    "settings.sharedNotice": "这些设置不会按 ChatGPT 账户保存，而是由使用此桥接实例的所有对话共享。桥接安全策略无法在此更改。",
    "activity.forceStopped": "已确认 worker 终止。",
    "activity.updated": "更新时间",
    "activity.noSignal": "最近没有进度信号；无法确定进程是否仍在运行。",
    "activity.terminating": "正在确认 worker 进程退出…",
    "activity.terminationFailed": "无法确认 worker 已终止。",
    "activity.unread": "未读完成通知",
    "activity.manualRefresh": "实时更新已暂停；请手动刷新。",
    "activity.partialChanges": "强制停止不会回滚已写入磁盘的更改。",
    "activity.jobs": "任务",
    "activity.threads": "线程",
    "activity.events": "最近活动",
    "activity.noEvents": "尚无公开进度事件。",
    "activity.approval": "Codex 需要你的批准",
    "activity.approve": "批准",
    "activity.decline": "拒绝",
    "activity.answer": "发送回答",
    "activity.steer": "指导当前 turn",
    "activity.steerPlaceholder": "向当前 Codex turn 添加指导…",
    "activity.orphaned": "桥接已重启，无法继续跟踪原执行。",
    "activity.workerLost": "被跟踪的 worker 进程已退出。",
    "activity.inputRequired": "需要输入"
  },
  "zh-Hant": {
    "common.error": "要求失敗。",
    "settings.access.readOnly": "一律唯讀",
    "settings.access.adaptive": "由 GPT 依工作選擇",
    "settings.access.full": "一律完整存取",
    "settings.access.readOnlyHint": "所有新工作都強制為唯讀。",
    "settings.access.adaptiveHint": "GPT 可在允許的範圍內選擇唯讀、工作區寫入或完整存取。",
    "settings.access.fullHint": "所有新工作都強制使用 danger-full-access。",
    "settings.fullWarning": "完整存取會以此 macOS 使用者的檔案系統與網路權限執行 Codex。允許的根目錄只限制起始資料夾，並非作業系統隔離。",
    "settings.modelDefault": "Codex 預設模型",
    "settings.modelHint": "從已安裝的 Codex CLI 載入。",
    "settings.savedModel": "目前已儲存",
    "settings.effortDefault": "模型預設推理強度",
    "settings.effortHint": "只顯示所選模型支援的值。",
    "settings.cwdHint": "只能儲存允許的根目錄：",


    "settings.cardVisibility": "Activity 卡片",
    "settings.cardVisibility.always": "一律顯示",
    "settings.cardVisibility.background": "僅背景工作",
    "settings.cardVisibility.never": "不要自動顯示",
    "settings.handoff": "完成交接",
    "settings.handoff.off": "關閉",
    "settings.handoff.auto": "卡片開啟時自動交接給 GPT",
    "settings.handoffRequiresCard": "自動交接需要顯示 Activity 卡片。",
    "settings.conflict": "設定已在其他位置變更。已載入最新值，請確認後再次儲存。",
    "settings.saving": "儲存中…",
    "settings.saved": "已儲存。",
    "settings.refreshing": "重新整理中…",
    "settings.refreshed": "模型清單已重新整理。",
    "settings.resetting": "還原中…",
    "settings.resetDone": "已還原預設設定。",
    "settings.invalidResponse": "設定工具傳回無效回應。",
    "settings.sharedNotice": "這些設定不是依 ChatGPT 帳戶儲存，而是由使用此橋接執行個體的所有對話共用。橋接安全政策無法在此變更。",
    "activity.forceStopped": "已確認 worker 終止。",
    "activity.updated": "更新時間",
    "activity.noSignal": "最近沒有進度訊號；無法確定程序是否仍在執行。",
    "activity.terminating": "正在確認 worker 程序結束…",
    "activity.terminationFailed": "無法確認 worker 已終止。",
    "activity.unread": "未讀完成通知",
    "activity.manualRefresh": "即時更新已暫停；請手動重新整理。",
    "activity.partialChanges": "強制停止不會回復已寫入磁碟的變更。",
    "activity.jobs": "工作",
    "activity.threads": "執行緒",
    "activity.events": "最近活動",
    "activity.noEvents": "尚無公開進度事件。",
    "activity.approval": "Codex 需要你的核准",
    "activity.approve": "核准",
    "activity.decline": "拒絕",
    "activity.answer": "傳送回答",
    "activity.steer": "引導目前的 turn",
    "activity.steerPlaceholder": "向目前的 Codex turn 加入指示…",
    "activity.orphaned": "橋接已重新啟動，無法繼續追蹤原本的執行。",
    "activity.workerLost": "追蹤中的 worker 程序已結束。",
    "activity.inputRequired": "需要輸入"
  },
  es: {
    "common.error": "La solicitud falló.",
    "settings.access.readOnly": "Siempre solo lectura",
    "settings.access.adaptive": "GPT elige por tarea",
    "settings.access.full": "Siempre acceso total",
    "settings.access.readOnlyHint": "Todas las tareas nuevas se fuerzan a solo lectura.",
    "settings.access.adaptiveHint": "GPT puede elegir solo lectura, escritura en el espacio de trabajo o acceso total dentro de los límites permitidos.",
    "settings.access.fullHint": "Todas las tareas nuevas se fuerzan a danger-full-access.",
    "settings.fullWarning": "El acceso total ejecuta Codex con los permisos de archivos y red de este usuario de macOS. Las raíces permitidas solo limitan la carpeta inicial; no son aislamiento del sistema operativo.",
    "settings.modelDefault": "Modelo predeterminado de Codex",
    "settings.modelHint": "Cargado desde la CLI de Codex instalada.",
    "settings.savedModel": "guardado actualmente",
    "settings.effortDefault": "Esfuerzo predeterminado del modelo",
    "settings.effortHint": "Solo se muestran valores compatibles con el modelo seleccionado.",
    "settings.cwdHint": "Solo pueden guardarse raíces permitidas:",


    "settings.cardVisibility": "Tarjeta de Activity",
    "settings.cardVisibility.always": "Mostrar siempre",
    "settings.cardVisibility.background": "Solo tareas en segundo plano",
    "settings.cardVisibility.never": "No mostrar automáticamente",
    "settings.handoff": "Entrega al finalizar",
    "settings.handoff.off": "Desactivada",
    "settings.handoff.auto": "Entrega automática a GPT mientras la tarjeta esté abierta",
    "settings.handoffRequiresCard": "La entrega automática requiere una tarjeta de Activity visible.",
    "settings.conflict": "La configuración cambió en otro lugar. Se cargaron los valores más recientes; revísalos y vuelve a guardar.",
    "settings.saving": "Guardando…",
    "settings.saved": "Guardado.",
    "settings.refreshing": "Actualizando…",
    "settings.refreshed": "Lista de modelos actualizada.",
    "settings.resetting": "Restaurando…",
    "settings.resetDone": "Configuración predeterminada restaurada.",
    "settings.invalidResponse": "La herramienta de configuración devolvió una respuesta no válida.",
    "settings.sharedNotice": "Esta configuración se comparte entre todas las conversaciones que usan esta instancia del puente; no se guarda por cuenta de ChatGPT. La política de seguridad del puente no puede cambiarse aquí.",
    "activity.forceConfirm": "Envía TERM al grupo de procesos worker exacto y escala automáticamente a KILL si es necesario. Pueden interrumpirse tareas que compartan worker y los cambios de archivos no se revierten.",
    "activity.forceStopped": "Se confirmó la finalización del worker.",
    "activity.updated": "Actualizado",
    "activity.noSignal": "No hay una señal de progreso reciente; se desconoce si el proceso sigue activo.",
    "activity.terminating": "Confirmando la salida del proceso worker…",
    "activity.terminationFailed": "No se pudo confirmar la finalización del worker.",
    "activity.unread": "Finalización sin leer",
    "activity.manualRefresh": "Las actualizaciones en vivo se pausaron; actualiza manualmente.",
    "activity.partialChanges": "La detención forzada no revierte los cambios ya escritos en disco.",
    "activity.jobs": "tareas",
    "activity.threads": "hilos",
    "activity.events": "Actividad reciente",
    "activity.noEvents": "Aún no hay eventos de progreso públicos.",
    "activity.approval": "Codex necesita tu aprobación",
    "activity.approve": "Aprobar",
    "activity.decline": "Rechazar",
    "activity.answer": "Enviar respuesta",
    "activity.steer": "Guiar el turn activo",
    "activity.steerPlaceholder": "Añade instrucciones a este turn de Codex…",
    "activity.orphaned": "El puente se reinició y ya no puede rastrear la ejecución original.",
    "activity.workerLost": "El proceso worker rastreado terminó.",
    "activity.inputRequired": "Se requiere información"
  },
  fr: {
    "common.error": "La requête a échoué.",
    "settings.access.readOnly": "Toujours en lecture seule",
    "settings.access.adaptive": "GPT choisit selon la tâche",
    "settings.access.full": "Toujours en accès complet",
    "settings.access.readOnlyHint": "Chaque nouvelle tâche est forcée en lecture seule.",
    "settings.access.adaptiveHint": "GPT peut choisir la lecture seule, l’écriture dans l’espace de travail ou l’accès complet dans les limites autorisées.",
    "settings.access.fullHint": "Chaque nouvelle tâche est forcée en danger-full-access.",
    "settings.fullWarning": "L’accès complet exécute Codex avec les autorisations de fichiers et de réseau de cet utilisateur macOS. Les racines autorisées limitent uniquement le dossier de départ et ne constituent pas une isolation du système.",
    "settings.modelDefault": "Modèle Codex par défaut",
    "settings.modelHint": "Chargé depuis la CLI Codex installée.",
    "settings.savedModel": "actuellement enregistré",
    "settings.effortDefault": "Effort par défaut du modèle",
    "settings.effortHint": "Seules les valeurs prises en charge par le modèle sélectionné sont affichées.",
    "settings.cwdHint": "Seules les racines autorisées peuvent être enregistrées :",


    "settings.cardVisibility": "Carte Activity",
    "settings.cardVisibility.always": "Toujours afficher",
    "settings.cardVisibility.background": "Travaux en arrière-plan uniquement",
    "settings.cardVisibility.never": "Ne pas afficher automatiquement",
    "settings.handoff": "Remise à la fin",
    "settings.handoff.off": "Désactivée",
    "settings.handoff.auto": "Transfert automatique à GPT tant que la carte est ouverte",
    "settings.handoffRequiresCard": "Le transfert automatique nécessite une carte Activity visible.",
    "settings.conflict": "Les paramètres ont changé ailleurs. Les dernières valeurs ont été chargées ; vérifiez-les puis enregistrez à nouveau.",
    "settings.saving": "Enregistrement…",
    "settings.saved": "Enregistré.",
    "settings.refreshing": "Actualisation…",
    "settings.refreshed": "Liste des modèles actualisée.",
    "settings.resetting": "Restauration…",
    "settings.resetDone": "Paramètres par défaut rétablis.",
    "settings.invalidResponse": "L’outil de paramètres a renvoyé une réponse non valide.",
    "settings.sharedNotice": "Ces paramètres sont partagés par toutes les conversations utilisant cette instance du pont ; ils ne sont pas enregistrés par compte ChatGPT. La politique de sécurité du pont ne peut pas être modifiée ici.",
    "activity.forceConfirm": "Envoie TERM au groupe de processus worker suivi avec précision et passe automatiquement à KILL si nécessaire. Les tâches partageant ce worker peuvent être interrompues et les modifications de fichiers ne sont pas annulées.",
    "activity.forceStopped": "L’arrêt du worker a été confirmé.",
    "activity.updated": "Mis à jour",
    "activity.noSignal": "Aucun signal de progression récent ; l’état du processus est inconnu.",
    "activity.terminating": "Confirmation de l’arrêt du processus worker…",
    "activity.terminationFailed": "Impossible de confirmer l’arrêt du worker.",
    "activity.unread": "Fin non lue",
    "activity.manualRefresh": "Les mises à jour en direct sont suspendues ; actualisez manuellement.",
    "activity.partialChanges": "L’arrêt forcé n’annule pas les modifications déjà écrites sur le disque.",
    "activity.jobs": "tâches",
    "activity.threads": "fils",
    "activity.events": "Activité récente",
    "activity.noEvents": "Aucun événement de progression public pour le moment.",
    "activity.approval": "Codex demande votre approbation",
    "activity.approve": "Approuver",
    "activity.decline": "Refuser",
    "activity.answer": "Envoyer la réponse",
    "activity.steer": "Guider le turn actif",
    "activity.steerPlaceholder": "Ajoutez une instruction à ce turn Codex…",
    "activity.orphaned": "Le pont a redémarré et ne peut plus suivre l’exécution d’origine.",
    "activity.workerLost": "Le processus worker suivi s’est arrêté.",
    "activity.inputRequired": "Saisie requise"
  },
  de: {
    "common.error": "Die Anfrage ist fehlgeschlagen.",
    "settings.access.readOnly": "Immer schreibgeschützt",
    "settings.access.adaptive": "GPT wählt je Aufgabe",
    "settings.access.full": "Immer Vollzugriff",
    "settings.access.readOnlyHint": "Jede neue Aufgabe wird auf schreibgeschützt festgelegt.",
    "settings.access.adaptiveHint": "GPT kann innerhalb der zulässigen Grenzen zwischen schreibgeschützt, Workspace-Schreibzugriff und Vollzugriff wählen.",
    "settings.access.fullHint": "Jede neue Aufgabe wird auf danger-full-access festgelegt.",
    "settings.fullWarning": "Vollzugriff führt Codex mit den Datei- und Netzwerkrechten dieses macOS-Benutzers aus. Zulässige Wurzeln begrenzen nur den Startordner und sind keine Betriebssystem-Isolation.",
    "settings.modelDefault": "Codex-Standardmodell",
    "settings.modelHint": "Aus der installierten Codex CLI geladen.",
    "settings.savedModel": "derzeit gespeichert",
    "settings.effortDefault": "Standardaufwand des Modells",
    "settings.effortHint": "Es werden nur vom gewählten Modell unterstützte Werte angezeigt.",
    "settings.cwdHint": "Nur zulässige Wurzeln können gespeichert werden:",


    "settings.cardVisibility": "Activity-Karte",
    "settings.cardVisibility.always": "Immer anzeigen",
    "settings.cardVisibility.background": "Nur Hintergrundaufgaben",
    "settings.cardVisibility.never": "Nicht automatisch anzeigen",
    "settings.handoff": "Abschlussübergabe",
    "settings.handoff.off": "Aus",
    "settings.handoff.auto": "Automatische GPT-Übergabe bei geöffneter Karte",
    "settings.handoffRequiresCard": "Die automatische Übergabe erfordert eine sichtbare Activity-Karte.",
    "settings.conflict": "Die Einstellungen wurden an anderer Stelle geändert. Die neuesten Werte wurden geladen; bitte prüfen und erneut speichern.",
    "settings.saving": "Wird gespeichert…",
    "settings.saved": "Gespeichert.",
    "settings.refreshing": "Wird aktualisiert…",
    "settings.refreshed": "Modellliste aktualisiert.",
    "settings.resetting": "Wird wiederhergestellt…",
    "settings.resetDone": "Standardeinstellungen wiederhergestellt.",
    "settings.invalidResponse": "Das Einstellungswerkzeug hat eine ungültige Antwort zurückgegeben.",
    "settings.sharedNotice": "Diese Einstellungen werden von allen Unterhaltungen gemeinsam genutzt, die diese Bridge-Instanz verwenden; sie werden nicht pro ChatGPT-Konto gespeichert. Die Sicherheitsrichtlinie der Bridge kann hier nicht geändert werden.",
    "activity.forceConfirm": "Sendet TERM an die exakt erfasste worker-Prozessgruppe und eskaliert bei Bedarf automatisch zu KILL. Jobs auf demselben worker können unterbrochen werden; Dateiänderungen werden nicht zurückgesetzt.",
    "activity.forceStopped": "Die Beendigung des workers wurde bestätigt.",
    "activity.updated": "Aktualisiert",
    "activity.noSignal": "Kein aktuelles Fortschrittssignal; der Prozessstatus ist unbekannt.",
    "activity.terminating": "Beenden des worker-Prozesses wird bestätigt…",
    "activity.terminationFailed": "Die Beendigung des workers konnte nicht bestätigt werden.",
    "activity.unread": "Ungelesener Abschluss",
    "activity.manualRefresh": "Live-Aktualisierung pausiert; bitte manuell aktualisieren.",
    "activity.partialChanges": "Erzwungenes Stoppen setzt bereits geschriebene Änderungen nicht zurück.",
    "activity.jobs": "Jobs",
    "activity.threads": "Threads",
    "activity.events": "Letzte Aktivität",
    "activity.noEvents": "Noch keine öffentlichen Fortschrittsereignisse.",
    "activity.approval": "Codex benötigt Ihre Zustimmung",
    "activity.approve": "Zustimmen",
    "activity.decline": "Ablehnen",
    "activity.answer": "Antwort senden",
    "activity.steer": "Aktiven turn steuern",
    "activity.steerPlaceholder": "Anweisung für diesen Codex turn hinzufügen…",
    "activity.orphaned": "Die Bridge wurde neu gestartet und kann die ursprüngliche Ausführung nicht mehr verfolgen.",
    "activity.workerLost": "Der verfolgte worker-Prozess wurde beendet.",
    "activity.inputRequired": "Eingabe erforderlich"
  },
  pt: {
    "common.error": "A solicitação falhou.",
    "settings.access.readOnly": "Sempre somente leitura",
    "settings.access.adaptive": "GPT escolhe por tarefa",
    "settings.access.full": "Sempre acesso total",
    "settings.access.readOnlyHint": "Todas as novas tarefas são forçadas a somente leitura.",
    "settings.access.adaptiveHint": "O GPT pode escolher somente leitura, escrita no espaço de trabalho ou acesso total dentro dos limites permitidos.",
    "settings.access.fullHint": "Todas as novas tarefas são forçadas a danger-full-access.",
    "settings.fullWarning": "O acesso total executa o Codex com as permissões de arquivos e rede deste usuário do macOS. As raízes permitidas limitam apenas a pasta inicial; não são isolamento do sistema operacional.",
    "settings.modelDefault": "Modelo padrão do Codex",
    "settings.modelHint": "Carregado da CLI do Codex instalada.",
    "settings.savedModel": "salvo atualmente",
    "settings.effortDefault": "Esforço padrão do modelo",
    "settings.effortHint": "Somente valores compatíveis com o modelo selecionado são exibidos.",
    "settings.cwdHint": "Somente raízes permitidas podem ser salvas:",


    "settings.cardVisibility": "Cartão de Activity",
    "settings.cardVisibility.always": "Mostrar sempre",
    "settings.cardVisibility.background": "Somente tarefas em segundo plano",
    "settings.cardVisibility.never": "Não mostrar automaticamente",
    "settings.handoff": "Entrega ao concluir",
    "settings.handoff.off": "Desativada",
    "settings.handoff.auto": "Entrega automática ao GPT enquanto o cartão estiver aberto",
    "settings.handoffRequiresCard": "A entrega automática requer um cartão de Activity visível.",
    "settings.conflict": "As configurações foram alteradas em outro local. Os valores mais recentes foram carregados; revise e salve novamente.",
    "settings.saving": "Salvando…",
    "settings.saved": "Salvo.",
    "settings.refreshing": "Atualizando…",
    "settings.refreshed": "Lista de modelos atualizada.",
    "settings.resetting": "Restaurando…",
    "settings.resetDone": "Configurações padrão restauradas.",
    "settings.invalidResponse": "A ferramenta de configurações retornou uma resposta inválida.",
    "settings.sharedNotice": "Estas configurações são compartilhadas por todas as conversas que usam esta instância da ponte; não são salvas por conta do ChatGPT. A política de segurança da ponte não pode ser alterada aqui.",
    "activity.forceConfirm": "Envia TERM ao grupo de processos worker rastreado com exatidão e escala automaticamente para KILL quando necessário. Tarefas que compartilham o worker podem ser interrompidas e as alterações em arquivos não são revertidas.",
    "activity.forceStopped": "A finalização do worker foi confirmada.",
    "activity.updated": "Atualizado",
    "activity.noSignal": "Nenhum sinal de progresso recente; não se sabe se o processo ainda está ativo.",
    "activity.terminating": "Confirmando a saída do processo worker…",
    "activity.terminationFailed": "Não foi possível confirmar a finalização do worker.",
    "activity.unread": "Conclusão não lida",
    "activity.manualRefresh": "As atualizações em tempo real foram pausadas; atualize manualmente.",
    "activity.partialChanges": "A parada forçada não reverte alterações já gravadas no disco.",
    "activity.jobs": "tarefas",
    "activity.threads": "threads",
    "activity.events": "Atividade recente",
    "activity.noEvents": "Ainda não há eventos públicos de progresso.",
    "activity.approval": "O Codex precisa da sua aprovação",
    "activity.approve": "Aprovar",
    "activity.decline": "Recusar",
    "activity.answer": "Enviar resposta",
    "activity.steer": "Orientar o turn ativo",
    "activity.steerPlaceholder": "Adicione uma orientação a este turn do Codex…",
    "activity.orphaned": "A ponte foi reiniciada e não consegue mais rastrear a execução original.",
    "activity.workerLost": "O processo worker rastreado foi encerrado.",
    "activity.inputRequired": "Entrada necessária"
  }
};

const ISSUE20_OVERRIDES: Record<Exclude<SupportedUiLocale, "en">, Partial<UiTranslationBundle>> = {
  ko: {
    "activity.currentActivities": "현재 활동", "activity.noCurrent": "이 대화에서 현재 진행 중인 Codex 활동이 없습니다.", "activity.completedCodex": "완료된 Codex", "activity.completedWork": "완료 작업", "activity.idleCodex": "대기 중인 Codex", "activity.endedCodex": "종료된 Codex", "activity.turns": "turns", "activity.continued": "이어진 작업", "activity.reviewComplete": "검토 완료", "activity.workComplete": "Codex 작업 완료", "activity.gptVerificationNeeded": "GPT 검증 필요", "activity.verify": "검증", "activity.retry": "재시도", "activity.followUpSent": "GPT 후속 요청을 이 대화에 추가했습니다.", "activity.moreActivities": "추가 완료 작업:"
  },
  ja: {
    "activity.currentActivities": "現在のアクティビティ", "activity.noCurrent": "この会話で進行中の Codex アクティビティはありません。", "activity.completedCodex": "完了した Codex", "activity.completedWork": "完了したアクティビティ", "activity.idleCodex": "待機中の Codex", "activity.endedCodex": "終了した Codex", "activity.turns": "ターン", "activity.continued": "継続作業", "activity.reviewComplete": "レビュー完了", "activity.workComplete": "Codex 作業完了", "activity.gptVerificationNeeded": "GPT の検証が必要", "activity.verify": "検証", "activity.retry": "再試行", "activity.followUpSent": "GPT へのフォローアップをこの会話に追加しました。", "activity.moreActivities": "その他の完了アクティビティ:"
  },
  "zh-Hans": {
    "activity.currentActivities": "当前活动", "activity.noCurrent": "此对话中没有正在进行的 Codex 活动。", "activity.completedCodex": "已完成的 Codex", "activity.completedWork": "已完成活动", "activity.idleCodex": "空闲 Codex", "activity.endedCodex": "已结束的 Codex", "activity.turns": "轮", "activity.continued": "后续工作", "activity.reviewComplete": "审查完成", "activity.workComplete": "Codex 工作完成", "activity.gptVerificationNeeded": "需要 GPT 验证", "activity.verify": "验证", "activity.retry": "重试", "activity.followUpSent": "已在此对话中添加 GPT 后续请求。", "activity.moreActivities": "其他已完成活动："
  },
  "zh-Hant": {
    "activity.currentActivities": "目前活動", "activity.noCurrent": "此對話中沒有進行中的 Codex 活動。", "activity.completedCodex": "已完成的 Codex", "activity.completedWork": "已完成活動", "activity.idleCodex": "閒置 Codex", "activity.endedCodex": "已結束的 Codex", "activity.turns": "輪", "activity.continued": "延續工作", "activity.reviewComplete": "審查完成", "activity.workComplete": "Codex 工作完成", "activity.gptVerificationNeeded": "需要 GPT 驗證", "activity.verify": "驗證", "activity.retry": "重試", "activity.followUpSent": "已在此對話中加入 GPT 後續要求。", "activity.moreActivities": "其他已完成活動："
  },
  es: {
    "activity.currentActivities": "Actividad actual", "activity.noCurrent": "No hay actividad de Codex en curso en esta conversación.", "activity.completedCodex": "Codex completados", "activity.completedWork": "actividades completadas", "activity.idleCodex": "Codex inactivos", "activity.endedCodex": "Codex finalizados", "activity.turns": "turnos", "activity.continued": "Trabajo continuado", "activity.reviewComplete": "Revisión completada", "activity.workComplete": "Trabajo de Codex completado", "activity.gptVerificationNeeded": "Se necesita verificación de GPT", "activity.verify": "Verificar", "activity.retry": "Reintentar", "activity.followUpSent": "Se añadió un seguimiento de GPT a esta conversación.", "activity.moreActivities": "Otras actividades completadas:"
  },
  fr: {
    "activity.currentActivities": "Activité actuelle", "activity.noCurrent": "Aucune activité Codex en cours dans cette conversation.", "activity.completedCodex": "Codex terminés", "activity.completedWork": "activités terminées", "activity.idleCodex": "Codex inactifs", "activity.endedCodex": "Codex arrêtés", "activity.turns": "tours", "activity.continued": "Travail poursuivi", "activity.reviewComplete": "Revue terminée", "activity.workComplete": "Travail Codex terminé", "activity.gptVerificationNeeded": "Vérification GPT requise", "activity.verify": "Vérifier", "activity.retry": "Réessayer", "activity.followUpSent": "Un suivi GPT a été ajouté à cette conversation.", "activity.moreActivities": "Autres activités terminées :"
  },
  de: {
    "activity.currentActivities": "Aktuelle Aktivität", "activity.noCurrent": "In dieser Unterhaltung läuft keine Codex-Aktivität.", "activity.completedCodex": "Abgeschlossene Codex", "activity.completedWork": "abgeschlossene Aktivitäten", "activity.idleCodex": "Inaktive Codex", "activity.endedCodex": "Beendete Codex", "activity.turns": "Runden", "activity.continued": "Fortgesetzte Arbeit", "activity.reviewComplete": "Prüfung abgeschlossen", "activity.workComplete": "Codex-Arbeit abgeschlossen", "activity.gptVerificationNeeded": "GPT-Prüfung erforderlich", "activity.verify": "Prüfen", "activity.retry": "Erneut versuchen", "activity.followUpSent": "Eine GPT-Folgeanfrage wurde dieser Unterhaltung hinzugefügt.", "activity.moreActivities": "Weitere abgeschlossene Aktivitäten:"
  },
  pt: {
    "activity.currentActivities": "Atividade atual", "activity.noCurrent": "Não há atividade do Codex em andamento nesta conversa.", "activity.completedCodex": "Codex concluídos", "activity.completedWork": "atividades concluídas", "activity.idleCodex": "Codex ociosos", "activity.endedCodex": "Codex encerrados", "activity.turns": "turnos", "activity.continued": "Trabalho continuado", "activity.reviewComplete": "Revisão concluída", "activity.workComplete": "Trabalho do Codex concluído", "activity.gptVerificationNeeded": "Verificação do GPT necessária", "activity.verify": "Verificar", "activity.retry": "Tentar novamente", "activity.followUpSent": "Um acompanhamento do GPT foi adicionado a esta conversa.", "activity.moreActivities": "Outras atividades concluídas:"
  }
};

const STATE_OVERRIDES: Record<Exclude<SupportedUiLocale, "en">, Partial<UiTranslationBundle>> = {
  ko: {
    "kind.discussion": "토론", "kind.investigation": "조사", "kind.review": "검토", "kind.implementation": "구현", "kind.other": "기타",
    "lifecycle.open": "진행 가능", "lifecycle.sealed": "작업 추가 마감", "lifecycle.terminating": "강제 종료 중", "lifecycle.completed": "완료", "lifecycle.cancelled": "취소됨", "lifecycle.abandoned": "중단됨",
    "waiting.none": "대기 없음", "waiting.codex": "Codex 작업 대기", "waiting.orchestrator": "GPT 판단 대기", "waiting.user": "사용자 입력 대기", "waiting.verification": "검증 대기",
    "verification.not-required": "검증 불필요", "verification.pending": "검증 대기", "verification.verifying": "검증 중", "verification.verified": "검증 완료", "verification.failed": "검증 실패",
    "job.running": "진행 중", "job.terminating": "강제 종료 중", "job.termination-failed": "종료 확인 실패", "job.completed": "완료", "job.failed": "실패", "job.interrupted": "중단됨", "job.cancelled": "취소됨"
  },
  ja: {
    "kind.discussion": "ディスカッション", "kind.investigation": "調査", "kind.review": "レビュー", "kind.implementation": "実装", "kind.other": "その他",
    "lifecycle.open": "進行可能", "lifecycle.sealed": "追加受付終了", "lifecycle.terminating": "強制終了中", "lifecycle.completed": "完了", "lifecycle.cancelled": "キャンセル済み", "lifecycle.abandoned": "中止済み",
    "waiting.none": "待機なし", "waiting.codex": "Codex を待機", "waiting.orchestrator": "GPT の判断待ち", "waiting.user": "ユーザー入力待ち", "waiting.verification": "検証待ち",
    "verification.not-required": "検証不要", "verification.pending": "検証待ち", "verification.verifying": "検証中", "verification.verified": "検証済み", "verification.failed": "検証失敗",
    "job.running": "実行中", "job.terminating": "強制終了中", "job.termination-failed": "終了未確認", "job.completed": "完了", "job.failed": "失敗", "job.interrupted": "中断", "job.cancelled": "キャンセル済み"
  },
  "zh-Hans": {
    "kind.discussion": "讨论", "kind.investigation": "调查", "kind.review": "审查", "kind.implementation": "实现", "kind.other": "其他",
    "lifecycle.open": "可继续", "lifecycle.sealed": "已停止添加任务", "lifecycle.terminating": "正在强制停止", "lifecycle.completed": "已完成", "lifecycle.cancelled": "已取消", "lifecycle.abandoned": "已放弃",
    "waiting.none": "无等待", "waiting.codex": "等待 Codex", "waiting.orchestrator": "等待 GPT 判断", "waiting.user": "等待用户", "waiting.verification": "等待验证",
    "verification.not-required": "无需验证", "verification.pending": "等待验证", "verification.verifying": "正在验证", "verification.verified": "已验证", "verification.failed": "验证失败",
    "job.running": "运行中", "job.terminating": "正在强制停止", "job.termination-failed": "未确认终止", "job.completed": "已完成", "job.failed": "失败", "job.interrupted": "已中断", "job.cancelled": "已取消"
  },
  "zh-Hant": {
    "kind.discussion": "討論", "kind.investigation": "調查", "kind.review": "審查", "kind.implementation": "實作", "kind.other": "其他",
    "lifecycle.open": "可繼續", "lifecycle.sealed": "已停止新增工作", "lifecycle.terminating": "正在強制停止", "lifecycle.completed": "已完成", "lifecycle.cancelled": "已取消", "lifecycle.abandoned": "已放棄",
    "waiting.none": "無等待", "waiting.codex": "等待 Codex", "waiting.orchestrator": "等待 GPT 判斷", "waiting.user": "等待使用者", "waiting.verification": "等待驗證",
    "verification.not-required": "無需驗證", "verification.pending": "等待驗證", "verification.verifying": "正在驗證", "verification.verified": "已驗證", "verification.failed": "驗證失敗",
    "job.running": "執行中", "job.terminating": "正在強制停止", "job.termination-failed": "未確認終止", "job.completed": "已完成", "job.failed": "失敗", "job.interrupted": "已中斷", "job.cancelled": "已取消"
  },
  es: {
    "kind.discussion": "Debate", "kind.investigation": "Investigación", "kind.review": "Revisión", "kind.implementation": "Implementación", "kind.other": "Otro",
    "lifecycle.open": "Abierta", "lifecycle.sealed": "Cerrada a nuevas tareas", "lifecycle.terminating": "Deteniendo", "lifecycle.completed": "Completada", "lifecycle.cancelled": "Cancelada", "lifecycle.abandoned": "Abandonada",
    "waiting.none": "Sin espera", "waiting.codex": "Esperando a Codex", "waiting.orchestrator": "Esperando decisión de GPT", "waiting.user": "Esperando al usuario", "waiting.verification": "Esperando verificación",
    "verification.not-required": "Verificación no requerida", "verification.pending": "Verificación pendiente", "verification.verifying": "Verificando", "verification.verified": "Verificado", "verification.failed": "Verificación fallida",
    "job.running": "En curso", "job.terminating": "Detención forzada", "job.termination-failed": "Finalización no confirmada", "job.completed": "Completado", "job.failed": "Falló", "job.interrupted": "Interrumpido", "job.cancelled": "Cancelado"
  },
  fr: {
    "kind.discussion": "Discussion", "kind.investigation": "Investigation", "kind.review": "Revue", "kind.implementation": "Implémentation", "kind.other": "Autre",
    "lifecycle.open": "Ouverte", "lifecycle.sealed": "Fermée aux nouvelles tâches", "lifecycle.terminating": "Arrêt en cours", "lifecycle.completed": "Terminée", "lifecycle.cancelled": "Annulée", "lifecycle.abandoned": "Abandonnée",
    "waiting.none": "Aucune attente", "waiting.codex": "En attente de Codex", "waiting.orchestrator": "En attente de la décision de GPT", "waiting.user": "En attente de l’utilisateur", "waiting.verification": "En attente de vérification",
    "verification.not-required": "Vérification non requise", "verification.pending": "Vérification en attente", "verification.verifying": "Vérification en cours", "verification.verified": "Vérifié", "verification.failed": "Échec de la vérification",
    "job.running": "En cours", "job.terminating": "Arrêt forcé en cours", "job.termination-failed": "Arrêt non confirmé", "job.completed": "Terminé", "job.failed": "Échec", "job.interrupted": "Interrompu", "job.cancelled": "Annulé"
  },
  de: {
    "kind.discussion": "Diskussion", "kind.investigation": "Untersuchung", "kind.review": "Prüfung", "kind.implementation": "Implementierung", "kind.other": "Sonstiges",
    "lifecycle.open": "Offen", "lifecycle.sealed": "Für neue Jobs geschlossen", "lifecycle.terminating": "Wird beendet", "lifecycle.completed": "Abgeschlossen", "lifecycle.cancelled": "Abgebrochen", "lifecycle.abandoned": "Aufgegeben",
    "waiting.none": "Keine Warteaktion", "waiting.codex": "Warten auf Codex", "waiting.orchestrator": "Warten auf GPT-Entscheidung", "waiting.user": "Warten auf Benutzer", "waiting.verification": "Warten auf Prüfung",
    "verification.not-required": "Keine Prüfung erforderlich", "verification.pending": "Prüfung ausstehend", "verification.verifying": "Wird geprüft", "verification.verified": "Geprüft", "verification.failed": "Prüfung fehlgeschlagen",
    "job.running": "Läuft", "job.terminating": "Stopp wird erzwungen", "job.termination-failed": "Beendigung unbestätigt", "job.completed": "Abgeschlossen", "job.failed": "Fehlgeschlagen", "job.interrupted": "Unterbrochen", "job.cancelled": "Abgebrochen"
  },
  pt: {
    "kind.discussion": "Discussão", "kind.investigation": "Investigação", "kind.review": "Revisão", "kind.implementation": "Implementação", "kind.other": "Outro",
    "lifecycle.open": "Aberta", "lifecycle.sealed": "Fechada para novas tarefas", "lifecycle.terminating": "Encerrando", "lifecycle.completed": "Concluída", "lifecycle.cancelled": "Cancelada", "lifecycle.abandoned": "Abandonada",
    "waiting.none": "Sem espera", "waiting.codex": "Aguardando o Codex", "waiting.orchestrator": "Aguardando decisão do GPT", "waiting.user": "Aguardando o usuário", "waiting.verification": "Aguardando verificação",
    "verification.not-required": "Verificação não necessária", "verification.pending": "Verificação pendente", "verification.verifying": "Verificando", "verification.verified": "Verificado", "verification.failed": "Falha na verificação",
    "job.running": "Em execução", "job.terminating": "Forçando parada", "job.termination-failed": "Finalização não confirmada", "job.completed": "Concluído", "job.failed": "Falhou", "job.interrupted": "Interrompido", "job.cancelled": "Cancelado"
  }
};

const BACKGROUND_PROCESS_OVERRIDES: Record<Exclude<SupportedUiLocale, "en">, Partial<UiTranslationBundle>> = {
  ko: {
    "activity.backgroundUnavailable": "백그라운드 프로세스 상태를 확인할 수 없음",
    "activity.stopBackground": "백그라운드 프로세스 종료…",
    "activity.backgroundConfirm": "이 에이전트가 남긴 백그라운드 프로세스를 모두 종료할까요? 파일 변경은 되돌리지 않습니다.",
    "activity.backgroundArchiveConflict": "남아 있는 백그라운드 프로세스를 종료한 뒤 에이전트를 보관하세요."
  },
  ja: {
    "activity.backgroundUnavailable": "バックグラウンドプロセスの状態を確認できません",
    "activity.stopBackground": "バックグラウンドプロセスを停止…",
    "activity.backgroundConfirm": "このエージェントが残したバックグラウンドプロセスをすべて停止しますか？ファイル変更は元に戻りません。",
    "activity.backgroundArchiveConflict": "残っているバックグラウンドプロセスを停止してからエージェントをアーカイブしてください。"
  },
  "zh-Hans": {
    "activity.backgroundUnavailable": "无法获取后台进程状态",
    "activity.stopBackground": "停止后台进程…",
    "activity.backgroundConfirm": "停止此代理留下的所有后台进程？文件更改不会回滚。",
    "activity.backgroundArchiveConflict": "请先停止剩余的后台进程，再归档此代理。"
  },
  "zh-Hant": {
    "activity.backgroundUnavailable": "無法取得背景程序狀態",
    "activity.stopBackground": "停止背景程序…",
    "activity.backgroundConfirm": "要停止此代理程式留下的所有背景程序嗎？檔案變更不會復原。",
    "activity.backgroundArchiveConflict": "請先停止剩餘的背景程序，再封存此代理程式。"
  },
  es: {
    "activity.backgroundUnavailable": "El estado de los procesos en segundo plano no está disponible",
    "activity.stopBackground": "Detener procesos en segundo plano…",
    "activity.backgroundConfirm": "¿Detener todos los procesos en segundo plano que dejó este agente? Los cambios en archivos no se revierten.",
    "activity.backgroundArchiveConflict": "Detén los procesos en segundo plano restantes antes de archivar este agente."
  },
  fr: {
    "activity.backgroundUnavailable": "L’état des processus en arrière-plan est indisponible",
    "activity.stopBackground": "Arrêter les processus en arrière-plan…",
    "activity.backgroundConfirm": "Arrêter tous les processus en arrière-plan laissés par cet agent ? Les modifications de fichiers ne sont pas annulées.",
    "activity.backgroundArchiveConflict": "Arrêtez les processus en arrière-plan restants avant d’archiver cet agent."
  },
  de: {
    "activity.backgroundUnavailable": "Der Status der Hintergrundprozesse ist nicht verfügbar",
    "activity.stopBackground": "Hintergrundprozesse stoppen…",
    "activity.backgroundConfirm": "Alle von diesem Agenten hinterlassenen Hintergrundprozesse stoppen? Dateiänderungen werden nicht zurückgesetzt.",
    "activity.backgroundArchiveConflict": "Stoppen Sie verbleibende Hintergrundprozesse, bevor Sie diesen Agenten archivieren."
  },
  pt: {
    "activity.backgroundUnavailable": "O estado dos processos em segundo plano está indisponível",
    "activity.stopBackground": "Parar processos em segundo plano…",
    "activity.backgroundConfirm": "Parar todos os processos em segundo plano deixados por este agente? As alterações em arquivos não serão revertidas.",
    "activity.backgroundArchiveConflict": "Pare os processos em segundo plano restantes antes de arquivar este agente."
  }
};

const ISSUE21_OVERRIDES: Partial<
  Record<Exclude<SupportedUiLocale, "en">, Partial<UiTranslationBundle>>
> = {
  ko: {
    "settings.allowedExactSelections": "먼저 모델을 선택한 다음, 모델별로 허용할 추론 에포트를 고르세요.",
    "settings.allowedModels": "모델",
    "settings.effortsByModel": "선택한 모델별 추론 에포트",
    "settings.selectAllEfforts": "모두",
    "settings.partialEffortsSelected": "일부 에포트가 선택되어 있습니다.",
    "settings.additionalServiceTiers": "추가 서비스 티어 조합",
    "settings.selectionCount": "정확한 selection {count}개",
    "settings.automaticNotice": "GPT는 이 범위에서 모델과 추론 에포트만 선택합니다. Priority는 GPT 선택지에 노출하지 않고 브리지가 내부적으로 적용합니다. 카탈로그 전체 모드는 새 모델·에포트 선택지를 자동 반영합니다.",
    "settings.modelEffortRequired": "{model} 모델의 추론 에포트를 하나 이상 선택하세요.",
    "settings.refreshModels": "모델 불러오기 재시도",
    "settings.refreshing": "모델을 다시 불러오는 중…",
    "settings.refreshed": "모델 목록을 불러왔습니다."
  },
  ja: {
    "settings.usePriority": "Priority（高速処理）を使用",
    "settings.usePriorityHint": "Codex 呼び出し時にブリッジが内部適用します。GPT はモデルと推論エフォートのみ選択します。",
    "settings.allowedExactSelections": "最初にモデルを選び、モデルごとに許可する推論エフォートを選択してください。",
    "settings.allowedModels": "モデル",
    "settings.effortsByModel": "選択したモデルごとの推論エフォート",
    "settings.selectAllEfforts": "すべて",
    "settings.partialEffortsSelected": "一部のエフォートが選択されています。",
    "settings.additionalServiceTiers": "追加のサービスティア構成",
    "settings.selectionCount": "完全一致の選択: {count} 件",
    "settings.automaticNotice": "GPT はこの範囲のモデルと推論エフォートのみ選択します。Priority は GPT の選択肢に公開せず、ブリッジが内部適用します。",
    "settings.modelEffortRequired": "{model} の推論エフォートを 1 つ以上選択してください。",
    "settings.refreshModels": "モデル読み込みを再試行",
    "settings.refreshing": "モデルを再読み込み中…",
    "settings.refreshed": "モデル一覧を読み込みました。"
  },
  "zh-Hans": {
    "settings.usePriority": "使用 Priority（快速处理）",
    "settings.usePriorityHint": "由桥接在调用 Codex 时内部应用。GPT 只选择模型和推理强度。",
    "settings.allowedExactSelections": "请先选择模型，再为每个模型选择允许的推理强度。",
    "settings.allowedModels": "模型",
    "settings.effortsByModel": "所选模型的推理强度",
    "settings.selectAllEfforts": "全部",
    "settings.partialEffortsSelected": "已选择部分推理强度。",
    "settings.additionalServiceTiers": "其他服务层级组合",
    "settings.selectionCount": "{count} 个精确选择",
    "settings.automaticNotice": "GPT 只选择此范围内的模型和推理强度。Priority 不会作为 GPT 选项公开，而由桥接内部应用。",
    "settings.modelEffortRequired": "请为 {model} 至少选择一个推理强度。",
    "settings.refreshModels": "重试加载模型",
    "settings.refreshing": "正在重新加载模型…",
    "settings.refreshed": "已加载模型列表。"
  },
  "zh-Hant": {
    "settings.usePriority": "使用 Priority（快速處理）",
    "settings.usePriorityHint": "由橋接在呼叫 Codex 時於內部套用。GPT 只選擇模型與推理強度。",
    "settings.allowedExactSelections": "請先選擇模型，再為每個模型選擇允許的推理強度。",
    "settings.allowedModels": "模型",
    "settings.effortsByModel": "所選模型的推理強度",
    "settings.selectAllEfforts": "全部",
    "settings.partialEffortsSelected": "已選擇部分推理強度。",
    "settings.additionalServiceTiers": "其他服務層級組合",
    "settings.selectionCount": "{count} 個精確選擇",
    "settings.automaticNotice": "GPT 只選擇此範圍內的模型與推理強度。Priority 不會作為 GPT 選項公開，而由橋接於內部套用。",
    "settings.modelEffortRequired": "請為 {model} 至少選擇一個推理強度。",
    "settings.refreshModels": "重試載入模型",
    "settings.refreshing": "正在重新載入模型…",
    "settings.refreshed": "已載入模型清單。"
  },
  es: {
    "settings.usePriority": "Usar Priority (procesamiento rápido)",
    "settings.usePriorityHint": "El puente lo aplica internamente al llamar a Codex. GPT solo elige el modelo y el nivel de razonamiento.",
    "settings.allowedExactSelections": "Selecciona primero los modelos y después los niveles de razonamiento permitidos para cada uno.",
    "settings.allowedModels": "Modelos",
    "settings.effortsByModel": "Niveles de razonamiento por modelo seleccionado",
    "settings.selectAllEfforts": "Todos",
    "settings.partialEffortsSelected": "Hay algunos niveles seleccionados.",
    "settings.additionalServiceTiers": "Variantes adicionales de nivel de servicio",
    "settings.selectionCount": "{count} selecciones exactas",
    "settings.automaticNotice": "GPT solo elige el modelo y el nivel de razonamiento de este intervalo. Priority no se expone como opción de GPT; el puente lo aplica internamente.",
    "settings.modelEffortRequired": "Selecciona al menos un nivel de razonamiento para {model}.",
    "settings.refreshModels": "Reintentar la carga de modelos",
    "settings.refreshing": "Reintentando la carga de modelos…",
    "settings.refreshed": "Lista de modelos cargada."
  },
  fr: {
    "settings.usePriority": "Utiliser Priority (traitement rapide)",
    "settings.usePriorityHint": "Le pont l’applique en interne lors de l’appel à Codex. GPT choisit uniquement le modèle et l’effort de raisonnement.",
    "settings.allowedExactSelections": "Sélectionnez d’abord les modèles, puis les niveaux de raisonnement autorisés pour chacun.",
    "settings.allowedModels": "Modèles",
    "settings.effortsByModel": "Niveaux de raisonnement par modèle sélectionné",
    "settings.selectAllEfforts": "Tous",
    "settings.partialEffortsSelected": "Certains niveaux sont sélectionnés.",
    "settings.additionalServiceTiers": "Variantes supplémentaires de niveau de service",
    "settings.selectionCount": "{count} sélections exactes",
    "settings.automaticNotice": "GPT choisit uniquement le modèle et l’effort de raisonnement de cette plage. Priority n’est pas exposé comme choix GPT ; le pont l’applique en interne.",
    "settings.modelEffortRequired": "Sélectionnez au moins un niveau de raisonnement pour {model}.",
    "settings.refreshModels": "Réessayer de charger les modèles",
    "settings.refreshing": "Nouvelle tentative de chargement des modèles…",
    "settings.refreshed": "Liste des modèles chargée."
  },
  de: {
    "settings.usePriority": "Priority (schnelle Verarbeitung) verwenden",
    "settings.usePriorityHint": "Die Bridge wendet dies beim Codex-Aufruf intern an. GPT wählt nur Modell und Reasoning-Stufe.",
    "settings.allowedExactSelections": "Wählen Sie zuerst die Modelle und dann die zulässigen Reasoning-Stufen für jedes Modell aus.",
    "settings.allowedModels": "Modelle",
    "settings.effortsByModel": "Reasoning-Stufen nach ausgewähltem Modell",
    "settings.selectAllEfforts": "Alle",
    "settings.partialEffortsSelected": "Einige Reasoning-Stufen sind ausgewählt.",
    "settings.additionalServiceTiers": "Zusätzliche Service-Tier-Varianten",
    "settings.selectionCount": "{count} exakte Auswahlen",
    "settings.automaticNotice": "GPT wählt nur Modell und Reasoning-Stufe aus diesem Bereich. Priority wird nicht als GPT-Auswahl offengelegt, sondern intern von der Bridge angewendet.",
    "settings.modelEffortRequired": "Wählen Sie mindestens eine Reasoning-Stufe für {model} aus.",
    "settings.refreshModels": "Laden der Modelle erneut versuchen",
    "settings.refreshing": "Modelle werden erneut geladen…",
    "settings.refreshed": "Modellliste geladen."
  },
  pt: {
    "settings.usePriority": "Usar Priority (processamento rápido)",
    "settings.usePriorityHint": "A ponte aplica internamente ao chamar o Codex. O GPT escolhe apenas o modelo e o nível de raciocínio.",
    "settings.allowedExactSelections": "Selecione primeiro os modelos e depois os níveis de raciocínio permitidos para cada um.",
    "settings.allowedModels": "Modelos",
    "settings.effortsByModel": "Níveis de raciocínio por modelo selecionado",
    "settings.selectAllEfforts": "Todos",
    "settings.partialEffortsSelected": "Alguns níveis estão selecionados.",
    "settings.additionalServiceTiers": "Variantes adicionais de nível de serviço",
    "settings.selectionCount": "{count} seleções exatas",
    "settings.automaticNotice": "O GPT escolhe apenas o modelo e o nível de raciocínio deste intervalo. Priority não é exposto como opção do GPT; a ponte aplica internamente.",
    "settings.modelEffortRequired": "Selecione pelo menos um nível de raciocínio para {model}.",
    "settings.refreshModels": "Tentar carregar os modelos novamente",
    "settings.refreshing": "Tentando carregar os modelos novamente…",
    "settings.refreshed": "Lista de modelos carregada."
  }
};

const ISSUE24_OVERRIDES: Record<
  Exclude<SupportedUiLocale, "en">,
  Partial<UiTranslationBundle>
> = {
  ko: {
    "settings.cardVisibility.always": "GPT 응답마다 카드 1개",
    "settings.cardVisibility.background": "백그라운드 작업이 있는 응답마다 카드 1개",
    "settings.cardVisibility.never": "자동 카드 표시 안 함",
    "activity.superseded": "더 최신 Activity 카드가 실시간 갱신을 맡았습니다. 이 스냅샷은 그대로 볼 수 있습니다."
  },
  ja: {
    "settings.cardVisibility.always": "GPT 応答ごとにカード 1 枚",
    "settings.cardVisibility.background": "バックグラウンド作業を含む応答ごとにカード 1 枚",
    "settings.cardVisibility.never": "自動カードを表示しない",
    "activity.superseded": "新しい Activity カードがライブ更新を引き継ぎました。このスナップショットは引き続き表示できます。"
  },
  "zh-Hans": {
    "settings.cardVisibility.always": "每个 GPT 回复一张卡片",
    "settings.cardVisibility.background": "每个含后台任务的回复一张卡片",
    "settings.cardVisibility.never": "不自动显示卡片",
    "activity.superseded": "较新的 Activity 卡片已接管实时更新。此快照仍可查看。"
  },
  "zh-Hant": {
    "settings.cardVisibility.always": "每個 GPT 回覆一張卡片",
    "settings.cardVisibility.background": "每個含背景工作的回覆一張卡片",
    "settings.cardVisibility.never": "不自動顯示卡片",
    "activity.superseded": "較新的 Activity 卡片已接管即時更新。此快照仍可查看。"
  },
  es: {
    "settings.cardVisibility.always": "Una tarjeta por respuesta de GPT",
    "settings.cardVisibility.background": "Una tarjeta por respuesta con trabajo en segundo plano",
    "settings.cardVisibility.never": "Sin tarjetas automáticas",
    "activity.superseded": "Una tarjeta de Activity más reciente controla ahora las actualizaciones en vivo. Esta instantánea seguirá disponible."
  },
  fr: {
    "settings.cardVisibility.always": "Une carte par réponse GPT",
    "settings.cardVisibility.background": "Une carte par réponse avec travail en arrière-plan",
    "settings.cardVisibility.never": "Aucune carte automatique",
    "activity.superseded": "Une carte Activity plus récente gère désormais les mises à jour en direct. Cet instantané reste disponible."
  },
  de: {
    "settings.cardVisibility.always": "Eine Karte pro GPT-Antwort",
    "settings.cardVisibility.background": "Eine Karte pro Antwort mit Hintergrundarbeit",
    "settings.cardVisibility.never": "Keine automatischen Karten",
    "activity.superseded": "Eine neuere Activity-Karte übernimmt jetzt die Live-Aktualisierung. Dieser Snapshot bleibt verfügbar."
  },
  pt: {
    "settings.cardVisibility.always": "Um cartão por resposta do GPT",
    "settings.cardVisibility.background": "Um cartão por resposta com trabalho em segundo plano",
    "settings.cardVisibility.never": "Sem cartões automáticos",
    "activity.superseded": "Um cartão de Activity mais recente agora controla as atualizações ao vivo. Este instantâneo continuará disponível."
  }
};

const ISSUE22_OVERRIDES: Record<
  Exclude<SupportedUiLocale, "en">,
  Partial<UiTranslationBundle>
> = {
  ko: {
    "settings.projects": "프로젝트",
    "settings.projectsHint": "이름을 붙인 폴더를 등록하세요. 프로젝트 ID는 안정적인 라우팅 키이며 표시 이름과 폴더는 수정할 수 있습니다.",
    "settings.allowedRoots": "브리지 허용 루트",
    "settings.allowedRootsHint": "프로젝트 실경로는 이 보안 상한 중 하나 안에 있어야 합니다. 프로젝트를 등록해도 범위는 넓어지지 않습니다.",
    "settings.addProject": "프로젝트 추가",
    "settings.noProjects": "등록된 프로젝트가 없습니다. 호환 기본값이 없다면 새 작업을 시작하기 전에 추가하세요.",
    "settings.projectId": "프로젝트 ID",
    "settings.projectIdHint": "저장된 프로젝트 ID는 유지됩니다. 새 식별자가 필요할 때만 제거한 뒤 다시 추가하세요.",
    "settings.projectLabel": "표시 이름",
    "settings.projectCwd": "절대 폴더 경로",
    "settings.defaultProject": "선택적 기본 프로젝트",
    "settings.defaultProjectHint": "프로젝트가 여러 개일 때 사용하는 호환 기본값입니다. 프로젝트별 작업 라우팅이 활성화된 뒤 기본값을 비워 두면 프로젝트를 명시해야 합니다.",
    "settings.defaultProjectNone": "기본 프로젝트 없음",
    "settings.projectAvailable": "사용 가능",
    "settings.projectUnavailable": "복구 필요",
    "settings.projectNew": "새 항목",
    "settings.removeProject": "제거",
    "settings.projectInvalidId": "소문자 ASCII 영문·숫자를 하이픈으로 구분해 1~64자로 입력하세요. 공백과 밑줄은 정규화됩니다.",
    "settings.projectInvalidLabel": "프로젝트 표시 이름을 출력 가능한 Unicode 1~120자로 입력하세요.",
    "settings.projectInvalidCwd": "브리지 허용 루트 안에 존재하는 절대 폴더를 입력하세요.",
    "settings.projectDuplicateId": "정규화한 프로젝트 ID는 서로 달라야 합니다.",
    "settings.projectDuplicatePath": "각 프로젝트는 서로 다른 canonical 폴더를 사용해야 합니다.",
    "settings.projectDefaultMissing": "프로젝트 목록에 남아 있는 기본값을 선택하거나 기본값 없음을 선택하세요.",
    "settings.projectUnavailableSave": "저장하기 전에 복구가 필요한 모든 프로젝트를 수정하거나 제거하세요.",
    "settings.projectLimit": "프로젝트는 최대 100개까지 등록할 수 있습니다.",
    "settings.projectError": "프로젝트 섹션의 강조된 값을 확인하고 수정하세요."
  },
  ja: {
    "settings.projects": "プロジェクト",
    "settings.projectsHint": "名前付きフォルダーを登録します。プロジェクト ID は安定したルーティングキーで、表示名とフォルダーは編集できます。",
    "settings.allowedRoots": "ブリッジで許可されたルート",
    "settings.allowedRootsHint": "プロジェクトの実体パスは、このセキュリティ上限のいずれかに含まれる必要があります。登録しても範囲は広がりません。",
    "settings.addProject": "プロジェクトを追加",
    "settings.noProjects": "登録済みプロジェクトはありません。互換用の既定値がない場合は、新しい作業の前に追加してください。",
    "settings.projectId": "プロジェクト ID",
    "settings.projectIdHint": "保存済み ID は固定です。新しい識別子が必要な場合だけ削除して追加し直してください。",
    "settings.projectLabel": "表示名",
    "settings.projectCwd": "絶対フォルダー",
    "settings.defaultProject": "任意の既定プロジェクト",
    "settings.defaultProjectHint": "複数プロジェクト用の互換既定値です。プロジェクト対応ルーティングの有効化後、未指定なら明示的な選択が必要です。",
    "settings.defaultProjectNone": "既定プロジェクトなし",
    "settings.projectAvailable": "利用可能",
    "settings.projectUnavailable": "復旧が必要",
    "settings.projectNew": "新規",
    "settings.removeProject": "削除",
    "settings.projectInvalidId": "小文字 ASCII 英数字をハイフンで区切り、1～64 文字で入力してください。空白とアンダースコアは正規化されます。",
    "settings.projectInvalidLabel": "表示名を印刷可能な Unicode 1～120 文字で入力してください。",
    "settings.projectInvalidCwd": "許可されたルート内に存在する絶対フォルダーを入力してください。",
    "settings.projectDuplicateId": "正規化後のプロジェクト ID は一意である必要があります。",
    "settings.projectDuplicatePath": "各プロジェクトには異なる正規フォルダーが必要です。",
    "settings.projectDefaultMissing": "一覧に残っている既定値を選ぶか、既定なしを選択してください。",
    "settings.projectUnavailableSave": "保存する前に、復旧が必要なプロジェクトをすべて修正または削除してください。",
    "settings.projectLimit": "登録できるプロジェクトは最大 100 件です。",
    "settings.projectError": "プロジェクト欄の強調表示された値を確認して修正してください。"
  },
  "zh-Hans": {
    "settings.projects": "项目",
    "settings.projectsHint": "在此注册命名文件夹。项目 ID 是稳定的路由键；显示名称和文件夹可以编辑。",
    "settings.allowedRoots": "桥接允许的根目录",
    "settings.allowedRootsHint": "项目的真实路径必须位于这些安全上限之一。注册项目不会扩大范围。",
    "settings.addProject": "添加项目",
    "settings.noProjects": "尚未注册项目。如果没有兼容默认值，请在开始新工作前添加一个。",
    "settings.projectId": "项目 ID",
    "settings.projectIdHint": "已保存的项目 ID 保持稳定。只有确实需要新身份时才删除并重新添加。",
    "settings.projectLabel": "显示名称",
    "settings.projectCwd": "绝对文件夹",
    "settings.defaultProject": "可选默认项目",
    "settings.defaultProjectHint": "多个项目时使用的兼容默认值。启用项目感知路由后，留空将要求明确选择项目。",
    "settings.defaultProjectNone": "无默认项目",
    "settings.projectAvailable": "可用",
    "settings.projectUnavailable": "需要恢复",
    "settings.projectNew": "新建",
    "settings.removeProject": "移除",
    "settings.projectInvalidId": "请输入 1–64 个由连字符分隔的小写 ASCII 字母或数字。空格和下划线会被规范化。",
    "settings.projectInvalidLabel": "请输入 1–120 个可打印 Unicode 字符作为项目名称。",
    "settings.projectInvalidCwd": "请输入桥接允许根目录内现有文件夹的绝对路径。",
    "settings.projectDuplicateId": "规范化后的项目 ID 必须唯一。",
    "settings.projectDuplicatePath": "每个项目必须使用不同的规范文件夹。",
    "settings.projectDefaultMissing": "请选择列表中仍存在的默认项目，或选择无默认项目。",
    "settings.projectUnavailableSave": "保存前请修复或移除所有需要恢复的项目。",
    "settings.projectLimit": "最多可注册 100 个项目。",
    "settings.projectError": "请检查并修正“项目”部分中突出显示的值。"
  },
  "zh-Hant": {
    "settings.projects": "專案",
    "settings.projectsHint": "在此登錄具名資料夾。專案 ID 是穩定的路由鍵；顯示名稱與資料夾可以編輯。",
    "settings.allowedRoots": "橋接允許的根目錄",
    "settings.allowedRootsHint": "專案的實際路徑必須位於這些安全上限之一。登錄專案不會擴大範圍。",
    "settings.addProject": "新增專案",
    "settings.noProjects": "尚未登錄專案。如果沒有相容預設值，請在開始新工作前新增一個。",
    "settings.projectId": "專案 ID",
    "settings.projectIdHint": "已儲存的專案 ID 會保持穩定。只有需要新識別身分時才移除並重新新增。",
    "settings.projectLabel": "顯示名稱",
    "settings.projectCwd": "絕對資料夾",
    "settings.defaultProject": "選用預設專案",
    "settings.defaultProjectHint": "多個專案時使用的相容預設值。啟用專案感知路由後，留空將需要明確選擇專案。",
    "settings.defaultProjectNone": "無預設專案",
    "settings.projectAvailable": "可用",
    "settings.projectUnavailable": "需要復原",
    "settings.projectNew": "新增",
    "settings.removeProject": "移除",
    "settings.projectInvalidId": "請輸入 1–64 個以連字號分隔的小寫 ASCII 字母或數字。空格與底線會被正規化。",
    "settings.projectInvalidLabel": "請輸入 1–120 個可列印 Unicode 字元作為專案名稱。",
    "settings.projectInvalidCwd": "請輸入橋接允許根目錄內現有資料夾的絕對路徑。",
    "settings.projectDuplicateId": "正規化後的專案 ID 必須唯一。",
    "settings.projectDuplicatePath": "每個專案必須使用不同的正規資料夾。",
    "settings.projectDefaultMissing": "請選擇清單中仍存在的預設專案，或選擇無預設專案。",
    "settings.projectUnavailableSave": "儲存前請修正或移除所有需要復原的專案。",
    "settings.projectLimit": "最多可登錄 100 個專案。",
    "settings.projectError": "請檢查並修正「專案」區段中突顯的值。"
  },
  es: {
    "settings.projects": "Proyectos",
    "settings.projectsHint": "Registra carpetas con nombre. El ID es una clave de enrutamiento estable; la etiqueta y la carpeta se pueden editar.",
    "settings.allowedRoots": "Raíces permitidas por el puente",
    "settings.allowedRootsHint": "La ruta real de cada proyecto debe estar dentro de uno de estos límites de seguridad. Registrar un proyecto no los amplía.",
    "settings.addProject": "Añadir proyecto",
    "settings.noProjects": "No hay proyectos registrados. Añade uno antes de iniciar trabajo nuevo si no existe un valor predeterminado compatible.",
    "settings.projectId": "ID del proyecto",
    "settings.projectIdHint": "Los ID guardados son estables. Elimina y vuelve a añadir solo si necesitas una identidad nueva.",
    "settings.projectLabel": "Nombre visible",
    "settings.projectCwd": "Carpeta absoluta",
    "settings.defaultProject": "Proyecto predeterminado opcional",
    "settings.defaultProjectHint": "Valor compatible para varios proyectos. Cuando se active el enrutamiento por proyecto, dejarlo vacío exigirá una selección explícita.",
    "settings.defaultProjectNone": "Sin proyecto predeterminado",
    "settings.projectAvailable": "Disponible",
    "settings.projectUnavailable": "Necesita recuperación",
    "settings.projectNew": "Nuevo",
    "settings.removeProject": "Eliminar",
    "settings.projectInvalidId": "Usa de 1 a 64 letras ASCII minúsculas o dígitos separados por guiones. Los espacios y guiones bajos se normalizan.",
    "settings.projectInvalidLabel": "Introduce de 1 a 120 caracteres Unicode imprimibles para el nombre.",
    "settings.projectInvalidCwd": "Introduce una carpeta absoluta existente dentro de una raíz permitida.",
    "settings.projectDuplicateId": "Los ID deben ser únicos después de normalizarlos.",
    "settings.projectDuplicatePath": "Cada proyecto debe usar una carpeta canónica distinta.",
    "settings.projectDefaultMissing": "Elige un proyecto que siga en la lista o selecciona ninguno.",
    "settings.projectUnavailableSave": "Corrige o elimina todos los proyectos que necesitan recuperación antes de guardar.",
    "settings.projectLimit": "Se pueden registrar como máximo 100 proyectos.",
    "settings.projectError": "Revisa la sección Proyectos y corrige los valores resaltados."
  },
  fr: {
    "settings.projects": "Projets",
    "settings.projectsHint": "Enregistrez des dossiers nommés. L’ID est une clé de routage stable ; le libellé et le dossier restent modifiables.",
    "settings.allowedRoots": "Racines autorisées par le pont",
    "settings.allowedRootsHint": "Le chemin réel de chaque projet doit rester dans l’une de ces limites de sécurité. Enregistrer un projet ne les élargit pas.",
    "settings.addProject": "Ajouter un projet",
    "settings.noProjects": "Aucun projet enregistré. Ajoutez-en un avant un nouveau travail si aucune valeur compatible n’est disponible.",
    "settings.projectId": "ID du projet",
    "settings.projectIdHint": "Les ID enregistrés sont stables. Supprimez puis recréez uniquement si une nouvelle identité est voulue.",
    "settings.projectLabel": "Libellé affiché",
    "settings.projectCwd": "Dossier absolu",
    "settings.defaultProject": "Projet par défaut facultatif",
    "settings.defaultProjectHint": "Valeur compatible pour plusieurs projets. Une fois le routage par projet activé, l’absence de valeur imposera un choix explicite.",
    "settings.defaultProjectNone": "Aucun projet par défaut",
    "settings.projectAvailable": "Disponible",
    "settings.projectUnavailable": "Récupération requise",
    "settings.projectNew": "Nouveau",
    "settings.removeProject": "Supprimer",
    "settings.projectInvalidId": "Utilisez 1 à 64 lettres ASCII minuscules ou chiffres séparés par des tirets. Espaces et underscores sont normalisés.",
    "settings.projectInvalidLabel": "Saisissez 1 à 120 caractères Unicode imprimables pour le libellé.",
    "settings.projectInvalidCwd": "Saisissez un dossier absolu existant dans une racine autorisée.",
    "settings.projectDuplicateId": "Les ID doivent être uniques après normalisation.",
    "settings.projectDuplicatePath": "Chaque projet doit utiliser un dossier canonique différent.",
    "settings.projectDefaultMissing": "Choisissez un projet encore présent dans la liste, ou aucun projet par défaut.",
    "settings.projectUnavailableSave": "Corrigez ou supprimez tous les projets à récupérer avant l’enregistrement.",
    "settings.projectLimit": "Au maximum 100 projets peuvent être enregistrés.",
    "settings.projectError": "Vérifiez la section Projets et corrigez les valeurs surlignées."
  },
  de: {
    "settings.projects": "Projekte",
    "settings.projectsHint": "Registrieren Sie benannte Ordner. Die Projekt-ID ist ein stabiler Routing-Schlüssel; Anzeigename und Ordner sind bearbeitbar.",
    "settings.allowedRoots": "Von der Bridge erlaubte Stammordner",
    "settings.allowedRootsHint": "Der reale Projektpfad muss innerhalb einer dieser Sicherheitsgrenzen liegen. Ein Projekt erweitert sie nicht.",
    "settings.addProject": "Projekt hinzufügen",
    "settings.noProjects": "Keine Projekte registriert. Fügen Sie vor neuer Arbeit eines hinzu, wenn kein kompatibler Standard vorhanden ist.",
    "settings.projectId": "Projekt-ID",
    "settings.projectIdHint": "Gespeicherte Projekt-IDs bleiben stabil. Nur für eine neue Identität entfernen und neu hinzufügen.",
    "settings.projectLabel": "Anzeigename",
    "settings.projectCwd": "Absoluter Ordner",
    "settings.defaultProject": "Optionales Standardprojekt",
    "settings.defaultProjectHint": "Kompatibler Standard bei mehreren Projekten. Nach Aktivierung des projektbezogenen Routings erfordert keine Auswahl ein explizites Projekt.",
    "settings.defaultProjectNone": "Kein Standardprojekt",
    "settings.projectAvailable": "Verfügbar",
    "settings.projectUnavailable": "Wiederherstellung nötig",
    "settings.projectNew": "Neu",
    "settings.removeProject": "Entfernen",
    "settings.projectInvalidId": "Verwenden Sie 1–64 kleine ASCII-Buchstaben oder Ziffern, getrennt durch Bindestriche. Leerzeichen und Unterstriche werden normalisiert.",
    "settings.projectInvalidLabel": "Geben Sie 1–120 druckbare Unicode-Zeichen als Anzeigename ein.",
    "settings.projectInvalidCwd": "Geben Sie einen vorhandenen absoluten Ordner innerhalb eines erlaubten Stammordners ein.",
    "settings.projectDuplicateId": "Normalisierte Projekt-IDs müssen eindeutig sein.",
    "settings.projectDuplicatePath": "Jedes Projekt muss einen anderen kanonischen Ordner verwenden.",
    "settings.projectDefaultMissing": "Wählen Sie ein noch vorhandenes Projekt oder kein Standardprojekt.",
    "settings.projectUnavailableSave": "Korrigieren oder entfernen Sie vor dem Speichern alle wiederherzustellenden Projekte.",
    "settings.projectLimit": "Es können höchstens 100 Projekte registriert werden.",
    "settings.projectError": "Prüfen Sie den Bereich Projekte und korrigieren Sie die hervorgehobenen Werte."
  },
  pt: {
    "settings.projects": "Projetos",
    "settings.projectsHint": "Registre pastas nomeadas. O ID é uma chave de roteamento estável; o rótulo e a pasta podem ser editados.",
    "settings.allowedRoots": "Raízes permitidas pela ponte",
    "settings.allowedRootsHint": "O caminho real de cada projeto deve ficar dentro de um destes limites de segurança. Registrar um projeto não os amplia.",
    "settings.addProject": "Adicionar projeto",
    "settings.noProjects": "Nenhum projeto registrado. Adicione um antes de iniciar novo trabalho se não houver um padrão compatível.",
    "settings.projectId": "ID do projeto",
    "settings.projectIdHint": "IDs salvos são estáveis. Remova e adicione novamente apenas quando quiser uma nova identidade.",
    "settings.projectLabel": "Rótulo de exibição",
    "settings.projectCwd": "Pasta absoluta",
    "settings.defaultProject": "Projeto padrão opcional",
    "settings.defaultProjectHint": "Padrão compatível para vários projetos. Quando o roteamento por projeto for ativado, deixar vazio exigirá uma seleção explícita.",
    "settings.defaultProjectNone": "Sem projeto padrão",
    "settings.projectAvailable": "Disponível",
    "settings.projectUnavailable": "Precisa de recuperação",
    "settings.projectNew": "Novo",
    "settings.removeProject": "Remover",
    "settings.projectInvalidId": "Use de 1 a 64 letras ASCII minúsculas ou dígitos separados por hífens. Espaços e sublinhados são normalizados.",
    "settings.projectInvalidLabel": "Digite de 1 a 120 caracteres Unicode imprimíveis para o rótulo.",
    "settings.projectInvalidCwd": "Digite uma pasta absoluta existente dentro de uma raiz permitida.",
    "settings.projectDuplicateId": "Os IDs devem ser exclusivos após a normalização.",
    "settings.projectDuplicatePath": "Cada projeto deve usar uma pasta canônica diferente.",
    "settings.projectDefaultMissing": "Escolha um projeto que permaneça na lista ou nenhum projeto padrão.",
    "settings.projectUnavailableSave": "Corrija ou remova todos os projetos que precisam de recuperação antes de salvar.",
    "settings.projectLimit": "No máximo 100 projetos podem ser registrados.",
    "settings.projectError": "Revise a seção Projetos e corrija os valores destacados."
  }
};

export const UI_TRANSLATIONS: Record<SupportedUiLocale, UiTranslationBundle> = Object.fromEntries(
  SUPPORTED_UI_LOCALES.map((locale) => [
    locale,
    locale === "en"
      ? { ...ENGLISH }
      : locale === "ko"
        ? { ...ENGLISH, ...OVERRIDES[locale], ...STATE_OVERRIDES[locale], ...ISSUE19_OVERRIDES[locale], ...ISSUE20_OVERRIDES[locale], ...BACKGROUND_PROCESS_OVERRIDES[locale], ...ISSUE21_OVERRIDES[locale], ...ISSUE24_OVERRIDES[locale], ...ISSUE22_OVERRIDES[locale] }
        : { ...ENGLISH, ...OVERRIDES[locale], ...REMAINDER[locale], ...STATE_OVERRIDES[locale], ...ISSUE19_OVERRIDES[locale], ...ISSUE20_OVERRIDES[locale], ...BACKGROUND_PROCESS_OVERRIDES[locale], ...ISSUE21_OVERRIDES[locale], ...ISSUE24_OVERRIDES[locale], ...ISSUE22_OVERRIDES[locale] }
  ])
) as Record<SupportedUiLocale, UiTranslationBundle>;

export function resolveUiLocale(input?: string | null): SupportedUiLocale {
  const locale = (input || "en").trim().replace(/_/g, "-").toLowerCase();
  if (locale === "ko" || locale.startsWith("ko-")) return "ko";
  if (locale === "ja" || locale.startsWith("ja-")) return "ja";
  if (locale === "zh-hant" || /^zh-(tw|hk|mo)(-|$)/.test(locale)) return "zh-Hant";
  if (locale === "zh" || locale === "zh-hans" || locale.startsWith("zh-")) return "zh-Hans";
  if (locale === "es" || locale.startsWith("es-")) return "es";
  if (locale === "fr" || locale.startsWith("fr-")) return "fr";
  if (locale === "de" || locale.startsWith("de-")) return "de";
  if (locale === "pt" || locale.startsWith("pt-")) return "pt";
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

export function serializedUiTranslations(): string {
  return JSON.stringify(UI_TRANSLATIONS).replaceAll("<", "\\u003c");
}

const KNOWN_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

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
  const canonical = effort.trim();
  const bundle = UI_TRANSLATIONS[locale] || UI_TRANSLATIONS.en;
  const known = KNOWN_REASONING_EFFORTS.has(canonical);
  const labelKey = `effort.${canonical}.label` as UiTranslationKey;
  const descriptionKey = `effort.${canonical}.description` as UiTranslationKey;
  if (locale === "en" && upstreamDescription?.trim()) {
    return {
      effort: canonical,
      label: known ? bundle[labelKey] : canonical,
      description: upstreamDescription.trim(),
      descriptionSource: "upstream"
    };
  }
  if (known) {
    return {
      effort: canonical,
      label: bundle[labelKey],
      description: bundle[descriptionKey],
      descriptionSource: "localized"
    };
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
