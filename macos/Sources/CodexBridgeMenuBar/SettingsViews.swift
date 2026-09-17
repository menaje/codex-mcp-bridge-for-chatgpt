import AppKit
import CodexBridgeKit
import SwiftUI
import SystemConfiguration

private func detectedRemoteManagementEndpoint() -> String {
    let configuredLocalName = (SCDynamicStoreCopyLocalHostName(nil) as String?)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let processHostName = ProcessInfo.processInfo.hostName
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let host: String
    if let configuredLocalName, !configuredLocalName.isEmpty {
        host = configuredLocalName.hasSuffix(".local")
            ? configuredLocalName
            : "\(configuredLocalName).local"
    } else if !processHostName.isEmpty {
        host = processHostName
    } else {
        host = "localhost"
    }
    var components = URLComponents()
    components.scheme = "https"
    components.host = host
    components.port = 8766
    return components.string ?? "https://\(host):8766"
}

enum SettingsNavigationPane: String, CaseIterable, Identifiable {
    case general
    case modelExecution = "model-execution"
    case projects
    case codex
    case connection
    case server

    var id: String { rawValue }

    var titleKey: String {
        switch self {
        case .general: return "macos.general"
        case .modelExecution: return "macos.settings.modelAndExecution"
        case .projects: return "settings.projects"
        case .codex: return "macos.settings.codexAccountAndInstallation"
        case .connection: return "macos.settings.connection"
        case .server: return "macos.server"
        }
    }

    var descriptionKey: String {
        switch self {
        case .general: return "macos.settings.generalDescription"
        case .modelExecution: return "macos.settings.modelAndExecutionDescription"
        case .projects: return "macos.settings.projectsDescription"
        case .codex: return "macos.settings.codexAccountAndInstallationDescription"
        case .connection: return "macos.settings.connectionDescription"
        case .server: return "macos.settings.serverDescription"
        }
    }

    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .modelExecution: return "slider.horizontal.3"
        case .projects: return "folder"
        case .codex: return "terminal"
        case .connection: return "network"
        case .server: return "server.rack"
        }
    }

    func isAvailable(
        isRemoteClient: Bool,
        hasSettings: Bool,
        needsSetup: Bool
    ) -> Bool {
        switch self {
        case .general, .connection:
            return true
        case .modelExecution, .projects:
            return hasSettings && !needsSetup
        case .codex:
            return !isRemoteClient
        case .server:
            return !isRemoteClient && hasSettings && !needsSetup
        }
    }

    static func resolved(
        rawValue: String,
        available: [SettingsNavigationPane],
        needsSetup: Bool
    ) -> SettingsNavigationPane {
        let migrated = rawValue == "skills" ? "general" : rawValue
        if let pane = SettingsNavigationPane(rawValue: migrated), available.contains(pane) {
            return pane
        }
        if needsSetup, available.contains(.connection) { return .connection }
        return available.first ?? .general
    }
}

enum SettingsSearchTarget: String, CaseIterable, Identifiable {
    case generalLanguage
    case generalTaskPresentation
    case generalNotifications
    case generalLaunchAtLogin
    case modelAccess
    case modelSelection
    case modelReasoning
    case modelDelegation
    case modelFastMode
    case modelConcurrency
    case modelHistory
    case projects
    case codexAccount
    case codexInstallation
    case codexUpdates
    case connectionSetup
    case connectionRole
    case connectionActiveServer
    case connectionRemoteManagement
    case connectionDevicePairing
    case serverAccess

    var id: String { rawValue }

    var pane: SettingsNavigationPane {
        switch self {
        case .generalLanguage, .generalTaskPresentation, .generalNotifications,
             .generalLaunchAtLogin:
            return .general
        case .modelAccess, .modelSelection, .modelReasoning, .modelDelegation,
             .modelFastMode, .modelConcurrency, .modelHistory:
            return .modelExecution
        case .projects:
            return .projects
        case .codexAccount, .codexInstallation, .codexUpdates:
            return .codex
        case .connectionSetup, .connectionRole, .connectionActiveServer,
             .connectionRemoteManagement, .connectionDevicePairing:
            return .connection
        case .serverAccess:
            return .server
        }
    }

    var titleKey: String {
        switch self {
        case .generalLanguage: return "macos.appandcardlanguage"
        case .generalTaskPresentation: return "macos.keepnewagenttasksinthecodexapp"
        case .generalNotifications: return "macos.notifyaboutbridgeproblems"
        case .generalLaunchAtLogin: return "macos.launchmenubarappatlogin"
        case .modelAccess: return "macos.accessstrategy"
        case .modelSelection: return "settings.model"
        case .modelReasoning: return "macos.reasoningeffort"
        case .modelDelegation: return "settings.allowDelegation"
        case .modelFastMode: return "settings.usePriority"
        case .modelConcurrency: return "macos.concurrentagenttasks"
        case .modelHistory: return "history.title"
        case .projects: return "settings.projects"
        case .codexAccount: return "macos.accountusage"
        case .codexInstallation: return "macos.cliinstallation"
        case .codexUpdates: return "macos.versionmanagement"
        case .connectionSetup: return "macos.connectionAssistant.openSetup"
        case .connectionRole: return "macos.approle"
        case .connectionActiveServer: return "macos.activeserver"
        case .connectionRemoteManagement: return "macos.managethisserverfromanothermac"
        case .connectionDevicePairing: return "macos.devicepairing"
        case .serverAccess: return "macos.maximumallowedaccess"
        }
    }

    var keywordKeys: [String] {
        switch self {
        case .generalLanguage:
            return ["macos.displayandexecution", "macos.withautomaticthemacosappfollowsyourmac"]
        case .generalTaskPresentation:
            return ["settings.dashboardAutoOpenBackground", "settings.completionFollowUp"]
        case .generalNotifications:
            return ["macos.securityandconnectionapprovalnotifications", "macos.openmacosnotificationsettings"]
        case .generalLaunchAtLogin:
            return ["macos.openloginitemsettings", "macos.themenubarappwillopenautomaticallyat"]
        case .modelAccess:
            return ["macos.access", "macos.readonly", "macos.workspacewrite", "macos.fullaccess"]
        case .modelSelection:
            return ["macos.modelpolicy", "macos.selectionmode", "macos.automaticallowlist"]
        case .modelReasoning:
            return ["macos.modelpolicy"]
        case .modelDelegation:
            return ["settings.ultraHint"]
        case .modelFastMode:
            return ["settings.usePriorityHint"]
        case .modelConcurrency:
            return ["macos.settings.execution"]
        case .modelHistory:
            return ["history.period", "history.forever"]
        case .projects:
            return ["macos.addproject", "macos.noregisteredprojects"]
        case .codexAccount:
            return ["macos.settings.codexAccountAndInstallation", "macos.apicostconnection"]
        case .codexInstallation:
            return ["macos.bridgecli", "macos.useanothercodexinstallation"]
        case .codexUpdates:
            return ["macos.installationandrecovery", "macos.restorepreviousversion"]
        case .connectionSetup:
            return ["macos.runtimeapikey", "macos.tunnel", "macos.connectionAssistant.connectionDetailsTitle"]
        case .connectionRole:
            return ["macos.runserveronthismac", "macos.connecttoexistingserver"]
        case .connectionActiveServer:
            return ["macos.pairnewserver", "macos.reconnect"]
        case .connectionRemoteManagement:
            return ["macos.advancedconnectionsettings", "macos.httpsaddress"]
        case .connectionDevicePairing:
            return ["macos.registereddevices", "macos.createandcopyanewpairinginvitationvalid"]
        case .serverAccess:
            return ["macos.serversettings", "macos.applyandrestartserver"]
        }
    }

    var anchorID: String {
        switch self {
        case .generalLanguage, .generalTaskPresentation:
            return "settings-search-general-display"
        case .generalNotifications, .generalLaunchAtLogin:
            return "settings-search-general-app"
        case .modelAccess:
            return "settings-search-model-access"
        case .modelSelection, .modelReasoning, .modelDelegation, .modelFastMode:
            return "settings-search-model-policy"
        case .modelConcurrency:
            return "settings-search-model-execution"
        case .modelHistory:
            return "settings-search-model-history"
        case .projects:
            return "settings-search-projects"
        case .codexAccount:
            return "settings-search-codex-account"
        case .codexInstallation, .codexUpdates:
            return "settings-search-codex-installation"
        case .connectionSetup:
            return "settings-search-connection-setup"
        case .connectionRole:
            return "settings-search-connection-role"
        case .connectionActiveServer:
            return "settings-search-connection-active-server"
        case .connectionRemoteManagement, .connectionDevicePairing:
            return "settings-search-connection-remote-management"
        case .serverAccess:
            return "settings-search-server-access"
        }
    }

    func isAvailable(
        availablePanes: [SettingsNavigationPane],
        isRemoteClient: Bool,
        hasSettings: Bool,
        needsSetup: Bool
    ) -> Bool {
        guard availablePanes.contains(pane) else { return false }
        switch self {
        case .generalLanguage, .generalTaskPresentation:
            return hasSettings
        case .connectionSetup:
            return needsSetup
        case .connectionRole:
            return !needsSetup
        case .connectionActiveServer:
            return isRemoteClient && !needsSetup
        case .connectionRemoteManagement, .connectionDevicePairing:
            return !isRemoteClient && !needsSetup
        default:
            return true
        }
    }
}

