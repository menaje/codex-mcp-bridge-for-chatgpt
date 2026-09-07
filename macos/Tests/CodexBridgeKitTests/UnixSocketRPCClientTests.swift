import Darwin
import Foundation
import XCTest
@testable import CodexBridgeKit

final class UnixSocketRPCClientTests: XCTestCase {
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
