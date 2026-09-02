import Darwin
import Foundation
import XCTest
@testable import CodexBridgeKit

final class UnixSocketRPCClientTests: XCTestCase {
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
