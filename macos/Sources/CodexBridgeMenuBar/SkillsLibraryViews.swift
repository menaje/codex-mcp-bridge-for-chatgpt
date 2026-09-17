import AppKit
import CodexBridgeKit
import Darwin
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class SkillsLibraryWindowState: ObservableObject {
    @Published var columnVisibility: NavigationSplitViewVisibility = .all
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
        case .all: "macos.skills.allSkills"
        case .active: "macos.skills.active"
        case .archived: "macos.skills.archived"
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
    let decoded = linkPath.removingPercentEncoding ?? linkPath
    guard !decoded.isEmpty,
          !decoded.hasPrefix("/"),
          !decoded.contains("\\"),
          decoded.range(of: "^[A-Za-z]:", options: .regularExpression) == nil,
          !decoded.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }

    var segments = currentFilePath?
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
    if isBridgeSkillMainDocumentPath(resolvedPath) { return .main }
    guard let storedPath = availableFilePaths.first(where: {
        bridgeSkillPathComparisonKey($0) == bridgeSkillPathComparisonKey(resolvedPath)
    }) else { return nil }
    return .file(storedPath)
}

func bridgeSkillPathComparisonKey(_ value: String) -> String {
    (try? BridgeTextIntegrity.searchKey(
        value,
        options: .init(allowEmpty: true, trim: false, collapseWhitespace: false)
    )) ?? value
}

func isBridgeSkillMainDocumentPath(_ value: String) -> Bool {
    let key = bridgeSkillPathComparisonKey(value)
    return key == "skill.md" || key == "document.md"
}

enum SkillsLibraryAdaptiveLayout {
    static let documentSidebarMinimumWorkspaceWidth: CGFloat = 680
    static let inlineInspectorMinimumDetailWidth: CGFloat = 720

    static func showsDocumentSidebar(workspaceWidth: CGFloat, hasSelection: Bool) -> Bool {
        hasSelection && workspaceWidth >= documentSidebarMinimumWorkspaceWidth
    }

    static func showsInlineInspector(isPresented: Bool, detailWidth: CGFloat) -> Bool {
        isPresented && detailWidth >= inlineInspectorMinimumDetailWidth
    }
}

private enum SkillEditorMode: String, CaseIterable, Identifiable {
    case preview
    case edit
    case split

