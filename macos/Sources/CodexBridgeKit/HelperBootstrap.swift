import Darwin
import Foundation

public enum HelperBootstrapError: LocalizedError, Sendable {
    case runtimeMissing
    case nodeMissing
    case launchFailed(String)
    case readinessTimeout
    case incompatibleHelper
    case replacementBlocked(String)
    case shutdownFailed(String)
    case shutdownTimeout

    public var errorDescription: String? {
        switch self {
        case .runtimeMissing:
            return "설치된 브리지 helper를 찾을 수 없습니다. 앱을 다시 설치해 주세요."
        case .nodeMissing:
            return "Node.js 22 이상을 찾을 수 없습니다. Node.js를 설치한 뒤 다시 시도해 주세요."
        case .launchFailed(let message):
            return "브리지 helper를 시작하지 못했습니다: \(message)"
        case .readinessTimeout:
            return "브리지 helper가 제한 시간 안에 준비되지 않았습니다."
        case .incompatibleHelper:
            return "실행 중인 브리지 helper가 현재 앱과 호환되지 않습니다. 앱을 다시 열어 갱신해 주세요."
        case .replacementBlocked(let message):
            return "실행 중인 작업을 안전하게 마치지 못해 helper 갱신을 중단했습니다: \(message)"
        case .shutdownFailed(let message):
            return "브리지 helper를 종료하지 못했습니다: \(message)"
        case .shutdownTimeout:
            return "브리지 helper가 제한 시간 안에 종료되지 않았습니다. 관련 프로세스가 남아 있을 수 있습니다."
        }
    }
}

