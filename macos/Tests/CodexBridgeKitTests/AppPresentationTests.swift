import Darwin
import AppKit
import XCTest
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

final class AppPresentationTests: XCTestCase {
    func testEarlierApplicationInstanceWinsSingleInstanceSelection() {
        let earlier = Date(timeIntervalSince1970: 100)
        let later = Date(timeIntervalSince1970: 200)

        XCTAssertEqual(
            AppSingleInstanceSelection.primaryProcessIdentifier(
                current: AppInstanceIdentity(processIdentifier: 20, launchDate: later),
                running: [
                    AppInstanceIdentity(processIdentifier: 10, launchDate: earlier)
                ]
            ),
            10
        )
        XCTAssertEqual(
            AppSingleInstanceSelection.primaryProcessIdentifier(
                current: AppInstanceIdentity(processIdentifier: 10, launchDate: earlier),
                running: [
                    AppInstanceIdentity(processIdentifier: 20, launchDate: later)
                ]
            ),
            10
        )
    }

    func testAppBundleProhibitsMultipleInstances() throws {
        let macOSDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let data = try Data(contentsOf: macOSDirectory.appendingPathComponent("Info.plist"))
        let propertyList = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        )

        XCTAssertEqual(propertyList["LSMultipleInstancesProhibited"] as? Bool, true)
    }

    func testApplicationQuitConfirmationOnlyAppearsWhenShutdownImpactExistsOrIsUnknown() {
        func impact(
            activeJobs: Int = 0,
            pendingAdmissions: Int = 0,
            backgroundProcessState: String = "confirmed",
            backgroundProcesses: Int = 0,
            backgroundProcessUnknownAgents: Int = 0
        ) -> RuntimeAdmissionSnapshot {
            RuntimeAdmissionSnapshot(
                acceptingNewJobs: true,
                activeJobs: activeJobs,
                pendingAdmissions: pendingAdmissions,
                backgroundProcessState: backgroundProcessState,
                backgroundProcesses: backgroundProcesses,
                backgroundProcessAgents: backgroundProcesses > 0 ? 1 : 0,
                backgroundProcessUnknownAgents: backgroundProcessUnknownAgents
            )
        }

        XCTAssertFalse(ApplicationQuitConfirmationPolicy.requiresConfirmation(
            for: impact(),
            refreshFailed: false
        ))
        XCTAssertTrue(ApplicationQuitConfirmationPolicy.requiresConfirmation(
            for: impact(activeJobs: 1),
            refreshFailed: false
        ))
        XCTAssertTrue(ApplicationQuitConfirmationPolicy.requiresConfirmation(
            for: impact(pendingAdmissions: 1),
            refreshFailed: false
        ))
        XCTAssertTrue(ApplicationQuitConfirmationPolicy.requiresConfirmation(
            for: impact(backgroundProcesses: 1),
            refreshFailed: false
        ))
        XCTAssertTrue(ApplicationQuitConfirmationPolicy.requiresConfirmation(
            for: impact(backgroundProcessUnknownAgents: 1),
            refreshFailed: false
        ))
        XCTAssertTrue(ApplicationQuitConfirmationPolicy.requiresConfirmation(
            for: impact(backgroundProcessState: "unknown"),
            refreshFailed: false
        ))
        XCTAssertTrue(ApplicationQuitConfirmationPolicy.requiresConfirmation(
            for: nil,
            refreshFailed: false
        ))
        XCTAssertTrue(ApplicationQuitConfirmationPolicy.requiresConfirmation(
            for: impact(),
            refreshFailed: true
        ))
    }

    func testNativeLocalizationSupportsEverySharedExplicitLocale() {
        let expected = [
            "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"
        ]

        XCTAssertEqual(BridgeAppLocalization.supportedLanguageCodes, expected)
        XCTAssertEqual(BridgeAppLocalization.supportedPreferences, ["auto"] + expected)
        for language in expected {
            XCTAssertEqual(BridgeAppLocalization.languageCode(for: language), language)
            XCTAssertEqual(
                BridgeAppLocalization.languageCode(
                    for: BridgeAppLocalization.locale(for: language)
                ),
                language
            )
        }
    }

    func testNativeLocalizationDoesNotTreatUnknownExplicitLocaleAsAutomatic() {
        XCTAssertEqual(BridgeAppLocalization.locale(for: "unknown").identifier, "en")
        XCTAssertEqual(BridgeAppLocalization.languageCode(for: "unknown"), "en")
    }

    func testNativeLocalizationNormalizesRegionalLocales() {
        let cases = [
            "en-GB": "en",
            "ko-KR": "ko",
            "ja-JP": "ja",
            "zh-CN": "zh-Hans",
            "zh-SG": "zh-Hans",
            "zh-TW": "zh-Hant",
            "zh-HK": "zh-Hant",
            "es-MX": "es",
            "fr-CA": "fr",
            "de-AT": "de",
            "pt-BR": "pt"
        ]

        for (identifier, expected) in cases {
            XCTAssertEqual(
                BridgeAppLocalization.languageCode(for: Locale(identifier: identifier)),
                expected,
                identifier
            )
        }
    }

    func testNativeLocalizationTreatsLegacyTunnelPollAsProgress() {
        XCTAssertTrue(BridgeAppLocalization.isTunnelConnectionPending(
            problem: nil,
            diagnosticMessage: "Waiting for a successful control-plane poll."
        ))
        XCTAssertNil(BridgeAppLocalization.statusProblemDescription(
            problem: nil,
            diagnosticMessage: "Waiting for a successful control-plane poll.",
            context: .tunnel,
            locale: Locale(identifier: "ko")
        ))
    }

    func testNativeLocalizationDoesNotExposeBackendStatusDiagnostics() {
        XCTAssertEqual(
            BridgeAppLocalization.statusProblemDescription(
                problem: BridgeStatusProblem(code: "tunnel-process-not-running"),
                diagnosticMessage: "The tunnel-client process is not running.",
                context: .tunnel,
                locale: Locale(identifier: "ko")
            ),
            "Secure MCP Tunnel 프로세스가 실행 중이지 않습니다."
        )
        XCTAssertEqual(
            BridgeAppLocalization.statusProblemDescription(
                problem: nil,
                diagnosticMessage: "Unexpected English helper diagnostic.",
                context: .helper,
                locale: Locale(identifier: "ko")
            ),
            "요청을 처리하지 못했습니다. 진단 로그에서 자세한 내용을 확인해 주세요."
        )
        XCTAssertEqual(
            BridgeAppLocalization.statusProblemDescription(
                problem: BridgeStatusProblem(code: "runtime-env-owner-mismatch"),
                diagnosticMessage: nil,
                context: .runtimeConfiguration,
                locale: Locale(identifier: "ko")
            ),
            "연결 정보 파일 또는 폴더를 현재 사용자가 소유하지 않습니다."
        )
    }

    @MainActor
    func testPrimaryAppWindowsUseStageManagerPrimaryBehavior() {
        let window = NSWindow(
            contentRect: .zero,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )

        PrimaryAppWindowPresentation.configure(window)

        XCTAssertEqual(window.level, .normal)
        XCTAssertTrue(window.collectionBehavior.contains(.managed))
        XCTAssertTrue(window.collectionBehavior.contains(.primary))
        XCTAssertTrue(window.collectionBehavior.contains(.participatesInCycle))
        XCTAssertFalse(window.collectionBehavior.contains(.auxiliary))
        XCTAssertFalse(window.collectionBehavior.contains(.canJoinAllApplications))
    }

    func testBrandMarkScalesInsideItsSquare() {
        let bounds = CGRect(x: 0, y: 0, width: 18, height: 18)
        let mark = BridgeBrandMarkShape().path(in: bounds).boundingRect

        XCTAssertGreaterThan(mark.width, 10)
        XCTAssertGreaterThan(mark.height, 10)
        XCTAssertTrue(bounds.contains(mark))
    }

    @MainActor
    func testMenuBarBrandImagesAreDistinctTemplates() {
        let healthy = BridgeMenuBarIcon.templateImage(for: .healthy)
        let checking = BridgeMenuBarIcon.templateImage(for: .checking)
        let attention = BridgeMenuBarIcon.templateImage(for: .attention)
        let unavailable = BridgeMenuBarIcon.templateImage(for: .unavailable)

        for image in [healthy, checking, attention, unavailable] {
            XCTAssertTrue(image.isTemplate)
            XCTAssertEqual(image.size, CGSize(width: 18, height: 18))
            XCTAssertNotNil(image.tiffRepresentation)
        }
        XCTAssertNotEqual(healthy.tiffRepresentation, checking.tiffRepresentation)
        XCTAssertNotEqual(checking.tiffRepresentation, attention.tiffRepresentation)
        XCTAssertNotEqual(healthy.tiffRepresentation, attention.tiffRepresentation)
        XCTAssertNotEqual(attention.tiffRepresentation, unavailable.tiffRepresentation)
    }

    @MainActor
    func testStartupAndTunnelReadinessUseCheckingHealthInsteadOfUnavailable() throws {
        let model = AppModel()

        XCTAssertTrue(model.isBridgeConnectionChecking)
        XCTAssertEqual(model.health, .checking)
        XCTAssertNil(model.operationalProblem)

        model.helperStatus = try helperStatus(
            phase: "starting",
            bridgeConnected: false,
            tunnelConnected: false
        )
        XCTAssertTrue(model.isBridgeConnectionChecking)
        XCTAssertEqual(model.health, .checking)
        XCTAssertNil(model.operationalProblem)

        model.helperStatus = try helperStatus(
            phase: "starting",
            bridgeConnected: true,
            tunnelConnected: false
        )
        XCTAssertTrue(model.isBridgeConnectionChecking)
        XCTAssertEqual(model.health, .checking)
        XCTAssertNil(model.operationalProblem)

        model.helperStatus = try helperStatus(tunnelConnected: false)
        XCTAssertTrue(model.isTunnelConnectionChecking)
        XCTAssertEqual(model.health, .checking)
        XCTAssertNil(model.operationalProblem)

        model.helperStatus = try helperStatus(
            phase: "stopped",
            bridgeConnected: false,
            tunnelConnected: false
        )
        XCTAssertFalse(model.isBridgeConnectionChecking)
        XCTAssertEqual(model.health, .unavailable)
    }

    @MainActor
    func testConfirmedStartupFailuresStillShowRecoveryGuidance() throws {
        let model = AppModel()
        model.startupErrorMessage = "Helper could not start"
        XCTAssertFalse(model.isBridgeConnectionChecking)
        XCTAssertEqual(model.health, .unavailable)
        XCTAssertEqual(model.operationalProblem, .runtime)

        model.startupErrorMessage = nil
        model.helperStatus = try helperStatus(
            phase: "starting", bridgeConnected: false, tunnelConnected: false,
            configurationValid: false
        )
        XCTAssertTrue(model.needsSetup)
        XCTAssertFalse(model.isBridgeConnectionChecking)
        XCTAssertEqual(model.health, .unavailable)
        XCTAssertEqual(model.operationalProblem, .configuration)
    }

    @MainActor
    func testLoginItemRegistrationUsesSystemStateWithoutSharedSettings() {
        let controller = TestLoginItemController(status: .notRegistered)
        let model = AppModel(loginItemController: controller)

        XCTAssertEqual(model.menuBarLoginItemStatus, .notRegistered)
        model.setMenuBarLaunchAtLogin(true)
        XCTAssertEqual(controller.registerCalls, 1)
        XCTAssertEqual(model.menuBarLoginItemStatus, .enabled)

        model.setMenuBarLaunchAtLogin(false)
        XCTAssertEqual(controller.unregisterCalls, 1)
        XCTAssertEqual(model.menuBarLoginItemStatus, .notRegistered)
        XCTAssertNil(model.loginItemErrorMessage)
    }

    @MainActor
    func testLocalTransientFailurePreservesContentAndConfirmedFailureIsUnavailable() async throws {
        let model = AppModel()
        let start = Date(timeIntervalSince1970: 100)
        model.recordLocalConnectionStatus(try helperStatus(), at: start)
        model.dashboard = try dashboardStatus(scope: "retained-local-dashboard")
        let failure = try helperStatus(bridgeConnected: false)

        model.recordLocalConnectionStatus(failure, at: start.addingTimeInterval(1))
        XCTAssertEqual(model.health, .checking)
        XCTAssertEqual(model.operationalObservation, .unknown)
        XCTAssertNil(model.operationalProblem)
        await model.refreshDashboard()
        XCTAssertEqual(model.dashboard?.scope, "retained-local-dashboard")

        model.recordLocalConnectionStatus(try helperStatus(), at: start.addingTimeInterval(2))
        XCTAssertTrue(model.bridgeConnected)
        XCTAssertFalse(model.localConnectionRecovery.isChecking)

        model.recordLocalConnectionStatus(failure, at: start.addingTimeInterval(3))
        model.recordLocalConnectionStatus(failure, at: start.addingTimeInterval(11))
        XCTAssertEqual(model.health, .unavailable)
        XCTAssertEqual(model.operationalProblem, .runtime)
        await model.refreshDashboard()
        XCTAssertNil(model.dashboard)
    }

    @MainActor
    func testTunnelProbeFailureGetsGraceButRuntimeExitDoesNot() throws {
        let model = AppModel()
        model.recordLocalConnectionStatus(try helperStatus(tunnelConnected: false))
        XCTAssertTrue(model.isTunnelConnectionChecking)
        XCTAssertEqual(model.health, .checking)
        model.recordLocalConnectionStatus(try helperStatus(phase: "backoff", bridgeConnected: false, tunnelConnected: false))
        XCTAssertEqual(model.health, .unavailable)
        XCTAssertEqual(model.operationalProblem, .runtime)
    }

    @MainActor
    func testRecoveryGraceExpiresEvenWhileAStatusRequestIsStalled() async throws {
        let model = AppModel()
        model.recordLocalConnectionStatus(try helperStatus(bridgeConnected: false))
        XCTAssertEqual(model.health, .checking)
        try await Task.sleep(nanoseconds: 8_100_000_000)
        XCTAssertEqual(model.health, .unavailable)
    }

    @MainActor
    func testHiddenDashboardDoesNotRefreshButOpeningAndFallbackDo() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-visible-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let status = String(decoding: try JSONEncoder().encode(helperStatus()), as: UTF8.self)
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { method in
            NativeFixtureReply(body: method == "helper.health" ? "{\"result\":\(status)}" : "{\"error\":{\"code\":-32601,\"message\":\"unsupported\"}}")
        }
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            NativeFixtureReply(body: "{\"error\":{\"code\":-32601,\"message\":\"unsupported\"}}", delay: method == "dashboard.snapshot" ? 0.2 : 0)
        }
        defer { helper.stop(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        let model = AppModel(paths: paths)
        model.recordLocalConnectionStatus(try helperStatus())
        model.scheduleBackgroundRefreshes()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 0)
        XCTAssertEqual(bridge.count("settings.snapshot"), 0)
        model.setDashboardVisible(true)
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertGreaterThan(bridge.count("dashboard.snapshot"), 0)
        model.setDashboardVisible(false)
        let before = bridge.count("dashboard.snapshot")
        model.scheduleBackgroundRefreshes(at: Date().addingTimeInterval(120))
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(bridge.count("dashboard.snapshot"), before)
        model.setDashboardVisible(true)
        try await Task.sleep(for: .milliseconds(320))
        model.setDashboardVisible(false)
        model.setDashboardVisible(true)
        try await Task.sleep(for: .milliseconds(50))
        model.scheduleBackgroundRefreshes(at: Date().addingTimeInterval(120))
        try await Task.sleep(for: .milliseconds(650))
        XCTAssertEqual(bridge.count("dashboard.snapshot"), before + 2)
        model.setDashboardVisible(false)
        model.cancelAllPolling()
    }

    @MainActor
    func testClosingDashboardDuringAReadKeepsHealthyMenuState() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-cancel-menu-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let status = String(decoding: try JSONEncoder().encode(helperStatus()), as: UTF8.self)
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { method in
            switch method {
            case "helper.health": return NativeFixtureReply(body: "{\"result\":\(status)}")
            case "auth.status": return NativeFixtureReply(body: #"{"result":{"installed":true,"authenticated":true,"summary":"ready"}}"#)
            default: return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#)
            }
        }
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#,
                delay: method == "dashboard.snapshot" ? 1 : 0)
        }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); helper.stop(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        model.authStatus = try loginStatus(installed: true, authenticated: true)
        model.dashboard = try dashboardStatus(scope: "retained")
        model.setDashboardVisible(true)
        for _ in 0..<50 {
            if bridge.count("dashboard.snapshot") > 0 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 1)
        model.setDashboardVisible(false)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertNil(model.dashboardErrorMessage)
        XCTAssertEqual(model.dashboard?.scope, "retained")
        XCTAssertEqual(model.health, .healthy)
    }

    @MainActor
    func testOlderDashboardFailureCannotReplaceANewerSuccessfulRead() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-stale-menu-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let snapshot = String(decoding: try JSONEncoder().encode(dashboardStatus(scope: "latest")), as: UTF8.self)
        let replies = TestDashboardReplySequence([
            NativeFixtureReply(body: #"{"error":{"code":-32603,"message":"older read failed"}}"#, delay: 0.4),
            NativeFixtureReply(body: "{\"result\":\(snapshot)}")
        ])
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { _ in replies.next() }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        model.authStatus = try loginStatus(installed: true, authenticated: true)
        let earlier = Task { await model.refreshDashboard(enrich: false) }
        for _ in 0..<50 {
            if bridge.count("dashboard.snapshot") > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 1)
        await model.refreshDashboard(enrich: false)
        await earlier.value
        XCTAssertEqual(model.dashboard?.scope, "latest")
        XCTAssertNil(model.dashboardErrorMessage)
        XCTAssertEqual(model.health, .healthy)
    }

    @MainActor
    func testChangesDuringAuthAndInstallationReadsGetATrailingRefresh() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-trailing-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let state = TestTrailingReadState()
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { method in state.reply(method) }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); helper.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        let initialAuth = Task { await model.refreshAuthStatus() }
        try await Task.sleep(for: .milliseconds(50))
        await model.refreshAuthStatus()
        await initialAuth.value
        XCTAssertEqual(helper.count("auth.status"), 2)
        XCTAssertEqual(model.authStatus?.authenticated, true)
        let initialDetails = Task { await model.manageCodex(.init(action: "status", includeAccount: false)) }
        try await Task.sleep(for: .milliseconds(50))
        await model.manageCodex(.init(action: "status", includeAccount: false))
        await initialDetails.value
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(helper.count("codex.runtime"), 2)
    }

    @MainActor
    func testLifecycleNoticeUpdatesMenuHealthWithoutWaitingForPolling() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-event-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let state = TestLifecycleNoticeState(status: String(decoding: try JSONEncoder().encode(helperStatus()), as: UTF8.self))
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { method in state.reply(method) }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); state.changed.signal(); helper.stop(); try? FileManager.default.removeItem(at: root) }
        await model.refreshStatus()
        for _ in 0..<50 {
            if helper.count("changes.wait") >= 2 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(model.helperChangesAvailable)
        XCTAssertTrue(model.bridgeConnected)
        state.setStatus(String(decoding: try JSONEncoder().encode(helperStatus(phase: "backoff", bridgeConnected: false, tunnelConnected: false)), as: UTF8.self))
        state.changed.signal()
        for _ in 0..<50 {
            if model.health == .unavailable { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(model.health, .unavailable)
    }

    @MainActor
    func testSlowDetailsCannotBlockHealthAndConcurrentChecksAreCoalesced() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-health-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let status = String(decoding: try JSONEncoder().encode(helperStatus()), as: UTF8.self)
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { method in
            if method == "helper.health" { return NativeFixtureReply(body: "{\"result\":\(status)}", delay: 0.05) }
            return NativeFixtureReply(body: "{\"error\":{\"code\":-32601,\"message\":\"unsupported\"}}", delay: method == "codex.runtime" ? 1.5 : 0)
        }
        defer { helper.stop(); try? FileManager.default.removeItem(at: root) }
        let model = AppModel(paths: paths)
        model.recordLocalConnectionStatus(try helperStatus())
        model.scheduleBackgroundRefreshes()
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertEqual(helper.count("codex.runtime"), 1)
        let started = Date()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<10 { group.addTask { await model.refreshStatus() } }
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertLessThanOrEqual(helper.count("helper.health"), 2)
        XCTAssertTrue(model.bridgeConnected)
        model.prepareForSystemSleep()
        XCTAssertEqual(model.operationalObservation, .unknown)
    }

    @MainActor
    func testLoginItemApprovalOpensSystemSettingsInsteadOfReregistering() {
        let controller = TestLoginItemController(status: .requiresApproval)
        let model = AppModel(loginItemController: controller)

        model.setMenuBarLaunchAtLogin(true)

        XCTAssertEqual(controller.registerCalls, 0)
        XCTAssertEqual(controller.openSystemSettingsCalls, 1)
        XCTAssertEqual(model.menuBarLoginItemStatus, .requiresApproval)
    }

    @MainActor
    func testLoginItemRegistrationFailureKeepsActualSystemState() {
        let controller = TestLoginItemController(status: .notRegistered)
        controller.registrationError = TestLoginItemError.denied
        let model = AppModel(loginItemController: controller)

        model.setMenuBarLaunchAtLogin(true)

        XCTAssertEqual(model.menuBarLoginItemStatus, .notRegistered)
        XCTAssertNotNil(model.loginItemErrorMessage)
        XCTAssertFalse(model.loginItemOperationInProgress)
    }

    @MainActor
    func testHealthyRuntimeDistinguishesLoadingFromAuthenticationProblems() throws {
        let model = AppModel()
        model.helperStatus = try helperStatus()

        XCTAssertEqual(model.health, .checking)
        model.authStatus = try loginStatus(installed: true, authenticated: false)
        XCTAssertEqual(model.health, .attention)
        model.authStatus = try loginStatus(installed: false, authenticated: false)
        XCTAssertEqual(model.health, .unavailable)
        model.authStatus = try loginStatus(installed: true, authenticated: true)
        XCTAssertEqual(model.health, .checking)
        model.dashboard = try dashboardStatus()
        XCTAssertEqual(model.health, .healthy)
        model.dashboard = try dashboardStatus(runtimeUnknownAgents: 18)
        XCTAssertEqual(model.health, .healthy)
        model.dashboardErrorMessage = "stale"
        XCTAssertEqual(model.health, .attention)
    }

    @MainActor
    func testAuthenticationNoticeDistinguishesCheckingFromLoggedOut() throws {
        let model = AppModel()

        XCTAssertFalse(model.shouldShowCodexAuthenticationNotice)
        XCTAssertTrue(model.shouldShowCodexWeeklyUsage)
        model.authStatus = try loginStatus(installed: true, authenticated: false)
        XCTAssertTrue(model.shouldShowCodexAuthenticationNotice)
        XCTAssertFalse(model.shouldShowCodexWeeklyUsage)
        model.authStatus = try loginStatus(installed: false, authenticated: false)
        XCTAssertTrue(model.shouldShowCodexAuthenticationNotice)
        XCTAssertFalse(model.shouldShowCodexWeeklyUsage)
        model.authStatus = try loginStatus(installed: true, authenticated: true)
        XCTAssertFalse(model.shouldShowCodexAuthenticationNotice)
        XCTAssertTrue(model.shouldShowCodexWeeklyUsage)
        model.authStatus = nil
        model.authErrorMessage = "status failed"
        XCTAssertTrue(model.shouldShowCodexAuthenticationNotice)
        XCTAssertTrue(model.shouldShowCodexWeeklyUsage)
    }

    func testSettingsDraftPreservesUnavailableSavedSelectionUntilPolicyChanges() throws {
        let saved = ModelChoice(model: "gpt-saved", reasoningEffort: "ultra")
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "fixed",
                "selection": choiceObject(saved),
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])],
            operatorCeiling: [ModelChoice(model: "gpt-current", reasoningEffort: "high")]
        )
        var draft = SettingsDraft(snapshot: snapshot)

        XCTAssertFalse(draft.modelPolicyDirty)
        XCTAssertTrue(SettingsDraft.displayedChoices(
            in: snapshot,
            allowDelegation: true
        ).contains(saved))
        XCTAssertFalse(SettingsDraft.selectableChoices(
            in: snapshot,
            allowDelegation: true
        ).contains(saved))

        draft.accessStrategy = "read-only"
        XCTAssertFalse(draft.modelPolicyDirty)
        draft.allowDelegation = false
        XCTAssertTrue(draft.modelPolicyDirty)
    }

    func testSettingsDraftIgnoresRetiredAutomaticDefaultsWithoutDirtyingPolicy() throws {
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            legacyPreferredModel: "gpt-legacy",
            catalogModels: [catalogModel(id: "gpt-legacy", efforts: ["medium", "high"], defaultEffort: "high")]
        )
        let draft = SettingsDraft(snapshot: snapshot)

        XCTAssertFalse(draft.modelPolicyDirty)
    }

    func testSettingsDraftDoesNotInventMissingAutomaticDefault() throws {
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let draft = SettingsDraft(snapshot: snapshot)

        XCTAssertFalse(draft.modelPolicyDirty)
    }

    func testSettingsDraftDeduplicatesCatalogChoices() throws {
        let duplicate = catalogModel(id: "gpt-current", efforts: ["high"])
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [duplicate, duplicate]
        )

        XCTAssertEqual(
            SettingsDraft.selectableChoices(in: snapshot, allowDelegation: true),
            [ModelChoice(model: "gpt-current", reasoningEffort: "high")]
        )
    }

    func testHidingActivityCardAlsoDisablesAutomaticHandoff() throws {
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        var draft = SettingsDraft(snapshot: snapshot)
        draft.completionHandoff = "auto-handoff"

        draft.setActivityCardVisibility("never")

        XCTAssertEqual(draft.activityCardVisibility, "never")
        XCTAssertEqual(draft.completionHandoff, "off")
    }

    func testSettingsRefreshPreservesDirtyDraftUntilExplicitReload() throws {
        let original = try settingsSnapshot(
            policy: [
                "mode": "fixed",
                "selection": choiceObject(
                    ModelChoice(model: "gpt-current", reasoningEffort: "high")
                ),
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let externallyChanged = try settingsSnapshot(
            settingsRevision: 5,
            accessStrategy: "read-only",
            policy: [
                "mode": "fixed",
                "selection": choiceObject(
                    ModelChoice(model: "gpt-current", reasoningEffort: "high")
                ),
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        var state = SettingsDraftSyncState()
        state.synchronize(with: original)
        var edited = try XCTUnwrap(state.draft)
        edited.maxConcurrentJobs = 3
        state.updateDraft(edited)

        state.synchronize(with: externallyChanged)

        XCTAssertEqual(state.draft?.maxConcurrentJobs, 3)
        XCTAssertEqual(state.draft?.accessStrategy, "adaptive")
        XCTAssertEqual(state.draft?.expectedSettingsRevision, 4)
        XCTAssertTrue(state.externalChangeDetected)
        state.synchronize(with: externallyChanged, force: true)
        XCTAssertEqual(state.draft?.accessStrategy, "read-only")
        XCTAssertEqual(state.draft?.maxConcurrentJobs, 2)
        XCTAssertEqual(state.draft?.expectedSettingsRevision, 5)
        XCTAssertFalse(state.externalChangeDetected)
    }

    func testSettingsAutosaveAcknowledgementRebasesNewerEdits() throws {
        let original = try settingsSnapshot(
            policy: [
                "mode": "fixed",
                "selection": choiceObject(
                    ModelChoice(model: "gpt-current", reasoningEffort: "high")
                ),
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let persisted = try settingsSnapshot(
            settingsRevision: 5,
            accessStrategy: "read-only",
            policy: [
                "mode": "fixed",
                "selection": choiceObject(
                    ModelChoice(model: "gpt-current", reasoningEffort: "high")
                ),
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        var state = SettingsDraftSyncState()
        state.synchronize(with: original)
        var submitted = try XCTUnwrap(state.draft)
        submitted.accessStrategy = "read-only"
        state.updateDraft(submitted)
        var newer = submitted
        newer.maxConcurrentJobs = 3
        state.updateDraft(newer)

        state.acknowledgePersisted(snapshot: persisted, submitted: submitted)

        XCTAssertEqual(state.draft?.expectedSettingsRevision, 5)
        XCTAssertEqual(state.draft?.accessStrategy, "read-only")
        XCTAssertEqual(state.draft?.maxConcurrentJobs, 3)
        XCTAssertFalse(state.externalChangeDetected)
    }

    @MainActor
    func testUnchangedSettingsDraftDoesNotEnterAutosaveQueue() throws {
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let model = AppModel()
        model.settings = snapshot

        model.scheduleSettingsAutosave(SettingsDraft(snapshot: snapshot))

        XCTAssertEqual(model.generalSettingsSaveState, .idle)
    }

    @MainActor
    func testDashboardCanEnableCodexThreadPersistenceThroughAutosave() throws {
        let snapshot = try settingsSnapshot(
            showBridgeThreadsInCodexApp: false,
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let model = AppModel()
        model.settings = snapshot

        model.enableCodexThreadPersistence()

        XCTAssertEqual(model.generalSettingsSaveState, .pending)
        model.cancelPendingSettingsAutosave()
    }

    @MainActor
    func testApplicationShutdownStopsWhenPendingSettingsCannotBeSaved() async throws {
        let root = URL(fileURLWithPath:
            "/tmp/cb-save-\(getpid())-\(UUID().uuidString.prefix(8))",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = RuntimePaths(
            environment: [
                "XDG_CONFIG_HOME": root.path,
                "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1",
                "PATH": ProcessInfo.processInfo.environment["PATH"] ?? ""
            ],
            bundle: .main,
            currentDirectory: root
        )
        try FileManager.default.createDirectory(
            at: paths.bridgeSocket.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let listener = try makeTestListener(at: paths.bridgeSocket.path)
        defer {
            Darwin.close(listener)
            unlink(paths.bridgeSocket.path)
        }
        let server = Task.detached {
            try serveSettingsFailureOnce(listener: listener)
        }
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let model = AppModel(
            paths: paths,
            loginItemController: TestLoginItemController(status: .notRegistered)
        )
        model.settings = snapshot
        var edited = SettingsDraft(snapshot: snapshot)
        edited.maxConcurrentJobs = 3
        model.scheduleSettingsAutosave(edited)

        let didShutdown = await model.shutdownApplication(force: true)

        try await server.value
        XCTAssertFalse(didShutdown)
        XCTAssertFalse(model.applicationShutdownCompleted)
        XCTAssertEqual(model.generalSettingsSaveState, .failed)
        XCTAssertNotNil(model.runtimeErrorMessage)
    }

    @MainActor
    func testApplicationShutdownUsesVerifiedHelperPreparation() async throws {
        let root = URL(fileURLWithPath:
            "/tmp/cb-quit-\(getpid())-\(UUID().uuidString.prefix(8))",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = RuntimePaths(
            environment: [
                "XDG_CONFIG_HOME": root.path,
                "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1",
                "PATH": ProcessInfo.processInfo.environment["PATH"] ?? ""
            ],
            bundle: .main,
            currentDirectory: root
        )
        try FileManager.default.createDirectory(
            at: paths.helperSocket.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let listener = try makeTestListener(at: paths.helperSocket.path)
        defer {
            Darwin.close(listener)
            unlink(paths.helperSocket.path)
        }
        let server = Task.detached {
            try serveHelperShutdownOnce(listener: listener)
        }
        let model = AppModel(
            paths: paths,
            loginItemController: TestLoginItemController(status: .notRegistered)
        )

        let didShutdown = await model.shutdownApplication(force: true)
        let method = try await server.value

        XCTAssertTrue(didShutdown)
        XCTAssertTrue(model.applicationShutdownCompleted)
        XCTAssertEqual(method, "helper.prepare-shutdown")
        XCTAssertNil(model.runtimeErrorMessage)
    }

    func testDashboardLinksAcceptOnlyExpectedLocalContractShapes() {
        XCTAssertNotNil(DashboardLink.conversation(
            "https://chatgpt.com/c/00000000-0000-4000-8000-000000000001"
        ))
        XCTAssertNil(DashboardLink.conversation(
            "https://example.com/c/00000000-0000-4000-8000-000000000001"
        ))
        XCTAssertNil(DashboardLink.conversation(
            "https://chatgpt.com:444/c/00000000-0000-4000-8000-000000000001"
        ))
        XCTAssertNil(DashboardLink.conversation(
            "https://chatgpt.com/c/00000000-0000-4000-8000-000000000001/"
        ))
        XCTAssertNotNil(DashboardLink.codexThread(
            "codex://threads/00000000-0000-4000-8000-000000000001"
        ))
        XCTAssertNil(DashboardLink.codexThread("file:///private/secrets"))
    }

    func testNextExecutionComparisonIgnoresPresentationOnlyFields() throws {
        let current = try dashboardExecution(
            model: " GPT-5.6 ",
            displayName: "새 표시 이름",
            effort: "HIGH",
            reroutedModel: nil,
            isCurrent: true
        )
        let historical = try dashboardExecution(
            model: "gpt-5.6",
            displayName: "Old display name",
            effort: "high",
            reroutedModel: nil,
            isCurrent: false
        )
        XCTAssertNil(DashboardExecutionPresentation.next(
            current: current,
            latest: historical
        ))
        let changed = try dashboardExecution(
            model: "gpt-5.6-terra",
            displayName: nil,
            effort: "high",
            reroutedModel: nil,
            isCurrent: true
        )
        XCTAssertNotNil(DashboardExecutionPresentation.next(
            current: changed,
            latest: historical
        ))
        XCTAssertNotNil(DashboardExecutionPresentation.next(
            current: changed,
            latest: nil
        ))
    }

    func testDashboardHistoryDeduplicatesOnlyActivityHeadingsAndKeepsTurnExecution() throws {
        let firstExecution = try dashboardExecution(
            model: "gpt-5.6-sol",
            displayName: "Sol",
            effort: "high",
            reroutedModel: nil,
            isCurrent: false
        )
        let secondExecution = try dashboardExecution(
            model: "gpt-5.6-terra",
            displayName: "Terra",
            effort: "max",
            reroutedModel: nil,
            isCurrent: false
        )
        let latest = try dashboardTurn(
            activityKey: "activity-a",
            activityTitle: "Repeated title",
            execution: firstExecution
        )
        let history = try [
            dashboardTurn(
                activityKey: "activity-a",
                activityTitle: "Repeated title",
                execution: secondExecution
            ),
            dashboardTurn(
                activityKey: "activity-b",
                activityTitle: "Repeated title",
                execution: firstExecution
            ),
            dashboardTurn(
                activityKey: "activity-b",
                activityTitle: "Repeated title",
                execution: nil
            ),
            dashboardTurn(
                activityKey: "activity-c",
                activityTitle: "Different title",
                execution: secondExecution
            )
        ]
        let items = DashboardHistoryPresentation.items(
            history: history,
            latestTurn: latest,
            enclosingActivityKey: "activity-a",
            enclosingActivityTitle: "Repeated title"
        )

        XCTAssertEqual(
            items.map(\.heading),
            [.none, .boundary, .none, .title("Different title")]
        )
        XCTAssertEqual(items[0].turn.execution?.model, "gpt-5.6-terra")
        XCTAssertEqual(items[0].turn.execution?.reasoningEffort, "max")
        XCTAssertEqual(items[1].turn.execution?.model, "gpt-5.6-sol")
        XCTAssertEqual(items[1].turn.execution?.reasoningEffort, "high")
        XCTAssertEqual(
            DashboardExecutionPresentation.turnText(items[0].turn.execution),
            "Terra · 최대"
        )
        XCTAssertEqual(
            DashboardExecutionPresentation.turnText(items[2].turn.execution),
            "모델 · 추론 확인 불가"
        )
    }

    @MainActor
    func testRemoteClientStartsWithoutLocalHelperAndQuitsWithoutRuntimeControl() async throws {
        let profile = remoteProfile(
            id: "11111111-1111-4111-8111-111111111111",
            name: "작업실"
        )
        let preferences = TestConnectionStore(BridgeConnectionPreferences(
            mode: .remoteClient,
            activeServerId: profile.serverId,
            profiles: [profile]
        ))
        let credentials = TestCredentialStore([
            profile.serverId: "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDE"
        ])
        let client = TestRemoteClient(
            profile: profile,
            dashboard: try dashboardStatus(scope: "server-workroom"),
            settings: try settingsSnapshot(
                policy: [
                    "mode": "automatic",
                    "allowedSelections": ["kind": "catalog-visible"],
                    "constraints": ["allowDelegation": true]
                ],
                catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
            )
        )
        let model = AppModel(
            loginItemController: TestLoginItemController(status: .notRegistered),
            connectionStore: preferences,
            credentialStore: credentials,
            remoteClientFactory: { _, _ in
                client.recordFactoryCall()
                return client
            }
        )

        await model.start()

        XCTAssertTrue(model.isRemoteClient)
        XCTAssertNil(model.helperStatus)
        XCTAssertEqual(model.remoteHello?.server.id, profile.serverId)
        XCTAssertEqual(model.dashboard?.scope, "server-workroom")
        XCTAssertNotNil(model.settings)
        XCTAssertTrue(model.bridgeConnected)

        var draft = try SettingsDraft(snapshot: XCTUnwrap(model.settings))
        draft.maxConcurrentJobs += 1
        model.scheduleSettingsAutosave(draft)
        let settingsFlushed = await model.flushSettingsAutosave()
        XCTAssertTrue(settingsFlushed)
        XCTAssertEqual(client.settingsUpdateCallCount, 1)

        XCTAssertNotNil(model.activeRemoteProfile?.lastConnectedAt)
        XCTAssertTrue(model.renameRemoteServer(profile.serverId, name: "이름 변경"))
        await model.refreshAll()
        await model.refreshStatus()
        XCTAssertEqual(client.factoryCallCount, 1)
        XCTAssertEqual(client.closeCallCount, 0)

        let didQuit = await model.shutdownApplication(force: false)
        XCTAssertTrue(didQuit)
        XCTAssertTrue(model.applicationShutdownCompleted)
        XCTAssertEqual(client.runtimeStatusCallCount, 0)
        XCTAssertEqual(client.closeCallCount, 1)
    }

    @MainActor
    func testLateDashboardFromPreviousRemoteServerCannotOverwriteActiveServer() async throws {
        let firstProfile = remoteProfile(
            id: "11111111-1111-4111-8111-111111111111",
            name: "첫 서버"
        )
        let secondProfile = remoteProfile(
            id: "22222222-2222-4222-8222-222222222222",
            name: "둘째 서버"
        )
        let settings = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let first = TestRemoteClient(
            profile: firstProfile,
            dashboard: try dashboardStatus(scope: "server-first"),
            settings: settings,
            dashboardDelayNanoseconds: 250_000_000
        )
        let second = TestRemoteClient(
            profile: secondProfile,
            dashboard: try dashboardStatus(scope: "server-second"),
            settings: settings
        )
        let clients = [firstProfile.serverId: first, secondProfile.serverId: second]
        let model = AppModel(
            loginItemController: TestLoginItemController(status: .notRegistered),
            connectionStore: TestConnectionStore(BridgeConnectionPreferences(
                mode: .remoteClient,
                activeServerId: firstProfile.serverId,
                profiles: [firstProfile, secondProfile]
            )),
            credentialStore: TestCredentialStore([
                firstProfile.serverId: "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDE",
                secondProfile.serverId: "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDF"
            ]),
            remoteClientFactory: { profile, _ in
                let client = clients[profile.serverId]!
                client.recordFactoryCall()
                return client
            }
        )
        await model.refreshStatus()
        let staleRefresh = Task { @MainActor in
            await model.refreshDashboard()
        }
        try await Task.sleep(nanoseconds: 30_000_000)

        let activated = await model.activateRemoteServer(secondProfile.serverId)
        XCTAssertTrue(activated)
        await staleRefresh.value
        try await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertEqual(model.activeRemoteProfile?.serverId, secondProfile.serverId)
        XCTAssertEqual(model.remoteHello?.server.id, secondProfile.serverId)
        XCTAssertEqual(model.dashboard?.scope, "server-second")
        XCTAssertEqual(first.factoryCallCount, 1)
        XCTAssertEqual(first.closeCallCount, 1)
        XCTAssertEqual(second.factoryCallCount, 1)
        XCTAssertEqual(second.closeCallCount, 0)

        let removed = await model.removeRemoteServer(firstProfile.serverId)
        XCTAssertTrue(removed)
        await model.refreshStatus()
        XCTAssertEqual(second.factoryCallCount, 1)
        XCTAssertEqual(second.closeCallCount, 0)
        let didQuit = await model.shutdownApplication(force: false)
        XCTAssertTrue(didQuit)
        XCTAssertEqual(second.closeCallCount, 1)
    }

    @MainActor
    func testRemoteRePairingReplacesCredentialAndRemovingActiveServerClosesItsClient() async throws {
        let profile = remoteProfile(
            id: "55555555-5555-4555-8555-555555555555",
            name: "다시 페어링할 서버"
        )
        let backupProfile = remoteProfile(
            id: "66666666-6666-4666-8666-666666666666",
            name: "다른 서버"
        )
        let settings = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let old = TestRemoteClient(
            profile: profile,
            dashboard: try dashboardStatus(scope: "before-pairing"),
            settings: settings
        )
        let repaired = TestRemoteClient(
            profile: profile,
            dashboard: try dashboardStatus(scope: "after-pairing"),
            settings: settings
        )
        let backup = TestRemoteClient(
            profile: backupProfile,
            dashboard: try dashboardStatus(scope: "backup-server"),
            settings: settings
        )
        let clients = ["old-credential": old, "new-credential": repaired, "backup-credential": backup]
        let credentials = TestCredentialStore([
            profile.serverId: "old-credential",
            backupProfile.serverId: "backup-credential"
        ])
        let model = AppModel(
            loginItemController: TestLoginItemController(status: .notRegistered),
            connectionStore: TestConnectionStore(BridgeConnectionPreferences(
                mode: .remoteClient,
                activeServerId: profile.serverId,
                profiles: [backupProfile, profile]
            )),
            credentialStore: credentials,
            remoteClientFactory: { _, credential in
                let client = clients[credential]!
                client.recordFactoryCall()
                return client
            },
            remotePairingFactory: { _, _, _ in
                RemotePairingResult(profile: profile, credential: "new-credential")
            }
        )
        await model.refreshAll()
        XCTAssertEqual(model.dashboard?.scope, "before-pairing")

        let paired = await model.pairRemoteServer(
            invitation: "fresh-invitation", profileName: "서버", deviceName: "Mac"
        )
        XCTAssertTrue(paired)
        XCTAssertEqual(model.dashboard?.scope, "after-pairing")
        XCTAssertEqual(try credentials.credential(for: profile.serverId), "new-credential")
        XCTAssertEqual(old.factoryCallCount, 1)
        XCTAssertEqual(old.closeCallCount, 1)
        XCTAssertEqual(repaired.factoryCallCount, 1)
        XCTAssertEqual(repaired.closeCallCount, 0)

        let removed = await model.removeRemoteServer(profile.serverId)
        XCTAssertTrue(removed)
        XCTAssertNil(try credentials.credential(for: profile.serverId))
        XCTAssertEqual(model.activeRemoteProfile?.serverId, backupProfile.serverId)
        XCTAssertEqual(model.dashboard?.scope, "backup-server")
        XCTAssertEqual(repaired.closeCallCount, 1)
        XCTAssertEqual(backup.factoryCallCount, 1)
        let didQuit = await model.shutdownApplication(force: false)
        XCTAssertTrue(didQuit)
        XCTAssertEqual(backup.closeCallCount, 1)
    }

    @MainActor
    func testRemoteClientRecoversAfterTemporaryConnectionFailure() async throws {
        let profile = remoteProfile(
            id: "33333333-3333-4333-8333-333333333333",
            name: "복구 서버"
        )
        let client = TestRemoteClient(
            profile: profile,
            dashboard: try dashboardStatus(scope: "server-recovered"),
            settings: try settingsSnapshot(
                policy: [
                    "mode": "automatic",
                    "allowedSelections": ["kind": "catalog-visible"],
                    "constraints": ["allowDelegation": true]
                ],
                catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
            ),
            helloFailures: 1
        )
        let model = AppModel(
            loginItemController: TestLoginItemController(status: .notRegistered),
            connectionStore: TestConnectionStore(BridgeConnectionPreferences(
                mode: .remoteClient,
                activeServerId: profile.serverId,
                profiles: [profile]
            )),
            credentialStore: TestCredentialStore([
                profile.serverId: "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDE"
            ]),
            remoteClientFactory: { _, _ in client }
        )

        await model.refreshAll()
        XCTAssertFalse(model.bridgeConnected)
        XCTAssertNil(model.dashboard)
        XCTAssertNotNil(model.connectionErrorMessage)

        await model.refreshAll()
        XCTAssertTrue(model.bridgeConnected)
        XCTAssertEqual(model.dashboard?.scope, "server-recovered")
        XCTAssertNotNil(model.settings)
        XCTAssertNil(model.connectionErrorMessage)
    }

    @MainActor
    func testPairingWhileHostingRegistersServerBeforeModeSwitch() async throws {
        let profile = remoteProfile(
            id: "44444444-4444-4444-8444-444444444444",
            name: "등록할 서버"
        )
        let preferences = TestConnectionStore(BridgeConnectionPreferences())
        let credentials = TestCredentialStore()
        let credential = "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDE"
        let model = AppModel(
            loginItemController: TestLoginItemController(status: .notRegistered),
            connectionStore: preferences,
            credentialStore: credentials,
            remotePairingFactory: { invitation, deviceName, profileName in
                XCTAssertEqual(invitation, "pairing-invitation")
                XCTAssertEqual(deviceName, "거실 Mac")
                XCTAssertEqual(profileName, "내 서버")
                return RemotePairingResult(profile: profile, credential: credential)
            }
        )

        let paired = await model.pairRemoteServer(
            invitation: "pairing-invitation",
            profileName: "내 서버",
            deviceName: "거실 Mac"
        )

        XCTAssertTrue(paired)
        XCTAssertFalse(model.isRemoteClient)
        XCTAssertEqual(preferences.value.mode, .localHost)
        XCTAssertEqual(model.activeRemoteProfile?.serverId, profile.serverId)
        XCTAssertEqual(try credentials.credential(for: profile.serverId), credential)
        XCTAssertTrue(model.prepareRemoteServerForModeSwitch(profile.serverId))
        XCTAssertFalse(model.isRemoteClient)
    }
}

@MainActor
private final class TestConnectionStore: BridgeConnectionPreferencesStoring {
    private(set) var value: BridgeConnectionPreferences

    init(_ value: BridgeConnectionPreferences) {
        self.value = value
    }

    func load() -> BridgeConnectionPreferences { value }
    func save(_ preferences: BridgeConnectionPreferences) throws { value = preferences }
}

private final class TestCredentialStore: RemoteCredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String]

    init(_ values: [String: String] = [:]) {
        self.values = values
    }

    func credential(for serverId: String) throws -> String? {
        lock.withLock { values[serverId] }
    }

    func saveCredential(_ credential: String, for serverId: String) throws {
        lock.withLock { values[serverId] = credential }
    }

    func deleteCredential(for serverId: String) throws {
        lock.withLock { _ = values.removeValue(forKey: serverId) }
    }
}

private final class TestRemoteClient: RemoteBridgeApplicationClient, @unchecked Sendable {
    private let helloValue: RemoteCompanionHello
    private let dashboardValue: DashboardSnapshot
    private let settingsValue: SettingsSnapshot
    private let dashboardDelayNanoseconds: UInt64
    private let lock = NSLock()
    private var runtimeCalls = 0
    private var settingsUpdateCalls = 0
    private var factoryCalls = 0
    private var closeCalls = 0
    private var remainingHelloFailures: Int

    init(
        profile: RemoteServerProfile,
        dashboard: DashboardSnapshot,
        settings: SettingsSnapshot,
        dashboardDelayNanoseconds: UInt64 = 0,
        helloFailures: Int = 0
    ) {
        helloValue = RemoteCompanionHello(
            protocol: RemoteServerProtocolInfo(
                name: remoteCompanionProtocolName,
                version: remoteCompanionProtocolVersion
            ),
            server: RemoteServerIdentity(
                id: profile.serverId,
                displayName: profile.serverDisplayName,
                certificateSha256: profile.certificateSha256
            ),
            bridge: CompanionBridgeInfo(
                name: "codex-mcp-bridge",
                title: "Codex MCP Bridge",
                version: profile.bridgeVersion,
                buildId: profile.bridgeBuildId
            ),
            capabilities: profile.capabilities
        )
        dashboardValue = dashboard
        settingsValue = settings
        self.dashboardDelayNanoseconds = dashboardDelayNanoseconds
        remainingHelloFailures = helloFailures
    }

    var runtimeStatusCallCount: Int { lock.withLock { runtimeCalls } }
    var settingsUpdateCallCount: Int { lock.withLock { settingsUpdateCalls } }
    var factoryCallCount: Int { lock.withLock { factoryCalls } }
    var closeCallCount: Int { lock.withLock { closeCalls } }

    func recordFactoryCall() {
        lock.withLock { factoryCalls += 1 }
    }

    func close() {
        lock.withLock { closeCalls += 1 }
    }

    func hello() async throws -> RemoteCompanionHello {
        let shouldFail = lock.withLock {
            guard remainingHelloFailures > 0 else { return false }
            remainingHelloFailures -= 1
            return true
        }
        if shouldFail { throw RemoteCompanionError.unauthorized }
        return helloValue
    }

    func dashboard(
        limit: Int,
        terminalOffset: Int,
        idleOffset: Int,
        enrich: Bool
    ) async throws -> DashboardSnapshot {
        if dashboardDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: dashboardDelayNanoseconds)
        }
        return dashboardValue
    }

    func settings(refreshModels: Bool, locale: String) async throws -> SettingsSnapshot {
        settingsValue
    }

    func updateSettings(_ mutation: SettingsMutation) async throws -> SettingsSnapshot {
        lock.withLock { settingsUpdateCalls += 1 }
        return settingsValue
    }

    func runtimeStatus(inspectBackgroundProcesses: Bool) async throws -> RuntimeAdmissionSnapshot {
        lock.withLock { runtimeCalls += 1 }
        return RuntimeAdmissionSnapshot(
            acceptingNewJobs: true,
            activeJobs: 0,
            pendingAdmissions: 0,
            backgroundProcessState: "confirmed",
            backgroundProcesses: 0,
            backgroundProcessAgents: 0,
            backgroundProcessUnknownAgents: 0
        )
    }
}

private func remoteProfile(id: String, name: String) -> RemoteServerProfile {
    RemoteServerProfile(
        serverId: id,
        name: name,
        endpoint: "https://example.invalid:8766",
        certificateSha256: String(repeating: "a", count: 64),
        serverDisplayName: name,
        bridgeVersion: "0.3.0",
        bridgeBuildId: "test-build",
        capabilities: ["dashboard.read", "settings.read", "settings.write", "runtime.read"],
        lastConnectedAt: nil
    )
}

@MainActor
private final class TestLoginItemController: LoginItemControlling {
    var status: MenuBarLoginItemStatus
    var registrationError: Error?
    var unregistrationError: Error?
    private(set) var registerCalls = 0
    private(set) var unregisterCalls = 0
    private(set) var openSystemSettingsCalls = 0

    init(status: MenuBarLoginItemStatus) {
        self.status = status
    }

    func register() throws {
        registerCalls += 1
        if let registrationError { throw registrationError }
        status = .enabled
    }

    func unregister() throws {
        unregisterCalls += 1
        if let unregistrationError { throw unregistrationError }
        status = .notRegistered
    }

    func openSystemSettings() {
        openSystemSettingsCalls += 1
    }
}

private enum TestLoginItemError: LocalizedError {
    case denied

    var errorDescription: String? {
        "승인되지 않음"
    }
}

private final class TestDashboardReplySequence: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [NativeFixtureReply]
    init(_ replies: [NativeFixtureReply]) { self.replies = replies }
    func next() -> NativeFixtureReply {
        lock.withLock {
            replies.isEmpty ? NativeFixtureReply(body: #"{"error":{"code":-32603,"message":"unexpected request"}}"#) : replies.removeFirst()
        }
    }
}

private func helperStatus(
    phase: String = "running",
    bridgeConnected: Bool = true,
    tunnelConnected: Bool = true,
    configurationValid: Bool = true
) throws -> HelperStatus {
    let json = #"""
    {
      "kind":"helper-status","generatedAt":"2026-09-03T00:00:00.000Z",
      "phase":"\#(phase)","pid":42,"startedAt":null,"lastExit":null,"lastError":null,
      "restartAttempt":0,
      "configuration":{"path":"/private/.env","exists":true,"valid":\#(configurationValid),"hasApiKey":true,"hasTunnelId":true,"tunnelId":"tunnel_native123","issue":null},
      "bridge":{"socketPath":"/private/bridge.sock","connected":\#(bridgeConnected),"acceptingNewJobs":true,"activeJobs":0,"pendingAdmissions":0,"backgroundProcessState":"confirmed","backgroundProcesses":0,"backgroundProcessAgents":0,"backgroundProcessUnknownAgents":0},
      "tunnel":{"phase":"connected","profile":"managed","transport":"stdio","doctorPassed":true,"processRunning":true,"connected":\#(tunnelConnected),"lastCheckedAt":null,"lastError":null}
    }
    """#.data(using: .utf8)!
    return try JSONDecoder().decode(HelperStatus.self, from: json)
}

private func loginStatus(installed: Bool, authenticated: Bool) throws -> CodexLoginStatus {
    let data = try JSONSerialization.data(withJSONObject: [
        "installed": installed,
        "authenticated": authenticated,
        "summary": authenticated ? "ready" : "login required"
    ])
    return try JSONDecoder().decode(CodexLoginStatus.self, from: data)
}

private func dashboardStatus(
    runtimeUnknownAgents: Int = 0,
    scope: String = "bridge-wide"
) throws -> DashboardSnapshot {
    let counts: [String: Any] = [
        "trackedProjects": 0,
        "trackedConversations": 0,
        "retainedJobs": 0,
        "active": 0,
        "running": 0,
        "inputRequired": 0,
        "approvalRequired": 0,
        "terminating": 0,
        "needsAttention": 0,
        "backgroundProcesses": 0,
        "backgroundProcessAgents": 0,
        "runtimeUnknownAgents": runtimeUnknownAgents,
        "runtimeProbeSkippedAgents": 0,
        "completed": 0,
        "failed": 0,
        "interrupted": 0,
        "cancelled": 0,
        "idleAgents": 0,
        "orphanedAgents": 0
    ]
    let page: [String: Any] = [
        "offset": 0,
        "limit": 12,
        "returned": 0,
        "total": 0,
        "returnedConversations": 0,
        "conversationTotal": 0,
        "hasPrevious": false,
        "hasNext": false
    ]
    let data = try JSONSerialization.data(withJSONObject: [
        "kind": "dashboard",
        "generatedAt": "2026-09-03T00:00:00.000Z",
        "scope": scope,
        "statusSource": "codex-runtime-only",
        "coverage": "complete",
        "counts": counts,
        "activeRows": [],
        "terminalRows": [],
        "idleRows": [],
        "pagination": ["active": page, "terminal": page, "idle": page],
        "uiLocalePreference": "auto"
    ])
    return try JSONDecoder().decode(DashboardSnapshot.self, from: data)
}

private func settingsSnapshot(
    settingsRevision: Int = 4,
    accessStrategy: String = "adaptive",
    showBridgeThreadsInCodexApp: Bool = true,
    policy: [String: Any],
    legacyPreferredModel: String? = nil,
    catalogModels: [[String: Any]],
    operatorCeiling: [ModelChoice]? = nil
) throws -> SettingsSnapshot {
    var settings: [String: Any] = [
        "schemaVersion": 1,
        "settingsRevision": settingsRevision,
        "registryRevision": 2,
        "revision": settingsRevision,
        "accessStrategy": accessStrategy,
        "modelPolicy": policy,
        "usePriorityServiceTier": false,
        "projects": [],
        "uiLocalePreference": "auto",
        "maxConcurrentJobs": 2,
        "showBridgeThreadsInCodexApp": showBridgeThreadsInCodexApp,
        "activityCardVisibility": "always",
        "completionHandoff": "off"
    ]
    if let legacyPreferredModel {
        settings["legacyPreferredModel"] = legacyPreferredModel
    }
    var capabilities: [String: Any] = [
        "availableAccessStrategies": ["read-only", "adaptive"],
        "availableUiLocalePreferences": ["auto", "ko", "en"],
        "availableActivityCardVisibilities": ["always", "background-only", "never"],
        "availableCompletionHandoffs": ["off", "auto-handoff"],
        "projectAvailability": [],
        "maxConcurrentJobs": 4,
        "defaultBackend": "mcp-server",
        "allowWorkspaceWrite": true,
        "allowDangerFullAccess": false,
        "persistent": true
    ]
    if let operatorCeiling {
        capabilities["operatorModelCeiling"] = operatorCeiling.map(choiceObject)
    }
    let object: [String: Any] = [
        "settings": settings,
        "operatorDefaults": settings,
        "capabilities": capabilities,
        "catalog": [
            "cached": false,
            "stale": false,
            "lastKnownGood": false,
            "validation": "valid",
            "translationCoverage": ["missingEffortIds": []],
            "models": catalogModels
        ],
        "warnings": [],
        "scopeNotice": "test",
        "policyActivation": [
            "policyRevision": settingsRevision,
            "executionPolicyActive": true,
            "descriptorProjectionUpdated": false,
            "developerModeRefreshRequired": false
        ]
    ]
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(SettingsSnapshot.self, from: data)
}

private func choiceObject(_ choice: ModelChoice) -> [String: Any] {
    ["model": choice.model, "reasoningEffort": choice.reasoningEffort]
}

private func catalogModel(
    id: String,
    efforts: [String],
    defaultEffort: String? = nil
) -> [String: Any] {
    var model: [String: Any] = [
        "id": id,
        "displayName": id,
        "supportedReasoningEfforts": efforts.map { ["effort": $0] },
        "serviceTiers": [],
        "inputModalities": ["text"]
    ]
    if let defaultEffort { model["defaultReasoningEffort"] = defaultEffort }
    return model
}

private func dashboardExecution(
    model: String,
    displayName: String?,
    effort: String,
    reroutedModel: String?,
    isCurrent: Bool
) throws -> DashboardExecution {
    var object: [String: Any] = [
        "model": model,
        "reasoningEffort": effort,
        "isCurrent": isCurrent
    ]
    if let displayName { object["modelDisplayName"] = displayName }
    if let reroutedModel { object["reroutedModel"] = reroutedModel }
    return try JSONDecoder().decode(
        DashboardExecution.self,
        from: JSONSerialization.data(withJSONObject: object)
    )
}

private func dashboardTurn(
    activityKey: String?,
    activityTitle: String?,
    execution: DashboardExecution?
) throws -> DashboardTurn {
    var turn: [String: Any] = [
        "status": "completed",
        "updatedAt": "2026-09-03T00:01:00.000Z",
        "endedAt": "2026-09-03T00:01:00.000Z",
        "durationMs": 60_000
    ]
    if let activityKey { turn["activityKey"] = activityKey }
    if let activityTitle { turn["activityTitle"] = activityTitle }
    if let execution {
        turn["execution"] = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(execution)
        )
    }
    return try JSONDecoder().decode(
        DashboardTurn.self,
        from: JSONSerialization.data(withJSONObject: turn)
    )
}

private func makeTestListener(at socketPath: String) throws -> Int32 {
    unlink(socketPath)
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw POSIXError(.EIO) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8)
    guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
        Darwin.close(descriptor)
        throw POSIXError(.ENAMETOOLONG)
    }
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        destination.initializeMemory(as: UInt8.self, repeating: 0)
        destination.copyBytes(from: pathBytes)
    }
    let length = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count + 1)
    let bound = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(descriptor, $0, length)
        }
    }
    guard bound == 0, Darwin.listen(descriptor, 1) == 0 else {
        Darwin.close(descriptor)
        throw POSIXError(.EADDRINUSE)
    }
    return descriptor
}

private func serveHelperShutdownOnce(listener: Int32) throws -> String {
    let connection = Darwin.accept(listener, nil, nil)
    guard connection >= 0 else { throw POSIXError(.ECONNABORTED) }
    defer { Darwin.close(connection) }
    var buffer = [UInt8](repeating: 0, count: 16 * 1_024)
    let count = Darwin.read(connection, &buffer, buffer.count)
    guard count > 0,
          let request = try JSONSerialization.jsonObject(
            with: Data(buffer.prefix(count))
          ) as? [String: Any],
          let requestID = request["id"] as? String,
          let method = request["method"] as? String else {
        throw POSIXError(.EIO)
    }
    let response = try JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0",
        "id": requestID,
        "result": [
            "kind": "helper-status",
            "generatedAt": "2026-09-03T00:00:00.000Z",
            "phase": "stopped",
            "pid": NSNull(),
            "startedAt": NSNull(),
            "lastExit": NSNull(),
            "lastError": NSNull(),
            "restartAttempt": 0,
            "configuration": [
                "path": "/private/.env",
                "exists": true,
                "valid": true,
                "hasApiKey": true,
                "hasTunnelId": true,
                "tunnelId": "tunnel_native123",
                "issue": NSNull()
            ],
            "bridge": [
                "socketPath": "/private/bridge.sock",
                "connected": false,
                "acceptingNewJobs": NSNull(),
                "activeJobs": NSNull(),
                "pendingAdmissions": NSNull(),
                "backgroundProcessState": NSNull(),
                "backgroundProcesses": NSNull(),
                "backgroundProcessAgents": NSNull(),
                "backgroundProcessUnknownAgents": NSNull()
            ],
            "tunnel": [
                "phase": "stopped",
                "profile": NSNull(),
                "transport": NSNull(),
                "doctorPassed": false,
                "processRunning": false,
                "connected": false,
                "lastCheckedAt": NSNull(),
                "lastError": NSNull()
            ]
        ]
    ]) + Data([0x0A])
    try writeTestResponse(response, to: connection)
    return method
}

private func serveSettingsFailureOnce(listener: Int32) throws {
    let connection = Darwin.accept(listener, nil, nil)
    guard connection >= 0 else { throw POSIXError(.ECONNABORTED) }
    defer { Darwin.close(connection) }
    var buffer = [UInt8](repeating: 0, count: 16 * 1_024)
    let count = Darwin.read(connection, &buffer, buffer.count)
    guard count > 0,
          let request = try JSONSerialization.jsonObject(
            with: Data(buffer.prefix(count))
          ) as? [String: Any],
          let requestID = request["id"] as? String else {
        throw POSIXError(.EIO)
    }
    let response = try JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0",
        "id": requestID,
        "error": ["code": -32602, "message": "settings save failed"]
    ]) + Data([0x0A])
    try writeTestResponse(response, to: connection)
}

private func writeTestResponse(_ response: Data, to connection: Int32) throws {
    try response.withUnsafeBytes { bytes in
        guard let base = bytes.baseAddress else { return }
        var sent = 0
        while sent < bytes.count {
            let written = Darwin.write(connection, base.advanced(by: sent), bytes.count - sent)
            guard written > 0 else { throw POSIXError(.EPIPE) }
            sent += written
        }
    }
}

private final class TestLifecycleNoticeState: @unchecked Sendable {
    let changed = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var status: String
    private var revision = 0
    init(status: String) { self.status = status }
    func setStatus(_ value: String) { lock.withLock { status = value } }
    func reply(_ method: String) -> NativeFixtureReply {
        if method == "helper.health" {
            return NativeFixtureReply(body: lock.withLock { "{\"result\":\(status)}" })
        }
        if method == "changes.wait" {
            let current = lock.withLock { () -> Int in revision += 1; return revision }
            if current > 1 { _ = changed.wait(timeout: .now() + 2) }
            return NativeFixtureReply(body: "{\"result\":{\"revision\":\"test:\(current)\",\"topics\":[\"runtime\"]}}")
        }
        return NativeFixtureReply(body: "{\"error\":{\"code\":-32601,\"message\":\"unsupported\"}}")
    }
}

private final class TestTrailingReadState: @unchecked Sendable {
    private let lock = NSLock()
    private var authReads = 0
    func reply(_ method: String) -> NativeFixtureReply {
        if method == "auth.status" {
            let authenticated = lock.withLock { () -> Bool in authReads += 1; return authReads > 1 }
            return NativeFixtureReply(body: "{\"result\":{\"installed\":true,\"authenticated\":\(authenticated),\"summary\":\"test\"}}", delay: 0.2)
        }
        return NativeFixtureReply(body: "{\"error\":{\"code\":-32601,\"message\":\"unsupported\"}}", delay: method == "codex.runtime" ? 0.2 : 0)
    }
}
