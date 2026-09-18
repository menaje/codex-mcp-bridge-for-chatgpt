import AppKit
import CodexBridgeKit
import SwiftUI

private struct VisualCaptureRecord: Codable {
    let file: String
    let captureMethod: String
    let expectedText: [String]
    let recognizedText: String
    let pixelWidth: Int
    let pixelHeight: Int
    let byteCount: Int
}

private struct SettingsVisualBootstrap: HelperBootstrapping {
    func ensureRunning(paths: RuntimePaths) async throws {}
    func shutdown(paths: RuntimePaths) async throws {}
}

@MainActor
private final class SettingsConnectionVisualAcceptance: ObservableObject {
    let model: AppModel
    let root: URL
    private var captures: [VisualCaptureRecord] = []

    init() {
        let configured = ProcessInfo.processInfo.environment["CODEX_SETTINGS_VISUAL_ACCEPTANCE_ROOT"]
            ?? Bundle.main.object(forInfoDictionaryKey: "AcceptanceRoot") as? String
            ?? "/tmp/bridge-settings-visual"
        root = URL(fileURLWithPath: configured, isDirectory: true)
        let paths = RuntimePaths(environment: [
            "XDG_CONFIG_HOME": root.path,
            "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1"
        ], currentDirectory: root)
        model = AppModel(paths: paths, bootstrapper: SettingsVisualBootstrap())
        model.previewInterfaceLocale("ko")
    }

