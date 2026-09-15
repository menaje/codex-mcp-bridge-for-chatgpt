import AppKit
import CodexBridgeKit
import Darwin
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class SkillsLibraryWindowState: ObservableObject {
    @Published var hasUnsavedChanges = false {
        didSet {
            if hasUnsavedChanges { applicationShutdownDiscardApproved = false }
        }
    }
    private(set) var applicationShutdownDiscardApproved = false

    func confirmDiscardIfNeeded(_ decision: () -> Bool) -> Bool {
        guard hasUnsavedChanges else { return true }
        guard decision() else { return false }
        hasUnsavedChanges = false
        return true
    }

    func confirmDiscardForApplicationShutdown(_ decision: () -> Bool) -> Bool {
        guard hasUnsavedChanges else { return true }
        guard !applicationShutdownDiscardApproved else { return true }
        guard decision() else { return false }
        applicationShutdownDiscardApproved = true
        return true
    }

    func completeApplicationShutdownDiscard() {
        guard applicationShutdownDiscardApproved else { return }
        applicationShutdownDiscardApproved = false
        hasUnsavedChanges = false
    }

    func cancelApplicationShutdownDiscard() {
        applicationShutdownDiscardApproved = false
    }
}

struct SkillsLibraryLocalizedRootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        SkillsLibraryWindowView()
            .environment(\.locale, model.interfaceLocale)
    }
}

extension Notification.Name {
    static let bridgeSkillCommandNew = Notification.Name("bridge.skill.command.new")
    static let bridgeSkillCommandImport = Notification.Name("bridge.skill.command.import")
    static let bridgeSkillCommandSave = Notification.Name("bridge.skill.command.save")
    static let bridgeSkillCommandFind = Notification.Name("bridge.skill.command.find")
    static let bridgeSkillCommandToggleEdit = Notification.Name("bridge.skill.command.toggle-edit")
}

private enum SkillLibraryScope: String, CaseIterable, Identifiable {
    case all
    case active
    case archived

    var id: String { rawValue }
    var title: LocalizedStringKey {
        switch self {
        case .all: "모든 스킬"
        case .active: "활성"
        case .archived: "보관됨"
        }
    }
}

private enum SkillDocumentSelection: Hashable {
    case main
    case file(String)
}

enum BridgeSkillMarkdownNavigationTarget: Equatable {
    case main
    case file(String)
}

func resolveBridgeSkillMarkdownNavigationTarget(
    linkPath: String,
    currentFilePath: String?,
    availableFilePaths: [String]
) -> BridgeSkillMarkdownNavigationTarget? {
    let decoded = (linkPath.removingPercentEncoding ?? linkPath)
        .precomposedStringWithCanonicalMapping
    guard !decoded.isEmpty,
          !decoded.hasPrefix("/"),
          !decoded.contains("\\"),
          decoded.range(of: "^[A-Za-z]:", options: .regularExpression) == nil,
          !decoded.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }

    var segments = currentFilePath?
        .precomposedStringWithCanonicalMapping
        .split(separator: "/", omittingEmptySubsequences: false)
        .dropLast()
        .map(String.init) ?? []
    for segment in decoded.split(separator: "/", omittingEmptySubsequences: false).map(String.init) {
        if segment == "." { continue }
        if segment == ".." {
            guard !segments.isEmpty else { return nil }
            segments.removeLast()
        } else {
            guard !segment.isEmpty else { return nil }
            segments.append(segment)
        }
    }

    let resolvedPath = segments.joined(separator: "/")
    let comparisonKey: (String) -> String = {
        $0.precomposedStringWithCanonicalMapping.lowercased(with: Locale(identifier: "en_US"))
    }
    if comparisonKey(resolvedPath) == "document.md" { return .main }
    guard let storedPath = availableFilePaths.first(where: {
        comparisonKey($0) == comparisonKey(resolvedPath)
    }) else { return nil }
    return .file(storedPath)
}

enum SkillsLibraryAdaptiveColumns {
    static let inspectorCompactWidth: CGFloat = 1_050

    static func shouldCollapseForInspector(isPresented: Bool, contentWidth: CGFloat) -> Bool {
        isPresented && contentWidth < inspectorCompactWidth
    }
}

private enum SkillEditorMode: String, CaseIterable, Identifiable {
    case preview
    case edit
    case split

    var id: String { rawValue }
    var title: LocalizedStringKey {
        switch self {
        case .preview: "미리보기"
        case .edit: "편집"
        case .split: "나란히 보기"
        }
    }
    var symbol: String {
        switch self {
        case .preview: "doc.richtext"
        case .edit: "square.and.pencil"
        case .split: "rectangle.split.2x1"
        }
    }
}

private enum SkillLibrarySheet: Identifiable {
    case newSkill
    case newFile
    case renameFile(String)
    case deleteSkill(BridgeSkillDocument)
    case importReview(BridgeSkillImportReview)

    var id: String {
        switch self {
        case .newSkill: "new-skill"
        case .newFile: "new-file"
        case .renameFile(let path): "rename-\(path)"
        case .deleteSkill(let document): "delete-\(document.id)"
        case .importReview(let review): "import-\(review.id)"
        }
    }
}

