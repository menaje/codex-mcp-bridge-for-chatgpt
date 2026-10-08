import Darwin
import Foundation

public enum LocalRPCPhase: String, Sendable, Equatable {
    case socket, connect, write, read, decode, remote
}

/// Numeric evidence is independent of strerror's language and presentation text.
public struct LocalRPCFailure: Sendable, Equatable {
    public let phase: LocalRPCPhase
    public let errnoCode: Int32?
    public let timedOut: Bool
    public let cancelled: Bool
    public let remoteCode: Int?

    public init?(error: Error) {
        guard !(error is CancellationError) else { return nil }
        cancelled = false
        remoteCode = (error as? LocalRPCError)?.remoteCode
        if case let .transport(phase, code, timedOut) = error as? LocalRPCError {
            self.phase = phase; errnoCode = code; self.timedOut = timedOut
        } else {
            errnoCode = nil; timedOut = false
            switch error as? LocalRPCError {
            case .connectionFailed, .invalidSocketPath, .peerIdentityMismatch: phase = .connect
            case .writeFailed: phase = .write
            case .emptyResponse, .responseTooLarge: phase = .read
            case .remote: phase = .remote
            default: phase = .decode
            }
        }
    }
}

public enum LocalRPCError: LocalizedError, Sendable {
    case transport(phase: LocalRPCPhase, errnoCode: Int32, timedOut: Bool)
    case invalidSocketPath
    case peerIdentityMismatch
    case connectionFailed(String)
    case writeFailed(String)
    case responseTooLarge
    case emptyResponse
    case malformedResponse(String)
    case remote(code: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .transport(let phase, let code, _):
            let message = String(cString: strerror(code))
            return phase == .write ? "로컬 서비스에 요청을 보낼 수 없습니다: \(message)" : "로컬 서비스에 연결할 수 없습니다: \(message)"
        case .invalidSocketPath:
            return "로컬 연결 경로가 올바르지 않습니다."
        case .peerIdentityMismatch:
            return "현재 사용자가 소유한 로컬 서비스가 아니므로 연결을 거부했습니다."
        case .connectionFailed(let message):
            return "로컬 서비스에 연결할 수 없습니다: \(message)"
        case .writeFailed(let message):
            return "로컬 서비스에 요청을 보낼 수 없습니다: \(message)"
        case .responseTooLarge:
            return "로컬 서비스 응답이 허용 크기를 초과했습니다."
        case .emptyResponse:
            return "로컬 서비스가 응답 없이 연결을 닫았습니다."
        case .malformedResponse(let message):
            return "로컬 서비스 응답을 읽을 수 없습니다: \(message)"
        case .remote(_, let message):
            return message
        }
    }
}

extension LocalRPCError {
    public var remoteCode: Int? {
        if case .remote(let code, _) = self { return code }
        return nil
    }

    /// Exactly the existing response-loss replay set, including its old socket,
    /// connect, write and read errno paths. Never retry decoding or remote errors.
    var allowsLifecycleReceiptReplay: Bool {
        switch self {
        case .connectionFailed, .writeFailed, .emptyResponse: return true
        case .transport(let phase, _, _): return [.socket, .connect, .write, .read].contains(phase)
        default: return false
        }
    }

    public var isObservationConnectionFailure: Bool {
        switch self {
        case .transport, .connectionFailed, .writeFailed, .emptyResponse: return true
        default: return false
        }
    }
}

public struct UnixSocketRPCClient: Sendable {
    public let socketPath: String
    public let timeout: TimeInterval
    public let maximumResponseBytes: Int

    public init(
        socketPath: String,
        timeout: TimeInterval = 10,
        maximumResponseBytes: Int = bridgeSkillTransportEnvelopeMaxBytes
    ) {
        self.socketPath = socketPath
        self.timeout = timeout
        self.maximumResponseBytes = maximumResponseBytes
    }

