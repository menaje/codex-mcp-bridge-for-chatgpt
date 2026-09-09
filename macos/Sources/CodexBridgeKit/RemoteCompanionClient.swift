import CryptoKit
import Foundation
import Security

public let remoteCompanionProtocolName = "codex-mcp-bridge-remote-companion"
public let remoteCompanionProtocolVersion = 1

public enum RemoteCompanionError: LocalizedError, Sendable {
    case invalidInvitation
    case expiredInvitation
    case invalidEndpoint
    case invalidCertificatePin
    case certificateMismatch
    case serverIdentityMismatch
    case incompatibleProtocol
    case credentialMissing
    case unauthorized
    case forbidden
    case responseTooLarge
    case invalidResponse(String)
    case server(status: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .invalidInvitation:
            return "페어링 초대가 올바르지 않습니다. 서버에서 새 초대를 만들어 주세요."
        case .expiredInvitation:
            return "페어링 초대가 만료되었습니다. 서버에서 새 초대를 만들어 주세요."
        case .invalidEndpoint:
            return "서버 주소는 경로가 없는 HTTPS 주소여야 합니다."
        case .invalidCertificatePin:
            return "서버 인증서 확인 값이 올바르지 않습니다."
        case .certificateMismatch:
            return "서버 인증서가 페어링할 때 확인한 인증서와 다릅니다. 연결을 거부했습니다."
        case .serverIdentityMismatch:
            return "응답한 서버의 고유 ID가 저장된 서버와 다릅니다. 연결을 거부했습니다."
        case .incompatibleProtocol:
            return "이 앱과 서버의 원격 관리 프로토콜 버전이 호환되지 않습니다."
        case .credentialMissing:
            return "이 서버의 기기 자격 증명을 찾을 수 없어 다시 페어링해야 합니다."
        case .unauthorized:
            return "서버가 이 기기의 자격 증명을 거부했습니다. 서버에서 기기 등록을 확인해 주세요."
        case .forbidden:
            return "이 기기에는 요청한 서버 기능을 사용할 권한이 없습니다."
        case .responseTooLarge:
            return "원격 서버 응답이 허용 크기를 초과했습니다."
        case .invalidResponse(let message):
            return "원격 서버 응답을 읽을 수 없습니다: \(message)"
        case .server(_, let message):
            return message
        }
    }
}

public struct RemoteServerProtocolInfo: Codable, Sendable, Equatable {
    public let name: String
    public let version: Int
}

public struct RemoteServerIdentity: Codable, Sendable, Equatable {
    public let id: String
    public let displayName: String
    public let certificateSha256: String
}

public struct RemoteCompanionHello: Codable, Sendable, Equatable {
    public let `protocol`: RemoteServerProtocolInfo
    public let server: RemoteServerIdentity
    public let bridge: CompanionBridgeInfo
    public let capabilities: [String]

    public func validate(serverId: String, certificateSha256: String) throws {
        guard self.protocol.name == remoteCompanionProtocolName,
              self.protocol.version == remoteCompanionProtocolVersion else {
            throw RemoteCompanionError.incompatibleProtocol
        }
        guard server.id == serverId else {
            throw RemoteCompanionError.serverIdentityMismatch
        }
        guard Self.normalizedPin(server.certificateSha256) == Self.normalizedPin(certificateSha256) else {
            throw RemoteCompanionError.certificateMismatch
        }
    }

    private static func normalizedPin(_ value: String) -> String {
        value.replacingOccurrences(of: ":", with: "").lowercased()
    }
}

public struct RemoteServerProfile: Codable, Identifiable, Sendable, Equatable {
    public var id: String { serverId }
    public let serverId: String
    public var name: String
    public var endpoint: String
    public var certificateSha256: String
    public var serverDisplayName: String
    public var bridgeVersion: String
    public var bridgeBuildId: String
    public var capabilities: [String]
    public var lastConnectedAt: String?

