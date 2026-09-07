import XCTest
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

@MainActor
final class OperationalNotificationsTests: XCTestCase {
    private let origin = Date(timeIntervalSince1970: 1_000)
    private let scope = OperationalNotificationPolicy.scope("fixture-server")

    func testGraceTransientRecoveryAndRestartDedupe() throws {
        var policy = OperationalNotificationPolicy()
        XCTAssertNil(policy.observe(.problem(.tunnel), scope: scope, now: origin))
        XCTAssertNil(policy.observe(.healthy, scope: scope, now: origin.addingTimeInterval(30)))
        XCTAssertNil(policy.observe(.problem(.tunnel), scope: scope, now: origin.addingTimeInterval(50)))
        XCTAssertNil(policy.observe(.problem(.tunnel), scope: scope, now: origin.addingTimeInterval(80)))
        XCTAssertEqual(policy.observe(.problem(.tunnel), scope: scope, now: origin.addingTimeInterval(110)), .tunnel)
        policy.markDelivered(scope: scope, problem: .tunnel)
        policy = try JSONDecoder().decode(OperationalNotificationPolicy.self, from: JSONEncoder().encode(policy))
        XCTAssertNil(policy.observe(.unknown, scope: scope, now: origin.addingTimeInterval(120)))
        XCTAssertNil(policy.observe(.problem(.tunnel), scope: scope, now: origin.addingTimeInterval(180)))
        XCTAssertNil(policy.observe(.healthy, scope: scope, now: origin.addingTimeInterval(190)))
        XCTAssertNil(policy.observe(.healthy, scope: scope, now: origin.addingTimeInterval(250)))
        XCTAssertNil(policy.observe(.problem(.tunnel), scope: scope, now: origin.addingTimeInterval(260)))
        XCTAssertEqual(policy.observe(.problem(.tunnel), scope: scope, now: origin.addingTimeInterval(320)), .tunnel)
    }

    func testDeniedPermissionPreferencesDeliveryFailureAndPersistence() async throws {
        let suite = "bridge-notifications-test-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let delivery = NotificationDeliveryFixture()
        var controller = OperationalNotifications(defaults: defaults, delivery: delivery)
        func refresh(_ time: Double, problem: OperationalProblem = .runtime) async {
            await controller.refresh(observation: .problem(problem), scope: scope,
                locale: Locale(identifier: "ko"), now: origin.addingTimeInterval(time))
        }
        XCTAssertTrue(controller.bridgeEnabled)
        XCTAssertTrue(controller.securityEnabled)
        await refresh(0)
        await refresh(60)
        XCTAssertTrue(delivery.sent.isEmpty)
        XCTAssertEqual(controller.actionRequired, .runtime)
        delivery.authorized = true
        controller.bridgeEnabled = false
        await refresh(70)
        XCTAssertTrue(delivery.sent.isEmpty)
        controller.bridgeEnabled = true
        delivery.fail = true
        await refresh(80)
        XCTAssertTrue(delivery.sent.isEmpty)
        delivery.fail = false
        await refresh(90)
        XCTAssertEqual(delivery.sent, [.runtime])
        controller = OperationalNotifications(defaults: defaults, delivery: delivery)
        await refresh(100)
        XCTAssertEqual(delivery.sent, [.runtime])
        controller.bridgeEnabled = false
        await refresh(110, problem: .remoteSecurity)
        await refresh(170, problem: .remoteSecurity)
        XCTAssertEqual(delivery.sent, [.runtime, .remoteSecurity])
        controller = OperationalNotifications(defaults: defaults, delivery: delivery)
        XCTAssertFalse(controller.bridgeEnabled)
        XCTAssertTrue(controller.securityEnabled)
        XCTAssertEqual(delivery.identifiers.count, Set(delivery.identifiers).count)
    }