public actor HelperBootstrap {
    public static let launchAgentLabel = "com.menaje.codex-mcp-bridge.helper"
    typealias LaunchctlResult = (status: Int32, output: String)
    typealias LaunchctlRunner = @Sendable ([String]) async -> LaunchctlResult
    private var developmentProcess: Process?
    private let launchctlRunner: LaunchctlRunner

    public init() {
        launchctlRunner = { arguments in
            await Self.runSystemLaunchctl(arguments)
        }
    }

    init(launchctlRunner: @escaping LaunchctlRunner) {
        self.launchctlRunner = launchctlRunner
    }

    public func ensureRunning(paths: RuntimePaths) async throws {
        let client = MacOSHelperClient(socketPath: paths.helperSocket.path)
        guard let bridgeRoot = paths.bridgeRoot, let helperScript = paths.helperScript else {
            throw HelperBootstrapError.runtimeMissing
        }
        guard let runtimeBuildID = paths.runtimeBuildID else {
            throw HelperBootstrapError.runtimeMissing
        }
        guard let nodeExecutable = paths.nodeExecutable else {
            throw HelperBootstrapError.nodeMissing
        }
        let currentHello = try? await client.hello()
        let currentIsCompatible = currentHello.map {
            Self.isCompatible($0, runtimeBuildID: runtimeBuildID)
        } ?? false
        let helperIsReachable: Bool
        if currentHello != nil {
            helperIsReachable = true
        } else {
            helperIsReachable = (try? await client.probe()) != nil
        }

        if paths.isPackagedRuntime {
            try await installAndStartLaunchAgent(
                nodeExecutable: nodeExecutable,
                helperScript: helperScript,
                bridgeRoot: bridgeRoot,
                environmentFile: paths.environmentFile,
                helperSocket: paths.helperSocket,
                bridgeSocket: paths.bridgeSocket,
                runtimeLockDirectory: paths.runtimeLockDirectory,
                runtimeBuildID: runtimeBuildID,
                forceRestart: !currentIsCompatible,
                client: client,
                helperIsReachable: helperIsReachable
            )
        } else {
            if currentIsCompatible { return }
            if currentHello != nil { throw HelperBootstrapError.incompatibleHelper }
            try startDevelopmentHelper(
                nodeExecutable: nodeExecutable,
                helperScript: helperScript,
                bridgeRoot: bridgeRoot,
                environmentFile: paths.environmentFile,
                helperSocket: paths.helperSocket,
                bridgeSocket: paths.bridgeSocket,
                runtimeLockDirectory: paths.runtimeLockDirectory
            )
        }

        for _ in 0..<40 {
            if let hello = try? await client.hello(),
               Self.isCompatible(hello, runtimeBuildID: runtimeBuildID) {
                return
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw HelperBootstrapError.readinessTimeout
    }

    /// Stops the helper for the current login session while preserving its
    /// LaunchAgent definition so an explicit app launch or the next login can
    /// start the service again.
    public func shutdown(paths: RuntimePaths) async throws {
        if paths.isPackagedRuntime {
            let service = "gui/\(getuid())/\(Self.launchAgentLabel)"
            try await stopLaunchAgent(service: service)
            try await waitForHelperShutdown(paths: paths)
            return
        }
        try await stopDevelopmentHelper()
        try await waitForRuntimeLockRelease(paths.runtimeLockDirectory)
    }

    func stopLaunchAgent(service: String) async throws {
        let state = await launchctl(["print", service])
        if isMissingService(state) { return }
        guard state.status == 0 else {
            throw HelperBootstrapError.shutdownFailed(
                launchctlFailure("print", state.output)
            )
        }

        let bootout = await launchctl(["bootout", service])
        guard bootout.status == 0 || isMissingService(bootout) else {
            throw HelperBootstrapError.shutdownFailed(
                launchctlFailure("bootout", bootout.output)
            )
        }

        for _ in 0..<40 {
            let current = await launchctl(["print", service])
            if isMissingService(current) { return }
            guard current.status == 0 else {
                throw HelperBootstrapError.shutdownFailed(
                    launchctlFailure("verify bootout", current.output)
                )
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw HelperBootstrapError.shutdownTimeout
    }

    private func stopDevelopmentHelper() async throws {
        guard let process = developmentProcess else { return }
        if process.isRunning { process.terminate() }
        for _ in 0..<40 {
            if !process.isRunning { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            for _ in 0..<20 {
                if !process.isRunning { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        guard !process.isRunning else { throw HelperBootstrapError.shutdownTimeout }
        developmentProcess = nil
    }

    private func waitForHelperShutdown(paths: RuntimePaths) async throws {
        let client = MacOSHelperClient(socketPath: paths.helperSocket.path)
        for _ in 0..<100 {
            let helperIsReachable = (try? await client.hello()) != nil
            let runtimeLockExists = FileManager.default.fileExists(
                atPath: paths.runtimeLockDirectory.path
            )
            if !helperIsReachable && !runtimeLockExists { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw HelperBootstrapError.shutdownTimeout
    }

    private func waitForRuntimeLockRelease(_ runtimeLockDirectory: URL) async throws {
        for _ in 0..<100 {
            if !FileManager.default.fileExists(atPath: runtimeLockDirectory.path) { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw HelperBootstrapError.shutdownTimeout
    }

    private func startDevelopmentHelper(
        nodeExecutable: URL,
        helperScript: URL,
        bridgeRoot: URL,
        environmentFile: URL,
        helperSocket: URL,
        bridgeSocket: URL,
        runtimeLockDirectory: URL
    ) throws {
        if let process = developmentProcess, process.isRunning { return }
        let process = Process()
        process.executableURL = nodeExecutable
        process.arguments = helperArguments(
            helperScript: helperScript,
            bridgeRoot: bridgeRoot,
            environmentFile: environmentFile,
            helperSocket: helperSocket,
            bridgeSocket: bridgeSocket,
            runtimeLockDirectory: runtimeLockDirectory
        )
        process.currentDirectoryURL = bridgeRoot
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            throw HelperBootstrapError.launchFailed(error.localizedDescription)
        }
        developmentProcess = process
    }

    private func installAndStartLaunchAgent(
        nodeExecutable: URL,
        helperScript: URL,
        bridgeRoot: URL,
        environmentFile: URL,
        helperSocket: URL,
        bridgeSocket: URL,
        runtimeLockDirectory: URL,
        runtimeBuildID: String,
        forceRestart: Bool,
        client: MacOSHelperClient,
        helperIsReachable: Bool
    ) async throws {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let launchAgents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        let plistURL = launchAgents.appendingPathComponent("\(Self.launchAgentLabel).plist")
        try FileManager.default.createDirectory(
            at: launchAgents,
            withIntermediateDirectories: true,
            attributes: nil
        )
        let plist: [String: Any] = [
            "Label": Self.launchAgentLabel,
            "ProgramArguments": [nodeExecutable.path] + helperArguments(
                helperScript: helperScript,
                bridgeRoot: bridgeRoot,
                environmentFile: environmentFile,
                helperSocket: helperSocket,
                bridgeSocket: bridgeSocket,
                runtimeLockDirectory: runtimeLockDirectory
            ),
            "WorkingDirectory": bridgeRoot.path,
            "RunAtLoad": true,
            "KeepAlive": true,
            "ProcessType": "Background",
            "ThrottleInterval": 10,
            "ExitTimeOut": 45,
            "StandardOutPath": "/dev/null",
            "StandardErrorPath": "/dev/null",
            "EnvironmentVariables": Self.launchAgentEnvironment(
                nodeExecutable: nodeExecutable,
                home: home
            )
        ]
        let data = try PropertyListSerialization.data(
            fromPropertyList: plist,
            format: .xml,
            options: 0
        )
        let previous: Data?
        if FileManager.default.fileExists(atPath: plistURL.path) {
            let attributes = try FileManager.default.attributesOfItem(atPath: plistURL.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else {
                throw HelperBootstrapError.launchFailed(
                    "기존 LaunchAgent plist가 일반 파일이 아닙니다: \(plistURL.path)"
                )
            }
            previous = try Data(contentsOf: plistURL)
        } else {
            previous = nil
        }
        let domain = "gui/\(getuid())"
        let service = "\(domain)/\(Self.launchAgentLabel)"
        let serviceState = await launchctl(["print", service])
        if serviceState.status != 0 && !isMissingService(serviceState) {
            throw HelperBootstrapError.launchFailed(
                launchctlFailure("print", serviceState.output)
            )
        }
        let loaded = serviceState.status == 0
        let needsRestart = previous != data || forceRestart
        if loaded && needsRestart && !helperIsReachable &&
            FileManager.default.fileExists(atPath: runtimeLockDirectory.path) {
            throw HelperBootstrapError.replacementBlocked(
                "기존 helper에 연결할 수 없어 활성 작업 여부를 확인하지 못했습니다."
            )
        }
        if loaded && needsRestart && helperIsReachable {
            do {
                try await client.prepareForReplacement()
            } catch {
                throw HelperBootstrapError.replacementBlocked(error.localizedDescription)
            }
        }
        do {
            try await replaceLaunchAgentDefinition(
                data: data,
                previous: previous,
                plistURL: plistURL,
                domain: domain,
                service: service,
                loaded: loaded,
                needsRestart: needsRestart,
                verifyReady: {
                    for _ in 0..<40 {
                        if let hello = try? await client.hello(),
                           Self.isCompatible(hello, runtimeBuildID: runtimeBuildID) {
                            return true
                        }
                        try? await Task.sleep(nanoseconds: 250_000_000)
                    }
                    return false
                }
            )
        } catch {
            if loaded && needsRestart && helperIsReachable {
                _ = try? await client.startRuntime()
            }
            throw error
        }
    }

    func replaceLaunchAgentDefinition(
        data: Data,
        previous: Data?,
        plistURL: URL,
        domain: String,
        service: String,
        loaded: Bool,
        needsRestart: Bool,
        verifyReady: (@Sendable () async -> Bool)? = nil
    ) async throws {
        var definitionChanged = false
        var oldServiceBootedOut = false
        var replacementServiceMayBeLoaded = false
        do {
            if previous != data {
                try data.write(to: plistURL, options: .atomic)
                definitionChanged = true
            }
            if loaded && needsRestart {
                let bootout = await launchctl(["bootout", service])
                guard bootout.status == 0 else {
                    throw HelperBootstrapError.launchFailed(
                        launchctlFailure("bootout", bootout.output)
                    )
                }
                oldServiceBootedOut = true
            }
            if !loaded || needsRestart {
                replacementServiceMayBeLoaded = true
                let bootstrap = await bootstrapLaunchAgent(
                    domain: domain,
                    plistURL: plistURL
                )
                guard bootstrap.status == 0 ||
                        bootstrap.output.localizedCaseInsensitiveContains("already") else {
                    throw HelperBootstrapError.launchFailed(
                        launchctlFailure("bootstrap", bootstrap.output)
                    )
                }
            }
            let kickstart = await launchctl(["kickstart", service])
            guard kickstart.status == 0 else {
                throw HelperBootstrapError.launchFailed(
                    launchctlFailure("kickstart", kickstart.output)
                )
            }
            if let verifyReady, !(await verifyReady()) {
                throw HelperBootstrapError.readinessTimeout
            }
        } catch {
            let recoveryFailure = await rollbackLaunchAgentDefinition(
                previous: previous,
                plistURL: plistURL,
                domain: domain,
                service: service,
                restoreLoadedService: loaded && oldServiceBootedOut,
                unloadReplacement: replacementServiceMayBeLoaded,
                restoreDefinition: definitionChanged
            )
            guard let recoveryFailure else { throw error }
            throw HelperBootstrapError.launchFailed(
                "\(error.localizedDescription) 이전 helper 복구에도 실패했습니다: \(recoveryFailure)"
            )
        }
    }

    private func rollbackLaunchAgentDefinition(
        previous: Data?,
        plistURL: URL,
        domain: String,
        service: String,
        restoreLoadedService: Bool,
        unloadReplacement: Bool,
        restoreDefinition: Bool
    ) async -> String? {
        var failures: [String] = []
        if unloadReplacement {
            let bootout = await launchctl(["bootout", service])
            if bootout.status != 0 &&
                !bootout.output.localizedCaseInsensitiveContains("not found") &&
                !bootout.output.localizedCaseInsensitiveContains("no such") {
                failures.append(launchctlFailure("replacement bootout", bootout.output))
            }
        }
        if restoreDefinition {
            do {
                if let previous {
                    try previous.write(to: plistURL, options: .atomic)
                } else if FileManager.default.fileExists(atPath: plistURL.path) {
                    try FileManager.default.removeItem(at: plistURL)
                }
            } catch {
                failures.append("plist restore: \(error.localizedDescription)")
            }
        }
        if restoreLoadedService {
            guard previous != nil else {
                failures.append("previous LaunchAgent definition is unavailable")
                return failures.joined(separator: "; ")
            }
            let bootstrap = await bootstrapLaunchAgent(
                domain: domain,
                plistURL: plistURL
            )
            if bootstrap.status != 0 &&
                !bootstrap.output.localizedCaseInsensitiveContains("already") {
                failures.append(launchctlFailure("previous bootstrap", bootstrap.output))
            } else {
                let kickstart = await launchctl(["kickstart", service])
                if kickstart.status != 0 {
                    failures.append(launchctlFailure("previous kickstart", kickstart.output))
                }
            }
        }
        return failures.isEmpty ? nil : failures.joined(separator: "; ")
    }

    private func launchctlFailure(_ operation: String, _ output: String) -> String {
        let detail = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return detail.isEmpty ? "launchctl \(operation) failed" : "launchctl \(operation): \(detail)"
    }

    private func bootstrapLaunchAgent(
        domain: String,
        plistURL: URL
    ) async -> LaunchctlResult {
        var result = await launchctl(["bootstrap", domain, plistURL.path])
        for retry in 1...3 {
            if result.status == 0 ||
                result.output.localizedCaseInsensitiveContains("already") ||
                !result.output.localizedCaseInsensitiveContains("input/output error") {
                return result
            }
            try? await Task.sleep(nanoseconds: UInt64(retry) * 250_000_000)
            result = await launchctl(["bootstrap", domain, plistURL.path])
        }
        return result
    }

    private func isMissingService(_ result: LaunchctlResult) -> Bool {
        result.status == 113 ||
            result.output.localizedCaseInsensitiveContains("could not find service") ||
            result.output.localizedCaseInsensitiveContains("not found") ||
            result.output.localizedCaseInsensitiveContains("no such")
    }

    static func isCompatible(_ hello: HelperHello, runtimeBuildID: String) -> Bool {
        hello.protocol.name == HelperHello.expectedProtocolName &&
            hello.protocol.version == HelperHello.expectedProtocolVersion &&
            hello.runtime.buildId == runtimeBuildID &&
            hello.capabilities.contains("setup.dotenv.atomic-apply") &&
            hello.capabilities.contains("setup.dotenv.repair-permissions") &&
            hello.capabilities.contains("runtime.configure")
    }

    private func helperArguments(
        helperScript: URL,
        bridgeRoot: URL,
        environmentFile: URL,
        helperSocket: URL,
        bridgeSocket: URL,
        runtimeLockDirectory: URL
    ) -> [String] {
        [
            "--", helperScript.path,
            "--bridge-root", bridgeRoot.path,
            "--env-file", environmentFile.path,
            "--socket", helperSocket.path,
            "--bridge-socket", bridgeSocket.path,
            "--runtime-lock-directory", runtimeLockDirectory.path
        ]
    }

    static func launchAgentEnvironment(
        nodeExecutable: URL,
        home: URL
    ) -> [String: String] {
        let candidates = [
            nodeExecutable.deletingLastPathComponent().path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            home.appendingPathComponent(".local/bin").path,
            home.appendingPathComponent(".npm-global/bin").path,
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin"
        ]
        var seen = Set<String>()
        let path = candidates.filter { seen.insert($0).inserted }.joined(separator: ":")
        return [
            "HOME": home.path,
            "PATH": path
        ]
    }

    private func launchctl(_ arguments: [String]) async -> (status: Int32, output: String) {
        await launchctlRunner(arguments)
    }

    private static func runSystemLaunchctl(_ arguments: [String]) async -> LaunchctlResult {
        await Task.detached(priority: .utility) {
            let process = Process()
            let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = arguments
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                try process.run()
                process.waitUntilExit()
                let output = String(
                    data: pipe.fileHandleForReading.readDataToEndOfFile(),
                    encoding: .utf8
                ) ?? ""
                return (process.terminationStatus, output.trimmingCharacters(in: .whitespacesAndNewlines))
            } catch {
                return (1, error.localizedDescription)
            }
        }.value
    }
}
