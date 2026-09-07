import CodexBridgeKit
import AppKit
import Darwin
import OSLog
import SwiftUI

struct AppInstanceIdentity: Equatable {
    let processIdentifier: pid_t
    let launchDate: Date?
}

enum AppSingleInstanceSelection {
    static func primaryProcessIdentifier(
        current: AppInstanceIdentity,
        running: [AppInstanceIdentity]
    ) -> pid_t {
        let candidates = [current] + running.filter {
            $0.processIdentifier != current.processIdentifier
        }
        return candidates.min { lhs, rhs in
            let lhsDate = lhs.launchDate ?? .distantFuture
            let rhsDate = rhs.launchDate ?? .distantFuture
            if lhsDate != rhsDate { return lhsDate < rhsDate }
            return lhs.processIdentifier < rhs.processIdentifier
        }?.processIdentifier ?? current.processIdentifier
    }
}

@MainActor
enum AppSingleInstanceCoordinator {
    private static var lockFileDescriptor: Int32 = -1

    static func acquireOrActivateExistingInstance() -> Bool {
        if let existing = preferredExistingApplication() {
            existing.activate(options: [.activateAllWindows])
            return false
        }

        let lockURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("com.menaje.codex-mcp-bridge.menu-bar.lock")
        let descriptor = lockURL.path.withCString {
            Darwin.open($0, O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
        }
        guard descriptor >= 0 else {
            return true
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(descriptor)
            activateAnyExistingApplication()
            return false
        }
        lockFileDescriptor = descriptor
        return true
    }

    private static func preferredExistingApplication() -> NSRunningApplication? {
        guard let bundleIdentifier = Bundle.main.bundleIdentifier else { return nil }
        let currentProcessIdentifier = ProcessInfo.processInfo.processIdentifier
        let current = AppInstanceIdentity(
            processIdentifier: currentProcessIdentifier,
            launchDate: NSRunningApplication.current.launchDate
        )
        let applications = NSRunningApplication
            .runningApplications(withBundleIdentifier: bundleIdentifier)
            .filter {
                !$0.isTerminated && $0.processIdentifier != currentProcessIdentifier
            }
        let primaryProcessIdentifier = AppSingleInstanceSelection.primaryProcessIdentifier(
            current: current,
            running: applications.map {
                AppInstanceIdentity(
                    processIdentifier: $0.processIdentifier,
                    launchDate: $0.launchDate
                )
            }
        )
        guard primaryProcessIdentifier != currentProcessIdentifier else { return nil }
        return applications.first {
            $0.processIdentifier == primaryProcessIdentifier
        }
    }

    private static func activateAnyExistingApplication() {
        guard let bundleIdentifier = Bundle.main.bundleIdentifier else { return }
        let currentProcessIdentifier = ProcessInfo.processInfo.processIdentifier
        NSRunningApplication
            .runningApplications(withBundleIdentifier: bundleIdentifier)
            .first {
                !$0.isTerminated && $0.processIdentifier != currentProcessIdentifier
            }?
            .activate(options: [.activateAllWindows])
    }
}

@MainActor
final class BridgeAppDelegate: NSObject, NSApplicationDelegate {
    static var model: AppModel?
    private let logger = Logger(subsystem: "com.menaje.codex-mcp-bridge", category: "lifecycle")
    private var terminationRequestInProgress = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        guard AppSingleInstanceCoordinator.acquireOrActivateExistingInstance() else {
            logger.info("another menu bar application instance is already running")
            Darwin._exit(EXIT_SUCCESS)
        }
    }

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

    func applicationDidBecomeActive(_ notification: Notification) {
        Self.model?.refreshLoginItemStatus()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model = Self.model else { return .terminateNow }
        if model.applicationShutdownCompleted { return .terminateNow }
        if terminationRequestInProgress { return .terminateLater }
        terminationRequestInProgress = true
        Task { @MainActor in
            var shouldTerminate = await model.shutdownApplication(force: false)
            if !shouldTerminate {
                if model.generalSettingsSaveState == .failed {
                    presentShutdownFailure(model: model)
                } else if confirmForceShutdown(model: model) {
                    shouldTerminate = await model.shutdownApplication(force: true)
                    if !shouldTerminate { presentShutdownFailure(model: model) }
                }
            }
            terminationRequestInProgress = false
            sender.reply(toApplicationShouldTerminate: shouldTerminate)
        }
        return .terminateLater
    }

    private func confirmForceShutdown(model: AppModel) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = BridgeAppLocalization.string(
            "안전하게 종료하지 못했습니다",
            locale: model.interfaceLocale
        )
        alert.informativeText = [
            model.runtimeErrorMessage,
            BridgeAppLocalization.string(
                "실행 중인 작업과 백그라운드 프로세스를 중단하고 앱의 관련 프로세스를 강제로 종료할까요? 파일 변경은 되돌아가지 않습니다.",
                locale: model.interfaceLocale
            )
        ].compactMap { $0 }.joined(separator: "\n\n")
        alert.addButton(withTitle: BridgeAppLocalization.string(
            "강제 종료",
            locale: model.interfaceLocale
        ))
        alert.addButton(withTitle: BridgeAppLocalization.string(
            "취소",
            locale: model.interfaceLocale
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func presentShutdownFailure(model: AppModel) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .critical
        let title = model.generalSettingsSaveState == .failed
            ? "설정 변경사항을 저장하지 못했습니다"
            : "관련 프로세스를 모두 종료하지 못했습니다"
        alert.messageText = BridgeAppLocalization.string(title, locale: model.interfaceLocale)
        alert.informativeText = model.runtimeErrorMessage ?? BridgeAppLocalization.string(
            "앱을 종료하지 않았습니다. 현황을 확인한 뒤 다시 시도해 주세요.",
            locale: model.interfaceLocale
        )
        alert.addButton(withTitle: BridgeAppLocalization.string(
            "확인",
            locale: model.interfaceLocale
        ))
        alert.runModal()
    }
}

@MainActor
enum PrimaryAppWindowPresentation {
    private static var visibleWindowIDs = Set<ObjectIdentifier>()

