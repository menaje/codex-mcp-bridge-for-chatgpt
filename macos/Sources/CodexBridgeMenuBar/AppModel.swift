import CodexBridgeKit
import Foundation
import OSLog
import SwiftUI

enum MenuBarHealth: Equatable {
    case healthy
    case attention
    case unavailable

    var symbol: String {
        switch self {
        case .healthy: return "point.3.connected.trianglepath.dotted"
        case .attention: return "exclamationmark.triangle.fill"
        case .unavailable: return "bolt.slash.fill"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .healthy: return "Codex 브리지 정상"
        case .attention: return "Codex 브리지 확인 필요"
        case .unavailable: return "Codex 브리지 연결 불가"
        }
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
}

@MainActor
final class AppModel: ObservableObject {
    @Published var helperStatus: HelperStatus?
    @Published var dashboard: DashboardSnapshot?
    @Published var settings: SettingsSnapshot?
    @Published var authStatus: CodexLoginStatus?
    @Published var logs: [HelperLogEntry] = []
    @Published var startupErrorMessage: String?
    @Published var statusErrorMessage: String?
    @Published var dashboardErrorMessage: String?
    @Published var settingsLoadErrorMessage: String?
    @Published var settingsErrorMessage: String?
    @Published var runtimeErrorMessage: String?
    @Published var authErrorMessage: String?
    @Published var logsErrorMessage: String?
    @Published var settingsConflictMessage: String?
    @Published var isBusy = false
    @Published var loginInProgress = false
    @Published var lastDashboardRefresh: Date?
    @Published var runtimeImpact: RuntimeAdmissionSnapshot?
    @Published var runtimeImpactErrorMessage: String?

    private let bootstrapper = HelperBootstrap()
    private let pageLimit = 12
    private let logger = Logger(subsystem: "com.menaje.codex-mcp-bridge", category: "app-model")
    private var pollingTask: Task<Void, Never>?
    private var settingsPollingTask: Task<Void, Never>?
    private var loginPollingTask: Task<Void, Never>?
    private var startTask: Task<Void, Never>?
    private var authRefreshTask: Task<Void, Never>?
    private var dashboardEnrichmentTask: Task<Void, Never>?
    private var dashboardRequestGeneration = 0
    private var paths: RuntimePaths?
    private var pathResolutionTask: Task<RuntimePaths, Never>?

    init(paths: RuntimePaths? = nil) {
        self.paths = paths
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

    private func bridgeClient() async -> BridgeCompanionClient {
        let paths = await resolvedPaths()
        return BridgeCompanionClient(socketPath: paths.bridgeSocket.path)
    }

    var health: MenuBarHealth {
        guard let helperStatus,
              helperStatus.configuration.valid,
              helperStatus.bridge.connected,
              helperStatus.tunnel.connected,
              helperStatus.phase == "running" else {
            return .unavailable
        }
        guard let authStatus else { return .attention }
        guard authStatus.installed else { return .unavailable }
        guard authStatus.authenticated else { return .attention }
        guard dashboardErrorMessage == nil, let counts = dashboard?.counts else {
            return .attention
        }
        return counts.needsAttention > 0 || counts.runtimeUnknownAgents > 0
            ? .attention
            : .healthy
    }

    var needsSetup: Bool {
        guard let helperStatus else { return false }
        return !helperStatus.configuration.valid
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
        logger.info("starting helper bootstrap")
        isBusy = true
        defer { isBusy = false }
        do {
            let paths = await resolvedPaths()
            try await bootstrapper.ensureRunning(paths: paths)
            logger.info("helper bootstrap completed")
            startupErrorMessage = nil
            await refreshAll()
            beginPolling()
        } catch {
            logger.error("helper bootstrap failed: \(error.localizedDescription, privacy: .public)")
            startupErrorMessage = error.localizedDescription
        }
    }

    func refreshAll(refreshModels: Bool = false) async {
        await refreshStatus()
        await refreshDashboard()
        await refreshSettings(refreshModels: refreshModels)
        await refreshAuthStatus()
    }

    func refreshStatus() async {
        do {
            let client = await helperClient()
            helperStatus = try await client.status()
            statusErrorMessage = nil
        } catch {
            helperStatus = nil
            statusErrorMessage = error.localizedDescription
        }
    }

    func refreshDashboard() async {
        dashboardEnrichmentTask?.cancel()
        dashboardRequestGeneration += 1
        let generation = dashboardRequestGeneration
        guard helperStatus?.bridge.connected == true else {
            dashboard = nil
            dashboardErrorMessage = nil
            return
        }
        do {
            let client = await bridgeClient()
            dashboard = try await client.dashboard(
                limit: pageLimit,
                terminalOffset: 0,
                idleOffset: 0,
                enrich: false
            )
            lastDashboardRefresh = Date()
            dashboardErrorMessage = nil
            scheduleDashboardEnrichment(
                generation: generation,
                terminalOffset: 0,
                idleOffset: 0
            )
        } catch {
            dashboardErrorMessage = error.localizedDescription
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
            do {
                let client = await self.bridgeClient()
                let enriched = try await client.dashboard(
                    limit: self.pageLimit,
                    terminalOffset: terminalOffset,
                    idleOffset: idleOffset,
                    enrich: true
                )
                guard !Task.isCancelled, generation == self.dashboardRequestGeneration else {
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
            } catch {
                // Structural state stays usable when optional runtime probes or
                // account usage enrichment is unavailable.
            }
        }
    }

    func refreshSettings(refreshModels: Bool = false) async {
        guard helperStatus?.bridge.connected == true else {
            settings = nil
            settingsLoadErrorMessage = nil
            return
        }
        do {
            let client = await bridgeClient()
            settings = try await client.settings(refreshModels: refreshModels)
            settingsLoadErrorMessage = nil
        } catch {
            settingsLoadErrorMessage = error.localizedDescription
        }
    }

    func refreshRuntimeImpact() async {
        isBusy = true
        defer { isBusy = false }
        do {
            let client = await bridgeClient()
            runtimeImpact = try await client.runtimeStatus(inspectBackgroundProcesses: true)
            runtimeImpactErrorMessage = nil
        } catch {
            runtimeImpact = nil
            runtimeImpactErrorMessage = error.localizedDescription
        }
    }

    func setSettingsWindowVisible(_ visible: Bool) {
        if !visible {
            settingsPollingTask?.cancel()
            settingsPollingTask = nil
            return
        }
        guard settingsPollingTask == nil else { return }
        settingsPollingTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard let self, !Task.isCancelled else { return }
                if !self.isBusy {
                    await self.refreshSettings()
                }
            }
        }
    }

