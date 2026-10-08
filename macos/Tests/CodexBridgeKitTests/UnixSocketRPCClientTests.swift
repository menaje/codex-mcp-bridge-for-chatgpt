import Darwin
import Foundation
import XCTest
@testable import CodexBridgeKit

final class UnixSocketRPCClientTests: XCTestCase {
    func testDefaultTransportReadsMaximumBridgeSkillContentEnvelope() async throws {
        struct SkillResult: Decodable { let content: String }
        // C0 control characters are valid source text (except NUL) but use
        // JSON's six-byte escape form, exercising the true transport bound.
        let content = String(repeating: "\u{0001}", count: 3 * 1_024 * 1_024)
        let body = String(
            decoding: try JSONSerialization.data(withJSONObject: [
                "result": ["content": content]
            ]),
            as: UTF8.self
        )
        XCTAssertGreaterThan(body.lengthOfBytes(using: .utf8), 8 * 1_024 * 1_024)
        XCTAssertLessThanOrEqual(body.lengthOfBytes(using: .utf8), bridgeSkillTransportEnvelopeMaxBytes)
        let path = "/tmp/cb-rpc-large-skill-\(UUID().uuidString.prefix(8)).sock"
        let server = try NativeRPCFixture(path: path) { _ in NativeFixtureReply(body: body) }
        defer { server.stop() }

        let client = UnixSocketRPCClient(socketPath: path)
        XCTAssertEqual(client.maximumResponseBytes, bridgeSkillTransportEnvelopeMaxBytes)
        let result: SkillResult = try await client.call("skills.read", params: EmptyParameters())
        XCTAssertEqual(result.content, content)
    }