    var id: String { rawValue }
    var title: LocalizedStringKey {
        switch self {
        case .preview: "macos.skills.preview"
        case .edit: "macos.common.editAction"
        case .split: "macos.skills.sideBySide"
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
    @State private var sheet: SkillLibrarySheet?
    @State private var isDropTargeted = false
    @State private var importTargetSkillID: String?
    @State private var expandedSkillFileFolderIDs = Set<String>()

    var body: some View {
        NavigationSplitView(columnVisibility: $windowState.columnVisibility) {
            skillSidebar
                .navigationSplitViewColumnWidth(min: 210, ideal: 230, max: 270)
        } detail: {
            libraryWorkspace
                .navigationSplitViewColumnWidth(min: 610, ideal: 820)
        }
        .navigationSplitViewStyle(.balanced)
        .searchable(text: $searchText, placement: .sidebar, prompt: "macos.skills.searchBridgeSkills")
        .modifier(SkillsDefaultSidebarToolbarRemovalModifier())
        .background(SkillsTitlebarSanitizerView())
        .toolbar { libraryToolbar }
        .sheet(item: $sheet) { presentedSheet($0) }
        .confirmationDialog(
            "macos.skills.discardUnsavedChanges",
            isPresented: $showsDiscardConfirmation,
            titleVisibility: .visible
        ) {
            Button("macos.skills.discardChanges", role: .destructive) { discardAndApplyPendingSelection() }
            Button("common.cancel", role: .cancel) {
                pendingSkillID = nil
                pendingDocumentSelection = nil
                pendingVersionReference = nil
            }
        } message: {
            Text("macos.skills.movingToAnotherDocumentWillDiscardTheCurrentMarkdownEdits")
        }
        .confirmationDialog(
            "macos.restoretheselectedversionasthenewcurrent",
            isPresented: $showsRestoreConfirmation,
            titleVisibility: .visible
        ) {
            Button("macos.restoreasnewversion") { restoreSelectedVersion() }
            Button("common.cancel", role: .cancel) { restoreTarget = nil }
        } message: {
            Text("macos.skills.thisCopiesTheMainDocumentAndTheEntireAttachmentTreeIntoANewImmutableVersion")
        }
        .task {
            windowState.columnVisibility = .all
            await model.refreshSkillLibrary()
        }
        .onChange(of: windowState.columnVisibility) { visibility in
            if visibility != .all { windowState.columnVisibility = .all }
        }
        .onChange(of: model.selectedBridgeSkill?.id) { _ in
            expandedSkillFileFolderIDs.removeAll()
            synchronizeSelectionFromModel()
        }
        .onChange(of: model.selectedBridgeSkillFile?.id) { _ in synchronizeDraftFromModel() }
        .onChange(of: editorMode) { mode in
            if mode != .preview, !isEditingCurrentSource { synchronizeDraftFromModel() }
            updateDirtyState()
        }
        .onChange(of: draftContent) { _ in updateDirtyState() }
        .onChange(of: draftName) { _ in updateDirtyState() }
        .onChange(of: draftDescription) { _ in updateDirtyState() }
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

    private var libraryWorkspace: some View {
        GeometryReader { geometry in
            let showsDocumentSidebar = SkillsLibraryAdaptiveLayout.showsDocumentSidebar(
                workspaceWidth: geometry.size.width,
                hasSelection: model.selectedBridgeSkill != nil
            )
            if showsDocumentSidebar {
                HStack(spacing: 0) {
                    documentSidebar
                        .frame(width: min(250, max(210, geometry.size.width * 0.28)))
                    Divider()
                    detailWithInspector(showsDocumentPicker: false)
                }
            } else {
                detailWithInspector(showsDocumentPicker: model.selectedBridgeSkill != nil)
            }
        }
    }

    private func detailWithInspector(showsDocumentPicker: Bool) -> some View {
        GeometryReader { geometry in
            let presentsInspector = showsInspector && model.selectedBridgeSkill != nil
            let showsInlineInspector = SkillsLibraryAdaptiveLayout.showsInlineInspector(
                isPresented: presentsInspector,
                detailWidth: geometry.size.width
            )
            if showsInlineInspector {
                HStack(spacing: 0) {
                    documentDetail(showsDocumentPicker: showsDocumentPicker)
                    Divider()
                    versionInspector
                        .frame(width: 300)
                }
            } else {
                documentDetail(showsDocumentPicker: showsDocumentPicker)
                    .overlay(alignment: .trailing) {
                        if presentsInspector {
                            versionInspector
                                .frame(width: min(300, max(260, geometry.size.width - 140)))
                                .frame(maxHeight: .infinity)
                                .background(.regularMaterial)
                                .overlay(alignment: .leading) { Divider() }
                                .shadow(color: .black.opacity(0.12), radius: 8, x: -2)
                                .transition(.move(edge: .trailing))
                        }
                    }
            }
        }
        .animation(.easeInOut(duration: 0.18), value: showsInspector)
    }

    private var skillSidebar: some View {
        VStack(spacing: 0) {
            Picker("macos.skills.displayScope", selection: $scope) {
                ForEach(SkillLibraryScope.allCases) { option in Text(option.title).tag(option) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(10)

            if let snapshot = model.skillLibrary {
                let skills = filteredSkills(snapshot.skills)
                if skills.isEmpty {
                    SkillEmptyState(
                        title: searchText.isEmpty ? "macos.skills.noBridgeSkills" : "macos.skills.noSearchResults",
                        symbol: searchText.isEmpty ? "books.vertical" : "magnifyingglass",
                        detail: searchText.isEmpty
                            ? "macos.skills.createANewFreeFormMarkdownSkillOrImportFilesAFolderOrAZip"
                            : "macos.skills.tryAnotherSearchTermOrScope"
                    )
                } else {
                    List(skills, selection: selectedSkillBinding) { skill in
                        SkillSummaryRow(skill: skill)
                            .tag(skill.skillId)
                            .contextMenu { skillContextMenu(skill) }
                    }
                    .listStyle(.sidebar)
                    .accessibilityLabel("macos.skills.bridgeSkillList")
                }
            } else if model.bridgeConnected {
                ProgressView("macos.loadingskilllibrary")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                SkillEmptyState(
                    title: "macos.skills.cannotConnectToBridge",
                    symbol: "bolt.horizontal.circle",
                    detail: "macos.skills.checkTheConnectionAndTryAgain"
                )
            }
        }
    }

    private var documentSidebar: some View {
        Group {
            if let document = model.selectedBridgeSkill {
                List(selection: selectedDocumentBinding) {
                    Section("macos.skills.documents") {
                        Label("macos.skills.mainDocument", systemImage: "doc.text")
                            .tag(SkillDocumentSelection.main)
                            .contextMenu { mainDocumentContextMenu(document) }
                    }
                    if !document.files.isEmpty {
                        Section("macos.skills.attachedMarkdown") {
                            ForEach(SkillFileTree.visibleRows(
                                for: document.files,
                                expandedFolderIDs: expandedSkillFileFolderIDs
                            )) { row in
                                skillFileTreeRow(row, document: document)
                            }
                        }
                    }
                }
                .listStyle(.inset)
                .navigationTitle(document.skill.name)
                .accessibilityLabel("macos.skills.skillDocumentFileTree")
            } else {
                SkillEmptyState(
                    title: "macos.skills.selectASkill",
                    symbol: "doc.text.magnifyingglass",
                    detail: "macos.skills.selectABridgeSkillToManageFromTheListOnTheLeft"
                )
            }
        }
    }

    @ViewBuilder
    private func documentDetail(showsDocumentPicker: Bool) -> some View {
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
                        "macos.skills.youAreViewingAnImmutablePastVersionToChangeItRestoreItAsANewCurrentVersionFromVersionHistory",
                        locale: locale
                    ))
                }
                documentHeader(document, showsDocumentPicker: showsDocumentPicker)
                Divider()
                sourceWorkspace(document)
            }
            .navigationTitle(selectedDocumentTitle(document))
        } else {
            SkillEmptyState(
                title: "macos.skills.bridgeSkillLibrary",
                symbol: "books.vertical",
                detail: "macos.skills.selectASkillOrCreateANewMarkdownSkill"
            )
        }
    }