enum SettingsSearchIndex {
    static func results(
        query: String,
        locale: Locale,
        availablePanes: [SettingsNavigationPane],
        isRemoteClient: Bool,
        hasSettings: Bool,
        needsSetup: Bool
    ) -> [SettingsSearchTarget] {
        let terms = query
            .split(whereSeparator: \.isWhitespace)
            .map { normalized(String($0), locale: locale) }
            .filter { !$0.isEmpty }
        guard !terms.isEmpty else { return [] }

        return SettingsSearchTarget.allCases.filter { target in
            guard target.isAvailable(
                availablePanes: availablePanes,
                isRemoteClient: isRemoteClient,
                hasSettings: hasSettings,
                needsSetup: needsSetup
            ) else { return false }
            let keys = [target.titleKey, target.pane.titleKey] + target.keywordKeys
            let searchableText = normalized(
                keys.map { BridgeAppLocalization.string($0, locale: locale) }
                    .joined(separator: " "),
                locale: locale
            )
            return terms.allSatisfy(searchableText.contains)
        }
    }

    private static func normalized(_ value: String, locale: Locale) -> String {
        value.folding(
            options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
            locale: locale
        )
    }
}

struct SettingsSearchRequest: Equatable {
    let id = UUID()
    let target: SettingsSearchTarget
}

struct SettingsSearchScrollContainer<Content: View>: View {
    let request: SettingsSearchRequest?
    let pane: SettingsNavigationPane
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollViewReader { proxy in
            content()
                .onAppear { scrollIfNeeded(using: proxy) }
                .onChange(of: request?.id) { _ in scrollIfNeeded(using: proxy) }
        }
    }

    private func scrollIfNeeded(using proxy: ScrollViewProxy) {
        guard let request, request.target.pane == pane else { return }
        Task { @MainActor in
            await Task.yield()
            withAnimation(.easeInOut(duration: 0.2)) {
                proxy.scrollTo(request.target.anchorID, anchor: .top)
            }
        }
    }
}

