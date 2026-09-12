import Foundation

public protocol BridgeApplicationClient: Sendable {
    func dashboard(
        limit: Int,
        terminalOffset: Int,
        idleOffset: Int,
        enrich: Bool,
        statusFilter: DashboardStatusFilter
    ) async throws -> DashboardSnapshot

    func settings(
        refreshModels: Bool,
        locale: String
    ) async throws -> SettingsSnapshot

    func updateSettings(_ mutation: SettingsMutation) async throws -> SettingsSnapshot

    func historyAction(_ action: HistoryAction) async throws -> HistoryActionResult

    func dashboardWithProblems(limit: Int, terminalOffset: Int, idleOffset: Int, enrich: Bool,
                               statusFilter: DashboardStatusFilter, problems: ProblemQuery) async throws -> DashboardSnapshot
    func dashboardWithProblems(limit: Int, terminalOffset: Int, idleOffset: Int, enrich: Bool,
                               statusFilter: DashboardStatusFilter, problems: ProblemQuery,
                               includeHistory: Bool) async throws -> DashboardSnapshot
    func problemAction(_ action: ProblemAction) async throws -> ProblemActionResult

    func runtimeStatus(
        inspectBackgroundProcesses: Bool
    ) async throws -> RuntimeAdmissionSnapshot
}

public extension BridgeApplicationClient {
    func dashboardWithProblems(limit: Int, terminalOffset: Int, idleOffset: Int, enrich: Bool,
                               statusFilter: DashboardStatusFilter, problems: ProblemQuery) async throws -> DashboardSnapshot {
        try await dashboard(limit: limit, terminalOffset: terminalOffset, idleOffset: idleOffset, enrich: enrich, statusFilter: statusFilter)
    }

    func dashboardWithProblems(limit: Int, terminalOffset: Int, idleOffset: Int, enrich: Bool,
                               statusFilter: DashboardStatusFilter, problems: ProblemQuery,
                               includeHistory: Bool) async throws -> DashboardSnapshot {
        try await dashboardWithProblems(
            limit: limit, terminalOffset: terminalOffset, idleOffset: idleOffset,
            enrich: enrich, statusFilter: statusFilter, problems: problems
        )
    }

    func problemAction(_ action: ProblemAction) async throws -> ProblemActionResult {
        throw NSError(domain: "PROBLEMS_UNSUPPORTED", code: 1)
    }

    func historyAction(_ action: HistoryAction) async throws -> HistoryActionResult {
        throw NSError(domain: "HISTORY_UNSUPPORTED", code: 1)
    }
}

public protocol RemoteBridgeApplicationClient: BridgeApplicationClient {
    func hello() async throws -> RemoteCompanionHello
    func close()
}

extension BridgeCompanionClient: BridgeApplicationClient {}

public struct CompanionProtocolInfo: Codable, Sendable, Equatable {
    public let name: String
    public let version: Int
}

public struct CompanionBridgeInfo: Codable, Sendable, Equatable {
    public let name: String
    public let title: String
    public let version: String
    public let buildId: String
}

public struct CompanionHello: Codable, Sendable, Equatable {
    public let `protocol`: CompanionProtocolInfo
    public let bridge: CompanionBridgeInfo
    public let capabilities: [String]
}

public struct RemoteManagementDevice: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let createdAt: String
    public let lastSeenAt: String?
    public let capabilities: [String]
}

public struct RemoteManagementStatus: Codable, Sendable, Equatable {
    public let enabled: Bool
    public let listening: Bool
    public let endpoint: String?
    public let displayName: String
    public let serverId: String
    public let certificateSha256: String?
    public let lastError: String?
    public let lastProblem: BridgeStatusProblem?
    public let devices: [RemoteManagementDevice]
}

public struct RemoteManagementConfigureParameters: Codable, Sendable {
    public let enabled: Bool
    public let endpoint: String
    public let displayName: String

    public init(enabled: Bool, endpoint: String, displayName: String) {
        self.enabled = enabled
        self.endpoint = endpoint
        self.displayName = displayName
    }
}

public struct RemotePairingParameters: Codable, Sendable {
    public let expiresInSeconds: Int

    public init(expiresInSeconds: Int = 300) {
        self.expiresInSeconds = expiresInSeconds
    }
}

public struct RemotePairingInvitation: Codable, Sendable, Equatable {
    public let invitation: String
    public let endpoint: String
    public let serverId: String
    public let certificateSha256: String
    public let expiresAt: String
}

public struct RemoteDeviceRevokeParameters: Codable, Sendable {
    public let deviceId: String

    public init(deviceId: String) {
        self.deviceId = deviceId
    }
}

public extension BridgeCompanionClient {
    func hello() async throws -> CompanionHello {
        try await rpc.call("companion.hello", params: EmptyParameters())
    }

    func remoteManagementStatus() async throws -> RemoteManagementStatus {
        try await rpc.call("remote.status", params: EmptyParameters())
    }

    func configureRemoteManagement(
        enabled: Bool,
        endpoint: String,
        displayName: String
    ) async throws -> RemoteManagementStatus {
        try await rpc.call(
            "remote.configure",
            params: RemoteManagementConfigureParameters(
                enabled: enabled,
                endpoint: endpoint,
                displayName: displayName
            ),
            timeout: 45
        )
    }

    func beginRemotePairing(expiresInSeconds: Int = 300) async throws -> RemotePairingInvitation {
        try await rpc.call(
            "remote.pairing.begin",
            params: RemotePairingParameters(expiresInSeconds: expiresInSeconds)
        )
    }

    func revokeRemoteDevice(_ deviceId: String) async throws -> RemoteManagementStatus {
        try await rpc.call(
            "remote.devices.revoke",
            params: RemoteDeviceRevokeParameters(deviceId: deviceId)
        )
    }
}
