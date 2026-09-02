import Foundation

public struct EmptyParameters: Codable, Sendable {
    public init() {}
}

public struct DashboardSnapshot: Codable, Sendable {
    public let kind: String
    public let generatedAt: String
    public let scope: String
    public let statusSource: String
    public let coverage: String
    public let weeklyUsage: WeeklyUsage?
    public let counts: DashboardCounts
    public var activeRows: [DashboardRow]
    public var terminalRows: [DashboardRow]
    public var idleRows: [DashboardRow]
    public var pagination: DashboardPagination
    public let uiLocalePreference: String
}

public enum DashboardAppendBucket: Sendable {
    case terminal
    case idle
}

public extension DashboardSnapshot {
    /// Merge one independently paged Dashboard bucket while retaining the
    /// other bucket and evicting rows that moved between runtime states.
    func mergingPage(
        _ next: DashboardSnapshot,
        bucket: DashboardAppendBucket,
        requestedOffset: Int
    ) -> DashboardSnapshot {
        var result = next
        switch bucket {
        case .terminal:
            result.terminalRows = next.pagination.terminal.offset == requestedOffset
                ? Self.mergeRows(terminalRows, next.terminalRows)
                : next.terminalRows
            result.idleRows = idleRows
            result.pagination.idle = pagination.idle
        case .idle:
            result.terminalRows = terminalRows
            result.idleRows = next.pagination.idle.offset == requestedOffset
                ? Self.mergeRows(idleRows, next.idleRows)
                : next.idleRows
            result.pagination.terminal = pagination.terminal
        }

        let activeKeys = Set(next.activeRows.map(\.rowKey))
        let incomingTerminalKeys = Set(next.terminalRows.map(\.rowKey))
        let incomingIdleKeys = Set(next.idleRows.map(\.rowKey))
        result.terminalRows.removeAll {
            activeKeys.contains($0.rowKey) || incomingIdleKeys.contains($0.rowKey)
        }
        let terminalKeys = Set(result.terminalRows.map(\.rowKey))
        result.idleRows.removeAll {
            activeKeys.contains($0.rowKey) ||
                incomingTerminalKeys.contains($0.rowKey) ||
                terminalKeys.contains($0.rowKey)
        }

        if result.terminalRows.count > result.pagination.terminal.total {
            result.terminalRows = Array(
                next.terminalRows.prefix(result.pagination.terminal.total)
            )
        }
        if result.idleRows.count > result.pagination.idle.total {
            result.idleRows = Array(next.idleRows.prefix(result.pagination.idle.total))
        }
        return result
    }

    private static func mergeRows(
        _ current: [DashboardRow],
        _ incoming: [DashboardRow]
    ) -> [DashboardRow] {
        var merged = current
        var indices: [String: Int] = [:]
        for (offset, row) in merged.enumerated() {
            indices[row.rowKey] = offset
        }
        for row in incoming {
            if let index = indices[row.rowKey] {
                merged[index] = row
            } else {
                indices[row.rowKey] = merged.count
                merged.append(row)
            }
        }
        return merged
    }
}

public struct WeeklyUsage: Codable, Sendable {
    public let source: String
    public let limitId: String
    public let usedPercent: Double
    public let remainingPercent: Double
    public let windowDurationMins: Int
    public let resetsAt: String?
    public let observedAt: String
}

public struct DashboardCounts: Codable, Sendable {
    public let trackedProjects: Int
    public let trackedConversations: Int
    public let retainedJobs: Int
    public let active: Int
    public let running: Int
    public let inputRequired: Int
    public let approvalRequired: Int
    public let terminating: Int
    public let needsAttention: Int
    public let backgroundProcesses: Int
    public let backgroundProcessAgents: Int
    public let runtimeUnknownAgents: Int
    public let runtimeProbeSkippedAgents: Int
    public let completed: Int
    public let failed: Int
    public let interrupted: Int
    public let cancelled: Int
    public let idleAgents: Int
    public let orphanedAgents: Int
}

public struct DashboardPagination: Codable, Sendable {
    public var active: DashboardPage
    public var terminal: DashboardPage
    public var idle: DashboardPage
}

public struct DashboardPage: Codable, Sendable {
    public let offset: Int
    public let limit: Int
    public let returned: Int
    public let total: Int
    public let returnedConversations: Int
    public let conversationTotal: Int
    public let hasPrevious: Bool
    public let hasNext: Bool
}

public struct DashboardExecution: Codable, Sendable {
    public let model: String
    public let modelDisplayName: String?
    public let reasoningEffort: String
    public let reroutedModel: String?
    public let reroutedModelDisplayName: String?
    public let isCurrent: Bool
}

public struct CancellationDisplay: Codable, Sendable {
    public let targetKind: String
    public let agentName: String?
    public let status: String
    public let reason: String
    public let requestedAt: String
}

