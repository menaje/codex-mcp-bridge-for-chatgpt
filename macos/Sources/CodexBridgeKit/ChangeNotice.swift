import Foundation

public struct ChangeNotice: Decodable, Sendable {
    public let revision: String
    public let topics: [String]
}

struct ChangeWaitParameters: Encodable {
    let after: String?
    let waitMs: Int = 25_000
}

extension LocalRPCError {
    public var isUnsupportedMethod: Bool {
        if case .remote(let code, let message) = self {
            return code == -32600 || code == -32601 || message == "CHANGES_UNSUPPORTED"
        }
        return false
    }
}