    public init(
        serverId: String,
        name: String,
        endpoint: String,
        certificateSha256: String,
        serverDisplayName: String,
        bridgeVersion: String,
        bridgeBuildId: String,
        capabilities: [String],
        lastConnectedAt: String?
    ) {
        self.serverId = serverId
        self.name = name
        self.endpoint = endpoint
        self.certificateSha256 = certificateSha256
        self.serverDisplayName = serverDisplayName
        self.bridgeVersion = bridgeVersion
        self.bridgeBuildId = bridgeBuildId
        self.capabilities = capabilities
        self.lastConnectedAt = lastConnectedAt
    }
}

public struct RemoteClientPairingInvitation: Codable, Sendable, Equatable {
    public let version: Int
    public let `protocol`: String
    public let endpoint: String
    public let serverId: String
    public let certificateSha256: String
    public let code: String
    public let expiresAt: String

    public static func decode(_ invitation: String) throws -> Self {
        let compact = invitation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !compact.isEmpty,
              let data = Data(base64URLEncoded: compact),
              let decoded = try? JSONDecoder().decode(Self.self, from: data),
              decoded.version == 1,
              decoded.protocol == remoteCompanionProtocolName,
              UUID(uuidString: decoded.serverId) != nil,
              decoded.certificateSha256.range(
                of: "^[a-fA-F0-9]{64}$",
                options: .regularExpression
              ) != nil,
              decoded.code.count >= 40 else {
            throw RemoteCompanionError.invalidInvitation
        }
        guard let expiration = remoteISO8601Date(from: decoded.expiresAt),
              expiration > Date() else {
            throw RemoteCompanionError.expiredInvitation
        }
        _ = try RemoteHTTPTransport.normalizedEndpoint(decoded.endpoint)
        return decoded
    }
}

public struct RemotePairingResult: Sendable {
    public let profile: RemoteServerProfile
    public let credential: String
}

public struct RemoteCompanionClient: RemoteBridgeApplicationClient, Sendable {
    private let profile: RemoteServerProfile
    private let credential: String
    private let transport: RemoteHTTPTransport

    public init(profile: RemoteServerProfile, credential: String) throws {
        guard !credential.isEmpty else { throw RemoteCompanionError.credentialMissing }
        self.profile = profile
        self.credential = credential
        self.transport = try RemoteHTTPTransport(
            endpoint: profile.endpoint,
            certificateSha256: profile.certificateSha256
        )
    }

    public static func pair(
        invitation invitationText: String,
        deviceName: String,
        profileName: String? = nil
    ) async throws -> RemotePairingResult {
        let invitation = try RemoteClientPairingInvitation.decode(invitationText)
        let transport = try RemoteHTTPTransport(
            endpoint: invitation.endpoint,
            certificateSha256: invitation.certificateSha256
        )
        defer { transport.close() }
        let response: PairingResponse = try await transport.post(
            path: "/remote-companion/v1/pair",
            body: PairingRequest(
                serverId: invitation.serverId,
                code: invitation.code,
                deviceName: deviceName
            ),
            headers: [:],
            timeout: 20
        )
        try response.hello.validate(
            serverId: invitation.serverId,
            certificateSha256: invitation.certificateSha256
        )
        let chosenName = profileName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let profile = RemoteServerProfile(
            serverId: invitation.serverId,
            name: chosenName?.isEmpty == false ? chosenName! : response.hello.server.displayName,
            endpoint: invitation.endpoint,
            certificateSha256: invitation.certificateSha256.lowercased(),
            serverDisplayName: response.hello.server.displayName,
            bridgeVersion: response.hello.bridge.version,
            bridgeBuildId: response.hello.bridge.buildId,
            capabilities: response.hello.capabilities,
            lastConnectedAt: ISO8601DateFormatter().string(from: Date())
        )
        return RemotePairingResult(profile: profile, credential: response.credential)
    }

    public func close() {
        transport.close()
    }

