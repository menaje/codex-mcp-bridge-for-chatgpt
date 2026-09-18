import CodexBridgeKit
import AppKit
import Combine
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

        let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.menaje.codex-mcp-bridge"
        let lockURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(bundleIdentifier).menu-bar.lock")
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

/// Hosts the dashboard in AppKit's native status-item popover. AppKit owns the
/// outer surface so the arrow, material, corners, shadow, and anchored size
/// transitions follow the current macOS appearance.
@MainActor
final class BridgeMenuBarController: NSObject, NSPopoverDelegate {
    private(set) var statusItem: NSStatusItem?
    private(set) var popover = NSPopover()
    private var hostingController: NSHostingController<AnyView>?
    private weak var model: AppModel?
    private var modelObservation: AnyCancellable?
    private var pendingPopoverSize: NSSize?
    private var popoverSizeUpdateScheduled = false

    func install(model: AppModel) {
        guard statusItem == nil else { return }
        self.model = model

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        guard let button = item.button else {
            NSStatusBar.system.removeStatusItem(item)
            return
        }
        statusItem = item
        button.target = self
        button.action = #selector(togglePopover(_:))
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleProportionallyDown

        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self

        let root = DashboardPopoverView(
            onContentSizeChange: { [weak self] size in self?.updatePopoverSize(size) },
            onRequestClose: { [weak self] in self?.closePopover() }
        )
        .environmentObject(model)
        let host = NSHostingController(rootView: AnyView(root))
        // preferredContentSize can transiently become zero while the model is
        // still starting. The dashboard's measured callback is the sole size
        // authority so that empty startup state cannot collapse the popover.
        host.sizingOptions = []
        host.view.frame = NSRect(
            x: 0,
            y: 0,
            width: DashboardPopoverLayout.width,
            height: DashboardPopoverLayout.initialHeight
        )
        host.preferredContentSize = host.view.frame.size
        hostingController = host
        popover.contentViewController = host
        // A newly started model can briefly have no body content. Assign the
        // native host first, then give the popover enough space for SwiftUI's
        // initial layout; the measured callback replaces this immediately.
        popover.contentSize = NSSize(
            width: DashboardPopoverLayout.width,
            height: DashboardPopoverLayout.initialHeight
        )
        host.view.layoutSubtreeIfNeeded()
        let fittingSize = host.view.fittingSize
        if fittingSize.width > 0, fittingSize.height > 0 {
            updatePopoverSize(fittingSize)
        }

        updateStatusItem()
        modelObservation = model.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                DispatchQueue.main.async { [weak self] in self?.updateStatusItem() }
            }
    }

    @objc private func togglePopover(_ sender: NSStatusBarButton) {
        if popover.isShown {
            closePopover()
        } else {
            showPopover(relativeTo: sender)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func showPopover(relativeTo button: NSStatusBarButton) {
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }

    private func closePopover() {
        guard popover.isShown else { return }
        popover.performClose(nil)
    }

    func showDashboard() {
        guard let button = statusItem?.button else { return }
        if !popover.isShown {
            showPopover(relativeTo: button)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    private func updatePopoverSize(_ measuredSize: CGSize) {
        guard measuredSize.width.isFinite, measuredSize.height.isFinite,
              measuredSize.width > 0, measuredSize.height > 0 else { return }
        let screen = statusItem?.button?.window?.screen ??
            hostingController?.view.window?.screen ?? NSScreen.main
        let next = NSSize(
            width: DashboardPopoverLayout.width,
            height: DashboardPopoverLayout.popoverHeight(
                measured: measuredSize.height,
                screen: screen?.visibleFrame.height ??
                    measuredSize.height + DashboardPopoverLayout.screenMargin
            )
        )
        pendingPopoverSize = next
        guard !popoverSizeUpdateScheduled else { return }
        popoverSizeUpdateScheduled = true
        // SwiftUI can publish several geometry preferences while replacing a
        // loading view with a scroll view. Apply only the final measurement for
        // this run-loop pass, without animating an intermediate content frame.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.popoverSizeUpdateScheduled = false
            guard let next = self.pendingPopoverSize else { return }
            self.pendingPopoverSize = nil
            guard abs(self.popover.contentSize.width - next.width) >= 0.5 ||
                    abs(self.popover.contentSize.height - next.height) >= 0.5 else { return }
            // AppKit's resize animation can briefly recenter the hosted SwiftUI
            // content before it expands the popover. Keep the menu anchor fixed
            // and apply this content-size change atomically instead.
            let window = self.popover.isShown ? self.hostingController?.view.window : nil
            let anchoredMaxY = window?.frame.maxY
            self.popover.animates = false
            self.hostingController?.preferredContentSize = next
            self.popover.contentSize = next
            if let window, let anchoredMaxY {
                self.pinPopoverWindow(window, toMaxY: anchoredMaxY)
            }
            // NSPopover can finish its internal frame update on the following
            // run-loop pass. Keep animations disabled through that pass and
            // restore the top edge once more before accepting new animation.
            DispatchQueue.main.async { [weak self, weak window] in
                guard let self else { return }
                if let window, let anchoredMaxY,
                   self.popover.isShown,
                   self.hostingController?.view.window === window {
                    self.pinPopoverWindow(window, toMaxY: anchoredMaxY)
                }
                self.popover.animates = true
            }
        }
    }

    private func pinPopoverWindow(_ window: NSWindow, toMaxY anchoredMaxY: CGFloat) {
        var frame = window.frame
        let offset = anchoredMaxY - frame.maxY
        guard abs(offset) >= 0.5 else { return }
        frame.origin.y += offset
        window.setFrame(frame, display: true)
    }

    private func updateStatusItem() {
        guard let model, let button = statusItem?.button else { return }
        let status = model.health.accessibilityLabel(locale: model.interfaceLocale)
        button.image = BridgeMenuBarIcon.templateImage(for: model.health)
        button.toolTip = BridgeAppLocalization.format(
            "macos.format.dotSeparatedPair",
            locale: model.interfaceLocale,
            BridgeAppLocalization.string("macos.codexmcpbridgeforchatgpt", locale: model.interfaceLocale),
            status
        )
        button.setAccessibilityLabel(status)
    }

    func popoverWillShow(_ notification: Notification) {
        model?.setDashboardVisible(true)
    }

    func popoverDidClose(_ notification: Notification) {
        model?.setDashboardVisible(false)
    }

    func uninstall() {
        closePopover()
        modelObservation = nil
        pendingPopoverSize = nil
        hostingController = nil
        popover.contentViewController = nil
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
        model = nil
    }
}

@MainActor
final class BridgeAppDelegate: NSObject, NSApplicationDelegate {
    static var model: AppModel?
    private let logger = Logger(subsystem: "com.menaje.codex-mcp-bridge", category: "lifecycle")
    private let menuBarController = BridgeMenuBarController()
    private var terminationRequestInProgress = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        _ = NSApp.setActivationPolicy(.accessory)
        guard AppSingleInstanceCoordinator.acquireOrActivateExistingInstance() else {
            logger.info("another menu bar application instance is already running")
            Darwin._exit(EXIT_SUCCESS)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        logger.info("menu bar application finished launching")
        if let model = Self.model {
            menuBarController.install(model: model)
            model.lifecycleTerminationHandler = { NSApp.terminate(nil) }
            model.completionNotificationOpenHandler = { [weak self] in
                self?.menuBarController.showDashboard()
            }
            Task { await model.start() }
        }
        if ProcessInfo.processInfo.environment["CODEX_MCP_BRIDGE_OPEN_SETTINGS"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if let model = Self.model {
                    SettingsWindowController.shared.show(model: model)
                }
            }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        Self.model?.refreshAfterSystemEvent()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard SkillsLibraryWindowController.shared.confirmDiscardBeforeApplicationShutdown() else {
            return .terminateCancel
        }
        guard let model = Self.model else {
            SkillsLibraryWindowController.shared.completeApplicationShutdownDiscard()
            return .terminateNow
        }
        if model.applicationShutdownCompleted {
            SkillsLibraryWindowController.shared.completeApplicationShutdownDiscard()
            return .terminateNow
        }
        if terminationRequestInProgress { return .terminateLater }
        terminationRequestInProgress = true
        Task { @MainActor in
            var shouldTerminate = await model.shutdownApplication(force: false)
            if !shouldTerminate && !model.applicationShutdownReserved {
                if model.generalSettingsSaveState == .failed {
                    presentShutdownFailure(model: model)
                } else if confirmForceShutdown(model: model) {
                    shouldTerminate = await model.shutdownApplication(force: true)
                    if !shouldTerminate { presentShutdownFailure(model: model) }
                }
            }
            if shouldTerminate,
               !SkillsLibraryWindowController.shared.confirmDiscardBeforeApplicationShutdown() {
                shouldTerminate = false
            }
            if shouldTerminate {
                SkillsLibraryWindowController.shared.completeApplicationShutdownDiscard()
            } else {
                SkillsLibraryWindowController.shared.cancelApplicationShutdownDiscard()
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
            "macos.couldnotquitsafely",
            locale: model.interfaceLocale
        )
        alert.informativeText = [
            model.runtimeErrorMessage,
            BridgeAppLocalization.string(
                "macos.interruptrunningworkandbackgroundprocessesandforce",
                locale: model.interfaceLocale
            )
        ].compactMap { $0 }.joined(separator: "\n\n")
        alert.addButton(withTitle: BridgeAppLocalization.string(
            "macos.forcequit",
            locale: model.interfaceLocale
        ))
        alert.addButton(withTitle: BridgeAppLocalization.string(
            "common.cancel",
            locale: model.interfaceLocale
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func presentShutdownFailure(model: AppModel) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .critical
        let title = model.generalSettingsSaveState == .failed
            ? "macos.couldnotsavesettings"
            : "macos.couldnotstopallrelatedprocesses"
        alert.messageText = BridgeAppLocalization.string(title, locale: model.interfaceLocale)
        alert.informativeText = model.runtimeErrorMessage ?? BridgeAppLocalization.string(
            "macos.theappwasnotquitreviewthestatus",
            locale: model.interfaceLocale
        )
        alert.addButton(withTitle: BridgeAppLocalization.string(
            "macos.ok",
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
        window.tabbingMode = .disallowed
        window.hasShadow = true
        window.backgroundColor = .windowBackgroundColor
        window.titleVisibility = .visible
        window.titlebarAppearsTransparent = false
        window.styleMask.remove(.fullSizeContentView)
        window.isMovableByWindowBackground = false
        window.standardWindowButton(.miniaturizeButton)?.isEnabled = false
        window.standardWindowButton(.zoomButton)?.isEnabled = false
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
                contentRect: NSRect(x: 0, y: 0, width: 980, height: 720),
                styleMask: [.titled, .closable, .resizable],
                backing: .buffered,
                defer: false
            )
            settingsWindow.title = BridgeAppLocalization.string(
                "macos.settings",
                locale: model.interfaceLocale
            )
            settingsWindow.isReleasedWhenClosed = false
            settingsWindow.delegate = self
            PrimaryAppWindowPresentation.configure(settingsWindow)
            settingsWindow.toolbarStyle = .unifiedCompact
            settingsWindow.standardWindowButton(.zoomButton)?.isEnabled = true
            settingsWindow.setFrameAutosaveName("CodexBridgeSettingsWindow")
            settingsWindow.contentMinSize = NSSize(width: 820, height: 600)
            let settingsHostingController = NSHostingController(
                rootView: NativeSettingsView(onWindowTitleChange: { [weak settingsWindow] title in
                    settingsWindow?.title = title
                })
                    .environmentObject(model)
                    .frame(minWidth: 820, minHeight: 600)
            )
            settingsWindow.contentViewController = settingsHostingController
            settingsWindow.titleVisibility = .hidden
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
final class SkillsLibraryWindowController: NSObject, NSWindowDelegate {
    static let shared = SkillsLibraryWindowController()
    private var window: NSWindow?
    private let windowState = SkillsLibraryWindowState()
    private weak var model: AppModel?

    func show(model: AppModel) {
        self.model = model
        if window == nil {
            let frameAutosaveName = "CodexBridgeSkillsLibraryWindowV5"
            let skillsWindow = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1_120, height: 760),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            skillsWindow.title = BridgeAppLocalization.string(
                "macos.skilllibrary",
                locale: model.interfaceLocale
            )
            skillsWindow.isReleasedWhenClosed = false
            skillsWindow.delegate = self
            PrimaryAppWindowPresentation.configure(skillsWindow)
            skillsWindow.standardWindowButton(.miniaturizeButton)?.isEnabled = true
            skillsWindow.standardWindowButton(.zoomButton)?.isEnabled = true
            skillsWindow.toolbarStyle = .unifiedCompact
            skillsWindow.contentMinSize = NSSize(width: 900, height: 600)
            skillsWindow.contentViewController = NSHostingController(
                rootView: SkillsLibraryLocalizedRootView()
                    .environmentObject(model)
                    .environmentObject(windowState)
                    .frame(minWidth: 900, minHeight: 600)
            )
            skillsWindow.titleVisibility = .hidden
            if !skillsWindow.setFrameUsingName(frameAutosaveName) {
                skillsWindow.setContentSize(NSSize(width: 1_120, height: 720))
                skillsWindow.center()
            }
            skillsWindow.setFrameAutosaveName(frameAutosaveName)
            window = skillsWindow
        }
        if let window {
            window.title = BridgeAppLocalization.string(
                "macos.skilllibrary",
                locale: model.interfaceLocale
            )
            PrimaryAppWindowPresentation.show(window)
        }
        Task {
            if model.helperStatus == nil { await model.start() }
            await model.refreshSkillLibrary()
        }
    }

    func windowWillClose(_ notification: Notification) {
        if let window = notification.object as? NSWindow {
            PrimaryAppWindowPresentation.didClose(window)
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        windowState.confirmDiscardIfNeeded {
            presentDiscardAlert(
                message: "macos.skills.discardUnsavedChangesAndClose",
                bringSkillsWindowForward: false
            )
        }
    }

    func confirmDiscardBeforeApplicationShutdown() -> Bool {
        windowState.confirmDiscardForApplicationShutdown {
            presentDiscardAlert(
                message: "macos.skills.discardUnsavedChanges",
                bringSkillsWindowForward: true
            )
        }
    }

    func completeApplicationShutdownDiscard() {
        windowState.completeApplicationShutdownDiscard()
    }

    func cancelApplicationShutdownDiscard() {
        windowState.cancelApplicationShutdownDiscard()
    }

    private func presentDiscardAlert(message: String, bringSkillsWindowForward: Bool) -> Bool {
        let locale = model?.interfaceLocale ?? .current
        if bringSkillsWindowForward, let window {
            NSApp.activate(ignoringOtherApps: true)
            PrimaryAppWindowPresentation.show(window)
        }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = BridgeAppLocalization.string(message, locale: locale)
        alert.informativeText = BridgeAppLocalization.string(
            "macos.skills.theCurrentMarkdownEditsWillBeLost",
            locale: locale
        )
        alert.addButton(withTitle: BridgeAppLocalization.string("macos.skills.discardChanges", locale: locale))
        alert.addButton(withTitle: BridgeAppLocalization.string("common.cancel", locale: locale))
        return alert.runModal() == .alertFirstButtonReturn
    }
}

@MainActor
final class ConnectionAssistantWindowController: NSObject, NSWindowDelegate {
    static let shared = ConnectionAssistantWindowController()
    private var window: NSWindow?
    private let windowState = ConnectionAssistantWindowState()

    func show(
        model: AppModel,
        presentation requestedPresentation: ConnectionAssistantPresentation? = nil
    ) {
        let presentation = requestedPresentation ?? (model.needsSetup ? .setup : .recovery)
        if window == nil || window?.isVisible != true || requestedPresentation != nil {
            windowState.begin(presentation)
        }
        if window == nil {
            let repairWindow = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 720, height: 640),
                styleMask: [.titled, .closable, .resizable],
                backing: .buffered,
                defer: false
            )
            repairWindow.title = localizedTitle(for: presentation, model: model)
            repairWindow.isReleasedWhenClosed = false
            repairWindow.delegate = self
            PrimaryAppWindowPresentation.configure(repairWindow)
            repairWindow.standardWindowButton(.zoomButton)?.isEnabled = true
            repairWindow.toolbarStyle = .unified
            repairWindow.setFrameAutosaveName("CodexBridgeConnectionAssistantWindow")
            repairWindow.contentMinSize = NSSize(width: 620, height: 520)
            let repairHostingController = NSHostingController(
                rootView: ConnectionAssistantRootView(
                    windowState: windowState,
                    onClose: { [weak repairWindow] in repairWindow?.performClose(nil) },
                    onTitleChange: { [weak repairWindow] title in repairWindow?.title = title }
                )
                    .environmentObject(model)
                    .frame(minWidth: 620, minHeight: 520)
            )
            repairWindow.contentViewController = repairHostingController
            repairWindow.center()
            window = repairWindow
        }
        if let window {
            window.title = localizedTitle(for: windowState.presentation, model: model)
            PrimaryAppWindowPresentation.show(window)
        }
        Task {
            if model.helperStatus == nil { await model.start() }
            await model.refreshStatus()
            await model.refreshAuthStatus()
            if windowState.presentation == .setup { await model.refreshSetupDiscovery() }
        }
    }

    private func localizedTitle(
        for presentation: ConnectionAssistantPresentation,
        model: AppModel
    ) -> String {
        BridgeAppLocalization.string(
            presentation == .setup
                ? "macos.connectionAssistant.setupWindowTitle"
                : "macos.connectionAssistant.recoveryWindowTitle",
            locale: model.interfaceLocale
        )
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
            operationalNotifications: OperationalNotifications(defaults: .standard, delivery: notificationDelivery),
            completionNotifications: CompletionNotifications(delivery: notificationDelivery)
        )
        notificationDelivery.onOpen = { [weak appModel] problem, scope in
            appModel?.showOperationalProblem(problem, scope: scope)
        }
        notificationDelivery.onCompletionOpen = { [weak appModel] in
            appModel?.showDashboardForCompletionNotification()
        }
        _model = StateObject(wrappedValue: appModel)
        BridgeAppDelegate.model = appModel
    }

    var body: some Scene {
        Settings {
            EmptyView()
                .environmentObject(model)
        }
        .commands {
            CommandMenu("macos.bridgeskills") {
                Button("macos.newskill") { performSkillLibraryCommand(.bridgeSkillCommandNew) }
                    .keyboardShortcut("n", modifiers: .command)
                Button("macos.skills.importFilesFolderOrZip") { performSkillLibraryCommand(.bridgeSkillCommandImport) }
                    .keyboardShortcut("o", modifiers: .command)
                Divider()
                Button("macos.save") { performSkillLibraryCommand(.bridgeSkillCommandSave) }
                    .keyboardShortcut("s", modifiers: .command)
                Button("macos.skills.searchBridgeSkills") { performSkillLibraryCommand(.bridgeSkillCommandFind) }
                    .keyboardShortcut("f", modifiers: .command)
                Button("macos.skills.togglePreviewEdit") { performSkillLibraryCommand(.bridgeSkillCommandToggleEdit) }
                    .keyboardShortcut("e", modifiers: .command)
            }
        }
    }

    private func performSkillLibraryCommand(_ name: Notification.Name) {
        SkillsLibraryWindowController.shared.show(model: model)
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: name, object: nil)
        }
    }
}
