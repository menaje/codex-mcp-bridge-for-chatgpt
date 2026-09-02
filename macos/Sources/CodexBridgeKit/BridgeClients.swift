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
            ),
            timeout: 20
        )
    }

    public func settings(refreshModels: Bool = false) async throws -> SettingsSnapshot {
        try await rpc.call(
            "settings.snapshot",
            params: SettingsSnapshotParameters(refreshModels: refreshModels),
            timeout: refreshModels ? 60 : 20
        )
    }

    public func updateSettings(_ mutation: SettingsMutation) async throws -> SettingsSnapshot {
        try await rpc.call("settings.update", params: mutation, timeout: 30)
    }

    public func runtimeStatus() async throws -> RuntimeAdmissionSnapshot {
        try await rpc.call("runtime.snapshot", params: EmptyParameters(), timeout: 15)
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
            ),
            timeout: Self.controlTimeout(timeoutMilliseconds, restartAfterStop: false)
        )
    }

    public func status() async throws -> HelperStatus {
        try await rpc.call("helper.status", params: EmptyParameters(), timeout: 15)
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

    public func authStatus() async throws -> CodexLoginStatus {
        try await rpc.call("auth.status", params: EmptyParameters(), timeout: 20)
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
