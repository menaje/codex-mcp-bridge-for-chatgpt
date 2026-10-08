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
            pendingInteractions: Int = 0,
            memoryOnlyThreads: Int = 0,
            protectedMemoryOnlyThreads: Int? = nil,
            discardableMemoryOnlyThreads: Int? = nil,
            backgroundProcessState: String = "confirmed",
            backgroundProcesses: Int = 0,
            backgroundProcessUnknownAgents: Int = 0
        ) -> RuntimeAdmissionSnapshot {
            RuntimeAdmissionSnapshot(
                acceptingNewJobs: true,
                activeJobs: activeJobs,
                pendingAdmissions: pendingAdmissions,
                pendingInteractions: pendingInteractions,
                memoryOnlyThreads: memoryOnlyThreads,
                protectedMemoryOnlyThreads: protectedMemoryOnlyThreads,
                discardableMemoryOnlyThreads: discardableMemoryOnlyThreads,
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
            for: impact(pendingInteractions: 1),
            refreshFailed: false
        ))
        XCTAssertTrue(ApplicationQuitConfirmationPolicy.requiresConfirmation(
            for: impact(memoryOnlyThreads: 1),
            refreshFailed: false
        ))
        let completedMemoryOnly = impact(
            memoryOnlyThreads: 2,
            protectedMemoryOnlyThreads: 0,
            discardableMemoryOnlyThreads: 2
        )
        XCTAssertTrue(ApplicationQuitConfirmationPolicy.requiresConfirmation(
            for: completedMemoryOnly,
            refreshFailed: false
        ))
        XCTAssertEqual(
            ApplicationQuitConfirmationPolicy.protectedMemoryOnlyThreadCount(
                for: completedMemoryOnly
            ),
            0
        )
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

    func testNativeSemanticKeyFallsBackToEnglishInsteadOfDisplayingItsIdentifier() {
        let value = BridgeAppLocalization.string(
            "settings.codexAppThreads",
            locale: Locale(identifier: "unsupported")
        )
        XCTAssertEqual(value, "Show bridge threads in the Codex app")
        XCTAssertNotEqual(value, "settings.codexAppThreads")
    }

    func testReasoningEffortLabelsUseCanonicalLowercaseValuesInEveryLocale() {
        for language in BridgeAppLocalization.supportedLanguageCodes {
            let locale = BridgeAppLocalization.locale(for: language)
            XCTAssertEqual(
                BridgeAppLocalization.reasoningEffortLabel("  XHIGH  ", fallback: "번역값", locale: locale),
                "xhigh"
            )
            XCTAssertEqual(
                BridgeAppLocalization.reasoningEffortLabel("", fallback: "  NOVEL  ", locale: locale),
                "novel"
            )
        }
    }

    func testNativeLocalizationNormalizesRegionalLocales() {
        let cases = [
            "en-GB": "en",
            "ko-KR": "ko",
            "ja-JP": "ja",
            "zh-CN": "zh-Hans",
            "zh-SG": "zh-Hans",
            "zh-Hans-CN": "zh-Hans",
            "zh-Hant-TW": "zh-Hant",
            "zh-Hant-HK": "zh-Hant",
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
            "The Secure MCP Tunnel process is not running."
        )
        XCTAssertEqual(
            BridgeAppLocalization.statusProblemDescription(
                problem: nil,
            diagnosticMessage: "Unexpected English helper diagnostic.",
            context: .helper,
            locale: Locale(identifier: "ko")
            ),
            "The request could not be completed. Check the diagnostic logs for details."
        )
        XCTAssertEqual(
            BridgeAppLocalization.statusProblemDescription(
                problem: BridgeStatusProblem(code: "runtime-env-owner-mismatch"),
            diagnosticMessage: nil,
            context: .runtimeConfiguration,
            locale: Locale(identifier: "ko")
            ),
            "The connection file or folder is not owned by the current user."
        )
        XCTAssertEqual(
            BridgeAppLocalization.statusProblemDescription(
                problem: BridgeStatusProblem(code: "codex-requested-state-invalid"),
                diagnosticMessage: nil,
                context: .runtimeConfiguration,
                locale: Locale(identifier: "ko")
            ),
            "Settings could not be loaded."
        )
    }

    func testNativeProjectConflictsExplainRecoveryWithoutExposingDiagnostics() {
        let locale = Locale(identifier: "ko")
        let messages = [
            ("PROJECT_CWD_CONFLICT", "settings.projectDuplicatePath"),
            ("PROJECT_CWD_STILL_PINNED", "settings.projectCwdStillPinned"),
            ("PROJECT_DELETE_STILL_PINNED", "settings.projectDeleteStillPinned")
        ].map { code, key in
            let message = BridgeAppLocalization.errorDescription(
                LocalRPCError.remote(code: -32000, message: "\(code): /private/project diagnostics"),
                locale: locale
            )
            XCTAssertEqual(message, BridgeAppLocalization.string(key, locale: locale))
            XCTAssertFalse(message.contains(code))
            XCTAssertFalse(message.contains("/private/project"))
            return message
        }
        XCTAssertEqual(Set(messages).count, 3)
    }

    func testNativeLocalizationDoesNotExposeBridgeSkillDiagnostics() {
        let locale = Locale(identifier: "ko")
        XCTAssertEqual(
            BridgeAppLocalization.errorDescription(
                LocalRPCError.remote(
                    code: -32000,
                    message: "SKILL_VERSION_CHANGED: Read the current bridge skill and retry."
                ),
                locale: locale
            ),
            "The skill was changed elsewhere. Load the latest version and try again."
        )
        XCTAssertEqual(
            BridgeAppLocalization.errorDescription(
                LocalRPCError.remote(
                    code: -32000,
                    message: "SKILL_PACKAGE_ENCRYPTED: Encrypted ZIP entries are not accepted."
                ),
                locale: locale
            ),
            "Encrypted ZIP packages cannot be imported."
        )
        XCTAssertEqual(
            BridgeAppLocalization.errorDescription(
                LocalRPCError.remote(code: -32000, message: "SKILL_FUTURE_FAILURE: raw English"),
                locale: locale
            ),
            "The skill request could not be completed. Check the input and connection, then try again."
        )
    }

    func testNativeRPCDiagnosticsAreNotLocalizationKeys() {
        for code in BridgeAppLocalization.supportedLanguageCodes {
            let locale = Locale(identifier: code)
            let message = BridgeAppLocalization.errorDescription(
                LocalRPCError.remote(code: -32000, message: "UNCATALOGUED_FAILURE: private diagnostic"),
                locale: locale
            )
            XCTAssertEqual(message, BridgeAppLocalization.string(
                "macos.therequestcouldnotbecompletedcheckthe", locale: locale
            ))
            XCTAssertFalse(message.contains(BridgeGeneratedLocalization.unavailableFallback))
            XCTAssertFalse(message.contains("private diagnostic"))

            let key = "macos.couldnotconnecttothelocalservice"
            let template = BridgeGeneratedLocalization.defaultStrings[key]!
            let wrapped = BridgeAppLocalization.errorDescription(
                LocalRPCError.remote(
                    code: -32000,
                    message: String(format: template, "UNCATALOGUED_FAILURE: private diagnostic")
                ),
                locale: locale
            )
            XCTAssertEqual(wrapped, BridgeAppLocalization.format(key, locale: locale, message))
            XCTAssertFalse(wrapped.contains("private diagnostic"))
        }
    }

    func testNativeLocalSocketFailuresExplainTheirCause() {
        let categories: [(Int32, String)] = [
            (EAGAIN, "macos.localService.responseTimedOut"),
            (ETIMEDOUT, "macos.localService.responseTimedOut"),
            (ENOENT, "macos.localService.unavailable"),
            (ECONNREFUSED, "macos.localService.unavailable"),
            (EACCES, "macos.localService.permissionDenied")
        ]
        for code in BridgeAppLocalization.supportedLanguageCodes {
            let locale = Locale(identifier: code)
            for (errorNumber, key) in categories {
                let reason = String(cString: strerror(errorNumber))
                for error in [LocalRPCError.connectionFailed(reason), .writeFailed(reason)] {
                    let message = BridgeAppLocalization.errorDescription(error, locale: locale)
                    XCTAssertEqual(message, BridgeAppLocalization.string(key, locale: locale))
                    XCTAssertFalse(message.contains(BridgeGeneratedLocalization.unavailableFallback))
                }
            }
        }
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
        XCTAssertFalse(window.styleMask.contains(.fullSizeContentView))
        XCTAssertFalse(window.titlebarAppearsTransparent)
        XCTAssertEqual(window.titleVisibility, .visible)
        XCTAssertEqual(window.backgroundColor, .windowBackgroundColor)
        XCTAssertTrue(window.hasShadow)
        XCTAssertFalse(window.isMovableByWindowBackground)
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
    func testTimedOutBridgeObservationRetainsLastDashboardAsUnconfirmed() async throws {
        let model = AppModel()
        let start = Date(timeIntervalSince1970: 100)
        model.recordLocalConnectionStatus(try helperStatus(), at: start)
        model.dashboard = try dashboardStatus(scope: "retained-timeout-dashboard")
        model.settings = try settingsSnapshot(
            policy: ["mode": "automatic", "allowedSelections": ["kind": "catalog-visible"],
                     "constraints": ["allowDelegation": true]],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let timedOut = try helperStatus(
            bridgeConnected: false,
            bridgeObservation: "timed-out",
            bridgeLastSuccessfulAt: "2026-09-21T00:00:00.000Z"
        )

        model.recordLocalConnectionStatus(timedOut, at: start.addingTimeInterval(1))
        XCTAssertFalse(model.bridgeConnected)
        XCTAssertTrue(model.hasRetainedBridgeObservation)
        XCTAssertEqual(model.health, .checking)

        model.recordLocalConnectionStatus(timedOut, at: start.addingTimeInterval(9))
        XCTAssertEqual(model.health, .attention)
        XCTAssertEqual(model.operationalObservation, .problem(.responseUnconfirmed))
        XCTAssertFalse(model.runtimeUnavailableExplanation.contains("중지되었습니다"))
        await model.refreshDashboard()
        XCTAssertEqual(model.dashboard?.scope, "retained-timeout-dashboard")
        await model.refreshSettings()
        XCTAssertEqual(model.settings?.settings.settingsRevision, 4)
    }

    @MainActor
    func testIssue242RepeatedDashboardAndHelperMethodCounts() async throws {
        let path = "/tmp/cb-242-reads-\(UUID().uuidString.prefix(8)).sock"
        let helperBody = String(decoding: try JSONEncoder().encode(helperStatus()), as: UTF8.self)
        let dashboardBody = String(decoding: try JSONEncoder().encode(dashboardStatus()), as: UTF8.self)
        let server = try NativeRPCFixture(path: path) { method in
            NativeFixtureReply(body: "{\"result\":\(method == "helper.health" ? helperBody : dashboardBody)}")
        }
        defer { server.stop() }
        let rpc = UnixSocketRPCClient(socketPath: path)
        for _ in 0..<10 {
            let _: HelperStatus = try await rpc.call("helper.health", params: EmptyParameters())
            let _: DashboardSnapshot = try await rpc.call("dashboard.snapshot", params: EmptyParameters())
        }
        XCTAssertEqual(server.count("helper.health"), 10)
        XCTAssertEqual(server.count("dashboard.snapshot"), 10)
        XCTAssertEqual(server.count("completion.claim"), 0)
    }

    @MainActor
    func testW3ProgressDoesNotClaimAndReadyDrainsTwentyFiveInDebouncedBatches() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-w3-model-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let outbox = W3NativeOutboxFixture()
        let server = try NativeRPCFixture(path: paths.bridgeSocket.path, requestReply: { method, input in outbox.reply(method, input) })
        let delivery = W3CompletionDeliveryFixture()
        let model = AppModel(paths: paths, completionNotifications: CompletionNotifications(delivery: delivery))
        defer { model.cancelAllPolling(); server.stop(); try? FileManager.default.removeItem(at: root) }
        func notice(_ version: Int, ready: Bool = false) throws -> ChangeNotice {
            let body: [String: Any] = ["revision": "epoch:\(version)",
                "supportedTopics": ["completion-outbox-ready"],
                "topics": ready ? ["completion-outbox-ready"] : ["dashboard", "settings"],
                "topicRevisions": ready ? ["completion-outbox-ready": "epoch:\(version)"] : [:]]
            return try JSONDecoder().decode(ChangeNotice.self, from: JSONSerialization.data(withJSONObject: body))
        }
        model.recordLocalConnectionStatus(try helperStatus())
        model.recordCompletionChangeNotice(try notice(0))
        for _ in 0..<200 {
            if server.count("completion.availability") > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertGreaterThan(server.count("completion.availability"), 0)
        try await Task.sleep(for: .milliseconds(100))
        let initialReads = server.count("completion.availability")
        for i in 1...400 { model.recordCompletionChangeNotice(try notice(i)) }
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(server.count("completion.availability"), initialReads)
        XCTAssertEqual(server.count("completion.claim"), 0)
        outbox.enqueue(25)
        model.recordCompletionChangeNotice(try notice(401, ready: true))
        for _ in 0..<200 {
            if delivery.ids.count == 25 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(delivery.ids.count, 25)
        XCTAssertEqual(outbox.batchSizes, [10, 10, 5])
        XCTAssertEqual(server.count("completion.claim"), 3)
        XCTAssertEqual(server.count("completion.delivered"), 3)
        for _ in 0..<20 { model.recordCompletionChangeNotice(try notice(401, ready: true)) }
        model.recordCompletionChangeNotice(try notice(400, ready: true))
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(server.count("completion.claim"), 3)
    }

    @MainActor
    func testIssue242HelperRPCFailureRetainsObservationAfterGrace() async throws {
        let model = AppModel()
        let start = Date(timeIntervalSince1970: 100)
        model.recordLocalConnectionStatus(try helperStatus(), at: start)
        model.dashboard = try dashboardStatus(scope: "issue-242-retained")
        model.lastDashboardRefresh = start
        model.recordLocalConnectionStatus(nil, at: start.addingTimeInterval(1))
        // refreshStatusOnce's catch also sets this error, ending initial-connect checking.
        model.statusErrorMessage = "fixture helper RPC timeout"
        XCTAssertEqual(model.health, .checking)
        await model.refreshDashboard()
        XCTAssertEqual(model.dashboard?.scope, "issue-242-retained")
        model.recordLocalConnectionStatus(nil, at: start.addingTimeInterval(9))
        XCTAssertTrue(model.hasRetainedBridgeObservation)
        XCTAssertFalse(model.bridgeConnected)
        XCTAssertEqual(model.health, .attention)
        XCTAssertEqual(model.operationalProblem, .responseUnconfirmed)
        await model.refreshDashboard()
        XCTAssertEqual(model.dashboard?.scope, "issue-242-retained")
        XCTAssertEqual(model.lastDashboardRefresh, start)
    }

    @MainActor
    func testIssue242FailureRecoveryCancellationAndActualStop() async throws {
        let model = AppModel()
        defer { model.cancelAllPolling() }
        let checked = Date(timeIntervalSince1970: 100)
        model.recordLocalConnectionStatus(try helperStatus(), at: checked)
        model.dashboard = try dashboardStatus(scope: "confirmed")
        model.lastDashboardRefresh = checked
        model.recordLocalConnectionFailure(CancellationError(), at: checked.addingTimeInterval(1))
        XCTAssertNil(model.helperObservationFailure)
        XCTAssertTrue(model.bridgeConnected)
        XCTAssertEqual(model.lastConfirmedHelperCheck, checked)
        model.recordLocalConnectionFailure(LocalRPCError.transport(phase: .receive, code: EAGAIN), at: checked.addingTimeInterval(2))
        XCTAssertEqual(model.helperObservationFailure?.kind, .timeout)
        XCTAssertEqual(model.helperObservationFailedAt, checked.addingTimeInterval(2))
        XCTAssertEqual(model.lastConfirmedHelperCheck, checked)
        XCTAssertNil(model.helperStatus)
        XCTAssertFalse(model.bridgeConnected)
        model.recordLocalConnectionStatus(try helperStatus(), at: checked.addingTimeInterval(3))
        XCTAssertNil(model.helperObservationFailure)
        XCTAssertTrue(model.bridgeConnected)
        XCTAssertEqual(model.lastConfirmedHelperCheck, checked.addingTimeInterval(3))
        model.recordLocalConnectionFailure(LocalRPCError.emptyResponse, at: checked.addingTimeInterval(4))
        model.recordLocalConnectionStatus(try helperStatus(phase: "stopped", bridgeConnected: false, tunnelConnected: false), at: checked.addingTimeInterval(5))
        XCTAssertFalse(model.hasRetainedBridgeObservation)
        XCTAssertFalse(model.bridgeResponseUnconfirmed)
        XCTAssertFalse(model.isBridgeConnectionChecking)
        XCTAssertNil(model.dashboard)
        XCTAssertEqual(model.lastDashboardRefresh, checked)
        let first = AppModel()
        defer { first.cancelAllPolling() }
        first.recordLocalConnectionFailure(LocalRPCError.transport(phase: .connect, code: ECONNREFUSED), at: checked)
        first.recordLocalConnectionFailure(LocalRPCError.emptyResponse, at: checked.addingTimeInterval(9))
        XCTAssertFalse(first.hasRetainedBridgeObservation)
        XCTAssertNil(first.lastConfirmedHelperCheck)
        XCTAssertEqual(first.health, .unavailable)
    }

    @MainActor
    func testIssue242HelperRPCFailureKeepsSettingsSkillsDetailAndFencesLateReads() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-242-content-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let row = try issue242Row("a", project: "A")
        let detail = "{\"kind\":\"dashboard-history\",\"rowKey\":\"\(row.rowKey)\",\"history\":[],\"historyCount\":1,\"historyRevision\":\"\(String(repeating: "a", count: 64))\"}"
        let settings = try settingsSnapshot(policy: ["mode": "automatic", "allowedSelections": ["kind": "catalog-visible"],
            "constraints": ["allowDelegation": true]], catalogModels: [])
        let settingsBody = String(decoding: try JSONEncoder().encode(settings), as: UTF8.self)
        let dashboardBody = String(decoding: try JSONEncoder().encode(dashboardStatus(scope: "late")), as: UTF8.self)
        let slow = TestDashboardReplySequence([NativeFixtureReply(body: "{\"result\":\(dashboardBody)}", delay: 0.3)])
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            switch method {
            case "settings.snapshot": return NativeFixtureReply(body: "{\"result\":\(settingsBody)}", delay: 0.3)
            case "skills.snapshot": return NativeFixtureReply(body: #"{"result":{"skills":[]}}"#)
            case "dashboard.history-detail": return NativeFixtureReply(body: "{\"result\":\(detail)}")
            default: return slow.next()
            }
        }
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { _ in NativeFixtureReply(body: "") }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); helper.stop(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        let checked = Date()
        model.recordLocalConnectionStatus(try helperStatus(), at: checked)
        model.dashboard = try dashboardStatus(scope: "confirmed")
        model.settings = settings
        model.lastDashboardRefresh = checked
        await model.loadDashboardHistory(row)
        await model.refreshSkillLibrary()
        XCTAssertNotNil(model.dashboardHistoryDetails[row.rowKey])
        XCTAssertNotNil(model.skillLibrary)
        let late = Task { await model.refreshDashboard(enrich: false) }
        let lateSettings = Task { await model.refreshSettings() }
        for _ in 0..<100 {
            if bridge.count("dashboard.snapshot") > 0 && bridge.count("settings.snapshot") > 0 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        await model.refreshStatus()
        XCTAssertEqual(model.helperObservationFailure?.kind, .peerClosed)
        model.recordLocalConnectionFailure(LocalRPCError.emptyResponse, at: checked.addingTimeInterval(9))
        await late.value; await lateSettings.value
        await model.refreshDashboard(); await model.refreshSettings(); await model.refreshSkillLibrary()
        XCTAssertEqual(model.dashboard?.scope, "confirmed")
        XCTAssertEqual(model.settings?.settings.settingsRevision, 4)
        XCTAssertNotNil(model.skillLibrary)
        XCTAssertNotNil(model.dashboardHistoryDetails[row.rowKey])
        XCTAssertEqual(model.lastDashboardRefresh, checked)
        XCTAssertEqual(model.lastConfirmedHelperCheck, checked)
        XCTAssertFalse(model.bridgeConnected)
        XCTAssertEqual(model.health, .attention)
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 1)
        XCTAssertEqual(bridge.count("settings.snapshot"), 1)
        XCTAssertEqual(bridge.count("skills.snapshot"), 1)
        model.recordLocalConnectionStatus(try helperStatus(phase: "stopped", bridgeConnected: false, tunnelConnected: false))
        XCTAssertNil(model.skillLibrary)
        XCTAssertNil(model.settings)
        XCTAssertTrue(model.dashboardHistoryDetails.isEmpty)
    }

    @MainActor
    func testIssue242LateHelperHealthCannotReplaceConfirmedStop() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-242-health-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let healthy = String(decoding: try JSONEncoder().encode(helperStatus()), as: UTF8.self)
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { _ in NativeFixtureReply(body: "{\"result\":\(healthy)}", delay: 0.3) }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); helper.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        let pending = Task { await model.refreshStatus() }
        for _ in 0..<100 {
            if helper.count("helper.health") > 0 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        model.recordLocalConnectionStatus(try helperStatus(phase: "stopped", bridgeConnected: false, tunnelConnected: false))
        await pending.value
        XCTAssertEqual(model.helperStatus?.phase, "stopped")
        XCTAssertFalse(model.bridgeConnected)
        XCTAssertFalse(model.hasRetainedBridgeObservation)
    }

    @MainActor
    func testHelperReplacementClearsPreviousContentAndFencesLateDashboard() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-target-change-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let previous = try dashboardStatus(scope: "previous-helper")
        let body = String(decoding: try JSONEncoder().encode(previous), as: UTF8.self)
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { _ in
            NativeFixtureReply(body: "{\"result\":\(body)}", delay: 0.3)
        }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        model.dashboard = previous
        model.settings = try issue242Settings(registry: 2, id: UUID().uuidString.lowercased(), name: "Previous", cwd: root.path)
        let pending = Task { await model.refreshDashboard(enrich: false) }
        for _ in 0..<100 {
            if bridge.count("dashboard.snapshot") > 0 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 1)
        model.recordLocalConnectionStatus(try helperStatus(pid: 43, bridgeConnected: false, tunnelConnected: false))
        await pending.value
        XCTAssertEqual(model.helperStatus?.pid, 43)
        XCTAssertNil(model.dashboard)
        XCTAssertNil(model.settings)
        XCTAssertNil(model.lastDashboardRefresh)
    }

    @MainActor
    func testProjectRegistryChangeClearsSkillsAndFencesLateLibraryRead() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-skill-target-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased()
        let first = try issue242Settings(registry: 2, id: id, name: "Project", cwd: root.path)
        let archived = try issue242Settings(registry: 3, id: id, name: "Project", cwd: root.path, archived: true)
        let settingsBody = String(decoding: try JSONEncoder().encode(archived), as: UTF8.self)
        let libraries = TestDashboardReplySequence([
            NativeFixtureReply(body: #"{"result":{"skills":[]}}"#),
            NativeFixtureReply(body: #"{"result":{"skills":[]}}"#, delay: 0.3)
        ])
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            switch method {
            case "skills.snapshot": return libraries.next()
            case "settings.update": return NativeFixtureReply(body: "{\"result\":\(settingsBody)}")
            default: return NativeFixtureReply(body: "")
            }
        }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        model.settings = first
        await model.refreshSkillLibrary()
        XCTAssertNotNil(model.skillLibrary)
        let pending = Task { await model.refreshSkillLibrary() }
        for _ in 0..<100 {
            if bridge.count("skills.snapshot") == 2 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(bridge.count("skills.snapshot"), 2)
        let accepted = await model.applyProjectOperation(.archive(projectId: id))
        XCTAssertTrue(accepted)
        await pending.value
        XCTAssertEqual(model.settings?.settings.registryRevision, 3)
        XCTAssertNil(model.skillLibrary)
        XCTAssertNil(model.selectedBridgeSkill)
    }

    @MainActor
    func testIssue242ArchiveDeleteSameCwdRegistrationFencesLateDashboardAndDetail() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-242-projects-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let aID = UUID().uuidString.lowercased(), bID = UUID().uuidString.lowercased()
        let rowA = try issue242Row("a", project: "A"), rowB = try issue242Row("b", project: "B")
        let snapshotA = try issue242Dashboard(rowA, scope: "A"), snapshotB = try issue242Dashboard(rowB, scope: "B")
        let bodyA = String(decoding: try JSONEncoder().encode(snapshotA), as: UTF8.self)
        let bodyB = String(decoding: try JSONEncoder().encode(snapshotB), as: UTF8.self)
        let first = try issue242Settings(registry: 2, id: aID, name: "A", cwd: root.path)
        let archive = try issue242Settings(registry: 3, id: aID, name: "A", cwd: root.path, archived: true)
        let deleted = try issue242Settings(registry: 4, id: nil, name: "", cwd: root.path)
        let registered = try issue242Settings(registry: 5, id: bID, name: "B", cwd: root.path)
        let mutations = TestDashboardReplySequence(try [archive, deleted, registered].map {
            NativeFixtureReply(body: "{\"result\":\(String(decoding: try JSONEncoder().encode($0), as: UTF8.self))}")
        })
        let pages = TestDashboardReplySequence([NativeFixtureReply(body: "{\"result\":\(bodyA)}", delay: 0.5),
            NativeFixtureReply(body: "{\"result\":\(bodyB)}")])
        let detail = "{\"result\":{\"kind\":\"dashboard-history\",\"rowKey\":\"\(rowA.rowKey)\",\"history\":[],\"historyCount\":1,\"historyRevision\":\"\(String(repeating: "a", count: 64))\"}}"
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            switch method {
            case "settings.update": return mutations.next()
            case "dashboard.history-detail": return NativeFixtureReply(body: detail, delay: 0.5)
            default: return pages.next()
            }
        }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        model.settings = first
        model.dashboard = snapshotA
        let page = Task { await model.refreshDashboard(enrich: false) }
        let history = Task { await model.loadDashboardHistory(rowA) }
        for _ in 0..<100 {
            if bridge.count("dashboard.snapshot") > 0 && bridge.count("dashboard.history-detail") > 0 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let archived = await model.applyProjectOperation(.archive(projectId: aID))
        let removed = await model.applyProjectOperation(.delete(projectId: aID))
        let added = await model.applyProjectOperation(.add(name: "B", cwd: root.path))
        XCTAssertTrue(archived && removed && added)
        XCTAssertEqual(model.settings?.settings.projects.first?.id, bID)
        XCTAssertEqual(model.settings?.settings.projects.first?.cwd, root.path)
        await page.value; await history.value
        XCTAssertNil(model.dashboard)
        XCTAssertTrue(model.dashboardHistoryDetails.isEmpty)
        await model.refreshDashboard(enrich: false)
        XCTAssertEqual(model.dashboard?.scope, "B")
        XCTAssertEqual(model.dashboard?.terminalRows.first?.rowKey, rowB.rowKey)
        XCTAssertNotEqual(model.dashboard?.terminalRows.first?.rowKey, rowA.rowKey)
        XCTAssertTrue(model.dashboardHistoryDetails.isEmpty)
    }

    @MainActor
    func testTunnelObservationFailureRetainsRuntimeAndDoesNotCountAsRecovery() throws {
        let model = AppModel()
        model.authStatus = try loginStatus(installed: true, authenticated: true)
        model.dashboard = try dashboardStatus(scope: "issue-242-tunnel")
        model.recordLocalConnectionStatus(try helperStatus(tunnelProbeFailed: true))
        XCTAssertTrue(model.bridgeConnected)
        XCTAssertFalse(model.bridgeResponseUnconfirmed)
        XCTAssertTrue(model.tunnelResponseUnconfirmed)
        XCTAssertEqual(model.health, .attention)
        XCTAssertEqual(model.operationalObservation, .problem(.responseUnconfirmed))
        XCTAssertEqual(model.dashboard?.scope, "issue-242-tunnel")

        var policy = OperationalNotificationPolicy()
        let scope = OperationalNotificationPolicy.scope("issue-242-fixture")
        let now = Date(timeIntervalSince1970: 1_000)
        _ = policy.observe(.problem(.tunnel), scope: scope, now: now)
        policy.markDelivered(scope: scope, problem: .tunnel)
        _ = policy.observe(.healthy, scope: scope, now: now.addingTimeInterval(10))
        _ = policy.observe(model.operationalObservation, scope: scope, now: now.addingTimeInterval(30))
        XCTAssertNil(policy.healthySince[scope])
        XCTAssertEqual(policy.observe(model.operationalObservation, scope: scope, now: now.addingTimeInterval(90)), .responseUnconfirmed)

        model.recordLocalConnectionStatus(try helperStatus())
        XCTAssertFalse(model.tunnelResponseUnconfirmed)
        XCTAssertEqual(model.operationalObservation, .healthy)
        _ = policy.observe(model.operationalObservation, scope: scope, now: now.addingTimeInterval(100))
        _ = policy.observe(model.operationalObservation, scope: scope, now: now.addingTimeInterval(120))
        _ = policy.observe(model.operationalObservation, scope: scope, now: now.addingTimeInterval(140))
        _ = policy.observe(model.operationalObservation, scope: scope, now: now.addingTimeInterval(160))
        XCTAssertTrue(policy.entries.isEmpty)
    }

    @MainActor
    func testReadProjectionDelayIsPartialAndDoesNotClaimRuntimeOrWritesFailed() throws {
        let model = AppModel()
        model.authStatus = try loginStatus(installed: true, authenticated: true)
        model.recordLocalConnectionStatus(try helperStatus(readServiceStatus: "read-stale"))

        XCTAssertTrue(model.bridgeConnected)
        XCTAssertTrue(model.bridgeReadProjectionDelayed)
        XCTAssertFalse(model.bridgeResponseUnconfirmed)
        XCTAssertEqual(model.operationalObservation, .healthy)
        XCTAssertEqual(model.health, .attention)

        model.recordLocalConnectionStatus(try helperStatus(readServiceStatus: "ready"))
        XCTAssertFalse(model.bridgeReadProjectionDelayed)
    }

    @MainActor
    func testStateStorageFailureIsDistinctFromAnUnconfirmedResponse() throws {
        let model = AppModel()
        model.authStatus = try loginStatus(installed: true, authenticated: true)
        model.recordLocalConnectionStatus(try helperStatus(stateServiceStorageError: "full"))

        XCTAssertTrue(model.bridgeConnected)
        XCTAssertEqual(model.bridgeStateStorageError, "full")
        XCTAssertFalse(model.bridgeResponseUnconfirmed)
        XCTAssertEqual(model.operationalObservation, .problem(.stateStorage))
        XCTAssertEqual(model.health, .attention)
        XCTAssertEqual(
            model.runtimeUnavailableExplanation,
            BridgeAppLocalization.string(
                "macos.bridgestoragecannotacceptupdatesexistingworkispreserved",
                locale: model.interfaceLocale
            )
        )
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
        for _ in 0..<40 {
            if model.health == .unavailable { break }
            try await Task.sleep(for: .milliseconds(250))
        }
        XCTAssertEqual(model.health, .unavailable)
    }

    @MainActor
    func testDashboardRefreshesOnOpeningButNotOnBackgroundSchedule() async throws {
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
        func waitForSnapshotCount(_ expected: Int) async throws {
            for _ in 0..<150 {
                if bridge.count("dashboard.snapshot") >= expected { return }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTFail("Expected at least \(expected) dashboard requests before the next visibility transition.")
        }
        defer { helper.stop(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        let model = AppModel(paths: paths)
        model.recordLocalConnectionStatus(try helperStatus())
        model.scheduleBackgroundRefreshes()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 0)
        XCTAssertEqual(bridge.count("settings.snapshot"), 0)
        model.setDashboardVisible(true)
        try await waitForSnapshotCount(1)
        XCTAssertGreaterThan(bridge.count("dashboard.snapshot"), 0)
        let whileOpen = bridge.count("dashboard.snapshot")
        model.scheduleBackgroundRefreshes(at: Date().addingTimeInterval(120))
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(bridge.count("dashboard.snapshot"), whileOpen)
        model.setDashboardVisible(false)
        let before = bridge.count("dashboard.snapshot")
        model.scheduleBackgroundRefreshes(at: Date().addingTimeInterval(120))
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(bridge.count("dashboard.snapshot"), before)
        model.setDashboardVisible(true)
        try await waitForSnapshotCount(before + 1)
        model.setDashboardVisible(false)
        model.setDashboardVisible(true)
        // A background scheduling pass cannot add another Dashboard read to the
        // explicit refresh caused by reopening the menu.
        model.scheduleBackgroundRefreshes(at: Date().addingTimeInterval(120))
        try await waitForSnapshotCount(before + 2)
        try await Task.sleep(for: .milliseconds(400))
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
        for _ in 0..<150 {
            if helper.count("codex.runtime") > 0 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
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
        XCTAssertEqual(model.health, .healthy)
        model.dashboard = try dashboardStatus()
        XCTAssertEqual(model.health, .healthy)
        model.dashboard = try dashboardStatus(runtimeUnknownAgents: 18)
        XCTAssertEqual(model.health, .healthy)
        model.dashboardErrorMessage = "stale"
        XCTAssertEqual(model.health, .attention)
    }

    @MainActor
    func testWorkProblemsStayInDashboardWithoutMakingTheBridgeUnhealthy() async throws {
        let local = AppModel()
        local.helperStatus = try helperStatus()
        local.authStatus = try loginStatus(installed: true, authenticated: true)

        let profile = remoteProfile(id: "11111111-1111-4111-8111-111111111111", name: "작업실")
        let client = TestRemoteClient(
            profile: profile,
            dashboard: try dashboardStatus(),
            settings: try settingsSnapshot(
                policy: ["mode": "automatic", "allowedSelections": ["kind": "catalog-visible"],
                         "constraints": ["allowDelegation": true]],
                catalogModels: []
            )
        )
        let remote = AppModel(
            connectionStore: TestConnectionStore(BridgeConnectionPreferences(
                mode: .remoteClient, activeServerId: profile.serverId, profiles: [profile]
            )),
            credentialStore: TestCredentialStore([
                profile.serverId: "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDE"
            ]),
            remoteClientFactory: { _, _ in client }
        )
        await remote.refreshStatus()
        remote.cancelAllPolling()
        XCTAssertTrue(remote.bridgeConnected)

        for model in [local, remote] {
            model.dashboard = nil
            XCTAssertEqual(model.health, .healthy)
            for current in [false, true] {
                var counts = ["inputRequired": 2, "approvalRequired": 3, "needsAttention": 5]
                if current { counts["responseRequired"] = 5; counts["problems"] = 0 }
                model.dashboard = try dashboardStatus(countOverrides: counts)
                XCTAssertEqual(model.dashboard?.counts.responseRequiredCount, 5)
                XCTAssertEqual(model.health, .healthy)

                for problem in ["orphanedAgents", "failed", "interrupted"] {
                    var problemCounts = counts
                    problemCounts[problem] = 1
                    problemCounts["needsAttention"] = 6
                    if current { problemCounts["problems"] = 1 }
                    model.dashboard = try dashboardStatus(countOverrides: problemCounts)
                    XCTAssertEqual(model.dashboard?.counts.problemCount, 1)
                    XCTAssertEqual(model.dashboard?.counts.responseRequiredCount, 5)
                    XCTAssertEqual(model.health, .healthy)
                }
            }
            model.dashboardErrorMessage = "snapshot request failed"
            XCTAssertEqual(model.health, .attention)
        }
    }

    @MainActor
    func testNetworkLossCannotReuseTheHelpersPreviouslyConnectedTunnelState() throws {
        let model = AppModel()
        model.helperStatus = try helperStatus()
        model.authStatus = try loginStatus(installed: true, authenticated: true)
        XCTAssertEqual(model.health, .healthy)
        model.recordNetworkAvailability(false)
        XCTAssertTrue(model.bridgeConnected) // Local IPC remains available.
        XCTAssertTrue(model.isBridgeConnectionChecking)
        XCTAssertEqual(model.health, .checking)
        XCTAssertEqual(model.operationalObservation, .problem(.tunnel))
        model.recordNetworkAvailability(true)
        XCTAssertEqual(model.health, .healthy)
        XCTAssertEqual(model.operationalObservation, .healthy)
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

    func testSettingsDraftTracksExperimentalDirectResultDelivery() throws {
        let enabledSnapshot = try settingsSnapshot(
            experimentalDirectResultDelivery: true,
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let disabledSnapshot = try settingsSnapshot(
            experimentalDirectResultDelivery: false,
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let enabled = SettingsDraft(snapshot: enabledSnapshot)
        var edited = enabled
        edited.experimentalDirectResultDelivery = false

        XCTAssertTrue(enabled.experimentalDirectResultDelivery)
        XCTAssertFalse(edited.hasSameEditableValues(as: enabled))
        XCTAssertFalse(edited.rebased(on: enabledSnapshot).experimentalDirectResultDelivery)
        XCTAssertFalse(SettingsDraft(snapshot: disabledSnapshot).experimentalDirectResultDelivery)
    }

    func testEmptyCatalogDoesNotRewriteAnExplicitPolicyForUnrelatedPreferences() throws {
        let saved = ModelChoice(model: "temporarily-unavailable", reasoningEffort: "high")
        let snapshot = try settingsSnapshot(policy: [
            "mode": "automatic", "allowedSelections": ["kind": "explicit", "selections": [choiceObject(saved)]],
            "constraints": ["allowDelegation": true]
        ], catalogModels: [])
        var draft = SettingsDraft(snapshot: snapshot)
        draft.accessStrategy = "read-only"
        XCTAssertFalse(draft.modelPolicyDirty)
        XCTAssertEqual(draft.rebased(on: snapshot).explicitSelectionKeys, [saved.key])
        XCTAssertFalse(draft.rebased(on: snapshot).modelPolicyDirty)
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

    func testDisabledUltraRemainsSavedWithoutBeingExecutable() throws {
        let ultra = ModelChoice(model: "gpt-current", reasoningEffort: "ultra")
        let high = ModelChoice(model: "gpt-current", reasoningEffort: "high")
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "explicit", "selections": [choiceObject(ultra)]],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high", "ultra"])]
        )
        var draft = SettingsDraft(snapshot: snapshot)
        draft.allowDelegation = false
        XCTAssertEqual(draft.explicitSelectionKeys, [ultra.key])
        XCTAssertTrue(draft.canRetainExplicitChoice(ultra, in: snapshot))
        XCTAssertTrue(draft.isUltraDisabled(ultra))
        XCTAssertEqual(SettingsDraft.selectableChoices(in: snapshot, allowDelegation: false), [high])
        XCTAssertTrue(SettingsDraft.displayedChoices(in: snapshot, allowDelegation: false).contains(ultra))
        XCTAssertFalse(draft.canRetainExplicitChoice(ModelChoice(model: "removed", reasoningEffort: "high"), in: snapshot))
        draft.allowDelegation = true
        XCTAssertFalse(draft.isUltraDisabled(ultra))
        XCTAssertTrue(SettingsDraft.selectableChoices(in: snapshot, allowDelegation: true).contains(ultra))
        XCTAssertEqual(draft.explicitSelectionKeys, [ultra.key])
    }

    func testModelDescriptionEditKeepsCatalogTextLiveAndOnlySavesDeliberateChanges() {
        var edit = ModelDescriptionEdit(officialDescription: "Official v1", override: nil)
        XCTAssertEqual(edit.text, "Official v1")
        XCTAssertNil(edit.valueToSave(officialDescription: "Official v2"))
        edit.text = "  Use for a scoped task.\nKeep the answer short.  "
        XCTAssertEqual(edit.valueToSave(officialDescription: "Official v2"), "Use for a scoped task.\nKeep the answer short.")
        edit.text = " \n\t"
        XCTAssertNil(edit.valueToSave(officialDescription: "Official v2"))
        edit.text = "Official v2"
        XCTAssertNil(edit.valueToSave(officialDescription: "Official v2"))
        edit.text = String(repeating: "x", count: 2_001)
        XCTAssertTrue(edit.isTooLong)
        let custom = ModelDescriptionEdit(officialDescription: "Official", override: "User text")
        XCTAssertEqual(custom.valueToSave(officialDescription: "User text"), "User text")
    }

    func testModelDescriptionLimitCountsCanonicalUnicodeScalarsWithoutRewritingTheDraft() {
        var edit = ModelDescriptionEdit(officialDescription: nil, override: nil)
        edit.text = String(repeating: "한", count: 2_000)
        XCTAssertFalse(edit.isTooLong)
        XCTAssertEqual(edit.text.utf8.count, 18_000)
        edit.text += "글"
        XCTAssertTrue(edit.isTooLong)
        edit.text = String(repeating: "😀", count: 2_000)
        XCTAssertFalse(edit.isTooLong)
        edit.text += "😀"
        XCTAssertTrue(edit.isTooLong)
    }

    @MainActor
    func testModelDescriptionHistoryDecodesAndLoadsThroughRemoteClient() async throws {
        let policy: [String: Any] = [
            "mode": "automatic", "allowedSelections": ["kind": "catalog-visible"],
            "constraints": ["allowDelegation": true]
        ]
        let legacy = try settingsSnapshot(policy: policy, catalogModels: [])
        XCTAssertNil(legacy.modelDescriptionHistoryModelIds)
        let snapshot = try settingsSnapshot(
            policy: policy,
            modelDescriptionOverrides: [:],
            modelDescriptionHistoryModelIds: ["missing-model"],
            catalogModels: []
        )
        XCTAssertEqual(snapshot.modelDescriptionHistoryModelIds, ["missing-model"])
        let page = try JSONDecoder().decode(ModelDescriptionHistoryPage.self, from: Data(
            #"{"kind":"model-description-history","modelId":"missing-model","versions":[{"version":2,"description":null,"createdAt":"2026-09-23T00:00:00.000Z"},{"version":1,"description":"Earlier text","createdAt":null}],"nextBeforeVersion":null}"#.utf8
        ))
        XCTAssertNil(page.versions[0].description)
        XCTAssertNil(page.versions[1].createdAt)
        let profile = remoteProfile(id: "11111111-1111-4111-8111-111111111111", name: "Description history")
        let client = TestRemoteClient(
            profile: profile,
            dashboard: try dashboardStatus(scope: "description-history"),
            settings: snapshot,
            modelDescriptionHistoryPage: page
        )
        let model = AppModel(
            loginItemController: TestLoginItemController(status: .notRegistered),
            connectionStore: TestConnectionStore(BridgeConnectionPreferences(mode: .remoteClient, activeServerId: profile.serverId, profiles: [profile])),
            credentialStore: TestCredentialStore([profile.serverId: "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDE"]),
            remoteClientFactory: { _, _ in client }
        )
        await model.start()
        let loaded = try await model.modelDescriptionHistory(modelID: "missing-model", beforeVersion: 3)
        XCTAssertEqual(loaded.versions.map(\.version), [2, 1])
        XCTAssertEqual(client.lastModelDescriptionHistoryModelID, "missing-model")
        XCTAssertEqual(client.lastModelDescriptionHistoryBeforeVersion, 3)
        let stopped = await model.shutdownApplication(force: false)
        XCTAssertTrue(stopped)
    }

    @MainActor
    func testModelDescriptionSaveAndRestorePatchOnlyUserTextAndPreserveUnavailableModels() async throws {
        let policy: [String: Any] = [
            "mode": "automatic", "allowedSelections": ["kind": "catalog-visible"],
            "constraints": ["allowDelegation": true]
        ]
        for restoring in [false, true] {
            let initial = restoring ? ["gpt-current": "User text", "missing-model": "Keep this."] : ["missing-model": "Keep this."]
            let expected = restoring ? ["missing-model": "Keep this."] : ["gpt-current": "User text", "missing-model": "Keep this."]
            let snapshot = try settingsSnapshot(policy: policy, modelDescriptionOverrides: initial, catalogModels: [])
            let updated = try settingsSnapshot(settingsRevision: 5, policy: policy, modelDescriptionOverrides: expected, catalogModels: [])
            let profile = remoteProfile(id: "11111111-1111-4111-8111-111111111111", name: "Description test")
            let client = TestRemoteClient(profile: profile, dashboard: try dashboardStatus(scope: "description-test"), settings: snapshot, settingsAfterUpdate: updated)
            let model = AppModel(
                loginItemController: TestLoginItemController(status: .notRegistered),
                connectionStore: TestConnectionStore(BridgeConnectionPreferences(mode: .remoteClient, activeServerId: profile.serverId, profiles: [profile])),
                credentialStore: TestCredentialStore([profile.serverId: "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDE"]),
                remoteClientFactory: { _, _ in client }
            )
            await model.start()
            let result = await model.submitModelDescription(modelID: "gpt-current", description: restoring ? nil : "  User text  ", expectedOverride: initial["gpt-current"], expectedSettingsRevision: 4)
            let receipt = try XCTUnwrap(result)
            XCTAssertEqual(receipt.settings.settingsRevision, 5)
            XCTAssertEqual(receipt.settings.modelDescriptionOverrides, expected)
            XCTAssertEqual(client.settingsUpdateCallCount, 1)
            let mutation = try XCTUnwrap(client.lastSettingsMutation)
            XCTAssertEqual(mutation.expectedSettingsRevision, 4)
            guard case .patch(let patch) = mutation.operation else { return XCTFail("Expected a description patch") }
            XCTAssertEqual(patch.modelDescriptionOverrides, expected)
            XCTAssertNil(patch.modelPolicy)
            XCTAssertNil(patch.accessStrategy)
            XCTAssertNil(patch.projectOperations)
            XCTAssertEqual(model.settings?.settings.modelDescriptionOverrides, expected)
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any]
            XCTAssertEqual(Set(encoded?.keys.map { $0 } ?? []), ["modelDescriptionOverrides"])
            let stopped = await model.shutdownApplication(force: false)
            XCTAssertTrue(stopped)
        }
    }

    @MainActor
    func testModelDescriptionEditRejectsKnownConflictsAndSupportsOlderServers() async throws {
        let policy: [String: Any] = ["mode": "automatic", "allowedSelections": ["kind": "catalog-visible"], "constraints": ["allowDelegation": true]]
        let legacy = try settingsSnapshot(policy: policy, catalogModels: [])
        XCTAssertNil(legacy.settings.modelDescriptionOverrides)
        let model = AppModel()
        model.settings = try settingsSnapshot(policy: policy, modelDescriptionOverrides: ["gpt-current": "Saved elsewhere"], catalogModels: [])
        var edit = ModelDescriptionEdit(officialDescription: "Official", override: "Older text")
        edit.text = "My unsaved draft"
        let saved = await model.saveModelDescription(modelID: "gpt-current", description: edit.text, expectedOverride: edit.expectedOverride)
        XCTAssertFalse(saved)
        XCTAssertEqual(edit.text, "My unsaved draft")
        XCTAssertEqual(model.settings?.settings.modelDescriptionOverrides?["gpt-current"], "Saved elsewhere")
        XCTAssertNotNil(model.settingsErrorMessage)
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
    func testAutosaveRejectsASelectedModelWithoutAnySupportedCommonEffort() async throws {
        let high = ModelChoice(model: "gpt-current", reasoningEffort: "high")
        let snapshot = try settingsSnapshot(policy: [
            "mode": "automatic", "allowedSelections": ["kind": "explicit", "selections": [choiceObject(high)]],
            "constraints": ["allowDelegation": true]
        ], catalogModels: [catalogModel(id: high.model, efforts: ["high"]), catalogModel(id: "ultra-only", efforts: ["ultra"])])
        let model = AppModel()
        model.settings = snapshot
        var draft = SettingsDraft(snapshot: snapshot)
        let choices = SettingsDraft.selectableChoices(in: snapshot, allowDelegation: true)
        draft.updateAllowlist(choices: choices) { $0.setModel("ultra-only", selected: true, choices: choices) }
        XCTAssertTrue(draft.modelPolicyDirty)
        XCTAssertEqual(draft.explicitSelectionKeys, [high.key])
        model.scheduleSettingsAutosave(draft)
        let saved = await model.flushSettingsAutosave()
        XCTAssertFalse(saved)
        XCTAssertTrue(model.settingsErrorMessage?.contains("ultra-only") == true)
        XCTAssertEqual(model.settings?.settings.settingsRevision, snapshot.settings.settingsRevision)
        model.cancelPendingSettingsAutosave()
    }

    @MainActor
    func testLegacyModelSpecificChoicesAreAutosavedAsOneCommonEffortList() async throws {
        let newHigh = ModelChoice(model: "new", reasoningEffort: "high")
        let olderLow = ModelChoice(model: "older", reasoningEffort: "low")
        let normalized = [newHigh, olderLow, ModelChoice(model: "new", reasoningEffort: "low"), ModelChoice(model: "older", reasoningEffort: "high")]
        let catalog = [catalogModel(id: "new", efforts: ["low", "high"]), catalogModel(id: "older", efforts: ["low", "high"])]
        func policy(_ choices: [ModelChoice]) -> [String: Any] {
            ["mode": "automatic", "allowedSelections": ["kind": "explicit", "selections": choices.map(choiceObject)],
             "constraints": ["allowDelegation": true]]
        }
        let snapshot = try settingsSnapshot(policy: policy([newHigh, olderLow]), catalogModels: catalog)
        let updated = try settingsSnapshot(settingsRevision: 5, policy: policy(normalized), catalogModels: catalog)
        let profile = remoteProfile(id: "11111111-1111-4111-8111-111111111111", name: "Common reasoning test")
        let client = TestRemoteClient(profile: profile, dashboard: try dashboardStatus(scope: "common-reasoning-test"),
            settings: snapshot, settingsAfterUpdate: updated)
        let model = AppModel(loginItemController: TestLoginItemController(status: .notRegistered),
            connectionStore: TestConnectionStore(BridgeConnectionPreferences(mode: .remoteClient, activeServerId: profile.serverId, profiles: [profile])),
            credentialStore: TestCredentialStore([profile.serverId: "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDE"]),
            remoteClientFactory: { _, _ in client })
        await model.start()
        let draft = SettingsDraft(snapshot: snapshot)
        XCTAssertTrue(draft.modelPolicyDirty)
        XCTAssertEqual(draft.explicitSelectionKeys, Set(normalized.map(\.key)))
        model.scheduleSettingsAutosave(draft)
        let saved = await model.flushSettingsAutosave()
        XCTAssertTrue(saved)
        XCTAssertEqual(client.settingsUpdateCallCount, 1)
        let mutation = try XCTUnwrap(client.lastSettingsMutation)
        guard case .patch(let patch) = mutation.operation else { return XCTFail("Expected a policy patch") }
        XCTAssertEqual(Set(patch.modelPolicy?.allowedSelections?.selections ?? []), Set(normalized))
        XCTAssertFalse(SettingsDraft(snapshot: updated).modelPolicyDirty)
        let stopped = await model.shutdownApplication(force: false)
        XCTAssertTrue(stopped)
    }

    @MainActor
    func testUltraOffAutosavePreservesAutomaticChoicesAndRequiresFixedReplacement() async throws {
        for mode in ["automatic-mixed", "automatic-ultra-only", "fixed"] {
            let ultra = ModelChoice(model: "gpt-current", reasoningEffort: "ultra")
            let high = ModelChoice(model: "gpt-current", reasoningEffort: "high")
            let savedChoices = mode == "automatic-mixed" ? [high, ultra] : [ultra]
            var policy: [String: Any] = [
                "mode": mode == "fixed" ? "fixed" : "automatic",
                "constraints": ["allowDelegation": true]
            ]
            if mode == "fixed" {
                policy["selection"] = choiceObject(ultra)
            } else {
                policy["allowedSelections"] = ["kind": "explicit", "selections": savedChoices.map(choiceObject)]
            }
            let catalog = [catalogModel(id: ultra.model, efforts: ["high", "ultra"])]
            let snapshot = try settingsSnapshot(policy: policy, catalogModels: catalog)
            policy["constraints"] = ["allowDelegation": false]
            if mode == "fixed" { policy["selection"] = choiceObject(high) }
            let updated = try settingsSnapshot(settingsRevision: 5, policy: policy, catalogModels: catalog)
            let profile = remoteProfile(id: "11111111-1111-4111-8111-111111111111", name: "Ultra test")
            let client = TestRemoteClient(
                profile: profile, dashboard: try dashboardStatus(scope: "ultra-test"),
                settings: snapshot, settingsAfterUpdate: updated
            )
            let model = AppModel(
                loginItemController: TestLoginItemController(status: .notRegistered),
                connectionStore: TestConnectionStore(BridgeConnectionPreferences(
                    mode: .remoteClient, activeServerId: profile.serverId, profiles: [profile]
                )),
                credentialStore: TestCredentialStore([
                    profile.serverId: "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDE"
                ]),
                remoteClientFactory: { _, _ in client }
            )
            await model.start()
            var draft = SettingsDraft(snapshot: snapshot)
            draft.allowDelegation = false
            if mode == "fixed" {
                model.scheduleSettingsAutosave(draft)
                let invalidSaved = await model.flushSettingsAutosave()
                XCTAssertFalse(invalidSaved)
                XCTAssertEqual(client.settingsUpdateCallCount, 0)
                XCTAssertNotNil(model.settingsErrorMessage)
                XCTAssertEqual(draft.fixedSelectionKey, ultra.key)
                draft.fixedSelectionKey = high.key
            }
            model.scheduleSettingsAutosave(draft)
            let saved = await model.flushSettingsAutosave()
            XCTAssertTrue(saved, mode)
            XCTAssertEqual(client.settingsUpdateCallCount, 1)
            let mutation = try XCTUnwrap(client.lastSettingsMutation)
            guard case .patch(let patch) = mutation.operation else {
                return XCTFail("Expected a policy patch")
            }
            let savedPolicy = try XCTUnwrap(patch.modelPolicy)
            XCTAssertFalse(savedPolicy.constraints.allowDelegation)
            if mode == "fixed" {
                XCTAssertEqual(savedPolicy.selection, high)
            } else {
                XCTAssertEqual(Set(savedPolicy.allowedSelections?.selections ?? []), Set(savedChoices))
            }
            XCTAssertEqual(model.settings?.settings.settingsRevision, 5)
            let stopped = await model.shutdownApplication(force: false)
            XCTAssertTrue(stopped)
        }
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
        let rerouted = try dashboardExecution(
            model: "gpt-5.6-sol",
            displayName: "Sol",
            effort: " XHIGH ",
            reroutedModel: "gpt-5.6-terra",
            isCurrent: false
        )
        XCTAssertEqual(
            DashboardExecutionPresentation.text(rerouted),
            "Sol → gpt-5.6-terra · xhigh"
        )
    }

    func testFastModeUsesEachExecutionAndDetectsNextRunChanges() throws {
        let standard = try dashboardExecution(
            model: "gpt-5.6", displayName: nil, effort: "high",
            reroutedModel: nil, isCurrent: true
        )
        XCTAssertNil(standard.serviceTier)
        XCTAssertFalse(DashboardExecutionPresentation.usesFastProcessing(standard))
        for tier in ["priority", "fast", " FAST ", "PRIORITY"] {
            let fast = try dashboardExecution(
                model: "gpt-5.6", displayName: nil, effort: "high",
                reroutedModel: nil, isCurrent: true, serviceTier: tier
            )
            XCTAssertTrue(DashboardExecutionPresentation.usesFastProcessing(fast))
            XCTAssertNotNil(DashboardExecutionPresentation.next(current: fast, latest: standard))
            XCTAssertNotNil(DashboardExecutionPresentation.next(current: standard, latest: fast))
            let historicalFast = try dashboardExecution(
                model: "gpt-5.6", displayName: nil, effort: "high",
                reroutedModel: nil, isCurrent: false, serviceTier: "priority"
            )
            XCTAssertNil(DashboardExecutionPresentation.next(current: fast, latest: historicalFast))
        }
        for tier in ["default", "auto", "flex", "ultrafast", ""] {
            let execution = try dashboardExecution(
                model: "gpt-5.6", displayName: nil, effort: "high",
                reroutedModel: nil, isCurrent: false, serviceTier: tier
            )
            XCTAssertFalse(DashboardExecutionPresentation.usesFastProcessing(execution))
        }
    }

    func testTurnSpeedRequestsStayDistinctFromConfirmationAndConversationScope() throws {
        let accepted = try dashboardExecution(model: "gpt-5.6-sol", displayName: "Sol", effort: "medium",
            reroutedModel: "gpt-6-astra", isCurrent: false, serviceTier: "fast",
            processingSpeed: "fast", serviceTierScope: "turn", requestState: "accepted")
        let text = DashboardExecutionPresentation.text(accepted, locale: Locale(identifier: "en"))
        XCTAssertEqual(text, "Sol ⚡ Fast → gpt-6-astra · medium")
        XCTAssertFalse(text.contains("requested"))
        XCTAssertFalse(text.contains("accepted"))
        XCTAssertFalse(text.contains("unconfirmed"))
        XCTAssertEqual(DashboardExecutionPresentation.speedBadgeHelp(accepted, locale: Locale(identifier: "en")), "Selected processing speed: ⚡ Fast")
        let persistent = try dashboardExecution(model: "gpt-5.6-sol", displayName: "Sol", effort: "medium",
            reroutedModel: "gpt-6-astra", isCurrent: true, serviceTier: "fast")
        XCTAssertFalse(DashboardExecutionPresentation.matches(accepted, persistent))
    }

    func testHistoricalSpeedBadgesUseOnlyRecognizedRecordedValues() throws {
        for tier in ["ultrafast", "flex", "future-tier"] {
            let historical = try dashboardExecution(model: "sol", displayName: nil, effort: "medium",
                reroutedModel: nil, isCurrent: false, serviceTier: tier, requestState: "requested")
            let text = DashboardExecutionPresentation.text(historical, locale: Locale(identifier: "en"))
            XCTAssertEqual(text, tier == "ultrafast" ? "sol 🚀 Ultrafast · medium" : "sol · medium")
            XCTAssertFalse(text.contains("clear conversation speed"))
            XCTAssertFalse(text.contains("unconfirmed"))
            XCTAssertEqual(historical.serviceTier, tier)
        }
        for mode in ["standard", "inherit", "future-tier"] {
            let execution = try dashboardExecution(model: "sol", displayName: nil, effort: "medium",
                reroutedModel: nil, isCurrent: false, serviceTier: nil, processingSpeed: mode)
            XCTAssertEqual(DashboardExecutionPresentation.text(execution), "sol · medium")
        }
    }

    func testSpeedPickerKeepsCompatibilityStateOutOfItsChoices() throws {
        for (mode, fast, expected) in [("legacy", false, "standard"), ("legacy", true, "fast"),
                                       ("inherit", false, ""), ("future-tier", false, ""), ("ultrafast", false, "")] {
            let snapshot = try settingsSnapshot(policy: ["mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"], "constraints": ["allowDelegation": true]],
                catalogModels: [], processingSpeed: mode, usePriorityServiceTier: fast,
                availableProcessingSpeeds: ["legacy", "fast", "inherit", "standard", "future-tier", "fast"])
            var draft = SettingsDraft(snapshot: snapshot)
            XCTAssertEqual(SettingsDraft.processingSpeedChoices(in: snapshot), ["standard", "fast"])
            XCTAssertEqual(draft.processingSpeedSelection(in: snapshot), expected)
            draft.selectProcessingSpeed("inherit", in: snapshot)
            draft.selectProcessingSpeed("ultrafast", in: snapshot)
            XCTAssertEqual(draft.processingSpeed, mode)
            XCTAssertEqual(draft.usePriorityServiceTier, fast)
            XCTAssertTrue(draft.hasSameEditableValues(as: SettingsDraft(snapshot: snapshot)))
            XCTAssertEqual(draft.rebased(on: snapshot).processingSpeed, mode)
        }
    }

    @MainActor
    func testSpeedPickerAutosaveOnlyChangesScopeAfterChoosingASpeed() async throws {
        for (mode, fast) in [("legacy", false), ("legacy", true), ("inherit", false)] {
            for changeSpeed in [false, true] {
                let policy: [String: Any] = ["mode": "automatic", "allowedSelections": ["kind": "catalog-visible"],
                    "constraints": ["allowDelegation": true]]
                let catalog = [catalogModel(id: "gpt-current", efforts: ["high"])]
                let snapshot = try settingsSnapshot(policy: policy, catalogModels: catalog, processingSpeed: mode,
                    usePriorityServiceTier: fast, availableProcessingSpeeds: ["legacy", "inherit", "standard", "fast"])
                let updated = try settingsSnapshot(settingsRevision: 5, accessStrategy: "read-only", policy: policy,
                    catalogModels: catalog, processingSpeed: changeSpeed ? "standard" : mode,
                    usePriorityServiceTier: fast, availableProcessingSpeeds: ["legacy", "inherit", "standard", "fast"])
                let profile = remoteProfile(id: "11111111-1111-4111-8111-111111111111", name: "Speed test")
                let client = TestRemoteClient(profile: profile, dashboard: try dashboardStatus(scope: "speed-test"),
                    settings: snapshot, settingsAfterUpdate: updated)
                let model = AppModel(loginItemController: TestLoginItemController(status: .notRegistered),
                    connectionStore: TestConnectionStore(BridgeConnectionPreferences(
                        mode: .remoteClient, activeServerId: profile.serverId, profiles: [profile])),
                    credentialStore: TestCredentialStore([profile.serverId: "device_abcdefghijklmnopqrstuvwxyz1234567890ABCDE"]),
                    remoteClientFactory: { _, _ in client })
                await model.start()
                var draft = SettingsDraft(snapshot: snapshot)
                draft.accessStrategy = "read-only"
                if changeSpeed { draft.selectProcessingSpeed("standard", in: snapshot) }
                model.scheduleSettingsAutosave(draft)
                let saved = await model.flushSettingsAutosave()
                XCTAssertTrue(saved)
                guard case .patch(let patch) = try XCTUnwrap(client.lastSettingsMutation).operation else {
                    return XCTFail("Expected a settings patch")
                }
                XCTAssertEqual(patch.processingSpeed, changeSpeed ? "standard" : mode)
                XCTAssertEqual(patch.usePriorityServiceTier, !changeSpeed && mode == "legacy" ? fast : nil)
                XCTAssertNil(patch.modelPolicy)
                let stopped = await model.shutdownApplication(force: false)
                XCTAssertTrue(stopped)
            }
        }
    }

    func testSettingsDraftPreservesUnknownSpeedWhenRebased() throws {
        let snapshot = try settingsSnapshot(policy: ["mode": "fixed", "selection": choiceObject(ModelChoice(model: "sol", reasoningEffort: "medium")),
            "constraints": ["allowDelegation": true]], catalogModels: [], processingSpeed: "future-tier")
        let draft = SettingsDraft(snapshot: snapshot)
        XCTAssertEqual(draft.processingSpeed, "future-tier")
        XCTAssertTrue(draft.hasSameEditableValues(as: SettingsDraft(snapshot: snapshot)))
        XCTAssertEqual(draft.rebased(on: snapshot).processingSpeed, "future-tier")
        XCTAssertTrue(processingSpeedLabel("future-tier", legacyFast: false, locale: Locale(identifier: "en")).contains("future-tier"))
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
            "Terra · max"
        )
        XCTAssertEqual(
            DashboardExecutionPresentation.turnText(items[2].turn.execution),
            "Model · Reasoning unavailable"
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
            ),
            helloDelayNanoseconds: 200_000_000
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

        let startup = Task { @MainActor in await model.start() }
        for _ in 0..<50 {
            if client.helloCallCount > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        model.refreshAfterSystemEvent()
        await startup.value
        XCTAssertGreaterThanOrEqual(client.helloCallCount, 2)

        XCTAssertTrue(model.isRemoteClient)
        XCTAssertNil(model.helperStatus)
        XCTAssertEqual(model.remoteHello?.server.id, profile.serverId)
        XCTAssertNil(model.dashboard)
        XCTAssertEqual(client.dashboardCallCount, 0)
        XCTAssertNotNil(model.settings)
        XCTAssertTrue(model.bridgeConnected)

        model.setDashboardVisible(true)
        for _ in 0..<100 {
            if model.dashboard?.scope == "server-workroom" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(model.dashboard?.scope, "server-workroom")

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

        let runtimeStatusReads = client.runtimeStatusCallCount
        XCTAssertGreaterThan(runtimeStatusReads, 0)
        let didQuit = await model.shutdownApplication(force: false)
        XCTAssertTrue(didQuit)
        XCTAssertTrue(model.applicationShutdownCompleted)
        XCTAssertEqual(client.runtimeStatusCallCount, runtimeStatusReads)
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
        await model.refreshDashboard(enrich: false)
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
        XCTAssertNil(model.dashboard)
        XCTAssertEqual(old.dashboardCallCount, 0)

        let paired = await model.pairRemoteServer(
            invitation: "fresh-invitation", profileName: "서버", deviceName: "Mac"
        )
        XCTAssertTrue(paired)
        XCTAssertNil(model.dashboard)
        XCTAssertEqual(repaired.dashboardCallCount, 0)
        XCTAssertEqual(try credentials.credential(for: profile.serverId), "new-credential")
        XCTAssertEqual(old.factoryCallCount, 1)
        XCTAssertEqual(old.closeCallCount, 1)
        XCTAssertEqual(repaired.factoryCallCount, 1)
        XCTAssertEqual(repaired.closeCallCount, 0)

        let removed = await model.removeRemoteServer(profile.serverId)
        XCTAssertTrue(removed)
        XCTAssertNil(try credentials.credential(for: profile.serverId))
        XCTAssertEqual(model.activeRemoteProfile?.serverId, backupProfile.serverId)
        XCTAssertNil(model.dashboard)
        XCTAssertEqual(backup.dashboardCallCount, 0)
        XCTAssertEqual(repaired.closeCallCount, 1)
        XCTAssertEqual(backup.factoryCallCount, 1)

        model.setDashboardVisible(true)
        for _ in 0..<100 {
            if model.dashboard?.scope == "backup-server" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(model.dashboard?.scope, "backup-server")
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
        XCTAssertNil(model.dashboard)
        XCTAssertNotNil(model.settings)
        XCTAssertNil(model.connectionErrorMessage)

        model.setDashboardVisible(true)
        for _ in 0..<100 {
            if model.dashboard?.scope == "server-recovered" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(model.dashboard?.scope, "server-recovered")
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
    private let settingsAfterUpdate: SettingsSnapshot?
    private let modelDescriptionHistoryPage: ModelDescriptionHistoryPage?
    private let dashboardDelayNanoseconds: UInt64
    private let helloDelayNanoseconds: UInt64
    private let lock = NSLock()
    private var runtimeCalls = 0
    private var settingsUpdateCalls = 0
    private var latestSettingsMutation: SettingsMutation?
    private var latestHistoryModelID: String?
    private var latestHistoryBeforeVersion: Int?
    private var factoryCalls = 0
    private var closeCalls = 0
    private var remainingHelloFailures: Int
    private var helloCalls = 0
    private var dashboardCalls = 0

    init(
        profile: RemoteServerProfile,
        dashboard: DashboardSnapshot,
        settings: SettingsSnapshot,
        settingsAfterUpdate: SettingsSnapshot? = nil,
        modelDescriptionHistoryPage: ModelDescriptionHistoryPage? = nil,
        dashboardDelayNanoseconds: UInt64 = 0,
        helloFailures: Int = 0,
        helloDelayNanoseconds: UInt64 = 0
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
        self.settingsAfterUpdate = settingsAfterUpdate
        self.modelDescriptionHistoryPage = modelDescriptionHistoryPage
        self.dashboardDelayNanoseconds = dashboardDelayNanoseconds
        self.helloDelayNanoseconds = helloDelayNanoseconds
        remainingHelloFailures = helloFailures
    }

    var runtimeStatusCallCount: Int { lock.withLock { runtimeCalls } }
    var helloCallCount: Int { lock.withLock { helloCalls } }
    var dashboardCallCount: Int { lock.withLock { dashboardCalls } }
    var settingsUpdateCallCount: Int { lock.withLock { settingsUpdateCalls } }
    var lastSettingsMutation: SettingsMutation? { lock.withLock { latestSettingsMutation } }
    var lastModelDescriptionHistoryModelID: String? { lock.withLock { latestHistoryModelID } }
    var lastModelDescriptionHistoryBeforeVersion: Int? { lock.withLock { latestHistoryBeforeVersion } }
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
            helloCalls += 1
            guard remainingHelloFailures > 0 else { return false }
            remainingHelloFailures -= 1
            return true
        }
        if shouldFail { throw RemoteCompanionError.unauthorized }
        if helloDelayNanoseconds > 0 { try await Task.sleep(nanoseconds: helloDelayNanoseconds) }
        return helloValue
    }

    func dashboard(
        limit: Int,
        terminalOffset: Int,
        idleOffset: Int,
        enrich: Bool,
        statusFilter: DashboardStatusFilter
    ) async throws -> DashboardSnapshot {
        lock.withLock { dashboardCalls += 1 }
        if dashboardDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: dashboardDelayNanoseconds)
        }
        return dashboardValue
    }

    func settings(refreshModels: Bool, locale: String) async throws -> SettingsSnapshot {
        settingsValue
    }

    func updateSettings(_ mutation: SettingsMutation) async throws -> SettingsSnapshot {
        lock.withLock {
            settingsUpdateCalls += 1
            latestSettingsMutation = mutation
        }
        return settingsAfterUpdate ?? settingsValue
    }

    func modelDescriptionHistory(modelID: String, beforeVersion: Int?) async throws -> ModelDescriptionHistoryPage {
        lock.withLock {
            latestHistoryModelID = modelID
            latestHistoryBeforeVersion = beforeVersion
        }
        guard let modelDescriptionHistoryPage else {
            throw NSError(domain: "MODEL_DESCRIPTION_HISTORY_UNAVAILABLE", code: 1)
        }
        return modelDescriptionHistoryPage
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
    pid: Int = 42,
    phase: String = "running",
    bridgeConnected: Bool = true,
    tunnelConnected: Bool = true,
    configurationValid: Bool = true,
    bridgeObservation: String? = nil,
    bridgeLastSuccessfulAt: String? = nil,
    readServiceStatus: String? = nil,
    stateServiceStorageError: String? = nil,
    tunnelProbeFailed: Bool = false
) throws -> HelperStatus {
    let tunnelProblemJSON = tunnelProbeFailed ? ",\"lastProblem\":{\"code\":\"tunnel-health-probe-failed\",\"arguments\":{}}" : ""
    let bridgeObservationJSON = bridgeObservation.map { ",\"observation\":\"\($0)\"" } ?? ""
    let bridgeLastSuccessfulAtJSON = bridgeLastSuccessfulAt.map { ",\"lastSuccessfulAt\":\"\($0)\"" } ?? ""
    let readServiceStatusJSON = readServiceStatus.map { ",\"readServiceStatus\":\"\($0)\"" } ?? ""
    let stateServiceStorageErrorJSON = stateServiceStorageError.map {
        ",\"stateServiceStatus\":\"state-recovering\",\"stateServiceStorageError\":\"\($0)\""
    } ?? ""
    let json = #"""
    {
      "kind":"helper-status","generatedAt":"2026-09-03T00:00:00.000Z",
      "phase":"\#(phase)","pid":\#(pid),"startedAt":null,"lastExit":null,"lastError":null,
      "restartAttempt":0,
      "configuration":{"path":"/private/.env","exists":true,"valid":\#(configurationValid),"hasApiKey":true,"hasTunnelId":true,"tunnelId":"tunnel_native123","issue":null},
      "bridge":{"socketPath":"/private/bridge.sock","connected":\#(bridgeConnected)\#(bridgeObservationJSON)\#(bridgeLastSuccessfulAtJSON)\#(readServiceStatusJSON)\#(stateServiceStorageErrorJSON),"acceptingNewJobs":true,"activeJobs":0,"pendingAdmissions":0,"backgroundProcessState":"confirmed","backgroundProcesses":0,"backgroundProcessAgents":0,"backgroundProcessUnknownAgents":0},
      "tunnel":{"phase":"connected","profile":"managed","transport":"stdio","doctorPassed":true,"processRunning":true,"connected":\#(tunnelConnected),"lastCheckedAt":null,"lastError":null\#(tunnelProblemJSON)}
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

private func issue242Dashboard(_ row: DashboardRow, scope: String) throws -> DashboardSnapshot {
    var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(dashboardStatus(scope: scope))) as! [String: Any]
    value["terminalRows"] = [try JSONSerialization.jsonObject(with: JSONEncoder().encode(row))]
    return try JSONDecoder().decode(DashboardSnapshot.self, from: JSONSerialization.data(withJSONObject: value))
}

private func issue242Settings(registry: Int, id: String?, name: String, cwd: String, archived: Bool = false) throws -> SettingsSnapshot {
    let base = try settingsSnapshot(policy: ["mode": "automatic", "allowedSelections": ["kind": "catalog-visible"],
        "constraints": ["allowDelegation": true]], catalogModels: [])
    var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(base)) as! [String: Any]
    var settings = value["settings"] as! [String: Any]
    settings["registryRevision"] = registry
    settings["projects"] = id.map { identity in [["id": identity, "projectRef": "fixture-\(identity)", "projectRevision": registry,
        "name": name, "nameKey": name.lowercased(), "cwd": cwd, "sortOrder": 0, "createdAt": 1, "updatedAt": 2,
        "archiveState": archived ? "complete" : "active", "archiveRevision": archived ? 1 : 0] as [String: Any]] } ?? []
    value["settings"] = settings
    return try JSONDecoder().decode(SettingsSnapshot.self, from: JSONSerialization.data(withJSONObject: value))
}

private func issue242Row(_ identity: String, project: String) throws -> DashboardRow {
    let row: [String: Any] = ["rowKey": String(repeating: identity, count: 32), "activityKey": "fixture",
        "conversationKey": "fixture", "sessionAlias": "Fixture", "bucket": "recent", "projectKey": String(repeating: identity, count: 32),
        "projectName": project, "agentName": "Fixture", "status": "completed", "createdAt": "2026-10-07T00:00:00Z",
        "updatedAt": "2026-10-07T00:00:01Z", "elapsedMs": 1000, "backgroundProcessCount": 0,
        "history": [], "historyCount": 1, "historyRevision": String(repeating: "a", count: 64)]
    return try JSONDecoder().decode(DashboardRow.self, from: JSONSerialization.data(withJSONObject: row))
}

private func dashboardStatus(
    runtimeUnknownAgents: Int = 0,
    scope: String = "bridge-wide",
    countOverrides: [String: Int] = [:]
) throws -> DashboardSnapshot {
    var counts: [String: Any] = [
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
    for (key, value) in countOverrides { counts[key] = value }
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
    experimentalDirectResultDelivery: Bool = false,
    policy: [String: Any],
    legacyPreferredModel: String? = nil,
    modelDescriptionOverrides: [String: String]? = nil,
    modelDescriptionHistoryModelIds: [String]? = nil,
    catalogModels: [[String: Any]],
    operatorCeiling: [ModelChoice]? = nil,
    processingSpeed: String? = nil,
    usePriorityServiceTier: Bool = false,
    availableProcessingSpeeds: [String]? = nil
) throws -> SettingsSnapshot {
    var settings: [String: Any] = [
        "schemaVersion": 1,
        "settingsRevision": settingsRevision,
        "registryRevision": 2,
        "revision": settingsRevision,
        "accessStrategy": accessStrategy,
        "modelPolicy": policy,
        "usePriorityServiceTier": usePriorityServiceTier,
        "projects": [],
        "uiLocalePreference": "auto",
        "maxConcurrentJobs": 2,
        "showBridgeThreadsInCodexApp": showBridgeThreadsInCodexApp,
        "experimentalDirectResultDelivery": experimentalDirectResultDelivery
    ]
    if let legacyPreferredModel {
        settings["legacyPreferredModel"] = legacyPreferredModel
    }
    if let modelDescriptionOverrides {
        settings["modelDescriptionOverrides"] = modelDescriptionOverrides
    }
    if let processingSpeed { settings["processingSpeed"] = processingSpeed }
    var capabilities: [String: Any] = [
        "availableAccessStrategies": ["read-only", "adaptive"],
        "availableUiLocalePreferences": ["auto", "ko", "en"],
        "projectAvailability": [],
        "maxConcurrentJobs": 4,
        "defaultBackend": "app-server",
        "allowWorkspaceWrite": true,
        "allowDangerFullAccess": false,
        "persistent": true
    ]
    if let availableProcessingSpeeds { capabilities["availableProcessingSpeeds"] = availableProcessingSpeeds }
    if let operatorCeiling {
        capabilities["operatorModelCeiling"] = operatorCeiling.map(choiceObject)
    }
    var object: [String: Any] = [
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
    if let modelDescriptionHistoryModelIds {
        object["modelDescriptionHistoryModelIds"] = modelDescriptionHistoryModelIds
    }
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
    isCurrent: Bool,
    serviceTier: String? = nil,
    processingSpeed: String? = nil,
    serviceTierScope: String? = nil,
    requestState: String? = nil
) throws -> DashboardExecution {
    var object: [String: Any] = [
        "model": model,
        "reasoningEffort": effort,
        "isCurrent": isCurrent
    ]
    if let displayName { object["modelDisplayName"] = displayName }
    if let serviceTier { object["serviceTier"] = serviceTier }
    if let processingSpeed { object["processingSpeed"] = processingSpeed }
    if let serviceTierScope { object["serviceTierScope"] = serviceTierScope }
    if let requestState { object["requestState"] = requestState }
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

extension AppPresentationTests {
    @MainActor
    func testOlderSettingsSuccessCannotReplaceNewerRevision() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-audit-settings-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let policy: [String: Any] = ["mode": "fixed", "selection": ["model": "fixture-model", "reasoningEffort": "high"], "constraints": ["allowDelegation": true]]
        let older = String(decoding: try JSONEncoder().encode(settingsSnapshot(settingsRevision: 4, accessStrategy: "read-only", policy: policy, catalogModels: [])), as: UTF8.self)
        let newer = String(decoding: try JSONEncoder().encode(settingsSnapshot(settingsRevision: 5, accessStrategy: "adaptive", policy: policy, catalogModels: [])), as: UTF8.self)
        let replies = TestDashboardReplySequence([
            NativeFixtureReply(body: "{\"result\":\(older)}", delay: 0.4),
            NativeFixtureReply(body: "{\"result\":\(newer)}")
        ])
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { _ in replies.next() }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        let early = Task { await model.refreshSettings() }
        for _ in 0..<50 {
            if bridge.count("settings.snapshot") > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        await model.refreshSettings()
        XCTAssertEqual(model.settings?.settings.settingsRevision, 5)
        await early.value
        XCTAssertEqual(model.settings?.settings.settingsRevision, 5)
        XCTAssertEqual(model.settings?.settings.accessStrategy, "adaptive")
    }

    @MainActor
    func testOlderSettingsFailureCannotReplaceNewerSuccess() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-audit-error-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let policy: [String: Any] = ["mode": "fixed", "selection": ["model": "fixture-model", "reasoningEffort": "high"], "constraints": ["allowDelegation": true]]
        let newer = String(decoding: try JSONEncoder().encode(settingsSnapshot(settingsRevision: 5, policy: policy, catalogModels: [])), as: UTF8.self)
        let replies = TestDashboardReplySequence([
            NativeFixtureReply(body: #"{"error":{"code":-32603,"message":"outdated request failed"}}"#, delay: 0.4),
            NativeFixtureReply(body: "{\"result\":\(newer)}")
        ])
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { _ in replies.next() }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        let early = Task { await model.refreshSettings() }
        for _ in 0..<50 {
            if bridge.count("settings.snapshot") > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        await model.refreshSettings()
        XCTAssertNil(model.settingsLoadErrorMessage)
        await early.value
        XCTAssertEqual(model.settings?.settings.settingsRevision, 5)
        XCTAssertNil(model.settingsLoadErrorMessage)
    }
}


extension AppPresentationTests {
    @MainActor
    func testSettingsReadCannotReplaceCompletedSave() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-save-read-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let policy: [String: Any] = ["mode": "fixed", "selection": ["model": "fixture-model", "reasoningEffort": "high"], "constraints": ["allowDelegation": true]]
        let before = try settingsSnapshot(settingsRevision: 4, accessStrategy: "read-only", policy: policy, catalogModels: [])
        let older = String(decoding: try JSONEncoder().encode(before), as: UTF8.self)
        let newer = String(decoding: try JSONEncoder().encode(settingsSnapshot(settingsRevision: 5, policy: policy, catalogModels: [])), as: UTF8.self)
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            NativeFixtureReply(body: "{\"result\":\(method == "settings.update" ? newer : older)}", delay: method == "settings.snapshot" ? 0.4 : 0)
        }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        model.settings = before
        let read = Task { await model.refreshSettings() }
        for _ in 0..<50 {
            if bridge.count("settings.snapshot") > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let saved = await model.resetGeneralSettings()
        XCTAssertTrue(saved)
        await read.value
        XCTAssertEqual(model.settings?.settings.settingsRevision, 5)
        // Even a later request must not lower a confirmed revision.
        await model.refreshSettings()
        XCTAssertEqual(model.settings?.settings.settingsRevision, 5)
        XCTAssertNil(model.settingsLoadErrorMessage)
    }

    @MainActor
    func testDashboardEnrichmentFailureRemainsVisibleUntilRecovery() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-enrich-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let snapshot = String(decoding: try JSONEncoder().encode(dashboardStatus()), as: UTF8.self)
        let healthy = NativeFixtureReply(body: "{\"result\":\(snapshot)}")
        let replies = TestDashboardReplySequence([healthy,
            NativeFixtureReply(body: #"{"error":{"code":-32603,"message":"supplemental read unavailable"}}"#), healthy, healthy, healthy])
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { _ in replies.next() }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        await model.refreshDashboard()
        for _ in 0..<50 {
            if model.dashboardEnrichmentFailed { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(model.dashboardEnrichmentFailed)
        XCTAssertNotNil(model.dashboard)
        XCTAssertNil(model.dashboardErrorMessage)
        await model.refreshDashboard(enrich: false)
        XCTAssertTrue(model.dashboardEnrichmentFailed)
        await model.refreshDashboard()
        for _ in 0..<50 {
            if !model.dashboardEnrichmentFailed { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(model.dashboardEnrichmentFailed)
    }
}


final class ConnectionObservationRecoveryTests: XCTestCase {
    @MainActor
    func testDeferredMenuReadCompletesAfterLocalConnectionRecovery() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-deferred-menu-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let failure = try helperStatus(bridgeConnected: false)
        let status = String(decoding: try JSONEncoder().encode(failure), as: UTF8.self)
        let snapshot = String(decoding: try JSONEncoder().encode(dashboardStatus(scope: "deferred-menu")), as: UTF8.self)
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { method in
            NativeFixtureReply(body: method == "helper.health"
                ? "{\"result\":\(status)}"
                : #"{"error":{"code":-32601,"message":"unsupported"}}"#)
        }
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            NativeFixtureReply(body: method == "dashboard.snapshot"
                ? "{\"result\":\(snapshot)}"
                : #"{"error":{"code":-32601,"message":"unsupported"}}"#)
        }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); helper.stop(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        let now = Date()
        model.recordLocalConnectionStatus(failure, at: now.addingTimeInterval(-9))
        model.recordLocalConnectionStatus(failure, at: now)
        model.setDashboardVisible(true)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(helper.count("helper.health"), 1)
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 0)
        XCTAssertFalse(model.bridgeConnected)

        // The watchdog/change handler receives a fresh healthy observation,
        // after the menu's original read already skipped the unavailable server.
        model.recordLocalConnectionStatus(try helperStatus())
        for _ in 0..<100 {
            if model.dashboard?.scope == "deferred-menu" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(model.bridgeConnected)
        XCTAssertEqual(model.dashboard?.scope, "deferred-menu")
        XCTAssertGreaterThan(bridge.count("dashboard.snapshot"), 0)

        try await Task.sleep(for: .milliseconds(300))
        let completedReads = bridge.count("dashboard.snapshot")
        model.recordLocalConnectionStatus(failure)
        model.recordLocalConnectionStatus(try helperStatus())
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(bridge.count("dashboard.snapshot"), completedReads,
                       "Recovery must not start another Dashboard refresh once the requested read completed.")

        model.recordLocalConnectionStatus(failure)
        await model.refreshDashboard(enrich: false)
        model.recordLocalConnectionStatus(try helperStatus())
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(bridge.count("dashboard.snapshot"), completedReads + 1,
                       "A deferred structural refresh must not add an enrichment request.")

        model.recordLocalConnectionStatus(failure)
        await model.refreshDashboard(enrich: false)
        model.setDashboardVisible(false)
        model.recordLocalConnectionStatus(try helperStatus())
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(bridge.count("dashboard.snapshot"), completedReads + 1,
                       "Closing the menu must discard its deferred read.")
    }

    @MainActor
    func testDeferredMenuReadCompletesAfterRemoteConnectionRecovery() async throws {
        let profile = remoteProfile(id: "33333333-3333-4333-8333-333333333333", name: "복구 서버")
        let client = TestRemoteClient(
            profile: profile,
            dashboard: try dashboardStatus(scope: "deferred-remote-menu"),
            settings: try settingsSnapshot(
                policy: ["mode": "automatic", "allowedSelections": ["kind": "catalog-visible"],
                         "constraints": ["allowDelegation": true]],
                catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
            ),
            helloFailures: 2
        )
        let model = AppModel(
            loginItemController: TestLoginItemController(status: .notRegistered),
            connectionStore: TestConnectionStore(BridgeConnectionPreferences(
                mode: .remoteClient, activeServerId: profile.serverId, profiles: [profile]
            )),
            credentialStore: TestCredentialStore([profile.serverId: "device_fixture"]),
            remoteClientFactory: { _, _ in client }
        )
        defer { model.cancelAllPolling() }
        await model.refreshStatus()
        model.setDashboardVisible(true)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(client.helloCallCount, 2)
        XCTAssertEqual(client.dashboardCallCount, 0)
        XCTAssertFalse(model.bridgeConnected)

        // Same status-only observation used by wake and the ten-second watchdog.
        await model.refreshStatus()
        for _ in 0..<100 {
            if model.dashboard?.scope == "deferred-remote-menu" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(model.bridgeConnected)
        XCTAssertEqual(model.dashboard?.scope, "deferred-remote-menu")
        XCTAssertGreaterThan(client.dashboardCallCount, 0)
    }

    @MainActor
    func testFailedObservationDoesNotClaimTheServerStopped() throws {
        let model = AppModel()
        defer { model.cancelAllPolling() }
        let failure = try helperStatus(bridgeConnected: false)
        let start = Date()
        model.recordLocalConnectionStatus(failure, at: start)
        XCTAssertEqual(model.health, .checking)
        model.recordLocalConnectionStatus(failure, at: start.addingTimeInterval(9))
        XCTAssertEqual(model.health, .unavailable)
        XCTAssertEqual(model.helperStatus?.phase, "running")
        XCTAssertFalse(model.runtimeUnavailableExplanation.contains("중지되었습니다"))
        XCTAssertNil(model.helperStatusErrorMessage)
        XCTAssertNil(model.runtimeErrorMessage)
        XCTAssertNil(model.statusErrorMessage)
        XCTAssertNil(model.connectionErrorMessage)
    }

    @MainActor
    func testSleepKeepsMenuCheckingUntilAFreshObservation() throws {
        let model = AppModel()
        defer { model.cancelAllPolling() }
        model.recordLocalConnectionStatus(try helperStatus(bridgeConnected: false))
        XCTAssertEqual(model.health, .checking)
        model.prepareForSystemSleep()
        XCTAssertEqual(model.operationalObservation, .unknown)
        XCTAssertFalse(model.localConnectionRecovery.isChecking)
        XCTAssertEqual(model.health, .checking)
    }

    @MainActor
    func testObservationGapReschedulesTheExpiryForTheFreshWindow() async throws {
        let model = AppModel()
        defer { model.cancelAllPolling() }
        let failure = try helperStatus(bridgeConnected: false)
        let start = Date()
        model.recordLocalConnectionStatus(failure, at: start)
        try await Task.sleep(for: .seconds(7))
        // Simulate an observation gap without willSleep, as distinct from a
        // system sleep that calls prepareForSystemSleep and cancels the timer.
        let resumed = start.addingTimeInterval(60)
        model.recordLocalConnectionStatus(failure, at: resumed)
        XCTAssertTrue(model.localConnectionRecovery.isChecking)
        try await Task.sleep(for: .milliseconds(1300))
        XCTAssertTrue(model.localConnectionRecovery.isChecking)
        XCTAssertEqual(model.health, .checking)
        var expectedWindow = ConnectionRecoveryWindow()
        expectedWindow.observe(available: false, retryable: true, at: resumed)
        expectedWindow.observe(available: false, retryable: true, at: resumed.addingTimeInterval(1.3))
        XCTAssertTrue(expectedWindow.isChecking)
    }

    @MainActor
    func testWindowEntryRecoveryRefreshesDashboardImmediately() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-wake-rpc-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let status = String(decoding: try JSONEncoder().encode(helperStatus()), as: UTF8.self)
        let dashboard = String(decoding: try JSONEncoder().encode(dashboardStatus(scope: "recovered")), as: UTF8.self)
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { method in
            if method == "helper.health" { return NativeFixtureReply(body: "{\"result\":\(status)}", delay: 0.6) }
            if method == "auth.status" { return NativeFixtureReply(body: #"{"result":{"installed":true,"authenticated":true,"summary":"ready"}}"#) }
            return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#)
        }
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            if method == "dashboard.snapshot" { return NativeFixtureReply(body: "{\"result\":\(dashboard)}") }
            return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#)
        }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); helper.stop(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        let now = Date()
        model.recordLocalConnectionStatus(try helperStatus(bridgeConnected: false), at: now.addingTimeInterval(-9))
        model.recordLocalConnectionStatus(try helperStatus(bridgeConnected: false), at: now)
        XCTAssertFalse(model.isBridgeConnectionChecking)
        model.setDashboardVisible(true)
        try await Task.sleep(for: .milliseconds(2200))
        XCTAssertTrue(model.bridgeConnected)
        XCTAssertGreaterThan(bridge.count("dashboard.snapshot"), 0)
        XCTAssertEqual(model.dashboard?.scope, "recovered")
    }
}


private final class RecoveryQuietChanges: @unchecked Sendable {
    private let lock = NSLock()
    private var reads = 0
    func reply() -> NativeFixtureReply {
        let n = lock.withLock { reads += 1; return reads }
        return NativeFixtureReply(body: n == 1
            ? #"{"result":{"revision":"quiet:0","topics":["dashboard","settings"]}}"#
            : #"{"result":{"revision":"quiet:0","topics":[]}}"#,
            delay: n == 1 ? 0 : 25)
    }
}

extension ConnectionObservationRecoveryTests {
    @MainActor
    func testExplicitWindowEntryRefreshesDashboardWithAnExistingQuietSubscription() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-wake-sub-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let status = String(decoding: try JSONEncoder().encode(helperStatus()), as: UTF8.self)
        let snapshot = String(decoding: try JSONEncoder().encode(dashboardStatus(scope: "live-subscription")), as: UTF8.self)
        let changes = RecoveryQuietChanges()
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { method in
            if method == "helper.health" { return NativeFixtureReply(body: "{\"result\":\(status)}", delay: 0.6) }
            if method == "auth.status" { return NativeFixtureReply(body: #"{"result":{"installed":true,"authenticated":true,"summary":"ready"}}"#) }
            return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#)
        }
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            if method == "changes.wait" { return changes.reply() }
            if method == "dashboard.snapshot" { return NativeFixtureReply(body: "{\"result\":\(snapshot)}") }
            return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#)
        }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); helper.stop(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        model.setDashboardVisible(true)
        try await Task.sleep(for: .milliseconds(2200))
        XCTAssertTrue(model.companionChangesAvailable)
        XCTAssertEqual(model.dashboard?.scope, "live-subscription")
        let baseline = bridge.count("dashboard.snapshot")
        XCTAssertEqual(baseline, 2)
        let now = Date()
        model.recordLocalConnectionStatus(try helperStatus(bridgeConnected: false), at: now.addingTimeInterval(-9))
        model.recordLocalConnectionStatus(try helperStatus(bridgeConnected: false), at: now)
        await model.refreshDashboard(enrich: false)
        XCTAssertNil(model.dashboard)
        // A fresh window-entry intent waits for the status observation and then
        // performs its own Dashboard read. Recovery alone does not request it.
        model.setDashboardVisible(true)
        try await Task.sleep(for: .milliseconds(1500))
        XCTAssertTrue(model.bridgeConnected)
        XCTAssertTrue(model.companionChangesAvailable)
        XCTAssertGreaterThan(bridge.count("dashboard.snapshot"), baseline)
        XCTAssertEqual(model.dashboard?.scope, "live-subscription")
    }
}


extension ConnectionObservationRecoveryTests {
    @MainActor
    func testStructuralRefreshPreservesAnUnfinishedEnrichment() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-continue-details-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        func reply(_ scope: String, delay: TimeInterval = 0) throws -> NativeFixtureReply {
            let snapshot = String(decoding: try JSONEncoder().encode(dashboardStatus(scope: scope)), as: UTF8.self)
            return NativeFixtureReply(body: "{\"result\":\(snapshot)}", delay: delay)
        }
        let replies = try TestDashboardReplySequence([
            reply("initial"), reply("obsolete-enrichment", delay: 0.6),
            reply("structural-refresh"), reply("current-enrichment")
        ])
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { _ in replies.next() }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        await model.refreshDashboard()
        for _ in 0..<50 {
            if bridge.count("dashboard.snapshot") == 2 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 2)
        await model.refreshDashboard(enrich: false)
        for _ in 0..<50 {
            if model.dashboard?.scope == "current-enrichment" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(model.dashboard?.scope, "current-enrichment")
        try await Task.sleep(for: .milliseconds(650))
        XCTAssertEqual(model.dashboard?.scope, "current-enrichment")
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 4)
    }

    @MainActor
    func testLateEnrichmentNoticeStaysCachedUntilExplicitWindowRefresh() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-late-details-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let status = String(decoding: try JSONEncoder().encode(helperStatus()), as: UTF8.self)
        let base = String(decoding: try JSONEncoder().encode(dashboardStatus()), as: UTF8.self)
        var pending = try JSONSerialization.jsonObject(with: Data(base.utf8)) as! [String: Any]
        pending["enrichment"] = ["state": "enriched", "runtimeRequests": 0, "cacheHits": 0, "timeouts": 0,
                                  "durationMs": 1500, "usageTimedOut": true, "pendingReads": 1,
                                  "oldestObservationAt": "2026-09-09T00:00:00.000Z"]
        let pendingBody = String(decoding: try JSONSerialization.data(withJSONObject: pending), as: UTF8.self)
        pending["enrichment"] = ["state": "structural", "runtimeRequests": 0, "cacheHits": 0, "timeouts": 0,
                                  "durationMs": 0, "usageTimedOut": false, "pendingReads": 0]
        let completeBody = String(decoding: try JSONSerialization.data(withJSONObject: pending), as: UTF8.self)
        let healthy = NativeFixtureReply(body: "{\"result\":\(completeBody)}")
        let snapshots = TestDashboardReplySequence([healthy, NativeFixtureReply(body: "{\"result\":\(pendingBody)}"), healthy])
        let changes = TestDashboardReplySequence([
            NativeFixtureReply(body: #"{"result":{"revision":"late:0","topics":[]}}"#),
            NativeFixtureReply(body: #"{"result":{"revision":"late:1","topics":["enrichment"]}}"#, delay: 1),
            NativeFixtureReply(body: #"{"result":{"revision":"late:1","topics":[]}}"#, delay: 25)
        ])
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { method in
            if method == "helper.health" { return NativeFixtureReply(body: "{\"result\":\(status)}") }
            return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#)
        }
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            if method == "changes.wait" { return changes.next() }
            return snapshots.next()
        }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); helper.stop(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
        model.recordLocalConnectionStatus(try helperStatus())
        model.setDashboardVisible(true)
        for _ in 0..<40 {
            if model.dashboardEnrichmentPending { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(model.dashboardEnrichmentPending)
        XCTAssertFalse(model.dashboardEnrichmentFailed)
        XCTAssertNotNil(model.dashboardObservationDate)
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertTrue(model.dashboardEnrichmentPending)
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 2)

        model.setDashboardVisible(false)
        model.setDashboardVisible(true)
        for _ in 0..<100 {
            if !model.dashboardEnrichmentPending { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(model.dashboardEnrichmentPending)
        XCTAssertFalse(model.dashboardEnrichmentFailed)
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 3)
    }
}


extension AppPresentationTests {
    @MainActor
    func testProblemBulkReviewCollectsEveryPageBeforeWritingAndRejectsChangedLists() async throws {
        for (changesDuringPaging, automaticViews) in [(false, false), (true, false), (false, true), (true, true)] {
            let root = URL(fileURLWithPath: "/tmp/cb-problems-\(UUID().uuidString.prefix(8))")
            let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
            try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
            let base = String(decoding: try JSONEncoder().encode(dashboardStatus()), as: UTF8.self)
            let state = ProblemPagingFixture(base: base, changesDuringPaging: changesDuringPaging, automaticViews: automaticViews)
            let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path, requestReply: { method, params in state.reply(method, params) })
            let model = AppModel(paths: paths)
            defer { model.cancelAllPolling(); bridge.stop(); try? FileManager.default.removeItem(at: root) }
            model.recordLocalConnectionStatus(try helperStatus())
            await model.refreshDashboard(enrich: false)
            if automaticViews {
                XCTAssertEqual(model.dashboard?.problems?.pendingCount, 0)
                await model.selectProblemQuery(view: .history)
                XCTAssertEqual(model.dashboard?.problems?.historyCount, 112)
            }
            await model.acknowledgeAllFinishedProblems()
            XCTAssertEqual(state.bulkHistoryReadCount, 0)
            if changesDuringPaging {
                XCTAssertEqual(state.batches, [])
                XCTAssertNotNil(model.dashboardErrorMessage)
            } else {
                XCTAssertEqual(state.batches, [100, 12])
                XCTAssertEqual(state.reviewedCount, 112)
                XCTAssertNotNil(model.problemActionNotice)
                if automaticViews {
                    await model.selectProblemQuery(view: .history)
                    XCTAssertEqual(model.dashboard?.problems?.pendingCount, 0)
                    XCTAssertEqual(model.dashboard?.problems?.historyCount, 112)
                } else { await model.selectProblemQuery(review: .acknowledged) }
                XCTAssertEqual(model.dashboard?.problems?.acknowledgedCount, 112)
                let problem = try XCTUnwrap(model.dashboard?.problems?.rows.first)
                XCTAssertEqual(problem.row.status, "failed")
                await model.changeProblem(problem, action: .unacknowledge)
                XCTAssertEqual(state.reviewedCount, 111)
                XCTAssertFalse(model.changingProblems)
            }
        }
    }
}

private final class ProblemPagingFixture: @unchecked Sendable {
    private let lock = NSLock()
    private let base: String
    private let changesDuringPaging: Bool
    private let automaticViews: Bool
    private var reviewed = Set<String>()
    private var recordedBatches: [Int] = []
    private var bulkHistoryReads = 0
    var batches: [Int] { lock.withLock { recordedBatches } }
    var reviewedCount: Int { lock.withLock { reviewed.count } }
    var bulkHistoryReadCount: Int { lock.withLock { bulkHistoryReads } }
    init(base: String, changesDuringPaging: Bool, automaticViews: Bool) {
        self.base = base; self.changesDuringPaging = changesDuringPaging; self.automaticViews = automaticViews
    }
    func reply(_ method: String, _ params: String) -> NativeFixtureReply {
        lock.withLock {
            do {
                if method == "dashboard.problem" {
                    let action = try JSONDecoder().decode(ProblemAction.self, from: Data(params.utf8))
                    if action.action == .acknowledge {
                        recordedBatches.append(action.targets.count)
                        for target in action.targets { reviewed.insert(target.problemKey) }
                    } else if action.action == .unacknowledge {
                        for target in action.targets { reviewed.remove(target.problemKey) }
                    }
                    return NativeFixtureReply(body: "{\"result\":{\"ok\":true,\"changed\":\(action.targets.count)}}")
                }
                guard method == "dashboard.snapshot" else {
                    return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#)
                }
                let args = try JSONSerialization.jsonObject(with: Data(params.utf8)) as! [String: Any]
                let query = args["problems"] as? [String: Any] ?? [:]
                let review = query["review"] as? String ?? "pending"
                let view = query["view"] as? String ?? "actionable"
                let limit = args["limit"] as? Int ?? 12
                if limit == 50, (args["includeHistory"] as? Bool) != false { bulkHistoryReads += 1 }
                let offset = query["offset"] as? Int ?? 0
                let ids = (1...112).map { String(format: "%032x", $0) }.filter {
                    automaticViews ? view == "history" : reviewed.contains($0) == (review == "acknowledged")
                }
                let selected = Array(ids.dropFirst(offset).prefix(limit))
                let rows: [[String: Any]] = selected.map { id in
                    let entryReview = reviewed.contains(id) ? "acknowledged" : "pending"
                    return ["problemKey": id, "revision": String(repeating: "a", count: 64), "kind": "failed", "source": "execution", "review": entryReview,
                     "observedAt": "2026-09-09T01:00:00Z", "canAcknowledge": entryReview == "pending", "canUnacknowledge": entryReview == "acknowledged", "canRecheck": false, "canRetryStop": false,
                     "row": ["rowKey": id, "activityKey": id, "conversationKey": id, "sessionAlias": "Session A", "bucket": "recent", "projectKey": id,
                             "agentName": "Repeated Agent", "status": "failed", "createdAt": "2026-09-09T01:00:00Z", "updatedAt": "2026-09-09T01:00:01Z", "elapsedMs": 1000, "backgroundProcessCount": 0]]
                }
                var snapshot = try JSONSerialization.jsonObject(with: Data(base.utf8)) as! [String: Any]
                if automaticViews {
                    snapshot["historyPolicy"] = ["retentionDays": 30, "issueAttentionDays": 7, "lastCleanupCount": 0,
                                                   "totalRemoved": 0, "reviewUntilRetention": true, "automaticRecovery": true]
                }
                snapshot["problems"] = ["query": query,
                    "revision": changesDuringPaging && offset > 0 ? "changed" : "stable", "pendingCount": automaticViews ? 0 : 112 - reviewed.count,
                    "historyCount": 112,
                    "acknowledgedCount": reviewed.count, "reviewableCount": 112 - reviewed.count, "rows": rows,
                    "page": ["offset": offset, "limit": limit, "total": ids.count, "returned": selected.count, "hasPrevious": offset > 0, "hasNext": offset + selected.count < ids.count]]
                let data = try JSONSerialization.data(withJSONObject: ["result": snapshot])
                return NativeFixtureReply(body: String(decoding: data, as: UTF8.self))
            } catch {
                return NativeFixtureReply(body: #"{"error":{"code":-32603,"message":"fixture failure"}}"#)
            }
        }
    }
}
