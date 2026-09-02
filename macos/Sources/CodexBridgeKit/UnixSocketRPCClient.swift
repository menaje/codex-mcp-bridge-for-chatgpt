import Darwin
import Foundation

public enum LocalRPCError: LocalizedError, Sendable {
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
        maximumResponseBytes: Int = 2 * 1_024 * 1_024
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
        let requestID = UUID().uuidString.lowercased()
        let request = RPCRequest(
            jsonrpc: "2.0",
            id: requestID,
            method: method,
            params: params
        )
        let requestData = try JSONEncoder().encode(request)
        let socketPath = self.socketPath
        let timeout = requestTimeout ?? self.timeout
        let maximumResponseBytes = self.maximumResponseBytes
        let responseData = try await Task.detached(priority: .userInitiated) {
            try transact(
                socketPath: socketPath,
                request: requestData,
                timeout: timeout,
                maximumResponseBytes: maximumResponseBytes
            )
        }.value
        do {
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
    maximumResponseBytes: Int
) throws -> Data {
    let pathBytes = Array(socketPath.utf8)
    guard !pathBytes.isEmpty, pathBytes.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
        throw LocalRPCError.invalidSocketPath
    }
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else {
        throw LocalRPCError.connectionFailed(posixMessage())
    }
    defer { Darwin.close(descriptor) }
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
    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(descriptor, $0, addressLength)
        }
    }
    guard connected == 0 else {
        throw LocalRPCError.connectionFailed(posixMessage())
    }
    var peerUser = uid_t()
    var peerGroup = gid_t()
    guard getpeereid(descriptor, &peerUser, &peerGroup) == 0,
          peerUser == geteuid() else {
        throw LocalRPCError.peerIdentityMismatch
    }

    var payload = request
    payload.append(0x0A)
    try payload.withUnsafeBytes { rawBuffer in
        guard let base = rawBuffer.baseAddress else { return }
        var sent = 0
        while sent < rawBuffer.count {
            let count = Darwin.write(descriptor, base.advanced(by: sent), rawBuffer.count - sent)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw LocalRPCError.writeFailed(posixMessage()) }
            sent += count
        }
    }

    var response = Data()
    var buffer = [UInt8](repeating: 0, count: 16 * 1_024)
    while true {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count < 0 && errno == EINTR { continue }
        if count < 0 { throw LocalRPCError.connectionFailed(posixMessage()) }
        if count == 0 { throw LocalRPCError.emptyResponse }
        response.append(buffer, count: count)
        if response.count > maximumResponseBytes { throw LocalRPCError.responseTooLarge }
        if let newline = response.firstIndex(of: 0x0A) {
            return response.prefix(upTo: newline)
        }
    }
}

private func posixMessage() -> String {
    String(cString: strerror(errno))
}