public struct DashboardTurn: Codable, Sendable {
    public let activityKey: String?
    public let activityTitle: String?
    public let execution: DashboardExecution?
    public let status: String
    public let startedAt: String?
    public let updatedAt: String
    public let endedAt: String?
    public let durationMs: Int?
    public let cancellation: CancellationDisplay?
}

public struct DashboardRow: Codable, Identifiable, Sendable {
    public var id: String { rowKey }
    public let rowKey: String
    public let activityKey: String
    public let conversationKey: String
    public let sessionAlias: String
    public let conversationUrl: String?
    public let codexThreadUrl: String?
    public let bucket: String
    public let projectKey: String
    public let projectName: String?
    public let agentName: String
    public let activityTitle: String?
    public let execution: DashboardExecution?
    public let status: String
    public let createdAt: String
    public let updatedAt: String
    public let elapsedMs: Int
    public let backgroundProcessCount: Int
    public let latestTurn: DashboardTurn?
    public let history: [DashboardTurn]?
    public let historyCount: Int?
}

public struct SettingsSnapshot: Codable, Sendable {
    public let settings: BridgeSettings
    public let operatorDefaults: BridgeSettings
    public let capabilities: SettingsCapabilities
    public let catalog: ModelCatalogSnapshot
    public let warnings: [String]
    public let scopeNotice: String
    public let policyActivation: PolicyActivation
}

public struct BridgeSettings: Codable, Sendable {
    public let schemaVersion: Int
    public let settingsRevision: Int
    public let registryRevision: Int
    public let revision: Int
    public let updatedAt: String?
    public let accessStrategy: String
    public let modelPolicy: ModelPolicy
    public let usePriorityServiceTier: Bool
    public let legacyPreferredModel: String?
    public let projects: [BridgeProject]
    public let uiLocalePreference: String
    public let maxConcurrentJobs: Int
    public let showBridgeThreadsInCodexApp: Bool
    public let activityCardVisibility: String
    public let completionHandoff: String
}

public struct BridgeProject: Codable, Identifiable, Sendable {
    public let id: String
    public let projectRef: String
    public let projectRevision: Int
    public let name: String
    public let label: String
    public let nameKey: String
    public let cwd: String
    public let sortOrder: Int
    public let createdAt: Double
    public let updatedAt: Double
    public let archivedAt: Double?
}

public struct ModelChoice: Codable, Hashable, Sendable {
    public let model: String
    public let reasoningEffort: String

    public init(model: String, reasoningEffort: String) {
        self.model = model
        self.reasoningEffort = reasoningEffort
    }

    public var key: String { "\(model)\u{0}\(reasoningEffort)" }
}

public struct ModelPolicyConstraints: Codable, Sendable {
    public var allowDelegation: Bool

    public init(allowDelegation: Bool) {
        self.allowDelegation = allowDelegation
    }
}

public struct AllowedSelections: Codable, Sendable {
    public var kind: String
    public var selections: [ModelChoice]?

    public init(kind: String, selections: [ModelChoice]? = nil) {
        self.kind = kind
        self.selections = selections
    }
}

public struct ModelPolicy: Codable, Sendable {
    public var mode: String
    public var selection: ModelChoice?
    public var fallbackSelection: ModelChoice?
    public var allowedSelections: AllowedSelections?
    public var constraints: ModelPolicyConstraints

    public init(
        mode: String,
        selection: ModelChoice? = nil,
        fallbackSelection: ModelChoice? = nil,
        allowedSelections: AllowedSelections? = nil,
        constraints: ModelPolicyConstraints
    ) {
        self.mode = mode
        self.selection = selection
        self.fallbackSelection = fallbackSelection
        self.allowedSelections = allowedSelections
        self.constraints = constraints
    }
}

public struct SettingsCapabilities: Codable, Sendable {
    public let availableAccessStrategies: [String]
    public let availableUiLocalePreferences: [String]
    public let availableActivityCardVisibilities: [String]
    public let availableCompletionHandoffs: [String]
    public let projectAvailability: [ProjectAvailability]
    public let maxConcurrentJobs: Int
    public let defaultBackend: String
    public let allowWorkspaceWrite: Bool
    public let allowDangerFullAccess: Bool
    public let operatorModelCeiling: [ModelChoice]?
    public let persistent: Bool
}

public struct ProjectAvailability: Codable, Sendable {
    public let projectId: String
    public let name: String
    public let available: Bool
    public let archived: Bool
}

public struct ModelCatalogSnapshot: Codable, Sendable {
    public let source: String?
    public let fetchedAt: String?
    public let validatedAt: String?
    public let fingerprint: String?
    public let cached: Bool
    public let stale: Bool
    public let lastKnownGood: Bool
    public let validation: String
    public let warning: String?
    public let translationCoverage: TranslationCoverage
    public let models: [CatalogModel]
}

