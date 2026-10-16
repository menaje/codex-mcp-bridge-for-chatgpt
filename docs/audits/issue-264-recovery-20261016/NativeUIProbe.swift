// Isolated acceptance harness: production AppModel/View + real fixture RPC sockets.
// This bundle does not read or start the user's installed helper or runtime.
import AppKit
import CodexBridgeKit
import SwiftUI

private actor ProbeBootstrap: HelperBootstrapping {
    private(set) var starts = 0
    func ensureRunning(paths: RuntimePaths) async throws { starts += 1; throw LocalRPCError.emptyResponse }
    func shutdown(paths: RuntimePaths) async throws {}
}

@MainActor
private final class Probe: ObservableObject {
    let root = URL(fileURLWithPath: Bundle.main.object(forInfoDictionaryKey: "AcceptanceRoot") as! String)
    let model: AppModel
    let helper: NativeRPCFixture
    let bridge: NativeRPCFixture
    let bootstrap: ProbeBootstrap

    init() {
        do {
            let directory = URL(fileURLWithPath: Bundle.main.object(forInfoDictionaryKey: "AcceptanceRoot") as! String)
            let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": directory.path], currentDirectory: directory)
            try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
            let health = try String(contentsOf: directory.appendingPathComponent("helper.json"), encoding: .utf8)
            let snapshot = try String(contentsOf: directory.appendingPathComponent("dashboard.json"), encoding: .utf8)
            let state = ProbeReplies(snapshot: snapshot)
            helper = try NativeRPCFixture(path: paths.helperSocket.path) { _ in NativeFixtureReply(body: "{\"result\":\(health)}") }
            bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { state.reply($0) }
            bootstrap = ProbeBootstrap()
            model = AppModel(paths: paths, bootstrapper: bootstrap)
            model.recordLocalConnectionStatus(try JSONDecoder().decode(HelperStatus.self, from: Data(health.utf8)))
            model.authStatus = try JSONDecoder().decode(CodexLoginStatus.self, from: Data(#"{"installed":true,"authenticated":true,"summary":"fixture"}"#.utf8))
        } catch { fatalError("Fixture initialization failed: \(error)") }
    }

    func run() async {
        await model.refreshDashboard(enrich: false)
        let window = NSPanel(contentRect: NSRect(x: 100, y: 100, width: DashboardPopoverLayout.width, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Bridge #264 UI fixture"
        window.appearance = NSAppearance(named: .aqua)
        let host = NSHostingController(rootView: DashboardPopoverView(onContentSizeChange: { window.setContentSize($0) })
            .environmentObject(model).environment(\.locale, Locale(identifier: "en")))
        window.contentViewController = host
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        do {
            try await Task.sleep(for: .milliseconds(300))
            try capture(window, "first-load-failure.png")
            try Data("ready".utf8).write(to: root.appendingPathComponent("ready"))
            // A bounded interaction window; no repeated requests or runtime soak.
            for _ in 0..<300 {
                if model.dashboard != nil, !model.isDashboardRefreshing {
                    try await Task.sleep(for: .milliseconds(200))
                    try capture(window, "recovered.png")
                    let starts = await bootstrap.starts
                    let report: [String: Any] = [
                        "scenario": "isolated production AppModel + DashboardPopoverView in localized app bundle",
                        "installedOperationalAcceptance": false,
                        "snapshotCalls": bridge.count("dashboard.snapshot"), "helperHealthCalls": helper.count("helper.health"),
                        "authCalls": helper.count("auth.status"), "settingsCalls": bridge.count("settings.snapshot"),
                        "bootstrapCalls": starts, "failureCleared": model.dashboardReadFailure == nil,
                        "lastSuccessfulReadRecorded": model.lastDashboardRefresh != nil,
                        "success": bridge.count("dashboard.snapshot") == 2 && helper.count("helper.health") == 0 &&
                            helper.count("auth.status") == 0 && bridge.count("settings.snapshot") == 0 && starts == 0 && model.dashboardReadFailure == nil
                    ]
                    try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent("report.json"))
                    model.cancelAllPolling(); helper.stop(); bridge.stop()
                    NSApp.terminate(nil)
                    return
                }
                try await Task.sleep(for: .milliseconds(200))
            }
        } catch { print("UI fixture failed: \(error)") }
        model.cancelAllPolling(); helper.stop(); bridge.stop()
        exit(1)
    }

    private func capture(_ window: NSWindow, _ name: String) throws {
        window.displayIfNeeded()
        guard let view = window.contentView?.superview,
              let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw LocalRPCError.emptyResponse }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else { throw LocalRPCError.emptyResponse }
        try data.write(to: root.appendingPathComponent(name))
    }
}

private final class ProbeReplies: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    let snapshot: String
    init(snapshot: String) { self.snapshot = snapshot }
    func reply(_ method: String) -> NativeFixtureReply {
        guard method == "dashboard.snapshot" else { return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported fixture method"}}"#) }
        let fail = lock.withLock { calls += 1; return calls == 1 }
        return NativeFixtureReply(body: fail
            ? #"{"error":{"code":-32000,"message":"STATE_READ_STALE: fixture"}}"#
            : "{\"result\":\(snapshot)}")
    }
}

@MainActor
private final class ProbeDelegate: NSObject, NSApplicationDelegate {
    static var probe: Probe?
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in await Self.probe?.run() }
    }
}

@main
private struct NativeUIProbeApp: App {
    @NSApplicationDelegateAdaptor(ProbeDelegate.self) private var delegate
    @StateObject private var probe: Probe
    init() {
        let value = Probe()
        _probe = StateObject(wrappedValue: value)
        ProbeDelegate.probe = value
    }
    var body: some Scene { Settings { EmptyView() } }
}