struct SkillsLibraryWindowView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var windowState: SkillsLibraryWindowState
    @Environment(\.locale) private var locale
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var scope: SkillLibraryScope = .all
    @State private var searchText = ""
    @State private var documentSelection: SkillDocumentSelection = .main
    @State private var editorMode: SkillEditorMode = .preview
    @State private var draftContent = ""
    @State private var draftName = ""
    @State private var draftDescription = ""
    @State private var pendingSkillID: String?
    @State private var pendingDocumentSelection: SkillDocumentSelection?
    @State private var pendingVersionReference: BridgeSkillReference?
    @State private var postMutationDocumentSelection: SkillDocumentSelection?
    @State private var showsDiscardConfirmation = false
    @State private var showsRestoreConfirmation = false
    @State private var restoreTarget: BridgeSkillVersionSummary?
    @AppStorage("SkillsLibraryShowsInspectorV2") private var showsInspector = false
    @AppStorage("SkillsLibraryColumnVisibilityV2") private var savedColumnVisibility = "automatic"
    @State private var compactInspectorPreviousVisibility: NavigationSplitViewVisibility?
    @State private var sheet: SkillLibrarySheet?
    @State private var isDropTargeted = false
    @State private var importTargetSkillID: String?

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            skillSidebar
                .navigationSplitViewColumnWidth(min: 190, ideal: 250, max: 330)
                .background(SplitViewAutosaveAnchor(name: "CodexBridgeSkillsNavigationSplit"))
        } content: {
            documentSidebar
                .navigationSplitViewColumnWidth(min: 190, ideal: 275, max: 380)
        } detail: {
            detailWithInspector
        }
        .navigationSplitViewStyle(.balanced)
        .searchable(text: $searchText, placement: .sidebar, prompt: "브리지 스킬 검색")
        .toolbar { libraryToolbar }
        .sheet(item: $sheet) { presentedSheet($0) }
        .confirmationDialog(
            "저장하지 않은 변경사항을 버릴까요?",
            isPresented: $showsDiscardConfirmation,
            titleVisibility: .visible
        ) {
            Button("변경사항 버리기", role: .destructive) { discardAndApplyPendingSelection() }
            Button("취소", role: .cancel) {
                pendingSkillID = nil
                pendingDocumentSelection = nil
                pendingVersionReference = nil
            }
        } message: {
            Text("다른 문서로 이동하면 현재 Markdown 편집 내용이 사라집니다.")
        }
        .confirmationDialog(
            "선택한 버전을 새 현재 버전으로 복원할까요?",
            isPresented: $showsRestoreConfirmation,
            titleVisibility: .visible
        ) {
            Button("새 버전으로 복원") { restoreSelectedVersion() }
            Button("취소", role: .cancel) { restoreTarget = nil }
        } message: {
            Text("메인 문서와 첨부 파일 트리 전체를 복사해 새 불변 버전을 만듭니다.")
        }
        .task {
            compactInspectorPreviousVisibility = nil
            restoreColumnVisibility()
            await Task.yield()
            if showsInspector {
                synchronizeNavigationForWindowWidth(SkillsLibraryWindowController.shared.contentWidth ?? 1_120)
            }
            await model.refreshSkillLibrary()
        }
        .onChange(of: columnVisibility) { visibility in saveColumnVisibility(visibility) }
        .onChange(of: showsInspector) { visible in synchronizeNavigationForInspector(visible) }
        .onChange(of: model.selectedBridgeSkill?.id) { _ in synchronizeSelectionFromModel() }
        .onChange(of: model.selectedBridgeSkillFile?.id) { _ in synchronizeDraftFromModel() }
        .onChange(of: editorMode) { mode in
            if mode != .preview, !isEditingCurrentSource { synchronizeDraftFromModel() }
            updateDirtyState()
        }
        .onChange(of: draftContent) { _ in updateDirtyState() }
        .onChange(of: draftName) { _ in updateDirtyState() }
        .onChange(of: draftDescription) { _ in updateDirtyState() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResizeNotification)) { notification in
            guard let resizedWindow = notification.object as? NSWindow,
                  SkillsLibraryWindowController.shared.manages(resizedWindow) else { return }
            synchronizeNavigationForWindowWidth(resizedWindow.contentLayoutRect.width)
        }
        .onReceive(NotificationCenter.default.publisher(for: .bridgeSkillCommandNew)) { _ in
            guard !windowState.hasUnsavedChanges else { NSSound.beep(); return }
            sheet = .newSkill
        }
        .onReceive(NotificationCenter.default.publisher(for: .bridgeSkillCommandImport)) { _ in
            guard !windowState.hasUnsavedChanges else { NSSound.beep(); return }
            presentImportPanel(intoCurrentSkill: false)
        }
        .onReceive(NotificationCenter.default.publisher(for: .bridgeSkillCommandSave)) { _ in
            saveCurrentDocument()
        }
        .onReceive(NotificationCenter.default.publisher(for: .bridgeSkillCommandFind)) { _ in
            focusSkillSearch()
        }
        .onReceive(NotificationCenter.default.publisher(for: .bridgeSkillCommandToggleEdit)) { _ in
            toggleEditingMode()
        }
        .onDrop(of: [UTType.fileURL.identifier], isTargeted: $isDropTargeted) { providers in
            guard !windowState.hasUnsavedChanges else { NSSound.beep(); return false }
            loadDroppedURLs(providers)
            return true
        }
        .overlay {
            if isDropTargeted {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 3, dash: [8]))
                    .background(Color.accentColor.opacity(0.08))
                    .padding(8)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }

    @ViewBuilder
    private var detailWithInspector: some View {
        if #available(macOS 14.0, *) {
            documentDetail
                .frame(minWidth: 390, maxWidth: .infinity, maxHeight: .infinity)
                .inspector(isPresented: $showsInspector) {
                    versionInspector
                        .inspectorColumnWidth(min: 260, ideal: 300, max: 360)
                }
        } else {
            documentDetail
                .frame(minWidth: 390, maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .trailing) {
                    if showsInspector {
                        versionInspector
                            .frame(width: 300)
                            .frame(maxHeight: .infinity)
                            .background(.regularMaterial)
                            .overlay(alignment: .leading) { Divider() }
                            .shadow(color: .black.opacity(0.12), radius: 8, x: -2)
                            .transition(.move(edge: .trailing))
                    }
                }
                .animation(.default, value: showsInspector)
        }
    }

    private var skillSidebar: some View {
        VStack(spacing: 0) {
            Picker("표시 범위", selection: $scope) {
                ForEach(SkillLibraryScope.allCases) { option in Text(option.title).tag(option) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(10)

            if let snapshot = model.skillLibrary {
                let skills = filteredSkills(snapshot.skills)
                if skills.isEmpty {
                    SkillEmptyState(
                        title: searchText.isEmpty ? "브리지 스킬이 없습니다" : "검색 결과가 없습니다",
                        symbol: searchText.isEmpty ? "books.vertical" : "magnifyingglass",
                        detail: searchText.isEmpty
                            ? "새 자유형 Markdown 스킬을 만들거나 파일·폴더·ZIP을 가져오세요."
                            : "다른 검색어나 표시 범위를 사용해 보세요."
                    )
                } else {
                    List(skills, selection: selectedSkillBinding) { skill in
                        SkillSummaryRow(skill: skill)
                            .tag(skill.skillId)
                            .contextMenu { skillContextMenu(skill) }
                    }
                    .listStyle(.sidebar)
                    .accessibilityLabel("브리지 스킬 목록")
                }
            } else if model.bridgeConnected {
                ProgressView("스킬 라이브러리를 불러오는 중…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                SkillEmptyState(
                    title: "브리지에 연결할 수 없습니다",
                    symbol: "bolt.horizontal.circle",
                    detail: "연결 상태를 확인한 뒤 다시 시도하세요."
                )
            }
        }
    }

    private var documentSidebar: some View {
        Group {
            if let document = model.selectedBridgeSkill {
                List(selection: selectedDocumentBinding) {
                    Section("문서") {
                        Label("메인 문서", systemImage: "doc.text")
                            .tag(SkillDocumentSelection.main)
                            .contextMenu { mainDocumentContextMenu(document) }
                    }
                    if !document.files.isEmpty {
                        Section("첨부 Markdown") {
                            OutlineGroup(SkillFileTree.nodes(for: document.files), children: \.children) { node in
                                skillFileTreeRow(node, document: document)
                            }
                        }
                    }
                }
                .listStyle(.inset)
                .navigationTitle(document.skill.name)
                .accessibilityLabel("스킬 문서 파일 트리")
            } else {
                SkillEmptyState(
                    title: "스킬을 선택하세요",
                    symbol: "doc.text.magnifyingglass",
                    detail: "왼쪽 목록에서 관리할 브리지 스킬을 선택하세요."
                )
            }
        }
    }

    @ViewBuilder
    private var documentDetail: some View {
        if let document = model.selectedBridgeSkill {
            VStack(spacing: 0) {
                if let message = model.skillLibraryErrorMessage ?? model.skillMutationErrorMessage {
                    SkillStatusBanner(style: .error, message: message)
                }
                ForEach(document.warnings, id: \.self) { warning in
                    SkillStatusBanner(style: .warning, message: warning.localizedDescription(locale: locale))
                }
                if !isCurrentVersion(document) {
                    SkillStatusBanner(style: .warning, message: BridgeAppLocalization.string(
                        "과거 불변 버전을 보고 있습니다. 내용을 바꾸려면 버전 이력에서 새 현재 버전으로 복원하세요.",
                        locale: locale
                    ))
                }
                documentHeader(document)
                Divider()
                sourceWorkspace(document)
            }
            .navigationTitle(selectedDocumentTitle(document))
        } else {
            SkillEmptyState(
                title: "브리지 스킬 라이브러리",
                symbol: "books.vertical",
                detail: "스킬을 선택하거나 새 Markdown 스킬을 만드세요."
            )
        }
    }

    private func documentHeader(_ document: BridgeSkillDocument) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(selectedDocumentTitle(document)).font(.headline)
                if documentSelection == .main, !document.skill.description.isEmpty {
                    Text(document.skill.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                } else if case .file(let path) = documentSelection {
                    Text(path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            Spacer()
            Text("v\(document.skill.version)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityLabel(Text("버전 \(document.skill.version)"))
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private func sourceWorkspace(_ document: BridgeSkillDocument) -> some View {
        if model.bridgeSkillFileLoading {
            ProgressView("Markdown 파일을 불러오는 중…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if case .file = documentSelection, model.selectedBridgeSkillFile == nil {
            SkillEmptyState(
                title: "파일을 불러올 수 없습니다",
                symbol: "doc.badge.ellipsis",
                detail: "파일을 다시 선택하거나 연결 상태를 확인하세요."
            )
        } else {
            switch editorMode {
            case .preview:
                SafeMarkdownView(
                    markdown: windowState.hasUnsavedChanges ? draftContent : currentSource(document),
                    onOpenRelativeLink: openRelativeLink
                )
            case .edit:
                wholeDocumentEditor
            case .split:
                HSplitView {
                    wholeDocumentEditor
                        .frame(minWidth: 280)
                        .background(SplitViewAutosaveAnchor(name: "CodexBridgeSkillsEditorSplit"))
                    SafeMarkdownView(markdown: draftContent, onOpenRelativeLink: openRelativeLink).frame(minWidth: 280)
                }
            }
        }
    }

    private var wholeDocumentEditor: some View {
        VStack(spacing: 0) {
            if documentSelection == .main {
                VStack(spacing: 8) {
                    TextField("스킬 이름", text: $draftName)
                        .font(.headline)
                    TextField("검색용 설명(선택)", text: $draftDescription)
                        .font(.callout)
                }
                .textFieldStyle(.roundedBorder)
                .padding(12)
                Divider()
            }
            TextEditor(text: $draftContent)
                .font(.system(.body, design: .monospaced))
                .scrollContentBackground(.hidden)
                .padding(10)
                .background(Color(nsColor: .textBackgroundColor))
                .textSelection(.enabled)
                .accessibilityLabel("선택한 파일 전체 Markdown 원문")
        }
    }

    @ToolbarContentBuilder
    private var libraryToolbar: some ToolbarContent {
        ToolbarItem(placement: .automatic) {
            Menu {
                Button("새 스킬", systemImage: "doc.badge.plus") { sheet = .newSkill }
                Button("새 Markdown 파일", systemImage: "doc.badge.plus") { sheet = .newFile }
                    .disabled(model.selectedBridgeSkill.map { !isCurrentVersion($0) } ?? true)
                Divider()
                Button("파일·폴더·ZIP으로 새 스킬 가져오기…", systemImage: "square.and.arrow.down") {
                    presentImportPanel(intoCurrentSkill: false)
                }
                if let document = model.selectedBridgeSkill, isCurrentVersion(document) {
                    Button("현재 스킬로 가져오기…", systemImage: "doc.badge.arrow.up") {
                        presentImportPanel(intoCurrentSkill: true)
                    }
                }
            } label: {
                Label("추가", systemImage: "plus")
            }
            .help("새 스킬 또는 Markdown 파일 추가")
            .disabled(windowState.hasUnsavedChanges)
        }
        ToolbarItem(placement: .automatic) {
            Button { presentImportPanel(intoCurrentSkill: false) } label: {
                Label("새 스킬 가져오기", systemImage: "square.and.arrow.down")
            }
                .help("Markdown 파일, 폴더 또는 ZIP 가져오기")
                .disabled(windowState.hasUnsavedChanges)
        }
        ToolbarItem(placement: .primaryAction) {
            Picker("보기 방식", selection: $editorMode) {
                ForEach(SkillEditorMode.allCases) { mode in Label(mode.title, systemImage: mode.symbol).tag(mode) }
            }
            .pickerStyle(.segmented)
            .frame(width: 240)
            .disabled(model.selectedBridgeSkill.map { !isCurrentVersion($0) } ?? true)
        }
        ToolbarItem(placement: .primaryAction) {
            Button("저장", systemImage: "square.and.arrow.down") { saveCurrentDocument() }
                .disabled(!windowState.hasUnsavedChanges || model.skillMutationInProgress ||
                          model.selectedBridgeSkill.map { !isCurrentVersion($0) } ?? true)
        }
        ToolbarItem(placement: .primaryAction) {
            if let document = model.selectedBridgeSkill,
               let history = model.selectedBridgeSkillVersions {
                Menu {
                    ForEach(history.versions) { version in
                        Button {
                            requestVersion(version)
                        } label: {
                            Label(
                                "v\(version.version) · \(version.createdAt)",
                                systemImage: version.version == document.skill.version ? "checkmark" : "doc"
                            )
                        }
                    }
                } label: {
                    Label {
                        Text("버전") + Text(verbatim: " v\(document.skill.version)")
                    } icon: {
                        Image(systemName: "clock.arrow.circlepath")
                    }
                }
                .help("버전 이력과 메타데이터")
            }
        }
        ToolbarItem(placement: .primaryAction) {
            if let document = model.selectedBridgeSkill {
                Button("ZIP으로 내보내기…", systemImage: "square.and.arrow.up") { export(document) }
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Button { setInspectorPresented(!showsInspector) } label: { Label("버전과 정보", systemImage: "sidebar.trailing") }
                .help("버전 이력과 메타데이터")
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                if let document = model.selectedBridgeSkill {
                    Button(document.skill.enabled ? "보관" : "다시 활성화",
                           systemImage: document.skill.enabled ? "archivebox" : "tray.and.arrow.up") {
                        toggleArchived(document)
                    }
                    .disabled(windowState.hasUnsavedChanges)
                    Button("영구 삭제…", systemImage: "trash", role: .destructive) { sheet = .deleteSkill(document) }
                        .disabled(windowState.hasUnsavedChanges)
                }
                Button("새로 고침", systemImage: "arrow.clockwise") { Task { await model.refreshSkillLibrary() } }
            } label: { Label("추가 작업", systemImage: "ellipsis.circle") }
            .disabled(model.selectedBridgeSkill == nil && model.skillLibrary == nil)
        }
    }

    private var versionInspector: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("스킬 정보").font(.headline)
                if let document = model.selectedBridgeSkill {
                    LabeledContent("이름", value: document.skill.name)
                    LabeledContent("버전", value: "v\(document.skill.version)")
                    LabeledContent("상태", value: document.skill.enabled ? "활성" : "보관됨")
                    LabeledContent("파일", value: "\(document.files.count + 1)")
                    if let digest = document.skill.contentDigest {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("콘텐츠 확인값").font(.caption).foregroundStyle(.secondary)
                            Text(digest).font(.caption2.monospaced()).textSelection(.enabled)
                        }
                    }
                    Divider()
                    Text("버전 이력").font(.headline)
                    if let versions = model.selectedBridgeSkillVersions?.versions {
                        ForEach(versions) { version in
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Text("v\(version.version)").font(.body.monospacedDigit().weight(.medium))
                                    if version.version == model.selectedBridgeSkillVersions?.currentVersion {
                                        Text("현재").font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button("보기") { requestVersion(version) }.buttonStyle(.link)
                                }
                                Text(DisplayFormat.dateTime(version.createdAt, locale: locale))
                                    .font(.caption).foregroundStyle(.secondary)
                                if version.legacy {
                                    Label("이전 형식", systemImage: "exclamationmark.triangle")
                                        .font(.caption).foregroundStyle(.orange)
                                }
                                if version.version != model.selectedBridgeSkillVersions?.currentVersion {
                                    Button("새 현재 버전으로 복원") {
                                        restoreTarget = version
                                        showsRestoreConfirmation = true
                                    }
                                    .font(.caption)
                                }
                            }
                            Divider()
                        }
                    } else {
                        ProgressView().controlSize(.small)
                    }
                } else {
                    Text("스킬을 선택하면 메타데이터와 불변 버전 이력을 볼 수 있습니다.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private func presentedSheet(_ item: SkillLibrarySheet) -> some View {
        switch item {
        case .newSkill:
            NewBridgeSkillSheet { name, description, document in
                Task { @MainActor in
                    if await model.createBridgeSkill(.init(name: name, description: description, document: document)) {
                        sheet = nil
                    }
                }
            }
        case .newFile:
            NewBridgeSkillFileSheet { path, content in
                guard let document = model.selectedBridgeSkill else { return }
                Task { @MainActor in
                    postMutationDocumentSelection = .file(path.precomposedStringWithCanonicalMapping)
                    if await model.updateBridgeSkill(.init(
                        skillId: document.skill.skillId,
                        expectedVersion: currentExpectedVersion(document),
                        files: .init(upsert: [.init(path: path, content: content)])
                    )) { sheet = nil }
                    else { postMutationDocumentSelection = nil }
                }
            }
        case .renameFile(let oldPath):
            RenameBridgeSkillFileSheet(oldPath: oldPath) { newPath in renameFile(oldPath, to: newPath) }
        case .deleteSkill(let document):
            BridgeSkillDeleteSheet(skillName: currentSkillName(for: document), isDeleting: model.skillMutationInProgress) { name in
                Task { @MainActor in
                    if await model.deleteBridgeSkill(.init(
                        skillId: document.skill.skillId,
                        expectedVersion: currentExpectedVersion(document),
                        confirmName: name
                    )) { sheet = nil }
                }
            }
        case .importReview(let review):
            BridgeSkillImportReviewSheet(review: review, currentSkill: importTargetSkill) { commit in
                commitImport(review, commit: commit)
            }
        }
    }

    private var selectedSkillBinding: Binding<String?> {
        Binding(
            get: { model.selectedBridgeSkill?.skill.skillId },
            set: { requested in requestSkillSelection(requested) }
        )
    }

    private var selectedDocumentBinding: Binding<SkillDocumentSelection?> {
        Binding(
            get: { documentSelection },
            set: { if let requested = $0 { requestDocumentSelection(requested) } }
        )
    }

    private func filteredSkills(_ skills: [BridgeSkillSummary]) -> [BridgeSkillSummary] {
        skills.filter { skill in
            let scopeMatches = scope == .all || (scope == .active ? skill.enabled : !skill.enabled)
            guard scopeMatches else { return false }
            guard !searchText.isEmpty else { return true }
            return "\(skill.name)\n\(skill.description)".localizedCaseInsensitiveContains(searchText)
        }
    }

    private func selectedDocumentTitle(_ document: BridgeSkillDocument) -> String {
        switch documentSelection {
        case .main: return document.skill.name
        case .file(let path): return path.split(separator: "/").last.map(String.init) ?? path
        }
    }

    @ViewBuilder
    private func skillFileTreeRow(_ node: SkillFileTree, document: BridgeSkillDocument) -> some View {
        if let path = node.path {
            Label(node.name, systemImage: "doc.text")
                .tag(SkillDocumentSelection.file(path))
                .contextMenu { fileContextMenu(path: path, document: document) }
        } else {
            Label(node.name, systemImage: "folder")
        }
    }

    private func requestSkillSelection(_ skillID: String?) {
        guard skillID != model.selectedBridgeSkill?.skill.skillId else { return }
        if windowState.hasUnsavedChanges {
            pendingSkillID = skillID
            showsDiscardConfirmation = true
            return
        }
        applySkillSelection(skillID)
    }

    private func applySkillSelection(_ skillID: String?) {
        guard let skillID,
              let skill = model.skillLibrary?.skills.first(where: { $0.skillId == skillID }) else { return }
        documentSelection = .main
        editorMode = .preview
        Task { await model.loadBridgeSkill(skill) }
    }

    private func requestDocumentSelection(_ requested: SkillDocumentSelection) {
        guard requested != documentSelection else { return }
        if windowState.hasUnsavedChanges {
            pendingDocumentSelection = requested
            showsDiscardConfirmation = true
            return
        }
        applyDocumentSelection(requested)
    }

    private func applyDocumentSelection(_ requested: SkillDocumentSelection) {
        documentSelection = requested
        editorMode = .preview
        switch requested {
        case .main: model.selectBridgeSkillMainDocument(); synchronizeDraftFromModel()
        case .file(let path): Task { await model.loadBridgeSkillFile(path: path) }
        }
    }

    private func discardAndApplyPendingSelection() {
        windowState.hasUnsavedChanges = false
        if let skillID = pendingSkillID {
            pendingSkillID = nil
            applySkillSelection(skillID)
        } else if let selection = pendingDocumentSelection {
            pendingDocumentSelection = nil
            applyDocumentSelection(selection)
        } else if let reference = pendingVersionReference {
            pendingVersionReference = nil
            Task { await model.loadBridgeSkill(reference) }
        }
    }

    private func synchronizeSelectionFromModel() {
        if let requested = postMutationDocumentSelection,
           case .file(let path) = requested,
           model.selectedBridgeSkill?.files.contains(where: { $0.path == path }) == true {
            postMutationDocumentSelection = nil
            documentSelection = requested
            editorMode = .preview
            Task { await model.loadBridgeSkillFile(path: path) }
            return
        }
        postMutationDocumentSelection = nil
        documentSelection = .main
        editorMode = .preview
        synchronizeDraftFromModel()
    }

    private func synchronizeDraftFromModel() {
        guard let document = model.selectedBridgeSkill else {
            draftContent = ""; draftName = ""; draftDescription = ""; windowState.hasUnsavedChanges = false
            return
        }
        draftName = document.skill.name
        draftDescription = document.skill.description
        draftContent = currentSource(document)
        windowState.hasUnsavedChanges = false
    }

    private func updateDirtyState() {
        guard let document = model.selectedBridgeSkill else {
            windowState.hasUnsavedChanges = false
            return
        }
        let metadataChanged = documentSelection == .main &&
            (draftName != document.skill.name || draftDescription != document.skill.description)
        windowState.hasUnsavedChanges = draftContent != currentSource(document) || metadataChanged
    }

    private var isEditingCurrentSource: Bool { windowState.hasUnsavedChanges || !draftContent.isEmpty }

    private func currentSource(_ document: BridgeSkillDocument) -> String {
        switch documentSelection {
        case .main: return document.document
        case .file: return model.selectedBridgeSkillFile?.content ?? ""
        }
    }

    private func saveCurrentDocument() {
        guard let document = model.selectedBridgeSkill, windowState.hasUnsavedChanges else { return }
        let request: BridgeSkillUpdateRequest
        switch documentSelection {
        case .main:
            request = .init(
                skillId: document.skill.skillId,
                expectedVersion: currentExpectedVersion(document),
                name: draftName,
                description: draftDescription,
                document: draftContent
            )
        case .file(let path):
            request = .init(
                skillId: document.skill.skillId,
                expectedVersion: currentExpectedVersion(document),
                files: .init(upsert: [.init(path: path, content: draftContent)])
            )
        }
        Task { @MainActor in
            if case .file = documentSelection { postMutationDocumentSelection = documentSelection }
            if await model.updateBridgeSkill(request) {
                windowState.hasUnsavedChanges = false
                editorMode = .preview
            } else { postMutationDocumentSelection = nil }
        }
    }

    private func openRelativeLink(_ path: String) {
        guard let document = model.selectedBridgeSkill else { return }
        let currentFilePath: String?
        if case .file(let path) = documentSelection { currentFilePath = path }
        else { currentFilePath = nil }
        guard let target = resolveBridgeSkillMarkdownNavigationTarget(
            linkPath: path,
            currentFilePath: currentFilePath,
            availableFilePaths: document.files.map(\.path)
        ) else { return }
        switch target {
        case .main: requestDocumentSelection(.main)
        case .file(let storedPath): requestDocumentSelection(.file(storedPath))
        }
    }

    private func requestVersion(_ version: BridgeSkillVersionSummary) {
        guard !windowState.hasUnsavedChanges else {
            pendingVersionReference = version.reference
            showsDiscardConfirmation = true
            return
        }
        Task { await model.loadBridgeSkill(version.reference) }
    }

    private func restoreSelectedVersion() {
        guard let target = restoreTarget, let document = model.selectedBridgeSkill,
              let history = model.selectedBridgeSkillVersions else { return }
        let request = BridgeSkillRestoreRequest(
            skillId: document.skill.skillId,
            expectedVersion: history.currentVersion,
            sourceVersion: target.version
        )
        Task { @MainActor in
            if await model.restoreBridgeSkill(request) { restoreTarget = nil }
        }
    }

    private func toggleArchived(_ document: BridgeSkillDocument) {
        Task { await model.setBridgeSkillEnabled(.init(
            skillId: document.skill.skillId,
            expectedVersion: currentExpectedVersion(document),
            enabled: !document.skill.enabled
        )) }
    }

    private func currentExpectedVersion(_ document: BridgeSkillDocument) -> String {
        model.selectedBridgeSkillVersions?.currentVersion ?? document.skill.version
    }

    private func currentSkillName(for document: BridgeSkillDocument) -> String {
        guard let history = model.selectedBridgeSkillVersions else { return document.skill.name }
        return history.versions.first(where: { $0.version == history.currentVersion })?.name ?? document.skill.name
    }

    private func isCurrentVersion(_ document: BridgeSkillDocument) -> Bool {
        guard let current = model.selectedBridgeSkillVersions?.currentVersion else { return true }
        return document.skill.version == current
    }

    private func toggleEditingMode() {
        guard let document = model.selectedBridgeSkill, isCurrentVersion(document) else { return }
        if editorMode == .preview {
            synchronizeDraftFromModel()
            editorMode = .edit
        } else {
            editorMode = .preview
        }
    }

    private func setInspectorPresented(_ presented: Bool) {
        showsInspector = presented
        synchronizeNavigationForInspector(presented)
    }

    private func synchronizeNavigationForInspector(_ visible: Bool) {
        if visible {
            synchronizeNavigationForWindowWidth(SkillsLibraryWindowController.shared.contentWidth ?? 1_120)
        } else {
            restoreNavigationAfterCompactInspector()
        }
    }

    private func synchronizeNavigationForWindowWidth(_ contentWidth: CGFloat) {
        if SkillsLibraryAdaptiveColumns.shouldCollapseForInspector(
            isPresented: showsInspector,
            contentWidth: contentWidth
        ) {
            adaptNavigationForVisibleInspector(contentWidth: contentWidth)
        } else {
            restoreNavigationAfterCompactInspector()
        }
    }

    private func adaptNavigationForVisibleInspector(contentWidth: CGFloat? = nil) {
        guard SkillsLibraryAdaptiveColumns.shouldCollapseForInspector(
            isPresented: true,
            contentWidth: contentWidth ?? SkillsLibraryWindowController.shared.contentWidth ?? 1_120
        ) else { return }
        if compactInspectorPreviousVisibility == nil {
            compactInspectorPreviousVisibility = columnVisibility
        }
        if columnVisibility != .detailOnly { columnVisibility = .detailOnly }
    }

    private func restoreNavigationAfterCompactInspector() {
        guard let previous = compactInspectorPreviousVisibility else { return }
        compactInspectorPreviousVisibility = nil
        columnVisibility = previous
    }

    private func focusSkillSearch() {
        if let textView = NSApp.keyWindow?.firstResponder as? NSTextView,
           textView.isEditable {
            let item = NSMenuItem()
            item.tag = Int(NSFindPanelAction.showFindPanel.rawValue)
            textView.performFindPanelAction(item)
            return
        }
        columnVisibility = .all
        DispatchQueue.main.async {
            guard let root = NSApp.keyWindow?.contentView,
                  let search = firstSubview(of: NSSearchField.self, in: root) else { return }
            NSApp.keyWindow?.makeFirstResponder(search)
        }
    }

    private func restoreColumnVisibility() {
        switch savedColumnVisibility {
        case "detail": columnVisibility = .detailOnly
        case "double": columnVisibility = .doubleColumn
        case "all": columnVisibility = .all
        default: columnVisibility = .automatic
        }
    }

    private func saveColumnVisibility(_ visibility: NavigationSplitViewVisibility) {
        guard compactInspectorPreviousVisibility == nil else { return }
        switch visibility {
        case .detailOnly: savedColumnVisibility = "detail"
        case .doubleColumn: savedColumnVisibility = "double"
        case .automatic: savedColumnVisibility = "automatic"
        default: savedColumnVisibility = "all"
        }
    }

    @ViewBuilder
    private func skillContextMenu(_ skill: BridgeSkillSummary) -> some View {
        Button("열기") { requestSkillSelection(skill.skillId) }
        Button(skill.enabled ? "보관" : "다시 활성화") {
            Task { await model.setBridgeSkillEnabled(.init(
                skillId: skill.skillId, expectedVersion: skill.version, enabled: !skill.enabled
            )) }
        }
        .disabled(windowState.hasUnsavedChanges)
    }

    @ViewBuilder
    private func mainDocumentContextMenu(_ document: BridgeSkillDocument) -> some View {
        Button("편집") { editorMode = .edit; synchronizeDraftFromModel() }
            .disabled(!isCurrentVersion(document))
        Button("현재 스킬로 가져오기…") { presentImportPanel(intoCurrentSkill: true) }
            .disabled(!isCurrentVersion(document) || windowState.hasUnsavedChanges)
        Button("ZIP으로 내보내기…") { export(document) }
    }

    @ViewBuilder
    private func fileContextMenu(path: String, document: BridgeSkillDocument) -> some View {
        Button("편집") { requestDocumentSelection(.file(path)); editorMode = .edit }
            .disabled(!isCurrentVersion(document))
        Button("이름 변경…") { sheet = .renameFile(path) }
            .disabled(!isCurrentVersion(document) || windowState.hasUnsavedChanges)
        Button("현재 스킬로 가져오기…") { presentImportPanel(intoCurrentSkill: true) }
            .disabled(!isCurrentVersion(document) || windowState.hasUnsavedChanges)
        Divider()
        Button("파일 삭제", role: .destructive) { deleteFile(path, from: document) }
            .disabled(!isCurrentVersion(document) || windowState.hasUnsavedChanges)
    }

    private func renameFile(_ oldPath: String, to newPath: String) {
        guard let document = model.selectedBridgeSkill else { return }
        Task { @MainActor in
            await model.loadBridgeSkillFile(path: oldPath)
            guard let content = model.selectedBridgeSkillFile?.content else { return }
            postMutationDocumentSelection = .file(newPath.precomposedStringWithCanonicalMapping)
            if await model.updateBridgeSkill(.init(
                skillId: document.skill.skillId,
                expectedVersion: currentExpectedVersion(document),
                files: .init(upsert: [.init(path: newPath, content: content)], remove: [oldPath])
            )) {
                sheet = nil
                documentSelection = .file(newPath)
                await model.loadBridgeSkillFile(path: newPath)
            } else { postMutationDocumentSelection = nil }
        }
    }

    private func deleteFile(_ path: String, from document: BridgeSkillDocument) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = BridgeAppLocalization.string("첨부 Markdown 파일을 삭제할까요?", locale: locale)
        alert.informativeText = path
        alert.addButton(withTitle: BridgeAppLocalization.string("파일 삭제", locale: locale))
        alert.addButton(withTitle: BridgeAppLocalization.string("취소", locale: locale))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task { @MainActor in
            if await model.updateBridgeSkill(.init(
                skillId: document.skill.skillId,
                expectedVersion: currentExpectedVersion(document),
                files: .init(remove: [path])
            )) {
                documentSelection = .main
                model.selectBridgeSkillMainDocument()
            }
        }
    }

    private func presentImportPanel(intoCurrentSkill: Bool) {
        importTargetSkillID = intoCurrentSkill ? model.selectedBridgeSkill?.skill.skillId : nil
        let panel = NSOpenPanel()
        panel.title = BridgeAppLocalization.string("Markdown 파일, 폴더 또는 ZIP 가져오기", locale: locale)
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.resolvesAliases = false
        panel.allowedContentTypes = [
            .folder, .zip,
            UTType(filenameExtension: "md") ?? .plainText,
            UTType(filenameExtension: "markdown") ?? .plainText
        ]
        Task { @MainActor in
            guard await panel.begin() == .OK else { return }
            beginImport(panel.urls, intoCurrentSkill: intoCurrentSkill)
        }
    }

    private func loadDroppedURLs(_ providers: [NSItemProvider]) {
        Task { @MainActor in
            var urls: [URL] = []
            for provider in providers {
                if let item = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier),
                   let data = item as? Data,
                   let url = URL(dataRepresentation: data, relativeTo: nil) {
                    urls.append(url)
                } else if let url = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) as? URL {
                    urls.append(url)
                }
            }
            if !urls.isEmpty {
                let intoCurrent = model.selectedBridgeSkill.map(isCurrentVersion) ?? false
                beginImport(urls, intoCurrentSkill: intoCurrent)
            }
        }
    }

    private func beginImport(_ urls: [URL], intoCurrentSkill: Bool) {
        guard !urls.isEmpty else { return }
        importTargetSkillID = intoCurrentSkill ? model.selectedBridgeSkill?.skill.skillId : nil
        if urls.count == 1, urls[0].pathExtension.lowercased() == "zip" {
            let url = urls[0]
            Task { @MainActor in
                if let inspection = await model.inspectBridgeSkillPackage(at: url) {
                    sheet = .importReview(.package(sourceName: url.deletingPathExtension().lastPathComponent,
                                                   inspection: inspection))
                }
            }
            return
        }
        Task { @MainActor in
            let review = await Task.detached(priority: .userInitiated) {
                BridgeSkillImportCollector.collect(urls: urls)
            }.value
            sheet = .importReview(review)
        }
    }

    private func commitImport(_ review: BridgeSkillImportReview, commit: BridgeSkillImportCommit) {
        guard let current = importTargetSkill else {
            commitNewImport(review, commit: commit)
            return
        }
        switch review.payload {
        case .direct(let files):
            guard let selected = selectedImportFiles(files, commit: commit) else { return }
            let main = commit.mainPath.flatMap { path in selected.first(where: { $0.path == path }) }
            let attachments = selected.filter { $0.path != main?.path }.map { BridgeSkillFileInput(path: $0.path, content: $0.content) }
            Task { @MainActor in
                if await model.updateBridgeSkill(.init(
                    skillId: current.skill.skillId,
                    expectedVersion: currentExpectedVersion(current),
                    document: main?.content,
                    files: attachments.isEmpty ? nil : .init(upsert: attachments)
                )) { sheet = nil }
            }
        case .package(let inspection):
            Task { @MainActor in
                if await model.updateBridgeSkillPackage(.init(
                    skillId: current.skill.skillId,
                    expectedVersion: currentExpectedVersion(current),
                    uploadId: inspection.uploadId,
                    mainPath: commit.mainPath,
                    includePaths: Array(commit.selectedPaths).sorted()
                )) { sheet = nil }
            }
        }
    }

    private func commitNewImport(_ review: BridgeSkillImportReview, commit: BridgeSkillImportCommit) {
        guard let mainPath = commit.mainPath, !commit.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        switch review.payload {
        case .direct(let files):
            guard let selected = selectedImportFiles(files, commit: commit),
                  let main = selected.first(where: { $0.path == mainPath }) else { return }
            let attachments = selected.filter { $0.path != mainPath }.map { BridgeSkillFileInput(path: $0.path, content: $0.content) }
            Task { @MainActor in
                if await model.createBridgeSkill(.init(
                    name: commit.name, description: commit.description, document: main.content, files: attachments
                )) { sheet = nil }
            }
        case .package(let inspection):
            Task { @MainActor in
                if await model.createBridgeSkillPackage(.init(
                    name: commit.name, description: commit.description,
                    uploadId: inspection.uploadId, mainPath: mainPath,
                    includePaths: Array(commit.selectedPaths).sorted()
                )) { sheet = nil }
            }
        }
    }

    private func selectedImportFiles(
        _ files: [BridgeSkillImportFile],
        commit: BridgeSkillImportCommit
    ) -> [BridgeSkillImportFile]? {
        let selected = files.filter { commit.selectedPaths.contains($0.path) }
        return selected.isEmpty ? nil : selected
    }

    private var importTargetSkill: BridgeSkillDocument? {
        guard let importTargetSkillID,
              model.selectedBridgeSkill?.skill.skillId == importTargetSkillID else { return nil }
        return model.selectedBridgeSkill
    }

    private func export(_ document: BridgeSkillDocument) {
        Task { @MainActor in
            guard let exported = await model.exportBridgeSkillPackage(document.skill.reference),
                  let data = Data(base64Encoded: exported.data) else { return }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = exported.fileName
            panel.allowedContentTypes = [.zip]
            guard await panel.begin() == .OK, let url = panel.url else { return }
            do { try data.write(to: url, options: .atomic) }
            catch { model.skillMutationErrorMessage = BridgeAppLocalization.errorDescription(error, locale: locale) }
        }
    }
}

@MainActor
private func firstSubview<ViewType: NSView>(of type: ViewType.Type, in root: NSView) -> ViewType? {
    if let match = root as? ViewType { return match }
    for child in root.subviews {
        if let match = firstSubview(of: type, in: child) { return match }
    }
    return nil
}

private struct SplitViewAutosaveAnchor: NSViewRepresentable {
    let name: String

    func makeNSView(context: Context) -> ProbeView {
        ProbeView(name: name)
    }

    func updateNSView(_ nsView: ProbeView, context: Context) {
        nsView.name = name
        nsView.configureNearestSplitView()
    }

    final class ProbeView: NSView {
        var name: String

        init(name: String) {
            self.name = name
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            configureNearestSplitView()
        }

        func configureNearestSplitView() {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                var ancestor = self.superview
                while let current = ancestor {
                    if let split = current as? NSSplitView {
                        split.autosaveName = NSSplitView.AutosaveName(self.name)
                        return
                    }
                    ancestor = current.superview
                }
            }
        }
    }
}

private struct SkillSummaryRow: View {
    let skill: BridgeSkillSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(skill.name).fontWeight(.medium).lineLimit(1)
                if !skill.enabled {
                    Image(systemName: "archivebox.fill").foregroundStyle(.orange).accessibilityLabel("보관됨")
                }
            }
            if !skill.description.isEmpty {
                Text(skill.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Text("v\(skill.version)").font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityValue(skill.enabled ? "활성" : "보관됨")
    }
}

private struct SkillEmptyState: View {
    let title: LocalizedStringKey
    let symbol: String
    let detail: LocalizedStringKey

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol).font(.largeTitle).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }
}