public struct TranslationCoverage: Codable, Sendable {
    public let missingEffortIds: [String]
}

public struct CatalogModel: Codable, Identifiable, Sendable {
    public let id: String
    public let catalogId: String?
    public let displayName: String
    public let description: String?
    public let defaultReasoningEffort: String?
    public let supportedReasoningEfforts: [ReasoningEffort]
    public let hidden: Bool?
    public let isDefault: Bool?
    public let upgrade: String?
    public let supportsPersonality: Bool?
    public let defaultServiceTier: String?
    public let serviceTiers: [ServiceTier]
    public let inputModalities: [String]
    public let supportedInApi: Bool?
}

public struct ReasoningEffort: Codable, Identifiable, Sendable {
    public var id: String { effort }
    public let effort: String
    public let description: String?
    public let label: String?
    public let localizedDescription: String?
    public let descriptionSource: String?
}

public struct ServiceTier: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
}

public struct PolicyActivation: Codable, Sendable {
    public let policyRevision: Int
    public let executionPolicyActive: Bool
    public let descriptorProjectionUpdated: Bool
    public let developerModeRefreshRequired: Bool
}

public struct DashboardParameters: Codable, Sendable {
    public var limit: Int
    public var terminalOffset: Int
    public var idleOffset: Int

    public init(limit: Int = 20, terminalOffset: Int = 0, idleOffset: Int = 0) {
        self.limit = limit
        self.terminalOffset = terminalOffset
        self.idleOffset = idleOffset
    }
}

public struct SettingsSnapshotParameters: Codable, Sendable {
    public let refreshModels: Bool

    public init(refreshModels: Bool = false) {
        self.refreshModels = refreshModels
    }
}

public struct SettingsMutation: Encodable, Sendable {
    public let expectedSettingsRevision: Int?
    public let expectedRegistryRevision: Int?
    public let operation: SettingsOperation

    public init(
        expectedSettingsRevision: Int?,
        expectedRegistryRevision: Int?,
        operation: SettingsOperation
    ) {
        self.expectedSettingsRevision = expectedSettingsRevision
        self.expectedRegistryRevision = expectedRegistryRevision
        self.operation = operation
    }
}

public enum SettingsOperation: Encodable, Sendable {
    case reset
    case patch(SettingsPatch)

    private enum CodingKeys: String, CodingKey { case kind, settings }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .reset:
            try container.encode("reset", forKey: .kind)
        case .patch(let settings):
            try container.encode("patch", forKey: .kind)
            try container.encode(settings, forKey: .settings)
        }
    }
}

public struct SettingsPatch: Encodable, Sendable {
    public var accessStrategy: String?
    public var modelPolicy: ModelPolicy?
    public var usePriorityServiceTier: Bool?
    public var uiLocalePreference: String?
    public var maxConcurrentJobs: Int?
    public var showBridgeThreadsInCodexApp: Bool?
    public var activityCard: ActivityCardPatch?
    public var projectOperations: [ProjectOperation]?

    public init(
        accessStrategy: String? = nil,
        modelPolicy: ModelPolicy? = nil,
        usePriorityServiceTier: Bool? = nil,
        uiLocalePreference: String? = nil,
        maxConcurrentJobs: Int? = nil,
        showBridgeThreadsInCodexApp: Bool? = nil,
        activityCard: ActivityCardPatch? = nil,
        projectOperations: [ProjectOperation]? = nil
    ) {
        self.accessStrategy = accessStrategy
        self.modelPolicy = modelPolicy
        self.usePriorityServiceTier = usePriorityServiceTier
        self.uiLocalePreference = uiLocalePreference
        self.maxConcurrentJobs = maxConcurrentJobs
        self.showBridgeThreadsInCodexApp = showBridgeThreadsInCodexApp
        self.activityCard = activityCard
        self.projectOperations = projectOperations
    }
}

public struct ActivityCardPatch: Encodable, Sendable {
    public var visibility: String
    public var completionHandoff: String

    public init(visibility: String, completionHandoff: String) {
        self.visibility = visibility
        self.completionHandoff = completionHandoff
    }
}

public enum ProjectOperation: Encodable, Sendable {
    case add(name: String, cwd: String)
    case rename(projectId: String, name: String)
    case relocate(projectId: String, cwd: String)
    case archive(projectId: String)
    case restore(projectId: String, name: String? = nil, cwd: String? = nil)
    case delete(projectId: String)

