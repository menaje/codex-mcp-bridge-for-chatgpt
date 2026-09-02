import Foundation

public struct BridgeCompanionClient: Sendable {
    private let rpc: UnixSocketRPCClient

    public init(socketPath: String) {
        self.rpc = UnixSocketRPCClient(socketPath: socketPath)
    }

    public func dashboard(
        limit: Int = 20,
        terminalOffset: Int = 0,
        idleOffset: Int = 0
    ) async throws -> DashboardSnapshot {
        try await rpc.call(
            "dashboard.snapshot",
            params: DashboardParameters(
                limit: limit,
                terminalOffset: terminalOffset,
                idleOffset: idleOffset
            )
        )
    }

    public func settings(refreshModels: Bool = false) async throws -> SettingsSnapshot {
        try await rpc.call(
            "settings.snapshot",
            params: SettingsSnapshotParameters(refreshModels: refreshModels)
        )
    }

    public func updateSettings(_ mutation: SettingsMutation) async throws -> SettingsSnapshot {
        try await rpc.call("settings.update", params: mutation)
    }

    public func runtimeStatus() async throws -> RuntimeAdmissionSnapshot {
        try await rpc.call("runtime.snapshot", params: EmptyParameters())
    }
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
            )
        )
    }

    public func status() async throws -> HelperStatus {
        try await rpc.call("helper.status", params: EmptyParameters())
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
            )
        )
    }

    public func authStatus() async throws -> CodexLoginStatus {
        try await rpc.call("auth.status", params: EmptyParameters())
    }

    public func startLogin() async throws -> LoginStartResponse {
        try await rpc.call("auth.login", params: EmptyParameters())
    }

    public func startRuntime() async throws -> HelperStatus {
        try await rpc.call("runtime.start", params: EmptyParameters())
    }

    public func stopRuntime(force: Bool, timeoutMilliseconds: Int = 60_000) async throws -> HelperStatus {
        try await rpc.call(
            "runtime.stop",
            params: RuntimeControlParameters(
                mode: force ? "force" : "drain",
                timeoutMs: timeoutMilliseconds
            )
        )
    }

    public func restartRuntime(force: Bool, timeoutMilliseconds: Int = 60_000) async throws -> HelperStatus {
        try await rpc.call(
            "runtime.restart",
            params: RuntimeControlParameters(
                mode: force ? "force" : "drain",
                timeoutMs: timeoutMilliseconds
            )
        )
    }

    public func repairRuntime(force: Bool, timeoutMilliseconds: Int = 60_000) async throws -> HelperStatus {
        try await rpc.call(
            "runtime.repair",
            params: RuntimeControlParameters(
                mode: force ? "force" : "drain",
                timeoutMs: timeoutMilliseconds
            )
        )
    }

    public func logs(limit: Int = 100) async throws -> HelperLogs {
        try await rpc.call("runtime.logs", params: RuntimeLogsParameters(limit: limit))
    }
}
