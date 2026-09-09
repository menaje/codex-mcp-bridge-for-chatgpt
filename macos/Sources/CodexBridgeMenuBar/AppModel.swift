import CodexBridgeKit
import Foundation
import Network
import OSLog
import SwiftUI

enum MenuBarHealth: Equatable {
    case healthy
    case checking
    case attention
    case unavailable

    func accessibilityLabel(locale: Locale) -> String {
        let key: String
        switch self {
        case .healthy: key = "Codex 브리지 정상"
        case .checking: key = "Codex 브리지 상태 확인 중"
        case .attention: key = "Codex 브리지 확인 필요"
        case .unavailable: key = "Codex 브리지 연결 불가"
        }
        return BridgeAppLocalization.string(key, locale: locale)
    }
}

enum GeneralSettingsSaveState: Equatable {
    case idle
    case pending
    case saving
    case saved
    case failed

    var isActive: Bool {
        self == .pending || self == .saving
    }
}

struct SettingsDraft: Equatable {
    let expectedSettingsRevision: Int
    var accessStrategy: String
    var policyMode: String
    var fixedSelectionKey: String
    var allowedKind: String
    var explicitSelectionKeys: Set<String>
    var allowDelegation: Bool
    var usePriorityServiceTier: Bool
    var uiLocalePreference: String
    var maxConcurrentJobs: Int
    var showBridgeThreadsInCodexApp: Bool
    var activityCardVisibility: String
    var completionHandoff: String
    private let originalPolicyState: PolicyState

    private struct PolicyState: Equatable {
        let mode: String
        let fixedSelectionKey: String
        let allowedKind: String
        let explicitSelectionKeys: Set<String>
        let allowDelegation: Bool
    }

    init(snapshot: SettingsSnapshot) {
        let settings = snapshot.settings
        expectedSettingsRevision = settings.settingsRevision
        accessStrategy = settings.accessStrategy
        policyMode = settings.modelPolicy.mode
        fixedSelectionKey = settings.modelPolicy.selection?.key ?? ""
        allowedKind = settings.modelPolicy.allowedSelections?.kind ?? "catalog-visible"
        explicitSelectionKeys = Set(
            settings.modelPolicy.allowedSelections?.selections?.map(\ModelChoice.key) ?? []
        )
        allowDelegation = settings.modelPolicy.constraints.allowDelegation
        usePriorityServiceTier = settings.usePriorityServiceTier
        uiLocalePreference = settings.uiLocalePreference
        maxConcurrentJobs = settings.maxConcurrentJobs
        showBridgeThreadsInCodexApp = settings.showBridgeThreadsInCodexApp
        activityCardVisibility = settings.activityCardVisibility
        completionHandoff = settings.completionHandoff
        originalPolicyState = PolicyState(
            mode: policyMode,
            fixedSelectionKey: fixedSelectionKey,
            allowedKind: allowedKind,
            explicitSelectionKeys: explicitSelectionKeys,
            allowDelegation: allowDelegation
        )
    }

    var modelPolicyDirty: Bool {
        policyState != originalPolicyState
    }

    func rebased(on snapshot: SettingsSnapshot) -> SettingsDraft {
        var rebased = SettingsDraft(snapshot: snapshot)
        rebased.accessStrategy = accessStrategy
        rebased.policyMode = policyMode
        rebased.fixedSelectionKey = fixedSelectionKey
        rebased.allowedKind = allowedKind
        rebased.explicitSelectionKeys = explicitSelectionKeys
        rebased.allowDelegation = allowDelegation
        rebased.usePriorityServiceTier = usePriorityServiceTier
        rebased.uiLocalePreference = uiLocalePreference
        rebased.maxConcurrentJobs = maxConcurrentJobs
        rebased.showBridgeThreadsInCodexApp = showBridgeThreadsInCodexApp
        rebased.activityCardVisibility = activityCardVisibility
        rebased.completionHandoff = completionHandoff
        return rebased
    }

    func hasSameEditableValues(as other: SettingsDraft) -> Bool {
        accessStrategy == other.accessStrategy &&
            policyMode == other.policyMode &&
            fixedSelectionKey == other.fixedSelectionKey &&
            allowedKind == other.allowedKind &&
            explicitSelectionKeys == other.explicitSelectionKeys &&
            allowDelegation == other.allowDelegation &&
            usePriorityServiceTier == other.usePriorityServiceTier &&
            uiLocalePreference == other.uiLocalePreference &&
            maxConcurrentJobs == other.maxConcurrentJobs &&
            showBridgeThreadsInCodexApp == other.showBridgeThreadsInCodexApp &&
            activityCardVisibility == other.activityCardVisibility &&
            completionHandoff == other.completionHandoff
    }

    mutating func setActivityCardVisibility(_ visibility: String) {
        activityCardVisibility = visibility
        if visibility == "never" {
            completionHandoff = "off"
        }
    }

    private var policyState: PolicyState {
        PolicyState(
            mode: policyMode,
            fixedSelectionKey: fixedSelectionKey,
            allowedKind: allowedKind,
            explicitSelectionKeys: explicitSelectionKeys,
            allowDelegation: allowDelegation
        )
    }

    static func selectableChoices(
        in snapshot: SettingsSnapshot,
        allowDelegation: Bool
    ) -> [ModelChoice] {
        let ceiling = snapshot.capabilities.operatorModelCeiling.map(Set.init)
        var seen = Set<String>()
        return snapshot.catalog.models
            .filter { $0.hidden != true }
            .flatMap { model in
                model.supportedReasoningEfforts.map {
                    ModelChoice(model: model.id, reasoningEffort: $0.effort)
                }
            }
            .filter {
                (ceiling?.contains($0) ?? true) &&
                    (allowDelegation || $0.reasoningEffort != "ultra")
            }
            .filter { seen.insert($0.key).inserted }
    }

    static func displayedChoices(
        in snapshot: SettingsSnapshot,
        allowDelegation: Bool,
        preservingKeys: Set<String> = []
    ) -> [ModelChoice] {
        let selectable = selectableChoices(
            in: snapshot,
            allowDelegation: allowDelegation
        )
        var result = selectable
        var keys = Set(selectable.map(\.key))
        for choice in savedChoices(in: snapshot) where keys.insert(choice.key).inserted {
            result.append(choice)
        }
        for key in preservingKeys.sorted() {
            guard let choice = choice(from: key), keys.insert(key).inserted else { continue }
            result.append(choice)
        }
        return result
    }

    static func savedChoiceKeys(in snapshot: SettingsSnapshot) -> Set<String> {
        Set(savedChoices(in: snapshot).map(\.key))
    }

    private static func choice(from key: String) -> ModelChoice? {
        let parts = key.split(separator: "\0", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return ModelChoice(model: String(parts[0]), reasoningEffort: String(parts[1]))
    }

    private static func savedChoices(in snapshot: SettingsSnapshot) -> [ModelChoice] {
        let policy = snapshot.settings.modelPolicy
        return [policy.selection].compactMap { $0 } +
            (policy.allowedSelections?.selections ?? [])
    }
}

struct SettingsDraftSyncState: Equatable {
    private(set) var draft: SettingsDraft?
    private(set) var baseline: SettingsDraft?
    private(set) var loadedRevision = -1
    private(set) var externalChangeDetected = false

    mutating func updateDraft(_ value: SettingsDraft) {
        draft = value
    }

    mutating func synchronize(with snapshot: SettingsSnapshot, force: Bool = false) {
        let next = SettingsDraft(snapshot: snapshot)
        let revisionChanged = loadedRevision != snapshot.settings.settingsRevision
        let hasLocalEdits = draft != nil && baseline != nil && draft != baseline
        if force || draft == nil || baseline == nil || !hasLocalEdits {
            draft = next
            baseline = next
            externalChangeDetected = false
        } else if revisionChanged {
            externalChangeDetected = true
        }
        loadedRevision = snapshot.settings.settingsRevision
    }