    public func hello() async throws -> RemoteCompanionHello {
        let hello: RemoteCompanionHello = try await call(
            "companion.hello",
            params: EmptyParameters(),
            timeout: 10
        )
        try hello.validate(
            serverId: profile.serverId,
            certificateSha256: profile.certificateSha256
        )
        return hello
    }

    public func dashboard(
        limit: Int = 20,
        terminalOffset: Int = 0,
        idleOffset: Int = 0,
        enrich: Bool = false,
        statusFilter: DashboardStatusFilter = .all
    ) async throws -> DashboardSnapshot {
        try await call(
            "dashboard.snapshot",
            params: DashboardParameters(
                limit: limit,
                terminalOffset: terminalOffset,
                idleOffset: idleOffset,
                enrich: enrich,
                statusFilter: statusFilter
            ),
            timeout: enrich ? 10 : 3
        )
    }

    public func settings(
        refreshModels: Bool = false,
        locale: String = Locale.current.identifier
    ) async throws -> SettingsSnapshot {
        try await call(
            "settings.snapshot",
            params: SettingsSnapshotParameters(refreshModels: refreshModels, locale: locale),
            timeout: refreshModels ? 60 : 20
        )
    }

    public func updateSettings(_ mutation: SettingsMutation) async throws -> SettingsSnapshot {
        try await call("settings.update", params: mutation, timeout: 30)
    }

    public func historyAction(_ action: HistoryAction) async throws -> HistoryActionResult {
        try await call("dashboard.history", params: action, timeout: 15)
    }

    public func runtimeStatus(
        inspectBackgroundProcesses: Bool = false
    ) async throws -> RuntimeAdmissionSnapshot {
        try await call(
            "runtime.snapshot",
            params: RuntimeSnapshotParameters(
                inspectBackgroundProcesses: inspectBackgroundProcesses
            ),
            timeout: 15
        )
    }

    private func call<Result: Decodable, Parameters: Encodable>(
        _ method: String,
        params: Parameters,
        timeout: TimeInterval
    ) async throws -> Result {
        let requestID = UUID().uuidString.lowercased()
        let response: RemoteRPCResponse<Result> = try await transport.post(
            path: "/remote-companion/v1/rpc",
            body: RemoteRPCRequest(
                jsonrpc: "2.0",
                id: requestID,
                method: method,
                params: params
            ),
            headers: [
                "Authorization": "Bearer \(credential)",
                "X-Codex-Bridge-Server-Id": profile.serverId
            ],
            timeout: timeout
        )
        guard response.jsonrpc == "2.0", response.id == requestID else {
            throw RemoteCompanionError.invalidResponse(
                "JSON-RPC response identity did not match the request."
            )
        }
        if let error = response.error {
            throw RemoteCompanionError.server(status: error.code, message: error.message)
        }
        guard let result = response.result else {
            throw RemoteCompanionError.invalidResponse("The response did not contain a result.")
        }
        return result
    }
}

private struct PairingRequest: Encodable {
    let serverId: String
    let code: String
    let deviceName: String
}

private struct PairingResponse: Decodable {
    let credential: String
    let device: RemoteManagementDevice
    let hello: RemoteCompanionHello
}

private struct RemoteRPCRequest<Parameters: Encodable>: Encodable {
    let jsonrpc: String
    let id: String
    let method: String
    let params: Parameters
}

private struct RemoteRPCResponse<Result: Decodable>: Decodable {
    let jsonrpc: String
    let id: String?
    let result: Result?
    let error: RemoteRPCError?
}

private struct RemoteRPCError: Decodable {
    let code: Int
    let message: String
}

