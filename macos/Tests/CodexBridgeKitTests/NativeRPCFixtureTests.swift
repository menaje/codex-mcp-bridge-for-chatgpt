import Darwin
import Foundation
import XCTest
@testable import CodexBridgeKit

final class NativeRPCFixtureTests: XCTestCase {
    func testAcceptedSocketSuppressesSIGPIPEBeforeStopCanShutItDown() async throws {
        let path = "/tmp/cb-fixture-order-\(UUID().uuidString.prefix(8)).sock"
        let gate = FixtureServeGate()
        let fixture = try NativeRPCFixture(path: path, beforeServe: { gate.pause($0) },
            requestReply: { _, _ in NativeFixtureReply(body: "") })
        defer { gate.resume.signal(); fixture.stop() }
        let request = Task {
            let _: EmptyParameters = try await UnixSocketRPCClient(socketPath: path, timeout: 3)
                .call("fixture.read", params: EmptyParameters())
        }
        let accepted = await Task.detached { gate.waitForAcceptance() }.value
        XCTAssertTrue(accepted)
        fixture.stop()
        gate.resume.signal()
        let resumed = await Task.detached { gate.waitForResume() }.value
        XCTAssertTrue(resumed)
        _ = await request.result
        XCTAssertEqual(gate.options, [1, 1],
            "SO_NOSIGPIPE must be set before stop can shut down an accepted socket. macOS rejects setting it after shutdown with EINVAL.")
    }
}

private final class FixtureServeGate: @unchecked Sendable {
    let accepted = DispatchSemaphore(value: 0)
    let resume = DispatchSemaphore(value: 0)
    let resumed = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var values: [Int32] = []
    var options: [Int32] { lock.withLock { values } }

    func waitForAcceptance() -> Bool { accepted.wait(timeout: .now() + 3) == .success }
    func waitForResume() -> Bool { resumed.wait(timeout: .now() + 3) == .success }

    func pause(_ descriptor: Int32) {
        observe(descriptor)
        accepted.signal()
        _ = resume.wait(timeout: .now() + 3)
        observe(descriptor)
        resumed.signal()
    }

    private func observe(_ descriptor: Int32) {
        var option: Int32 = -1
        var length = socklen_t(MemoryLayout<Int32>.size)
        _ = getsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &option, &length)
        lock.withLock { values.append(option) }
    }
}
