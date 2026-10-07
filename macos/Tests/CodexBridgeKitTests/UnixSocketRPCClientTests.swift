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
        // This is a byte-envelope test. Debug Foundation decoding of 18 MiB
        // takes longer than the ordinary deadline; deadline behavior is tested separately.
        let result: SkillResult = try await client.call("skills.read", params: EmptyParameters(), timeout: 60)
        XCTAssertEqual(result.content, content)
    }

    func testIssue242StructuralFailureCategories() {
        for (code, kind) in [(EAGAIN, RPCFailureKind.timeout), (ECONNREFUSED, .refused),
                             (ECONNRESET, .peerClosed), (EPIPE, .peerClosed), (EPERM, .permissionDenied)] {
            let failure = RPCObservationFailure(LocalRPCError.transport(phase: .receive, code: code))
            XCTAssertEqual(failure.kind, kind)
            XCTAssertEqual(failure.phase, .receive)
            XCTAssertEqual(failure.posixCode, code)
        }
        XCTAssertEqual(RPCObservationFailure(CancellationError()).kind, .cancelled)
        XCTAssertEqual(RPCObservationFailure(LocalRPCError.malformedResponse("test")).kind, .contractMismatch)
    }

    func testIssue242CancellationDuringDecodeRemainsCancellation() async throws {
        struct CancelledResult: Decodable {
            init(from decoder: Decoder) throws { throw CancellationError() }
        }
        let path = "/tmp/cb-242-decode-cancel-\(UUID().uuidString.prefix(8)).sock"
        let server = try NativeRPCFixture(path: path) { _ in NativeFixtureReply(body: #"{"result":{}}"#) }
        defer { server.stop() }
        do {
            let _: CancelledResult = try await UnixSocketRPCClient(socketPath: path).call("test", params: EmptyParameters())
            XCTFail("Cancelled decoder must not publish a value")
        } catch { XCTAssertEqual(RPCObservationFailure(error).kind, .cancelled) }
    }

    func testIssue242DecoderCannotPublishAfterAbsoluteDeadline() async throws {
        struct SlowResult: Decodable {
            init(from decoder: Decoder) throws { Thread.sleep(forTimeInterval: 2) }
        }
        let path = "/tmp/cb-242-decode-deadline-\(UUID().uuidString.prefix(8)).sock"
        let server = try NativeRPCFixture(path: path) { _ in NativeFixtureReply(body: #"{"result":{}}"#) }
        defer { server.stop() }
        do {
            let _: SlowResult = try await UnixSocketRPCClient(socketPath: path, timeout: 1).call("test", params: EmptyParameters())
            XCTFail("A synchronous decoder cannot publish after its deadline")
        } catch {
            XCTAssertEqual(RPCObservationFailure(error).kind, .timeout)
            XCTAssertEqual(RPCObservationFailure(error).phase, .decode)
        }
    }

    func testIssue242RefusalPeerCloseAndMissingResultStayDistinct() async throws {
        let path = "/tmp/cb-242-errors-\(UUID().uuidString.prefix(8)).sock"
        do {
            let _: EmptyParameters = try await UnixSocketRPCClient(socketPath: path).call("test", params: EmptyParameters())
            XCTFail("Missing listener must refuse the connection")
        } catch { XCTAssertEqual(RPCObservationFailure(error).kind, .refused) }
        let replies = ["test.close": "", "test.contract": "{}"]
        let server = try NativeRPCFixture(path: path) { NativeFixtureReply(body: replies[$0] ?? "") }
        defer { server.stop() }
        for (method, kind) in [("test.close", RPCFailureKind.peerClosed), ("test.contract", .contractMismatch)] {
            do {
                let _: EmptyParameters = try await UnixSocketRPCClient(socketPath: path).call(method, params: EmptyParameters())
                XCTFail("Fixture must fail")
            } catch { XCTAssertEqual(RPCObservationFailure(error).kind, kind) }
        }
    }

    func testIssue242PartialResponseCannotExtendAbsoluteDeadline() async throws {
        let path = "/tmp/cb-242-partial-\(UUID().uuidString.prefix(8)).sock"
        let listener = try makeListener(at: path)
        defer { Darwin.close(listener); unlink(path) }
        let server = Task.detached {
            let client = Darwin.accept(listener, nil, nil)
            guard client >= 0 else { return }
            defer { Darwin.close(client) }
            var noSignal: Int32 = 1
            _ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            var input = [UInt8](repeating: 0, count: 4096)
            _ = Darwin.read(client, &input, input.count)
            var byte: UInt8 = 0x20
            for _ in 0..<30 {
                if Darwin.write(client, &byte, 1) != 1 { break }
                try? await Task.sleep(for: .milliseconds(30))
            }
        }
        let started = Date()
        do {
            let _: EmptyParameters = try await UnixSocketRPCClient(socketPath: path, timeout: 0.2).call("test", params: EmptyParameters())
            XCTFail("Partial response must miss its total deadline")
        } catch {
            XCTAssertEqual(RPCObservationFailure(error).kind, .timeout)
            XCTAssertEqual(RPCObservationFailure(error).phase, .receive)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.7)
        await server.value
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
