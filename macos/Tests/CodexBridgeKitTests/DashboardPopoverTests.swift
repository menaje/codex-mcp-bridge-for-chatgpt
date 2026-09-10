import Foundation
import XCTest
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

final class DashboardPopoverTests: XCTestCase {
    @MainActor
    func testPanelsToggleIndependentlyFromTheAllHistoryQueryAndResetOnClose() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let model = f.model
        await model.refreshDashboard(enrich: false)
        XCTAssertNil(model.dashboardPanel)
        XCTAssertEqual(model.dashboard?.counts.running, 3)
        for panel in [DashboardPanel.running, .responseRequired, .problems, .history] {
            await model.toggleDashboardPanel(panel)
            XCTAssertEqual(model.dashboardPanel, panel)
            XCTAssertEqual(model.dashboardLoadedFilter, panel.filter)
            XCTAssertEqual(model.dashboard?.scope, panel.filter.rawValue)
        }
        await model.refreshDashboard(enrich: false)
        XCTAssertEqual(model.dashboardPanel, .history)
        await model.toggleDashboardPanel(.history)
        XCTAssertNil(model.dashboardPanel)
        XCTAssertNotNil(model.dashboard)
        await model.toggleDashboardPanel(.problems)
        model.setDashboardVisible(false)
        XCTAssertNil(model.dashboardPanel)
        XCTAssertEqual(model.dashboardStatusFilter, .all)
    }

    @MainActor
    func testSummarySurvivesFilterLoadingAndLateResultsCannotChangeTheSelectedPanel() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let model = f.model
        await model.refreshDashboard(enrich: false)
        f.state.delayRunning = true
        let running = Task { await model.toggleDashboardPanel(.running) }
        for _ in 0..<50 {
            if model.dashboardDetailLoading { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(model.dashboard?.counts.running, 3)
        XCTAssertTrue(model.dashboardDetailLoading)
        await model.toggleDashboardPanel(.problems)
        await running.value
        XCTAssertEqual(model.dashboardPanel, .problems)
        XCTAssertEqual(model.dashboardLoadedFilter, .problems)
        XCTAssertEqual(model.dashboard?.scope, "problems")
        XCTAssertFalse(model.dashboardDetailLoading)

        let next = Task { await model.toggleDashboardPanel(.running) }
        for _ in 0..<50 {
            if model.dashboardPanel == .running { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        model.setDashboardVisible(false)
        await next.value
        XCTAssertNil(model.dashboardPanel)
        XCTAssertEqual(model.dashboard?.scope, "problems")
    }

    func testDetailHeightFitsEmptyShortAndLongListsToTheOwningScreen() {
        XCTAssertEqual(DashboardPopoverLayout.detailHeight(content: 72, fixed: 280, screen: 900), 72)
        XCTAssertEqual(DashboardPopoverLayout.detailHeight(content: 4000, fixed: 280, screen: 900), 596)
        XCTAssertEqual(DashboardPopoverLayout.detailHeight(content: 4000, fixed: 400, screen: 600), 176)
        XCTAssertGreaterThan(DashboardPopoverLayout.detailHeight(content: 0, fixed: 400, screen: 600), 0)
    }

    @MainActor
    func testAppLaunchSubmitsStartOnceAndLaterBootstrapDoesNotUndoAManualStop() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        async let first: Void = f.model.start()
        async let second: Void = f.model.start()
        _ = await (first, second)
        let launches = f.state.launchRequests
        XCTAssertEqual(launches.count, 1)
        XCTAssertNotNil(launches.first?["applicationLaunchAt"] as? String)
        XCTAssertEqual(launches.first?["kind"] as? String, "start")
        XCTAssertNil(f.model.startupErrorMessage)
        _ = await f.model.stopRuntime(force: false)
        await f.model.start()
        XCTAssertEqual(f.state.launchRequests.count, 1)
    }

    @MainActor
    func testAppLaunchCanObserveAnExistingOperationWithoutAnIdentityError() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.coalesceStart = true
        await f.model.start()
        XCTAssertNil(f.model.startupErrorMessage)
        XCTAssertEqual(f.model.lifecycleOperation?.requestId, PopoverReplyState.existingRequestID)
    }

    @MainActor
    func testFailedLaunchKeepsTheSameRequestIdentityForAnExplicitRetry() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.failStart = true
        await f.model.start()
        XCTAssertNotNil(f.model.startupErrorMessage)
        f.state.failStart = false
        await f.model.start()
        XCTAssertNil(f.model.startupErrorMessage)
        let requests = f.state.launchRequests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0]["requestId"] as? String, requests[1]["requestId"] as? String)
        XCTAssertEqual(requests[0]["applicationLaunchAt"] as? String, requests[1]["applicationLaunchAt"] as? String)
    }
}

private actor PopoverBootstrap: HelperBootstrapping {
    func ensureRunning(paths: RuntimePaths) async throws {}
    func shutdown(paths: RuntimePaths) async throws {}
}

