import Foundation
import XCTest
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

@MainActor
private final class CompletionOrderingGateFixture: CompletionNotificationDelivering {
    private(set) var ids: [String] = []
    private var releaseRequested = false
    private var gate: CheckedContinuation<Void, Never>?
    func isAuthorized() async -> Bool { true }
    func deliverCompletion(identifier: String, locale: Locale) async throws {
        ids.append(identifier)
        if ids.count == 25 && !releaseRequested {
            await withCheckedContinuation { gate = $0 }
        }
    }
    func releaseLastDelivery() {
        releaseRequested = true
        gate?.resume()
        gate = nil
    }
}

final class CompletionNotificationOrderingTests: XCTestCase {
    @MainActor
    func testTwentyFivePresentationIDsCanPrecedeThirdAcknowledgmentWithoutLostDelivery() async throws {
        let path = "/tmp/cb-ack-order-\(UUID().uuidString.prefix(8)).sock"
        let outbox = W3NativeOutboxFixture()
        let server = try NativeRPCFixture(path: path, requestReply: { method, input in outbox.reply(method, input) })
        let delivery = CompletionOrderingGateFixture()
        let notifications = CompletionNotifications(delivery: delivery)
        let client = BridgeCompanionClient(socketPath: path)
        outbox.enqueue(25)
        let pending = Task { @MainActor in
            while await notifications.refresh(client: client, locale: Locale(identifier: "en")) {}
        }
        defer { delivery.releaseLastDelivery(); pending.cancel(); server.stop() }
        for _ in 0..<200 {
            if delivery.ids.count == 25 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(delivery.ids.count, 25)
        XCTAssertEqual(outbox.batchSizes, [10, 10, 5])
        XCTAssertEqual(server.count("completion.claim"), 3)
        // The original readiness predicate is true while acknowledgment is
        // still correctly pending after the final presentation callback.
        XCTAssertEqual(server.count("completion.delivered"), 2)
        print("ACK_ORDER before: notificationIDs=25 claims=3 deliveredRPCs=2; final callback pending")
        delivery.releaseLastDelivery()
        await pending.value
        XCTAssertEqual(Set(delivery.ids), Set((1...25).map { "stable-\($0)" }))
        XCTAssertEqual(server.count("completion.claim"), 3)
        XCTAssertEqual(server.count("completion.delivered"), 3)
        XCTAssertEqual(server.count("completion.release"), 0)
        print("ACK_ORDER after: uniqueNotificationIDs=25 claims=3 deliveredRPCs=3 releases=0; refresh completed")
    }
}