    mutating func acknowledgePersisted(
        snapshot: SettingsSnapshot,
        submitted: SettingsDraft
    ) {
        let next = SettingsDraft(snapshot: snapshot)
        let current = draft
        baseline = next
        loadedRevision = snapshot.settings.settingsRevision
        externalChangeDetected = false
        if let current, !current.hasSameEditableValues(as: submitted) {
            draft = current.rebased(on: snapshot)
        } else {
            draft = next
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var requestedSettingsTab: String?
    @Published private(set) var operationalActionRequiredProblem: OperationalProblem?
    @Published var bridgeProblemNotificationsEnabled = true {
        didSet { operationalNotifications?.bridgeEnabled = bridgeProblemNotificationsEnabled }
    }
    @Published var securityNotificationsEnabled = true {
        didSet { operationalNotifications?.securityEnabled = securityNotificationsEnabled }
    }
    private let operationalNotifications: OperationalNotifications?
    private var remoteOperationalProblem: OperationalProblem?
    private var notificationRefreshTask: Task<Void, Never>?
    private var notificationsStarted = false
    private var statusRefreshTask: Task<Void, Never>?
    private var statusRefreshPending = false
    private var helperChangesTask: Task<Void, Never>?
    private var companionChangesTask: Task<Void, Never>?
    private var helperChangesUnsupported = false
    private var companionChangesUnsupported = false
    @Published private(set) var helperChangesAvailable = false
    @Published private(set) var companionChangesAvailable = false
    private var refreshEventTasks: [String: Task<Void, Never>] = [:]
    private var refreshEventTaskIDs: [String: UUID] = [:]
    private var pendingRefreshEvents = Set<String>()
    private var lastScheduledRefresh: [String: Date] = [:]
    private var lastDashboardEnrichment: Date?
    private var networkMonitor: NWPathMonitor?
    private var workspaceObservers: [NSObjectProtocol] = []
    private(set) var dashboardVisible = false
    private(set) var settingsWindowVisible = false
    private var settingsInvalidated = false
    private var systemObservationPending = false
    @Published var helperStatus: HelperStatus? { didSet { scheduleOperationalObservation() } }
    @Published var codexRuntime: CodexRuntimeSnapshot?
    @Published var codexRuntimeError: String?
    @Published var checkingCodexUpdates = Set<String>()
    var codexSettingsVisible = false
    private var codexRuntimeReads: [String: Int] = [:]
    private var codexRuntimeReadRevision: [String: Int] = [:]
    @Published var dashboard: DashboardSnapshot?
    @Published var settings: SettingsSnapshot?
    @Published var authStatus: CodexLoginStatus? { didSet { scheduleOperationalObservation() } }
    @Published var logs: [HelperLogEntry] = []
    @Published private(set) var setupDiscovery: TunnelSetupDiscovery?
    @Published var setupDiscoveryErrorMessage: String?
    @Published var startupErrorMessage: String? { didSet { scheduleOperationalObservation() } }
    @Published var statusErrorMessage: String? { didSet { scheduleOperationalObservation() } }
    @Published var dashboardErrorMessage: String?
    @Published var dashboardEnrichmentFailed = false
    @Published var dashboardEnrichmentPending = false
    @Published var dashboardObservationDate: Date?
    private var dashboardEnrichmentInvalidated = false
    @Published var settingsLoadErrorMessage: String?
    @Published var settingsErrorMessage: String?
    @Published var runtimeErrorMessage: String?
    @Published private(set) var runtimeFailureCanRetryWithForce = false
    @Published var authErrorMessage: String? { didSet { scheduleOperationalObservation() } }
    @Published var logsErrorMessage: String?
    @Published var settingsConflictMessage: String?
    @Published var isBusy = false { didSet { scheduleOperationalObservation() } }
    @Published var loginInProgress = false { didSet { scheduleOperationalObservation() } }
    @Published var lastDashboardRefresh: Date?
    @Published var runtimeImpact: RuntimeAdmissionSnapshot?
    @Published var runtimeImpactErrorMessage: String?
    @Published var menuBarLoginItemStatus: MenuBarLoginItemStatus = .notRegistered
    @Published var loginItemErrorMessage: String?
    @Published var loginItemOperationInProgress = false
    @Published private(set) var interfaceLocalePreference = "auto"
    @Published private(set) var generalSettingsSaveState: GeneralSettingsSaveState = .idle
    @Published private(set) var lastAutosavedSettingsRevision: Int?
    @Published private(set) var lastAutosavedDraft: SettingsDraft?
    @Published private(set) var applicationShutdownCompleted = false
    @Published private(set) var applicationShutdownInProgress = false
    @Published private(set) var connectionPreferences: BridgeConnectionPreferences
    @Published private(set) var remoteHello: RemoteCompanionHello?
    @Published private(set) var remoteManagementStatus: RemoteManagementStatus?
    @Published var connectionErrorMessage: String?
    @Published var remoteManagementErrorMessage: String?
    @Published var remotePairingInvitation: RemotePairingInvitation?
    @Published private(set) var connectionContextID = UUID()

    private let bootstrapper = HelperBootstrap()
    private let loginItemController: any LoginItemControlling
    private let connectionStore: (any BridgeConnectionPreferencesStoring)?
    private let credentialStore: any RemoteCredentialStoring
    private let remoteClientFactory: @Sendable (
        RemoteServerProfile,
        String
    ) throws -> any RemoteBridgeApplicationClient
    private let remotePairingFactory: @Sendable (
        String,
        String,
        String?
    ) async throws -> RemotePairingResult
    private let pageLimit = 12
    private let logger = Logger(subsystem: "com.menaje.codex-mcp-bridge", category: "app-model")
    private var pollingTask: Task<Void, Never>?
    private var bridgeReadinessTask: Task<Void, Never>?
    private var connectionRecoveryExpiryTask: Task<Void, Never>?
    private var connectionRecoveryExpiryDeadline: Date?
    private var bridgeReadinessTaskGeneration = 0
    private var loginPollingTask: Task<Void, Never>?
    private var startTask: Task<Void, Never>?
    private var authRefreshTask: Task<Void, Never>?
    private var authRefreshPending = false
    private var codexRuntimePendingReads = Set<String>()
    private var dashboardEnrichmentTask: Task<Void, Never>?
    private var settingsAutosaveDebounceTask: Task<Void, Never>?
    private var remotePairingExpirationTask: Task<Void, Never>?
    private var pendingSettingsDraft: SettingsDraft?
    private var settingsAutosaveInProgress = false
    private var interfaceLocalePreviewActive = false
    private var dashboardRequestGeneration = 0
    private var settingsRequestGeneration = 0
    private var statusRequestGeneration = 0
    @Published private(set) var localConnectionRecovery = ConnectionRecoveryWindow() { didSet { scheduleOperationalObservation() } }
    private var connectionGeneration = 0
    private var cachedRemoteClient: (
        profile: RemoteServerProfile,
        client: any RemoteBridgeApplicationClient
    )?
    private let profileHeartbeatInterval: TimeInterval = 60
    private var paths: RuntimePaths?
    private var pathResolutionTask: Task<RuntimePaths, Never>?

    init(
        paths: RuntimePaths? = nil,
        loginItemController: (any LoginItemControlling)? = nil,
        connectionStore: (any BridgeConnectionPreferencesStoring)? = nil,
        operationalNotifications: OperationalNotifications? = nil,
        credentialStore: any RemoteCredentialStoring = KeychainRemoteCredentialStore(),
        remoteClientFactory: @escaping @Sendable (
            RemoteServerProfile,
            String
        ) throws -> any RemoteBridgeApplicationClient = { profile, credential in
            try RemoteCompanionClient(profile: profile, credential: credential)
        },
        remotePairingFactory: @escaping @Sendable (
            String,
            String,
            String?
        ) async throws -> RemotePairingResult = { invitation, deviceName, profileName in
            try await RemoteCompanionClient.pair(
                invitation: invitation,
                deviceName: deviceName,
                profileName: profileName
            )
        }
    ) {
        self.paths = paths
        self.loginItemController = loginItemController ?? ServiceManagementLoginItemController()
        self.connectionStore = connectionStore
        self.operationalNotifications = operationalNotifications
        self.credentialStore = credentialStore
        self.remoteClientFactory = remoteClientFactory
        self.remotePairingFactory = remotePairingFactory
        self.connectionPreferences = connectionStore?.load() ?? BridgeConnectionPreferences()
        menuBarLoginItemStatus = self.loginItemController.status
        bridgeProblemNotificationsEnabled = operationalNotifications?.bridgeEnabled ?? true
        securityNotificationsEnabled = operationalNotifications?.securityEnabled ?? true
    }

    var operationalNotificationScope: String {
        OperationalNotificationPolicy.scope(isRemoteClient ? (activeRemoteProfile?.serverId ?? "unselected") : "local")
    }

    var operationalObservation: OperationalObservation {
        guard !isBusy, !loginInProgress, !applicationShutdownInProgress, !systemObservationPending else { return .unknown }
        if !isRemoteClient, localConnectionRecovery.isChecking { return .unknown }
        if isRemoteClient {
            guard activeRemoteProfile != nil else { return .unknown }
            if let remoteOperationalProblem { return .problem(remoteOperationalProblem) }
            return remoteHello == nil ? .unknown : .healthy
        }
        guard let status = helperStatus else {
            return startupErrorMessage != nil || statusErrorMessage != nil ? .problem(.runtime) : .unknown
        }
        if !status.configuration.valid { return .problem(.configuration) }
        // An intentional stop is healthy. Failed/retrying starts still have a grace period.
        if status.phase == "stopped", status.lastError == nil, status.lastProblem == nil { return .healthy }
        if status.phase != "running" || !status.bridge.connected { return .problem(.runtime) }
        if !status.tunnel.connected { return .problem(.tunnel) }
        guard let auth = authStatus else { return authErrorMessage == nil ? .unknown : .problem(.authentication) }
        if !auth.installed { return .problem(.installation) }
        return auth.authenticated ? .healthy : .problem(.authentication)
    }

    var operationalProblem: OperationalProblem? {
        guard case .problem(let problem) = operationalObservation else { return nil }
        // Readiness still feeds the notification grace period, but is not yet
        // a failure to show alongside the menu's connection-checking view.
        if isBridgeConnectionChecking, problem == .runtime || problem == .tunnel { return nil }
        return problem
    }

    private var currentActionRequiredProblem: OperationalProblem? {
        guard let problem = operationalActionRequiredProblem,
              operationalObservation == .problem(problem) else { return nil }
        return problem
    }

    private var connectionCheckRequiresAttention: Bool {
        switch currentActionRequiredProblem {
        case .runtime, .tunnel, .remoteConnection: return true
        default: return false
        }
    }

    func requestNotificationAuthorization() async {
        if await operationalNotifications?.requestAuthorization() == false,
           let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }

    func showOperationalProblem(_ problem: OperationalProblem, scope: String? = nil) {
        requestedSettingsTab = isRemoteClient || (scope != nil && scope != operationalNotificationScope)
            ? "connection" : problem.settingsTab
        SettingsWindowController.shared.show(model: self)
    }

    private func beginOperationalNotifications() {
        notificationsStarted = true
        scheduleOperationalObservation()
    }

    private func scheduleOperationalObservation() {
        guard notificationsStarted, operationalNotifications != nil, notificationRefreshTask == nil else { return }
        notificationRefreshTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
            guard let self else { return }
            self.notificationRefreshTask = nil
            await self.refreshOperationalNotifications()
        }
    }

    func refreshOperationalNotifications(at now: Date = Date()) async {
        await operationalNotifications?.refresh(observation: operationalObservation,
            scope: operationalNotificationScope, locale: interfaceLocale, now: now)
        operationalActionRequiredProblem = operationalNotifications?.actionRequired
    }

    private func resolvedPaths() async -> RuntimePaths {
        if let paths { return paths }
        if let pathResolutionTask { return await pathResolutionTask.value }
        let task = Task.detached(priority: .userInitiated) { RuntimePaths() }
        pathResolutionTask = task
        let resolved = await task.value
        paths = resolved
        pathResolutionTask = nil
        return resolved
    }

    private func helperClient() async -> MacOSHelperClient {
        let paths = await resolvedPaths()
        return MacOSHelperClient(socketPath: paths.helperSocket.path)
    }

    private func localBridgeClient() async -> BridgeCompanionClient {
        let paths = await resolvedPaths()
        return BridgeCompanionClient(socketPath: paths.bridgeSocket.path)
    }

    private func bridgeClient() async throws -> any BridgeApplicationClient {
        if let remote = try remoteClientIfSelected() { return remote }
        return await localBridgeClient()
    }

    private func remoteClientIfSelected() throws -> (any RemoteBridgeApplicationClient)? {
        guard isRemoteClient else { return nil }
        guard let profile = activeRemoteProfile else {
            throw RemoteCompanionError.invalidEndpoint
        }
        if let cached = cachedRemoteClient,
           cached.profile.serverId == profile.serverId,
           cached.profile.endpoint == profile.endpoint,
           cached.profile.certificateSha256 == profile.certificateSha256 {
            return cached.client
        }
        invalidateRemoteClient()
        guard let credential = try credentialStore.credential(for: profile.serverId) else {
            throw RemoteCompanionError.credentialMissing
        }
        let client = try remoteClientFactory(profile, credential)
        cachedRemoteClient = (profile, client)
        return client
    }

    private func invalidateRemoteClient() {
        cachedRemoteClient?.client.close()
        cachedRemoteClient = nil
    }

    var isRemoteClient: Bool {
        connectionPreferences.mode == .remoteClient
    }

    var activeRemoteProfile: RemoteServerProfile? {
        connectionPreferences.activeProfile
    }

    var connectionTargetName: String {
        if isRemoteClient {
            return activeRemoteProfile?.name ?? BridgeAppLocalization.string(
                "선택된 원격 서버 없음",
                locale: interfaceLocale
            )
        }
        return BridgeAppLocalization.string("이 Mac", locale: interfaceLocale)
    }

    var bridgeConnected: Bool {
        isRemoteClient ? remoteHello != nil : helperStatus?.bridge.connected == true
    }

    var hasConnectionTarget: Bool {
        !isRemoteClient || activeRemoteProfile != nil
    }

    var helperStatusErrorMessage: String? {
        BridgeAppLocalization.statusProblemDescription(
            problem: helperStatus?.lastProblem,
            diagnosticMessage: helperStatus?.lastError,
            context: .helper,
            locale: interfaceLocale
        )
    }

    var tunnelStatusErrorMessage: String? {
        BridgeAppLocalization.statusProblemDescription(
            problem: helperStatus?.tunnel.lastProblem,
            diagnosticMessage: helperStatus?.tunnel.lastError,
            context: .tunnel,
            locale: interfaceLocale
        )
    }

    var runtimeConfigurationIssueMessage: String? {
        BridgeAppLocalization.statusProblemDescription(
            problem: helperStatus?.configuration.issueProblem,
            diagnosticMessage: helperStatus?.configuration.issue,
            context: .runtimeConfiguration,
            locale: interfaceLocale
        )
    }

    var remoteManagementStatusErrorMessage: String? {
        BridgeAppLocalization.statusProblemDescription(
            problem: remoteManagementStatus?.lastProblem,
            diagnosticMessage: remoteManagementStatus?.lastError,
            context: .remoteManagement,
            locale: interfaceLocale
        )
    }

    var isTunnelConnectionChecking: Bool {
        guard !isRemoteClient, !needsSetup, !connectionCheckRequiresAttention,
              let helperStatus,
              helperStatus.phase == "starting" || helperStatus.phase == "running",
              !helperStatus.tunnel.connected else { return false }
        let tunnel = helperStatus.tunnel
        if localConnectionRecovery.isChecking { return true }
        if tunnel.phase == "starting" { return true }
        if BridgeAppLocalization.isTunnelConnectionPending(
            problem: tunnel.lastProblem,
            diagnosticMessage: tunnel.lastError
        ) {
            return true
        }
        return tunnel.processRunning && tunnel.lastProblem == nil && tunnel.lastError == nil
    }

    var isBridgeConnectionChecking: Bool {
        if systemObservationPending { return true }
        guard !needsSetup, !connectionCheckRequiresAttention else { return false }
        if isRemoteClient {
            guard activeRemoteProfile != nil, remoteHello == nil else { return false }
            return connectionErrorMessage == nil && statusErrorMessage == nil
        }
        if localConnectionRecovery.isChecking,
           helperStatus == nil || (helperStatus?.phase == "running" && helperStatus?.configuration.valid == true) {
            return true
        }
        if helperStatus?.phase == "starting" || isTunnelConnectionChecking { return true }
        guard helperStatus == nil else { return false }
        return startupErrorMessage == nil && statusErrorMessage == nil
    }

    var shouldShowCodexAuthenticationNotice: Bool {
        guard !isRemoteClient else { return false }
        if authErrorMessage != nil { return true }
        guard let authStatus else { return false }
        return !authStatus.installed || !authStatus.authenticated
    }

    var shouldShowCodexWeeklyUsage: Bool {
        isRemoteClient || authStatus?.authenticated != false
    }

    var selectedCodexAccount: CodexAccountUsage? { codexRuntime?.account }

    var health: MenuBarHealth {
        if systemObservationPending { return .checking }
        if currentActionRequiredProblem != nil { return .attention }
        if isBridgeConnectionChecking { return .checking }
        if isRemoteClient {
            guard activeRemoteProfile != nil, remoteHello != nil else { return .unavailable }
            guard connectionErrorMessage == nil, dashboardErrorMessage == nil else {
                return .attention
            }
            guard let counts = dashboard?.counts else { return .checking }
            return counts.needsAttention > 0 ? .attention : .healthy
        }
        guard let helperStatus,
              helperStatus.configuration.valid,
              helperStatus.bridge.connected,
              helperStatus.tunnel.connected,
              helperStatus.phase == "running" else {
            return .unavailable
        }
        guard let authStatus else {
            return authErrorMessage == nil ? .checking : .attention
        }
        guard authStatus.installed else { return .unavailable }
        guard authStatus.authenticated else { return .attention }
        guard dashboardErrorMessage == nil else { return .attention }
        guard let counts = dashboard?.counts else { return .checking }
        return counts.needsAttention > 0 ? .attention : .healthy
    }

    var needsSetup: Bool {
        if isRemoteClient { return false }
        guard let helperStatus else { return false }
        return !helperStatus.configuration.valid
    }

    var interfaceLocale: Locale {
        BridgeAppLocalization.locale(for: interfaceLocalePreference)
    }

    var interfaceLocaleIdentifier: String {
        BridgeAppLocalization.languageCode(for: interfaceLocalePreference)
    }

    func setConnectionMode(_ mode: BridgeAppMode, force: Bool = false) async -> Bool {
        guard mode != connectionPreferences.mode else { return true }
        guard await flushSettingsAutosave() else {
            connectionErrorMessage = BridgeAppLocalization.string(
                "저장 중인 서버 설정을 완료하지 못해 연결 모드를 바꾸지 않았습니다.",
                locale: interfaceLocale
            )
            return false
        }
        isBusy = true
        defer { isBusy = false }
        connectionErrorMessage = nil

        if mode == .remoteClient {
            do {
                try await stopLocalOwnershipForModeSwitch(force: force)
            } catch {
                connectionErrorMessage = localizedApplicationShutdownError(error)
                return false
            }
        }

        let previous = connectionPreferences
        connectionPreferences.mode = mode
        do {
            try connectionStore?.save(connectionPreferences)
        } catch {
            let persistenceError = error
            connectionPreferences = previous
            if mode == .remoteClient {
                do {
                    let paths = await resolvedPaths()
                    try await bootstrapper.ensureRunning(paths: paths)
                    startupErrorMessage = nil
                } catch {
                    startupErrorMessage = localizedErrorDescription(error)
                }
            }
            connectionErrorMessage = localizedErrorDescription(persistenceError)
            return false
        }
        resetConnectionContext()

        if mode == .localHost {
            do {
                let paths = await resolvedPaths()
                try await bootstrapper.ensureRunning(paths: paths)
                startupErrorMessage = nil
            } catch {
                startupErrorMessage = localizedErrorDescription(error)
                return false
            }
        }
        await refreshAll()
        beginPolling()
        return true
    }

    func pairRemoteServer(
        invitation: String,
        profileName: String,
        deviceName: String
    ) async -> Bool {
        let trimmedDeviceName = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedDeviceName.isEmpty else {
            connectionErrorMessage = BridgeAppLocalization.string(
                "이 기기를 구분할 이름을 입력해 주세요.",
                locale: interfaceLocale
            )
            return false
        }
        guard await flushSettingsAutosave() else {
            connectionErrorMessage = BridgeAppLocalization.string(
                "저장 중인 서버 설정을 완료하지 못해 새 서버를 페어링하지 않았습니다.",
                locale: interfaceLocale
            )
            return false
        }
        isBusy = true
        defer { isBusy = false }
        connectionErrorMessage = nil
        let wasRemoteClient = isRemoteClient
        do {
            let result = try await remotePairingFactory(
                invitation,
                trimmedDeviceName,
                profileName
            )
            let previousCredential = try credentialStore.credential(
                for: result.profile.serverId
            )
            try credentialStore.saveCredential(
                result.credential,
                for: result.profile.serverId
            )
            let previous = connectionPreferences
            var profiles = connectionPreferences.profiles.filter {
                $0.serverId != result.profile.serverId
            }
            profiles.append(result.profile)
            connectionPreferences.profiles = profiles
            connectionPreferences.activeServerId = result.profile.serverId
            do {
                try connectionStore?.save(connectionPreferences)
            } catch {
                connectionPreferences = previous
                if let previousCredential {
                    try? credentialStore.saveCredential(
                        previousCredential,
                        for: result.profile.serverId
                    )
                } else {
                    try? credentialStore.deleteCredential(for: result.profile.serverId)
                }
                throw error
            }
            if wasRemoteClient, isRemoteClient {
                resetConnectionContext()
                await refreshAll()
            }
            return true
        } catch {
            connectionErrorMessage = localizedErrorDescription(error)
            return false
        }
    }

    func prepareRemoteServerForModeSwitch(_ serverId: String) -> Bool {
        guard !isRemoteClient,
              connectionPreferences.profiles.contains(where: {
                  $0.serverId == serverId
              }) else {
            return false
        }
        do {
            guard try credentialStore.credential(for: serverId) != nil else {
                throw RemoteCompanionError.credentialMissing
            }
            let previous = connectionPreferences
            connectionPreferences.activeServerId = serverId
            do {
                try connectionStore?.save(connectionPreferences)
            } catch {
                connectionPreferences = previous
                throw error
            }
            connectionErrorMessage = nil
            return true
        } catch {
            connectionErrorMessage = localizedErrorDescription(error)
            return false
        }
    }

    func activateRemoteServer(_ serverId: String) async -> Bool {
        guard isRemoteClient,
              serverId != connectionPreferences.activeServerId,
              connectionPreferences.profiles.contains(where: { $0.serverId == serverId }) else {
            return serverId == connectionPreferences.activeServerId
        }
        guard await flushSettingsAutosave() else {
            connectionErrorMessage = BridgeAppLocalization.string(
                "저장 중인 서버 설정을 완료하지 못해 서버를 전환하지 않았습니다.",
                locale: interfaceLocale
            )
            return false
        }
        let previous = connectionPreferences
        connectionPreferences.activeServerId = serverId
        do {
            try connectionStore?.save(connectionPreferences)
        } catch {
            connectionPreferences = previous
            connectionErrorMessage = localizedErrorDescription(error)
            return false
        }
        resetConnectionContext()
        await refreshAll()
        return remoteHello != nil
    }

    func renameRemoteServer(_ serverId: String, name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed.count <= 120,
              let index = connectionPreferences.profiles.firstIndex(where: {
                  $0.serverId == serverId
              }) else {
            return false
        }
        let previous = connectionPreferences
        connectionPreferences.profiles[index].name = trimmed
        do {
            try connectionStore?.save(connectionPreferences)
            return true
        } catch {
            connectionPreferences = previous
            connectionErrorMessage = localizedErrorDescription(error)
            return false
        }
    }

    func removeRemoteServer(_ serverId: String) async -> Bool {
        guard connectionPreferences.profiles.contains(where: { $0.serverId == serverId }) else {
            return false
        }
        let wasActive = connectionPreferences.activeServerId == serverId
        if isRemoteClient, wasActive, !(await flushSettingsAutosave()) {
            connectionErrorMessage = BridgeAppLocalization.string(
                "저장 중인 서버 설정을 완료하지 못해 서버를 삭제하지 않았습니다.",
                locale: interfaceLocale
            )
            return false
        }
        let previousCredential: String?
        do {
            previousCredential = try credentialStore.credential(for: serverId)
        } catch {
            connectionErrorMessage = localizedErrorDescription(error)
            return false
        }
        let previous = connectionPreferences
        connectionPreferences.profiles.removeAll { $0.serverId == serverId }
        if connectionPreferences.activeServerId == serverId {
            connectionPreferences.activeServerId = connectionPreferences.profiles.first?.serverId
        }
        do {
            try connectionStore?.save(connectionPreferences)
            try credentialStore.deleteCredential(for: serverId)
        } catch {
            connectionPreferences = previous
            try? connectionStore?.save(previous)
            if let previousCredential {
                try? credentialStore.saveCredential(previousCredential, for: serverId)
            }
            connectionErrorMessage = localizedErrorDescription(error)
            return false
        }
        if isRemoteClient, wasActive {
            resetConnectionContext()
            await refreshAll()
        }
        return true
    }

    func refreshRemoteManagementStatus() async {
        guard !isRemoteClient, bridgeConnected else {
            remoteManagementStatus = nil
            return
        }
        let generation = connectionGeneration
        do {
            let client = await localBridgeClient()
            let next = try await client.remoteManagementStatus()
            guard generation == connectionGeneration, !isRemoteClient else { return }
            remoteManagementStatus = next
            remoteManagementErrorMessage = nil
        } catch {
            guard generation == connectionGeneration, !isRemoteClient else { return }
            remoteManagementStatus = nil
            remoteManagementErrorMessage = localizedErrorDescription(error)
        }
    }

    func configureRemoteManagement(
        enabled: Bool,
        endpoint: String,
        displayName: String
    ) async -> Bool {
        guard !isRemoteClient, bridgeConnected else { return false }
        isBusy = true
        defer { isBusy = false }
        let generation = connectionGeneration
        remoteManagementErrorMessage = nil
        setRemotePairingInvitation(nil)
        do {
            let client = await localBridgeClient()
            let status = try await client.configureRemoteManagement(
                enabled: enabled,
                endpoint: endpoint,
                displayName: displayName
            )
            guard generation == connectionGeneration, !isRemoteClient else { return false }
            remoteManagementStatus = status
            if enabled, !status.listening {
                remoteManagementErrorMessage = BridgeAppLocalization.statusProblemDescription(
                    problem: status.lastProblem,
                    diagnosticMessage: status.lastError,
                    context: .remoteManagement,
                    locale: interfaceLocale
                ) ??
                    BridgeAppLocalization.string(
                        "원격 관리 서버가 지정한 주소에서 시작되지 않았습니다.",
                        locale: interfaceLocale
                    )
                return false
            }
            return true
        } catch {
            guard generation == connectionGeneration, !isRemoteClient else { return false }
            remoteManagementErrorMessage = localizedErrorDescription(error)
            return false
        }
    }

    func beginRemotePairing() async -> Bool {
        guard !isRemoteClient, remoteManagementStatus?.listening == true else { return false }
        isBusy = true
        defer { isBusy = false }
        let generation = connectionGeneration
        do {
            let client = await localBridgeClient()
            let next = try await client.beginRemotePairing()
            guard generation == connectionGeneration, !isRemoteClient else { return false }
            setRemotePairingInvitation(next)
            remoteManagementErrorMessage = nil
            return true
        } catch {
            guard generation == connectionGeneration, !isRemoteClient else { return false }
            setRemotePairingInvitation(nil)
            remoteManagementErrorMessage = localizedErrorDescription(error)
            return false
        }
    }

    func revokeRemoteDevice(_ deviceId: String) async -> Bool {
        guard !isRemoteClient else { return false }
        isBusy = true
        defer { isBusy = false }
        let generation = connectionGeneration
        do {
            let client = await localBridgeClient()
            let next = try await client.revokeRemoteDevice(deviceId)
            guard generation == connectionGeneration, !isRemoteClient else { return false }
            remoteManagementStatus = next
            remoteManagementErrorMessage = nil
            return true
        } catch {
            guard generation == connectionGeneration, !isRemoteClient else { return false }
            remoteManagementErrorMessage = localizedErrorDescription(error)
            return false
        }
    }

    func previewInterfaceLocale(_ preference: String) {
        guard BridgeAppLocalization.supportedPreferences.contains(preference) else { return }
        interfaceLocalePreviewActive = true
        interfaceLocalePreference = preference
    }

    func restorePersistedInterfaceLocale() {
        interfaceLocalePreviewActive = false
        if let preference = settings?.settings.uiLocalePreference {
            interfaceLocalePreference = preference
        }
    }

    func consumeAutosaveAcknowledgement(revision: Int) {
        guard lastAutosavedSettingsRevision == revision else { return }
        lastAutosavedSettingsRevision = nil
        lastAutosavedDraft = nil
    }

    func start() async {
        if let startTask {
            await startTask.value
            return
        }
        let task = Task<Void, Never> { @MainActor [weak self] in
            guard let self else { return }
            await self.startOnce()
        }
        startTask = task
        await task.value
        startTask = nil
    }

    private func startOnce() async {
        beginOperationalNotifications()
        if isRemoteClient {
            logger.info("starting in remote client mode without local helper bootstrap")
            isBusy = true
            defer { isBusy = false }
            startupErrorMessage = nil
            beginPolling()
            await refreshAll()
            return
        }
        logger.info("starting helper bootstrap")
        isBusy = true
        defer { isBusy = false }
        do {
            let paths = await resolvedPaths()
            try await bootstrapper.ensureRunning(paths: paths)
            logger.info("helper bootstrap completed")
            startupErrorMessage = nil
            beginPolling()
            await refreshAll()
        } catch {
            logger.error("helper bootstrap failed: \(error.localizedDescription, privacy: .public)")
            startupErrorMessage = localizedErrorDescription(error)
        }
    }

    func refreshAll(refreshModels: Bool = false) async {
        await refreshStatus()
        if !isRemoteClient {
            await refreshAuthStatus()
            enqueueRefresh(["codex"])
        }
        if !isRemoteClient, needsSetup {
            await refreshSetupDiscovery()
        } else {
            setupDiscovery = nil
            setupDiscoveryErrorMessage = nil
        }
        await refreshBridgeContent(refreshModels: refreshModels)
        beginBridgeReadinessPollingIfNeeded()
    }

    private func refreshBridgeContent(refreshModels: Bool = false) async {
        await refreshDashboard()
        await refreshSettings(refreshModels: refreshModels)
    }

    func refreshStatus() async {
        statusRefreshPending = true
        if let task = statusRefreshTask { await task.value; return }
        let generation = connectionGeneration
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            while self.statusRefreshPending, !Task.isCancelled, generation == self.connectionGeneration {
                self.statusRefreshPending = false
                await self.refreshStatusOnce()
            }
        }
        statusRefreshTask = task
        await task.value
        if generation == connectionGeneration { statusRefreshTask = nil }
    }

