import AppKit
import CodexBridgeKit
import Foundation
import OSLog
import SwiftUI

enum MenuBarHealth {
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
    var accessStrategy: String
    var policyMode: String
    var fixedSelectionKey: String
    var fallbackSelectionKey: String
    var allowedKind: String
    var explicitSelectionKeys: Set<String>
    var allowDelegation: Bool
    var usePriorityServiceTier: Bool
    var uiLocalePreference: String
    var maxConcurrentJobs: Int
    var showBridgeThreadsInCodexApp: Bool
    var activityCardVisibility: String
    var completionHandoff: String

    init(snapshot: SettingsSnapshot) {
        let settings = snapshot.settings
        accessStrategy = settings.accessStrategy
        policyMode = settings.modelPolicy.mode
        fixedSelectionKey = settings.modelPolicy.selection?.key ?? ""
        fallbackSelectionKey = settings.modelPolicy.fallbackSelection?.key ?? ""
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

        let choices = Self.choices(in: snapshot)
        if fixedSelectionKey.isEmpty { fixedSelectionKey = choices.first?.key ?? "" }
    }

    static func choices(in snapshot: SettingsSnapshot) -> [ModelChoice] {
        let ceiling = snapshot.capabilities.operatorModelCeiling.map(Set.init)
        return snapshot.catalog.models
            .filter { $0.hidden != true }
            .flatMap { model in
                model.supportedReasoningEfforts.map {
                    ModelChoice(model: model.id, reasoningEffort: $0.effort)
                }
            }
            .filter { ceiling?.contains($0) ?? true }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var helperStatus: HelperStatus?
    @Published var dashboard: DashboardSnapshot?
    @Published var settings: SettingsSnapshot?
    @Published var authStatus: CodexLoginStatus?
    @Published var logs: [HelperLogEntry] = []
    @Published var errorMessage: String?
    @Published var settingsConflictMessage: String?
    @Published var isBusy = false
    @Published var lastDashboardRefresh: Date?

    let paths = RuntimePaths()
    private let bootstrapper = HelperBootstrap()
    private let pageLimit = 12
    private let logger = Logger(subsystem: "com.menaje.codex-mcp-bridge", category: "app-model")
    private var pollingTask: Task<Void, Never>?

    private var helperClient: MacOSHelperClient {
        MacOSHelperClient(socketPath: paths.helperSocket.path)
    }

    private var bridgeClient: BridgeCompanionClient {
        BridgeCompanionClient(socketPath: paths.bridgeSocket.path)
    }

    var health: MenuBarHealth {
        guard let helperStatus,
              helperStatus.configuration.valid,
              helperStatus.bridge.connected,
              helperStatus.tunnel.connected,
              helperStatus.phase == "running" else {
            return .unavailable
        }
        guard let counts = dashboard?.counts else { return .healthy }
        return counts.needsAttention > 0 || counts.runtimeUnknownAgents > 0
            ? .attention
            : .healthy
    }

    var needsSetup: Bool {
        guard let helperStatus else { return false }
        return !helperStatus.configuration.valid
    }

    func start() async {
        logger.info("starting helper bootstrap")
        isBusy = true
        defer { isBusy = false }
        do {
            try await bootstrapper.ensureRunning(paths: paths)
            logger.info("helper bootstrap completed")
            errorMessage = nil
            await refreshAll()
            beginPolling()
        } catch {
            logger.error("helper bootstrap failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = error.localizedDescription
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
            helperStatus = try await helperClient.status()
            errorMessage = nil
        } catch {
            helperStatus = nil
            errorMessage = error.localizedDescription
        }
    }

    func refreshDashboard() async {
        guard helperStatus?.bridge.connected == true else {
            dashboard = nil
            return
        }
        do {
            dashboard = try await bridgeClient.dashboard(
                limit: pageLimit,
                terminalOffset: 0,
                idleOffset: 0
            )
            lastDashboardRefresh = Date()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshSettings(refreshModels: Bool = false) async {
        guard helperStatus?.bridge.connected == true else {
            settings = nil
            return
        }
        do {
            settings = try await bridgeClient.settings(refreshModels: refreshModels)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshAuthStatus() async {
        guard helperStatus != nil else { return }
        do {
            authStatus = try await helperClient.authStatus()
        } catch {
            authStatus = nil
        }
    }

    func saveSetup(apiKey: String, tunnelId: String) async -> Bool {
        await perform {
            let result = try await self.helperClient.applySetup(
                apiKey: apiKey.isEmpty ? nil : apiKey,
                tunnelId: tunnelId.isEmpty ? nil : tunnelId,
                force: false,
                timeoutMilliseconds: 60_000
            )
            self.helperStatus = result.status
            await self.refreshAll()
        }
    }

    func launchCodexLogin() async -> Bool {
        await perform {
            _ = try await self.helperClient.startLogin()
            try await Task.sleep(nanoseconds: 1_000_000_000)
            await self.refreshAuthStatus()
        }
    }

    func startRuntime() async -> Bool {
        await perform {
            self.helperStatus = try await self.helperClient.startRuntime()
            await self.refreshAll()
        }
    }

    func stopRuntime(force: Bool) async -> Bool {
        await perform {
            self.helperStatus = try await self.helperClient.stopRuntime(
                force: force,
                timeoutMilliseconds: 60_000
            )
            self.dashboard = nil
            self.settings = nil
        }
    }

    func restartRuntime(force: Bool) async -> Bool {
        await perform {
            self.helperStatus = try await self.helperClient.restartRuntime(
                force: force,
                timeoutMilliseconds: 60_000
            )
            await self.refreshAll()
        }
    }

    func repairTunnelProfile(force: Bool = false) async -> Bool {
        await perform {
            self.helperStatus = try await self.helperClient.repairRuntime(
                force: force,
                timeoutMilliseconds: 60_000
            )
            await self.refreshAll()
        }
    }

    func saveSettings(_ draft: SettingsDraft) async -> Bool {
        guard let snapshot = settings else { return false }
        let choices = Dictionary(
            uniqueKeysWithValues: SettingsDraft.choices(in: snapshot).map { ($0.key, $0) }
        )
        let policy: ModelPolicy
        if draft.policyMode == "fixed" {
            guard let choice = choices[draft.fixedSelectionKey] else {
                errorMessage = "고정 모델과 reasoning effort를 선택해 주세요."
                return false
            }
            policy = ModelPolicy(
                mode: "fixed",
                selection: choice,
                constraints: ModelPolicyConstraints(allowDelegation: draft.allowDelegation)
            )
        } else {
            let fallback = choices[draft.fallbackSelectionKey]
            let allowed: AllowedSelections
            if draft.allowedKind == "explicit" {
                var selectedKeys = draft.explicitSelectionKeys
                if let fallback { selectedKeys.insert(fallback.key) }
                let selections = selectedKeys.compactMap { choices[$0] }.sorted {
                    $0.key < $1.key
                }
                guard !selections.isEmpty else {
                    errorMessage = "자동 정책의 명시적 허용 목록을 하나 이상 선택해 주세요."
                    return false
                }
                allowed = AllowedSelections(kind: "explicit", selections: selections)
            } else {
                allowed = AllowedSelections(kind: "catalog-visible")
            }
            policy = ModelPolicy(
                mode: "automatic",
                fallbackSelection: fallback,
                allowedSelections: allowed,
                constraints: ModelPolicyConstraints(allowDelegation: draft.allowDelegation)
            )
        }

        let mutation = SettingsMutation(
            expectedSettingsRevision: snapshot.settings.settingsRevision,
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
        _ = await perform {
            let page = try await self.bridgeClient.dashboard(
                limit: self.pageLimit,
                terminalOffset: nextOffset,
                idleOffset: 0
            )
            self.dashboard = current.mergingPage(
                page,
                bucket: .terminal,
                requestedOffset: nextOffset
            )
            self.lastDashboardRefresh = Date()
        }
    }

    func loadMoreIdle() async {
        guard let current = dashboard, current.pagination.idle.hasNext else { return }
        let nextOffset = current.pagination.idle.offset + current.pagination.idle.returned
        _ = await perform {
            let page = try await self.bridgeClient.dashboard(
                limit: self.pageLimit,
                terminalOffset: 0,
                idleOffset: nextOffset
            )
            self.dashboard = current.mergingPage(
                page,
                bucket: .idle,
                requestedOffset: nextOffset
            )
            self.lastDashboardRefresh = Date()
        }
    }

    func refreshLogs() async {
        do {
            logs = try await helperClient.logs(limit: 100).entries
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performSettingsMutation(_ mutation: SettingsMutation) async -> Bool {
        await perform {
            do {
                self.settings = try await self.bridgeClient.updateSettings(mutation)
                self.settingsConflictMessage = nil
            } catch {
                if error.localizedDescription.contains("REVISION_CONFLICT") {
                    self.settingsConflictMessage =
                        "다른 화면에서 설정이 변경되었습니다. 최신 값을 불러왔으니 내용을 확인한 뒤 다시 저장해 주세요."
                    await self.refreshSettings()
                }
                throw error
            }
        }
    }

    private func perform(_ operation: () async throws -> Void) async -> Bool {
        isBusy = true
        defer { isBusy = false }
        do {
            try await operation()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
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
                if ticks.isMultiple(of: 3) {
                    await self.refreshDashboard()
                }
            }
        }
    }
}
