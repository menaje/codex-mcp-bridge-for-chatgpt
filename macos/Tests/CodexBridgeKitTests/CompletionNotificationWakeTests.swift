import CodexBridgeKit
@testable import CodexBridgeMenuBar
import Foundation
import XCTest

final class CompletionNotificationWakeTests: XCTestCase {
    private func notice(_ revision: String, topics: [String] = [], ready: String? = nil, modern: Bool = true) throws -> ChangeNotice {
        var body: [String: Any] = ["revision": revision, "topics": topics]
        if modern {
            body["supportedTopics"] = ["dashboard", "settings", "completion-outbox-ready"]
            body["topicRevisions"] = ready.map { ["completion-outbox-ready": $0] } ?? [:]
        }
        return try JSONDecoder().decode(ChangeNotice.self, from: JSONSerialization.data(withJSONObject: body))
    }

    func testProgressAndSettingsNeverWakeClaimsAndLostEventsUseBoundedRecovery() throws {
        var state = CompletionNotificationWakeState()
        let start = Date(timeIntervalSince1970: 100)
        XCTAssertTrue(state.observe(try notice("A:0")))
        state.checked(at: start, nextAvailableAt: nil)
        for version in 1...400 {
            XCTAssertFalse(state.observe(try notice("A:\(version)", topics: [version % 2 == 0 ? "dashboard" : "settings"])))
        }
        XCTAssertFalse(state.recoveryDue(at: start.addingTimeInterval(59)))
        XCTAssertTrue(state.recoveryDue(at: start.addingTimeInterval(60)))
    }

    func testDuplicateOutOfOrderReconnectEpochAndAppRestart() throws {
        var state = CompletionNotificationWakeState()
        XCTAssertTrue(state.observe(try notice("A:0")))
        XCTAssertTrue(state.observe(try notice("A:5", topics: ["completion-outbox-ready"], ready: "A:5")))
        XCTAssertFalse(state.observe(try notice("A:5", topics: ["completion-outbox-ready"], ready: "A:5")))
        XCTAssertFalse(state.observe(try notice("A:4", topics: ["completion-outbox-ready"], ready: "A:4")))
        XCTAssertFalse(state.observe(try notice("A:6", topics: ["completion-outbox-ready"], ready: "A:5")))
        state.disconnected()
        XCTAssertTrue(state.observe(try notice("A:6")))
        XCTAssertTrue(state.observe(try notice("B:0")))
        XCTAssertFalse(state.observe(try notice("A:7", topics: ["completion-outbox-ready"], ready: "A:7")))
        state = CompletionNotificationWakeState()
        XCTAssertTrue(state.observe(try notice("B:0")))
    }

    func testLegacyUnsupportedEventsAndDueRetryOrLease() throws {
        var state = CompletionNotificationWakeState()
        let start = Date(timeIntervalSince1970: 100)
        XCTAssertTrue(state.observe(try notice("old:0", modern: false)))
        state.checked(at: start, nextAvailableAt: nil)
        for version in 1...100 { XCTAssertFalse(state.observe(try notice("old:\(version)", topics: ["dashboard"], modern: false))) }
        XCTAssertFalse(state.recoveryDue(at: start.addingTimeInterval(9)))
        XCTAssertTrue(state.recoveryDue(at: start.addingTimeInterval(10)))
        state.disconnected()
        state.checked(at: start, nextAvailableAt: nil)
        XCTAssertTrue(state.recoveryDue(at: start.addingTimeInterval(10)))
        XCTAssertTrue(state.observe(try notice("new:0")))
        state.checked(at: start, nextAvailableAt: start.addingTimeInterval(5))
        XCTAssertFalse(state.recoveryDue(at: start.addingTimeInterval(4)))
        XCTAssertTrue(state.recoveryDue(at: start.addingTimeInterval(5)))
        state.checked(at: start, nextAvailableAt: start.addingTimeInterval(30))
        XCTAssertTrue(state.recoveryDue(at: start.addingTimeInterval(30)))
    }
}