private final class PinnedServerTrustDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let expectedCertificateSha256: String

    init(expectedCertificateSha256: String) {
        self.expectedCertificateSha256 = expectedCertificateSha256
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = certificates.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let certificateData = SecCertificateCopyData(leaf) as Data
        let fingerprint = SHA256.hash(data: certificateData)
            .map { String(format: "%02x", $0) }
            .joined()
        guard fingerprint == expectedCertificateSha256 else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

private final class RemoteHTTPTransport: Sendable {
    private let endpoint: URL
    private let session: URLSession
    private let trustDelegate: PinnedServerTrustDelegate
    private let maximumResponseBytes = 2 * 1_024 * 1_024

    init(endpoint: String, certificateSha256: String) throws {
        self.endpoint = try Self.normalizedEndpoint(endpoint)
        let normalizedPin = certificateSha256
            .replacingOccurrences(of: ":", with: "")
            .lowercased()
        guard normalizedPin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw RemoteCompanionError.invalidCertificatePin
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        let trustDelegate = PinnedServerTrustDelegate(
            expectedCertificateSha256: normalizedPin
        )
        self.trustDelegate = trustDelegate
        session = URLSession(configuration: configuration)
    }

    deinit {
        session.invalidateAndCancel()
    }

    func close() {
        session.invalidateAndCancel()
    }

    static func normalizedEndpoint(_ input: String) throws -> URL {
        guard var components = URLComponents(string: input),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            throw RemoteCompanionError.invalidEndpoint
        }
        components.path = ""
        guard let url = components.url else { throw RemoteCompanionError.invalidEndpoint }
        return url
    }

    func post<Result: Decodable, Body: Encodable>(
        path: String,
        body: Body,
        headers: [String: String],
        timeout: TimeInterval
    ) async throws -> Result {
        try await request(
            path: path,
            method: "POST",
            body: try JSONEncoder().encode(body),
            headers: headers,
            timeout: timeout
        )
    }

    private func request<Result: Decodable>(
        path: String,
        method: String,
        body: Data?,
        headers: [String: String],
        timeout: TimeInterval
    ) async throws -> Result {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw RemoteCompanionError.invalidEndpoint
        }
        components.path = path
        guard let url = components.url else { throw RemoteCompanionError.invalidEndpoint }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let data: Data
        let response: URLResponse
        do {
            let (bytes, receivedResponse) = try await session.bytes(
                for: request,
                delegate: trustDelegate
            )
            response = receivedResponse
            let expectedLength = receivedResponse.expectedContentLength
            if expectedLength > Int64(maximumResponseBytes) {
                throw RemoteCompanionError.responseTooLarge
            }
            var received = Data()
            received.reserveCapacity(
                expectedLength > 0 ? Int(expectedLength) : 0
            )
            for try await byte in bytes {
                guard received.count < maximumResponseBytes else {
                    throw RemoteCompanionError.responseTooLarge
                }
                received.append(byte)
            }
            data = received
        } catch let error as RemoteCompanionError {
            throw error
        } catch let error as URLError where error.code == .serverCertificateUntrusted ||
            error.code == .secureConnectionFailed || error.code == .cancelled {
            throw RemoteCompanionError.certificateMismatch
        }
        guard let http = response as? HTTPURLResponse else {
            throw RemoteCompanionError.invalidResponse("Missing HTTP status.")
        }
        if http.statusCode == 401 { throw RemoteCompanionError.unauthorized }
        if http.statusCode == 403 { throw RemoteCompanionError.forbidden }
        if http.statusCode == 409 { throw RemoteCompanionError.serverIdentityMismatch }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(RemoteHTTPError.self, from: data).message) ??
                HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw RemoteCompanionError.server(status: http.statusCode, message: message)
        }
        do {
            return try JSONDecoder().decode(Result.self, from: data)
        } catch {
            throw RemoteCompanionError.invalidResponse(error.localizedDescription)
        }
    }
}

private struct RemoteHTTPError: Decodable {
    let error: String
    let message: String?
}

private func remoteISO8601Date(from value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
}

private extension Data {
    init?(base64URLEncoded value: String) {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = (4 - base64.count % 4) % 4
        base64.append(String(repeating: "=", count: padding))
        self.init(base64Encoded: base64)
    }
}