private struct SkillFileTree: Identifiable, Hashable {
    let id: String
    let name: String
    let path: String?
    let children: [SkillFileTree]?

    static func nodes(for files: [BridgeSkillFileSummary]) -> [SkillFileTree] {
        final class MutableNode {
            var files: [String: String] = [:]
            var folders: [String: MutableNode] = [:]
        }
        let root = MutableNode()
        for file in files {
            let parts = file.path.split(separator: "/").map(String.init)
            var node = root
            for folder in parts.dropLast() {
                if node.folders[folder] == nil { node.folders[folder] = MutableNode() }
                node = node.folders[folder]!
            }
            if let name = parts.last { node.files[name] = file.path }
        }
        func materialize(_ node: MutableNode, prefix: String) -> [SkillFileTree] {
            let folders = node.folders.keys.sorted().map { name -> SkillFileTree in
                let id = prefix.isEmpty ? name : "\(prefix)/\(name)"
                return SkillFileTree(id: "folder:\(id)", name: name, path: nil,
                                     children: materialize(node.folders[name]!, prefix: id))
            }
            let leaves = node.files.keys.sorted().map { name -> SkillFileTree in
                let filePath = node.files[name]!
                return SkillFileTree(id: "file:\(filePath)", name: name, path: filePath, children: nil)
            }
            return folders + leaves
        }
        return materialize(root, prefix: "")
    }
}

