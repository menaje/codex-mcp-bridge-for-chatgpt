import AppKit
import CodexBridgeKit
import SwiftUI

struct NativeSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var draft: SettingsDraft?
    @State private var loadedRevision = -1

    var body: some View {
        Group {
            if model.needsSetup {
                ConnectionRepairView()
            } else if let snapshot = model.settings, let draft {
                TabView {
                    GeneralSettingsPane(snapshot: snapshot, draft: binding(for: draft))
                        .environmentObject(model)
                        .tabItem { Label("일반", systemImage: "gearshape") }
                    ProjectsSettingsPane(snapshot: snapshot)
                        .environmentObject(model)
                        .tabItem { Label("프로젝트", systemImage: "folder") }
                }
                .padding(18)
            } else if model.helperStatus?.bridge.connected != true {
                VStack(spacing: 12) {
                    Image(systemName: "bolt.slash.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.orange)
                    Text("설정을 불러오려면 브리지 서버를 시작해 주세요.")
                    Button("서버 시작") { Task { await model.startRuntime() } }
                        .buttonStyle(.borderedProminent)
                    if let error = model.errorMessage {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                }
            } else {
                ProgressView("설정을 불러오는 중…")
            }
        }
        .onAppear { synchronizeDraft() }
        .onChange(of: model.settings?.settings.settingsRevision) { _ in synchronizeDraft() }
        .alert("설정 충돌", isPresented: Binding(
            get: { model.settingsConflictMessage != nil },
            set: { if !$0 { model.settingsConflictMessage = nil } }
        )) {
            Button("확인", role: .cancel) {}
        } message: {
            Text(model.settingsConflictMessage ?? "")
        }
    }

    private func synchronizeDraft() {
        guard let snapshot = model.settings else { return }
        let revision = snapshot.settings.settingsRevision
        guard loadedRevision != revision else { return }
        draft = SettingsDraft(snapshot: snapshot)
        loadedRevision = revision
    }

    private func binding(for value: SettingsDraft) -> Binding<SettingsDraft> {
        Binding(get: { draft ?? value }, set: { draft = $0 })
    }
}

private struct GeneralSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot
    @Binding var draft: SettingsDraft
    @State private var showResetConfirmation = false

    private var choices: [ModelChoice] { SettingsDraft.choices(in: snapshot) }
    private var modelsByID: [String: CatalogModel] {
        Dictionary(uniqueKeysWithValues: snapshot.catalog.models.map { ($0.id, $0) })
    }

    var body: some View {
        Form {
            Section("접근 권한") {
                Picker("접근 전략", selection: $draft.accessStrategy) {
                    ForEach(snapshot.capabilities.availableAccessStrategies, id: \.self) {
                        Text(accessLabel($0)).tag($0)
                    }
                }
                Text(accessDescription(draft.accessStrategy))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("모델 정책") {
                Picker("선택 방식", selection: $draft.policyMode) {
                    Text("고정").tag("fixed")
                    Text("자동").tag("automatic")
                }
                .pickerStyle(.segmented)

                if draft.policyMode == "fixed" {
                    Picker("모델 · reasoning", selection: $draft.fixedSelectionKey) {
                        ForEach(choices, id: \.key) { choice in
                            Text(choiceLabel(choice)).tag(choice.key)
                        }
                    }
                } else {
                    Picker("자동 허용 범위", selection: $draft.allowedKind) {
                        Text("표시되는 전체 카탈로그").tag("catalog-visible")
                        Text("명시적으로 선택").tag("explicit")
                    }
                    Picker("기본 fallback", selection: $draft.fallbackSelectionKey) {
                        Text("백엔드 기본값").tag("")
                        ForEach(choices, id: \.key) { choice in
                            Text(choiceLabel(choice)).tag(choice.key)
                        }
                    }
                    if draft.allowedKind == "explicit" {
                        DisclosureGroup("허용 모델과 reasoning effort") {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(choices, id: \.key) { choice in
                                    Toggle(choiceLabel(choice), isOn: explicitBinding(choice.key))
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }

                Toggle("Delegation 허용", isOn: $draft.allowDelegation)
                Toggle("Priority/Fast 처리 사용", isOn: $draft.usePriorityServiceTier)
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
            }

            Section("정책과 카탈로그 상태") {
                LabeledContent(
                    "실행 정책",
                    value: snapshot.policyActivation.executionPolicyActive ? "적용됨" : "확인 필요"
                )
                LabeledContent(
                    "정책 revision",
                    value: String(snapshot.policyActivation.policyRevision)
                )
                LabeledContent(
                    "실행 백엔드",
                    value: snapshot.capabilities.defaultBackend
                )
                LabeledContent(
                    "모델 카탈로그",
                    value: snapshot.catalog.source ?? "사용 가능한 캐시 없음"
                )
                LabeledContent("카탈로그 검증", value: snapshot.catalog.validation)
                LabeledContent(
                    "운영자 모델 상한",
                    value: snapshot.capabilities.operatorModelCeiling.map {
                        "모델·reasoning 조합 \($0.count)개"
                    } ?? "별도 제한 없음"
                )
                if snapshot.policyActivation.developerModeRefreshRequired {
                    Label(
                        "정적 실행 한도가 바뀌어 ChatGPT 플러그인 Refresh가 필요합니다.",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                } else if snapshot.policyActivation.descriptorProjectionUpdated {
                    Label("현재 실행 계약이 반영되었습니다.", systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("표시와 실행") {
                Picker("UI 언어", selection: $draft.uiLocalePreference) {
                    ForEach(snapshot.capabilities.availableUiLocalePreferences, id: \.self) {
                        Text(localeLabel($0)).tag($0)
                    }
                }
                Stepper(
                    "최대 동시 작업: \(draft.maxConcurrentJobs)",
                    value: $draft.maxConcurrentJobs,
                    in: 1...snapshot.capabilities.maxConcurrentJobs
                )
                Toggle("Codex 앱에서 bridge thread 표시", isOn: $draft.showBridgeThreadsInCodexApp)
                Picker("Activity 카드 표시", selection: $draft.activityCardVisibility) {
                    ForEach(snapshot.capabilities.availableActivityCardVisibilities, id: \.self) {
                        Text(activityVisibilityLabel($0)).tag($0)
                    }
                }
                Picker("완료 handoff", selection: $draft.completionHandoff) {
                    ForEach(snapshot.capabilities.availableCompletionHandoffs, id: \.self) {
                        Text(handoffLabel($0)).tag($0)
                    }
                }
            }

            if !snapshot.warnings.isEmpty {
                Section("현재 경고") {
                    ForEach(snapshot.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .textSelection(.enabled)
                    }
                }
            }

            Section {
                HStack {
                    Button("일반 설정 초기화…", role: .destructive) {
                        showResetConfirmation = true
                    }
                    Spacer()
                    if model.isBusy { ProgressView().controlSize(.small) }
                    Button("변경사항 저장") {
                        Task { await model.saveSettings(draft) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isBusy)
                }
            } footer: {
                Text("프로젝트 registry는 일반 설정 초기화에 포함되지 않습니다. 설정은 기존 ChatGPT 카드와 즉시 공유됩니다.")
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("일반 설정을 운영자 기본값으로 되돌릴까요?", isPresented: $showResetConfirmation) {
            Button("일반 설정 초기화", role: .destructive) {
                Task { await model.resetGeneralSettings() }
            }
        } message: {
            Text("등록된 프로젝트는 유지됩니다.")
        }
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

    private func choiceLabel(_ choice: ModelChoice) -> String {
        let model = modelsByID[choice.model]
        let effort = model?.supportedReasoningEfforts.first {
            $0.effort == choice.reasoningEffort
        }
        return "\(model?.displayName ?? choice.model) · \(effort?.label ?? choice.reasoningEffort)"
    }
}

private struct ProjectsSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot
    @State private var editor: ProjectEditor?
    @State private var deletionTarget: BridgeProject?

    private var availability: [String: ProjectAvailability] {
        Dictionary(uniqueKeysWithValues: snapshot.capabilities.projectAvailability.map {
            ($0.projectId, $0)
        })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("프로젝트").font(.title2.bold())
                    Text("폴더는 앱에 저장되지 않고 기존 bridge registry에서 관리됩니다.")
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

            Text("Registry revision \(snapshot.settings.registryRevision) · 삭제는 등록 정보만 제거하며 폴더와 작업 기록은 삭제하지 않습니다.")
                .font(.caption)
                .foregroundStyle(.secondary)
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
            Text("‘\(project.name)’ 폴더와 기존 작업 기록은 그대로 유지됩니다.")
        }
    }

    private func chooseFolder() -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "선택"
        return panel.runModal() == .OK ? panel.url : nil
    }
}

private struct ProjectRow: View {
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
                    Button("폴더 이전…", action: relocate)
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
                        if panel.runModal() == .OK, let url = panel.url { cwd = url.path }
                    }
                }
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
        switch editor {
        case .add: return "프로젝트 추가"
        case .rename: return "프로젝트 이름 변경"
        case .restore: return "프로젝트 복원"
        }
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

private func accessLabel(_ value: String) -> String {
    switch value {
    case "read-only": return "읽기 전용"
    case "adaptive": return "작업별 선택"
    case "always-full": return "항상 전체 접근"
    default: return value
    }
}

private func accessDescription(_ value: String) -> String {
    switch value {
    case "read-only": return "모든 새 작업을 읽기 전용 sandbox로 제한합니다."
    case "adaptive": return "허용된 범위 안에서 작업마다 필요한 접근 수준을 선택합니다."
    case "always-full": return "모든 새 작업에 danger-full-access를 적용합니다."
    default: return value
    }
}

private func localeLabel(_ value: String) -> String {
    switch value {
    case "auto": return "자동"
    case "ko": return "한국어"
    case "en": return "English"
    default: return value
    }
}

private func activityVisibilityLabel(_ value: String) -> String {
    switch value {
    case "always": return "항상"
    case "background-only": return "백그라운드 작업만"
    case "never": return "표시 안 함"
    default: return value
    }
}

private func handoffLabel(_ value: String) -> String {
    switch value {
    case "off": return "사용 안 함"
    case "auto-handoff": return "완료 시 자동 handoff"
    default: return value
    }
}

private func phaseLabel(_ value: String?) -> String {
    switch value {
    case "running": return "실행 중"
    case "starting": return "시작 중"
    case "draining": return "작업 종료 대기 중"
    case "stopping": return "중지 중"
    case "backoff": return "재시작 대기 중"
    case "safe-mode": return "안전 모드"
    default: return "중지됨"
    }
}
