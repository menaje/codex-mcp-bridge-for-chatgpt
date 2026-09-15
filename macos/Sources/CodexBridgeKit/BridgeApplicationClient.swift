import Foundation

/// Matches the Bridge companion envelope for the main document plus files.
public let bridgeSkillTransportEnvelopeMaxBytes = 72 * 1_024 * 1_024
public let bridgeSkillPackageCompressedMaxBytes = 16 * 1_024 * 1_024

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

    func skillLibrary() async throws -> BridgeSkillLibrarySnapshot
    func readBridgeSkill(_ reference: BridgeSkillReference) async throws -> BridgeSkillDocument
    func readBridgeSkillFile(_ reference: BridgeSkillReference, path: String) async throws -> BridgeSkillFileDocument
    func bridgeSkillVersions(skillId: String) async throws -> BridgeSkillVersionList
    func createBridgeSkill(_ request: BridgeSkillCreateRequest) async throws -> BridgeSkillSummary
    func updateBridgeSkill(_ request: BridgeSkillUpdateRequest) async throws -> BridgeSkillSummary
    func restoreBridgeSkill(_ request: BridgeSkillRestoreRequest) async throws -> BridgeSkillSummary
    func setBridgeSkillEnabled(_ request: BridgeSkillSetEnabledRequest) async throws -> BridgeSkillSummary
    func deleteBridgeSkill(_ request: BridgeSkillDeleteRequest) async throws -> BridgeSkillDeletion
    func uploadBridgeSkillPackage(_ archive: Data) async throws -> BridgeSkillPackageInspection
    func uploadBridgeSkillPackage(at archiveURL: URL) async throws -> BridgeSkillPackageInspection
    func createBridgeSkillPackage(_ request: BridgeSkillPackageCreateRequest) async throws -> BridgeSkillSummary
    func updateBridgeSkillPackage(_ request: BridgeSkillPackageUpdateRequest) async throws -> BridgeSkillSummary
    func exportBridgeSkillPackage(_ reference: BridgeSkillReference) async throws -> BridgeSkillPackageExport

    func historyAction(_ action: HistoryAction) async throws -> HistoryActionResult

    func dashboardHistoryDetail(rowKey: String) async throws -> DashboardHistoryDetail

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

    func dashboardHistoryDetail(rowKey: String) async throws -> DashboardHistoryDetail {
        throw NSError(domain: "DASHBOARD_HISTORY_DETAIL_UNSUPPORTED", code: 1)
    }

    func skillLibrary() async throws -> BridgeSkillLibrarySnapshot {
        throw NSError(domain: "SKILL_LIBRARY_UNAVAILABLE", code: 1)
    }

    func readBridgeSkill(_ reference: BridgeSkillReference) async throws -> BridgeSkillDocument {
        throw NSError(domain: "SKILL_LIBRARY_UNAVAILABLE", code: 1)
    }

    func readBridgeSkillFile(_ reference: BridgeSkillReference, path: String) async throws -> BridgeSkillFileDocument {
        throw NSError(domain: "SKILL_LIBRARY_UNAVAILABLE", code: 1)
    }

    func bridgeSkillVersions(skillId: String) async throws -> BridgeSkillVersionList {
        throw NSError(domain: "SKILL_LIBRARY_UNAVAILABLE", code: 1)
    }

    func createBridgeSkill(_ request: BridgeSkillCreateRequest) async throws -> BridgeSkillSummary {
        throw NSError(domain: "SKILL_LIBRARY_UNAVAILABLE", code: 1)
    }

    func updateBridgeSkill(_ request: BridgeSkillUpdateRequest) async throws -> BridgeSkillSummary {
        throw NSError(domain: "SKILL_LIBRARY_UNAVAILABLE", code: 1)
    }

    func restoreBridgeSkill(_ request: BridgeSkillRestoreRequest) async throws -> BridgeSkillSummary {
        throw NSError(domain: "SKILL_LIBRARY_UNAVAILABLE", code: 1)
    }

    func setBridgeSkillEnabled(_ request: BridgeSkillSetEnabledRequest) async throws -> BridgeSkillSummary {
        throw NSError(domain: "SKILL_LIBRARY_UNAVAILABLE", code: 1)
    }

    func deleteBridgeSkill(_ request: BridgeSkillDeleteRequest) async throws -> BridgeSkillDeletion {
        throw NSError(domain: "SKILL_LIBRARY_UNAVAILABLE", code: 1)
    }
    func uploadBridgeSkillPackage(_ archive: Data) async throws -> BridgeSkillPackageInspection {
        throw NSError(domain: "SKILL_PACKAGE_UNAVAILABLE", code: 1)
    }

    func uploadBridgeSkillPackage(at archiveURL: URL) async throws -> BridgeSkillPackageInspection {
        let archive = try Data(contentsOf: archiveURL, options: [.mappedIfSafe])
        return try await uploadBridgeSkillPackage(archive)
    }

    func createBridgeSkillPackage(_ request: BridgeSkillPackageCreateRequest) async throws -> BridgeSkillSummary {
        throw NSError(domain: "SKILL_PACKAGE_UNAVAILABLE", code: 1)
    }

    func updateBridgeSkillPackage(_ request: BridgeSkillPackageUpdateRequest) async throws -> BridgeSkillSummary {
        throw NSError(domain: "SKILL_PACKAGE_UNAVAILABLE", code: 1)
    }

    func exportBridgeSkillPackage(_ reference: BridgeSkillReference) async throws -> BridgeSkillPackageExport {
        throw NSError(domain: "SKILL_PACKAGE_UNAVAILABLE", code: 1)
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
