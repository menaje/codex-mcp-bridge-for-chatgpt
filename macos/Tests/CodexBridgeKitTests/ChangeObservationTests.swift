import Combine
import CodexBridgeKit
import Foundation
import XCTest
@testable import CodexBridgeMenuBar

final class ChangeObservationTests: XCTestCase {
    @MainActor
    func testProgressAndQuietNoticesPublishOnlyAvailabilityTransitions() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-notices-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let helperNotices = NoticeBurst(topics: [])
        let companionNotices = NoticeBurst(topics: ["dashboard"])
        let status = #"""
        {"kind":"helper-status","generatedAt":"2026-10-22T00:00:00Z","phase":"running","restartAttempt":0,
         "configuration":{"path":"fixture","exists":true,"valid":true,"hasApiKey":true,"hasTunnelId":true},
         "bridge":{"socketPath":"fixture","connected":true},
         "tunnel":{"phase":"connected","doctorPassed":true,"processRunning":true,"connected":true}}
        """#
        let helper = try NativeRPCFixture(path: paths.helperSocket.path) { method in
            if method == "helper.health" { return NativeFixtureReply(body: "{\"result\":\(status)}") }
            if method == "changes.wait" { return helperNotices.reply() }
            return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#)
        }
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method in
            if method == "changes.wait" { return companionNotices.reply() }
            return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#)
        }
        let model = AppModel(paths: paths)
        defer {
            model.cancelAllPolling(); helper.stop(); bridge.stop()
            try? FileManager.default.removeItem(at: root)
        }
        var helperAvailability: [Bool] = []
        var companionAvailability: [Bool] = []
        let helperSubscription = model.$helperChangesAvailable.sink { helperAvailability.append($0) }
        let companionSubscription = model.$companionChangesAvailable.sink { companionAvailability.append($0) }
        defer { helperSubscription.cancel(); companionSubscription.cancel() }

        await model.refreshStatus()
        for _ in 0..<400 {
            if helperNotices.count > 201, companionNotices.count > 201,
               model.helperChangesAvailable, model.companionChangesAvailable { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertGreaterThan(helperNotices.count, 201)
        XCTAssertGreaterThan(companionNotices.count, 201)
        XCTAssertEqual(helperAvailability, [false, true, false, true])
        XCTAssertEqual(companionAvailability, [false, true, false, true])
        XCTAssertEqual(bridge.count("dashboard.snapshot"), 0, "Progress invalidations must not add hidden Dashboard reads")

        model.cancelAllPolling()
        model.cancelAllPolling()
        XCTAssertEqual(helperAvailability, [false, true, false, true, false])
        XCTAssertEqual(companionAvailability, [false, true, false, true, false])
    }
}

private final class NoticeBurst: @unchecked Sendable {
    private let lock = NSLock()
    private var replies = 0
    private let topics: [String]
    init(topics: [String]) { self.topics = topics }
    var count: Int { lock.withLock { replies } }
    func reply() -> NativeFixtureReply {
        let n = lock.withLock { replies += 1; return replies }
        if n == 201 {
            return NativeFixtureReply(body: #"{"error":{"code":-32000,"message":"temporary disconnect"}}"#)
        }
        let body: [String: Any] = ["result": ["revision": "burst:\(n)", "topics": topics]]
        return NativeFixtureReply(body: String(decoding: try! JSONSerialization.data(withJSONObject: body), as: UTF8.self), delay: n > 202 ? 25 : 0)
    }
}