    public func call<Result: Decodable, Parameters: Encodable>(
        _ method: String,
        params: Parameters,
        as resultType: Result.Type = Result.self,
        timeout requestTimeout: TimeInterval? = nil
    ) async throws -> Result {
        let started = ProcessInfo.processInfo.systemUptime
        try Task.checkCancellation()
        let requestID = UUID().uuidString.lowercased()
        let request = RPCRequest(
            jsonrpc: "2.0",
            id: requestID,
            method: method,
            params: params
        )
        let requestData = try JSONEncoder().encode(request)
        try BridgeTextIntegrity.validateJSONUTF8(requestData)
        let socketPath = self.socketPath
        let timeout = requestTimeout ?? self.timeout
        let maximumResponseBytes = self.maximumResponseBytes
        let cancellation = SocketCancellation()
        let responseData: Data
        do {
            responseData = try await withTaskCancellationHandler {
                try Task.checkCancellation()
                // Long change waits must not occupy Swift's cooperative workers
                // needed to schedule health reads and cancellation.
                let value: Data = try await withCheckedThrowingContinuation { continuation in
                    DispatchQueue.global(qos: .userInitiated).async {
                        do {
                            continuation.resume(returning: try transact(socketPath: socketPath,
                                request: requestData, deadline: started + timeout,
                                maximumResponseBytes: maximumResponseBytes, cancellation: cancellation))
                        } catch { continuation.resume(throwing: error) }
                    }
                }
                try Task.checkCancellation()
                return value
            } onCancel: { cancellation.cancel() }
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw error
        }
        do {
            try BridgeTextIntegrity.validateJSONUTF8(responseData)
            let envelope = try JSONDecoder().decode(RPCResponse<Result>.self, from: responseData)
            guard envelope.jsonrpc == "2.0", envelope.id == requestID else {
                throw LocalRPCError.malformedResponse("JSON-RPC response identity did not match the request.")
            }
            if let error = envelope.error {
                throw LocalRPCError.remote(code: error.code, message: error.message)
            }
            guard let result = envelope.result else { throw LocalRPCError.emptyResponse }
            return result
        } catch let error as LocalRPCError {
            throw error
        } catch is DecodingError {
            // Foundation's localized DecodingError text can say that data was
            // "lost", which sounds like persistent state was deleted. A decode
            // failure means the app and service disagree about their response
            // contract; keep that distinction explicit for recovery UI.
            throw LocalRPCError.malformedResponse("BRIDGE_RESPONSE_CONTRACT_MISMATCH")
        } catch {
            throw LocalRPCError.malformedResponse(error.localizedDescription)
        }
    }
}

private struct RPCRequest<Parameters: Encodable>: Encodable {
    let jsonrpc: String
    let id: String
    let method: String
    let params: Parameters
}

private struct RPCResponse<Result: Decodable>: Decodable {
    let jsonrpc: String
    let id: String?
    let result: Result?
    let error: RPCRemoteError?
}

private struct RPCRemoteError: Decodable {
    let code: Int
    let message: String
}

