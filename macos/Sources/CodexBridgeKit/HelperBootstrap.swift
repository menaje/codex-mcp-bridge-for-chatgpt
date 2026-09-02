import Darwin
import Foundation

public enum HelperBootstrapError: LocalizedError, Sendable {
    case runtimeMissing
    case nodeMissing
    case launchFailed(String)
    case readinessTimeout
    case incompatibleHelper
    case replacementBlocked(String)

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
        }
    }
}

public actor HelperBootstrap {
    public static let launchAgentLabel = "com.menaje.codex-mcp-bridge.helper"
    private var developmentProcess: Process?

    public init() {}

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
        let previous = try? Data(contentsOf: plistURL)
        let domain = "gui/\(getuid())"
        let service = "\(domain)/\(Self.launchAgentLabel)"
        let loaded = await launchctl(["print", service]).status == 0
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
        if previous != data {
            do {
                try data.write(to: plistURL, options: .atomic)
            } catch {
                if loaded && needsRestart && helperIsReachable {
                    _ = try? await client.startRuntime()
                }
                throw error
            }
        }
        if loaded && needsRestart {
            _ = await launchctl(["bootout", service])
        }
        if !loaded || needsRestart {
            let bootstrap = await launchctl(["bootstrap", domain, plistURL.path])
            if bootstrap.status != 0 && !bootstrap.output.localizedCaseInsensitiveContains("already") {
                throw HelperBootstrapError.launchFailed(bootstrap.output)
            }
        }
        let kickstart = await launchctl(["kickstart", service])
        if kickstart.status != 0 {
            throw HelperBootstrapError.launchFailed(kickstart.output)
        }
    }

    static func isCompatible(_ hello: HelperHello, runtimeBuildID: String) -> Bool {
        hello.protocol.name == HelperHello.expectedProtocolName &&
            hello.protocol.version == HelperHello.expectedProtocolVersion &&
            hello.runtime.buildId == runtimeBuildID &&
            hello.capabilities.contains("setup.dotenv.atomic-apply") &&
            hello.capabilities.contains("setup.dotenv.repair-permissions")
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
