import CodexBridgeKit
@testable import CodexBridgeMenuBar
import Foundation

final class W3NativeOutboxFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [Int] = []
    private var batches: [Int] = []
    var batchSizes: [Int] { lock.withLock { batches } }

    func enqueue(_ count: Int) { lock.withLock { pending = Array(1...count) } }

    func reply(_ method: String, _ input: String) -> NativeFixtureReply {
        lock.withLock {
            var result: [String: Any] = [:]
            switch method {
            case "completion.availability": result = ["available": !pending.isEmpty]
            case "completion.claim":
                let batch = Array(pending.prefix(10))
                pending.removeFirst(batch.count)
                batches.append(batch.count)
                result = ["events": batch.map { ["outboxId": $0, "eventId": "stable-\($0)"] as [String: Any] }]
            case "completion.delivered", "completion.release": result = ["ok": true]
            default: return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"unsupported"}}"#)
            }
            let data = try! JSONSerialization.data(withJSONObject: ["result": result])
            return NativeFixtureReply(body: String(decoding: data, as: UTF8.self))
        }
    }
}

@MainActor
final class W3CompletionDeliveryFixture: CompletionNotificationDelivering {
    private(set) var ids: [String] = []
    func isAuthorized() async -> Bool { true }
    func deliverCompletion(identifier: String, locale: Locale) async throws { ids.append(identifier) }
}