    func testContractDecodeFailureIsNotReportedAsPersistentDataLoss() async throws {
        struct RequiredResult: Decodable { let value: String }
        let path = "/tmp/cb-rpc-contract-\(UUID().uuidString.prefix(8)).sock"
        let server = try NativeRPCFixture(path: path) { _ in
            NativeFixtureReply(body: #"{"result":{}}"#)
        }
        defer { server.stop() }

        do {
            let _: RequiredResult = try await UnixSocketRPCClient(socketPath: path).call(
                "test.contract",
                params: EmptyParameters()
            )
            XCTFail("A response missing the required value should fail decoding.")
        } catch LocalRPCError.malformedResponse(let message) {
            XCTAssertEqual(message, "BRIDGE_RESPONSE_CONTRACT_MISMATCH")
        }
    }

    func testPendingChangeWaitDoesNotDelayIndependentHealthRead() async throws {
        let path = "/tmp/cb-rpc-independent-\(UUID().uuidString.prefix(8)).sock"
        let connected = expectation(description: "change wait received")
        let server = try NativeRPCFixture(path: path) { method in
            if method == "changes.wait" {
                connected.fulfill()
                return NativeFixtureReply(body: #"{"result":{"revision":"same","topics":[]}}"#, delay: 2)
            }
            return NativeFixtureReply(body: #"{"result":{}}"#)
        }
        defer { server.stop() }
        let started = Date()
        let pending = Task { try await MacOSHelperClient(socketPath: path).waitForChanges(after: "same") }
        defer { pending.cancel() }
        await fulfillment(of: [connected], timeout: 1)
        let _: EmptyParameters = try await UnixSocketRPCClient(socketPath: path).call("helper.health", params: EmptyParameters())
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        pending.cancel()
        _ = try? await pending.value
    }

    func testCancellingChangeWaitClosesSocketWithoutWaitingForTimeout() async throws {
        let path = "/tmp/cb-cancel-\(UUID().uuidString.prefix(8)).sock"
        let listener = try makeListener(at: path)
        defer { Darwin.close(listener); unlink(path) }
        let connected = expectation(description: "request received")
        let server = Task.detached { () throws -> Void in
            let client = Darwin.accept(listener, nil, nil)
            guard client >= 0 else { throw POSIXError(.EIO) }
            defer { Darwin.close(client) }
            var buffer = [UInt8](repeating: 0, count: 4096)
            guard Darwin.read(client, &buffer, buffer.count) > 0 else { throw POSIXError(.EIO) }
            connected.fulfill()
            XCTAssertEqual(Darwin.read(client, &buffer, buffer.count), 0)
        }
        let client = MacOSHelperClient(socketPath: path)
        let request = Task { try await client.waitForChanges(after: "same-revision") }
        await fulfillment(of: [connected], timeout: 2)
        let started = Date()
        request.cancel()
        do { _ = try await request.value; XCTFail("Cancelled wait returned a value") }
        catch is CancellationError { }
        try await server.value
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
    }

    func testPerCallTimeoutCanOutliveShortClientDefault() async throws {
        let socketPath = "/tmp/cb-rpc-\(getpid())-\(UUID().uuidString.prefix(8)).sock"
        unlink(socketPath)
        let listener = try makeListener(at: socketPath)
        defer {
            Darwin.close(listener)
            unlink(socketPath)
        }

        let server = Task.detached { () throws -> Void in
            let connection = Darwin.accept(listener, nil, nil)
            guard connection >= 0 else { throw POSIXError(.ECONNABORTED) }
            defer { Darwin.close(connection) }
            var buffer = [UInt8](repeating: 0, count: 4_096)
            let count = Darwin.read(connection, &buffer, buffer.count)
            guard count > 0 else { throw POSIXError(.EIO) }
            let request = try JSONSerialization.jsonObject(
                with: Data(buffer.prefix(count))
            ) as? [String: Any]
            let requestID = request?["id"] as? String ?? ""
            try await Task.sleep(nanoseconds: 200_000_000)
            let response = try JSONSerialization.data(withJSONObject: [
                "jsonrpc": "2.0",
                "id": requestID,
                "result": [:]
            ]) + Data([0x0A])
            try response.withUnsafeBytes { bytes in
                guard let base = bytes.baseAddress else { return }
                var sent = 0
                while sent < bytes.count {
                    let count = Darwin.write(connection, base.advanced(by: sent), bytes.count - sent)
                    guard count > 0 else { throw POSIXError(.EPIPE) }
                    sent += count
                }
            }
        }

        let client = UnixSocketRPCClient(socketPath: socketPath, timeout: 0.05)
        let _: EmptyParameters = try await client.call(
            "test.slow",
            params: EmptyParameters(),
            timeout: 1
        )
        try await server.value
    }
}

private func makeListener(at socketPath: String) throws -> Int32 {
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw POSIXError(.EIO) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8)
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

extension UnixSocketRPCClientTests {
    func testNumericFailureEvidenceAndLifecycleReplayBoundary() async throws {
        let path = "/tmp/cb-missing-\(UUID().uuidString.prefix(8)).sock"
        do {
            let _: EmptyParameters = try await UnixSocketRPCClient(socketPath: path).call("helper.health", params: EmptyParameters())
            XCTFail("Missing fixture socket must fail")
        } catch {
            let evidence = try XCTUnwrap(LocalRPCFailure(error: error))
            XCTAssertEqual(evidence.phase, .connect)
            XCTAssertEqual(evidence.errnoCode, ENOENT)
            XCTAssertFalse(evidence.timedOut)
            XCTAssertFalse(evidence.cancelled)
            XCTAssertTrue(try XCTUnwrap(error as? LocalRPCError).allowsLifecycleReceiptReplay)
        }
        XCTAssertNil(LocalRPCFailure(error: CancellationError()))
        for phase: LocalRPCPhase in [.socket, .connect, .write, .read] {
            XCTAssertTrue(LocalRPCError.transport(phase: phase, errnoCode: ETIMEDOUT, timedOut: true).allowsLifecycleReceiptReplay)
        }
        for error: LocalRPCError in [.invalidSocketPath, .peerIdentityMismatch, .responseTooLarge,
                                    .malformedResponse("contract"), .remote(code: -32000, message: "timeout"),
                                    .transport(phase: .decode, errnoCode: ETIMEDOUT, timedOut: true)] {
            XCTAssertFalse(error.allowsLifecycleReceiptReplay)
        }
    }

    func testFragmentedResponseCannotResetAbsoluteDeadline() async throws {
        let path = "/tmp/cb-fragment-\(UUID().uuidString.prefix(8)).sock"
        let listener = try makeListener(at: path)
        defer { Darwin.close(listener); unlink(path) }
        let server = Task.detached {
            let descriptor = Darwin.accept(listener, nil, nil)
            guard descriptor >= 0 else { return }
            defer { Darwin.close(descriptor) }
            var noSignal: Int32 = 1
            _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            var buffer = [UInt8](repeating: 0, count: 4096)
            guard Darwin.read(descriptor, &buffer, buffer.count) > 0 else { return }
            // Each fragment arrives before an idle timeout, but the total exceeds the budget.
            for _ in 0..<20 {
                try? await Task.sleep(for: .milliseconds(30))
                var byte: UInt8 = 0x20
                if Darwin.write(descriptor, &byte, 1) != 1 { return }
            }
        }
        let started = Date()
        do {
            let _: EmptyParameters = try await UnixSocketRPCClient(socketPath: path, timeout: 0.12)
                .call("dashboard.snapshot", params: EmptyParameters())
            XCTFail("Fragment trickle must exceed the absolute deadline")
        } catch {
            let evidence = try XCTUnwrap(LocalRPCFailure(error: error))
            XCTAssertEqual(evidence.phase, .read)
            XCTAssertEqual(evidence.errnoCode, ETIMEDOUT)
            XCTAssertTrue(evidence.timedOut)
            XCTAssertFalse(evidence.cancelled)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.5)
        await server.value
    }

    func testReceiptReplayUsesSameLifecycleIDAndExactPayloadAfterResponseLoss() async throws {
        let path = "/tmp/cb-replay-\(UUID().uuidString.prefix(8)).sock"
        let received = LifecycleReplayRequests()
        let server = try NativeRPCFixture(path: path, requestReply: { _, params in
            let count = received.append(params)
            // An invalid fixture reply closes the socket without a response.
            if count == 1 { return NativeFixtureReply(body: "") }
            return NativeFixtureReply(body: #"{"result":{"requestId":"same-receipt","kind":"start","force":false,"state":"queued","phase":"queued","createdAt":"now","updatedAt":"now","impact":null,"result":null,"error":null,"cancellable":true}}"#)
        })
        defer { server.stop() }
        let request = RuntimeLifecycleRequest(requestId: "same-receipt", kind: "start", force: false)
        _ = try await MacOSHelperClient(socketPath: path).requestLifecycle(request)
        let payloads = received.values
        XCTAssertEqual(payloads.count, 2)
        let first = try JSONSerialization.jsonObject(with: Data(payloads[0].utf8)) as? NSDictionary
        let second = try JSONSerialization.jsonObject(with: Data(payloads[1].utf8)) as? NSDictionary
        XCTAssertEqual(first, second)
        XCTAssertEqual(first?["requestId"] as? String, "same-receipt")
    }
}

private final class LifecycleReplayRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var payloads: [String] = []
    func append(_ value: String) -> Int { lock.withLock { payloads.append(value); return payloads.count } }
    var values: [String] { lock.withLock { payloads } }
}