    private func refreshStatusOnce() async {
        let generation = connectionGeneration
        statusRequestGeneration += 1
        let requestGeneration = statusRequestGeneration
        defer {
            if generation == connectionGeneration, requestGeneration == statusRequestGeneration {
                systemObservationPending = false
                scheduleOperationalObservation()
            }
        }
        if isRemoteClient {
            helperStatus = nil
            codexRuntime = nil
            authStatus = nil
            guard activeRemoteProfile != nil else {
                remoteHello = nil
                statusErrorMessage = nil
                connectionErrorMessage = nil
                return
            }
            do {
                guard let client = try remoteClientIfSelected() else { return }
                let hello = try await client.hello()
                guard generation == connectionGeneration, requestGeneration == statusRequestGeneration, isRemoteClient else { return }
                let refreshContent = systemObservationPending || remoteHello == nil
                remoteHello = hello
                remoteOperationalProblem = nil
                statusErrorMessage = nil
                connectionErrorMessage = nil
                updateActiveProfile(from: hello)
                if refreshContent {
                    lastDashboardEnrichment = nil
                    enqueueRefresh(["dashboard", "settings"])
                }
            } catch {
                guard generation == connectionGeneration, requestGeneration == statusRequestGeneration, isRemoteClient else { return }
                remoteHello = nil
                remoteOperationalProblem = OperationalProblem.remoteError(error)
                let message = localizedErrorDescription(error)
                statusErrorMessage = message
                connectionErrorMessage = message
            }
            return
        }
        remoteHello = nil
        connectionErrorMessage = nil
        do {
            let client = await helperClient()
            let next = try await client.health()
            guard generation == connectionGeneration, requestGeneration == statusRequestGeneration, !isRemoteClient else { return }
            recordLocalConnectionStatus(next)
            statusErrorMessage = nil
            beginChangeWatchingIfNeeded()
        } catch {
            guard generation == connectionGeneration, requestGeneration == statusRequestGeneration, !isRemoteClient else { return }
            recordLocalConnectionStatus(nil)
            statusErrorMessage = localizedErrorDescription(error)
            logger.error("helper status check failed: \(error.localizedDescription, privacy: .public)")
        }
        beginBridgeReadinessPollingIfNeeded()
    }

