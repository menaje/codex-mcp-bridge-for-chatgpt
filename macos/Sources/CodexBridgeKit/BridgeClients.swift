import Foundation

public struct BridgeCompanionClient: Sendable {
    let rpc: UnixSocketRPCClient

    public init(socketPath: String) {
        self.rpc = UnixSocketRPCClient(socketPath: socketPath)
    }

    public func threadHandoff(rowKey: String, codexThreadUrl: String, action: String) async throws -> ThreadHandoffStatus {
        try await rpc.call("thread.handoff", params: ThreadHandoffParameters(rowKey: rowKey, codexThreadUrl: codexThreadUrl, action: action))
    }

    public func waitForChanges(after: String?) async throws -> ChangeNotice {
        try await rpc.call("changes.wait", params: ChangeWaitParameters(after: after), timeout: 30)
    }

    public func dashboard(
        limit: Int = 20,
        terminalOffset: Int = 0,
        idleOffset: Int = 0,
        enrich: Bool = false,
        statusFilter: DashboardStatusFilter = .all
    ) async throws -> DashboardSnapshot {
        try await rpc.call(
            "dashboard.snapshot",
            params: DashboardParameters(
                limit: limit,
                terminalOffset: terminalOffset,
                idleOffset: idleOffset,
                enrich: enrich,
                statusFilter: statusFilter
            ),
            timeout: enrich ? 10 : 2
        )
    }

    public func settings(
        refreshModels: Bool = false,
        locale: String = Locale.current.identifier
    ) async throws -> SettingsSnapshot {
        try await rpc.call(
            "settings.snapshot",
            params: SettingsSnapshotParameters(refreshModels: refreshModels, locale: locale),
            timeout: refreshModels ? 60 : 20
        )
    }

    public func updateSettings(_ mutation: SettingsMutation) async throws -> SettingsSnapshot {
        try await rpc.call("settings.update", params: mutation, timeout: 30)
    }

    public func historyAction(_ action: HistoryAction) async throws -> HistoryActionResult {
        try await rpc.call("dashboard.history", params: action, timeout: 15)
    }

    public func dashboardWithProblems(limit: Int, terminalOffset: Int, idleOffset: Int, enrich: Bool,
                                      statusFilter: DashboardStatusFilter, problems: ProblemQuery) async throws -> DashboardSnapshot {
        try await rpc.call("dashboard.snapshot", params: DashboardParameters(limit: limit, terminalOffset: terminalOffset,
            idleOffset: idleOffset, enrich: enrich, statusFilter: statusFilter, problems: problems), timeout: enrich ? 10 : 3)
    }

    public func problemAction(_ action: ProblemAction) async throws -> ProblemActionResult {
        try await rpc.call("dashboard.problem", params: action, timeout: action.action == .retryStop ? 120 : 15)
    }

    public func runtimeStatus(
        inspectBackgroundProcesses: Bool = false
    ) async throws -> RuntimeAdmissionSnapshot {
        try await rpc.call(
            "runtime.snapshot",
            params: RuntimeSnapshotParameters(
                inspectBackgroundProcesses: inspectBackgroundProcesses
            ),
            timeout: 15
        )
    }
}

private struct ThreadHandoffParameters: Encodable, Sendable {
    let rowKey: String
    let codexThreadUrl: String
    let action: String
}

public struct MacOSHelperClient: Sendable {
    private let rpc: UnixSocketRPCClient

    public init(socketPath: String) {
        self.rpc = UnixSocketRPCClient(socketPath: socketPath)
    }

    public func hello() async throws -> HelperHello {
        try await rpc.call("helper.hello", params: EmptyParameters())
    }

    public func probe() async throws {
        let _: EmptyParameters = try await rpc.call(
            "helper.hello",
            params: EmptyParameters()
        )
    }

    public func prepareForReplacement(timeoutMilliseconds: Int = 60_000) async throws {
        let _: EmptyParameters = try await rpc.call(
            "runtime.stop",
            params: RuntimeControlParameters(
                mode: "drain",
                timeoutMs: timeoutMilliseconds
            ),
            timeout: Self.controlTimeout(timeoutMilliseconds, restartAfterStop: false)
        )
    }

