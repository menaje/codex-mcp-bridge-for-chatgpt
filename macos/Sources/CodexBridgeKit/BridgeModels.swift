import Foundation

public struct EmptyParameters: Codable, Sendable {
    public init() {}
}

public struct DashboardSnapshot: Codable, Sendable {
    public var problems: DashboardProblems? = nil
    public let kind: String
    public let generatedAt: String
    public let scope: String
    public let statusSource: String
    public let coverage: String
    public let enrichment: CardEnrichment?
    public let codexAccount: CodexAccountUsage?
    public let weeklyUsage: WeeklyUsage?
    public let counts: DashboardCounts
    public var activeRows: [DashboardRow]
    public var terminalRows: [DashboardRow]
    public var idleRows: [DashboardRow]
    public var statusRows: [DashboardRow]? = nil
    public var statusRowsComplete: Bool? = nil
    public var historyIncluded: Bool? = nil
    public var pagination: DashboardPagination
    public let uiLocalePreference: String
    public var historyPolicy: WorkHistoryPolicy? = nil
}

public struct WorkHistoryPolicy: Codable, Sendable, Equatable {
    public var reviewUntilRetention: Bool? = nil
    public var automaticRecovery: Bool? = nil
    public let retentionDays: Int
    public let issueAttentionDays: Int
    public let lastCleanupAt: String?
    public let lastCleanupCount: Int
    public let totalRemoved: Int
}

public struct HistoryControls: Codable, Sendable {
    public let revision: String
    public let canAcknowledge: Bool
}

public struct HistoryAction: Codable, Sendable {
    public let rowKey: String
    public let expectedRevision: String
    public let action: String
    public let requestId: String

    public init(rowKey: String, expectedRevision: String, requestId: String = UUID().uuidString) {
        self.rowKey = rowKey
        self.expectedRevision = expectedRevision
        self.action = "acknowledge"
        self.requestId = requestId
    }
}

public struct HistoryActionResult: Codable, Sendable { public let ok: Bool }

public struct CardEnrichment: Codable, Sendable {
    public let state: String
    public let runtimeRequests: Int
    public let cacheHits: Int
    public let timeouts: Int
    public let durationMs: Int
    public let usageTimedOut: Bool
    public let runtimeUnavailable: Int?
    public let pendingReads: Int?
    public let usageUnavailable: Bool?
    public let oldestObservationAt: String?

    public var isUpdating: Bool { (pendingReads ?? 0) > 0 }

    public var hasFailures: Bool {
        if pendingReads != nil { return (runtimeUnavailable ?? 0) > 0 || usageUnavailable == true }
        return isIncomplete
    }

    public var isIncomplete: Bool {
        usageTimedOut || timeouts > 0 || (runtimeUnavailable ?? 0) > 0 || usageUnavailable == true
    }
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
        guard historyPolicy?.totalRemoved == next.historyPolicy?.totalRemoved else { return next }
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

public enum DashboardStatusFilter: String, Codable, Sendable {
    case all, running, problems, background
    case responseRequired = "response-required"
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
    public let responseRequired: Int?
    public let problems: Int?
    public var responseRequiredCount: Int { responseRequired ?? inputRequired + approvalRequired }
    public var problemCount: Int { problems ?? max(0, needsAttention - responseRequiredCount) }
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
    public let serviceTier: String?
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

public struct DashboardHistoryDetail: Codable, Sendable {
    public let kind: String
    public let rowKey: String
    public let history: [DashboardTurn]
    public let historyCount: Int
    /// Matches the Dashboard row that selected the representative execution.
    /// Older bridge versions omit it, so clients retain a compatibility path.
    public var historyRevision: String? = nil
}

public struct DashboardRow: Codable, Identifiable, Sendable {
    public var historyControls: HistoryControls? = nil
    public var handoff: ThreadHandoffStatus? = nil
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
    public let tokenUsage: CodexTokenUsage?
    public let execution: DashboardExecution?
    public let status: String
    public let createdAt: String
    public let updatedAt: String
    public let elapsedMs: Int
    public let backgroundProcessCount: Int
    public let latestTurn: DashboardTurn?
    public let history: [DashboardTurn]?
    public let historyCount: Int?
    /// Stable only for the snapshot that supplied this row; used to discard a
    /// deferred history response after the Agent begins a new execution.
    public var historyRevision: String? = nil
}

public struct ThreadHandoffStatus: Codable, Sendable {
    public let phase: String
    public let reason: String?
    public let requested: Bool
    public let canOpen: Bool
}

public struct SettingsSnapshot: Codable, Sendable {
    public var historyPolicy: WorkHistoryPolicy? = nil
    public let settings: BridgeSettings
    public let operatorDefaults: BridgeSettings
    public let capabilities: SettingsCapabilities
    public let catalog: ModelCatalogSnapshot
    public let warnings: [String]
    public let scopeNotice: String
    public let policyActivation: PolicyActivation
}

public struct BridgeSettings: Codable, Sendable {
    public var historyRetentionDays: Int? = nil
    public let schemaVersion: Int
    public let settingsRevision: Int
    public let registryRevision: Int
    public let revision: Int
    public let updatedAt: String?
    public let accessStrategy: String
    public let modelPolicy: ModelPolicy
    /// Missing on older servers; official catalog descriptions are never copied here.
    public let modelDescriptionOverrides: [String: String]?
    public let usePriorityServiceTier: Bool
    public let projects: [BridgeProject]
    public let uiLocalePreference: String
    public let maxConcurrentJobs: Int
    public let showBridgeThreadsInCodexApp: Bool
}

/// Opaque local-delivery receipt. It deliberately excludes task prompts,
/// result content, project paths, Activity IDs, and conversation IDs.
public struct NativeCompletionNotification: Codable, Sendable, Equatable, Identifiable {
    public let eventId: String
    public let outboxId: Int

