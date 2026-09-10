import AppKit
import CodexBridgeKit
import SwiftUI

// Explicit --connect-installed acceptance only. This window uses the production
// views and IPC against the existing service, without replacing its helper or
// generating a second application's operational system notifications.
private struct ExistingServiceBootstrap: HelperBootstrapping {
    func ensureRunning(paths: RuntimePaths) async throws {}
    func shutdown(paths: RuntimePaths) async throws {
        throw NSError(domain: "NativeLiveAcceptance", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Use the installed application for app-exit acceptance."])
    }
}

@MainActor
private final class NoDuplicateNotifications: OperationalNotificationDelivering {
    func isAuthorized() async -> Bool { false }
    func requestAuthorization() async -> Bool { false }
    func deliver(identifier: String, problem: OperationalProblem, scope: String, locale: Locale) async throws {}
}

@main
struct NativeLiveAcceptanceApp: App {
    @StateObject private var model: AppModel
    @State private var dark = false

    init() {
        let paths = RuntimePaths(environment: [
            "CODEX_MCP_BRIDGE_ROOT": "/Applications/Codex MCP Bridge for ChatGPT.app/Contents/Resources/Runtime",
            "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1"
        ])
        let defaults = UserDefaults(suiteName: "com.menaje.bridge-live-acceptance.policy")!
        let value = AppModel(paths: paths, bootstrapper: ExistingServiceBootstrap(),
            operationalNotifications: OperationalNotifications(defaults: defaults, delivery: NoDuplicateNotifications()))
        value.previewInterfaceLocale("ko")
        _model = StateObject(wrappedValue: value)
    }

    var body: some Scene {
        WindowGroup("설치된 브리지 검증") {
            VStack(spacing: 8) {
                Toggle("다크 모드", isOn: $dark).padding(.horizontal)
                DashboardPopoverView().environmentObject(model)
            }
            .padding(8)
            .preferredColorScheme(dark ? .dark : .light)
            .onChange(of: model.networkAvailable) { _ in recordNetworkObservation() }
            .onChange(of: model.health) { _ in recordNetworkObservation() }
        }
    }

    private func recordNetworkObservation() {
        guard let available = model.networkAvailable,
              let root = Bundle.main.object(forInfoDictionaryKey: "AcceptanceRoot") as? String else { return }
        let file = URL(fileURLWithPath: root).appendingPathComponent("network-observations.jsonl")
        let value: [String: Any] = ["at": ISO8601DateFormatter().string(from: Date()),
            "networkAvailable": available, "localIPCConnected": model.bridgeConnected,
            "healthLabel": model.health.accessibilityLabel(locale: Locale(identifier: "ko"))]
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data + Data([10]))
        }
    }
}