    func refreshAuthStatus() async {
        if let authRefreshTask {
            await authRefreshTask.value
            return
        }
        let task = Task<Void, Never> { @MainActor [weak self] in
            await self?.refreshAuthStatusOnce()
        }
        authRefreshTask = task
        await task.value
        authRefreshTask = nil
    }

    private func refreshAuthStatusOnce() async {
        guard helperStatus != nil else {
            authStatus = nil
            return
        }
        do {
            let client = await helperClient()
            authStatus = try await client.authStatus()
            authErrorMessage = nil
            if authStatus?.authenticated == true {
                loginInProgress = false
                loginPollingTask?.cancel()
                loginPollingTask = nil
            }
        } catch {
            authStatus = nil
            authErrorMessage = error.localizedDescription
        }
    }

    func saveSetup(apiKey: String, tunnelId: String) async -> Bool {
        await performRuntime {
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

    func repairConfigurationPermissions() async -> Bool {
        await performRuntime {
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
        isBusy = true
        defer { isBusy = false }
        authErrorMessage = nil
        do {
            let client = await helperClient()
            _ = try await client.startLogin()
            loginInProgress = true
            beginLoginPolling()
            return true
        } catch {
            authErrorMessage = error.localizedDescription
            return false
        }
    }

    func startRuntime() async -> Bool {
        await performRuntime {
            let client = await self.helperClient()
            self.helperStatus = try await client.startRuntime()
            await self.refreshAll()
        }
    }

    func stopRuntime(force: Bool) async -> Bool {
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

    func restartRuntime(force: Bool) async -> Bool {
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

    func saveSettings(_ draft: SettingsDraft) async -> Bool {
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
                    settingsErrorMessage =
                        "현재 사용할 수 있는 고정 모델과 reasoning effort를 선택해 주세요."
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
                        settingsErrorMessage =
                            "현재 사용할 수 없는 저장된 모델 조합을 허용 목록에서 해제해 주세요."
                        return false
                    }
                    let selections = selectedKeys.compactMap { displayedChoices[$0] }.sorted {
                        $0.key < $1.key
                    }
                    guard !selections.isEmpty else {
                        settingsErrorMessage =
                            "자동 정책의 명시적 허용 목록을 하나 이상 선택해 주세요."
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
        return await performSettingsMutation(mutation)
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
        _ = await performDashboard {
            let client = await self.bridgeClient()
            let page = try await client.dashboard(
                limit: self.pageLimit,
                terminalOffset: nextOffset,
                idleOffset: 0,
                enrich: false
            )
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
        _ = await performDashboard {
            let client = await self.bridgeClient()
            let page = try await client.dashboard(
                limit: self.pageLimit,
                terminalOffset: 0,
                idleOffset: nextOffset,
                enrich: false
            )
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
        do {
            let client = await helperClient()
            logs = try await client.logs(limit: 100).entries
            logsErrorMessage = nil
        } catch {
            logsErrorMessage = error.localizedDescription
        }
    }

    private func performSettingsMutation(_ mutation: SettingsMutation) async -> Bool {
        isBusy = true
        defer { isBusy = false }
        settingsErrorMessage = nil
        do {
            let client = await bridgeClient()
            settings = try await client.updateSettings(mutation)
            settingsConflictMessage = nil
            return true
        } catch {
            let message = error.localizedDescription
            if message.contains("REVISION_CONFLICT") {
                settingsConflictMessage =
                    "다른 화면에서 설정이 변경되었습니다. 편집 중인 값은 유지했습니다. 필요한 내용을 확인하거나 복사한 뒤 최신 값으로 되돌려 다시 적용해 주세요."
                await refreshSettings()
            }
            settingsErrorMessage = message
            return false
        }
    }

    private func performRuntime(_ operation: () async throws -> Void) async -> Bool {
        isBusy = true
        defer { isBusy = false }
        runtimeErrorMessage = nil
        do {
            try await operation()
            return true
        } catch {
            runtimeErrorMessage = error.localizedDescription
            return false
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
            dashboardErrorMessage = error.localizedDescription
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
        guard pollingTask == nil else { return }
        pollingTask = Task { [weak self] in
            var ticks = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard let self, !Task.isCancelled else { return }
                await self.refreshStatus()
                ticks += 1
                if ticks.isMultiple(of: 6) {
                    await self.refreshAuthStatus()
                }
                if ticks.isMultiple(of: 3) {
                    await self.refreshDashboard()
                }
            }
        }
    }
}