    public func reserveReplacement(targetBuildID: String) async throws -> String? {
        do {
            let current = try await lifecycleStatus()
            let operation: RuntimeLifecycleOperation
            if let current, current.isPending {
                guard current.kind == "helper-replace", current.targetBuildId == targetBuildID else {
                    throw HelperBootstrapError.replacementBlocked("LIFECYCLE_BUSY")
                }
                operation = current
            } else {
                operation = try await requestLifecycle(.init(kind: "helper-replace", targetBuildId: targetBuildID))
            }
            guard operation.needsHandoff else { throw HelperBootstrapError.replacementPending }
            _ = try await acknowledgeLifecycle(requestId: operation.requestId)
            return operation.requestId
        } catch let error as LocalRPCError where error.isUnsupportedMethod {
            // One-time migration from helpers predating durable reservations.
            try await prepareForReplacement()
            return nil
        }
    }

    public func waitForChanges(after: String?) async throws -> ChangeNotice {
        try await rpc.call("changes.wait", params: ChangeWaitParameters(after: after), timeout: 30)
    }

    public func health() async throws -> HelperStatus {
        do { return try await rpc.call("helper.health", params: EmptyParameters(), timeout: 5) }
        catch let error as LocalRPCError where error.isUnsupportedMethod { return try await status() }
    }

    public func status() async throws -> HelperStatus {
        try await rpc.call("helper.status", params: EmptyParameters(), timeout: 15)
    }

    public func requestLifecycle(_ request: RuntimeLifecycleRequest) async throws -> RuntimeLifecycleOperation {
        // A lost receipt may be retried, using the same ID and exact payload.
        let operation: RuntimeLifecycleOperation
        do { operation = try await rpc.call("lifecycle.request", params: request, timeout: 20) }
        catch let error as LocalRPCError {
            switch error {
            case .connectionFailed, .writeFailed, .emptyResponse:
                try Task.checkCancellation()
                operation = try await rpc.call("lifecycle.request", params: request, timeout: 20)
            default: throw error
            }
        }
        guard operation.requestId == request.requestId else { throw LocalRPCError.malformedResponse("LIFECYCLE_ID_CONFLICT") }
        return operation
    }

    public func lifecycleStatus(requestId: String? = nil) async throws -> RuntimeLifecycleOperation? {
        let response: RuntimeLifecycleStatus = try await rpc.call("lifecycle.status", params: RuntimeLifecycleReference(requestId: requestId))
        return response.operation
    }

    public func cancelLifecycle(requestId: String) async throws -> RuntimeLifecycleOperation {
        try await rpc.call("lifecycle.cancel", params: RuntimeLifecycleReference(requestId: requestId))
    }

    public func acknowledgeLifecycle(requestId: String) async throws -> RuntimeLifecycleOperation {
        try await rpc.call("lifecycle.acknowledge", params: RuntimeLifecycleReference(requestId: requestId))
    }

    public func discoverSetup() async throws -> TunnelSetupDiscovery {
        try await rpc.call("setup.discover", params: EmptyParameters(), timeout: 15)
    }

    public func importSetup(
        candidateId: String,
        force: Bool = false,
        timeoutMilliseconds: Int = 60_000
    ) async throws -> SetupApplyResponse {
        try await rpc.call(
            "setup.import",
            params: SetupImportParameters(
                candidateId: candidateId,
                force: force,
                timeoutMilliseconds: timeoutMilliseconds
            ),
            timeout: Self.configurationApplyTimeout(timeoutMilliseconds)
        )
    }

    public func applySetup(
        apiKey: String?,
        tunnelId: String?,
        force: Bool = false,
        timeoutMilliseconds: Int = 60_000
    ) async throws -> SetupApplyResponse {
        try await rpc.call(
            "setup.apply",
            params: SetupApplyParameters(
                apiKey: apiKey,
                tunnelId: tunnelId,
                force: force,
                timeoutMilliseconds: timeoutMilliseconds
            ),
            timeout: Self.configurationApplyTimeout(timeoutMilliseconds)
        )
    }