struct NativeSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var syncState = SettingsDraftSyncState()
    @State private var showDiscardDraftConfirmation = false
    @State private var didResolveInitialPane = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var searchQuery = ""
    @State private var searchRequest: SettingsSearchRequest?
    @AppStorage("settings.selectedPane") private var selectedPaneID = "general"
    var onWindowTitleChange: ((String) -> Void)?

    init(
        onWindowTitleChange: ((String) -> Void)? = nil,
        initialColumnVisibility: NavigationSplitViewVisibility = .all,
        initialSearchQuery: String = ""
    ) {
        self.onWindowTitleChange = onWindowTitleChange
        _columnVisibility = State(initialValue: initialColumnVisibility)
        _searchQuery = State(initialValue: initialSearchQuery)
    }

    var body: some View {
        GeometryReader { geometry in
            settingsNavigation
                .frame(
                    width: geometry.size.width,
                    height: geometry.size.height,
                    alignment: .top
                )
        }
        .frame(minWidth: 820, minHeight: 600)
    }

    private var settingsNavigation: some View {
        HStack(spacing: 0) {
            if columnVisibility != .detailOnly {
                settingsSidebar
                    .id(settingsSidebarIdentity)
                    .frame(width: 238)
                Divider()
            }
            settingsDetail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .animation(.easeInOut(duration: 0.2), value: columnVisibility)
        .modifier(SettingsDefaultSidebarToolbarRemovalModifier())
        .background(SettingsToolbarCleanupView())
        .background(SettingsSidebarToggleAccessory(columnVisibility: $columnVisibility))
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.locale, model.interfaceLocale)
        .onAppear {
            if !didResolveInitialPane {
                didResolveInitialPane = true
                if model.needsSetup, model.requestedSettingsTab == nil {
                    selectedPaneID = SettingsNavigationPane.connection.rawValue
                }
            }
            normalizeSelection()
            synchronizeDraft()
            if let target = model.requestedSettingsTab {
                selectRequestedPane(target)
                model.requestedSettingsTab = nil
            }
            reportWindowTitle()
        }
        .onChange(of: selectedPaneID) { _ in
            normalizeSelection()
        }
        .onChange(of: model.requestedSettingsTab) { target in
            if let target {
                selectRequestedPane(target)
                model.requestedSettingsTab = nil
            }
        }
        .onChange(of: model.connectionContextID) { _ in
            syncState = SettingsDraftSyncState()
            synchronizeDraft(force: true)
            selectedPaneID = model.settings == nil ? "connection" : "general"
        }
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
        .onChange(of: model.needsSetup) { _ in
            normalizeSelection()
        }
        .onChange(of: model.isRemoteClient) { _ in
            normalizeSelection()
        }
        .onChange(of: model.interfaceLocalePreference) { _ in reportWindowTitle() }
        .alert("macos.settingsconflict", isPresented: Binding(
            get: { model.settingsConflictMessage != nil },
            set: { if !$0 { model.settingsConflictMessage = nil } }
        )) {
            Button("macos.ok", role: .cancel) {}
        } message: {
            Text(model.settingsConflictMessage ?? "")
        }
        .confirmationDialog(
            "macos.discardyourcurrenteditsandloadthelatest",
            isPresented: $showDiscardDraftConfirmation
        ) {
            Button("macos.discardedits", role: .destructive) {
                model.cancelPendingSettingsAutosave()
                synchronizeDraft(force: true)
                model.restorePersistedInterfaceLocale()
            }
        }
    }

    private var availablePanes: [SettingsNavigationPane] {
        SettingsNavigationPane.allCases.filter {
            $0.isAvailable(
                isRemoteClient: model.isRemoteClient,
                hasSettings: model.settings != nil,
                needsSetup: model.needsSetup
            )
        }
    }

    private var selectedPane: SettingsNavigationPane {
        SettingsNavigationPane.resolved(
            rawValue: selectedPaneID,
            available: availablePanes,
            needsSetup: model.needsSetup
        )
    }

    private var selection: Binding<SettingsNavigationPane?> {
        Binding(
            get: { selectedPane },
            set: { pane in
                guard let pane else { return }
                selectedPaneID = pane.rawValue
            }
        )
    }

    private var settingsSidebarIdentity: String {
        let destinations = availablePanes.map(\.rawValue).joined(separator: ",")
        return "\(model.interfaceLocaleIdentifier):\(destinations)"
    }

    private var searchResults: [SettingsSearchTarget] {
        SettingsSearchIndex.results(
            query: searchQuery,
            locale: model.interfaceLocale,
            availablePanes: availablePanes,
            isRemoteClient: model.isRemoteClient,
            hasSettings: model.settings != nil,
            needsSetup: model.needsSetup
        )
    }

    private var settingsSidebar: some View {
        VStack(spacing: 0) {
            SettingsSidebarSearchField(
                text: $searchQuery,
                placeholder: BridgeAppLocalization.string(
                    "macos.settings.searchPrompt",
                    locale: model.interfaceLocale
                )
            )
            .frame(height: 28)
            .padding(.horizontal, 10)
            .padding(.top, 10)
            .padding(.bottom, 6)

            ScrollViewReader { scrollProxy in
                List(selection: selection) {
                    Section {
                        if searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            ForEach(availablePanes) { pane in
                                HStack(spacing: 8) {
                                    Label(
                                        BridgeAppLocalization.string(
                                            pane.titleKey,
                                            locale: model.interfaceLocale
                                        ),
                                        systemImage: pane.symbol
                                    )
                                    Spacer(minLength: 4)
                                    if pane == .connection,
                                       model.health == .attention || model.health == .unavailable {
                                        Image(systemName: "exclamationmark.circle.fill")
                                            .foregroundStyle(model.health == .unavailable ? .red : .orange)
                                            .accessibilityHidden(true)
                                    }
                                }
                                .id("settings-pane-\(pane.rawValue)")
                                .tag(pane)
                                .accessibilityAddTraits(selectedPane == pane ? [.isSelected] : [])
                            }
                        } else if searchResults.isEmpty {
                            Label(
                                "macos.settings.noSearchResults",
                                systemImage: "magnifyingglass"
                            )
                            .foregroundStyle(.secondary)
                            .listRowSeparator(.hidden)
                        } else {
                            ForEach(searchResults) { target in
                                Button {
                                    selectSearchResult(target)
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: target.pane.symbol)
                                            .foregroundStyle(Color.accentColor)
                                            .frame(width: 18)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(BridgeAppLocalization.string(
                                                target.titleKey,
                                                locale: model.interfaceLocale
                                            ))
                                                .lineLimit(2)
                                            Text(BridgeAppLocalization.string(
                                                target.pane.titleKey,
                                                locale: model.interfaceLocale
                                            ))
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer(minLength: 0)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint(BridgeAppLocalization.string(
                                    target.pane.descriptionKey,
                                    locale: model.interfaceLocale
                                ))
                            }
                        }
                    }
                    .id("settings-sidebar-top")
                }
                .listStyle(.sidebar)
                .onAppear {
                    scrollProxy.scrollTo("settings-sidebar-top", anchor: .top)
                }
                .onChange(of: settingsSidebarIdentity) { _ in
                    scrollProxy.scrollTo("settings-sidebar-top", anchor: .top)
                }
            }
            Divider()
            settingsConnectionStatusCard
                .padding(10)
        }
    }

    private var settingsConnectionStatusCard: some View {
        Button {
            searchQuery = ""
            selectedPaneID = SettingsNavigationPane.connection.rawValue
        } label: {
            HStack(spacing: 9) {
                Image(systemName: model.isRemoteClient ? "network" : "desktopcomputer")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.connectionTargetName)
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                    Text(model.health.accessibilityLabel(locale: model.interfaceLocale))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Circle()
                    .fill(settingsHealthColor)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .help(BridgeAppLocalization.string(
            SettingsNavigationPane.connection.titleKey,
            locale: model.interfaceLocale
        ))
        .accessibilityLabel(BridgeAppLocalization.format(
            "macos.format.dotSeparatedPair",
            locale: model.interfaceLocale,
            model.connectionTargetName,
            model.health.accessibilityLabel(locale: model.interfaceLocale)
        ))
    }

    private var settingsHealthColor: Color {
        switch model.health {
        case .healthy: return .green
        case .checking: return .blue
        case .attention: return .orange
        case .unavailable: return .red
        }
    }

    private var settingsDetail: some View {
        VStack(spacing: 0) {
            SettingsPaneHeader(pane: selectedPane)
                .environmentObject(model)
            Divider()
            VStack(spacing: 8) {
                RuntimeLifecycleNoticeView()
                if syncState.externalChangeDetected {
                    HStack(spacing: 10) {
                        Label(
                            "macos.settingschangedelsewheresoautomaticsavingpausedreview",
                            systemImage: "arrow.triangle.2.circlepath"
                        )
                        .font(.caption)
                        .foregroundStyle(.orange)
                        Spacer()
                        Button("macos.reloadlatestvalues") {
                            showDiscardDraftConfirmation = true
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 8)
                }
            }
            GeometryReader { geometry in
                paneContent
                    .id("\(selectedPane.rawValue):\(model.interfaceLocaleIdentifier)")
                    .frame(width: geometry.size.width, height: geometry.size.height)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder
    private var paneContent: some View {
        switch selectedPane {
        case .general:
            AppGeneralSettingsPane(
                snapshot: model.settings,
                draft: syncState.draft.map { binding(for: $0) },
                didReset: resetDraftAfterDefaults,
                searchRequest: searchRequest
            )
            .environmentObject(model)
        case .modelExecution:
            if let snapshot = model.settings, let draft = syncState.draft {
                ModelExecutionSettingsPane(
                    snapshot: snapshot,
                    draft: binding(for: draft),
                    didReset: resetDraftAfterDefaults,
                    searchRequest: searchRequest
                )
                .environmentObject(model)
            } else {
                SettingsConnectionUnavailablePane()
                    .environmentObject(model)
            }
        case .projects:
            if let snapshot = model.settings {
                ProjectsSettingsPane(
                    snapshot: snapshot,
                    usesRemotePaths: model.isRemoteClient,
                    searchRequest: searchRequest
                )
                .environmentObject(model)
            } else {
                SettingsConnectionUnavailablePane()
                    .environmentObject(model)
            }
        case .codex:
            CodexRuntimeSettingsPane(
                isSelected: selectedPane == .codex,
                searchRequest: searchRequest
            )
                .environmentObject(model)
        case .connection:
            if model.needsSetup {
                ConnectionSetupSettingsPane()
                    .id(SettingsSearchTarget.connectionSetup.anchorID)
                    .environmentObject(model)
            } else {
                ConnectionSettingsPane(searchRequest: searchRequest)
                    .environmentObject(model)
            }
        case .server:
            if let snapshot = model.settings {
                RuntimeStatusPane(snapshot: snapshot, searchRequest: searchRequest)
                    .environmentObject(model)
            } else {
                SettingsConnectionUnavailablePane()
                    .environmentObject(model)
            }
        }
    }

    private func synchronizeDraft(force: Bool = false) {
        guard let snapshot = model.settings else { return }
        syncState.synchronize(with: snapshot, force: force)
    }

    private func resetDraftAfterDefaults() {
        synchronizeDraft(force: true)
        model.restorePersistedInterfaceLocale()
    }

    private func normalizeSelection() {
        let normalized = selectedPane.rawValue
        if selectedPaneID != normalized { selectedPaneID = normalized }
    }

    private func selectRequestedPane(_ request: String) {
        selectedPaneID = SettingsNavigationPane.resolved(
            rawValue: request,
            available: availablePanes,
            needsSetup: model.needsSetup
        ).rawValue
    }

    private func selectSearchResult(_ target: SettingsSearchTarget) {
        selectedPaneID = target.pane.rawValue
        searchRequest = SettingsSearchRequest(target: target)
    }

    private func reportWindowTitle() {
        onWindowTitleChange?(BridgeAppLocalization.string(
            "macos.settings",
            locale: model.interfaceLocale
        ))
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

private struct SettingsSidebarSearchField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    func makeNSView(context: Context) -> NSSearchField {
        let searchField = NSSearchField(frame: .zero)
        searchField.identifier = NSUserInterfaceItemIdentifier("settings-search-field")
        searchField.sendsSearchStringImmediately = true
        searchField.delegate = context.coordinator
        searchField.placeholderString = placeholder
        searchField.setAccessibilityLabel(placeholder)
        return searchField
    }

    func updateNSView(_ searchField: NSSearchField, context: Context) {
        context.coordinator.text = $text
        if searchField.stringValue != text {
            searchField.stringValue = text
        }
        searchField.placeholderString = placeholder
        searchField.setAccessibilityLabel(placeholder)
    }

    final class Coordinator: NSObject, NSSearchFieldDelegate {
        var text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let searchField = notification.object as? NSSearchField else { return }
            if text.wrappedValue != searchField.stringValue {
                text.wrappedValue = searchField.stringValue
            }
        }
    }
}

private struct SettingsDefaultSidebarToolbarRemovalModifier: ViewModifier {
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
private final class SettingsSidebarAccessoryHostView: NSView {
    var onWindowChange: ((NSWindow?) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onWindowChange?(window)
    }
}

private struct SettingsSidebarToggleAccessory: NSViewRepresentable {
    @Environment(\.locale) private var locale
    @Binding var columnVisibility: NavigationSplitViewVisibility

    func makeCoordinator() -> Coordinator {
        Coordinator(columnVisibility: $columnVisibility, locale: locale)
    }

    func makeNSView(context: Context) -> SettingsSidebarAccessoryHostView {
        let view = SettingsSidebarAccessoryHostView(frame: .zero)
        view.onWindowChange = { [weak coordinator = context.coordinator] window in
            coordinator?.install(in: window)
        }
        return view
    }

    func updateNSView(_ nsView: SettingsSidebarAccessoryHostView, context: Context) {
        context.coordinator.update(columnVisibility: $columnVisibility, locale: locale)
        context.coordinator.install(in: nsView.window)
    }

    static func dismantleNSView(
        _ nsView: SettingsSidebarAccessoryHostView,
        coordinator: Coordinator
    ) {
        nsView.onWindowChange = nil
        coordinator.uninstall()
    }

    @MainActor
    final class Coordinator: NSObject {
        private var columnVisibility: Binding<NavigationSplitViewVisibility>
        private var locale: Locale
        private weak var installedWindow: NSWindow?
        private var accessoryController: NSTitlebarAccessoryViewController?
        private weak var button: NSButton?

        init(columnVisibility: Binding<NavigationSplitViewVisibility>, locale: Locale) {
            self.columnVisibility = columnVisibility
            self.locale = locale
        }

        func update(
            columnVisibility: Binding<NavigationSplitViewVisibility>,
            locale: Locale
        ) {
            self.columnVisibility = columnVisibility
            self.locale = locale
            updateButtonPresentation()
        }

        func install(in window: NSWindow?) {
            guard let window else {
                uninstall()
                return
            }
            guard window !== installedWindow || accessoryController == nil else {
                updateButtonPresentation()
                return
            }

            uninstall()

            let button = NSButton(
                image: NSImage(
                    systemSymbolName: "sidebar.left",
                    accessibilityDescription: nil
                ) ?? NSImage(),
                target: self,
                action: #selector(toggleSidebar)
            )
            button.identifier = NSUserInterfaceItemIdentifier("settings-sidebar-toggle")
            button.imagePosition = .imageOnly
            button.bezelStyle = .texturedRounded
            button.controlSize = .regular
            button.keyEquivalent = "s"
            button.keyEquivalentModifierMask = [.command, .control]
            button.translatesAutoresizingMaskIntoConstraints = false

            let accessoryView = NSView(frame: NSRect(x: 0, y: 0, width: 42, height: 28))
            accessoryView.identifier = NSUserInterfaceItemIdentifier(
                "settings-sidebar-toggle-accessory"
            )
            accessoryView.addSubview(button)
            NSLayoutConstraint.activate([
                button.centerXAnchor.constraint(equalTo: accessoryView.centerXAnchor),
                button.centerYAnchor.constraint(equalTo: accessoryView.centerYAnchor),
                button.widthAnchor.constraint(equalToConstant: 32),
                button.heightAnchor.constraint(equalToConstant: 28)
            ])

            let controller = NSTitlebarAccessoryViewController()
            controller.layoutAttribute = .leading
            controller.view = accessoryView
            window.addTitlebarAccessoryViewController(controller)

            installedWindow = window
            accessoryController = controller
            self.button = button
            updateButtonPresentation()
        }

        func uninstall() {
            if let window = installedWindow,
               let accessoryController,
               let index = window.titlebarAccessoryViewControllers.firstIndex(where: {
                   $0 === accessoryController
               }) {
                window.removeTitlebarAccessoryViewController(at: index)
            }
            installedWindow = nil
            accessoryController = nil
            button = nil
        }

        @objc private func toggleSidebar() {
            withAnimation(.easeInOut(duration: 0.2)) {
                columnVisibility.wrappedValue = sidebarIsHidden ? .all : .detailOnly
            }
            updateButtonPresentation()
        }

        private var sidebarIsHidden: Bool {
            columnVisibility.wrappedValue == .detailOnly
        }

        private func updateButtonPresentation() {
            let label = BridgeAppLocalization.string(
                sidebarIsHidden
                    ? "macos.settings.showSidebar"
                    : "macos.settings.hideSidebar",
                locale: locale
            )
            button?.toolTip = label
            button?.setAccessibilityLabel(label)
        }
    }
}

@MainActor
private final class SettingsToolbarCleanupNSView: NSView {
    private weak var observedToolbar: NSToolbar?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observeToolbarIfNeeded()
        scheduleCleanup()
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

    func scheduleCleanup() {
        Task { @MainActor [weak self] in
            self?.observeToolbarIfNeeded()
            self?.removeAutomaticSidebarToggle()
            for delay in [50_000_000, 150_000_000, 400_000_000] as [UInt64] {
                try? await Task.sleep(nanoseconds: delay)
                self?.observeToolbarIfNeeded()
                self?.removeAutomaticSidebarToggle()
            }
        }
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
        Task { @MainActor [weak self] in
            await Task.yield()
            self?.removeAutomaticSidebarToggle()
        }
    }

    private func removeAutomaticSidebarToggle() {
        guard let toolbar = window?.toolbar else { return }
        let indexes = toolbar.items.indices.filter { index in
            toolbar.items[index].itemIdentifier.rawValue.contains(
                "navigationSplitView.toggleSidebar"
            )
        }
        for index in indexes.reversed() {
            toolbar.removeItem(at: index)
        }
    }
}

private struct SettingsToolbarCleanupView: NSViewRepresentable {
    func makeNSView(context: Context) -> SettingsToolbarCleanupNSView {
        SettingsToolbarCleanupNSView(frame: .zero)
    }

    func updateNSView(_ nsView: SettingsToolbarCleanupNSView, context: Context) {
        nsView.scheduleCleanup()
    }
}

private struct SettingsPaneHeader: View {
    @EnvironmentObject private var model: AppModel
    let pane: SettingsNavigationPane

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: pane.symbol)
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 3) {
                Text(BridgeAppLocalization.string(pane.titleKey, locale: model.interfaceLocale))
                    .font(.title2.bold())
                Text(BridgeAppLocalization.string(pane.descriptionKey, locale: model.interfaceLocale))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ConnectionSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let searchRequest: SettingsSearchRequest?
    @State private var showRemoteModeConfirmation = false
    @State private var showRemoteConnectionSheet = false
    @State private var confirmRemoteModeAfterSheet = false
    @State private var showDisableRemoteConnectionConfirmation = false
    @State private var profileDeletionTarget: RemoteServerProfile?
    @State private var deviceRevocationTarget: RemoteManagementDevice?
    @State private var activeProfileName = ""
    @State private var hostedEndpoint = detectedRemoteManagementEndpoint()
    @State private var hostedDisplayName = Host.current().localizedName ?? "Codex MCP Bridge"
    @State private var pairingInvitationCopied = false
    @State private var advancedConnectionSettingsExpanded = false

    var body: some View {
        SettingsSearchScrollContainer(request: searchRequest, pane: .connection) {
            Form {
                Section("macos.approle") {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: model.isRemoteClient ? "network" : "desktopcomputer")
                            .font(.title2)
                            .foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(BridgeAppLocalization.string(
                                model.isRemoteClient ? "macos.connecttoexistingserver" : "macos.runserveronthismac",
                                locale: model.interfaceLocale
                            ))
                                .font(.headline)
                            Text(BridgeAppLocalization.string(
                                model.isRemoteClient
                                    ? "macos.thisappusesonlytheselectedservers"
                                    : "macos.thismacownsandrunsthehelperbridge",
                                locale: model.interfaceLocale
                            ))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if model.isRemoteClient {
                            Button("macos.runonthismac") {
                                Task { await model.setConnectionMode(.localHost) }
                            }
                        } else {
                            Button("macos.connecttoexistingserver") {
                                showRemoteConnectionSheet = true
                            }
                        }
                    }
                }
                .id(SettingsSearchTarget.connectionRole.anchorID)

                if model.isRemoteClient {
                    remoteClientSections
                } else {
                    hostedServerSections
                }
            }
            .formStyle(.grouped)
        }
        .onAppear {
            synchronizeProfileName()
            guard !model.isRemoteClient else { return }
            Task {
                await model.refreshRemoteManagementStatus()
                synchronizeHostedFields()
            }
        }
        .onChange(of: model.connectionPreferences.activeServerId) { _ in
            synchronizeProfileName()
        }
        .onChange(of: model.remoteManagementStatus) { _ in
            synchronizeHostedFields()
        }
        .onChange(of: model.remotePairingInvitation) { invitation in
            if invitation == nil { pairingInvitationCopied = false }
        }
        .onChange(of: model.bridgeConnected) { connected in
            guard connected, !model.isRemoteClient else { return }
            Task { await model.refreshRemoteManagementStatus() }
        }
        .sheet(
            isPresented: $showRemoteConnectionSheet,
            onDismiss: {
                guard confirmRemoteModeAfterSheet else { return }
                confirmRemoteModeAfterSheet = false
                showRemoteModeConfirmation = true
            }
        ) {
            RemoteServerConnectionSheet { shouldSwitchMode in
                confirmRemoteModeAfterSheet = shouldSwitchMode
                showRemoteConnectionSheet = false
            }
            .environmentObject(model)
        }
        .confirmationDialog(
            "macos.switchtoremoteclientmode",
            isPresented: $showRemoteModeConfirmation
        ) {
            Button("macos.switchtoremotemodeafterfinishingwork") {
                Task { await model.setConnectionMode(.remoteClient) }
            }
            Button("macos.forcestopandswitch", role: .destructive) {
                Task { await model.setConnectionMode(.remoteClient, force: true) }
            }
            Button("common.cancel", role: .cancel) {}
        } message: {
            Text("macos.theserverandtunnelrunningonthismac")
        }
        .confirmationDialog(
            "macos.remoteConnections.turnOffConfirmation",
            isPresented: $showDisableRemoteConnectionConfirmation
        ) {
            Button("macos.turnoffconnectionsfromothermacs", role: .destructive) {
                Task {
                    await model.configureRemoteManagement(
                        enabled: false,
                        endpoint: hostedEndpoint,
                        displayName: hostedDisplayName
                    )
                }
            }
            Button("common.cancel", role: .cancel) {}
        } message: {
            Text("macos.registereddevicesarekeptbuttheycannotconnect")
        }
        .confirmationDialog(
            "macos.deletethesavedserverfromthismac",
            isPresented: Binding(
                get: { profileDeletionTarget != nil },
                set: { if !$0 { profileDeletionTarget = nil } }
            ),
            presenting: profileDeletionTarget
        ) { profile in
            Button("macos.deleteserverprofileandcredentials", role: .destructive) {
                Task {
                    if await model.removeRemoteServer(profile.serverId) {
                        profileDeletionTarget = nil
                    }
                }
            }
        } message: { profile in
            Text(BridgeAppLocalization.format(
                "macos.thisdoesnotchangetheserveritselfor",
                locale: model.interfaceLocale,
                profile.name
            ))
        }
        .confirmationDialog(
            "macos.revokethisdevicesremoteaccess",
            isPresented: Binding(
                get: { deviceRevocationTarget != nil },
                set: { if !$0 { deviceRevocationTarget = nil } }
            ),
            presenting: deviceRevocationTarget
        ) { device in
            Button("macos.revokeaccess", role: .destructive) {
                Task {
                    if await model.revokeRemoteDevice(device.id) {
                        deviceRevocationTarget = nil
                    }
                }
            }
        } message: { device in
            Text(BridgeAppLocalization.format(
                "macos.thecredentialsforwillstopworkingimmediately",
                locale: model.interfaceLocale,
                device.name
            ))
        }
    }

    @ViewBuilder
    private var remoteClientSections: some View {
        Section("macos.activeserver") {
            if model.connectionPreferences.profiles.isEmpty {
                Label("macos.noserversaresavedenterapairinginvitation", systemImage: "server.rack")
                    .foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("macos.pairnewserver") {
                        showRemoteConnectionSheet = true
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isBusy)
                }
            } else {
                ForEach(model.connectionPreferences.profiles) { profile in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(profile.name).font(.headline)
                                if profile.serverId == model.connectionPreferences.activeServerId {
                                    Text("agent.active").font(.caption2).padding(4).background(.quaternary, in: Capsule())
                                }
                            }
                            Text(profile.endpoint)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                            Text(BridgeAppLocalization.format(
                                "macos.serverid",
                                locale: model.interfaceLocale,
                                profile.serverId
                            ))
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        if profile.serverId != model.connectionPreferences.activeServerId {
                            Button("macos.switch") {
                                Task { await model.activateRemoteServer(profile.serverId) }
                            }
                        }
                        Button(role: .destructive) {
                            profileDeletionTarget = profile
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                    }
                }
                HStack {
                    Spacer()
                    Button("macos.pairnewserver") {
                        showRemoteConnectionSheet = true
                    }
                    .disabled(model.isBusy)
                }
            }
            if let profile = model.activeRemoteProfile {
                HStack {
                    TextField("macos.activeserverdisplayname", text: $activeProfileName)
                    Button("macos.savename") {
                        _ = model.renameRemoteServer(profile.serverId, name: activeProfileName)
                    }
                    .disabled(activeProfileName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if let hello = model.remoteHello {
                Label(
                    BridgeAppLocalization.format(
                        "macos.bridgeconnected",
                        locale: model.interfaceLocale,
                        hello.server.displayName,
                        hello.bridge.version
                    ),
                    systemImage: "checkmark.circle.fill"
                )
                .foregroundStyle(.green)
            } else if model.activeRemoteProfile != nil {
                Label("macos.notconnectedtotheselectedserver", systemImage: "network.slash")
                    .foregroundStyle(.orange)
                Button("macos.reconnect") { Task { await model.refreshAll() } }
            }
        }
        .id(SettingsSearchTarget.connectionActiveServer.anchorID)

        if let error = model.connectionErrorMessage {
            Section("macos.connectionerror") {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private var hostedServerSections: some View {
        Section("macos.managethisserverfromanothermac") {
            Text("macos.thismacsnameandconnectionaddressare")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("macos.servernameshownonotherdevices", text: $hostedDisplayName)
            HStack {
                if let status = model.remoteManagementStatus {
                    Label(
                        remoteManagementStatusText(status),
                        systemImage: status.listening ? "lock.shield.fill" : "lock.slash"
                    )
                    .foregroundStyle(status.listening ? .green : status.enabled ? .orange : .secondary)
                }
                Spacer()
                Button {
                    Task {
                        await model.configureRemoteManagement(
                            enabled: true,
                            endpoint: hostedEndpoint,
                            displayName: hostedDisplayName
                        )
                    }
                } label: {
                    Text(remoteManagementActionTitle)
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    hostedEndpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        hostedDisplayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        model.isBusy
                )
                if model.remoteManagementStatus?.enabled == true {
                    Button("macos.turnoffconnections", role: .destructive) {
                        showDisableRemoteConnectionConfirmation = true
                    }
                    .disabled(model.isBusy)
                }
            }
            FullRowDisclosure(
                "macos.advancedconnectionsettings",
                isExpanded: $advancedConnectionSettingsExpanded
            ) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("macos.thisaddresswasdetectedautomaticallychangeitonly")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text("macos.httpsaddress")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 76, alignment: .leading)
                        TextField(text: $hostedEndpoint) {
                            EmptyView()
                        }
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity)
                    }
                    if let status = model.remoteManagementStatus {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(BridgeAppLocalization.format(
                                "macos.connection.serverIdLabeled",
                                locale: model.interfaceLocale,
                                status.serverId
                            ))
                            if let fingerprint = status.certificateSha256 {
                                Text(BridgeAppLocalization.format(
                                    "macos.certificatesha256",
                                    locale: model.interfaceLocale,
                                    fingerprint
                                ))
                            }
                        }
                        .font(.caption2.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            if let error = model.remoteManagementErrorMessage ??
                model.remoteManagementStatusErrorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .id(SettingsSearchTarget.connectionRemoteManagement.anchorID)

        if model.remoteManagementStatus?.listening == true {
            Section("macos.devicepairing") {
                Text("macos.createsaonetimeinvitationtopasteinto")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("macos.createandcopyanewpairinginvitationvalid") {
                    pairingInvitationCopied = false
                    Task {
                        if await model.beginRemotePairing(),
                           let pairing = model.remotePairingInvitation {
                            copyToPasteboard(pairing.invitation)
                            pairingInvitationCopied = true
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
                if let pairing = model.remotePairingInvitation {
                    if pairingInvitationCopied {
                        Label("macos.pairinginvitationcopiedtotheclipboard", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                    HStack {
                        Text(BridgeAppLocalization.format(
                            "macos.usableonceuntil",
                            locale: model.interfaceLocale,
                            DisplayFormat.dateTime(pairing.expiresAt, locale: model.interfaceLocale)
                        ))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("macos.copyinvitation") {
                            copyToPasteboard(pairing.invitation)
                            pairingInvitationCopied = true
                        }
                    }
                }
            }

            Section("macos.registereddevices") {
                if model.remoteManagementStatus?.devices.isEmpty != false {
                    Text("macos.therearenoregisteredremotedevices")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.remoteManagementStatus?.devices ?? []) { device in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.name).font(.headline)
                            Text(device.lastSeenAt.map {
                                BridgeAppLocalization.format(
                                    "macos.lastconnected",
                                    locale: model.interfaceLocale,
                                    $0
                                )
                            } ?? BridgeAppLocalization.string(
                                "macos.neverconnected",
                                locale: model.interfaceLocale
                            ))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("macos.revoke", role: .destructive) {
                            deviceRevocationTarget = device
                        }
                    }
                }
            }
        }
    }

    private func synchronizeProfileName() {
        activeProfileName = model.activeRemoteProfile?.name ?? ""
    }

    private func remoteManagementStatusText(_ status: RemoteManagementStatus) -> String {
        if status.listening {
            return BridgeAppLocalization.string(
                "macos.readyforconnections",
                locale: model.interfaceLocale
            )
        }
        if status.enabled {
            return BridgeAppLocalization.string("macos.failedtostart", locale: model.interfaceLocale)
        }
        return BridgeAppLocalization.string("macos.off", locale: model.interfaceLocale)
    }

    private var remoteManagementActionTitle: String {
        if model.remoteManagementStatus?.listening == true {
            return BridgeAppLocalization.string("macos.savesettings", locale: model.interfaceLocale)
        }
        if model.remoteManagementStatus?.enabled == true {
            return BridgeAppLocalization.string("macos.restart", locale: model.interfaceLocale)
        }
        return BridgeAppLocalization.string("macos.turnonconnectionsfromothermacs", locale: model.interfaceLocale)
    }

    private func synchronizeHostedFields() {
        let detectedEndpoint = detectedRemoteManagementEndpoint()
        if let status = model.remoteManagementStatus {
            hostedEndpoint = status.endpoint ?? detectedEndpoint
            if status.endpoint != nil || status.enabled {
                hostedDisplayName = status.displayName
            }
        } else if hostedEndpoint.isEmpty {
            hostedEndpoint = detectedEndpoint
        }
    }

    private func copyToPasteboard(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}

private struct RemoteServerConnectionSheet: View {
    @EnvironmentObject private var model: AppModel
    let onComplete: (Bool) -> Void
    @State private var invitation = ""
    @State private var profileName = ""
    @State private var deviceName = Host.current().localizedName ?? "Mac"
    @State private var selectedServerId = ""
    @State private var optionalFieldsExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.isRemoteClient ? "macos.pairnewserver" : "macos.connecttoexistingserver")
                        .font(.title2.bold())
                    Text("macos.thepairinginvitationcopiedfromtheserververifies")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(20)

            Divider()

            Form {
                if !model.isRemoteClient, !model.connectionPreferences.profiles.isEmpty {
                    Section("macos.useasavedserver") {
                        Picker("macos.server", selection: $selectedServerId) {
                            ForEach(model.connectionPreferences.profiles) { profile in
                                Text(profile.name).tag(profile.serverId)
                            }
                        }
                        HStack {
                            Spacer()
                            Button("macos.connecttoselectedserver") {
                                if model.prepareRemoteServerForModeSwitch(selectedServerId) {
                                    onComplete(true)
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(selectedServerId.isEmpty || model.isBusy)
                        }
                    }
                }

                Section("macos.pairnewserver") {
                    Text("macos.ontheservermacclickcreateandcopy")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $invitation)
                        .font(.caption.monospaced())
                        .frame(minHeight: 76)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                    HStack {
                        Button("macos.pastefromclipboard") {
                            if let copied = NSPasteboard.general.string(forType: .string) {
                                invitation = copied.trimmingCharacters(in: .whitespacesAndNewlines)
                            }
                        }
                        Spacer()
                    }
                    TextField("macos.nameofthisdeviceshownontheserver", text: $deviceName)
                    FullRowDisclosure("macos.optional", isExpanded: $optionalFieldsExpanded) {
                        TextField("macos.servernametosaveoptional", text: $profileName)
                    }
                    HStack {
                        Spacer()
                        Button(model.isRemoteClient ? "macos.pairandactivate" : "macos.verifyandregisterserver") {
                            let shouldSwitchMode = !model.isRemoteClient
                            Task {
                                if await model.pairRemoteServer(
                                    invitation: invitation,
                                    profileName: profileName,
                                    deviceName: deviceName
                                ) {
                                    onComplete(shouldSwitchMode)
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(
                            invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                model.isBusy
                        )
                    }
                    Text("macos.devicecredentialsarestoredonlyinthemacos")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if let error = model.connectionErrorMessage {
                    Section("macos.connectionerror") {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                Spacer()
                Button("common.cancel") { onComplete(false) }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(16)
        }
        .frame(width: 540, height: model.isRemoteClient ? 480 : 590)
        .environment(\.locale, model.interfaceLocale)
        .onAppear {
            selectedServerId = model.connectionPreferences.activeServerId ??
                model.connectionPreferences.profiles.first?.serverId ?? ""
        }
    }
}

private struct SettingsConnectionUnavailablePane: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 12) {
            if !model.bridgeConnected, model.isBridgeConnectionChecking {
                ProgressView("macos.checkingthebridgeconnection")
                    .controlSize(.small)
            } else if model.isRemoteClient {
                BridgeBrandStatusIcon(health: .unavailable, size: 44)
                if model.activeRemoteProfile == nil {
                    Text("macos.pairaserverintheconnectiontab")
                        .font(.headline)
                    Text("macos.remotemodedoesnotstartthehelperor")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("macos.couldnotloadtheremoteserversettings")
                        .font(.headline)
                    if let error = model.connectionErrorMessage ??
                        model.statusErrorMessage ?? model.settingsLoadErrorMessage {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                    Button("macos.reconnect") { Task { await model.refreshAll() } }
                        .buttonStyle(.borderedProminent)
                }
            } else if !model.bridgeConnected {
                BridgeBrandStatusIcon(health: .unavailable, size: 44)
                Text("macos.startthebridgeserveronthismacto")
                Button("macos.startserver") { Task { await model.startRuntime() } }
                    .buttonStyle(.borderedProminent)
                if let error = model.runtimeErrorMessage ?? model.statusErrorMessage {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            } else if model.settingsLoadErrorMessage != nil {
                BridgeBrandStatusIcon(health: .attention, size: 44)
                Text("macos.settingscouldnotbeloaded").font(.headline)
                Text("macos.logininformationconversationhistoryprojectsandbridgesettings")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("macos.tryagain") { Task { await model.refreshSettings() } }
            } else {
                ProgressView("macos.loadingsettings")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(30)
    }
}

private struct AppGeneralSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot?
    let draft: Binding<SettingsDraft>?
    let didReset: () -> Void
    let searchRequest: SettingsSearchRequest?
    @State private var showResetConfirmation = false

    var body: some View {
        SettingsSearchScrollContainer(request: searchRequest, pane: .general) {
            Form {
                if let snapshot, let draft {
                    Section("macos.displayandexecution") {
                    Picker("macos.appandcardlanguage", selection: draft.uiLocalePreference) {
                        ForEach(snapshot.capabilities.availableUiLocalePreferences, id: \.self) {
                            Text(localeLabel($0, locale: model.interfaceLocale)).tag($0)
                        }
                    }
                    Text("macos.withautomaticthemacosappfollowsyourmac")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Toggle(
                        "macos.keepnewagenttasksinthecodexapp",
                        isOn: draft.showBridgeThreadsInCodexApp
                    )
                    Text("macos.whenenablednewtasksandfreshcontextsare")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Toggle(
                        "settings.dashboardAutoOpenBackground",
                        isOn: draft.dashboardAutoOpenBackground
                    )
                    Text("settings.dashboardAutoOpenBackgroundHint")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if model.isRemoteClient {
                        Label(
                            "macos.completionnotificationsaresentbythemenubar",
                            systemImage: "bell.badge"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    } else {
                        Toggle(
                            "settings.completionFollowUp",
                            isOn: draft.completionFollowUp
                        )
                        Text("macos.whenworkcompletesthemenubarappon")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    }
                    .id(SettingsSearchTarget.generalLanguage.anchorID)
                } else {
                    Section {
                        Label(
                            "macos.settings.sharedSettingsAvailableAfterConnection",
                            systemImage: "network"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }

                Section("macos.thismacsappsettings") {
                Toggle(
                    "macos.notifyaboutbridgeproblems",
                    isOn: $model.bridgeProblemNotificationsEnabled
                )
                Toggle(
                    "macos.securityandconnectionapprovalnotifications",
                    isOn: $model.securityNotificationsEnabled
                )
                HStack {
                    switch model.notificationPermission {
                    case .authorized:
                        Label("macos.macosnotificationsallowed", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Spacer()
                        Button("macos.openmacosnotificationsettings") {
                            model.openNotificationSettings()
                        }
                    case .denied:
                        Label("macos.macosnotificationsaredisabled", systemImage: "bell.slash")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("macos.openmacosnotificationsettings") {
                            model.openNotificationSettings()
                        }
                    case .notDetermined:
                        Button("macos.checkmacosnotificationpermission") {
                            Task { await model.requestNotificationAuthorization() }
                        }
                        .disabled(model.notificationAuthorizationInProgress)
                    case .unknown:
                        Text("macos.checkingnotificationpermission")
                            .foregroundStyle(.secondary)
                    }
                }
                Text("macos.notificationsfollowmacossettingsandfocusconnectionproblems")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Toggle(
                    "macos.launchmenubarappatlogin",
                    isOn: Binding(
                        get: { model.menuBarLoginItemStatus.isEnabled },
                        set: { model.setMenuBarLaunchAtLogin($0) }
                    )
                )
                .disabled(model.loginItemOperationInProgress)

                Text(BridgeAppLocalization.string(
                    model.isRemoteClient
                        ? "macos.thisappusesonlytheselectedservers"
                        : "macos.appliesimmediatelyonthismacturningitoff",
                    locale: model.interfaceLocale
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                switch model.menuBarLoginItemStatus {
                case .enabled:
                    Label("macos.themenubarappwillopenautomaticallyat", systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case .requiresApproval:
                    Label(
                        "macos.macosapprovalisrequiredforthisloginitem",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                    Button("macos.openloginitemsettings") {
                        model.openLoginItemsSystemSettings()
                    }
                case .notFound:
                    Label("macos.theloginitemcouldnotbefoundin", systemImage: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                case .unknown:
                    Label("macos.theloginitemstatuscouldnotbedetermined", systemImage: "questionmark.circle")
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
                .id(SettingsSearchTarget.generalNotifications.anchorID)

                if let error = model.settingsErrorMessage ?? model.settingsLoadErrorMessage {
                    Section("macos.saveerror") {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                }

                if draft != nil {
                    Section {
                        HStack {
                            Button("macos.resetgeneralsettings", role: .destructive) {
                                model.cancelPendingSettingsAutosave()
                                showResetConfirmation = true
                            }
                            .disabled(model.isBusy || model.generalSettingsSaveState.isActive)
                            Spacer()
                            SettingsAutosaveStatusView()
                                .environmentObject(model)
                        }
                    }
                }
            }
            .formStyle(.grouped)
        }
        .onAppear {
            Task { await model.refreshNotificationPermission() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await model.refreshNotificationPermission() }
        }
        .confirmationDialog(
            "macos.resetgeneralsettingstotheoperatordefaults",
            isPresented: $showResetConfirmation
        ) {
            Button("macos.resetgeneralsettings", role: .destructive) {
                Task {
                    if await model.resetGeneralSettings() { didReset() }
                }
            }
        }
    }
}

private struct SettingsAutosaveStatusView: View {
    @EnvironmentObject private var model: AppModel

    @ViewBuilder
    var body: some View {
        switch model.generalSettingsSaveState {
        case .idle:
            Text("macos.changessaveautomatically")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .pending:
            Label("macos.waitingtosave", systemImage: "ellipsis")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .saving:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("settings.saving")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        case .saved:
            Label("macos.saved", systemImage: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .failed:
            Label("macos.couldnotsave", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
        }
    }
}

private struct ModelExecutionSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot
    @Binding var draft: SettingsDraft
    let didReset: () -> Void
    let searchRequest: SettingsSearchRequest?
    @State private var showResetConfirmation = false
    @State private var allowedModelsExpanded = false
    @State private var expandedModelIDs = Set<String>()

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
        SettingsSearchScrollContainer(request: searchRequest, pane: .modelExecution) {
            Form {
                Section {
                Label(
                    "macos.thesesettingsaresharedbyeveryconversationusing",
                    systemImage: "person.2"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

                Section("macos.access") {
                Picker("macos.accessstrategy", selection: $draft.accessStrategy) {
                    ForEach(snapshot.capabilities.availableAccessStrategies, id: \.self) {
                        Text(accessLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                Text(accessDescription(draft.accessStrategy, locale: model.interfaceLocale))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("macos.thisisthedefaultaccessleveleachtask")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if draft.accessStrategy == "always-full" {
                    Label(
                        BridgeAppLocalization.string(
                            snapshot.capabilities.allowDangerFullAccess
                                ? "macos.fullaccessrunscodexwiththismacosuser"
                                : "macos.yourfullaccesspreferenceispreservedbutthe",
                            locale: model.interfaceLocale
                        ),
                        systemImage: "exclamationmark.shield.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                }
                .id(SettingsSearchTarget.modelAccess.anchorID)

                Section("macos.modelpolicy") {
                Picker("macos.selectionmode", selection: policyModeBinding) {
                    Text("settings.modelPolicy.fixed").tag("fixed")
                    Text("settings.language.auto").tag("automatic")
                }
                .pickerStyle(.segmented)

                if draft.policyMode == "fixed" {
                    Picker("settings.model", selection: fixedModelIDBinding) {
                        ForEach(modelIDs, id: \.self) { modelID in
                            Text(modelLabel(modelID)).tag(modelID)
                        }
                    }
                    Picker("macos.reasoningeffort", selection: fixedEffortBinding) {
                        ForEach(choicesForFixedModel, id: \.key) { choice in
                            Text(effortLabel(choice)).tag(choice.reasoningEffort)
                                .disabled(draft.isUltraDisabled(choice))
                        }
                    }
                } else {
                    Picker("macos.automaticallowlist", selection: $draft.allowedKind) {
                        Text("macos.allvisiblecatalogmodels").tag("catalog-visible")
                        Text("macos.selectexplicitly").tag("explicit")
                    }
                    if draft.allowedKind == "explicit" {
                        FullRowDisclosure(
                            "macos.allowedmodelsandreasoningefforts",
                            isExpanded: $allowedModelsExpanded
                        ) {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(modelIDs, id: \.self) { modelID in
                                    FullRowDisclosure(
                                        isExpanded: modelExpansionBinding(modelID),
                                        label: { Text(modelLabel(modelID)) },
                                        content: {
                                            VStack(alignment: .leading, spacing: 5) {
                                                ForEach(choices(for: modelID), id: \.key) { choice in
                                                    Toggle(
                                                        effortLabel(choice),
                                                        isOn: explicitBinding(choice.key)
                                                    )
                                                    .disabled(
                                                        draft.isUltraDisabled(choice) ||
                                                        (!selectableChoiceKeys.contains(choice.key) &&
                                                        !draft.explicitSelectionKeys.contains(choice.key))
                                                    )
                                                }
                                            }
                                            .padding(.leading, 2)
                                        }
                                    )
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }

                Toggle(
                    "settings.allowDelegation",
                    isOn: $draft.allowDelegation
                )
                Text("settings.ultraHint")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if draft.policyMode == "fixed", let choice = selectedFixedChoice, draft.isUltraDisabled(choice) {
                    Text("settings.ultraFixedConflict")
                        .font(.caption)
                        .foregroundStyle(.orange)
                } else if draft.policyMode == "automatic", draft.allowedKind == "explicit",
                          choices.contains(where: { draft.explicitSelectionKeys.contains($0.key) && draft.isUltraDisabled($0) }),
                          draft.explicitSelectionKeys.isDisjoint(with: selectableChoiceKeys) {
                    Text("settings.ultraNoSelection")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Toggle("settings.usePriority", isOn: $draft.usePriorityServiceTier)
                Text("settings.usePriorityHint")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if snapshot.catalog.stale {
                    Label("macos.themodelcatalogisstalesopolicychanges", systemImage: "clock.badge.exclamationmark")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let warning = snapshot.catalog.warning {
                    Text(warning)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                }
                Button("macos.refreshmodels") {
                    Task { await model.refreshSettings(refreshModels: true) }
                }
                .disabled(model.generalSettingsSaveState.isActive)
                }
                .id(SettingsSearchTarget.modelSelection.anchorID)

            if draft.policyMode == "automatic", snapshot.settings.modelDescriptionOverrides != nil {
                ModelDescriptionsSettingsSection(snapshot: snapshot)
                    .id(model.connectionContextID)
            }

                Section("macos.settings.execution") {
                LabeledContent("macos.concurrentagenttasks") {
                    HStack(spacing: 6) {
                        TextField(value: concurrentJobsBinding, format: .number) {
                            EmptyView()
                        }
                        .frame(width: 46)
                        .multilineTextAlignment(.trailing)
                        .textFieldStyle(.roundedBorder)
                        Stepper(value: concurrentJobsBinding, in: 1...snapshot.capabilities.maxConcurrentJobs) {
                            EmptyView()
                        }
                        .labelsHidden()
                    }
                }
                Text(BridgeAppLocalization.format(
                    "macos.enteravaluefrom1totheoperator",
                    locale: model.interfaceLocale,
                    snapshot.capabilities.maxConcurrentJobs
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if draft.maxConcurrentJobs > 30 {
                    Label(
                        "macos.valuesabove30cansubstantiallyincreasecpumemory",
                        systemImage: "gauge.with.dots.needle.67percent"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                }
                .id(SettingsSearchTarget.modelConcurrency.anchorID)

                if let policy = snapshot.historyPolicy, snapshot.settings.historyRetentionDays != nil {
                    Section("history.title") {
                    Picker("history.period", selection: $draft.historyRetentionDays) {
                        Text("macos.history.retention7Days").tag(7)
                        Text("macos.history.retention30Days").tag(30)
                        Text("macos.history.retention90Days").tag(90)
                        Text("history.forever").tag(0)
                    }
                    WorkHistoryPolicyView(policy: policy)
                    }
                    .id(SettingsSearchTarget.modelHistory.anchorID)
                }

                if let error = model.settingsErrorMessage ?? model.settingsLoadErrorMessage {
                    Section("macos.saveerror") {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                    }
                }

                Section {
                    HStack {
                    Button("macos.resetgeneralsettings", role: .destructive) {
                        model.cancelPendingSettingsAutosave()
                        showResetConfirmation = true
                    }
                    .disabled(model.isBusy || model.generalSettingsSaveState.isActive)
                    Spacer()
                    SettingsAutosaveStatusView()
                        .environmentObject(model)
                    }
                }
            }
            .formStyle(.grouped)
        }
        .disabled(model.modelDescriptionSaveInProgress)
        .confirmationDialog("macos.resetgeneralsettingstotheoperatordefaults", isPresented: $showResetConfirmation) {
            Button("macos.resetgeneralsettings", role: .destructive) {
                Task {
                    if await model.resetGeneralSettings() { didReset() }
                }
            }
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

    private func modelExpansionBinding(_ modelID: String) -> Binding<Bool> {
        Binding(
            get: { expandedModelIDs.contains(modelID) },
            set: { expanded in
                if expanded { expandedModelIDs.insert(modelID) }
                else { expandedModelIDs.remove(modelID) }
            }
        )
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

    private func modelLabel(_ modelID: String) -> String {
        modelsByID[modelID]?.displayName ?? modelID
    }

    private func effortLabel(_ choice: ModelChoice) -> String {
        let effort = modelsByID[choice.model]?.supportedReasoningEfforts.first {
            $0.effort == choice.reasoningEffort
        }
        let unavailable: String
        if draft.isUltraDisabled(choice) {
            unavailable = " (" + BridgeAppLocalization.string(
                "settings.ultraDisabled", locale: model.interfaceLocale
            ) + ")"
        } else if selectableChoiceKeys.contains(choice.key) {
            unavailable = ""
        } else if SettingsDraft.savedChoiceKeys(in: snapshot).contains(choice.key) {
            unavailable = BridgeAppLocalization.string(
                "macos.savedcurrentlyunavailable",
                locale: model.interfaceLocale
            )
        } else {
            unavailable = BridgeAppLocalization.string(
                "macos.currentlyunavailable",
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
    let searchRequest: SettingsSearchRequest?
    private let defaultBackend = "app-server"
    @State private var maximumAccess = "read-only"
    @State private var showApplyConfirmation = false
    @State private var showForceConfirmation = false

    private var savedConfiguration: RuntimeOperatorConfiguration? {
        model.helperStatus?.configuration.operatorConfiguration
    }

    private var isDirty: Bool {
        guard let savedConfiguration else { return false }
        return maximumAccess != savedConfiguration.maximumAccess
    }

    private var canRetryWithForce: Bool {
        model.runtimeFailureCanRetryWithForce
    }

    var body: some View {
        SettingsSearchScrollContainer(request: searchRequest, pane: .server) {
            Form {
                Section("macos.serversettings") {
                Picker("macos.maximumallowedaccess", selection: $maximumAccess) {
                    Text("macos.readonly").tag("read-only")
                    Text("macos.workspacewrite").tag("workspace-write")
                    Text("macos.fullaccess").tag("full-access")
                }
                Text("macos.thisserversafetylimitisseparatefromthe")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if maximumAccess == "full-access" {
                    Label(
                        "macos.fullaccesscanruncodexwiththismacos",
                        systemImage: "exclamationmark.shield.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                HStack {
                    Spacer()
                    if model.isBusy { ProgressView().controlSize(.small) }
                    Button("macos.applyandrestartserver") {
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
                .id(SettingsSearchTarget.serverAccess.anchorID)

                if snapshot.policyActivation.developerModeRefreshRequired {
                    Section("macos.actionrequired") {
                    Label(
                        "macos.executionlimitschangedrefreshtheplugininchatgpt",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                    }
                }

                if !snapshot.warnings.isEmpty {
                    Section("macos.needsattention") {
                    ForEach(snapshot.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .textSelection(.enabled)
                    }
                    }
                }

                if let error = model.runtimeErrorMessage {
                    Section("macos.applyerror") {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                    if canRetryWithForce {
                        Button("macos.forceapplyandrestart", role: .destructive) {
                            showForceConfirmation = true
                        }
                        .disabled(model.isBusy)
                    }
                    }
                }
            }
            .formStyle(.grouped)
        }
        .onAppear(perform: synchronize)
        .onChange(of: model.helperStatus?.configuration.operatorConfiguration) { _ in
            if !isDirty { synchronize() }
        }
        .confirmationDialog(
            "macos.applyserversettingsandrestarttheserver",
            isPresented: $showApplyConfirmation
        ) {
            Button("macos.applyandrestart") {
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
            Text("macos.theappwaitsforactiveworktofinish")
        }
        .confirmationDialog(
            "macos.ignoreunverifiedbackgroundprocessesandforcearestart",
            isPresented: $showForceConfirmation
        ) {
            Button("macos.forceapplyandrestart", role: .destructive) {
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
            Text("macos.runningcodextasksorbackgroundprocessesmaybe")
        }
    }

    private func synchronize() {
        guard let savedConfiguration else { return }
        maximumAccess = savedConfiguration.maximumAccess
    }
}

private struct ProjectsSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot
    let usesRemotePaths: Bool
    let searchRequest: SettingsSearchRequest?
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
                if usesRemotePaths {
                    Label(
                        "macos.manageprojectsontheselectedserverallpaths",
                        systemImage: "network"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    if usesRemotePaths {
                        editor = .add(name: "", cwd: "")
                    } else if let folder = chooseFolder() {
                        editor = .add(
                            name: folder.lastPathComponent,
                            cwd: folder.path
                        )
                    }
                } label: {
                    Label("macos.addproject", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)

            List {
                if snapshot.settings.projects.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "folder.badge.plus")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text("macos.noregisteredprojects").font(.headline)
                        Text("macos.registeratleastoneexistingfolderbeforestarting")
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
                            if usesRemotePaths {
                                editor = .relocate(project)
                            } else if let folder = chooseFolder() {
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

            Text("macos.removingaregistrationpreservestheactualfolderfiles")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 20)
                .padding(.bottom, 14)
            if let error = model.settingsErrorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .id(SettingsSearchTarget.projects.anchorID)
        .sheet(item: $editor) { editor in
            ProjectEditorSheet(editor: editor, usesRemotePaths: usesRemotePaths) { operation in
                let succeeded = await model.applyProjectOperation(operation)
                if succeeded { self.editor = nil }
                return succeeded
            }
        }
        .confirmationDialog(
            "macos.removethisarchivedprojectregistration",
            isPresented: Binding(
                get: { deletionTarget != nil },
                set: { if !$0 { deletionTarget = nil } }
            ),
            presenting: deletionTarget
        ) { project in
            Button("macos.removeregistration", role: .destructive) {
                Task {
                    if await model.applyProjectOperation(.delete(projectId: project.id)) {
                        deletionTarget = nil
                    }
                }
            }
        } message: { project in
            Text(BridgeAppLocalization.format(
                "macos.thefolderandexistingworkhistorywillbe",
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
        panel.prompt = BridgeAppLocalization.string("macos.link", locale: model.interfaceLocale)
        panel.message = BridgeAppLocalization.string(
            "macos.choosethefoldertolinknofoldersor",
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
                        Text("settings.projectArchived").font(.caption2).padding(4).background(.quaternary, in: Capsule())
                    }
                    if availability?.available == false {
                        Label("macos.folderunavailable", systemImage: "exclamationmark.triangle")
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
                    Button("activity.rename", action: rename)
                    Button("macos.changelinkedfolder", action: relocate)
                    Divider()
                    Button("settings.archiveProject", action: archive)
                } else {
                    Button("settings.restoreProject", action: restore)
                    Divider()
                    Button("macos.removeregistration", role: .destructive, action: delete)
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
    case relocate(BridgeProject)
    case restore(BridgeProject)

    var id: String {
        switch self {
        case .add: return "add"
        case .rename(let project): return "rename-\(project.id)"
        case .relocate(let project): return "relocate-\(project.id)"
        case .restore(let project): return "restore-\(project.id)"
        }
    }
}

private struct ProjectEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @EnvironmentObject private var model: AppModel
    let editor: ProjectEditor
    let usesRemotePaths: Bool
    let save: (ProjectOperation) async -> Bool
    @State private var name: String
    @State private var cwd: String
    @State private var isSaving = false

    init(
        editor: ProjectEditor,
        usesRemotePaths: Bool,
        save: @escaping (ProjectOperation) async -> Bool
    ) {
        self.editor = editor
        self.usesRemotePaths = usesRemotePaths
        self.save = save
        switch editor {
        case .add(let name, let cwd):
            _name = State(initialValue: name)
            _cwd = State(initialValue: cwd)
        case .rename(let project), .relocate(let project), .restore(let project):
            _name = State(initialValue: project.name)
            _cwd = State(initialValue: project.cwd)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title2.bold())
            TextField("macos.projectname", text: $name)
            if case .rename = editor {
                EmptyView()
            } else {
                HStack {
                    TextField(
                        BridgeAppLocalization.string(
                            usesRemotePaths ? "macos.absolutefolderpathontheserver" : "macos.folder",
                            locale: locale
                        ),
                        text: $cwd
                    )
                    .textFieldStyle(.roundedBorder)
                    if !usesRemotePaths {
                        Button("problem.selectShort") {
                            let panel = NSOpenPanel()
                            panel.canChooseFiles = false
                            panel.canChooseDirectories = true
                            panel.prompt = BridgeAppLocalization.string("macos.link", locale: locale)
                            panel.message = BridgeAppLocalization.string(
                                "macos.choosethefoldertolinknofoldersor",
                                locale: locale
                            )
                            if panel.runModal() == .OK, let url = panel.url { cwd = url.path }
                        }
                    }
                }
                if usesRemotePaths {
                    Label(
                        "macos.enteranabsolutepaththatexistsonthe",
                        systemImage: "network"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            if let error = model.settingsErrorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            HStack {
                Button("common.cancel", role: .cancel) { dismiss() }
                Spacer()
                if isSaving { ProgressView().controlSize(.small) }
                Button("macos.save") {
                    isSaving = true
                    Task {
                        if await save(operation) { dismiss() }
                        isSaving = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        requiresPath && cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        isSaving
                )
            }
        }
        .padding(20)
        .frame(width: 480)
    }

    private var title: String {
        let key: String
        switch editor {
        case .add: key = "macos.addproject"
        case .rename: key = "macos.renameproject"
        case .relocate: key = "macos.changelinkedfolder"
        case .restore: key = "macos.restoreproject"
        }
        return BridgeAppLocalization.string(key, locale: locale)
    }

    private var operation: ProjectOperation {
        switch editor {
        case .add:
            return .add(name: name, cwd: cwd)
        case .rename(let project):
            return .rename(projectId: project.id, name: name)
        case .relocate(let project):
            return .relocate(projectId: project.id, cwd: cwd)
        case .restore(let project):
            return .restore(projectId: project.id, name: name, cwd: cwd)
        }
    }

    private var requiresPath: Bool {
        if case .rename = editor { return false }
        return true
    }
}

private func accessLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "read-only": key = "macos.readonly"
    case "adaptive": key = "settings.access.adaptive"
    case "always-full": key = "macos.alwaysfullaccess"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func accessDescription(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "read-only": key = "macos.restrictseverynewtasktoreadonlyaccess"
    case "adaptive": key = "settings.access.adaptiveHint"
    case "always-full": key = "macos.appliesfullaccesstoeverynewtask"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func localeLabel(_ value: String, locale: Locale) -> String {
    switch value {
    case "auto": return BridgeAppLocalization.string("settings.language.auto", locale: locale)
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
    case "always": key = "macos.always"
    case "background-only": key = "macos.backgroundtasksonly"
    case "never": key = "macos.never"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func handoffLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "off": key = "macos.runtime.offLabel"
    case "auto-handoff": key = "macos.automaticallyhandoffoncompletion"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func phaseLabel(_ value: String?, locale: Locale) -> String {
    let key: String
    switch value {
    case "running": key = "macos.running"
    case "starting": key = "macos.starting"
    case "draining": key = "macos.waitingfortaskstofinish"
    case "stopping": key = "macos.stopping"
    case "backoff": key = "macos.waitingtorestart"
    case "safe-mode": key = "macos.safemode"
    default: key = "macos.stopped"
    }
    return BridgeAppLocalization.string(key, locale: locale)
}
