import CodexBridgeKit
import AppKit
import OSLog
import SwiftUI

@MainActor
final class BridgeAppDelegate: NSObject, NSApplicationDelegate {
    static var model: AppModel?
    private let logger = Logger(subsystem: "com.menaje.codex-mcp-bridge", category: "lifecycle")

    func applicationDidFinishLaunching(_ notification: Notification) {
        logger.info("menu bar application finished launching")
        Task { await Self.model?.start() }
        if ProcessInfo.processInfo.environment["CODEX_MCP_BRIDGE_OPEN_SETTINGS"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if let model = Self.model {
                    SettingsWindowController.shared.show(model: model)
                }
            }
        }
    }
}

@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    static let shared = SettingsWindowController()
    private var window: NSWindow?

    func show(model: AppModel) {
        if window == nil {
            let settingsWindow = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 820, height: 700),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            settingsWindow.title = "Codex MCP Bridge for ChatGPT 설정"
            settingsWindow.isReleasedWhenClosed = false
            settingsWindow.delegate = self
            settingsWindow.setFrameAutosaveName("CodexBridgeSettingsWindow")
            settingsWindow.contentView = NSHostingView(
                rootView: NativeSettingsView()
                    .environmentObject(model)
                    .frame(minWidth: 720, minHeight: 620)
            )
            settingsWindow.center()
            window = settingsWindow
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task {
            if model.helperStatus == nil { await model.start() }
            await model.refreshSettings()
        }
    }
}

@main
struct CodexBridgeMenuBarApp: App {
    @NSApplicationDelegateAdaptor(BridgeAppDelegate.self) private var appDelegate
    @StateObject private var model: AppModel

    init() {
        let appModel = AppModel()
        _model = StateObject(wrappedValue: appModel)
        BridgeAppDelegate.model = appModel
    }

    var body: some Scene {
        MenuBarExtra {
            DashboardPopoverView()
                .environmentObject(model)
        } label: {
            Image(systemName: model.health.symbol)
                .accessibilityLabel(model.health.accessibilityLabel)
        }
        .menuBarExtraStyle(.window)
    }
}