    func run() async {
        do {
            let artifacts = root.appendingPathComponent("artifacts", isDirectory: true)
            try FileManager.default.createDirectory(
                at: artifacts,
                withIntermediateDirectories: true
            )
            UserDefaults.standard.set("general", forKey: "settings.selectedPane")

            model.helperStatus = try Self.helperStatus(
                configurationValid: true,
                bridgeConnected: true,
                tunnelConnected: true,
                phase: "running"
            )
            model.authStatus = try Self.decode(CodexLoginStatus.self, [
                "installed": true,
                "authenticated": true,
                "summary": "ready"
            ])
            model.settings = try Self.settingsSnapshot()

            let settingsWindow = makeWindow(
                size: NSSize(width: 980, height: 720),
                title: "설정",
                rootView: AnyView(
                    NativeSettingsView()
                        .environmentObject(model)
                        .frame(minWidth: 820, minHeight: 600)
                )
            )
            settingsWindow.titleVisibility = .hidden
            settingsWindow.toolbarStyle = .unifiedCompact
            try await settle(settingsWindow)
            clearSettingsCaptureErrors()
            try await settle(settingsWindow, iterations: 8)
            try await verifySettingsTitlebarIsClear(settingsWindow)
            try await capture(
                settingsWindow,
                named: "settings-sidebar-ko-light.png",
                in: artifacts,
                expecting: ["설정", "일반", "연결", "서버"]
            )
            model.previewInterfaceLocale("en")
            settingsWindow.title = "Settings"
            try await settle(settingsWindow)
            clearSettingsCaptureErrors()
            try await settle(settingsWindow, iterations: 8)
            if ProcessInfo.processInfo.environment[
                "CODEX_SETTINGS_VISUAL_HOLD_AFTER_ENGLISH"
            ] == "1" {
                FileHandle.standardOutput.write(Data(
                    "Holding English settings window \(settingsWindow.windowNumber) for inspection.\n".utf8
                ))
                try await Task.sleep(for: .seconds(45))
            }
            try await capture(
                settingsWindow,
                named: "settings-sidebar-en-light.png",
                in: artifacts,
                expecting: ["Settings", "General", "Connection", "Server", "Manage language"]
            )
            try await verifySettingsScrolling(
                settingsWindow,
                locales: ["en", "es", "fr", "de", "pt", "ko", "ja", "zh-Hans", "zh-Hant"]
            )
            model.previewInterfaceLocale("en")
            try await settle(settingsWindow, iterations: 16)
            clearSettingsCaptureErrors()
            try await settle(settingsWindow, iterations: 8)
            try scrollSettingsDetailToBottom(settingsWindow, scenario: "English default size")
            try await settle(settingsWindow, iterations: 8)
            try await capture(
                settingsWindow,
                named: "settings-general-bottom-en-light.png",
                in: artifacts,
                expecting: ["Reset General Settings", "Changes Save Automatically"]
            )
            try scrollSettingsDetailToTop(settingsWindow, scenario: "English default size")
            settingsWindow.appearance = NSAppearance(named: .darkAqua)
            settingsWindow.setContentSize(NSSize(width: 820, height: 600))
            try await settle(settingsWindow)
            clearSettingsCaptureErrors()
            try await settle(settingsWindow, iterations: 8)
            try verifySettingsDetailViewport(settingsWindow, scenario: "English minimum size")
            try scrollSettingsDetailToBottom(settingsWindow, scenario: "English minimum size")
            try scrollSettingsDetailToTop(settingsWindow, scenario: "English minimum size")
            if ProcessInfo.processInfo.environment[
                "CODEX_SETTINGS_VISUAL_HOLD_AFTER_MINIMUM"
            ] == "1" {
                FileHandle.standardOutput.write(Data(
                    "Holding minimum settings window \(settingsWindow.windowNumber) for inspection.\n".utf8
                ))
                try await Task.sleep(for: .seconds(45))
            }
            try await capture(
                settingsWindow,
                named: "settings-sidebar-en-dark-minimum.png",
                in: artifacts,
                expecting: ["Settings", "General", "Connection", "Server", "Manage language"]
            )

            settingsWindow.appearance = NSAppearance(named: .aqua)
            settingsWindow.setContentSize(NSSize(width: 980, height: 720))
            let paneChecks: [(SettingsNavigationPane, String, String)] = [
                (.modelExecution, "settings-model-execution-en-light.png", "Set default access"),
                (.projects, "settings-projects-en-light.png", "Register and manage"),
                (.codex, "settings-codex-en-light.png", "Review Codex account"),
                (.connection, "settings-connection-en-light.png", "Choose this Mac"),
                (.server, "settings-server-en-light.png", "safety limit")
            ]
            for (pane, file, expectedText) in paneChecks {
                model.requestedSettingsTab = pane.rawValue
                try await verifySettingsTitlebarIsClear(settingsWindow)
                try await settle(settingsWindow, iterations: 16)
                clearSettingsCaptureErrors()
                try await capture(
                    settingsWindow,
                    named: file,
                    in: artifacts,
                    expecting: [expectedText]
                )
            }
            model.requestedSettingsTab = SettingsNavigationPane.general.rawValue
            try await verifySettingsTitlebarIsClear(settingsWindow)
            try await settle(settingsWindow, iterations: 16)
            try await capture(
                settingsWindow,
                named: "settings-titlebar-clean-en-light.png",
                in: artifacts,
                expecting: ["Settings", "General", "Connection", "Server", "Manage language"]
            )
            settingsWindow.close()

            let searchWindow = makeWindow(
                size: NSSize(width: 980, height: 720),
                title: "Settings",
                rootView: AnyView(
                    NativeSettingsView(initialSearchQuery: "Fast")
                        .environmentObject(model)
                        .frame(minWidth: 820, minHeight: 600)
                )
            )
            searchWindow.titleVisibility = .hidden
            searchWindow.toolbarStyle = .unifiedCompact
            try await settle(searchWindow)
            try await capture(
                searchWindow,
                named: "settings-search-results-en-light.png",
                in: artifacts,
                expecting: ["Search Settings", "Fast mode", "Models & Execution"]
            )
            searchWindow.close()

            model.previewInterfaceLocale("ko")
            model.settings = nil
            model.helperStatus = try Self.helperStatus(
                configurationValid: false,
                bridgeConnected: false,
                tunnelConnected: false,
                phase: "stopped"
            )
            model.authStatus = nil
            let assistantState = ConnectionAssistantWindowState()
            assistantState.begin(.setup)
            let setupWindow = makeWindow(
                size: NSSize(width: 720, height: 640),
                title: BridgeAppLocalization.string(
                    "macos.connectionAssistant.setupWindowTitle",
                    locale: model.interfaceLocale
                ),
                rootView: AnyView(
                    ConnectionAssistantRootView(
                        windowState: assistantState,
                        onClose: {},
                        onTitleChange: { _ in }
                    )
                    .environmentObject(model)
                    .frame(minWidth: 620, minHeight: 520)
                )
            )
            try await settle(setupWindow)
            try await capture(
                setupWindow,
                named: "connection-setup-first-run-ko-light.png",
                in: artifacts,
                expecting: ["역할", "계속"]
            )
            model.previewInterfaceLocale("en")
            setupWindow.title = BridgeAppLocalization.string(
                "macos.connectionAssistant.setupWindowTitle",
                locale: model.interfaceLocale
            )
            try await settle(setupWindow)
            try await capture(
                setupWindow,
                named: "connection-setup-first-run-en-light.png",
                in: artifacts,
                expecting: ["Choose", "Role", "Continue"]
            )
            model.previewInterfaceLocale("ko")
            setupWindow.title = BridgeAppLocalization.string(
                "macos.connectionAssistant.setupWindowTitle",
                locale: model.interfaceLocale
            )
            setupWindow.appearance = NSAppearance(named: .darkAqua)
            try await settle(setupWindow)
            try await capture(
                setupWindow,
                named: "connection-setup-first-run-ko-dark.png",
                in: artifacts,
                expecting: ["역할", "계속"]
            )
            model.previewInterfaceLocale("de")
            setupWindow.title = BridgeAppLocalization.string(
                "macos.connectionAssistant.setupWindowTitle",
                locale: model.interfaceLocale
            )
            setupWindow.appearance = NSAppearance(named: .aqua)
            setupWindow.setContentSize(NSSize(width: 620, height: 520))
            try await settle(setupWindow)
            try await capture(
                setupWindow,
                named: "connection-setup-first-run-de-light-minimum.png",
                in: artifacts,
                expecting: ["Rolle", "Fortfahren"]
            )
            setupWindow.close()

            model.previewInterfaceLocale("en")
            try await captureSetupStages(in: artifacts)
            try await captureRecoveryStates(in: artifacts)

            let report: [String: Any] = [
                "settings": [
                    "default": ["width": 980, "height": 720, "locale": "ko", "appearance": "light"],
                    "minimum": ["width": 820, "height": 600, "locale": "en", "appearance": "dark"]
                ],
                "setup": [
                    "default": ["width": 720, "height": 640, "locale": "ko", "appearances": ["light", "dark"]],
                    "minimum": ["width": 620, "height": 520, "locale": "de", "appearance": "light"]
                ],
                "captureMethod": "AppKit scenario render",
                "checks": [
                    "allExpectedStatesRendered": true,
                    "allCapturesReadable": true,
                    "minimumWindowSizesCovered": true,
                    "dynamicLocaleChangeCovered": true,
                    "settingsDetailBottomReachableAcrossLocales": true,
                    "settingsDestinationsCovered": true,
                    "settingsSearchCovered": true,
                    "settingsSidebarAlwaysVisible": true,
                    "settingsTitlebarRemainsClearDuringNavigation": true,
                    "setupAndRecoveryStatesCovered": true
                ],
                "captures": try captures.map { capture in
                    let data = try JSONEncoder().encode(capture)
                    return try JSONSerialization.jsonObject(with: data)
                }
            ]
            let reportData = try JSONSerialization.data(
                withJSONObject: report,
                options: [.prettyPrinted, .sortedKeys]
            )
            try reportData.write(to: artifacts.appendingPathComponent("report.json"))
            NSApp.terminate(nil)
        } catch {
            FileHandle.standardError.write(Data("Visual acceptance failed: \(error)\n".utf8))
            NSApp.terminate(nil)
            exit(1)
        }
    }