    private enum CodingKeys: String, CodingKey {
        case kind, project, projectId, name, cwd
    }
    private struct NewProject: Encodable { let name: String; let cwd: String }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .add(let name, let cwd):
            try container.encode("add", forKey: .kind)
            try container.encode(NewProject(name: name, cwd: cwd), forKey: .project)
        case .rename(let projectId, let name):
            try container.encode("rename", forKey: .kind)
            try container.encode(projectId, forKey: .projectId)
            try container.encode(name, forKey: .name)
        case .relocate(let projectId, let cwd):
            try container.encode("relocate", forKey: .kind)
            try container.encode(projectId, forKey: .projectId)
            try container.encode(cwd, forKey: .cwd)
        case .archive(let projectId):
            try container.encode("archive", forKey: .kind)
            try container.encode(projectId, forKey: .projectId)
        case .restore(let projectId, let name, let cwd):
            try container.encode("restore", forKey: .kind)
            try container.encode(projectId, forKey: .projectId)
            try container.encodeIfPresent(name, forKey: .name)
            try container.encodeIfPresent(cwd, forKey: .cwd)
        case .delete(let projectId):
            try container.encode("delete", forKey: .kind)
            try container.encode(projectId, forKey: .projectId)
        }
    }
}

public struct RuntimeAdmissionSnapshot: Codable, Sendable {
    public let acceptingNewJobs: Bool
    public let activeJobs: Int
    public let pendingAdmissions: Int
}

public struct RuntimeConfigurationStatus: Codable, Sendable {
    public let path: String
    public let exists: Bool
    public let valid: Bool
    public let hasApiKey: Bool
    public let hasTunnelId: Bool
    public let tunnelId: String?
    public let issue: String?
}

public struct HelperBridgeStatus: Codable, Sendable {
    public let socketPath: String
    public let connected: Bool
    public let acceptingNewJobs: Bool?
    public let activeJobs: Int?
    public let pendingAdmissions: Int?
}

public struct HelperTunnelStatus: Codable, Sendable {
    public let phase: String
    public let profile: String?
    public let transport: String?
    public let doctorPassed: Bool
    public let processRunning: Bool
    public let connected: Bool
    public let lastCheckedAt: String?
    public let lastError: String?
}

public struct HelperExitStatus: Codable, Sendable {
    public let at: String
    public let code: Int?
    public let signal: String?
}

public struct HelperStatus: Codable, Sendable {
    public let kind: String
    public let generatedAt: String
    public let phase: String
    public let pid: Int?
    public let startedAt: String?
    public let lastExit: HelperExitStatus?
    public let lastError: String?
    public let restartAttempt: Int
    public let configuration: RuntimeConfigurationStatus
    public let bridge: HelperBridgeStatus
    public let tunnel: HelperTunnelStatus
}

public struct HelperHello: Codable, Sendable {
    public static let expectedProtocolName = "codex-mcp-bridge-macos-helper"
    public static let expectedProtocolVersion = 2

    public struct ProtocolInfo: Codable, Sendable {
        public let name: String
        public let version: Int
    }
    public struct RuntimeInfo: Codable, Sendable {
        public let buildId: String
        public let version: String
    }
    public let `protocol`: ProtocolInfo
    public let runtime: RuntimeInfo
    public let capabilities: [String]
    public let status: HelperStatus
}

public struct SetupApplyParameters: Codable, Sendable {
    public let apiKey: String?
    public let tunnelId: String?
    public let mode: String
    public let timeoutMs: Int

    public init(
        apiKey: String?,
        tunnelId: String?,
        force: Bool,
        timeoutMilliseconds: Int
    ) {
        self.apiKey = apiKey
        self.tunnelId = tunnelId
        self.mode = force ? "force" : "drain"
        self.timeoutMs = timeoutMilliseconds
    }
}

public struct SetupApplyResponse: Codable, Sendable {
    public let configuration: RuntimeConfigurationStatus
    public let status: HelperStatus
    public let restarted: Bool
    public let rolledBack: Bool
}

public struct CodexLoginStatus: Codable, Sendable {
    public let installed: Bool
    public let authenticated: Bool
    public let summary: String
}

public struct LoginStartResponse: Codable, Sendable {
    public let started: Bool
}

public struct RuntimeControlParameters: Codable, Sendable {
    public let mode: String
    public let timeoutMs: Int

    public init(mode: String, timeoutMs: Int) {
        self.mode = mode
        self.timeoutMs = timeoutMs
    }
}

public struct RuntimeLogsParameters: Codable, Sendable {
    public let limit: Int

    public init(limit: Int) { self.limit = limit }
}

public struct HelperLogEntry: Codable, Identifiable, Sendable {
    public var id: String { "\(at)-\(source)-\(message)" }
    public let at: String
    public let source: String
    public let message: String
}

public struct HelperLogs: Codable, Sendable {
    public let entries: [HelperLogEntry]
}