    public var id: String { eventId }

    public init(eventId: String, outboxId: Int) {
        self.eventId = eventId
        self.outboxId = outboxId
    }
}

public struct BridgeProject: Codable, Identifiable, Sendable {
    public let id: String
    public let projectRef: String
    public let projectRevision: Int
    public let name: String
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
    public var allowedSelections: AllowedSelections?
    public var constraints: ModelPolicyConstraints

    public init(
        mode: String,
        selection: ModelChoice? = nil,
        allowedSelections: AllowedSelections? = nil,
        constraints: ModelPolicyConstraints
    ) {
        self.mode = mode
        self.selection = selection
        self.allowedSelections = allowedSelections
        self.constraints = constraints
    }
}

public struct SettingsCapabilities: Codable, Sendable {
    public let availableAccessStrategies: [String]
    public let availableUiLocalePreferences: [String]
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
    public var problems: ProblemQuery? = nil
    public var limit: Int
    public var terminalOffset: Int
    public var idleOffset: Int
    public var enrich: Bool
    public var statusFilter: DashboardStatusFilter
    public var includeHistory: Bool?

    public init(
        limit: Int = 12,
        terminalOffset: Int = 0,
        idleOffset: Int = 0,
        enrich: Bool = false,
        statusFilter: DashboardStatusFilter = .all,
        includeHistory: Bool? = nil,
        problems: ProblemQuery? = nil
    ) {
        self.statusFilter = statusFilter
        self.problems = problems
        self.limit = limit
        self.terminalOffset = terminalOffset
        self.idleOffset = idleOffset
        self.enrich = enrich
        self.includeHistory = includeHistory
    }
}

public struct DashboardHistoryDetailParameters: Codable, Sendable {
    public let rowKey: String

    public init(rowKey: String) {
        self.rowKey = rowKey
    }
}

public struct SettingsSnapshotParameters: Codable, Sendable {
    public let refreshModels: Bool
    public let locale: String

    public init(refreshModels: Bool = false, locale: String = Locale.current.identifier) {
        self.refreshModels = refreshModels
        self.locale = locale
    }
}

public struct SettingsMutation: Encodable, Sendable {
    public let expectedSettingsRevision: Int?
    public let expectedRegistryRevision: Int?
    public let operation: SettingsOperation
    /// Display-only locale consumed by the companion transport adapter. It is
    /// deliberately not a persisted bridge setting or part of `operation`.
    public let locale: String?

    public init(
        expectedSettingsRevision: Int?,
        expectedRegistryRevision: Int?,
        operation: SettingsOperation,
        locale: String? = nil
    ) {
        self.expectedSettingsRevision = expectedSettingsRevision
        self.expectedRegistryRevision = expectedRegistryRevision
        self.operation = operation
        self.locale = locale
    }