    var runtimeUnavailableExplanation: String {
        let key: String
        if isRemoteClient { key = "연결 탭에서 서버를 선택하거나 페어링해 주세요." }
        else if helperStatus?.phase == "stopped" { key = "브리지 서버가 중지되었습니다." }
        else if helperStatus?.pid != nil { key = "서버 프로세스는 실행 중이지만 연결 응답을 확인하지 못했습니다." }
        else { key = "브리지 서버의 응답을 확인하지 못했습니다. 잠시 후 다시 확인해 주세요." }
        return BridgeAppLocalization.string(key, locale: interfaceLocale)
    }

    func recordLocalConnectionStatus(_ next: HelperStatus?, at now: Date = Date()) {
        let refreshContent = systemObservationPending || helperStatus?.bridge.connected != true
        systemObservationPending = false
        helperStatus = next
        localConnectionRecovery.observe(
            available: next?.bridge.connected == true && next?.tunnel.connected == true,
            retryable: next.map { $0.phase == "running" && $0.configuration.valid } ?? true,
            at: now
        )
        scheduleConnectionRecoveryExpiry(at: now)
        if refreshContent, next?.bridge.connected == true {
            lastDashboardEnrichment = nil
            enqueueRefresh(["dashboard", "settings"])
        }
    }

    private func scheduleConnectionRecoveryExpiry(at now: Date = Date()) {
        let deadline = localConnectionRecovery.deadline
        if deadline == connectionRecoveryExpiryDeadline, connectionRecoveryExpiryTask != nil { return }
        connectionRecoveryExpiryTask?.cancel()
        connectionRecoveryExpiryTask = nil
        connectionRecoveryExpiryDeadline = deadline
        guard let deadline else { return }
        let generation = connectionGeneration
        let remaining = max(0, deadline.timeIntervalSince(now))
        connectionRecoveryExpiryTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)) } catch { return }
            guard let self, generation == self.connectionGeneration,
                  self.connectionRecoveryExpiryDeadline == deadline else { return }
            self.localConnectionRecovery.expire(ifDeadline: deadline)
            self.connectionRecoveryExpiryTask = nil
            self.connectionRecoveryExpiryDeadline = nil
        }
    }

    func refreshDashboard(enrich: Bool = true) async {
        dashboardEnrichmentTask?.cancel()
        dashboardRequestGeneration += 1
        let generation = dashboardRequestGeneration
        guard bridgeConnected else {
            if isBridgeConnectionChecking { return }
            dashboard = nil
            dashboardErrorMessage = nil
            return
        }
        let connection = connectionGeneration
        do {
            let client = try await bridgeClient()
            let next = try await client.dashboard(
                limit: pageLimit,
                terminalOffset: 0,
                idleOffset: 0,
                enrich: false
            )
            guard !Task.isCancelled, connection == connectionGeneration,
                  generation == dashboardRequestGeneration else { return }
            dashboard = next
            if settings == nil && !interfaceLocalePreviewActive {
                interfaceLocalePreference = next.uiLocalePreference
            }
            lastDashboardRefresh = Date()
            dashboardErrorMessage = nil
            if enrich {
                lastDashboardEnrichment = Date()
                scheduleDashboardEnrichment(generation: generation, terminalOffset: 0, idleOffset: 0)
            }
        } catch {
            guard !Task.isCancelled, connection == connectionGeneration,
                  generation == dashboardRequestGeneration else { return }
            dashboardErrorMessage = localizedErrorDescription(error)
        }
    }

    private func scheduleDashboardEnrichment(
        generation: Int,
        terminalOffset: Int,
        idleOffset: Int,
        bucket: DashboardAppendBucket? = nil,
        requestedOffset: Int = 0
    ) {
        dashboardEnrichmentTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let connection = self.connectionGeneration
            do {
                let client = try await self.bridgeClient()
                let enriched = try await client.dashboard(
                    limit: self.pageLimit,
                    terminalOffset: terminalOffset,
                    idleOffset: idleOffset,
                    enrich: true
                )
                guard !Task.isCancelled,
                      generation == self.dashboardRequestGeneration,
                      connection == self.connectionGeneration else {
                    return
                }
                if let bucket, let current = self.dashboard {
                    self.dashboard = current.mergingPage(
                        enriched,
                        bucket: bucket,
                        requestedOffset: requestedOffset
                    )
                } else {
                    self.dashboard = enriched
                }
                self.lastDashboardRefresh = Date()
                self.dashboardEnrichmentFailed = enriched.enrichment?.hasFailures == true
                self.dashboardEnrichmentPending = enriched.enrichment?.isUpdating == true
                self.dashboardObservationDate = enriched.enrichment?.oldestObservationAt.flatMap { DisplayFormat.parseDate($0) }
            } catch {
                guard !Task.isCancelled,
                      generation == self.dashboardRequestGeneration,
                      connection == self.connectionGeneration else { return }
                self.dashboardEnrichmentFailed = true
                self.dashboardEnrichmentPending = false
            }
        }
    }

    func refreshSettings(refreshModels: Bool = false) async {
        settingsRequestGeneration += 1
        let request = settingsRequestGeneration
        guard bridgeConnected else {
            if isBridgeConnectionChecking { return }
            settings = nil
            settingsLoadErrorMessage = nil
            return
        }
        let generation = connectionGeneration
        do {
            let client = try await bridgeClient()
            let next = try await client.settings(
                refreshModels: refreshModels,
                locale: interfaceLocaleIdentifier
            )
            guard !Task.isCancelled, generation == connectionGeneration,
                  request == settingsRequestGeneration,
                  settingsSnapshotIsCurrent(next) else { return }
            settings = next
            if !interfaceLocalePreviewActive {
                interfaceLocalePreference = next.settings.uiLocalePreference
            }
            settingsLoadErrorMessage = nil
        } catch {
            guard !Task.isCancelled, generation == connectionGeneration,
                  request == settingsRequestGeneration else { return }
            settingsLoadErrorMessage = localizedErrorDescription(error)
        }
    }

    private func settingsSnapshotIsCurrent(_ next: SettingsSnapshot) -> Bool {
        guard let current = settings else { return true }
        return next.settings.settingsRevision >= current.settings.settingsRevision &&
            next.settings.registryRevision >= current.settings.registryRevision
    }

    func refreshRuntimeImpact() async {
        isBusy = true
        defer { isBusy = false }
        runtimeImpact = nil
        runtimeImpactErrorMessage = nil
        let generation = connectionGeneration
        do {
            let client = try await bridgeClient()
            let next = try await client.runtimeStatus(inspectBackgroundProcesses: true)
            guard generation == connectionGeneration else { return }
            runtimeImpact = next
            runtimeImpactErrorMessage = nil
        } catch {
            guard generation == connectionGeneration else { return }
            runtimeImpact = nil
            runtimeImpactErrorMessage = localizedErrorDescription(error)
        }
    }

    func setSettingsWindowVisible(_ visible: Bool) {
        settingsWindowVisible = visible
        if visible {
            settingsInvalidated = true
            enqueueRefresh(["status", "settings", "auth", "codex"])
        } else {
            Task { @MainActor [weak self] in await self?.flushSettingsAutosave() }
        }
        beginChangeWatchingIfNeeded()
    }

    func setDashboardVisible(_ visible: Bool) {
        dashboardVisible = visible
        if visible {
            enqueueRefresh(["status", "dashboard", "auth", "codex"])
        } else {
            refreshEventTasks.removeValue(forKey: "dashboard")?.cancel()
            pendingRefreshEvents.remove("dashboard")
            dashboardRequestGeneration += 1
            dashboardEnrichmentTask?.cancel()
            dashboardEnrichmentTask = nil
        }
        beginChangeWatchingIfNeeded()
    }

    func scheduleSettingsAutosave(_ draft: SettingsDraft) {
        if !settingsAutosaveInProgress,
           let snapshot = settings,
           draft.hasSameEditableValues(as: SettingsDraft(snapshot: snapshot)) {
            settingsAutosaveDebounceTask?.cancel()
            settingsAutosaveDebounceTask = nil
            pendingSettingsDraft = nil
            generalSettingsSaveState = .idle
            settingsErrorMessage = nil
            interfaceLocalePreviewActive = false
            interfaceLocalePreference = snapshot.settings.uiLocalePreference
            return
        }
        pendingSettingsDraft = draft
        generalSettingsSaveState = settingsAutosaveInProgress ? .saving : .pending
        settingsErrorMessage = nil
        settingsAutosaveDebounceTask?.cancel()
        settingsAutosaveDebounceTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: 450_000_000)
            } catch {
                return
            }
            guard let self, !Task.isCancelled else { return }
            self.settingsAutosaveDebounceTask = nil
            await self.drainSettingsAutosave()
        }
    }

    func enableCodexThreadPersistence() {
        guard let snapshot = settings else { return }
        var draft = SettingsDraft(snapshot: snapshot)
        guard !draft.showBridgeThreadsInCodexApp else { return }
        draft.showBridgeThreadsInCodexApp = true
        scheduleSettingsAutosave(draft)
    }

    func cancelPendingSettingsAutosave() {
        settingsAutosaveDebounceTask?.cancel()
        settingsAutosaveDebounceTask = nil
        pendingSettingsDraft = nil
        if !settingsAutosaveInProgress {
            generalSettingsSaveState = .idle
        }
    }

    @discardableResult
    func flushSettingsAutosave() async -> Bool {
        settingsAutosaveDebounceTask?.cancel()
        settingsAutosaveDebounceTask = nil
        while true {
            if settingsAutosaveInProgress {
                try? await Task.sleep(nanoseconds: 50_000_000)
                continue
            }
            if pendingSettingsDraft != nil {
                await drainSettingsAutosave()
                continue
            }
            return generalSettingsSaveState != .failed
        }
    }

    private func drainSettingsAutosave() async {
        if settingsAutosaveInProgress { return }
        settingsAutosaveInProgress = true
        defer { settingsAutosaveInProgress = false }

        var persistedAny = false
        while let requestedDraft = pendingSettingsDraft {
            pendingSettingsDraft = nil
            guard let snapshot = settings else {
                generalSettingsSaveState = .failed
                return
            }
            let draft = requestedDraft.rebased(on: snapshot)
            if draft.hasSameEditableValues(as: SettingsDraft(snapshot: snapshot)) {
                continue
            }
            generalSettingsSaveState = .saving
            guard await saveSettings(draft, autosave: true) else {
                pendingSettingsDraft = nil
                generalSettingsSaveState = .failed
                return
            }
            persistedAny = true
        }
        if persistedAny {
            interfaceLocalePreviewActive = false
            if let preference = settings?.settings.uiLocalePreference {
                interfaceLocalePreference = preference
            }
            generalSettingsSaveState = .saved
        } else {
            interfaceLocalePreviewActive = false
            if let preference = settings?.settings.uiLocalePreference {
                interfaceLocalePreference = preference
            }
            generalSettingsSaveState = .idle
        }
    }

    func refreshLoginItemStatus() {
        menuBarLoginItemStatus = loginItemController.status
    }

    func setMenuBarLaunchAtLogin(_ enabled: Bool) {
        guard !loginItemOperationInProgress else { return }
        refreshLoginItemStatus()
        if enabled && menuBarLoginItemStatus == .requiresApproval {
            loginItemController.openSystemSettings()
            return
        }
        guard menuBarLoginItemStatus.isEnabled != enabled else { return }

        loginItemOperationInProgress = true
        loginItemErrorMessage = nil
        defer {
            refreshLoginItemStatus()
            loginItemOperationInProgress = false
        }
        do {
            if enabled {
                try loginItemController.register()
            } else {
                try loginItemController.unregister()
            }
        } catch {
            loginItemErrorMessage = BridgeAppLocalization.format(
                "로그인 시 실행 설정을 변경하지 못했습니다: %@",
                locale: interfaceLocale,
                localizedErrorDescription(error)
            )
        }
    }

    func openLoginItemsSystemSettings() {
        loginItemController.openSystemSettings()
    }

    func refreshAuthStatus() async {
        authRefreshPending = true
        if let task = authRefreshTask { await task.value; return }
        let generation = connectionGeneration
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            while self.authRefreshPending, !Task.isCancelled, generation == self.connectionGeneration {
                self.authRefreshPending = false
                await self.refreshAuthStatusOnce()
            }
        }
        authRefreshTask = task
        await task.value
        if generation == connectionGeneration { authRefreshTask = nil }
    }

    private func refreshAuthStatusOnce() async {
        let generation = connectionGeneration
        guard !isRemoteClient else {
            authStatus = nil
            authErrorMessage = nil
            return
        }
        guard helperStatus != nil else {
            authStatus = nil
            return
        }
        do {
            let client = await helperClient()
            let next = try await client.authStatus()
            guard generation == connectionGeneration, !isRemoteClient else { return }
            authStatus = next
            authErrorMessage = nil
            if authStatus?.authenticated == true {
                loginInProgress = false
                loginPollingTask?.cancel()
                loginPollingTask = nil
            }
        } catch {
            guard generation == connectionGeneration, !isRemoteClient else { return }
            authStatus = nil
            authErrorMessage = localizedErrorDescription(error)
        }
    }

    func saveSetup(apiKey: String, tunnelId: String) async -> Bool {
        guard !isRemoteClient else { return false }
        return await performRuntime {
            let client = await self.helperClient()
            let result = try await client.applySetup(
                apiKey: apiKey.isEmpty ? nil : apiKey,
                tunnelId: tunnelId.isEmpty ? nil : tunnelId,
                force: false,
                timeoutMilliseconds: 60_000
            )
            self.helperStatus = result.status
            await self.refreshAll()
        }
    }

    func refreshSetupDiscovery() async {
        let generation = connectionGeneration
        guard !isRemoteClient, helperStatus != nil else {
            setupDiscovery = nil
            setupDiscoveryErrorMessage = nil
            return
        }
        do {
            let client = await helperClient()
            let discovery = try await client.discoverSetup()
            guard generation == connectionGeneration, !isRemoteClient else { return }
            setupDiscovery = discovery
            setupDiscoveryErrorMessage = nil
        } catch {
            guard generation == connectionGeneration, !isRemoteClient else { return }
            setupDiscovery = nil
            setupDiscoveryErrorMessage = localizedErrorDescription(error)
        }
    }

    func importDiscoveredSetup(candidateId: String) async -> Bool {
        guard !isRemoteClient else { return false }
        let succeeded = await performRuntime {
            let client = await self.helperClient()
            let result = try await client.importSetup(
                candidateId: candidateId,
                force: false,
                timeoutMilliseconds: 60_000
            )
            self.helperStatus = result.status
            self.setupDiscovery = nil
            self.setupDiscoveryErrorMessage = nil
            await self.refreshAll()
        }
        if !succeeded { await refreshSetupDiscovery() }
        return succeeded
    }

    func manageCodex(_ request: CodexRuntimeRequest) async {
        guard !isRemoteClient else { return }
        let kind = request.kind ?? "cli"
        if request.action == "status" {
            await loadCodexRuntime(kind: kind, includeAccount: request.includeAccount ?? true)
            return
        }
        if request.action == "check-updates" {
            guard !checkingCodexUpdates.contains(kind) else { return }
            checkingCodexUpdates.insert(kind)
        }
        defer { checkingCodexUpdates.remove(kind) }
        do {
            let client = await helperClient()
            _ = try await client.codexRuntime(request)
            // Actions return installation state only. Publish a complete status so
            // account/authentication sections do not disappear between requests.
            await loadCodexRuntime(kind: kind, force: true)
        } catch {
            await loadCodexRuntime(kind: kind, force: true)
            setCodexRuntimeError(localizedErrorDescription(error), kind: kind)
        }
    }

    private func loadCodexRuntime(kind: String, includeAccount: Bool = true, force: Bool = false) async {
        guard !isRemoteClient else { return }
        guard force || codexRuntimeReads[kind, default: 0] == 0 else {
            codexRuntimePendingReads.insert(kind)
            return
        }
        codexRuntimeReads[kind, default: 0] += 1
        defer {
            codexRuntimeReads[kind, default: 1] -= 1
            if codexRuntimeReads[kind, default: 0] == 0, codexRuntimePendingReads.remove(kind) != nil {
                enqueueRefresh(["codex"])
            }
        }
        codexRuntimeReadRevision[kind, default: 0] += 1
        let revision = codexRuntimeReadRevision[kind], connection = connectionGeneration
        do {
            let client = await helperClient()
            let next = try await client.codexRuntime(.init(action: "status", kind: kind, includeAccount: includeAccount))
            guard connection == connectionGeneration, !isRemoteClient, revision == codexRuntimeReadRevision[kind] else { return }
            if codexRuntime != next { codexRuntime = next }
            setCodexRuntimeError(nil, kind: kind)
        } catch {
            guard connection == connectionGeneration, revision == codexRuntimeReadRevision[kind] else { return }
            setCodexRuntimeError(localizedErrorDescription(error), kind: kind)
        }
    }

    private func setCodexRuntimeError(_ message: String?, kind: String) {
        if codexRuntimeError != message { codexRuntimeError = message }
    }

    func configureRuntime(
        defaultBackend: String,
        maximumAccess: String,
        force: Bool = false
    ) async -> Bool {
        guard !isRemoteClient else { return false }
        return await performRuntime {
            let client = await self.helperClient()
            let result = try await client.configureRuntime(
                defaultBackend: defaultBackend,
                maximumAccess: maximumAccess,
                force: force,
                timeoutMilliseconds: 60_000
            )
            self.helperStatus = result.status
            await self.refreshAll()
        }
    }

    func repairConfigurationPermissions() async -> Bool {
        guard !isRemoteClient else { return false }
        return await performRuntime {
            let client = await self.helperClient()
            _ = try await client.repairConfigurationPermissions()
            await self.refreshStatus()
            if self.helperStatus?.configuration.valid == true {
                self.helperStatus = try await client.startRuntime()
                await self.refreshAll()
            }
        }
    }

    func launchCodexLogin() async -> Bool {
        guard !isRemoteClient else { return false }
        isBusy = true
        defer { isBusy = false }
        authErrorMessage = nil
        let generation = connectionGeneration
        do {
            let client = await helperClient()
            let current = try await client.authStatus()
            guard generation == connectionGeneration, !isRemoteClient else { return false }
            authStatus = current
            if current.authenticated {
                loginInProgress = false
                loginPollingTask?.cancel()
                loginPollingTask = nil
                return true
            }
            guard current.installed else { return false }
            _ = try await client.startLogin()
            guard generation == connectionGeneration, !isRemoteClient else { return false }
            loginInProgress = true
            beginLoginPolling()
            return true
        } catch {
            authErrorMessage = localizedErrorDescription(error)
            return false
        }
    }

    func startRuntime() async -> Bool {
        guard !isRemoteClient else { return false }
        return await performRuntime {
            let client = await self.helperClient()
            self.helperStatus = try await client.startRuntime()
            await self.refreshAll()
        }
    }

    func stopRuntime(force: Bool) async -> Bool {
        guard !isRemoteClient else { return false }
        let succeeded = await performRuntime {
            let client = await self.helperClient()
            self.helperStatus = try await client.stopRuntime(
                force: force,
                timeoutMilliseconds: 60_000
            )
            self.dashboard = nil
            self.settings = nil
        }
        if !succeeded {
            await refreshStatus()
            await refreshDashboard()
        }
        return succeeded
    }

    func shutdownApplication(force: Bool) async -> Bool {
        if applicationShutdownCompleted { return true }
        guard !applicationShutdownInProgress else { return false }
        applicationShutdownInProgress = true
        isBusy = true
        runtimeErrorMessage = nil
        runtimeFailureCanRetryWithForce = false
        defer {
            applicationShutdownInProgress = false
            isBusy = false
        }

        guard await flushSettingsAutosave() else {
            runtimeErrorMessage = BridgeAppLocalization.string(
                "설정 변경사항을 저장하지 못해 앱을 종료하지 않았습니다. 저장 오류를 해결한 뒤 다시 시도해 주세요.",
                locale: interfaceLocale
            )
            return false
        }
        if isRemoteClient {
            applicationShutdownCompleted = true
            cancelAllPolling()
            setRemotePairingInvitation(nil)
            connectionGeneration += 1
            invalidateRemoteClient()
            dashboardRequestGeneration += 1
            connectionContextID = UUID()
            remoteHello = nil
            dashboard = nil
            settings = nil
            authStatus = nil
            return true
        }
        let paths = await resolvedPaths()
        let client = await helperClient()
        do {
            do {
                let stopped = try await client.prepareApplicationShutdown(
                    force: force,
                    timeoutMilliseconds: 60_000
                )
                guard stopped.phase == "stopped", stopped.pid == nil else {
                    throw NSError(
                        domain: "CodexBridgeApplicationShutdown",
                        code: 1,
                        userInfo: [
                            NSLocalizedDescriptionKey:
                                "RUNTIME_STOP_INCOMPLETE: The managed runtime still reports phase \(stopped.phase)."
                        ]
                    )
                }
                helperStatus = stopped
            } catch {
                let runtimeLockExists = FileManager.default.fileExists(
                    atPath: paths.runtimeLockDirectory.path
                )
                let helperSocketExists = FileManager.default.fileExists(
                    atPath: paths.helperSocket.path
                )
                guard !runtimeLockExists && !helperSocketExists else { throw error }
                logger.warning(
                    "verified shutdown RPC was unavailable with no helper socket or runtime lock; unloading the inactive service: \(error.localizedDescription, privacy: .public)"
                )
            }

            try await bootstrapper.shutdown(paths: paths)
            applicationShutdownCompleted = true
            cancelAllPolling()
            setRemotePairingInvitation(nil)
            helperStatus = nil
            dashboard = nil
            settings = nil
            authStatus = nil
            return true
        } catch {
            let message = localizedApplicationShutdownError(error)
            runtimeErrorMessage = message
            logger.error("application shutdown failed: \(message, privacy: .public)")
            await refreshStatus()
            await refreshDashboard()
            return false
        }
    }

    func restartRuntime(force: Bool) async -> Bool {
        guard !isRemoteClient else { return false }
        let succeeded = await performRuntime {
            let client = await self.helperClient()
            self.helperStatus = try await client.restartRuntime(
                force: force,
                timeoutMilliseconds: 60_000
            )
            await self.refreshAll()
        }
        if !succeeded {
            await refreshStatus()
            await refreshDashboard()
        }
        return succeeded
    }

    func repairTunnelProfile(force: Bool = false) async -> Bool {
        guard !isRemoteClient else { return false }
        let succeeded = await performRuntime {
            let client = await self.helperClient()
            self.helperStatus = try await client.repairRuntime(
                force: force,
                timeoutMilliseconds: 60_000
            )
            await self.refreshAll()
        }
        if !succeeded {
            await refreshStatus()
            await refreshDashboard()
        }
        return succeeded
    }

    private func saveSettings(_ draft: SettingsDraft, autosave: Bool) async -> Bool {
        guard let snapshot = settings else { return false }
        settingsErrorMessage = nil
        let displayedChoices = Dictionary(
            uniqueKeysWithValues: SettingsDraft.displayedChoices(
                in: snapshot,
                allowDelegation: draft.allowDelegation,
                preservingKeys: draft.explicitSelectionKeys.union([
                    draft.fixedSelectionKey
                ])
            ).map { ($0.key, $0) }
        )
        let selectableKeys = Set(SettingsDraft.selectableChoices(
            in: snapshot,
            allowDelegation: draft.allowDelegation
        ).map(\.key))
        var policy: ModelPolicy?
        if draft.modelPolicyDirty {
            if draft.policyMode == "fixed" {
                guard let choice = displayedChoices[draft.fixedSelectionKey],
                      selectableKeys.contains(choice.key) else {
                    settingsErrorMessage = BridgeAppLocalization.string(
                        "현재 사용할 수 있는 고정 모델과 추론 수준을 선택해 주세요.",
                        locale: interfaceLocale
                    )
                    return false
                }
                policy = ModelPolicy(
                    mode: "fixed",
                    selection: choice,
                    constraints: ModelPolicyConstraints(allowDelegation: draft.allowDelegation)
                )
            } else {
                let allowed: AllowedSelections
                if draft.allowedKind == "explicit" {
                    let selectedKeys = draft.explicitSelectionKeys
                    guard selectedKeys.allSatisfy(selectableKeys.contains) else {
                        settingsErrorMessage = BridgeAppLocalization.string(
                            "현재 사용할 수 없는 저장된 모델 조합을 허용 목록에서 해제해 주세요.",
                            locale: interfaceLocale
                        )
                        return false
                    }
                    let selections = selectedKeys.compactMap { displayedChoices[$0] }.sorted {
                        $0.key < $1.key
                    }
                    guard !selections.isEmpty else {
                        settingsErrorMessage = BridgeAppLocalization.string(
                            "자동 정책의 명시적 허용 목록을 하나 이상 선택해 주세요.",
                            locale: interfaceLocale
                        )
                        return false
                    }
                    allowed = AllowedSelections(kind: "explicit", selections: selections)
                } else {
                    allowed = AllowedSelections(kind: "catalog-visible")
                }
                policy = ModelPolicy(
                    mode: "automatic",
                    allowedSelections: allowed,
                    constraints: ModelPolicyConstraints(allowDelegation: draft.allowDelegation)
                )
            }
        }

        let mutation = SettingsMutation(
            expectedSettingsRevision: draft.expectedSettingsRevision,
            expectedRegistryRevision: nil,
            operation: .patch(SettingsPatch(
                accessStrategy: draft.accessStrategy,
                modelPolicy: policy,
                usePriorityServiceTier: draft.usePriorityServiceTier,
                uiLocalePreference: draft.uiLocalePreference,
                maxConcurrentJobs: draft.maxConcurrentJobs,
                showBridgeThreadsInCodexApp: draft.showBridgeThreadsInCodexApp,
                activityCard: ActivityCardPatch(
                    visibility: draft.activityCardVisibility,
                    completionHandoff: draft.completionHandoff
                )
            ))
        )
        return await performSettingsMutation(
            mutation,
            tracksGlobalBusyState: !autosave,
            autosavedDraft: autosave ? draft : nil
        )
    }

    func resetGeneralSettings() async -> Bool {
        guard let snapshot = settings else { return false }
        return await performSettingsMutation(SettingsMutation(
            expectedSettingsRevision: snapshot.settings.settingsRevision,
            expectedRegistryRevision: nil,
            operation: .reset
        ))
    }

    func applyProjectOperation(_ operation: ProjectOperation) async -> Bool {
        guard let snapshot = settings else { return false }
        return await performSettingsMutation(SettingsMutation(
            expectedSettingsRevision: nil,
            expectedRegistryRevision: snapshot.settings.registryRevision,
            operation: .patch(SettingsPatch(projectOperations: [operation]))
        ))
    }

    func loadMoreRecent() async {
        guard let current = dashboard, current.pagination.terminal.hasNext else { return }
        let nextOffset = current.pagination.terminal.offset + current.pagination.terminal.returned
        dashboardEnrichmentTask?.cancel()
        dashboardRequestGeneration += 1
        let generation = dashboardRequestGeneration
        let connection = connectionGeneration
        _ = await performDashboard {
            let client = try await self.bridgeClient()
            let page = try await client.dashboard(
                limit: self.pageLimit,
                terminalOffset: nextOffset,
                idleOffset: 0,
                enrich: false
            )
            guard connection == self.connectionGeneration else { return }
            self.dashboard = current.mergingPage(
                page,
                bucket: .terminal,
                requestedOffset: nextOffset
            )
            self.lastDashboardRefresh = Date()
            self.scheduleDashboardEnrichment(
                generation: generation,
                terminalOffset: nextOffset,
                idleOffset: 0,
                bucket: .terminal,
                requestedOffset: nextOffset
            )
        }
    }

    func loadMoreIdle() async {
        guard let current = dashboard, current.pagination.idle.hasNext else { return }
        let nextOffset = current.pagination.idle.offset + current.pagination.idle.returned
        dashboardEnrichmentTask?.cancel()
        dashboardRequestGeneration += 1
        let generation = dashboardRequestGeneration
        let connection = connectionGeneration
        _ = await performDashboard {
            let client = try await self.bridgeClient()
            let page = try await client.dashboard(
                limit: self.pageLimit,
                terminalOffset: 0,
                idleOffset: nextOffset,
                enrich: false
            )
            guard connection == self.connectionGeneration else { return }
            self.dashboard = current.mergingPage(
                page,
                bucket: .idle,
                requestedOffset: nextOffset
            )
            self.lastDashboardRefresh = Date()
            self.scheduleDashboardEnrichment(
                generation: generation,
                terminalOffset: 0,
                idleOffset: nextOffset,
                bucket: .idle,
                requestedOffset: nextOffset
            )
        }
    }

    func refreshLogs() async {
        guard !isRemoteClient else {
            logs = []
            logsErrorMessage = nil
            return
        }
        do {
            let client = await helperClient()
            logs = try await client.logs(limit: 100).entries
            logsErrorMessage = nil
        } catch {
            logsErrorMessage = localizedErrorDescription(error)
        }
    }

    private func performSettingsMutation(
        _ mutation: SettingsMutation,
        tracksGlobalBusyState: Bool = true,
        autosavedDraft: SettingsDraft? = nil
    ) async -> Bool {
        if tracksGlobalBusyState { isBusy = true }
        defer {
            if tracksGlobalBusyState { isBusy = false }
        }
        settingsErrorMessage = nil
        // A saved response must not be replaced by a read started before save.
        settingsRequestGeneration += 1
        let generation = connectionGeneration
        do {
            let client = try await bridgeClient()
            let updated = try await client.updateSettings(mutation)
            guard generation == connectionGeneration else { return false }
            guard settingsSnapshotIsCurrent(updated) else { return true }
            settingsRequestGeneration += 1
            if let autosavedDraft {
                lastAutosavedSettingsRevision = updated.settings.settingsRevision
                lastAutosavedDraft = autosavedDraft
            }
            settings = updated
            settingsConflictMessage = nil
            return true
        } catch {
            guard generation == connectionGeneration else { return false }
            let message = error.localizedDescription
            if message.contains("REVISION_CONFLICT") {
                if autosavedDraft == nil {
                    settingsConflictMessage =
                        BridgeAppLocalization.string(
                            "다른 화면에서 설정이 변경되었습니다. 최신 값을 확인한 뒤 다시 시도해 주세요.",
                            locale: interfaceLocale
                        )
                }
                await refreshSettings()
            }
            settingsErrorMessage = localizedErrorDescription(error)
            return false
        }
    }

    private func performRuntime(_ operation: () async throws -> Void) async -> Bool {
        isBusy = true
        defer { isBusy = false }
        runtimeErrorMessage = nil
        runtimeFailureCanRetryWithForce = false
        do {
            try await operation()
            return true
        } catch {
            let diagnosticMessage = error.localizedDescription
            runtimeFailureCanRetryWithForce = diagnosticMessage.contains("DRAIN_TIMEOUT") ||
                diagnosticMessage.contains("BACKGROUND_PROCESS")
            runtimeErrorMessage = localizedErrorDescription(error)
            return false
        }
    }

    private func localizedErrorDescription(_ error: Error) -> String {
        BridgeAppLocalization.errorDescription(error, locale: interfaceLocale)
    }

    private func localizedApplicationShutdownError(_ error: Error) -> String {
        let message = error.localizedDescription
        if message.contains("DRAIN_TIMEOUT") {
            return BridgeAppLocalization.string(
                "진행 중인 작업이 제한 시간 안에 끝나지 않아 종료하지 않았습니다. 강제 종료 여부를 확인해 주세요.",
                locale: interfaceLocale
            )
        }
        if message.contains("BACKGROUND_PROCESS_STATE_UNKNOWN") {
            return BridgeAppLocalization.string(
                "일부 Agent의 백그라운드 프로세스 상태를 확인할 수 없어 안전 종료하지 않았습니다. 강제 종료 여부를 확인해 주세요.",
                locale: interfaceLocale
            )
        }
        if message.contains("BACKGROUND_PROCESSES_ACTIVE") {
            return BridgeAppLocalization.string(
                "백그라운드 프로세스가 실행 중이어서 안전 종료하지 않았습니다. 강제 종료하면 해당 프로세스도 중단됩니다.",
                locale: interfaceLocale
            )
        }
        return BridgeAppLocalization.format(
            "앱과 관련 프로세스를 모두 종료하지 못했습니다: %@",
            locale: interfaceLocale,
            localizedErrorDescription(error)
        )
    }

    private func stopLocalOwnershipForModeSwitch(force: Bool) async throws {
        let paths = await resolvedPaths()
        let client = await helperClient()
        do {
            let stopped = try await client.prepareApplicationShutdown(
                force: force,
                timeoutMilliseconds: 60_000
            )
            guard stopped.phase == "stopped", stopped.pid == nil else {
                throw NSError(
                    domain: "CodexBridgeModeSwitch",
                    code: 1,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "RUNTIME_STOP_INCOMPLETE: The managed runtime still reports phase \(stopped.phase)."
                    ]
                )
            }
        } catch {
            let runtimeLockExists = FileManager.default.fileExists(
                atPath: paths.runtimeLockDirectory.path
            )
            let helperSocketExists = FileManager.default.fileExists(
                atPath: paths.helperSocket.path
            )
            guard !runtimeLockExists && !helperSocketExists else { throw error }
        }
        try await bootstrapper.shutdown(paths: paths)
        helperStatus = nil
        authStatus = nil
        setupDiscovery = nil
    }

    private func resetConnectionContext() {
        authRefreshTask?.cancel()
        authRefreshTask = nil
        authRefreshPending = false
        codexRuntimePendingReads.removeAll()
        cancelChangeWatching()
        statusRefreshTask?.cancel()
        statusRefreshTask = nil
        statusRefreshPending = false
        for task in refreshEventTasks.values { task.cancel() }
        refreshEventTasks.removeAll()
        refreshEventTaskIDs.removeAll()
        pendingRefreshEvents.removeAll()
        lastScheduledRefresh.removeAll()
        lastDashboardEnrichment = nil
        connectionRecoveryExpiryTask?.cancel()
        connectionRecoveryExpiryTask = nil
        localConnectionRecovery = ConnectionRecoveryWindow()
        systemObservationPending = false
        dashboardEnrichmentPending = false
        dashboardObservationDate = nil
        dashboardEnrichmentInvalidated = false
        statusRequestGeneration += 1
        remoteOperationalProblem = nil
        operationalActionRequiredProblem = nil
        cancelBridgeReadinessPolling()
        connectionGeneration += 1
        invalidateRemoteClient()
        connectionContextID = UUID()
        dashboardRequestGeneration += 1
        dashboardEnrichmentTask?.cancel()
        dashboardEnrichmentTask = nil
        settingsAutosaveDebounceTask?.cancel()
        settingsAutosaveDebounceTask = nil
        pendingSettingsDraft = nil
        settingsAutosaveInProgress = false
        generalSettingsSaveState = .idle
        dashboard = nil
        settings = nil
        authStatus = nil
        setupDiscovery = nil
        remoteHello = nil
        runtimeImpact = nil
        setRemotePairingInvitation(nil)
        dashboardErrorMessage = nil
        settingsLoadErrorMessage = nil
        settingsErrorMessage = nil
        settingsConflictMessage = nil
        runtimeImpactErrorMessage = nil
        statusErrorMessage = nil
        authErrorMessage = nil
        setupDiscoveryErrorMessage = nil
        if isRemoteClient {
            helperStatus = nil
            logs = []
        } else {
            remoteManagementStatus = nil
        }
    }

    private func updateActiveProfile(from hello: RemoteCompanionHello) {
        guard let serverId = connectionPreferences.activeServerId,
              let index = connectionPreferences.profiles.firstIndex(where: {
                  $0.serverId == serverId
              }) else {
            return
        }
        var profile = connectionPreferences.profiles[index]
        let now = Date()
        let formatter = ISO8601DateFormatter()
        let lastConnectedAt = profile.lastConnectedAt.flatMap(formatter.date(from:))
        let metadataChanged = profile.serverDisplayName != hello.server.displayName ||
            profile.bridgeVersion != hello.bridge.version ||
            profile.bridgeBuildId != hello.bridge.buildId ||
            profile.capabilities != hello.capabilities
        let heartbeatDue = lastConnectedAt.map {
            now.timeIntervalSince($0) >= profileHeartbeatInterval
        } ?? true
        guard metadataChanged || heartbeatDue else { return }
        profile.serverDisplayName = hello.server.displayName
        profile.bridgeVersion = hello.bridge.version
        profile.bridgeBuildId = hello.bridge.buildId
        profile.capabilities = hello.capabilities
        profile.lastConnectedAt = formatter.string(from: now)
        connectionPreferences.profiles[index] = profile
        do {
            try connectionStore?.save(connectionPreferences)
        } catch {
            connectionErrorMessage = localizedErrorDescription(error)
        }
    }

    private func setRemotePairingInvitation(_ invitation: RemotePairingInvitation?) {
        remotePairingExpirationTask?.cancel()
        remotePairingExpirationTask = nil
        remotePairingInvitation = invitation
        guard let invitation,
              let expiration = remotePairingExpirationDate(invitation.expiresAt) else {
            return
        }
        let delay = expiration.timeIntervalSinceNow
        guard delay > 0 else {
            remotePairingInvitation = nil
            return
        }
        let expectedInvitation = invitation.invitation
        let nanoseconds = UInt64(min(delay, 900) * 1_000_000_000)
        remotePairingExpirationTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: nanoseconds)
            } catch {
                return
            }
            guard let self,
                  !Task.isCancelled,
                  self.remotePairingInvitation?.invitation == expectedInvitation else {
                return
            }
            self.remotePairingInvitation = nil
            self.remotePairingExpirationTask = nil
        }
    }

    private func remotePairingExpirationDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    func cancelAllPolling() {
        cancelChangeWatching()
        statusRefreshTask?.cancel()
        statusRefreshTask = nil
        statusRefreshPending = false
        for task in refreshEventTasks.values { task.cancel() }
        refreshEventTasks.removeAll()
        refreshEventTaskIDs.removeAll()
        pendingRefreshEvents.removeAll()
        notificationRefreshTask?.cancel()
        notificationRefreshTask = nil
        notificationsStarted = false
        networkMonitor?.cancel()
        networkMonitor = nil
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObservers.removeAll()
        connectionRecoveryExpiryTask?.cancel()
        connectionRecoveryExpiryTask = nil
        pollingTask?.cancel()
        pollingTask = nil
        cancelBridgeReadinessPolling()
        loginPollingTask?.cancel()
        loginPollingTask = nil
        authRefreshTask?.cancel()
        authRefreshTask = nil
        authRefreshPending = false
        codexRuntimePendingReads.removeAll()
        dashboardEnrichmentTask?.cancel()
        dashboardEnrichmentTask = nil
    }

    private var shouldPollForBridgeReadiness: Bool {
        guard !isRemoteClient, !needsSetup else { return false }
        if localConnectionRecovery.isChecking || isTunnelConnectionChecking { return true }
        return helperStatus?.phase == "starting" ||
            (helperStatus == nil && statusErrorMessage == nil && startupErrorMessage == nil)
    }

    private func cancelBridgeReadinessPolling() {
        bridgeReadinessTaskGeneration += 1
        bridgeReadinessTask?.cancel()
        bridgeReadinessTask = nil
    }

    private func beginBridgeReadinessPollingIfNeeded() {
        guard shouldPollForBridgeReadiness, bridgeReadinessTask == nil else { return }

        let taskGeneration = bridgeReadinessTaskGeneration
        let expectedConnectionGeneration = connectionGeneration
        bridgeReadinessTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.bridgeReadinessTaskGeneration == taskGeneration {
                    self.bridgeReadinessTask = nil
                }
            }

            for _ in 0..<60 {
                do {
                    try await Task.sleep(nanoseconds: self.localConnectionRecovery.isChecking ? 1_000_000_000 : 500_000_000)
                } catch {
                    return
                }
                guard !Task.isCancelled,
                      expectedConnectionGeneration == self.connectionGeneration,
                      self.shouldPollForBridgeReadiness else {
                    return
                }

                let hadHelperStatus = self.helperStatus != nil
                let wasBridgeConnected = self.bridgeConnected
                await self.refreshStatus()
                guard !Task.isCancelled,
                      expectedConnectionGeneration == self.connectionGeneration else {
                    return
                }

                if !hadHelperStatus,
                   self.helperStatus != nil,
                   self.authStatus == nil,
                   self.authErrorMessage == nil {
                    await self.refreshAuthStatus()
                    guard !Task.isCancelled,
                          expectedConnectionGeneration == self.connectionGeneration else {
                        return
                    }
                }
                if self.needsSetup {
                    await self.refreshSetupDiscovery()
                    return
                }
                if !wasBridgeConnected, self.bridgeConnected {
                    self.logger.info("bridge became ready; refreshing startup content immediately")
                    await self.refreshBridgeContent()
                    if !self.shouldPollForBridgeReadiness { return }
                }
                guard self.shouldPollForBridgeReadiness else { return }
            }
        }
    }

    private func performDashboard(_ operation: () async throws -> Void) async -> Bool {
        isBusy = true
        defer { isBusy = false }
        dashboardErrorMessage = nil
        do {
            try await operation()
            return true
        } catch {
            dashboardErrorMessage = localizedErrorDescription(error)
            return false
        }
    }

    private func beginLoginPolling() {
        loginPollingTask?.cancel()
        loginPollingTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for _ in 0..<60 {
                if Task.isCancelled { return }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled { return }
                await self.refreshAuthStatus()
                if self.authStatus?.authenticated == true { return }
            }
            self.loginInProgress = false
        }
    }

    private func beginPolling() {
        beginChangeWatchingIfNeeded()
        beginSystemEventsIfNeeded()
        guard pollingTask == nil else { return }
        pollingTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                guard let self, !Task.isCancelled else { return }
                let wasConnected = self.bridgeConnected
                await self.refreshStatus()
                guard !Task.isCancelled else { return }
                if !wasConnected, self.bridgeConnected {
                    self.enqueueRefresh(["dashboard", "settings", "auth", "codex"])
                }
                self.scheduleBackgroundRefreshes()
                self.scheduleOperationalObservation()
            }
        }
    }

    func scheduleBackgroundRefreshes(at now: Date = Date()) {
        func due(_ topic: String, every interval: TimeInterval) -> Bool {
            lastScheduledRefresh[topic].map { now.timeIntervalSince($0) >= interval } ?? true
        }
        if dashboardVisible, due("dashboard", every: companionChangesAvailable ? 30 : 10) {
            enqueueRefresh(["dashboard"])
        }
        if settingsWindowVisible, settingsInvalidated || due("settings", every: 60) {
            enqueueRefresh(["settings"])
        }
        if !isRemoteClient {
            if due("auth", every: 300) { enqueueRefresh(["auth"]) }
            if !codexSettingsVisible, due("codex", every: 300) { enqueueRefresh(["codex"]) }
        }
    }

    func refreshAfterSystemEvent() {
        guard !applicationShutdownInProgress, !applicationShutdownCompleted, pollingTask != nil else { return }
        // Expire freshness on wake: elapsed sleep is not observed connectivity.
        statusRequestGeneration += 1
        systemObservationPending = true
        // A startup caller awaiting the current read must also await the fresh
        // observation, instead of returning before the debounced event runs.
        if statusRefreshTask != nil { statusRefreshPending = true }
        if !isRemoteClient, !localConnectionRecovery.isChecking {
            localConnectionRecovery.begin()
            scheduleConnectionRecoveryExpiry()
        }
        lastScheduledRefresh.removeAll()
        lastDashboardEnrichment = nil
        enqueueRefresh(["status", "dashboard", "settings", "auth", "codex"])
        beginChangeWatchingIfNeeded()
        refreshLoginItemStatus()
    }

    private func beginSystemEventsIfNeeded() {
        guard networkMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshAfterSystemEvent() }
        }
        monitor.start(queue: DispatchQueue(label: "bridge.network-changes", qos: .utility))
        networkMonitor = monitor
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in self?.refreshAfterSystemEvent() }
            })
        }
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in self?.prepareForSystemSleep() }
            })
        }
    }

    func prepareForSystemSleep() {
        systemObservationPending = true
        statusRequestGeneration += 1
        connectionRecoveryExpiryTask?.cancel()
        connectionRecoveryExpiryTask = nil
        localConnectionRecovery = ConnectionRecoveryWindow()
        scheduleOperationalObservation()
    }

    private func enqueueRefresh(_ topics: Set<String>) {
        guard !applicationShutdownInProgress, !applicationShutdownCompleted else { return }
        var topics = topics
        if topics.remove("enrichment") != nil {
            dashboardEnrichmentInvalidated = true
            topics.insert("dashboard")
        }
        for topic in topics {
            if topic == "dashboard", !dashboardVisible { continue }
            if topic == "settings", !settingsWindowVisible { settingsInvalidated = true; continue }
            if ["auth", "codex"].contains(topic), isRemoteClient { continue }
            pendingRefreshEvents.insert(topic)
            guard refreshEventTasks[topic] == nil else { continue }
            let generation = connectionGeneration
            let taskID = UUID()
            refreshEventTaskIDs[topic] = taskID
            refreshEventTasks[topic] = Task { @MainActor [weak self] in
                guard let self else { return }
                defer {
                    if generation == self.connectionGeneration, self.refreshEventTaskIDs[topic] == taskID {
                        self.refreshEventTasks[topic] = nil
                        self.refreshEventTaskIDs[topic] = nil
                    }
                }
                while !Task.isCancelled, generation == self.connectionGeneration, self.pendingRefreshEvents.remove(topic) != nil {
                    do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
                    // All arrivals during the debounce belong to this read.
                    self.pendingRefreshEvents.remove(topic)
                    guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                    self.lastScheduledRefresh[topic] = Date()
                    switch topic {
                    case "status": await self.refreshStatus()
                    case "dashboard":
                        if self.dashboardVisible {
                            let enrich = self.dashboardEnrichmentInvalidated || (self.lastDashboardEnrichment.map { Date().timeIntervalSince($0) >= 30 } ?? true)
                            self.dashboardEnrichmentInvalidated = false
                            await self.refreshDashboard(enrich: enrich)
                        }
                    case "settings":
                        if self.settingsWindowVisible, !self.isBusy, !self.settingsAutosaveInProgress, self.pendingSettingsDraft == nil {
                            self.settingsInvalidated = false
                            await self.refreshSettings()
                        } else { self.settingsInvalidated = true }
                    case "auth": await self.refreshAuthStatus()
                    case "codex":
                        await self.loadCodexRuntime(kind: "cli", includeAccount: self.codexRuntime?.isInstalling != true)
                    default: break
                    }
                }
            }
        }
    }

    private func beginChangeWatchingIfNeeded() {
        guard !applicationShutdownInProgress, !applicationShutdownCompleted, !isRemoteClient else { return }
        let generation = connectionGeneration
        if helperChangesTask == nil, !helperChangesUnsupported {
            helperChangesTask = Task { @MainActor [weak self] in
                guard let self else { return }
                let client = await self.helperClient()
                var revision: String?
                var failures = 0
                while !Task.isCancelled, generation == self.connectionGeneration {
                    do {
                        let notice = try await client.waitForChanges(after: revision)
                        guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                        self.helperChangesAvailable = true
                        revision = notice.revision
                        failures = 0
                        var topics = Set<String>()
                        if notice.topics.contains("runtime") { topics.insert("status") }
                        if notice.topics.contains("configuration") { topics.formUnion(["status", "settings", "auth", "codex"]) }
                        if notice.topics.contains("auth") { topics.formUnion(["auth", "codex"]) }
                        if notice.topics.contains("installation") { topics.insert("codex") }
                        self.enqueueRefresh(topics)
                    } catch {
                        guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                        self.helperChangesAvailable = false
                        if let error = error as? LocalRPCError, error.isUnsupportedMethod {
                            self.helperChangesUnsupported = true
                            return
                        }
                        self.enqueueRefresh(["status"])
                        failures += 1
                        do { try await Task.sleep(for: .seconds(min(30, pow(2, Double(min(failures - 1, 5)))))) } catch { return }
                    }
                }
            }
        }
        guard dashboardVisible || settingsWindowVisible else {
            companionChangesTask?.cancel()
            companionChangesTask = nil
            return
        }
        guard companionChangesTask == nil, !companionChangesUnsupported, bridgeConnected else { return }
        companionChangesTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let paths = await self.resolvedPaths()
            let client = BridgeCompanionClient(socketPath: paths.bridgeSocket.path)
            var revision: String?
            var failures = 0
            while !Task.isCancelled, generation == self.connectionGeneration {
                do {
                    let notice = try await client.waitForChanges(after: revision)
                    guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                    self.companionChangesAvailable = true
                    revision = notice.revision
                    failures = 0
                    self.enqueueRefresh(Set(notice.topics))
                } catch {
                    guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                    self.companionChangesAvailable = false
                    if let error = error as? LocalRPCError, error.isUnsupportedMethod {
                        self.companionChangesUnsupported = true
                        return
                    }
                    failures += 1
                    do { try await Task.sleep(for: .seconds(min(30, pow(2, Double(min(failures - 1, 5)))))) } catch { return }
                }
            }
        }
    }

    private func cancelChangeWatching() {
        helperChangesTask?.cancel()
        helperChangesTask = nil
        companionChangesTask?.cancel()
        companionChangesTask = nil
        helperChangesAvailable = false
        companionChangesAvailable = false
        helperChangesUnsupported = false
        companionChangesUnsupported = false
    }
}