private enum SkillBannerStyle { case warning, archived, error }

private struct SkillStatusBanner: View {
    let style: SkillBannerStyle
    let message: String

    var body: some View {
        Label(message, systemImage: symbol)
            .font(.caption)
            .foregroundStyle(style == .error ? Color.red : Color.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background((style == .error ? Color.red : Color.orange).opacity(0.09))
            .textSelection(.enabled)
    }

    private var symbol: String {
        switch style {
        case .warning: "exclamationmark.triangle.fill"
        case .archived: "archivebox.fill"
        case .error: "xmark.octagon.fill"
        }
    }
}

extension BridgeSkillWarningCode {
    func localizedDescription(locale: Locale) -> String {
        let key: String
        switch self {
        case .archived:
            key = "이 스킬은 보관되어 검색 결과에서 제외됩니다. 불변 버전은 계속 읽을 수 있습니다."
        case .legacyStructured:
            key = "이전 구조형 버전입니다. 수정하거나 복원하면 자유형 Markdown과 파일 트리의 새 버전이 만들어집니다."
        }
        return BridgeAppLocalization.string(key, locale: locale)
    }
}

// MARK: - Safe Markdown rendering

enum SafeMarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case unordered([String])
    case ordered(start: Int, items: [String])
    case quote(String)
    case code(language: String?, source: String)
    case table(headers: [String], rows: [[String]])
    case divider
}