    public func withPresentationLocale(_ value: String) -> SettingsMutation {
        SettingsMutation(
            expectedSettingsRevision: expectedSettingsRevision,
            expectedRegistryRevision: expectedRegistryRevision,
            operation: operation,
            locale: value
        )
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
    public var modelDescriptionOverrides: [String: String]?
    public var usePriorityServiceTier: Bool?
    public var uiLocalePreference: String?
    public var maxConcurrentJobs: Int?
    public var historyRetentionDays: Int?
    public var showBridgeThreadsInCodexApp: Bool?
    public var projectOperations: [ProjectOperation]?

    public init(
        accessStrategy: String? = nil,
        modelPolicy: ModelPolicy? = nil,
        modelDescriptionOverrides: [String: String]? = nil,
        usePriorityServiceTier: Bool? = nil,
        uiLocalePreference: String? = nil,
        maxConcurrentJobs: Int? = nil,
        historyRetentionDays: Int? = nil,
        showBridgeThreadsInCodexApp: Bool? = nil,
        projectOperations: [ProjectOperation]? = nil
    ) {
        self.accessStrategy = accessStrategy
        self.modelPolicy = modelPolicy
        self.modelDescriptionOverrides = modelDescriptionOverrides
        self.usePriorityServiceTier = usePriorityServiceTier
        self.uiLocalePreference = uiLocalePreference
        self.maxConcurrentJobs = maxConcurrentJobs
        self.historyRetentionDays = historyRetentionDays
        self.showBridgeThreadsInCodexApp = showBridgeThreadsInCodexApp
        self.projectOperations = projectOperations
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
    public let pendingInteractions: Int?
    public let memoryOnlyThreads: Int?
    public let protectedMemoryOnlyThreads: Int?
    public let discardableMemoryOnlyThreads: Int?
    public let backgroundProcessState: String
    public let backgroundProcesses: Int
    public let backgroundProcessAgents: Int
    public let backgroundProcessUnknownAgents: Int

    public init(
        acceptingNewJobs: Bool,
        activeJobs: Int,
        pendingAdmissions: Int,
        pendingInteractions: Int? = nil,
        memoryOnlyThreads: Int? = nil,
        protectedMemoryOnlyThreads: Int? = nil,
        discardableMemoryOnlyThreads: Int? = nil,
        backgroundProcessState: String,
        backgroundProcesses: Int,
        backgroundProcessAgents: Int,
        backgroundProcessUnknownAgents: Int
    ) {
        self.acceptingNewJobs = acceptingNewJobs
        self.activeJobs = activeJobs
        self.pendingAdmissions = pendingAdmissions
        self.pendingInteractions = pendingInteractions
        self.memoryOnlyThreads = memoryOnlyThreads
        self.protectedMemoryOnlyThreads = protectedMemoryOnlyThreads
        self.discardableMemoryOnlyThreads = discardableMemoryOnlyThreads
        self.backgroundProcessState = backgroundProcessState
        self.backgroundProcesses = backgroundProcesses
        self.backgroundProcessAgents = backgroundProcessAgents
        self.backgroundProcessUnknownAgents = backgroundProcessUnknownAgents
    }
}

public struct RuntimeSnapshotParameters: Codable, Sendable {
    public let inspectBackgroundProcesses: Bool

    public init(inspectBackgroundProcesses: Bool) {
        self.inspectBackgroundProcesses = inspectBackgroundProcesses
    }
}

public struct RuntimeOperatorConfiguration: Codable, Equatable, Sendable {
    public let defaultBackend: String
    public let maximumAccess: String

    public init(defaultBackend: String, maximumAccess: String) {
        self.defaultBackend = defaultBackend
        self.maximumAccess = maximumAccess
    }
}

public struct BridgeStatusProblem: Codable, Equatable, Sendable {
    public let code: String
    public let arguments: [String: String]

    public init(code: String, arguments: [String: String] = [:]) {
        self.code = code
        self.arguments = arguments
    }

    private enum CodingKeys: String, CodingKey {
        case code, arguments
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(String.self, forKey: .code)
        arguments = try container.decodeIfPresent(
            [String: String].self,
            forKey: .arguments
        ) ?? [:]
    }
}

public struct RuntimeConfigurationStatus: Codable, Sendable {
    public let path: String
    public let exists: Bool
    public let valid: Bool
    public let hasApiKey: Bool
    public let hasTunnelId: Bool
    public let tunnelId: String?
    public let operatorConfiguration: RuntimeOperatorConfiguration
    public let issue: String?
    public let issueProblem: BridgeStatusProblem?

    private enum CodingKeys: String, CodingKey {
        case path, exists, valid, hasApiKey, hasTunnelId, tunnelId
        case operatorConfiguration, issue, issueProblem
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        exists = try container.decode(Bool.self, forKey: .exists)
        valid = try container.decode(Bool.self, forKey: .valid)
        hasApiKey = try container.decode(Bool.self, forKey: .hasApiKey)
        hasTunnelId = try container.decode(Bool.self, forKey: .hasTunnelId)
        tunnelId = try container.decodeIfPresent(String.self, forKey: .tunnelId)
        operatorConfiguration = try container.decodeIfPresent(
            RuntimeOperatorConfiguration.self,
            forKey: .operatorConfiguration
        ) ?? RuntimeOperatorConfiguration(
            defaultBackend: "app-server",
            maximumAccess: "read-only"
        )
        issue = try container.decodeIfPresent(String.self, forKey: .issue)
        issueProblem = try container.decodeIfPresent(BridgeStatusProblem.self, forKey: .issueProblem)
    }
}

public struct HelperBridgeStatus: Codable, Sendable {
    public let socketPath: String
    public let connected: Bool
    public let acceptingNewJobs: Bool?
    public let activeJobs: Int?
    public let pendingAdmissions: Int?
    public let pendingInteractions: Int?
    public let memoryOnlyThreads: Int?
    public let protectedMemoryOnlyThreads: Int?
    public let discardableMemoryOnlyThreads: Int?
    public let backgroundProcessState: String?
    public let backgroundProcesses: Int?
    public let backgroundProcessAgents: Int?
    public let backgroundProcessUnknownAgents: Int?
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
    public let lastProblem: BridgeStatusProblem?
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
    public let lastProblem: BridgeStatusProblem?
    public let restartAttempt: Int
    public let configuration: RuntimeConfigurationStatus
    public let bridge: HelperBridgeStatus
    public let tunnel: HelperTunnelStatus
    public var lifecycle: RuntimeLifecycleOperation? = nil
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

public struct RuntimeConfigureParameters: Codable, Sendable {
    public let defaultBackend: String
    public let maximumAccess: String
    public let mode: String
    public let timeoutMs: Int

    public init(
        defaultBackend: String,
        maximumAccess: String,
        force: Bool,
        timeoutMilliseconds: Int
    ) {
        self.defaultBackend = defaultBackend
        self.maximumAccess = maximumAccess
        self.mode = force ? "force" : "drain"
        self.timeoutMs = timeoutMilliseconds
    }
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

/// A stable reference into the Bridge-owned Markdown skill library.
public struct BridgeSkillReference: Codable, Sendable, Equatable {
    public let skillId: String
    public let source: String
    public let version: String

    public init(skillId: String, source: String = "bridge", version: String) {
        self.skillId = skillId
        self.source = source
        self.version = version
    }
}

public struct BridgeSkillSummary: Codable, Sendable, Identifiable, Equatable {
    public var id: String { "\(source)-\(skillId)-\(version)" }
    public let skillId: String
    public let source: String
    public let version: String
    public let name: String
    /// Optional discovery metadata. An empty string has no special UI meaning.
    public let description: String
    public let contentDigest: String?
    public let enabled: Bool
    public let availability: String

    public var reference: BridgeSkillReference {
        BridgeSkillReference(skillId: skillId, source: source, version: version)
    }
}

public struct BridgeSkill: Codable, Sendable, Equatable, Identifiable {
    public var id: String { skill.id }
    public let skill: BridgeSkillSummary
    /// Exact authored source. The client renders this value but never rewrites it.
    public let content: String
    public let files: [BridgeSkillFileSummary]
    public let format: String
    /// A legacy structured version exposed through the lossless Markdown adapter.
    public let legacy: Bool
    public let sourceSnapshot: String
    public let warnings: [BridgeSkillWarningCode]
}

public enum BridgeSkillWarningCode: String, Codable, Sendable, Equatable {
    case archived
    case legacyStructured = "legacy-structured"
}

public struct BridgeSkillFileSummary: Codable, Sendable, Equatable, Identifiable {
    public var id: String { path }
    public let path: String
    public let format: String
    public let bytes: Int
    public let contentDigest: String
}

public struct BridgeSkillFileReadRequest: Codable, Sendable, Equatable {
    public let skillId: String
    public let source: String
    public let version: String
    public let path: String

    public init(reference: BridgeSkillReference, path: String) {
        skillId = reference.skillId
        source = reference.source
        version = reference.version
        self.path = path
    }
}

public struct BridgeSkillFile: Codable, Sendable, Equatable, Identifiable {
    public var id: String { "\(skill.id)-\(path)" }
    public let kind: String
    public let skill: BridgeSkillSummary
    public let path: String
    public let content: String
    public let format: String
    public let bytes: Int
    public let contentDigest: String
}

public struct BridgeSkillFileInput: Codable, Sendable, Equatable {
    public let path: String
    public let content: String

    public init(path: String, content: String) {
        self.path = path
        self.content = content
    }
}

public struct BridgeSkillFileChanges: Codable, Sendable, Equatable {
    public let upsert: [BridgeSkillFileInput]?
    public let remove: [String]?

    public init(upsert: [BridgeSkillFileInput]? = nil, remove: [String]? = nil) {
        self.upsert = upsert
        self.remove = remove
    }
}

public struct BridgeSkillLibrarySnapshot: Codable, Sendable, Equatable {
    public let skills: [BridgeSkillSummary]
}

public struct BridgeSkillVersionsParameters: Codable, Sendable, Equatable {
    public let skillId: String

    public init(skillId: String) {
        self.skillId = skillId
    }
}

public struct BridgeSkillVersionSummary: Codable, Sendable, Identifiable, Equatable {
    public var id: String { "\(source)-\(skillId)-\(version)" }
    public let skillId: String
    public let source: String
    public let version: String
    public let name: String
    public let description: String
    public let contentDigest: String
    public let createdAt: String
    public let format: String
    public let legacy: Bool

    public var reference: BridgeSkillReference {
        BridgeSkillReference(skillId: skillId, source: source, version: version)
    }
}

public struct BridgeSkillVersionList: Codable, Sendable, Equatable {
    public let skillId: String
    public let source: String
    public let currentVersion: String
    public let enabled: Bool
    public let versions: [BridgeSkillVersionSummary]
}

public struct BridgeSkillCreateRequest: Codable, Sendable, Equatable {
    public let requestId: String
    public let name: String
    public let description: String?
    public let content: String
    public let files: [BridgeSkillFileInput]?

    public init(
        requestId: String = UUID().uuidString,
        name: String,
        description: String? = nil,
        content: String,
        files: [BridgeSkillFileInput]? = nil
    ) {
        self.requestId = requestId
        self.name = name
        self.description = description
        self.content = content
        self.files = files
    }
}

public struct BridgeSkillUpdateRequest: Codable, Sendable, Equatable {
    public let requestId: String
    public let skillId: String
    public let expectedVersion: String
    public let name: String?
    public let description: String?
    public let content: String?
    public let files: BridgeSkillFileChanges?

    public init(
        requestId: String = UUID().uuidString,
        skillId: String,
        expectedVersion: String,
        name: String? = nil,
        description: String? = nil,
        content: String? = nil,
        files: BridgeSkillFileChanges? = nil
    ) {
        self.requestId = requestId
        self.skillId = skillId
        self.expectedVersion = expectedVersion
        self.name = name
        self.description = description
        self.content = content
        self.files = files
    }
}

public struct BridgeSkillRestoreRequest: Codable, Sendable, Equatable {
    public let requestId: String
    public let skillId: String
    public let expectedVersion: String
    public let sourceVersion: String

    public init(
        requestId: String = UUID().uuidString,
        skillId: String,
        expectedVersion: String,
        sourceVersion: String
    ) {
        self.requestId = requestId
        self.skillId = skillId
        self.expectedVersion = expectedVersion
        self.sourceVersion = sourceVersion
    }
}

public struct BridgeSkillSetEnabledRequest: Codable, Sendable, Equatable {
    public let requestId: String
    public let skillId: String
    public let expectedVersion: String
    public let enabled: Bool

    public init(
        requestId: String = UUID().uuidString,
        skillId: String,
        expectedVersion: String,
        enabled: Bool
    ) {
        self.requestId = requestId
        self.skillId = skillId
        self.expectedVersion = expectedVersion
        self.enabled = enabled
    }
}

/// Permanent deletion is intentionally native-only and version checked.
public struct BridgeSkillDeleteRequest: Codable, Sendable, Equatable {
    public let requestId: String
    public let skillId: String
    public let expectedVersion: String

    public init(
        requestId: String = UUID().uuidString,
        skillId: String,
        expectedVersion: String
    ) {
        self.requestId = requestId
        self.skillId = skillId
        self.expectedVersion = expectedVersion
    }
}

/// A permanent deletion intentionally returns no deleted skill metadata.
public struct BridgeSkillDeletion: Codable, Sendable, Equatable {
    public let skillId: String
    public let source: String
    public let deletedAt: String
}

public struct BridgeSkillPackageUploadStarted: Codable, Sendable, Equatable {
    public let uploadId: String
    public let expiresAt: String
    public let chunkMaxBytes: Int
}

public struct BridgeSkillPackageUploadChunk: Codable, Sendable, Equatable {
    public let uploadId: String
    public let chunkIndex: Int
    public let data: String

    public init(uploadId: String, chunkIndex: Int, data: String) {
        self.uploadId = uploadId
        self.chunkIndex = chunkIndex
        self.data = data
    }
}

public struct BridgeSkillPackageUploadProgress: Codable, Sendable, Equatable {
    public let receivedBytes: Int
    public let nextChunk: Int
}

public struct BridgeSkillPackageUploadReference: Codable, Sendable, Equatable {
    public let uploadId: String
    public init(uploadId: String) { self.uploadId = uploadId }
}

public struct BridgeSkillPackageIgnoredFile: Codable, Sendable, Equatable, Identifiable {
    public var id: String { "\(path)-\(reason)" }
    public let path: String
    public let reason: String
}

public struct BridgeSkillPackageInspection: Codable, Sendable, Equatable {
    public let uploadId: String
    public let expiresAt: String
    public let files: [BridgeSkillFileSummary]
    public let suggestedMainPath: String?
    public let suggestedName: String?
    public let suggestedDescription: String?
    public let ignored: [BridgeSkillPackageIgnoredFile]
    public let strippedWrapper: String?
}

public struct BridgeSkillPackageCreateRequest: Codable, Sendable, Equatable {
    public let requestId: String
    public let name: String
    public let description: String?
    public let uploadId: String
    public let mainPath: String
    public let includePaths: [String]?

    public init(requestId: String = UUID().uuidString, name: String, description: String? = nil,
                uploadId: String, mainPath: String, includePaths: [String]? = nil) {
        self.requestId = requestId
        self.name = name
        self.description = description
        self.uploadId = uploadId
        self.mainPath = mainPath
        self.includePaths = includePaths
    }
}

public struct BridgeSkillPackageUpdateRequest: Codable, Sendable, Equatable {
    public let requestId: String
    public let skillId: String
    public let expectedVersion: String
    public let uploadId: String
    public let mainPath: String?
    public let includePaths: [String]?

    public init(requestId: String = UUID().uuidString, skillId: String, expectedVersion: String,
                uploadId: String, mainPath: String?, includePaths: [String]? = nil) {
        self.requestId = requestId
        self.skillId = skillId
        self.expectedVersion = expectedVersion
        self.uploadId = uploadId
        self.mainPath = mainPath
        self.includePaths = includePaths
    }

    private enum CodingKeys: String, CodingKey {
        case requestId, skillId, expectedVersion, uploadId, mainPath, includePaths
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(requestId, forKey: .requestId)
        try container.encode(skillId, forKey: .skillId)
        try container.encode(expectedVersion, forKey: .expectedVersion)
        try container.encode(uploadId, forKey: .uploadId)
        if let mainPath { try container.encode(mainPath, forKey: .mainPath) }
        else { try container.encodeNil(forKey: .mainPath) }
        try container.encodeIfPresent(includePaths, forKey: .includePaths)
    }
}

public struct BridgeSkillPackageExport: Codable, Sendable, Equatable {
    public let fileName: String
    public let mediaType: String
    public let bytes: Int
    public let contentDigest: String
    public let data: String
}