@MainActor
private final class PopoverFixture {
    let root: URL
    let state = PopoverReplyState()
    let helper: NativeRPCFixture
    let bridge: NativeRPCFixture
    let model: AppModel

    init() throws {
        root = URL(fileURLWithPath: "/tmp/cb-menu-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path], currentDirectory: root)
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let state = self.state
        helper = try NativeRPCFixture(path: paths.helperSocket.path, requestReply: { state.reply($0, $1) })
        bridge = try NativeRPCFixture(path: paths.bridgeSocket.path, requestReply: { state.reply($0, $1) })
        model = AppModel(paths: paths, bootstrapper: PopoverBootstrap())
        model.recordLocalConnectionStatus(try JSONDecoder().decode(HelperStatus.self,
            from: JSONSerialization.data(withJSONObject: PopoverReplyState.helperStatus)))
    }

    func remove() {
        model.cancelAllPolling()
        helper.stop(); bridge.stop()
        try? FileManager.default.removeItem(at: root)
    }
}

private final class PopoverReplyState: @unchecked Sendable {
    static let existingRequestID = "11111111-1111-4111-8111-111111111111"
    private let lock = NSLock()
    private var requests: [[String: Any]] = []
    private var slow = false
    private var fail = false
    private var coalesce = false
    private var operation: [String: Any]?
    var delayRunning: Bool { get { lock.withLock { slow } } set { lock.withLock { slow = newValue } } }
    var failStart: Bool { get { lock.withLock { fail } } set { lock.withLock { fail = newValue } } }
    var coalesceStart: Bool { get { lock.withLock { coalesce } } set { lock.withLock { coalesce = newValue } } }
    var launchRequests: [[String: Any]] { lock.withLock { requests.filter { $0["applicationLaunchAt"] != nil } } }
    static var helperStatus: [String: Any] { [
        "kind": "helper-status", "generatedAt": "2026-09-10T00:00:00Z", "phase": "running", "restartAttempt": 0,
        "configuration": ["path": "/private/fixture/.env", "exists": true, "valid": true, "hasApiKey": true, "hasTunnelId": true],
        "bridge": ["socketPath": "/private/fixture/bridge.sock", "connected": true],
        "tunnel": ["phase": "connected", "doctorPassed": true, "processRunning": true, "connected": true]
    ] }

    func reply(_ method: String, _ parameters: String) -> NativeFixtureReply {
        let params = (try? JSONSerialization.jsonObject(with: Data(parameters.utf8))) as? [String: Any] ?? [:]
        var delay: TimeInterval = 0
        let result: [String: Any]
        switch method {
        case "helper.status", "helper.health":
            var status = Self.helperStatus
            if let operation = lock.withLock({ operation }) { status["lifecycle"] = operation }
            result = status
        case "auth.status": result = ["installed": true, "authenticated": true, "summary": "fixture"]
        case "lifecycle.request":
            lock.withLock { requests.append(params) }
            if failStart { return NativeFixtureReply(body: #"{"error":{"code":-32000,"message":"FIXTURE_START_FAILED"}}"#) }
            result = ["requestId": coalesceStart ? Self.existingRequestID : params["requestId"]!, "kind": params["kind"]!,
                "force": false, "phase": "completed", "createdAt": "2026-09-10T00:00:00Z", "updatedAt": "2026-09-10T00:00:00Z",
                "reasons": [], "cancellable": false]
            lock.withLock { operation = result }
        case "dashboard.snapshot":
            let filter = params["statusFilter"] as? String ?? "all"
            if filter == "running", delayRunning { delay = 0.2 }
            let names = ["trackedProjects", "trackedConversations", "retainedJobs", "active", "running", "inputRequired",
                "approvalRequired", "terminating", "needsAttention", "backgroundProcesses", "backgroundProcessAgents",
                "runtimeUnknownAgents", "runtimeProbeSkippedAgents", "completed", "failed", "interrupted", "cancelled", "idleAgents", "orphanedAgents"]
            var counts = Dictionary(uniqueKeysWithValues: names.map { ($0, 0) }); counts["running"] = 3
            let page: [String: Any] = ["offset": 0, "limit": 12, "returned": 0, "total": 0,
                "returnedConversations": 0, "conversationTotal": 0, "hasPrevious": false, "hasNext": false]
            result = ["kind": "dashboard", "generatedAt": "2026-09-10T00:00:00Z", "scope": filter,
                "statusSource": "codex-runtime-only", "coverage": "complete", "counts": counts,
                "activeRows": [], "terminalRows": [], "idleRows": [], "pagination": ["active": page, "terminal": page, "idle": page],
                "uiLocalePreference": "ko"]
        default: return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"Fixture method unavailable"}}"#)
        }
        let data = try! JSONSerialization.data(withJSONObject: ["result": result])
        return NativeFixtureReply(body: String(decoding: data, as: UTF8.self), delay: delay)
    }
}