struct SafeMarkdownDocument: Equatable {
    let blocks: [SafeMarkdownBlock]

    init(markdown: String) {
        let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var result: [SafeMarkdownBlock] = []
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { index += 1; continue }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                let fence = String(trimmed.prefix(3))
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                index += 1
                var source: [String] = []
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    source.append(lines[index]); index += 1
                }
                if index < lines.count { index += 1 }
                result.append(.code(language: language.isEmpty ? nil : language, source: source.joined(separator: "\n")))
                continue
            }
            if let heading = Self.heading(line) { result.append(heading); index += 1; continue }
            if Self.isDivider(trimmed) { result.append(.divider); index += 1; continue }
            if index + 1 < lines.count, Self.isTableSeparator(lines[index + 1]) {
                let headers = Self.tableCells(line)
                index += 2
                var rows: [[String]] = []
                while index < lines.count, lines[index].contains("|"), !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(Self.tableCells(lines[index])); index += 1
                }
                result.append(.table(headers: headers, rows: rows)); continue
            }
            if Self.unorderedItem(line) != nil {
                var items: [String] = []
                while index < lines.count, let item = Self.unorderedItem(lines[index]) { items.append(item); index += 1 }
                result.append(.unordered(items)); continue
            }
            if let first = Self.orderedItem(line) {
                var items = [first.item]
                let start = first.number
                index += 1
                while index < lines.count, let item = Self.orderedItem(lines[index]) { items.append(item.item); index += 1 }
                result.append(.ordered(start: start, items: items)); continue
            }
            if trimmed.hasPrefix(">") {
                var quoted: [String] = []
                while index < lines.count {
                    let value = lines[index].trimmingCharacters(in: .whitespaces)
                    guard value.hasPrefix(">") else { break }
                    quoted.append(String(value.dropFirst()).trimmingCharacters(in: .whitespaces)); index += 1
                }
                result.append(.quote(quoted.joined(separator: "\n"))); continue
            }
            var paragraph = [line]
            index += 1
            while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                  Self.heading(lines[index]) == nil, Self.unorderedItem(lines[index]) == nil,
                  Self.orderedItem(lines[index]) == nil, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">"),
                  !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```"),
                  !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("~~~") {
                paragraph.append(lines[index]); index += 1
            }
            result.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        blocks = result
    }

    private static func heading(_ line: String) -> SafeMarkdownBlock? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let hashes = trimmed.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), trimmed.dropFirst(hashes).first == " " else { return nil }
        return .heading(level: hashes, text: String(trimmed.dropFirst(hashes + 1)))
    }

    private static func unorderedItem(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2, ["- ", "* ", "+ "].contains(String(trimmed.prefix(2))) else { return nil }
        return String(trimmed.dropFirst(2))
    }

    private static func orderedItem(_ line: String) -> (number: Int, item: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let punctuation = trimmed.firstIndex(where: { $0 == "." || $0 == ")" }),
              let number = Int(trimmed[..<punctuation]) else { return nil }
        let rest = trimmed[trimmed.index(after: punctuation)...]
        guard rest.first == " " else { return nil }
        return (number, String(rest.dropFirst()))
    }

    private static func isDivider(_ line: String) -> Bool {
        let compact = line.replacingOccurrences(of: " ", with: "")
        return compact.count >= 3 && (Set(compact) == ["-"] || Set(compact) == ["*"] || Set(compact) == ["_"])
    }

    private static func tableCells(_ line: String) -> [String] {
        var value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|") { value.removeLast() }
        return value.split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let cells = tableCells(line)
        return !cells.isEmpty && cells.allSatisfy { cell in
            let value = cell.replacingOccurrences(of: ":", with: "").trimmingCharacters(in: .whitespaces)
            return value.count >= 3 && Set(value) == ["-"]
        }
    }
}

struct SafeMarkdownView: View {
    let markdown: String
    var onOpenRelativeLink: (String) -> Void = { _ in }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                ForEach(Array(SafeMarkdownDocument(markdown: markdown).blocks.enumerated()), id: \.offset) { _, block in
                    rendered(block)
                }
            }
            .frame(maxWidth: 780, alignment: .leading)
            .padding(.horizontal, 28)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.45))
        .environment(\.openURL, OpenURLAction { url in
            if let relative = safeRelativeMarkdownPath(url) { onOpenRelativeLink(relative) }
            return .handled
        })
        .accessibilityLabel("렌더링된 Markdown 미리보기")
    }

    @ViewBuilder
    private func rendered(_ block: SafeMarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            inline(text).font(headingFont(level)).padding(.top, level <= 2 ? 8 : 2)
        case .paragraph(let text): inline(text).lineSpacing(3)
        case .unordered(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 9) { Text(verbatim: "•"); inline(item) }
                }
            }.padding(.leading, 8)
        case .ordered(let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { offset, item in
                    HStack(alignment: .firstTextBaseline, spacing: 9) {
                        Text(verbatim: "\(start + offset).").monospacedDigit().foregroundStyle(.secondary)
                        inline(item)
                    }
                }
            }.padding(.leading, 8)
        case .quote(let text):
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 1).fill(Color.accentColor.opacity(0.55)).frame(width: 3)
                inline(text).foregroundStyle(.secondary).italic()
            }.padding(.vertical, 2)
        case .code(let language, let source):
            VStack(alignment: .leading, spacing: 7) {
                if let language { Text(language).font(.caption2.monospaced()).foregroundStyle(.secondary) }
                ScrollView(.horizontal) {
                    Text(verbatim: source).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(12)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        case .table(let headers, let rows):
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                GridRow { ForEach(Array(headers.enumerated()), id: \.offset) { _, cell in inline(cell).fontWeight(.semibold) } }
                Divider().gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, cell in inline(cell) } }
                }
            }
            .padding(10)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
        case .divider: Divider()
        }
    }

    private func inline(_ source: String) -> some View {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return Text((try? AttributedString(markdown: source, options: options)) ?? AttributedString(source))
            .textSelection(.enabled)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .largeTitle.weight(.bold)
        case 2: .title.weight(.semibold)
        case 3: .title2.weight(.semibold)
        case 4: .title3.weight(.semibold)
        default: .headline
        }
    }

    private func safeRelativeMarkdownPath(_ url: URL) -> String? {
        guard url.scheme == nil, url.host == nil else { return nil }
        let source = url.path.isEmpty ? url.relativeString : url.path
        let path = source.split(separator: "#", maxSplits: 1).first.map(String.init) ?? source
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"),
              path.lowercased().hasSuffix(".md") || path.lowercased().hasSuffix(".markdown") else { return nil }
        return path
    }
}

// MARK: - Import review

struct BridgeSkillImportFile: Identifiable, Sendable, Equatable {
    var id: String { path }
    let path: String
    let content: String
    let bytes: Int
}

struct BridgeSkillImportIssue: Identifiable, Sendable, Equatable {
    var id: String { "\(path)-\(reason)" }
    let path: String
    let reason: String

    func localizedReason(locale: Locale) -> String {
        let key: String
        switch reason {
        case "macos-metadata": key = "macOS 메타데이터 파일은 가져오지 않습니다."
        case "unsupported-file": key = "현재는 .md와 .markdown만 지원합니다."
        case "symbolic-link": key = "심볼릭 링크는 가져올 수 없습니다."
        case "special-file": key = "일반 파일만 가져올 수 있습니다."
        case "stat-failed": key = "파일 정보를 확인할 수 없습니다."
        case "unsafe-path": key = "선택한 폴더 밖의 파일 경로는 가져올 수 없습니다."
        case "path-conflict": key = "다른 파일과 경로가 충돌합니다."
        case "invalid-utf8": key = "유효한 UTF-8 Markdown이 아닙니다."
        case "file-too-large": key = "Markdown 파일 하나의 크기는 3MiB를 넘을 수 없습니다."
        case "collection-too-large": key = "Markdown 파일이 허용된 파일 수 또는 크기 한도를 초과합니다."
        case "read-failed": key = "파일을 읽을 수 없습니다."
        default: key = "가져올 수 없는 파일입니다."
        }
        return BridgeAppLocalization.string(key, locale: locale)
    }
}

enum BridgeSkillImportPayload: Sendable, Equatable {
    case direct([BridgeSkillImportFile])
    case package(BridgeSkillPackageInspection)
}

struct BridgeSkillImportReview: Identifiable, Sendable, Equatable {
    let id = UUID()
    let sourceName: String
    let payload: BridgeSkillImportPayload
    let suggestedMainPath: String?
    let issues: [BridgeSkillImportIssue]

    static func package(sourceName: String, inspection: BridgeSkillPackageInspection) -> Self {
        .init(
            sourceName: sourceName,
            payload: .package(inspection),
            suggestedMainPath: inspection.suggestedMainPath,
            issues: inspection.ignored.map { .init(path: $0.path, reason: $0.reason) }
        )
    }

    var paths: [String] {
        switch payload {
        case .direct(let files): files.map(\.path)
        case .package(let inspection): inspection.files.map(\.path)
        }
    }

    func bytes(for path: String) -> Int? {
        switch payload {
        case .direct(let files): files.first(where: { $0.path == path })?.bytes
        case .package(let inspection): inspection.files.first(where: { $0.path == path })?.bytes
        }
    }
}

struct BridgeSkillImportCommit {
    let name: String
    let description: String?
    let mainPath: String?
    let selectedPaths: Set<String>
}

enum BridgeSkillImportCollector {
    static func collect(urls: [URL]) -> BridgeSkillImportReview {
        var files: [BridgeSkillImportFile] = []
        var issues: [BridgeSkillImportIssue] = []
        let manager = FileManager.default
        for url in urls {
            do {
                let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey])
                if values.isSymbolicLink == true {
                    issues.append(.init(path: url.lastPathComponent, reason: "symbolic-link"))
                } else if values.isDirectory == true {
                    let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey]
                    let resolvedRoot = resolvedFilesystemURL(url)
                    let enumerator = manager.enumerator(
                        at: resolvedRoot,
                        includingPropertiesForKeys: keys
                    )
                    while let child = enumerator?.nextObject() as? URL {
                        let rootPrefix = resolvedRoot.path.hasSuffix("/") ? resolvedRoot.path : resolvedRoot.path + "/"
                        guard child.path.hasPrefix(rootPrefix) else {
                            enumerator?.skipDescendants()
                            issues.append(.init(path: child.lastPathComponent, reason: "unsafe-path"))
                            continue
                        }
                        let relative = String(child.path.dropFirst(resolvedRoot.path.count))
                            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                        collectFile(child, relativePath: relative, into: &files, issues: &issues)
                    }
                } else {
                    collectFile(url, relativePath: url.lastPathComponent, into: &files, issues: &issues)
                }
            } catch {
                issues.append(.init(path: url.lastPathComponent, reason: "stat-failed"))
            }
        }
        var unique: [String: BridgeSkillImportFile] = [:]
        var keys = Set<String>()
        for file in files {
            let key = file.path.precomposedStringWithCanonicalMapping.lowercased()
            if keys.contains(key) {
                issues.append(.init(path: file.path, reason: "path-conflict"))
            } else {
                keys.insert(key)
                unique[file.path] = file
            }
        }
        let sorted = unique.values.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
        let documentCandidate = sorted.first { $0.path == "document.md" }
        let skillCandidate = sorted.filter { $0.path == "SKILL.md" }
        let suggestion = documentCandidate?.path ??
            (sorted.count == 1 ? sorted[0].path : skillCandidate.count == 1 ? skillCandidate[0].path : nil)
        let sourceName = urls.count == 1 ? urls[0].deletingPathExtension().lastPathComponent : ""
        return .init(sourceName: sourceName, payload: .direct(sorted), suggestedMainPath: suggestion, issues: issues)
    }

    private static func collectFile(
        _ url: URL,
        relativePath: String,
        into files: inout [BridgeSkillImportFile],
        issues: inout [BridgeSkillImportIssue]
    ) {
        do {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey])
            if values.isDirectory == true { return }
            if values.isSymbolicLink == true || values.isRegularFile != true {
                issues.append(.init(path: relativePath, reason: "special-file")); return
            }
            let normalized = relativePath.precomposedStringWithCanonicalMapping.replacingOccurrences(of: "\\", with: "/")
            if isMacMetadataPath(normalized) {
                issues.append(.init(path: normalized, reason: "macos-metadata")); return
            }
            guard isSafeBridgeSkillImportPath(normalized) else {
                issues.append(.init(path: normalized, reason: "unsafe-path")); return
            }
            guard normalized.lowercased().hasSuffix(".md") || normalized.lowercased().hasSuffix(".markdown") else {
                issues.append(.init(path: normalized, reason: "unsupported-file")); return
            }
            let data = try Data(contentsOf: url)
            guard data.count <= 3 * 1_024 * 1_024 else {
                issues.append(.init(path: normalized, reason: "file-too-large")); return
            }
            guard let content = decodeBridgeSkillMarkdown(data), !content.contains("\u{0}") else {
                issues.append(.init(path: normalized, reason: "invalid-utf8")); return
            }
            let totalBytes = files.reduce(0) { $0 + $1.bytes }
            guard files.count < 129, totalBytes + data.count <= 11 * 1_024 * 1_024 else {
                issues.append(.init(path: normalized, reason: "collection-too-large")); return
            }
            files.append(.init(path: normalized, content: content, bytes: data.count))
        } catch {
            issues.append(.init(path: relativePath, reason: "read-failed"))
        }
    }
}

private func isSafeBridgeSkillImportPath(_ path: String) -> Bool {
    guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"),
          (path.data(using: .utf8)?.count ?? 1_025) <= 1_024 else { return false }
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard segments.count <= 32 else { return false }
    return segments.allSatisfy { segment in
        !segment.isEmpty && segment != "." && segment != ".." &&
            !segment.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
    }
}

private func isMacMetadataPath(_ path: String) -> Bool {
    path == ".DS_Store" || path.hasPrefix("__MACOSX/") ||
        path.split(separator: "/").contains(where: { $0.hasPrefix("._") })
}

private func decodeBridgeSkillMarkdown(_ data: Data) -> String? {
    let bom = Data([0xef, 0xbb, 0xbf])
    if data.starts(with: bom) {
        guard let suffix = String(data: data.dropFirst(bom.count), encoding: .utf8) else { return nil }
        return "\u{feff}" + suffix
    }
    return String(data: data, encoding: .utf8)
}

private func resolvedFilesystemURL(_ url: URL) -> URL {
    let resolvedPath = url.path.withCString { source -> String? in
        guard let resolved = Darwin.realpath(source, nil) else { return nil }
        defer { Darwin.free(resolved) }
        return String(cString: resolved)
    }
    return resolvedPath.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? url.standardizedFileURL
}

private struct BridgeSkillImportReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let review: BridgeSkillImportReview
    let currentSkill: BridgeSkillDocument?
    let commit: (BridgeSkillImportCommit) -> Void
    @State private var name: String
    @State private var description = ""
    @State private var mainPath: String?
    @State private var selectedPaths: Set<String>

    init(review: BridgeSkillImportReview, currentSkill: BridgeSkillDocument?, commit: @escaping (BridgeSkillImportCommit) -> Void) {
        self.review = review
        self.currentSkill = currentSkill
        self.commit = commit
        _name = State(initialValue: review.sourceName)
        _mainPath = State(initialValue: currentSkill == nil ? review.suggestedMainPath : nil)
        var initiallySelected = Set(review.paths)
        if currentSkill != nil {
            initiallySelected = Set(initiallySelected.filter { $0.lowercased() != "document.md" })
        }
        _selectedPaths = State(initialValue: initiallySelected)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("가져오기 검토").font(.title2.weight(.semibold))
            Text(currentSkill == nil
                 ? "메인 문서를 선택하세요. 나머지 선택 파일은 상대경로를 유지한 첨부 Markdown으로 저장됩니다."
                 : "선택 파일은 첨부 문서로 추가·교체됩니다. 메인 교체는 메인 문서를 명시적으로 선택한 경우에만 적용됩니다.")
                .font(.callout).foregroundStyle(.secondary)
            if currentSkill == nil {
                Form {
                    TextField("스킬 이름", text: $name)
                    TextField("검색용 설명(선택)", text: $description)
                }.formStyle(.grouped).frame(height: 120)
            }
            Picker("메인 문서", selection: $mainPath) {
                if currentSkill != nil { Text("메인 문서 변경 안 함").tag(String?.none) }
                ForEach(review.paths, id: \.self) { path in Text(path).tag(String?.some(path)) }
            }
            List(review.paths, id: \.self) { path in
                Toggle(isOn: Binding(
                    get: { selectedPaths.contains(path) },
                    set: { enabled in
                        if enabled { selectedPaths.insert(path) }
                        else { selectedPaths.remove(path) }
                    }
                )) {
                    HStack {
                        Label(path, systemImage: path == mainPath ? "doc.text.fill" : "doc.text")
                        Spacer()
                        if currentSkill?.files.contains(where: { $0.path.lowercased() == path.lowercased() }) == true {
                            Text("교체").font(.caption).foregroundStyle(.orange)
                        } else if currentSkill != nil, path.lowercased() == "document.md", path != mainPath {
                            Text("메인으로 선택하거나 제외").font(.caption).foregroundStyle(.orange)
                        }
                    }
                }
            }
            .frame(minHeight: 220)
            if !review.issues.isEmpty {
                GroupBox("가져오지 않는 항목과 충돌") {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(review.issues) { issue in
                            Label("\(issue.path): \(issue.localizedReason(locale: locale))", systemImage: "exclamationmark.triangle")
                                .font(.caption).foregroundStyle(.orange)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if selectionExceedsLimits {
                Label(
                    "Markdown 파일이 허용된 파일 수 또는 크기 한도를 초과합니다.",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }
            HStack {
                Button("취소", role: .cancel) { dismiss() }
                Spacer()
                Button("가져오기") {
                    commit(.init(
                        name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                        description: description.isEmpty ? nil : description,
                        mainPath: mainPath,
                        selectedPaths: selectedPaths
                    ))
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    selectedPaths.isEmpty ||
                    (mainPath.map { !selectedPaths.contains($0) } ?? false) ||
                    selectedRootDocumentConflicts ||
                    selectionExceedsLimits ||
                    (currentSkill == nil && (mainPath == nil || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                )
            }
        }
        .padding(22)
        .frame(minWidth: 620, minHeight: 600)
    }

    private var selectedRootDocumentConflicts: Bool {
        selectedPaths.contains(where: { $0.lowercased() == "document.md" && $0 != mainPath })
    }

    private var selectionExceedsLimits: Bool {
        var attachments = Dictionary(uniqueKeysWithValues: (currentSkill?.files ?? []).map {
            ($0.path.precomposedStringWithCanonicalMapping.lowercased(), $0.bytes)
        })
        for path in selectedPaths where path != mainPath {
            guard let bytes = review.bytes(for: path) else { return true }
            attachments[path.precomposedStringWithCanonicalMapping.lowercased()] = bytes
        }
        return attachments.count > 128 || attachments.values.reduce(0, +) > 8 * 1_024 * 1_024
    }
}

private struct NewBridgeSkillSheet: View {
    @Environment(\.dismiss) private var dismiss
    let save: (String, String?, String) -> Void
    @State private var name = ""
    @State private var description = ""
    @State private var document = "# "

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("새 브리지 스킬").font(.title2.weight(.semibold))
            TextField("스킬 이름", text: $name)
            TextField("검색용 설명(선택)", text: $description)
            Text("메인 Markdown 문서").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $document).font(.system(.body, design: .monospaced))
                .frame(minHeight: 320).border(Color(nsColor: .separatorColor))
            HStack {
                Button("취소", role: .cancel) { dismiss() }
                Spacer()
                Button("스킬 만들기") { save(name, description.isEmpty ? nil : description, document) }
                    .buttonStyle(.borderedProminent)
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || document.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(22).frame(width: 620, height: 520)
    }
}

private struct NewBridgeSkillFileSheet: View {
    @Environment(\.dismiss) private var dismiss
    let save: (String, String) -> Void
    @State private var path = "references/new.md"
    @State private var content = "# "

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("새 Markdown 파일").font(.title2.weight(.semibold))
            TextField("상대경로 (.md 또는 .markdown)", text: $path)
            TextEditor(text: $content).font(.system(.body, design: .monospaced))
                .frame(minHeight: 280).border(Color(nsColor: .separatorColor))
            HStack {
                Button("취소", role: .cancel) { dismiss() }
                Spacer()
                Button("파일 추가") { save(path, content) }.buttonStyle(.borderedProminent)
                    .disabled(path.isEmpty)
            }
        }.padding(22).frame(width: 580, height: 450)
    }
}

private struct RenameBridgeSkillFileSheet: View {
    @Environment(\.dismiss) private var dismiss
    let oldPath: String
    let save: (String) -> Void
    @State private var path: String

    init(oldPath: String, save: @escaping (String) -> Void) {
        self.oldPath = oldPath; self.save = save; _path = State(initialValue: oldPath)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Markdown 파일 이름 변경").font(.headline)
            TextField("새 상대경로", text: $path)
            HStack {
                Button("취소", role: .cancel) { dismiss() }
                Spacer()
                Button("이름 변경") { save(path) }.buttonStyle(.borderedProminent)
                    .disabled(path == oldPath || path.isEmpty)
            }
        }.padding(20).frame(width: 480)
    }
}

private struct BridgeSkillDeleteSheet: View {
    @Environment(\.dismiss) private var dismiss
    let skillName: String
    let isDeleting: Bool
    let confirm: (String) -> Void
    @State private var typedName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("스킬 영구 삭제").font(.headline)
            Text("모든 버전과 Markdown 파일을 삭제하며 복구할 수 없습니다.")
                .font(.caption).foregroundStyle(.secondary)
            Text("계속하려면 스킬 이름을 정확히 입력하세요: \(skillName)").font(.caption)
            TextField("스킬 이름", text: $typedName)
            HStack {
                Button("취소", role: .cancel) { dismiss() }
                Spacer()
                if isDeleting { ProgressView().controlSize(.small) }
                Button("영구 삭제", role: .destructive) { confirm(typedName) }
                    .disabled(typedName != skillName || isDeleting)
            }
        }.padding(20).frame(width: 430)
    }
}