    private func documentHeader(
        _ document: BridgeSkillDocument,
        showsDocumentPicker: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: selectedDocumentTitle(document)).font(.headline)
                    if documentSelection == .main, !document.skill.description.isEmpty {
                        Text(verbatim: document.skill.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    } else if case .file(let path) = documentSelection {
                        Text(verbatim: path)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                Spacer()
                Text(verbatim: "v\(document.skill.version)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(Text(verbatim: BridgeAppLocalization.format(
                        "macos.skills.versionValue",
                        locale: locale,
                        document.skill.version
                    )))
            }

            HStack(spacing: 8) {
                if showsDocumentPicker {
                    compactDocumentPicker(document)
                }
                Spacer(minLength: 8)
                Picker("macos.skills.viewMode", selection: $editorMode) {
                    ForEach(SkillEditorMode.allCases) { mode in
                        Label(mode.title, systemImage: mode.symbol).tag(mode)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .frame(width: 210)
                .disabled(!isCurrentVersion(document))

                Button("macos.save", systemImage: "square.and.arrow.down") {
                    saveCurrentDocument()
                }
                .labelStyle(.iconOnly)
                .help("macos.save")
                .disabled(
                    !windowState.hasUnsavedChanges ||
                    model.skillMutationInProgress ||
                    !isCurrentVersion(document)
                )

                versionHistoryMenu(document)

                Button("macos.skills.exportAsZip", systemImage: "square.and.arrow.up") {
                    export(document)
                }
                .labelStyle(.iconOnly)
                .help("macos.skills.exportAsZip")
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
    }

    private func compactDocumentPicker(_ document: BridgeSkillDocument) -> some View {
        Picker(
            "macos.skills.documents",
            selection: Binding(
                get: { documentSelection },
                set: { requestDocumentSelection($0) }
            )
        ) {
            Label("macos.skills.mainDocument", systemImage: "doc.text")
                .tag(SkillDocumentSelection.main)
            ForEach(document.files, id: \.path) { file in
                Text(verbatim: file.path)
                    .tag(SkillDocumentSelection.file(file.path))
            }
        }
        .pickerStyle(.menu)
        .frame(maxWidth: 180)
    }

    private func versionHistoryMenu(_ document: BridgeSkillDocument) -> some View {
        Menu {
            if let history = model.selectedBridgeSkillVersions {
                ForEach(history.versions) { version in
                    Button {
                        requestVersion(version)
                    } label: {
                        Label {
                            Text(verbatim: "v\(version.version) · \(version.createdAt)")
                        } icon: {
                            Image(systemName: version.version == document.skill.version ? "checkmark" : "doc")
                        }
                    }
                }
            }
        } label: {
            Label("macos.skills.version", systemImage: "clock.arrow.circlepath")
        }
        .labelStyle(.iconOnly)
        .help("macos.skills.versionHistoryAndMetadata")
        .disabled(model.selectedBridgeSkillVersions == nil)
    }

    @ViewBuilder
    private func sourceWorkspace(_ document: BridgeSkillDocument) -> some View {
        if model.bridgeSkillFileLoading {
            ProgressView("macos.skills.loadingMarkdownFile")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if case .file = documentSelection, model.selectedBridgeSkillFile == nil {
            SkillEmptyState(
                title: "macos.skills.cannotLoadFile",
                symbol: "doc.badge.ellipsis",
                detail: "macos.skills.selectTheFileAgainOrCheckTheConnection"
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
                    TextField("macos.skills.skillName", text: $draftName)
                        .font(.headline)
                    TextField("macos.skills.searchDescriptionOptional", text: $draftDescription)
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
                .accessibilityLabel("macos.skills.fullMarkdownSourceOfSelectedFile")
        }
    }

    @ToolbarContentBuilder
    private var libraryToolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button("macos.newskill", systemImage: "doc.badge.plus") { sheet = .newSkill }
                Button("macos.skills.newMarkdownFile", systemImage: "doc.badge.plus") { sheet = .newFile }
                    .disabled(model.selectedBridgeSkill.map { !isCurrentVersion($0) } ?? true)
                Divider()
                Button("macos.skills.importNewSkillFromFilesFolderOrZip", systemImage: "square.and.arrow.down") {
                    presentImportPanel(intoCurrentSkill: false)
                }
                if let document = model.selectedBridgeSkill, isCurrentVersion(document) {
                    Button("macos.skills.importIntoCurrentSkill", systemImage: "doc.badge.arrow.up") {
                        presentImportPanel(intoCurrentSkill: true)
                    }
                }
            } label: {
                Label("macos.add", systemImage: "plus")
            }
            .help("macos.skills.addANewSkillOrMarkdownFile")
            .disabled(windowState.hasUnsavedChanges)
        }
        ToolbarItem(placement: .primaryAction) {
            Button { showsInspector.toggle() } label: {
                Label("macos.skills.versionsAndInfo", systemImage: "sidebar.trailing")
            }
                .help("macos.skills.versionHistoryAndMetadata")
                .disabled(model.selectedBridgeSkill == nil)
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                if let document = model.selectedBridgeSkill {
                    Button(BridgeAppLocalization.string(
                        document.skill.enabled ? "macos.skills.archive" : "macos.skills.reactivate",
                        locale: locale
                    ),
                           systemImage: document.skill.enabled ? "archivebox" : "tray.and.arrow.up") {
                        toggleArchived(document)
                    }
                    .disabled(windowState.hasUnsavedChanges)
                    Button("macos.skills.deletePermanentlyDialog", systemImage: "trash", role: .destructive) { sheet = .deleteSkill(document) }
                        .disabled(windowState.hasUnsavedChanges)
                }
                Button("macos.refresh", systemImage: "arrow.clockwise") { Task { await model.refreshSkillLibrary() } }
            } label: { Label("macos.skills.moreActions", systemImage: "ellipsis.circle") }
            .disabled(model.selectedBridgeSkill == nil && model.skillLibrary == nil)
        }
    }

    private var versionInspector: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("macos.skills.skillInfo").font(.headline)
                if let document = model.selectedBridgeSkill {
                    LabeledContent("macos.name", value: document.skill.name)
                    LabeledContent("macos.skills.version", value: "v\(document.skill.version)")
                    LabeledContent(
                        "macos.skills.status",
                        value: BridgeAppLocalization.string(
                            document.skill.enabled ? "macos.skills.active" : "macos.skills.archived",
                            locale: locale
                        )
                    )
                    LabeledContent("macos.skills.files", value: "\(document.files.count + 1)")
                    if let digest = document.skill.contentDigest {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("macos.skills.contentDigest").font(.caption).foregroundStyle(.secondary)
                            Text(verbatim: digest).font(.caption2.monospaced()).textSelection(.enabled)
                        }
                    }
                    Divider()
                    Text("macos.skills.versionHistory").font(.headline)
                    if let versions = model.selectedBridgeSkillVersions?.versions {
                        ForEach(versions) { version in
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Text(verbatim: "v\(version.version)").font(.body.monospacedDigit().weight(.medium))
                                    if version.version == model.selectedBridgeSkillVersions?.currentVersion {
                                        Text("macos.current").font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button("macos.skills.view") { requestVersion(version) }.buttonStyle(.link)
                                }
                                Text(verbatim: DisplayFormat.dateTime(version.createdAt, locale: locale))
                                    .font(.caption).foregroundStyle(.secondary)
                                if version.legacy {
                                    Label("macos.skills.legacyFormat", systemImage: "exclamationmark.triangle")
                                        .font(.caption).foregroundStyle(.orange)
                                }
                                if version.version != model.selectedBridgeSkillVersions?.currentVersion {
                                    Button("macos.skills.restoreAsNewCurrentVersion") {
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
                    Text("macos.skills.selectASkillToViewItsMetadataAndImmutableVersionHistory")
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
                    postMutationDocumentSelection = .file(path)
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
    private func skillFileTreeRow(_ row: SkillFileTreeVisibleRow, document: BridgeSkillDocument) -> some View {
        let node = row.node
        if let path = node.path {
            Label { Text(verbatim: node.name) } icon: { Image(systemName: "doc.text") }
                .padding(.leading, CGFloat(row.depth) * 18)
                .tag(SkillDocumentSelection.file(path))
                .contextMenu { fileContextMenu(path: path, document: document) }
        } else {
            let isExpanded = expandedSkillFileFolderIDs.contains(node.id)
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    toggleFolder(node.id)
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .accessibilityHidden(true)
                    Label {
                        Text(verbatim: node.name)
                    } icon: {
                        Image(systemName: "folder")
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, CGFloat(row.depth) * 18)
                .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(BridgeAppLocalization.string(
                isExpanded ? "macos.expanded" : "macos.collapsed",
                locale: locale
            ))
        }
    }

    private func toggleFolder(_ id: String) {
        if expandedSkillFileFolderIDs.contains(id) {
            expandedSkillFileFolderIDs.remove(id)
        } else {
            expandedSkillFileFolderIDs.insert(id)
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
        case .file(let path):
            expandFolders(containing: path)
            Task { await model.loadBridgeSkillFile(path: path) }
        }
    }

    private func expandFolders(containing path: String) {
        let folders = path.split(separator: "/").dropLast().map(String.init)
        guard !folders.isEmpty else { return }
        var components: [String] = []
        for folder in folders {
            components.append(folder)
            expandedSkillFileFolderIDs.insert("folder:\(components.joined(separator: "/"))")
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
            expandFolders(containing: path)
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

    private func focusSkillSearch() {
        if let textView = NSApp.keyWindow?.firstResponder as? NSTextView,
           textView.isEditable {
            let item = NSMenuItem()
            item.tag = Int(NSFindPanelAction.showFindPanel.rawValue)
            textView.performFindPanelAction(item)
            return
        }
        DispatchQueue.main.async {
            guard let root = NSApp.keyWindow?.contentView,
                  let search = firstSubview(of: NSSearchField.self, in: root) else { return }
            NSApp.keyWindow?.makeFirstResponder(search)
        }
    }

    @ViewBuilder
    private func skillContextMenu(_ skill: BridgeSkillSummary) -> some View {
        Button("macos.skills.open") { requestSkillSelection(skill.skillId) }
        Button(BridgeAppLocalization.string(
            skill.enabled ? "macos.skills.archive" : "macos.skills.reactivate",
            locale: locale
        )) {
            Task { await model.setBridgeSkillEnabled(.init(
                skillId: skill.skillId, expectedVersion: skill.version, enabled: !skill.enabled
            )) }
        }
        .disabled(windowState.hasUnsavedChanges)
    }

    @ViewBuilder
    private func mainDocumentContextMenu(_ document: BridgeSkillDocument) -> some View {
        Button("macos.common.editAction") { editorMode = .edit; synchronizeDraftFromModel() }
            .disabled(!isCurrentVersion(document))
        Button("macos.skills.importIntoCurrentSkill") { presentImportPanel(intoCurrentSkill: true) }
            .disabled(!isCurrentVersion(document) || windowState.hasUnsavedChanges)
        Button("macos.skills.exportAsZip") { export(document) }
    }

    @ViewBuilder
    private func fileContextMenu(path: String, document: BridgeSkillDocument) -> some View {
        Button("macos.common.editAction") { requestDocumentSelection(.file(path)); editorMode = .edit }
            .disabled(!isCurrentVersion(document))
        Button("macos.skills.renameDialog") { sheet = .renameFile(path) }
            .disabled(!isCurrentVersion(document) || windowState.hasUnsavedChanges)
        Button("macos.skills.importIntoCurrentSkill") { presentImportPanel(intoCurrentSkill: true) }
            .disabled(!isCurrentVersion(document) || windowState.hasUnsavedChanges)
        Divider()
        Button("macos.skills.deleteFile", role: .destructive) { deleteFile(path, from: document) }
            .disabled(!isCurrentVersion(document) || windowState.hasUnsavedChanges)
    }

    private func renameFile(_ oldPath: String, to newPath: String) {
        guard let document = model.selectedBridgeSkill else { return }
        Task { @MainActor in
            await model.loadBridgeSkillFile(path: oldPath)
            guard let content = model.selectedBridgeSkillFile?.content else { return }
            postMutationDocumentSelection = .file(newPath)
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
        alert.messageText = BridgeAppLocalization.string("macos.skills.deleteTheAttachedMarkdownFile", locale: locale)
        alert.informativeText = path
        alert.addButton(withTitle: BridgeAppLocalization.string("macos.skills.deleteFile", locale: locale))
        alert.addButton(withTitle: BridgeAppLocalization.string("common.cancel", locale: locale))
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
        panel.title = BridgeAppLocalization.string("macos.skills.importMarkdownFilesAFolderOrAZip", locale: locale)
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
            let urls = await BridgeSkillDropLoader.urls(from: providers)
            if !urls.isEmpty {
                beginImport(urls, intoCurrentSkill: false)
            }
        }
    }

    private func beginImport(_ urls: [URL], intoCurrentSkill: Bool) {
        guard !urls.isEmpty else { return }
        importTargetSkillID = intoCurrentSkill ? model.selectedBridgeSkill?.skill.skillId : nil
        switch BridgeSkillImportRouter.route(urls: urls) {
        case .package(let url):
            Task { @MainActor in
                if let inspection = await model.inspectBridgeSkillPackage(at: url) {
                    sheet = .importReview(.package(sourceName: url.deletingPathExtension().lastPathComponent,
                                                   inspection: inspection))
                }
            }
        case .direct(let directURLs):
            Task { @MainActor in
                let review = await Task.detached(priority: .userInitiated) {
                    BridgeSkillImportCollector.collect(urls: directURLs)
                }.value
                sheet = .importReview(review)
            }
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

private struct SkillsDefaultSidebarToolbarRemovalModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 14.0, *) {
            content.toolbar(removing: .sidebarToggle)
        } else {
            content
        }
    }
}

@MainActor
private final class SkillsTitlebarSanitizerNSView: NSView {
    private weak var observedToolbar: NSToolbar?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        refresh()
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow == nil, let observedToolbar {
            NotificationCenter.default.removeObserver(
                self,
                name: NSToolbar.willAddItemNotification,
                object: observedToolbar
            )
            self.observedToolbar = nil
        }
        super.viewWillMove(toWindow: newWindow)
    }

    func refresh() {
        window?.titleVisibility = .hidden
        observeToolbarIfNeeded()
        removeSystemSplitViewItems()
    }

    private func observeToolbarIfNeeded() {
        guard let toolbar = window?.toolbar, toolbar !== observedToolbar else { return }
        if let observedToolbar {
            NotificationCenter.default.removeObserver(
                self,
                name: NSToolbar.willAddItemNotification,
                object: observedToolbar
            )
        }
        observedToolbar = toolbar
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(toolbarWillAddItem(_:)),
            name: NSToolbar.willAddItemNotification,
            object: toolbar
        )
    }

    @objc private func toolbarWillAddItem(_ notification: Notification) {
        guard let toolbar = notification.object as? NSToolbar,
              let item = notification.userInfo?.values
            .compactMap({ $0 as? NSToolbarItem })
            .first(where: Self.isSystemSplitViewItem) else { return }
        conceal(item)
        DispatchQueue.main.async { [weak self, weak toolbar] in
            self?.removeSystemSplitViewItems(from: toolbar)
            self?.window?.titleVisibility = .hidden
        }
    }

    private func removeSystemSplitViewItems() {
        removeSystemSplitViewItems(from: observedToolbar)
    }

    private func removeSystemSplitViewItems(from toolbar: NSToolbar?) {
        guard let toolbar else { return }
        let indexes = toolbar.items.indices.filter { index in
            Self.isSystemSplitViewItem(toolbar.items[index])
        }
        for index in indexes.reversed() {
            conceal(toolbar.items[index])
            toolbar.removeItem(at: index)
        }
        window?.titleVisibility = .hidden
    }

    private func conceal(_ item: NSToolbarItem) {
        item.isEnabled = false
        item.view?.alphaValue = 0
        item.view?.isHidden = true
    }

    private static func isSystemSplitViewItem(_ item: NSToolbarItem) -> Bool {
        let identifier = item.itemIdentifier.rawValue
        return identifier.contains("navigationSplitView.toggleSidebar")
            || identifier.contains("splitViewSeparator")
    }
}

private struct SkillsTitlebarSanitizerView: NSViewRepresentable {
    func makeNSView(context: Context) -> SkillsTitlebarSanitizerNSView {
        SkillsTitlebarSanitizerNSView(frame: .zero)
    }

    func updateNSView(_ nsView: SkillsTitlebarSanitizerNSView, context: Context) {
        nsView.refresh()
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
    @Environment(\.locale) private var locale
    let skill: BridgeSkillSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(verbatim: skill.name).fontWeight(.medium).lineLimit(1)
                if !skill.enabled {
                    Image(systemName: "archivebox.fill").foregroundStyle(.orange).accessibilityLabel("macos.skills.archived")
                }
            }
            if !skill.description.isEmpty {
                Text(verbatim: skill.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Text(verbatim: "v\(skill.version)").font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityValue(Text(verbatim: BridgeAppLocalization.string(
            skill.enabled ? "macos.skills.active" : "macos.skills.archived",
            locale: locale
        )))
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

    static func visibleRows(
        for files: [BridgeSkillFileSummary],
        expandedFolderIDs: Set<String>
    ) -> [SkillFileTreeVisibleRow] {
        var rows: [SkillFileTreeVisibleRow] = []
        func append(_ nodes: [SkillFileTree], depth: Int) {
            for node in nodes {
                rows.append(SkillFileTreeVisibleRow(node: node, depth: depth))
                if let children = node.children, expandedFolderIDs.contains(node.id) {
                    append(children, depth: depth + 1)
                }
            }
        }
        append(nodes(for: files), depth: 0)
        return rows
    }
}

private struct SkillFileTreeVisibleRow: Identifiable {
    let node: SkillFileTree
    let depth: Int
    var id: String { node.id }
}

private enum SkillBannerStyle { case warning, archived, error }

private struct SkillStatusBanner: View {
    let style: SkillBannerStyle
    let message: String

    var body: some View {
        Label { Text(verbatim: message) } icon: { Image(systemName: symbol) }
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
            key = "macos.skills.thisSkillIsArchivedAndExcludedFromSearchResultsItsImmutableVersionsRemainReadable"
        case .legacyStructured:
            key = "macos.skills.thisIsALegacyStructuredVersionEditingOrRestoringItCreatesANewFreeFormMarkdownAndFileTreeVersion"
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
        .accessibilityLabel("macos.skills.renderedMarkdownPreview")
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
                if let language { Text(verbatim: language).font(.caption2.monospaced()).foregroundStyle(.secondary) }
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
        case "macos-metadata": key = "macos.skills.macosMetadataFilesAreNotImported"
        case "unsupported-file": key = "macos.skills.onlyMdAndMarkdownAreCurrentlySupported"
        case "symbolic-link": key = "macos.skills.symbolicLinksCannotBeImported"
        case "special-file": key = "macos.skills.onlyRegularFilesCanBeImported"
        case "stat-failed": key = "macos.skills.fileInformationCouldNotBeRead"
        case "unsafe-path": key = "macos.skills.aFilePathOutsideTheSelectedFolderCannotBeImported"
        case "path-conflict": key = "macos.skills.itsPathConflictsWithAnotherFile"
        case "invalid-utf8": key = "macos.skills.thisIsNotValidUtf8Markdown"
        case "file-too-large": key = "macos.skills.aMarkdownFileCannotExceed3Mib"
        case "collection-too-large": key = "macos.skills.theMarkdownFilesExceedTheAllowedFileCountOrSizeLimit"
        case "read-failed": key = "macos.skills.theFileCouldNotBeRead"
        default: key = "macos.skills.thisFileCannotBeImported"
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
    let suggestedName: String
    let suggestedDescription: String?
    let payload: BridgeSkillImportPayload
    let suggestedMainPath: String?
    let issues: [BridgeSkillImportIssue]

    static func package(sourceName: String, inspection: BridgeSkillPackageInspection) -> Self {
        .init(
            suggestedName: inspection.suggestedName ?? sourceName,
            suggestedDescription: inspection.suggestedDescription,
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

    var automaticallyExcludedIssues: [BridgeSkillImportIssue] {
        issues.filter { $0.reason == "macos-metadata" }
    }

    var warningIssues: [BridgeSkillImportIssue] {
        issues.filter { $0.reason != "macos-metadata" }
    }

    var warningSectionTitleKey: String {
        warningIssues.contains(where: { $0.reason == "path-conflict" })
            ? "macos.skills.skippedItemsAndConflicts"
            : "macos.skills.itemsNotImported"
    }

    func bytes(for path: String) -> Int? {
        switch payload {
        case .direct(let files): files.first(where: { $0.path == path })?.bytes
        case .package(let inspection): inspection.files.first(where: { $0.path == path })?.bytes
        }
    }

    func initiallySelectedPaths(intoCurrentSkill: Bool) -> Set<String> {
        let initialMainPath = intoCurrentSkill ? nil : suggestedMainPath
        let mainKey = initialMainPath.map(bridgeSkillPathComparisonKey)
        return Set(paths.filter { path in
            if !isBridgeSkillMainDocumentPath(path) { return true }
            guard let mainKey else { return false }
            return bridgeSkillPathComparisonKey(path) == mainKey
        })
    }
}

struct BridgeSkillMetadataSuggestion: Sendable, Equatable {
    let name: String?
    let description: String?
}

enum BridgeSkillMetadataParser {
    static func parse(_ source: String) -> BridgeSkillMetadataSuggestion {
        var text = source
        if text.first == "\u{feff}" { text.removeFirst() }
        let lines = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        guard lines.first?.trimmingCharacters(in: .whitespacesAndNewlines) == "---",
              let closing = lines.indices.dropFirst().first(where: {
                  lines[$0].trimmingCharacters(in: .whitespacesAndNewlines) == "---"
              }) else {
            return .init(name: nil, description: nil)
        }

        var name: String?
        var description: String?
        for line in lines[1..<closing] {
            guard line.first?.isWhitespace != true, let separator = line.firstIndex(of: ":") else { continue }
            let key = line[..<separator].trimmingCharacters(in: .whitespacesAndNewlines)
            let value = yamlScalar(String(line[line.index(after: separator)...]))
            switch key {
            case "name": name = normalizedSuggestion(value, maxCharacters: 120)
            case "description": description = normalizedSuggestion(value, maxCharacters: 2_000)
            default: continue
            }
        }
        return .init(name: name, description: description)
    }

    private static func yamlScalar(_ source: String) -> String {
        let value = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.count >= 2 else { return value }
        if value.first == "\"", value.last == "\"",
           let data = value.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(String.self, from: data) {
            return decoded
        }
        if value.first == "'", value.last == "'" {
            return String(value.dropFirst().dropLast()).replacingOccurrences(of: "''", with: "'")
        }
        return value
    }

    private static func normalizedSuggestion(_ source: String, maxCharacters: Int) -> String? {
        let normalized = source.split(whereSeparator: \Character.isWhitespace).joined(separator: " ")
        guard !normalized.isEmpty, normalized.count <= maxCharacters,
              !normalized.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        return normalized
    }
}

struct BridgeSkillImportCommit {
    let name: String
    let description: String?
    let mainPath: String?
    let selectedPaths: Set<String>
}

enum BridgeSkillImportRoute: Equatable {
    case package(URL)
    case direct([URL])
}

enum BridgeSkillImportRouter {
    static func route(urls: [URL]) -> BridgeSkillImportRoute {
        if urls.count == 1, let url = urls.first, url.pathExtension.lowercased() == "zip" {
            return .package(url)
        }
        return .direct(urls)
    }
}

@MainActor
enum BridgeSkillDropLoader {
    static func urls(from providers: [NSItemProvider]) async -> [URL] {
        var urls: [URL] = []
        var seen = Set<String>()
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier),
                  let url = decodeURL(from: item) else { continue }
            let key = bridgeSkillPathComparisonKey(url.standardizedFileURL.path)
            if seen.insert(key).inserted { urls.append(url) }
        }
        return urls
    }

    static func decodeURL(from item: NSSecureCoding?) -> URL? {
        if let url = item as? URL { return url }
        if let data = item as? Data { return URL(dataRepresentation: data, relativeTo: nil) }
        return nil
    }
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
            let key = bridgeSkillPathComparisonKey(file.path)
            if keys.contains(key) {
                issues.append(.init(path: file.path, reason: "path-conflict"))
            } else {
                keys.insert(key)
                unique[file.path] = file
            }
        }
        let sorted = unique.values.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
        let skillCandidate = sorted.first { $0.path == "SKILL.md" }
        let documentCandidate = sorted.first { $0.path == "document.md" }
        let suggestion = skillCandidate?.path ?? documentCandidate?.path ?? (sorted.count == 1 ? sorted[0].path : nil)
        let metadata = skillCandidate.map { BridgeSkillMetadataParser.parse($0.content) }
        let sourceName = urls.count == 1 ? urls[0].deletingPathExtension().lastPathComponent : ""
        return .init(
            suggestedName: metadata?.name ?? sourceName,
            suggestedDescription: metadata?.description,
            payload: .direct(sorted),
            suggestedMainPath: suggestion,
            issues: issues
        )
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
            let normalized = relativePath.replacingOccurrences(of: "\\", with: "/")
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
    try? BridgeTextIntegrity.decodeUTF8Strict(data)
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
        _name = State(initialValue: review.suggestedName)
        _description = State(initialValue: review.suggestedDescription ?? "")
        _mainPath = State(initialValue: currentSkill == nil ? review.suggestedMainPath : nil)
        _selectedPaths = State(initialValue: review.initiallySelectedPaths(intoCurrentSkill: currentSkill != nil))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("macos.skills.reviewImport").font(.title2.weight(.semibold))
            Text(verbatim: BridgeAppLocalization.string(
                currentSkill == nil
                    ? "macos.skills.chooseTheMainDocumentOtherSelectedFilesAreSavedAsAttachedMarkdownWithTheirRelativePathsPreserved"
                    : "macos.skills.selectedFilesAreAddedOrReplacedAsAttachmentsTheMainDocumentIsReplacedOnlyWhenYouExplicitlySelectOne",
                locale: locale
            ))
                .font(.callout).foregroundStyle(.secondary)
            if currentSkill == nil {
                Form {
                    TextField("macos.skills.skillName", text: $name)
                    TextField("macos.skills.searchDescriptionOptional", text: $description)
                }.formStyle(.grouped).frame(height: 120)
            }
            Picker("macos.skills.mainDocument", selection: mainPathSelection) {
                if currentSkill != nil { Text("macos.skills.keepMainDocument").tag(String?.none) }
                ForEach(review.paths, id: \.self) { path in Text(verbatim: path).tag(String?.some(path)) }
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
                        Label {
                            Text(verbatim: path)
                        } icon: {
                            Image(systemName: path == mainPath ? "doc.text.fill" : "doc.text")
                        }
                        Spacer()
                        if currentSkill?.files.contains(where: {
                            bridgeSkillPathComparisonKey($0.path) == bridgeSkillPathComparisonKey(path)
                        }) == true {
                            Text("macos.skills.replace").font(.caption).foregroundStyle(.orange)
                        } else if currentSkill != nil,
                                  isBridgeSkillMainDocumentPath(path),
                                  path != mainPath {
                            Text("macos.skills.chooseAsMainOrExclude").font(.caption).foregroundStyle(.orange)
                        }
                    }
                }
            }
            .frame(minHeight: 220)
            if !review.automaticallyExcludedIssues.isEmpty {
                GroupBox("macos.skills.automaticCleanup") {
                    Label {
                        Text(verbatim: BridgeAppLocalization.format(
                            "macos.skills.macosMetadataExcludedAutomaticallyCount",
                            locale: locale,
                            review.automaticallyExcludedIssues.count
                        ))
                    } icon: {
                        Image(systemName: "checkmark.circle")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if !review.warningIssues.isEmpty {
                GroupBox(LocalizedStringKey(review.warningSectionTitleKey)) {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(review.warningIssues) { issue in
                            Label {
                                Text(verbatim: "\(issue.path): \(issue.localizedReason(locale: locale))")
                            } icon: {
                                Image(systemName: "exclamationmark.triangle")
                            }
                                .font(.caption).foregroundStyle(.orange)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if selectionExceedsLimits {
                Label(
                    "macos.skills.theMarkdownFilesExceedTheAllowedFileCountOrSizeLimit",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }
            HStack {
                Button("common.cancel", role: .cancel) { dismiss() }
                Spacer()
                Button("macos.skills.import") {
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
                    selectedMainDocumentConflicts ||
                    selectionExceedsLimits ||
                    (currentSkill == nil && (mainPath == nil || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                )
            }
        }
        .padding(22)
        .frame(minWidth: 620, minHeight: 600)
    }

    private var mainPathSelection: Binding<String?> {
        Binding(
            get: { mainPath },
            set: { newValue in
                mainPath = newValue
                guard let newValue else { return }
                let newKey = bridgeSkillPathComparisonKey(newValue)
                selectedPaths = Set(selectedPaths.filter { path in
                    !isBridgeSkillMainDocumentPath(path) || bridgeSkillPathComparisonKey(path) == newKey
                })
                selectedPaths.insert(newValue)
            }
        )
    }

    private var selectedMainDocumentConflicts: Bool {
        selectedPaths.contains(where: {
            isBridgeSkillMainDocumentPath($0) && $0 != mainPath
        })
    }

    private var selectionExceedsLimits: Bool {
        var attachments = Dictionary(uniqueKeysWithValues: (currentSkill?.files ?? []).map {
            (bridgeSkillPathComparisonKey($0.path), $0.bytes)
        })
        for path in selectedPaths where path != mainPath {
            guard let bytes = review.bytes(for: path) else { return true }
            attachments[bridgeSkillPathComparisonKey(path)] = bytes
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
            Text("macos.newbridgeskill").font(.title2.weight(.semibold))
            TextField("macos.skills.skillName", text: $name)
            TextField("macos.skills.searchDescriptionOptional", text: $description)
            Text("macos.skills.mainMarkdownDocument").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $document).font(.system(.body, design: .monospaced))
                .frame(minHeight: 320).border(Color(nsColor: .separatorColor))
            HStack {
                Button("common.cancel", role: .cancel) { dismiss() }
                Spacer()
                Button("macos.skills.createSkill") { save(name, description.isEmpty ? nil : description, document) }
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
            Text("macos.skills.newMarkdownFile").font(.title2.weight(.semibold))
            TextField("macos.skills.relativePathMdOrMarkdown", text: $path)
            TextEditor(text: $content).font(.system(.body, design: .monospaced))
                .frame(minHeight: 280).border(Color(nsColor: .separatorColor))
            HStack {
                Button("common.cancel", role: .cancel) { dismiss() }
                Spacer()
                Button("macos.skills.addFile") { save(path, content) }.buttonStyle(.borderedProminent)
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
            Text("macos.skills.renameMarkdownFile").font(.headline)
            TextField("macos.skills.newRelativePath", text: $path)
            HStack {
                Button("common.cancel", role: .cancel) { dismiss() }
                Spacer()
                Button("macos.skills.renameAction") { save(path) }.buttonStyle(.borderedProminent)
                    .disabled(path == oldPath || path.isEmpty)
            }
        }.padding(20).frame(width: 480)
    }
}

private struct BridgeSkillDeleteSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let skillName: String
    let isDeleting: Bool
    let confirm: (String) -> Void
    @State private var typedName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("macos.skills.permanentlyDeleteSkill").font(.headline)
            Text("macos.skills.allVersionsAndMarkdownFilesWillBeDeletedAndCannotBeRecovered")
                .font(.caption).foregroundStyle(.secondary)
            Text(verbatim: BridgeAppLocalization.format(
                "macos.skills.toContinueEnterTheExactSkillNameValue",
                locale: locale,
                skillName
            )).font(.caption)
            TextField("macos.skills.skillName", text: $typedName)
            HStack {
                Button("common.cancel", role: .cancel) { dismiss() }
                Spacer()
                if isDeleting { ProgressView().controlSize(.small) }
                Button("macos.skills.deletePermanentlyAction", role: .destructive) { confirm(typedName) }
                    .disabled(typedName != skillName || isDeleting)
            }
        }.padding(20).frame(width: 430)
    }
}