private func transact(
    socketPath: String,
    request: Data,
    deadline: TimeInterval,
    maximumResponseBytes: Int,
    cancellation: SocketCancellation
) throws -> Data {
    let pathBytes = Array(socketPath.utf8)
    guard !pathBytes.isEmpty, pathBytes.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
        throw LocalRPCError.invalidSocketPath
    }
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else {
        throw transportError(.socket)
    }
    defer { cancellation.close(descriptor) }
    try cancellation.attach(descriptor)
    var noSignal: Int32 = 1
    _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)

    _ = fcntl(descriptor, F_SETFL, O_NONBLOCK)
    try cancellation.check()
    try checkDeadline(deadline, phase: .connect)

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        destination.initializeMemory(as: UInt8.self, repeating: 0)
        destination.copyBytes(from: pathBytes)
    }
    let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count + 1)
    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(descriptor, $0, addressLength)
        }
    }
    if connected != 0 {
        guard errno == EINPROGRESS || errno == EAGAIN || errno == EINTR else { throw transportError(.connect) }
        try waitForSocket(descriptor, events: Int16(POLLOUT), deadline: deadline, phase: .connect, cancellation: cancellation)
        var code: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &code, &length) == 0 else { throw transportError(.connect) }
        if code != 0 { throw LocalRPCError.transport(phase: .connect, errnoCode: code, timedOut: code == ETIMEDOUT) }
    }
    var peerUser = uid_t()
    var peerGroup = gid_t()
    guard getpeereid(descriptor, &peerUser, &peerGroup) == 0,
          peerUser == geteuid() else {
        throw LocalRPCError.peerIdentityMismatch
    }

    try cancellation.check()
    var payload = request
    payload.append(0x0A)
    try payload.withUnsafeBytes { rawBuffer in
        guard let base = rawBuffer.baseAddress else { return }
        var sent = 0
        while sent < rawBuffer.count {
            try waitForSocket(descriptor, events: Int16(POLLOUT), deadline: deadline, phase: .write, cancellation: cancellation)
            let count = Darwin.write(descriptor, base.advanced(by: sent), rawBuffer.count - sent)
            if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            guard count > 0 else { throw transportError(.write) }
            sent += count
        }
    }

    var response = Data()
    var buffer = [UInt8](repeating: 0, count: 16 * 1_024)
    while true {
        try waitForSocket(descriptor, events: Int16(POLLIN), deadline: deadline, phase: .read, cancellation: cancellation)
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
        if count < 0 { throw transportError(.read) }
        if count == 0 { throw LocalRPCError.emptyResponse }
        // Each prior chunk was known not to contain a line terminator. Scan
        // only this chunk, rather than rescanning the full accumulated response
        // response after every 16 KiB read.
        if let newline = buffer[..<count].firstIndex(of: 0x0A) {
            response.append(buffer, count: newline)
            if response.count > maximumResponseBytes { throw LocalRPCError.responseTooLarge }
            return response
        }
        response.append(buffer, count: count)
        if response.count > maximumResponseBytes { throw LocalRPCError.responseTooLarge }
    }
}

private func transportError(_ phase: LocalRPCPhase) -> LocalRPCError {
    let code = errno
    return .transport(phase: phase, errnoCode: code, timedOut: [EAGAIN, EWOULDBLOCK, ETIMEDOUT].contains(code))
}

private func checkDeadline(_ deadline: TimeInterval, phase: LocalRPCPhase) throws {
    if ProcessInfo.processInfo.systemUptime >= deadline {
        throw LocalRPCError.transport(phase: phase, errnoCode: ETIMEDOUT, timedOut: true)
    }
}

private func waitForSocket(_ descriptor: Int32, events: Int16, deadline: TimeInterval,
                           phase: LocalRPCPhase, cancellation: SocketCancellation) throws {
    while true {
        try cancellation.check()
        try checkDeadline(deadline, phase: phase)
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        var entry = pollfd(fd: descriptor, events: events, revents: 0)
        let milliseconds = Int32(min(Double(Int32.max), max(1, ceil(remaining * 1_000))))
        let result = Darwin.poll(&entry, 1, milliseconds)
        try cancellation.check()
        if result < 0 && errno == EINTR { continue }
        if result < 0 { throw transportError(phase) }
        if result == 0 { continue }
        try checkDeadline(deadline, phase: phase)
        return
    }
}

// Cancellation interrupts a blocking read without closing/reusing its descriptor
// underneath another thread. The transaction alone owns the final close.
private final class SocketCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var descriptor: Int32?
    private var cancelled = false

    func attach(_ value: Int32) throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CancellationError() }
        descriptor = value
    }
    func check() throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CancellationError() }
    }
    func cancel() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true
        if let descriptor { _ = Darwin.shutdown(descriptor, SHUT_RDWR) }
    }
    func close(_ value: Int32) {
        lock.lock(); defer { lock.unlock() }
        descriptor = nil
        Darwin.close(value)
    }
}
