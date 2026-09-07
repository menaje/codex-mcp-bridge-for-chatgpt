import Darwin
import Foundation

struct NativeFixtureReply: Sendable {
    let body: String
    var delay: TimeInterval = 0
}

/// Real sockets exercise cancellation and independent requests without launching a user's helper.
final class NativeRPCFixture: @unchecked Sendable {
    private let listener: Int32
    private let path: String
    private let reply: @Sendable (String) -> NativeFixtureReply
    private let lock = NSLock()
    private var stopped = false
    private var clients = Set<Int32>()
    private var counts: [String: Int] = [:]

    init(path: String, reply: @escaping @Sendable (String) -> NativeFixtureReply) throws {
        self.path = path
        self.reply = reply
        listener = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw POSIXError(.EIO) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { Darwin.close(listener); throw POSIXError(.ENAMETOOLONG) }
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.initializeMemory(as: UInt8.self, repeating: 0)
            destination.copyBytes(from: bytes)
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, Darwin.listen(listener, 16) == 0 else { Darwin.close(listener); throw POSIXError(.EIO) }
        chmod(path, 0o600)
        Thread.detachNewThread { [self] in
            while true {
                let client = Darwin.accept(listener, nil, nil)
                guard client >= 0 else { return }
                let active = lock.withLock { () -> Bool in
                    if stopped { Darwin.close(client); return false }
                    clients.insert(client)
                    return true
                }
                guard active else { return }
                Thread.detachNewThread { [self] in serve(client) }
            }
        }
    }

    func count(_ method: String) -> Int { lock.withLock { counts[method, default: 0] } }

    func stop() {
        lock.withLock {
            guard !stopped else { return }
            stopped = true
            _ = Darwin.shutdown(listener, SHUT_RDWR)
            Darwin.close(listener)
            for client in clients { _ = Darwin.shutdown(client, SHUT_RDWR) }
            unlink(path)
        }
    }

    private func serve(_ client: Int32) {
        defer { lock.withLock { clients.remove(client); Darwin.close(client) } }
        var noSignal: Int32 = 1
        _ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var input = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while !input.contains(0x0A) {
            let count = Darwin.read(client, &buffer, buffer.count)
            guard count > 0 else { return }
            input.append(buffer, count: count)
        }
        guard let request = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
              let method = request["method"] as? String, let id = request["id"] else { return }
        lock.withLock { counts[method, default: 0] += 1 }
        let response = reply(method)
        if response.delay > 0 { Thread.sleep(forTimeInterval: response.delay) }
        guard var body = try? JSONSerialization.jsonObject(with: Data(response.body.utf8)) as? [String: Any] else { return }
        body["jsonrpc"] = "2.0"
        body["id"] = id
        guard var data = try? JSONSerialization.data(withJSONObject: body) else { return }
        data.append(0x0A)
        data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var sent = 0
            while sent < bytes.count {
                let count = Darwin.write(client, base.advanced(by: sent), bytes.count - sent)
                guard count > 0 else { return }
                sent += count
            }
        }
    }
}