    func testOperationalClassificationIgnoresTaskEventsAndManualOperations() throws {
        let model = AppModel()
        func helper(phase: String = "running", valid: Bool = true, bridge: Bool = true, tunnel: Bool = true) throws -> HelperStatus {
            let json = #"""
            {"kind":"helper-status","generatedAt":"2026-09-06T00:00:00Z","phase":"\#(phase)","restartAttempt":0,
            "configuration":{"path":"/private/secret","exists":true,"valid":\#(valid),"hasApiKey":true,"hasTunnelId":true},
            "bridge":{"socketPath":"/private/socket","connected":\#(bridge)},
            "tunnel":{"phase":"connected","doctorPassed":true,"processRunning":true,"connected":\#(tunnel)}}
            """#
            return try JSONDecoder().decode(HelperStatus.self, from: Data(json.utf8))
        }
        func auth(installed: Bool = true, authenticated: Bool = true) throws -> CodexLoginStatus {
            try JSONDecoder().decode(CodexLoginStatus.self, from: JSONSerialization.data(withJSONObject:
                ["installed": installed, "authenticated": authenticated, "summary": "private-fixture"]))
        }
        XCTAssertEqual(model.operationalObservation, .unknown)
        model.helperStatus = try helper()
        model.authStatus = try auth()
        XCTAssertEqual(model.operationalObservation, .healthy)
        // Codex job failures and input-required events only update the dashboard. They cannot enter this policy.
        for taskState in ["completed", "failed", "cancelled", "needs-attention", "input-required", "approval-required"] {
            model.dashboardErrorMessage = taskState
            XCTAssertEqual(model.operationalObservation, .healthy)
        }
        model.helperStatus = try helper(tunnel: false)
        XCTAssertEqual(model.operationalObservation, .problem(.tunnel))
        model.helperStatus = try helper(bridge: false)
        XCTAssertEqual(model.operationalObservation, .problem(.runtime))
        model.helperStatus = try helper(valid: false)
        XCTAssertEqual(model.operationalObservation, .problem(.configuration))
        model.helperStatus = try helper()
        model.authStatus = try auth(installed: false)
        XCTAssertEqual(model.operationalObservation, .problem(.installation))
        model.authStatus = try auth(authenticated: false)
        XCTAssertEqual(model.operationalObservation, .problem(.authentication))
        model.isBusy = true
        XCTAssertEqual(model.operationalObservation, .unknown)
        model.isBusy = false
        model.helperStatus = try helper(phase: "stopped", bridge: false, tunnel: false)
        XCTAssertEqual(model.operationalObservation, .healthy)
    }

    func testPrivateErrorsBecomeFixedCopyAndSafeSettingsDestinations() throws {
        let secret = "sk-secret /Users/private/project prompt-code"
        XCTAssertEqual(OperationalProblem.remoteError(RemoteCompanionError.invalidResponse(secret)), .remoteConnection)
        XCTAssertEqual(OperationalProblem.remoteError(RemoteCompanionError.unauthorized), .remoteSecurity)
        XCTAssertEqual(OperationalProblem.remoteError(RemoteCompanionError.certificateMismatch), .remoteSecurity)
        XCTAssertEqual(OperationalProblem.remoteError(RemoteCompanionError.incompatibleProtocol), .compatibility)
        for problem in OperationalProblem.allCases {
            let content = SystemOperationalNotificationDelivery.content(problem: problem, scope: scope, locale: Locale(identifier: "ko"))
            XCTAssertEqual(content.body, problem.messageKey)
            XCTAssertFalse(content.body.contains(secret))
            XCTAssertEqual(Set(content.userInfo.keys.compactMap { $0 as? String }), ["problem", "scope"])
            XCTAssertEqual(content.interruptionLevel, .active)
            XCTAssertTrue(["codex", "connection"].contains(problem.settingsTab))
            XCTAssertFalse(OperationalNotificationPolicy.key(scope: scope, problem: problem).contains("fixture-server"))
        }
        XCTAssertEqual(Set([MenuBarHealth.healthy, .checking, .attention, .unavailable].map {
            $0.accessibilityLabel(locale: Locale(identifier: "ko"))
        }).count, 4)
    }
}

@MainActor
private final class NotificationDeliveryFixture: OperationalNotificationDelivering {
    var authorized = false
    var fail = false
    var sent: [OperationalProblem] = []
    var identifiers: [String] = []
    func isAuthorized() async -> Bool { authorized }
    func requestAuthorization() async -> Bool { authorized }
    func deliver(identifier: String, problem: OperationalProblem, scope: String, locale: Locale) async throws {
        if fail { throw CocoaError(.fileWriteUnknown) }
        sent.append(problem)
        identifiers.append(identifier)
    }
}
