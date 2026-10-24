import AppKit
import CodexBridgeKit
import SwiftUI
import Vision

private struct DocumentationBootstrap: HelperBootstrapping {
    func ensureRunning(paths: RuntimePaths) async throws {}
    func shutdown(paths: RuntimePaths) async throws {}
}

@MainActor
private final class DocumentationLoginItem: LoginItemControlling {
    var status: MenuBarLoginItemStatus { .notRegistered }
    func register() throws {}
    func unregister() throws {}
    func openSystemSettings() {}
}

@MainActor
private final class DocumentationNotifications: OperationalNotificationDelivering {
    func isAuthorized() async -> Bool { true }
    func requestAuthorization() async -> Bool { true }
    func deliver(identifier: String, problem: OperationalProblem, scope: String, locale: Locale) async throws {}
}

/// Hosts unmodified production views against isolated, read-only sample RPCs.
@MainActor
private final class DocumentationCapture {
    let model: AppModel
    let root: URL
    let output: URL
    private let bridge: NativeRPCFixture
    private let helper: NativeRPCFixture
    private var captures: [[String: Any]] = []

    init() throws {
        root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BRIDGE_DOCUMENTATION_ROOT"]!)
        output = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BRIDGE_DOCUMENTATION_OUTPUT"]!)
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path, "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1"], currentDirectory: root)
        let stateFile = root.appendingPathComponent("snapshots.json")
        let state = try Self.state(stateFile)
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        bridge = try NativeRPCFixture(path: paths.bridgeSocket.path, requestReply: { Self.reply($0, $1, stateFile) })
        helper = try NativeRPCFixture(path: paths.helperSocket.path, requestReply: { Self.reply($0, $1, stateFile) })
        model = AppModel(paths: paths, bootstrapper: DocumentationBootstrap(), loginItemController: DocumentationLoginItem(),
                         operationalNotifications: OperationalNotifications(defaults: .standard, delivery: DocumentationNotifications()))
        model.previewInterfaceLocale("en")
        model.helperStatus = try Self.decode(HelperStatus.self, state["helper"]!)
        model.authStatus = try Self.decode(CodexLoginStatus.self, state["auth"]!)
        model.settings = try Self.decode(SettingsSnapshot.self, state["settings"]!)
        model.codexRuntime = try Self.decode(CodexRuntimeSnapshot.self, state["runtime"]!)
        model.dashboard = try Self.decode(DashboardSnapshot.self, state["dashboard"]!)
    }

    nonisolated private static func state(_ file: URL) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
    }

    nonisolated private static func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }

    nonisolated private static func reply(_ method: String, _ raw: String, _ file: URL) -> NativeFixtureReply {
        let keys = ["helper.status": "helper", "helper.health": "helper", "settings.snapshot": "settings",
                    "auth.status": "auth", "codex.runtime": "runtime", "dashboard.snapshot": "dashboard",
                    "remote.status": "remote", "skills.snapshot": "skills", "skills.read": "skill", "skills.versions": "versions"]
        guard let key = keys[method], let value = try? state(file)[key] else {
            return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"Documentation fixture is read-only"}}"#)
        }
        return NativeFixtureReply(body: String(decoding: try! JSONSerialization.data(withJSONObject: ["result": value]), as: UTF8.self))
    }

    func run() async throws {
        UserDefaults.standard.set("general", forKey: "settings.selectedPane")
        let settings = window(AnyView(NativeSettingsView().environmentObject(model)), size: NSSize(width: 980, height: 760))
        settings.titleVisibility = .hidden
        settings.toolbarStyle = .unifiedCompact
        for (pane, file, expected) in [
            ("general", "macos-settings-sidebar-light-en.png", ["General", "App and Card Language"]),
            ("model-execution", "macos-models-execution-light-en.png", ["Processing speed", "Standard"]),
            ("projects", "macos-projects-light-en.png", ["Bridge Demo", "Projects"]),
            ("codex", "macos-codex-account-light-en.png", ["demo@example.invalid", "Codex"]),
            ("connection", "macos-app-roles-light-en.png", ["Run Server on This Mac", "Connect to Existing Server"])
        ] {
            model.requestedSettingsTab = pane
            try await settle(settings)
            model.cancelPendingSettingsAutosave()
            model.settingsLoadErrorMessage = nil
            model.settingsErrorMessage = nil
            model.loginItemErrorMessage = nil
            try await capture(settings, file, expected: expected)
        }
        // The pairing controls appear below the role and server sections.
        if let scroll = descendants(settings.contentView!).compactMap({ $0 as? NSScrollView }).max(by: { $0.bounds.width < $1.bounds.width }),
           let document = scroll.documentView {
            let y = document.isFlipped ? max(0, document.bounds.height - scroll.contentView.bounds.height) : 0
            scroll.contentView.scroll(to: NSPoint(x: 0, y: y))
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        try await capture(settings, "macos-pairing-invitation-light-en.png", expected: ["pairing invitation", "5 minutes"])
        settings.close()

        let assistant = ConnectionAssistantWindowState()
        assistant.begin(.setup)
        let setup = window(AnyView(ConnectionAssistantRootView(windowState: assistant, onClose: {}, onTitleChange: { _ in }).environmentObject(model)), size: NSSize(width: 720, height: 640))
        try await capture(setup, "macos-connection-setup-light-en.png", expected: ["Choose", "Continue"])
        setup.close()

        let dashboard = window(AnyView(DashboardPopoverView().environmentObject(model)), size: NSSize(width: 420, height: 400), borderless: true)
        try await fit(dashboard)
        try await capture(dashboard, "macos-menubar-usage-light-en.png", expected: ["In progress", "Execution history", "Problem history"])
        await model.toggleDashboardPanel(.running)
        try await fit(dashboard)
        try await capture(dashboard, "macos-dashboard-light-en.png", expected: ["Review the demo project", "Input Required"])
        await model.toggleDashboardPanel(.history)
        try await fit(dashboard)
        try await capture(dashboard, "macos-execution-history-light-en.png", expected: ["Code Review", "Completed"])
        await model.toggleDashboardPanel(.problems)
        try await fit(dashboard)
        try await capture(dashboard, "macos-problem-history-light-en.png", expected: ["Check the preview", "Cancellation Reason", "Stopped at the user's request"])
        dashboard.close()

        UserDefaults.standard.set(false, forKey: "SkillsLibraryShowsInspectorV2")
        UserDefaults.standard.set("all", forKey: "SkillsLibraryColumnVisibilityV2")
        SkillsLibraryWindowController.shared.show(model: model)
        await model.refreshSkillLibrary()
        // The production controller and view also request their initial snapshot.
        // Let their newest generation settle before selecting the sample.
        for _ in 0..<50 {
            if model.skillLibrary?.skills.first != nil { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard let skill = model.skillLibrary?.skills.first else { throw CaptureError("Skill sample did not load: \(model.skillLibraryErrorMessage ?? "no current snapshot")") }
        await model.loadBridgeSkill(skill)
        guard let skills = NSApp.windows.first(where: { $0.isVisible && $0.title == BridgeAppLocalization.string("macos.skilllibrary", locale: model.interfaceLocale) })
            ?? NSApp.windows.first(where: { $0.isVisible && $0 !== dashboard && $0 !== settings && $0 !== setup }) else { throw CaptureError("Skill window did not open") }
        skills.setContentSize(NSSize(width: 1120, height: 760))
        try await capture(skills, "macos-skill-library-light-en.png", expected: ["Code Review", "Procedure", "Report"])
        skills.close()
        let report = try JSONSerialization.data(withJSONObject: captures, options: [.prettyPrinted, .sortedKeys])
        try report.write(to: output.appendingPathComponent("native-captures.json"))
        bridge.stop()
        helper.stop()
    }

    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

    private func window(_ view: AnyView, size: NSSize, borderless: Bool = false) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: borderless ? [.borderless] : [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.backgroundColor = .windowBackgroundColor
        window.isOpaque = true
        window.title = "Codex MCP Bridge for ChatGPT"
        window.contentViewController = NSHostingController(rootView: view.environment(\.locale, Locale(identifier: "en")))
        window.setContentSize(size)
        window.center()
        window.makeKeyAndOrderFront(nil)
        return window
    }

    private func settle(_ window: NSWindow) async throws {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        try await Task.sleep(for: .milliseconds(700))
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
    }

    private func fit(_ window: NSWindow) async throws {
        try await settle(window)
        if let size = window.contentView?.fittingSize, size.height > 0 { window.setContentSize(size) }
        window.center()
        try await settle(window)
    }

    private func capture(_ window: NSWindow, _ filename: String, expected: [String]) async throws {
        try await settle(window)
        let file = output.appendingPathComponent(filename)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-o", "-l", String(window.windowNumber), file.path]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CaptureError("Screen capture failed: \(filename)") }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(url: file).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        let missing = expected.filter { !text.localizedCaseInsensitiveContains($0) }
        guard missing.isEmpty else { throw CaptureError("Missing visible text in \(filename): \(missing)\n\(text)") }
        guard text.range(of: "[가-힣一-龯ぁ-ゔァ-ヴ]", options: .regularExpression) == nil else { throw CaptureError("Non-English text in \(filename)") }
        captures.append(["file": filename, "method": "macOS window screencapture", "locale": "en", "appearance": "light", "recognizedText": text])
        print("Captured \(filename)")
    }
}

private struct CaptureError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

@MainActor
private final class DocumentationDelegate: NSObject, NSApplicationDelegate {
    private var capture: DocumentationCapture?
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in
            do {
                capture = try DocumentationCapture()
                try await capture!.run()
                NSApp.terminate(nil)
            } catch {
                FileHandle.standardError.write(Data("Documentation capture failed: \(error)\n".utf8))
                exit(1)
            }
        }
    }
}

@main
private struct DocumentationApp: App {
    @NSApplicationDelegateAdaptor(DocumentationDelegate.self) private var delegate
    var body: some Scene { Settings { EmptyView() } }
}
