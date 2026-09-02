import Foundation

public struct RuntimePaths: Sendable {
    public let configurationDirectory: URL
    public let environmentFile: URL
    public let helperSocket: URL
    public let bridgeSocket: URL
    public let bridgeRoot: URL?
    public let runtimeBuildID: String?
    public let nodeExecutable: URL?
    private let launchAgentDisabled: Bool

    public init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main,
        currentDirectory: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    ) {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let configHome = environment["XDG_CONFIG_HOME"].map(URL.init(fileURLWithPath:))
            ?? home.appendingPathComponent(".config", isDirectory: true)
        let configurationDirectory = configHome
            .appendingPathComponent("codex-mcp-bridge", isDirectory: true)
        self.configurationDirectory = configurationDirectory
        self.environmentFile = environment["CODEX_MCP_BRIDGE_ENV_FILE"]
            .map(URL.init(fileURLWithPath:))
            ?? configurationDirectory.appendingPathComponent(".env")
        self.helperSocket = configurationDirectory
            .appendingPathComponent("run", isDirectory: true)
            .appendingPathComponent("helper.sock")
        self.bridgeSocket = configurationDirectory
            .appendingPathComponent("run", isDirectory: true)
            .appendingPathComponent("bridge.sock")

        let explicitRoot = environment["CODEX_MCP_BRIDGE_ROOT"].map(URL.init(fileURLWithPath:))
        let bundledRoot = bundle.resourceURL?.appendingPathComponent("Runtime", isDirectory: true)
        let selectedBridgeRoot = [explicitRoot, bundledRoot, currentDirectory]
            .compactMap { $0 }
            .first(where: Self.isRuntimeRoot)
        self.bridgeRoot = selectedBridgeRoot
        self.runtimeBuildID = selectedBridgeRoot.flatMap(Self.readRuntimeBuildID)

        let explicitNode = environment["CODEX_MCP_BRIDGE_NODE"].map(URL.init(fileURLWithPath:))
        let bundledNode = bundledRoot?.appendingPathComponent("node/bin/node")
        let homeNode = home.appendingPathComponent(".local/bin/node")
        let pathNodes = (environment["PATH"] ?? "")
            .split(separator: ":")
            .map { URL(fileURLWithPath: String($0)).appendingPathComponent("node") }
        let nvmVersions = home.appendingPathComponent(".nvm/versions/node", isDirectory: true)
        let nvmNodes = ((try? FileManager.default.contentsOfDirectory(
            at: nvmVersions,
            includingPropertiesForKeys: nil
        )) ?? [])
            .sorted { $0.lastPathComponent.compare($1.lastPathComponent, options: .numeric) == .orderedDescending }
            .map { $0.appendingPathComponent("bin/node") }
        let candidates = [
            explicitNode,
            bundledNode,
            URL(fileURLWithPath: "/opt/homebrew/bin/node"),
            URL(fileURLWithPath: "/usr/local/bin/node"),
            homeNode,
            URL(fileURLWithPath: "/usr/bin/node")
        ].compactMap { $0 } + pathNodes + nvmNodes
        self.nodeExecutable = candidates.first {
            FileManager.default.isExecutableFile(atPath: $0.path) &&
                Self.supportsRequiredNodeVersion($0)
        }
        self.launchAgentDisabled = environment["CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT"] == "1"
    }

    public var helperScript: URL? {
        bridgeRoot?.appendingPathComponent("dist/macosHelper.js")
    }

    public var isPackagedRuntime: Bool {
        guard let root = bridgeRoot, let resources = Bundle.main.resourceURL else { return false }
        return !launchAgentDisabled &&
            root.standardizedFileURL.path.hasPrefix(resources.standardizedFileURL.path + "/")
    }

    private static func isRuntimeRoot(_ url: URL) -> Bool {
        let fileManager = FileManager.default
        return fileManager.fileExists(atPath: url.appendingPathComponent("dist/macosHelper.js").path)
            && fileManager.fileExists(
                atPath: url.appendingPathComponent("scripts/start-codex-mcp-bridge.mjs").path
            )
    }

    private static func readRuntimeBuildID(_ root: URL) -> String? {
        let file = root.appendingPathComponent("dist/build-info.json")
        guard let data = try? Data(contentsOf: file),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let buildID = object["id"] as? String,
              !buildID.isEmpty else {
            return nil
        }
        return buildID
    }

    private static func supportsRequiredNodeVersion(_ executable: URL) -> Bool {
        let process = Process()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = ["-p", "process.versions.node"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        let completion = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completion.signal() }
        do {
            try process.run()
            if completion.wait(timeout: .now() + 2) == .timedOut {
                process.terminate()
                _ = completion.wait(timeout: .now() + 1)
                return false
            }
            guard process.terminationStatus == 0 else { return false }
            let version = String(
                data: output.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            )?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let major = version?.split(separator: ".").first.flatMap({
                Int($0)
            }) else {
                return false
            }
            return major >= 22
        } catch {
            return false
        }
    }
}
