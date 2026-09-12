import Foundation

public enum ProblemReview: String, Codable, Sendable, CaseIterable {
    case pending, acknowledged, automatic
}

public enum ProblemView: String, Codable, Sendable, CaseIterable {
    case actionable, history, automatic
}

public enum ProblemKind: String, Codable, Sendable, CaseIterable {
    case all, failed, unknown, orphaned
    case terminationFailed = "termination-failed"
}

public struct ProblemQuery: Codable, Sendable, Equatable {
    public var review: ProblemReview
    public var kind: ProblemKind
    public var offset: Int
    public var view: ProblemView?
    public init(review: ProblemReview = .pending, kind: ProblemKind = .all, offset: Int = 0, view: ProblemView? = nil) {
        self.review = review
        self.kind = kind
        self.offset = offset
        self.view = view
    }
}

public struct DashboardProblems: Codable, Sendable {
    public let query: ProblemQuery
    public let revision: String
    public let pendingCount: Int
    public let acknowledgedCount: Int
    public let reviewableCount: Int
    public var historyCount: Int? = nil
    public var automaticCount: Int? = nil
    public let rows: [DashboardProblem]
    public let page: ProblemPage
}

public struct ProblemPage: Codable, Sendable {
    public let offset: Int
    public let limit: Int
    public let total: Int
    public let returned: Int
    public let hasPrevious: Bool
    public let hasNext: Bool
}

public struct DashboardProblem: Codable, Identifiable, Sendable {
    public var id: String { problemKey }
    public let problemKey: String
    public let revision: String
    public let kind: ProblemKind
    public let source: String
    public let review: ProblemReview
    public let acknowledgedAt: String?
    public let observedAt: String
    public let reason: String?
    public let canAcknowledge: Bool
    public let canUnacknowledge: Bool
    public let canRecheck: Bool
    public let canRetryStop: Bool
    public let stopImpact: ProblemStopImpact?
    public var automatic: AutomaticRecoverySummary? = nil
    public let row: DashboardRow

    public var target: ProblemTarget {
        ProblemTarget(problemKey: problemKey, expectedRevision: revision)
    }
}

public struct AutomaticRecoverySummary: Codable, Sendable {
    public let kind: String
    public let state: String
    public let attempts: Int
    public let reason: String
    public let evidence: String?
}

public struct ProblemStopImpact: Codable, Sendable {
    public let affectedJobIds: [String]
    public let agentNames: [String]
}

public struct ProblemTarget: Codable, Sendable, Equatable {
    public let problemKey: String
    public let expectedRevision: String
    public init(problemKey: String, expectedRevision: String) {
        self.problemKey = problemKey
        self.expectedRevision = expectedRevision
    }
}

public enum ProblemActionKind: String, Codable, Sendable {
    case acknowledge, unacknowledge, recheck
    case retryStop = "retry-stop"
}

public struct ProblemAction: Codable, Sendable {
    public let action: ProblemActionKind
    public let targets: [ProblemTarget]
    public let acknowledgeAffectedJobIds: [String]?
    public let requestId: String
    public init(action: ProblemActionKind, targets: [ProblemTarget], acknowledgeAffectedJobIds: [String]? = nil,
                requestId: String = UUID().uuidString) {
        self.action = action
        self.targets = targets
        self.acknowledgeAffectedJobIds = acknowledgeAffectedJobIds
        self.requestId = requestId
    }
}

public struct ProblemActionResult: Codable, Sendable {
    public let ok: Bool
    public let changed: Int
}