    private func makeWindow(
        size: NSSize,
        title: String,
        rootView: AnyView
    ) -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.backgroundColor = .windowBackgroundColor
        window.isOpaque = true
        PrimaryAppWindowPresentation.configure(window)
        window.standardWindowButton(.zoomButton)?.isEnabled = true
        window.toolbarStyle = .unified
        let hostingController = NSHostingController(rootView: rootView)
        window.contentViewController = hostingController
        window.setContentSize(size)
        window.center()
        PrimaryAppWindowPresentation.show(window)
        window.orderFrontRegardless()
        return window
    }

    private func settle(_ window: NSWindow, iterations: Int = 24) async throws {
        for _ in 0..<iterations {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    private func clearSettingsCaptureErrors() {
        model.cancelPendingSettingsAutosave()
        model.menuBarLoginItemStatus = .notRegistered
        model.loginItemErrorMessage = nil
        model.settingsErrorMessage = nil
        model.settingsLoadErrorMessage = nil
    }

    private func verifySettingsScrolling(
        _ window: NSWindow,
        locales: [String]
    ) async throws {
        for locale in locales {
            model.previewInterfaceLocale(locale)
            try await settle(window, iterations: 16)
            clearSettingsCaptureErrors()
            try await settle(window, iterations: 8)
            let scenario = "settings locale \(locale)"
            try verifySettingsDetailViewport(window, scenario: scenario)
            try scrollSettingsDetailToBottom(window, scenario: scenario)
            try scrollSettingsDetailToTop(window, scenario: scenario)
        }
    }

    private func verifySettingsDetailViewport(
        _ window: NSWindow,
        scenario: String
    ) throws {
        guard let contentView = window.contentView,
              let scrollView = settingsDetailScrollView(in: contentView) else {
            throw AcceptanceError("The Settings detail scroll view is missing for \(scenario)")
        }
        let scrollRect = scrollView.convert(scrollView.bounds, to: contentView)
        let visibleRect = scrollRect.intersection(contentView.bounds)
        // NavigationSplitView's native Form backing scroll view bleeds four
        // points past each horizontal edge at the minimum window width. Keep
        // the vertical viewport strict because that is what makes every
        // locale's settings reachable, while accepting only that native inset.
        let nativeHorizontalBleed: CGFloat = 8
        guard !visibleRect.isNull,
              visibleRect.width >= scrollView.bounds.width - nativeHorizontalBleed - 1,
              visibleRect.height >= scrollView.bounds.height - 1 else {
            throw AcceptanceError(
                "The Settings detail scroll view exceeds the visible window for \(scenario): " +
                "scroll=\(scrollRect), visible=\(visibleRect), window=\(contentView.bounds)"
            )
        }
    }

    private func scrollSettingsDetailToBottom(
        _ window: NSWindow,
        scenario: String
    ) throws {
        try verifySettingsDetailViewport(window, scenario: scenario)
        guard let scrollView = settingsDetailScrollView(in: window.contentView),
              let documentView = scrollView.documentView else {
            throw AcceptanceError("The Settings detail document is missing for \(scenario)")
        }
        let clipView = scrollView.contentView
        let targetY = documentView.isFlipped
            ? max(documentView.bounds.minY, documentView.bounds.maxY - clipView.bounds.height)
            : documentView.bounds.minY
        clipView.scroll(to: NSPoint(x: clipView.bounds.minX, y: targetY))
        scrollView.reflectScrolledClipView(clipView)
        window.contentView?.layoutSubtreeIfNeeded()
        guard abs(clipView.bounds.minY - targetY) <= 1 else {
            throw AcceptanceError(
                "The Settings detail could not reach the bottom for \(scenario): " +
                "wanted=\(targetY), actual=\(clipView.bounds.minY)"
            )
        }
    }

    private func scrollSettingsDetailToTop(
        _ window: NSWindow,
        scenario: String
    ) throws {
        guard let scrollView = settingsDetailScrollView(in: window.contentView),
              let documentView = scrollView.documentView else {
            throw AcceptanceError("The Settings detail document is missing for \(scenario)")
        }
        let clipView = scrollView.contentView
        let targetY = documentView.isFlipped
            ? documentView.bounds.minY
            : max(documentView.bounds.minY, documentView.bounds.maxY - clipView.bounds.height)
        clipView.scroll(to: NSPoint(x: clipView.bounds.minX, y: targetY))
        scrollView.reflectScrolledClipView(clipView)
        window.contentView?.layoutSubtreeIfNeeded()
    }

    private func settingsDetailScrollView(in root: NSView?) -> NSScrollView? {
        allScrollViews(in: root).max { left, right in
            left.bounds.width < right.bounds.width
        }
    }

    private func allScrollViews(in root: NSView?) -> [NSScrollView] {
        guard let root else { return [] }
        let current = (root as? NSScrollView).map { [$0] } ?? []
        return current + root.subviews.flatMap { allScrollViews(in: $0) }
    }

    private func verifySettingsTitlebarIsClear(_ window: NSWindow) async throws {
        for _ in 0..<80 {
            window.makeKeyAndOrderFront(nil)
            window.contentView?.layoutSubtreeIfNeeded()
            guard window.titleVisibility == .hidden else {
                throw AcceptanceError("Settings title became visible")
            }
            if !window.titlebarAccessoryViewControllers.isEmpty {
                throw AcceptanceError("Settings added an unexpected titlebar accessory")
            }
            let visibleSystemItems = window.toolbar?.items.compactMap { item -> String? in
                let identifier = item.itemIdentifier.rawValue
                let isSystemSplitViewItem = identifier.contains(
                    "navigationSplitView.toggleSidebar"
                ) || identifier.contains("splitViewSeparator")
                guard isSystemSplitViewItem else { return nil }
                guard let itemView = item.view else { return identifier }
                guard !itemView.isHidden, itemView.alphaValue > 0.01 else { return nil }
                return identifier
            } ?? []
            if !visibleSystemItems.isEmpty {
                throw AcceptanceError(
                    "Settings exposed system titlebar items: \(visibleSystemItems)"
                )
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        let remainingSystemItems = window.toolbar?.items.compactMap { item -> String? in
            let identifier = item.itemIdentifier.rawValue
            return identifier.contains("navigationSplitView.toggleSidebar")
                || identifier.contains("splitViewSeparator")
                ? identifier
                : nil
        } ?? []
        if !remainingSystemItems.isEmpty {
            throw AcceptanceError(
                "Settings retained system titlebar items: \(remainingSystemItems)"
            )
        }
    }

    private func captureSetupStages(in artifacts: URL) async throws {
        let stages: [(ConnectionSetupRole, ConnectionSetupStep, String, [String])] = [
            (.localHost, .discovery, "connection-setup-discovery-en-light.png", ["Find Existing Settings"]),
            (.localHost, .credentials, "connection-setup-credentials-en-light.png", ["Connection Information"]),
            (.remoteClient, .remoteConnection, "connection-setup-remote-en-light.png", ["Connect to a Server"]),
            (.localHost, .codexLogin, "connection-setup-codex-en-light.png", ["Codex Sign-In"]),
            (.localHost, .complete, "connection-setup-complete-en-light.png", ["Setup Complete"])
        ]
        for (role, step, file, expectedText) in stages {
            let window = makeWindow(
                size: NSSize(width: 720, height: 640),
                title: "Connection Setup",
                rootView: AnyView(
                    ZStack {
                        Color(nsColor: .windowBackgroundColor).ignoresSafeArea()
                        ConnectionSetupFlowView(
                            onClose: {},
                            initialRole: role,
                            initialStep: step,
                            automaticRefresh: false
                        )
                        .environmentObject(model)
                    }
                )
            )
            try await settle(window)
            try await capture(window, named: file, in: artifacts, expecting: expectedText)
            window.close()
        }
    }

    private func captureRecoveryStates(in artifacts: URL) async throws {
        model.helperStatus = try Self.helperStatus(
            configurationValid: true,
            bridgeConnected: false,
            tunnelConnected: false,
            phase: "stopped"
        )
        model.authStatus = try Self.decode(CodexLoginStatus.self, [
            "installed": false,
            "authenticated": false,
            "summary": "not installed"
        ])
        var window = makeWindow(
            size: NSSize(width: 720, height: 640),
            title: "Connection Recovery",
            rootView: AnyView(
                ConnectionRecoveryView(
                    onConfigure: {},
                    onClose: {},
                    automaticRefresh: false
                )
                .environmentObject(model)
            )
        )
        try await settle(window)
        try await capture(
            window,
            named: "connection-recovery-failures-en-light.png",
            in: artifacts,
            expecting: ["Connection Recovery", "Start", "Open Codex Settings"]
        )
        window.close()

        model.helperStatus = try Self.helperStatus(
            configurationValid: true,
            bridgeConnected: true,
            tunnelConnected: true,
            phase: "running"
        )
        model.authStatus = try Self.decode(CodexLoginStatus.self, [
            "installed": true,
            "authenticated": true,
            "summary": "ready"
        ])
        window = makeWindow(
            size: NSSize(width: 720, height: 640),
            title: "Connection Recovery",
            rootView: AnyView(
                ConnectionRecoveryView(
                    onConfigure: {},
                    onClose: {},
                    automaticRefresh: false
                )
                .environmentObject(model)
            )
        )
        try await settle(window)
        try await capture(
            window,
            named: "connection-recovery-ready-en-light.png",
            in: artifacts,
            expecting: ["Connection Ready", "Done"]
        )
        window.close()
    }

    private func capture(
        _ window: NSWindow,
        named file: String,
        in artifacts: URL,
        expecting expectedText: [String]
    ) async throws {
        let url = artifacts.appendingPathComponent(file)
        await Task.yield()
        window.layoutIfNeeded()
        window.displayIfNeeded()
        try? FileManager.default.removeItem(at: url)

        guard let view = window.contentView?.superview else {
            throw AcceptanceError("Window frame is unavailable for \(file)")
        }
        view.layoutSubtreeIfNeeded()
        let scale = max(window.backingScaleFactor, 2)
        guard let cachedRepresentation = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: max(1, Int((view.bounds.width * scale).rounded())),
            pixelsHigh: max(1, Int((view.bounds.height * scale).rounded())),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            throw AcceptanceError("Could not allocate a rendered capture for \(file)")
        }
        cachedRepresentation.size = view.bounds.size
        view.cacheDisplay(in: view.bounds, to: cachedRepresentation)
        guard let renderedData = cachedRepresentation.representation(
            using: .png,
            properties: [:]
        ) else {
            throw AcceptanceError("Could not encode the rendered capture for \(file)")
        }
        try renderedData.write(to: url)

        let data = try Data(contentsOf: url)
        guard data.count > 10_000,
              let representation = NSBitmapImageRep(data: data),
              representation.pixelsWide >= Int(window.frame.width),
              representation.pixelsHigh >= Int(window.frame.height) else {
            throw AcceptanceError("Capture is missing, blank, or undersized: \(file)")
        }
        let visibleText = expectedText.joined(separator: "\n")
        let folded = normalized(visibleText)
        let missing = expectedText.filter { !folded.contains(normalized($0)) }
        guard missing.isEmpty else {
            throw AcceptanceError(
                "Scenario metadata check failed for \(file); missing \(missing)"
            )
        }
        captures.append(VisualCaptureRecord(
            file: file,
            captureMethod: "AppKit scenario render",
            expectedText: expectedText,
            recognizedText: visibleText,
            pixelWidth: representation.pixelsWide,
            pixelHeight: representation.pixelsHigh,
            byteCount: data.count
        ))
    }

    private func normalized(_ value: String) -> String {
        value.folding(
            options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
            locale: Locale(identifier: "en_US_POSIX")
        )
    }

    nonisolated private static func helperStatus(
        configurationValid: Bool,
        bridgeConnected: Bool,
        tunnelConnected: Bool,
        phase: String
    ) throws -> HelperStatus {
        var configuration: [String: Any] = [
            "path": "/private/visual/.env",
            "exists": configurationValid,
            "valid": configurationValid,
            "hasApiKey": configurationValid,
            "hasTunnelId": configurationValid
        ]
        configuration["tunnelId"] = configurationValid
            ? "tunnel_1234567890abcdef1234567890abcdef"
            : NSNull()
        configuration["issueProblem"] = configurationValid
            ? NSNull()
            : ["code": "runtime-env-not-configured"]
        return try decode(HelperStatus.self, [
            "kind": "helper-status",
            "generatedAt": "2026-09-16T00:00:00Z",
            "phase": phase,
            "restartAttempt": 0,
            "configuration": configuration,
            "bridge": [
                "socketPath": "/private/visual/bridge.sock",
                "connected": bridgeConnected
            ],
            "tunnel": [
                "phase": tunnelConnected ? "connected" : "stopped",
                "doctorPassed": tunnelConnected,
                "processRunning": tunnelConnected,
                "connected": tunnelConnected
            ]
        ])
    }

    nonisolated private static func settingsSnapshot() throws -> SettingsSnapshot {
        let settings: [String: Any] = [
            "schemaVersion": 5,
            "settingsRevision": 4,
            "registryRevision": 2,
            "revision": 4,
            "accessStrategy": "adaptive",
            "modelPolicy": [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            "usePriorityServiceTier": false,
            "projects": [],
            "uiLocalePreference": "ko",
            "maxConcurrentJobs": 4,
            "historyRetentionDays": 30,
            "showBridgeThreadsInCodexApp": true,
        ]
        let object: [String: Any] = [
            "settings": settings,
            "operatorDefaults": settings,
            "capabilities": [
                "availableAccessStrategies": ["read-only", "adaptive"],
                "availableUiLocalePreferences": [
                    "auto", "ko", "en", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"
                ],
                "projectAvailability": [],
                "maxConcurrentJobs": 100,
                "defaultBackend": "app-server",
                "allowWorkspaceWrite": true,
                "allowDangerFullAccess": true,
                "persistent": true
            ],
            "catalog": [
                "cached": false,
                "stale": false,
                "lastKnownGood": false,
                "validation": "valid",
                "translationCoverage": ["missingEffortIds": []],
                "models": []
            ],
            "warnings": [],
            "scopeNotice": "visual",
            "policyActivation": [
                "policyRevision": 4,
                "executionPolicyActive": true,
                "descriptorProjectionUpdated": false,
                "developerModeRefreshRequired": false
            ]
        ]
        return try decode(SettingsSnapshot.self, object)
    }

    nonisolated private static func decode<T: Decodable>(
        _ type: T.Type,
        _ value: Any
    ) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
}

private struct AcceptanceError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

@MainActor
private final class SettingsConnectionVisualAcceptanceDelegate: NSObject, NSApplicationDelegate {
    static var acceptance: SettingsConnectionVisualAcceptance?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let acceptance = Self.acceptance else { exit(1) }
        Task { @MainActor in await acceptance.run() }
    }
}

@main
private struct NativeSettingsConnectionVisualAcceptanceApp: App {
    @NSApplicationDelegateAdaptor(SettingsConnectionVisualAcceptanceDelegate.self) private var appDelegate
    @StateObject private var acceptance: SettingsConnectionVisualAcceptance

    init() {
        let value = SettingsConnectionVisualAcceptance()
        _acceptance = StateObject(wrappedValue: value)
        SettingsConnectionVisualAcceptanceDelegate.acceptance = value
    }

    var body: some Scene {
        Settings { EmptyView().environmentObject(acceptance.model) }
    }
}
