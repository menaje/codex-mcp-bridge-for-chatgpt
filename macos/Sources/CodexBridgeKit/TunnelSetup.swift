import Foundation

public struct TunnelSetupDiscovery: Codable, Sendable {
    public let kind: String
    public let candidates: [TunnelSetupCandidate]
}

public struct TunnelSetupCandidate: Codable, Identifiable, Sendable {
    public let id: String
    public let source: String
    public let profileName: String?
    public let tunnelId: String
    public let hasApiKey: Bool
    public let apiKeySource: String
}

public struct SetupImportParameters: Codable, Sendable {
    public let candidateId: String
    public let mode: String
    public let timeoutMs: Int

    public init(candidateId: String, force: Bool, timeoutMilliseconds: Int) {
        self.candidateId = candidateId
        self.mode = force ? "force" : "drain"
        self.timeoutMs = timeoutMilliseconds
    }
}

public struct TunnelSetupInput: Equatable, Sendable {
    public let apiKey: String?
    public let tunnelId: String?

    public init(apiKey: String?, tunnelId: String?) {
        self.apiKey = apiKey
        self.tunnelId = tunnelId
    }

    public var isEmpty: Bool {
        apiKey == nil && tunnelId == nil
    }
}

public enum TunnelSetupInputParser {
    private static let apiKeyExpression = try! NSRegularExpression(
        pattern: #"(?<![A-Za-z0-9._~+/-])sk-(?![aA][dD][mM][iI][nN]-)[A-Za-z0-9._~+/=-]{16,}(?![A-Za-z0-9._~+/=-])"#
    )
    private static let tunnelIDExpression = try! NSRegularExpression(
        pattern: #"(?<![A-Za-z0-9_])tunnel_[a-z0-9]{32}(?![A-Za-z0-9_])"#
    )

    public static func parse(_ value: String) -> TunnelSetupInput {
        TunnelSetupInput(
            apiKey: firstMatch(apiKeyExpression, in: value),
            tunnelId: firstMatch(tunnelIDExpression, in: value)
        )
    }

    private static func firstMatch(_ expression: NSRegularExpression, in value: String) -> String? {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = expression.firstMatch(in: value, range: range),
              let matchRange = Range(match.range, in: value) else {
            return nil
        }
        return String(value[matchRange])
    }
}