    static let collectionBehavior: NSWindow.CollectionBehavior = [
        .managed,
        .primary,
        .participatesInCycle
    ]

    static func configure(_ window: NSWindow) {
        window.level = .normal
        window.collectionBehavior = collectionBehavior
    }

    static func show(_ window: NSWindow) {
        visibleWindowIDs.insert(ObjectIdentifier(window))
        // A UIElement app is otherwise treated like an auxiliary overlay by
        // Stage Manager. Become a regular app only while a primary window is open.
        _ = NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        window.makeMain()
        NSApp.activate(ignoringOtherApps: true)
    }

    static func didClose(_ window: NSWindow) {
        visibleWindowIDs.remove(ObjectIdentifier(window))
        guard visibleWindowIDs.isEmpty else { return }
        _ = NSApp.setActivationPolicy(.accessory)
    }
}

@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    static let shared = SettingsWindowController()
    private var window: NSWindow?
    private weak var model: AppModel?

    func show(model: AppModel) {
        self.model = model
        if window == nil {
            let settingsWindow = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 820, height: 700),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            settingsWindow.title = "Codex MCP Bridge for ChatGPT"
            settingsWindow.isReleasedWhenClosed = false
            settingsWindow.delegate = self
            PrimaryAppWindowPresentation.configure(settingsWindow)
            settingsWindow.setFrameAutosaveName("CodexBridgeSettingsWindow")
            settingsWindow.contentView = NSHostingView(
                rootView: NativeSettingsView()
                    .environmentObject(model)
                    .frame(minWidth: 720, minHeight: 620)
            )
            settingsWindow.center()
            window = settingsWindow
        }
        if let window {
            PrimaryAppWindowPresentation.show(window)
        }
        model.setSettingsWindowVisible(true)
        model.refreshLoginItemStatus()
        Task {
            if model.helperStatus == nil { await model.start() }
            await model.refreshStatus()
            await model.refreshSettings()
        }
    }

    func windowWillClose(_ notification: Notification) {
        if let window = notification.object as? NSWindow {
            PrimaryAppWindowPresentation.didClose(window)
        }
        model?.setSettingsWindowVisible(false)
    }
}

@MainActor
final class ConnectionRepairWindowController: NSObject, NSWindowDelegate {
    static let shared = ConnectionRepairWindowController()
    private var window: NSWindow?

    func show(model: AppModel) {
        if window == nil {
            let repairWindow = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 560, height: 660),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            repairWindow.title = "Codex MCP Bridge for ChatGPT"
            repairWindow.isReleasedWhenClosed = false
            repairWindow.delegate = self
            PrimaryAppWindowPresentation.configure(repairWindow)
            repairWindow.setFrameAutosaveName("CodexBridgeConnectionRepairWindow")
            repairWindow.contentView = NSHostingView(
                rootView: ConnectionRepairView()
                    .environmentObject(model)
                    .frame(minWidth: 500, minHeight: 580)
            )
            repairWindow.center()
            window = repairWindow
        }
        if let window {
            PrimaryAppWindowPresentation.show(window)
        }
        Task {
            if model.helperStatus == nil { await model.start() }
            await model.refreshStatus()
            await model.refreshAuthStatus()
        }
    }

    func windowWillClose(_ notification: Notification) {
        if let window = notification.object as? NSWindow {
            PrimaryAppWindowPresentation.didClose(window)
        }
    }
}

@main
struct CodexBridgeMenuBarApp: App {
    @NSApplicationDelegateAdaptor(BridgeAppDelegate.self) private var appDelegate
    @StateObject private var model: AppModel

    init() {
        let notificationDelivery = SystemOperationalNotificationDelivery()
        let appModel = AppModel(
            connectionStore: UserDefaultsBridgeConnectionStore(),
            operationalNotifications: OperationalNotifications(defaults: .standard, delivery: notificationDelivery)
        )
        notificationDelivery.onOpen = { [weak appModel] problem, scope in
            appModel?.showOperationalProblem(problem, scope: scope)
        }
        _model = StateObject(wrappedValue: appModel)
        BridgeAppDelegate.model = appModel
    }

    var body: some Scene {
        MenuBarExtra {
            DashboardPopoverView()
                .environmentObject(model)
        } label: {
            BridgeMenuBarIcon(health: model.health)
                .accessibilityLabel(
                    model.health.accessibilityLabel(locale: model.interfaceLocale)
                )
        }
        .menuBarExtraStyle(.window)
    }
}