    public func configureRuntime(
        defaultBackend: String,
        maximumAccess: String,
        force: Bool = false,
        timeoutMilliseconds: Int = 60_000
    ) async throws -> SetupApplyResponse {
        try await rpc.call(
            "runtime.configure",
            params: RuntimeConfigureParameters(
                defaultBackend: defaultBackend,
                maximumAccess: maximumAccess,
                force: force,
                timeoutMilliseconds: timeoutMilliseconds
            ),
            timeout: Self.configurationApplyTimeout(timeoutMilliseconds)
        )
    }

    public func authStatus() async throws -> CodexLoginStatus {
        try await rpc.call("auth.status", params: EmptyParameters(), timeout: 20)
    }

    public func codexRuntime(_ request: CodexRuntimeRequest = .init(action: "status")) async throws -> CodexRuntimeSnapshot {
        try await rpc.call("codex.runtime", params: request, timeout: 30)
    }

    public func repairConfigurationPermissions() async throws -> RuntimeConfigurationStatus {
        try await rpc.call(
            "setup.repair-permissions",
            params: EmptyParameters(),
            timeout: 20
        )
    }

    public func startLogin() async throws -> LoginStartResponse {
        try await rpc.call("auth.login", params: EmptyParameters(), timeout: 20)
    }

    public func startRuntime() async throws -> HelperStatus {
        try await rpc.call("runtime.start", params: EmptyParameters(), timeout: 90)
    }

    public func stopRuntime(force: Bool, timeoutMilliseconds: Int = 60_000) async throws -> HelperStatus {
        try await rpc.call(
            "runtime.stop",
            params: RuntimeControlParameters(
                mode: force ? "force" : "drain",
                timeoutMs: timeoutMilliseconds
            ),
            timeout: Self.controlTimeout(timeoutMilliseconds, restartAfterStop: false)
        )
    }

    public func prepareApplicationShutdown(
        force: Bool,
        timeoutMilliseconds: Int = 60_000
    ) async throws -> HelperStatus {
        try await rpc.call(
            "helper.prepare-shutdown",
            params: RuntimeControlParameters(
                mode: force ? "force" : "drain",
                timeoutMs: timeoutMilliseconds
            ),
            timeout: Self.controlTimeout(timeoutMilliseconds, restartAfterStop: false)
        )
    }

    public func restartRuntime(force: Bool, timeoutMilliseconds: Int = 60_000) async throws -> HelperStatus {
        try await rpc.call(
            "runtime.restart",
            params: RuntimeControlParameters(
                mode: force ? "force" : "drain",
                timeoutMs: timeoutMilliseconds
            ),
            timeout: Self.controlTimeout(timeoutMilliseconds, restartAfterStop: true)
        )
    }

    public func repairRuntime(force: Bool, timeoutMilliseconds: Int = 60_000) async throws -> HelperStatus {
        try await rpc.call(
            "runtime.repair",
            params: RuntimeControlParameters(
                mode: force ? "force" : "drain",
                timeoutMs: timeoutMilliseconds
            ),
            timeout: Self.controlTimeout(timeoutMilliseconds, restartAfterStop: true)
        )
    }

    public func logs(limit: Int = 100) async throws -> HelperLogs {
        try await rpc.call(
            "runtime.logs",
            params: RuntimeLogsParameters(limit: limit),
            timeout: 15
        )
    }

    private static func controlTimeout(
        _ requestedMilliseconds: Int,
        restartAfterStop: Bool
    ) -> TimeInterval {
        let requestedSeconds = TimeInterval(max(0, requestedMilliseconds)) / 1_000
        // The helper can spend the requested time draining, up to 20 seconds
        // stopping the launcher, and another 60 seconds starting it again.
        return requestedSeconds + (restartAfterStop ? 90 : 30)
    }

    private static func configurationApplyTimeout(_ requestedMilliseconds: Int) -> TimeInterval {
        let requestedSeconds = TimeInterval(max(0, requestedMilliseconds)) / 1_000
        // A failed replacement can consume a full startup timeout and then
        // start the restored configuration before returning the final error.
        return requestedSeconds + 180
    }
}
