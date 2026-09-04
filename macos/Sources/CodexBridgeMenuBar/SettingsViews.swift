import AppKit
import CodexBridgeKit
import SwiftUI

struct NativeSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var syncState = SettingsDraftSyncState()
    @State private var showDiscardDraftConfirmation = false

    var body: some View {
        Group {
            if model.needsSetup {
                ConnectionRepairView()
            } else if let snapshot = model.settings, let draft = syncState.draft {
                VStack(spacing: 10) {
                    HStack(spacing: 10) {
                        BridgeBrandStatusIcon(health: model.health, size: 32)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Codex MCP Bridge for ChatGPT")
                                .font(.headline)
                            Text("전역 설정")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    if syncState.externalChangeDetected {
                        HStack(spacing: 10) {
                            Label(
                                "다른 화면에서 설정이 변경되어 자동 저장을 멈췄습니다. 편집 내용을 유지하려면 확인한 뒤 최신 값을 다시 불러와 주세요.",
                                systemImage: "arrow.triangle.2.circlepath"
                            )
                            .font(.caption)
                            .foregroundStyle(.orange)
                            Spacer()
                            Button("최신 값 불러오기…") {
                                showDiscardDraftConfirmation = true
                            }
                        }
                    }
                    TabView {
                        GeneralSettingsPane(
                            snapshot: snapshot,
                            draft: binding(for: draft),
                            didReset: {
                                synchronizeDraft(force: true)
                                model.restorePersistedInterfaceLocale()
                            }
                        )
                            .environmentObject(model)
                            .tabItem { Label("일반", systemImage: "gearshape") }
                        ProjectsSettingsPane(snapshot: snapshot)
                            .environmentObject(model)
                            .tabItem { Label("프로젝트", systemImage: "folder") }
                        RuntimeStatusPane(snapshot: snapshot)
                            .environmentObject(model)
                            .tabItem { Label("서버", systemImage: "server.rack") }
                    }
                }
                .padding(18)
            } else if model.helperStatus?.bridge.connected != true {
                VStack(spacing: 12) {
                    BridgeBrandStatusIcon(health: .unavailable, size: 52)
                    Text("설정을 불러오려면 브리지 서버를 시작해 주세요.")
                    Button("서버 시작") { Task { await model.startRuntime() } }
                        .buttonStyle(.borderedProminent)
                    if let error = model.runtimeErrorMessage ?? model.statusErrorMessage {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                }
            } else {
                VStack(spacing: 12) {
                    if let error = model.settingsLoadErrorMessage {
                        BridgeBrandStatusIcon(health: .attention, size: 52)
                        Text("설정을 불러오지 못했습니다.")
                            .font(.headline)
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                        Button("다시 시도") { Task { await model.refreshSettings() } }
                    } else {
                        BridgeBrandMark()
                            .frame(width: 44, height: 44)
                        ProgressView("설정을 불러오는 중…")
                    }
                }
            }
        }
        .environment(\.locale, model.interfaceLocale)
        .onAppear { synchronizeDraft() }
        .onChange(of: model.settings?.settings.settingsRevision) { revision in
            guard let snapshot = model.settings else { return }
            if revision == model.lastAutosavedSettingsRevision,
               let submitted = model.lastAutosavedDraft {
                syncState.acknowledgePersisted(snapshot: snapshot, submitted: submitted)
                model.consumeAutosaveAcknowledgement(revision: revision ?? -1)
            } else {
                synchronizeDraft()
            }
        }
        .alert("설정 충돌", isPresented: Binding(
            get: { model.settingsConflictMessage != nil },
            set: { if !$0 { model.settingsConflictMessage = nil } }
        )) {
            Button("확인", role: .cancel) {}
        } message: {
            Text(model.settingsConflictMessage ?? "")
        }
        .confirmationDialog(
            "현재 편집 내용을 버리고 최신 설정을 불러올까요?",
            isPresented: $showDiscardDraftConfirmation
        ) {
            Button("편집 내용 버리기", role: .destructive) {
                model.cancelPendingSettingsAutosave()
                synchronizeDraft(force: true)
                model.restorePersistedInterfaceLocale()
            }
        }
    }

    private func synchronizeDraft(force: Bool = false) {
        guard let snapshot = model.settings else { return }
        syncState.synchronize(with: snapshot, force: force)
    }

    private func binding(for value: SettingsDraft) -> Binding<SettingsDraft> {
        Binding(
            get: { syncState.draft ?? value },
            set: { next in
                syncState.updateDraft(next)
                model.previewInterfaceLocale(next.uiLocalePreference)
                if !syncState.externalChangeDetected {
                    model.scheduleSettingsAutosave(next)
                }
            }
        )
    }
}

private struct GeneralSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot
    @Binding var draft: SettingsDraft
    let didReset: () -> Void
    @State private var showResetConfirmation = false

    private var choices: [ModelChoice] {
        SettingsDraft.displayedChoices(
            in: snapshot,
            allowDelegation: draft.allowDelegation,
            preservingKeys: draft.explicitSelectionKeys.union([
                draft.fixedSelectionKey
            ])
        )
    }
    private var selectableChoiceKeys: Set<String> {
        Set(SettingsDraft.selectableChoices(
            in: snapshot,
            allowDelegation: draft.allowDelegation
        ).map(\.key))
    }
    private var modelsByID: [String: CatalogModel] {
        snapshot.catalog.models.reduce(into: [:]) { models, model in
            if models[model.id] == nil {
                models[model.id] = model
            }
        }
    }
    private var modelIDs: [String] {
        var seen = Set<String>()
        return choices.map(\.model).filter { seen.insert($0).inserted }
    }

    var body: some View {
        Form {
            Section {
                Label(
                    "이 설정은 이 브리지 연결을 사용하는 모든 대화에 공유됩니다.",
                    systemImage: "person.2"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Section("접근 권한") {
                Picker("접근 전략", selection: $draft.accessStrategy) {
                    ForEach(snapshot.capabilities.availableAccessStrategies, id: \.self) {
                        Text(accessLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                Text(accessDescription(draft.accessStrategy, locale: model.interfaceLocale))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if draft.accessStrategy == "always-full" {
                    Label(
                        BridgeAppLocalization.string(
                            snapshot.capabilities.allowDangerFullAccess
                                ? "전체 접근은 이 macOS 사용자의 파일시스템과 네트워크 권한으로 Codex를 실행합니다."
                                : "전체 접근 선택은 보존되어 있지만 현재 최대 접근 권한이 제한되어 읽기 전용으로 실행됩니다. 서버 탭에서 최대 권한을 변경할 수 있습니다.",
                            locale: model.interfaceLocale
                        ),
                        systemImage: "exclamationmark.shield.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }

            Section("모델 정책") {
                Picker("선택 방식", selection: policyModeBinding) {
                    Text("고정").tag("fixed")
                    Text("자동").tag("automatic")
                }
                .pickerStyle(.segmented)

                if draft.policyMode == "fixed" {
                    Picker("모델", selection: fixedModelIDBinding) {
                        ForEach(modelIDs, id: \.self) { modelID in
                            Text(modelLabel(modelID)).tag(modelID)
                        }
                    }
                    Picker("추론 수준", selection: fixedEffortBinding) {
                        ForEach(choicesForFixedModel, id: \.key) { choice in
                            Text(effortLabel(choice)).tag(choice.reasoningEffort)
                        }
                    }
                } else {
                    Picker("자동 허용 범위", selection: $draft.allowedKind) {
                        Text("표시되는 전체 카탈로그").tag("catalog-visible")
                        Text("명시적으로 선택").tag("explicit")
                    }
                    if draft.allowedKind == "explicit" {
                        DisclosureGroup("허용 모델과 추론 수준") {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(modelIDs, id: \.self) { modelID in
                                    DisclosureGroup(modelLabel(modelID)) {
                                        VStack(alignment: .leading, spacing: 5) {
                                            ForEach(choices(for: modelID), id: \.key) { choice in
                                                Toggle(
                                                    effortLabel(choice),
                                                    isOn: explicitBinding(choice.key)
                                                )
                                                .disabled(
                                                    !selectableChoiceKeys.contains(choice.key) &&
                                                    !draft.explicitSelectionKeys.contains(choice.key)
                                                )
                                            }
                                        }
                                        .padding(.leading, 8)
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }

                Toggle(
                    "Ultra 추론 및 하위 에이전트 위임 허용",
                    isOn: $draft.allowDelegation
                )
                Text("끄면 Ultra 추론이 모델 목록에서 제외되고 하위 에이전트 위임이 차단됩니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Toggle("빠른 처리 우선 사용", isOn: $draft.usePriorityServiceTier)
                Text("지원되는 모델에서 Priority/Fast 처리 계층을 요청합니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if snapshot.catalog.stale {
                    Label("모델 카탈로그가 오래되어 정책 저장이 제한될 수 있습니다.", systemImage: "clock.badge.exclamationmark")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let warning = snapshot.catalog.warning {
                    Text(warning)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                }
                Button("모델 목록 새로고침") {
                    Task { await model.refreshSettings(refreshModels: true) }
                }
                .disabled(model.generalSettingsSaveState.isActive)
            }

            Section("표시와 실행") {
                Picker("앱 및 카드 언어", selection: $draft.uiLocalePreference) {
                    ForEach(snapshot.capabilities.availableUiLocalePreferences, id: \.self) {
                        Text(localeLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                Text("자동을 선택하면 macOS 앱은 Mac의 언어를, GPT 카드는 ChatGPT의 표시 언어를 따릅니다. 두 화면의 언어가 다를 수 있습니다. 언어를 직접 선택하면 앱과 GPT 카드에 동일하게 적용됩니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                LabeledContent("동시 실행 에이전트 작업 수") {
                    HStack(spacing: 6) {
                        TextField(
                            "개수",
                            value: concurrentJobsBinding,
                            format: .number
                        )
                        .frame(width: 58)
                        .multilineTextAlignment(.trailing)
                        .textFieldStyle(.roundedBorder)
                        Stepper(
                            "",
                            value: concurrentJobsBinding,
                            in: 1...snapshot.capabilities.maxConcurrentJobs
                        )
                        .labelsHidden()
                    }
                }
                Text(BridgeAppLocalization.format(
                    "1부터 운영 한도 %d까지 직접 입력할 수 있습니다. 등록된 에이전트 수가 아니라 동시에 실행할 작업의 상한입니다.",
                    locale: model.interfaceLocale,
                    snapshot.capabilities.maxConcurrentJobs
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if draft.maxConcurrentJobs > 30 {
                    Label(
                        "30을 넘기면 CPU·메모리·API 사용량이 크게 증가할 수 있습니다.",
                        systemImage: "gauge.with.dots.needle.67percent"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                Toggle("새 Agent 작업을 Codex 앱에 보존", isOn: $draft.showBridgeThreadsInCodexApp)
                Text(threadVisibilityDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Picker("액티비티 카드 표시", selection: activityCardVisibilityBinding) {
                    ForEach(snapshot.capabilities.availableActivityCardVisibilities, id: \.self) {
                        Text(activityVisibilityLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                Picker("완료 후 ChatGPT에 넘기기", selection: $draft.completionHandoff) {
                    ForEach(snapshot.capabilities.availableCompletionHandoffs, id: \.self) {
                        Text(handoffLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                .disabled(draft.activityCardVisibility == "never")
                if draft.activityCardVisibility == "never" {
                    Text("자동으로 넘기려면 액티비티 카드가 표시되어야 합니다.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Mac 앱") {
                Toggle(
                    "로그인 시 메뉴 막대 앱 열기",
                    isOn: Binding(
                        get: { model.menuBarLoginItemStatus.isEnabled },
                        set: { model.setMenuBarLaunchAtLogin($0) }
                    )
                )
                .disabled(model.loginItemOperationInProgress)

                Text(BridgeAppLocalization.string(
                    "이 Mac에만 즉시 적용됩니다. 이 설정을 꺼도 ChatGPT 연결을 위한 브리지 helper와 서버는 백그라운드에서 계속 실행됩니다.",
                    locale: model.interfaceLocale
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                switch model.menuBarLoginItemStatus {
                case .enabled:
                    Label("다음 사용자 로그인부터 메뉴 막대 앱이 자동으로 열립니다.", systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case .requiresApproval:
                    Label("macOS에서 로그인 항목 실행 승인이 필요합니다.", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                    Button("로그인 항목 설정 열기") {
                        model.openLoginItemsSystemSettings()
                    }
                case .notFound:
                    Label("설치된 앱 번들에서 로그인 항목을 찾지 못했습니다.", systemImage: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                case .unknown:
                    Label("로그인 항목 상태를 확인할 수 없습니다.", systemImage: "questionmark.circle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                case .notRegistered:
                    EmptyView()
                }

                if let error = model.loginItemErrorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }

            if let error = model.settingsErrorMessage ?? model.settingsLoadErrorMessage {
                Section("저장하지 못한 이유") {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }

            Section {
                HStack {
                    Button("일반 설정 초기화…", role: .destructive) {
                        model.cancelPendingSettingsAutosave()
                        showResetConfirmation = true
                    }
                    .disabled(model.isBusy || model.generalSettingsSaveState.isActive)
                    Spacer()
                    autosaveStatus
                }
            } footer: {
                Text("변경사항은 자동으로 저장되어 기존 ChatGPT 카드와 공유됩니다. 프로젝트 등록은 일반 설정 초기화에 포함되지 않습니다.")
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("일반 설정을 운영자 기본값으로 되돌릴까요?", isPresented: $showResetConfirmation) {
            Button("일반 설정 초기화", role: .destructive) {
                Task {
                    if await model.resetGeneralSettings() { didReset() }
                }
            }
        } message: {
            Text("등록된 프로젝트는 유지됩니다.")
        }
    }

    @ViewBuilder
    private var autosaveStatus: some View {
        switch model.generalSettingsSaveState {
        case .idle:
            Text("변경사항 자동 저장")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .pending:
            Label("저장 대기 중…", systemImage: "ellipsis")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .saving:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("저장 중…")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        case .saved:
            Label("저장됨", systemImage: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .failed:
            Label("저장하지 못함", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
        }
    }

    private var concurrentJobsBinding: Binding<Int> {
        Binding(
            get: { draft.maxConcurrentJobs },
            set: {
                draft.maxConcurrentJobs = min(
                    snapshot.capabilities.maxConcurrentJobs,
                    max(1, $0)
                )
            }
        )
    }

    private var threadVisibilityDescription: String {
        let key: String
        if snapshot.capabilities.defaultBackend == "app-server" {
            key = "켜면 이후 새 작업과 새 컨텍스트를 영구 스레드로 저장하고 현황에 'Codex에서 열기' 버튼을 표시합니다. 기존 임시 작업에는 소급 적용되지 않습니다. 끄면 임시 스레드로 실행되어 서버 재시작 뒤 이어갈 수 없습니다."
        } else {
            key = "MCP Server에서는 이 설정으로 Codex 앱 연결 여부를 바꿀 수 없습니다. App Server로 전환한 뒤 만드는 새 작업과 새 컨텍스트부터 적용됩니다."
        }
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    private func explicitBinding(_ key: String) -> Binding<Bool> {
        Binding(
            get: { draft.explicitSelectionKeys.contains(key) },
            set: { enabled in
                if enabled { draft.explicitSelectionKeys.insert(key) }
                else { draft.explicitSelectionKeys.remove(key) }
            }
        )
    }

    private var policyModeBinding: Binding<String> {
        Binding(
            get: { draft.policyMode },
            set: { mode in
                draft.policyMode = mode
                if mode == "fixed" && !selectableChoiceKeys.contains(draft.fixedSelectionKey),
                   let first = SettingsDraft.selectableChoices(
                       in: snapshot,
                       allowDelegation: draft.allowDelegation
                   ).first {
                    draft.fixedSelectionKey = first.key
                }
            }
        )
    }

    private var selectedFixedChoice: ModelChoice? {
        choices.first { $0.key == draft.fixedSelectionKey }
    }

    private var choicesForFixedModel: [ModelChoice] {
        let selectedModel = selectedFixedChoice?.model ?? modelIDs.first ?? ""
        return choices(for: selectedModel)
    }

    private var fixedModelIDBinding: Binding<String> {
        Binding(
            get: { selectedFixedChoice?.model ?? modelIDs.first ?? "" },
            set: { modelID in
                let candidates = choices(for: modelID)
                let previousEffort = selectedFixedChoice?.reasoningEffort
                let preferredEffort = modelsByID[modelID]?.defaultReasoningEffort
                let next = candidates.first {
                    $0.reasoningEffort == previousEffort && selectableChoiceKeys.contains($0.key)
                } ?? candidates.first {
                    $0.reasoningEffort == preferredEffort && selectableChoiceKeys.contains($0.key)
                } ?? candidates.first { selectableChoiceKeys.contains($0.key) }
                    ?? candidates.first
                if let next { draft.fixedSelectionKey = next.key }
            }
        )
    }

    private var fixedEffortBinding: Binding<String> {
        Binding(
            get: { selectedFixedChoice?.reasoningEffort ?? choicesForFixedModel.first?.reasoningEffort ?? "" },
            set: { effort in
                guard let modelID = selectedFixedChoice?.model ?? modelIDs.first,
                      let choice = choices(for: modelID).first(where: {
                          $0.reasoningEffort == effort
                      }) else { return }
                draft.fixedSelectionKey = choice.key
            }
        )
    }

    private func choices(for modelID: String) -> [ModelChoice] {
        choices.filter { $0.model == modelID }
    }

    private var activityCardVisibilityBinding: Binding<String> {
        Binding(
            get: { draft.activityCardVisibility },
            set: { draft.setActivityCardVisibility($0) }
        )
    }

    private func modelLabel(_ modelID: String) -> String {
        modelsByID[modelID]?.displayName ?? modelID
    }

    private func effortLabel(_ choice: ModelChoice) -> String {
        let effort = modelsByID[choice.model]?.supportedReasoningEfforts.first {
            $0.effort == choice.reasoningEffort
        }
        let unavailable: String
        if selectableChoiceKeys.contains(choice.key) {
            unavailable = ""
        } else if SettingsDraft.savedChoiceKeys(in: snapshot).contains(choice.key) {
            unavailable = BridgeAppLocalization.string(
                " (저장됨 · 현재 선택 불가)",
                locale: model.interfaceLocale
            )
        } else {
            unavailable = BridgeAppLocalization.string(
                " (현재 선택 불가)",
                locale: model.interfaceLocale
            )
        }
        let label = BridgeAppLocalization.reasoningEffortLabel(
            choice.reasoningEffort,
            fallback: effort?.label,
            locale: model.interfaceLocale
        )
        return "\(label)\(unavailable)"
    }
}

private struct RuntimeStatusPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot
    @State private var defaultBackend = "mcp-server"
    @State private var maximumAccess = "read-only"
    @State private var showApplyConfirmation = false
    @State private var showForceConfirmation = false

    private var savedConfiguration: RuntimeOperatorConfiguration? {
        model.helperStatus?.configuration.operatorConfiguration
    }

    private var isDirty: Bool {
        guard let savedConfiguration else { return false }
        return defaultBackend != savedConfiguration.defaultBackend ||
            maximumAccess != savedConfiguration.maximumAccess
    }

    private var nonRoutingWarnings: [String] {
        snapshot.warnings.filter { warning in
            !warning.localizedCaseInsensitiveContains("Backend routing:") &&
                !warning.contains("백엔드 라우팅:")
        }
    }

    private var canRetryWithForce: Bool {
        guard let error = model.runtimeErrorMessage else { return false }
        return error.contains("BACKGROUND_PROCESS") || error.contains("DRAIN_TIMEOUT")
    }

    private var backendDescription: String {
        let key: String
        if defaultBackend == "app-server" {
            key = "실험적 방식입니다. 스레드와 백그라운드 프로세스를 더 세밀하게 제어하고 Codex 앱에 표시되지 않는 임시 스레드를 지원합니다."
        } else {
            key = "안정적인 기본 방식입니다. 호환성과 복구 안정성을 우선하며 일부 스레드·백그라운드 프로세스 제어는 제한됩니다."
        }
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    var body: some View {
        Form {
            Section("서버 설정") {
                Picker("Codex 실행 백엔드", selection: $defaultBackend) {
                    Text("App Server").tag("app-server")
                    Text("MCP Server").tag("mcp-server")
                }
                Text(backendDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                DisclosureGroup("백엔드 전환 시 알아둘 점") {
                    Text("변경 사항은 서버를 재시작한 뒤 새 에이전트 또는 새로 시작한 에이전트부터 적용됩니다. 기존 에이전트는 생성 당시 백엔드를 계속 사용하며, 다른 백엔드로 새로 시작할 때는 이전 작업을 요약해 전달해야 합니다.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 3)
                }
                Picker("허용할 최대 접근 권한", selection: $maximumAccess) {
                    Text("읽기 전용").tag("read-only")
                    Text("작업 폴더 쓰기").tag("workspace-write")
                    Text("전체 접근").tag("full-access")
                }
                Text("이 값은 기존 비공개 .env에 저장되며 키체인을 사용하지 않습니다. 적용할 때 진행 중인 작업을 안전하게 비운 뒤 서버를 재시작합니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if maximumAccess == "full-access" {
                    Label(
                        "전체 접근은 이 macOS 사용자의 파일시스템과 네트워크 권한으로 Codex를 실행할 수 있게 합니다.",
                        systemImage: "exclamationmark.shield.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                HStack {
                    Spacer()
                    if model.isBusy { ProgressView().controlSize(.small) }
                    Button("저장하고 서버 재시작…") {
                        showApplyConfirmation = true
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        model.isBusy ||
                            model.generalSettingsSaveState.isActive ||
                            !isDirty
                    )
                }
            }

            if snapshot.policyActivation.developerModeRefreshRequired {
                Section("필요한 조치") {
                    Label(
                        "실행 한도가 바뀌었습니다. ChatGPT 개발자 모드에서 플러그인을 새로고침해 주세요.",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }

            if !nonRoutingWarnings.isEmpty {
                Section("확인할 사항") {
                    ForEach(nonRoutingWarnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .textSelection(.enabled)
                    }
                }
            }

            if let error = model.runtimeErrorMessage {
                Section("적용하지 못한 이유") {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                    if canRetryWithForce {
                        Button("강제로 저장하고 재시작…", role: .destructive) {
                            showForceConfirmation = true
                        }
                        .disabled(model.isBusy)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: synchronize)
        .onChange(of: model.helperStatus?.configuration.operatorConfiguration) { _ in
            if !isDirty { synchronize() }
        }
        .confirmationDialog(
            "런타임 설정을 저장하고 서버를 재시작할까요?",
            isPresented: $showApplyConfirmation
        ) {
            Button("저장하고 재시작") {
                Task {
                    if await model.configureRuntime(
                        defaultBackend: defaultBackend,
                        maximumAccess: maximumAccess
                    ) {
                        synchronize()
                    }
                }
            }
        } message: {
            Text("진행 중인 작업이 있으면 완료될 때까지 기다린 뒤 적용합니다.")
        }
        .confirmationDialog(
            "확인할 수 없는 백그라운드 프로세스를 무시하고 강제로 재시작할까요?",
            isPresented: $showForceConfirmation
        ) {
            Button("강제로 저장하고 재시작", role: .destructive) {
                Task {
                    if await model.configureRuntime(
                        defaultBackend: defaultBackend,
                        maximumAccess: maximumAccess,
                        force: true
                    ) {
                        synchronize()
                    }
                }
            }
        } message: {
            Text("실제로 실행 중인 Codex 작업이나 백그라운드 프로세스가 있으면 중단될 수 있습니다.")
        }
    }

    private func synchronize() {
        guard let savedConfiguration else { return }
        defaultBackend = savedConfiguration.defaultBackend
        maximumAccess = savedConfiguration.maximumAccess
    }
}

private struct ProjectsSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot
    @State private var editor: ProjectEditor?
    @State private var deletionTarget: BridgeProject?

    private var availability: [String: ProjectAvailability] {
        snapshot.capabilities.projectAvailability.reduce(into: [:]) { availability, item in
            if availability[item.projectId] == nil {
                availability[item.projectId] = item
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("프로젝트").font(.title2.bold())
                    Text("프로젝트 이름과 연결할 기존 폴더를 관리합니다. 앱은 실제 폴더나 파일을 이동하지 않습니다.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    if let folder = chooseFolder() {
                        editor = .add(
                            name: folder.lastPathComponent,
                            cwd: folder.path
                        )
                    }
                } label: {
                    Label("프로젝트 추가", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
            }

            List {
                if snapshot.settings.projects.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "folder.badge.plus")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text("등록된 프로젝트 없음").font(.headline)
                        Text("Codex 작업을 시작하려면 기존 폴더를 하나 이상 등록하세요.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(30)
                }
                ForEach(snapshot.settings.projects) { project in
                    ProjectRow(
                        project: project,
                        availability: availability[project.id],
                        rename: { editor = .rename(project) },
                        relocate: {
                            if let folder = chooseFolder() {
                                Task {
                                    await model.applyProjectOperation(
                                        .relocate(projectId: project.id, cwd: folder.path)
                                    )
                                }
                            }
                        },
                        archive: {
                            Task { await model.applyProjectOperation(.archive(projectId: project.id)) }
                        },
                        restore: { editor = .restore(project) },
                        delete: { deletionTarget = project }
                    )
                }
            }
            .listStyle(.inset)

            Text("등록을 삭제해도 실제 폴더·파일과 기존 작업 기록은 그대로 유지됩니다.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let error = model.settingsErrorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .sheet(item: $editor) { editor in
            ProjectEditorSheet(editor: editor) { operation in
                let succeeded = await model.applyProjectOperation(operation)
                if succeeded { self.editor = nil }
                return succeeded
            }
        }
        .confirmationDialog(
            "보관된 프로젝트 등록을 삭제할까요?",
            isPresented: Binding(
                get: { deletionTarget != nil },
                set: { if !$0 { deletionTarget = nil } }
            ),
            presenting: deletionTarget
        ) { project in
            Button("등록 삭제", role: .destructive) {
                Task {
                    if await model.applyProjectOperation(.delete(projectId: project.id)) {
                        deletionTarget = nil
                    }
                }
            }
        } message: { project in
            Text(BridgeAppLocalization.format(
                "‘%@’ 폴더와 기존 작업 기록은 그대로 유지됩니다.",
                locale: model.interfaceLocale,
                project.name
            ))
        }
    }

    private func chooseFolder() -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = BridgeAppLocalization.string("연결", locale: model.interfaceLocale)
        panel.message = BridgeAppLocalization.string(
            "연결할 폴더를 선택합니다. 실제 폴더나 파일은 이동하지 않습니다.",
            locale: model.interfaceLocale
        )
        return panel.runModal() == .OK ? panel.url : nil
    }
}

private struct ProjectRow: View {
    @EnvironmentObject private var model: AppModel
    let project: BridgeProject
    let availability: ProjectAvailability?
    let rename: () -> Void
    let relocate: () -> Void
    let archive: () -> Void
    let restore: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: project.archivedAt == nil ? "folder.fill" : "archivebox.fill")
                .font(.title2)
                .foregroundStyle(availability?.available == false ? Color.orange : Color.accentColor)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(project.name).font(.headline)
                    if project.archivedAt != nil {
                        Text("보관됨").font(.caption2).padding(4).background(.quaternary, in: Capsule())
                    }
                    if availability?.available == false {
                        Label("폴더 사용 불가", systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                Text(project.cwd)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            Spacer()
            Menu {
                if project.archivedAt == nil {
                    Button("이름 변경…", action: rename)
                    Button("연결 폴더 변경…", action: relocate)
                    Divider()
                    Button("보관", action: archive)
                } else {
                    Button("복원…", action: restore)
                    Divider()
                    Button("등록 삭제…", role: .destructive, action: delete)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(model.isBusy)
        }
        .padding(.vertical, 5)
    }
}

private enum ProjectEditor: Identifiable {
    case add(name: String, cwd: String)
    case rename(BridgeProject)
    case restore(BridgeProject)

    var id: String {
        switch self {
        case .add: return "add"
        case .rename(let project): return "rename-\(project.id)"
        case .restore(let project): return "restore-\(project.id)"
        }
    }
}

private struct ProjectEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @EnvironmentObject private var model: AppModel
    let editor: ProjectEditor
    let save: (ProjectOperation) async -> Bool
    @State private var name: String
    @State private var cwd: String
    @State private var isSaving = false

    init(editor: ProjectEditor, save: @escaping (ProjectOperation) async -> Bool) {
        self.editor = editor
        self.save = save
        switch editor {
        case .add(let name, let cwd):
            _name = State(initialValue: name)
            _cwd = State(initialValue: cwd)
        case .rename(let project), .restore(let project):
            _name = State(initialValue: project.name)
            _cwd = State(initialValue: project.cwd)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title2.bold())
            TextField("프로젝트 이름", text: $name)
            if case .rename = editor {
                EmptyView()
            } else {
                HStack {
                    TextField("폴더", text: $cwd).textFieldStyle(.roundedBorder)
                    Button("선택…") {
                        let panel = NSOpenPanel()
                        panel.canChooseFiles = false
                        panel.canChooseDirectories = true
                        panel.prompt = BridgeAppLocalization.string("연결", locale: locale)
                        panel.message = BridgeAppLocalization.string(
                            "연결할 폴더를 선택합니다. 실제 폴더나 파일은 이동하지 않습니다.",
                            locale: locale
                        )
                        if panel.runModal() == .OK, let url = panel.url { cwd = url.path }
                    }
                }
            }
            if let error = model.settingsErrorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            HStack {
                Button("취소", role: .cancel) { dismiss() }
                Spacer()
                if isSaving { ProgressView().controlSize(.small) }
                Button("저장") {
                    isSaving = true
                    Task {
                        if await save(operation) { dismiss() }
                        isSaving = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
            }
        }
        .padding(20)
        .frame(width: 480)
    }

    private var title: String {
        let key: String
        switch editor {
        case .add: key = "프로젝트 추가"
        case .rename: key = "프로젝트 이름 변경"
        case .restore: key = "프로젝트 복원"
        }
        return BridgeAppLocalization.string(key, locale: locale)
    }

    private var operation: ProjectOperation {
        switch editor {
        case .add:
            return .add(name: name, cwd: cwd)
        case .rename(let project):
            return .rename(projectId: project.id, name: name)
        case .restore(let project):
            return .restore(projectId: project.id, name: name, cwd: cwd)
        }
    }
}

private func accessLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "read-only": key = "읽기 전용"
    case "adaptive": key = "작업별 선택"
    case "always-full": key = "항상 전체 접근"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func accessDescription(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "read-only": key = "모든 새 작업을 읽기 전용으로 제한합니다."
    case "adaptive": key = "허용된 범위 안에서 작업마다 필요한 접근 수준을 선택합니다."
    case "always-full": key = "모든 새 작업에 전체 접근을 적용합니다."
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func localeLabel(_ value: String, locale: Locale) -> String {
    switch value {
    case "auto": return BridgeAppLocalization.string("자동", locale: locale)
    case "ko": return "한국어"
    case "en": return "English"
    case "ja": return "日本語"
    case "zh-Hans": return "简体中文"
    case "zh-Hant": return "繁體中文"
    case "es": return "Español"
    case "fr": return "Français"
    case "de": return "Deutsch"
    case "pt": return "Português"
    default: return value
    }
}

private func activityVisibilityLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "always": key = "항상"
    case "background-only": key = "백그라운드 작업만"
    case "never": key = "표시 안 함"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func handoffLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "off": key = "사용 안 함"
    case "auto-handoff": key = "완료 시 자동으로 ChatGPT에 넘기기"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func phaseLabel(_ value: String?, locale: Locale) -> String {
    let key: String
    switch value {
    case "running": key = "실행 중"
    case "starting": key = "시작 중"
    case "draining": key = "작업 종료 대기 중"
    case "stopping": key = "중지 중"
    case "backoff": key = "재시작 대기 중"
    case "safe-mode": key = "안전 모드"
    default: key = "중지됨"
    }
    return BridgeAppLocalization.string(key, locale: locale)
}
