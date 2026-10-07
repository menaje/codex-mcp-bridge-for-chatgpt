import Darwin
import Foundation

public enum LocalRPCPhase: String, Sendable { case queued, connect, send, receive, decode }
public enum RPCFailureKind: String, Sendable { case timeout, refused, peerClosed, cancelled, contractMismatch, permissionDenied, transport, remote }

/// Observation metadata is separate from confirmed content and execution state.
public struct RPCObservationFailure: Equatable, Sendable {
    public let kind: RPCFailureKind
    public let phase: LocalRPCPhase?
    public let posixCode: Int32?

    public init(_ error: Error) {
        if error is CancellationError { kind = .cancelled; phase = nil; posixCode = nil; return }
        guard let error = error as? LocalRPCError else { kind = .transport; phase = nil; posixCode = nil; return }
        switch error {
        case .deadlineExceeded(let at): kind = .timeout; phase = at; posixCode = nil
        case .transport(let at, let code):
            phase = at; posixCode = code
            switch code {
            case EAGAIN, ETIMEDOUT: kind = .timeout
            case ECONNREFUSED, ENOENT: kind = .refused
            case ECONNRESET, ENOTCONN, EPIPE: kind = .peerClosed
            case EACCES, EPERM: kind = .permissionDenied
            default: kind = .transport
            }
        case .emptyResponse: kind = .peerClosed; phase = .receive; posixCode = nil
        case .malformedResponse: kind = .contractMismatch; phase = .decode; posixCode = nil
        case .peerIdentityMismatch: kind = .permissionDenied; phase = .connect; posixCode = nil
        case .remote(_, let code):
            kind = code.hasPrefix("STATE_READ_STALE:") || code.hasPrefix("STATE_READ_FAILED: STATE_READ_STALE:") ? .timeout
                : code.hasPrefix("STATE_READ_CANCELLED:") ? .cancelled : .remote
            phase = nil; posixCode = nil
        default: kind = .transport; phase = nil; posixCode = nil
        }
    }
}

public enum LocalRPCError: LocalizedError, Sendable {
    case invalidSocketPath
    case transport(phase: LocalRPCPhase, code: Int32)
    case deadlineExceeded(phase: LocalRPCPhase)
    case peerIdentityMismatch
    case connectionFailed(String)
    case writeFailed(String)
    case responseTooLarge
    case emptyResponse
    case malformedResponse(String)
    case remote(code: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .transport(_, let code):
            return "로컬 서비스 전송 실패: \(String(cString: strerror(code)))"
        case .deadlineExceeded:
            return "로컬 서비스 응답 확인 시간이 만료되었습니다."
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
        let cancellation = SocketCancellation()
        let timeout = requestTimeout ?? self.timeout
        guard timeout.isFinite, timeout > 0, timeout < 86_400 else {
            throw LocalRPCError.transport(phase: .queued, code: EINVAL)
        }
        let expiry = DispatchWorkItem { cancellation.expire() }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout, execute: expiry)
        defer { expiry.cancel() }
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
        let maximumResponseBytes = self.maximumResponseBytes
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
                                request: requestData, timeout: timeout,
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
            try cancellation.setPhase(.decode)
            try BridgeTextIntegrity.validateJSONUTF8(responseData)
            let envelope = try JSONDecoder().decode(RPCResponse<Result>.self, from: responseData)
            guard envelope.jsonrpc == "2.0", envelope.id == requestID else {
                throw LocalRPCError.malformedResponse("JSON-RPC response identity did not match the request.")
            }
            if let error = envelope.error {
                throw LocalRPCError.remote(code: error.code, message: error.message)
            }
            guard let result = envelope.result else { throw LocalRPCError.malformedResponse("BRIDGE_RESPONSE_CONTRACT_MISMATCH") }
            try cancellation.check()
            try Task.checkCancellation()
            return result
        } catch is CancellationError {
            throw CancellationError()
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
    timeout: TimeInterval,
    maximumResponseBytes: Int,
    cancellation: SocketCancellation
) throws -> Data {
    let pathBytes = Array(socketPath.utf8)
    guard !pathBytes.isEmpty, pathBytes.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
        throw LocalRPCError.invalidSocketPath
    }
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else {
        throw LocalRPCError.transport(phase: .connect, code: errno)
    }
    defer { cancellation.close(descriptor) }
    try cancellation.attach(descriptor)
    var noSignal: Int32 = 1
    _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)

    var socketTimeout = timeval(
        tv_sec: Int(timeout),
        tv_usec: Int32((timeout - floor(timeout)) * 1_000_000)
    )
    withUnsafePointer(to: &socketTimeout) { pointer in
        _ = setsockopt(
            descriptor,
            SOL_SOCKET,
            SO_RCVTIMEO,
            pointer,
            socklen_t(MemoryLayout<timeval>.size)
        )
        _ = setsockopt(
            descriptor,
            SOL_SOCKET,
            SO_SNDTIMEO,
            pointer,
            socklen_t(MemoryLayout<timeval>.size)
        )
    }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        destination.initializeMemory(as: UInt8.self, repeating: 0)
        destination.copyBytes(from: pathBytes)
    }
    let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count + 1)
    try cancellation.setPhase(.connect)
    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(descriptor, $0, addressLength)
        }
    }
    let connectCode = errno
    try cancellation.check()
    guard connected == 0 else {
        throw LocalRPCError.transport(phase: .connect, code: connectCode)
    }
    var peerUser = uid_t()
    var peerGroup = gid_t()
    guard getpeereid(descriptor, &peerUser, &peerGroup) == 0,
          peerUser == geteuid() else {
        throw LocalRPCError.peerIdentityMismatch
    }

    try cancellation.setPhase(.send)
    var payload = request
    payload.append(0x0A)
    try payload.withUnsafeBytes { rawBuffer in
        guard let base = rawBuffer.baseAddress else { return }
        var sent = 0
        while sent < rawBuffer.count {
            let count = Darwin.write(descriptor, base.advanced(by: sent), rawBuffer.count - sent)
            if count < 0 && errno == EINTR { continue }
            let code = errno
            try cancellation.check()
            guard count > 0 else { throw LocalRPCError.transport(phase: .send, code: code) }
            sent += count
        }
    }

    try cancellation.setPhase(.receive)
    var response = Data()
    var buffer = [UInt8](repeating: 0, count: 16 * 1_024)
    while true {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count < 0 && errno == EINTR { continue }
        let code = errno
        try cancellation.check()
        if count < 0 { throw LocalRPCError.transport(phase: .receive, code: code) }
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

// Cancellation interrupts a blocking read without closing/reusing its descriptor
// underneath another thread. The transaction alone owns the final close.
private final class SocketCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var descriptor: Int32?
    private var cancelled = false
    private var timedOut = false
    private var phase: LocalRPCPhase = .queued

    func attach(_ value: Int32) throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CancellationError() }
        if timedOut { throw LocalRPCError.deadlineExceeded(phase: phase) }
        descriptor = value
    }
    func check() throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CancellationError() }
        if timedOut { throw LocalRPCError.deadlineExceeded(phase: phase) }
    }
    func setPhase(_ next: LocalRPCPhase) throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CancellationError() }
        if timedOut { throw LocalRPCError.deadlineExceeded(phase: phase) }
        phase = next
    }
    func expire() {
        lock.lock(); defer { lock.unlock() }
        timedOut = true
        if let descriptor { _ = Darwin.shutdown(descriptor, SHUT_RDWR) }
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
