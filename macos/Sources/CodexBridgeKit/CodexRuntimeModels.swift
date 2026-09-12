import Foundation

public struct CodexInstallation: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let source: String
    public let command: String
    public let physicalPath: String
    public let version: String?
    public let available: Bool?
    public let compatible: Bool?
}

public struct CodexRuntimePreferences: Codable, Sendable, Equatable {
    public let pinnedVersion: String?
    public let skippedVersion: String?
    public let notifications: Bool

    public init(pinnedVersion: String?, skippedVersion: String?, notifications: Bool) {
        self.pinnedVersion = pinnedVersion
        self.skippedVersion = skippedVersion
        self.notifications = notifications
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(pinnedVersion, forKey: .pinnedVersion)
        try container.encode(skippedVersion, forKey: .skippedVersion)
        try container.encode(notifications, forKey: .notifications)
    }
}

public struct CodexRuntimeOperation: Codable, Sendable, Equatable {
    public let action: String
    public let phase: String
    public let version: String?
    public let error: String?
    public let downloadedBytes: Int?
    public let totalBytes: Int?
}

public struct CodexRuntimeActions: Codable, Sendable, Equatable {
    public let install: Bool
    public let update: Bool
    public let remove: Bool
    public let reinstall: Bool
    public let rollback: Bool
    public let cleanup: Bool
    public let retry: Bool
    public let applyPending: Bool
    public let skip: Bool
}

public struct CodexRuntimeSnapshot: Codable, Sendable, Equatable {
    public let billing: CodexAccountUsage.Billing.Costs?
    public let account: CodexAccountUsage?
    public let knownVersions: [String]?
    public struct ManagedVersion: Codable, Sendable, Equatable {
        public let version: String
        public let bytes: Int
        public let active: Bool
        public let staged: Bool
        public let recovery: Bool
    }
    public let managedVersions: [ManagedVersion]?
    public let selection: CodexInstallation?
    public let candidates: [CodexInstallation]
    public let selectionRequired: Bool
    public let configuredCommand: String?
    public let pendingSelection: CodexInstallation?
    public let installedVersion: String?
    public let runningVersions: [String]
    public let updateVersion: String?
    public let latestVersion: String?
    public let checkedAt: String?
    public let lastSuccessfulCheckAt: String?
    public let updateCheckError: String?
    public let preferences: CodexRuntimePreferences
    public let operation: CodexRuntimeOperation?
    public let stagedVersion: String?
    public let recoveryVersion: String?
    public let reclaimableBytes: Int
    public let actions: CodexRuntimeActions

    public var isInstalling: Bool {
        ["downloading", "installing", "verifying"].contains(operation?.phase ?? "")
    }

    public var showsMenuUpdate: Bool {
        selection?.source == "bridge" && actions.update && preferences.notifications
    }
}

public struct CodexRuntimeRequest: Encodable, Sendable {
    public var includeAccount: Bool?
    public var billing: CodexBillingInput?
    public var version: String?
    public var kind: String?
    public let action: String
    public var selectionId: String?
    public var preferences: CodexRuntimePreferences?

    public init(action: String, kind: String? = nil, includeAccount: Bool? = nil, version: String? = nil, billing: CodexBillingInput? = nil, selectionId: String? = nil, preferences: CodexRuntimePreferences? = nil) {
        self.includeAccount = includeAccount
        self.billing = billing
        self.version = version
        self.action = action
        self.kind = kind
        self.selectionId = selectionId
        self.preferences = preferences
    }
}

public struct CodexAccountUsage: Codable, Sendable, Equatable {
    public struct Window: Codable, Sendable, Equatable, Identifiable {
        public let limitName: String?
        public let limitId: String
        public let usedPercent: Double
        public let remainingPercent: Double
        public let windowDurationMins: Double
        public let resetsAt: Double?
        public var id: String { "\(limitId):\(windowDurationMins)" }
        public var isSpark: Bool { limitId == "codex_bengalfox" }
        public var displayName: String? { isSpark ? "GPT-5.3-Codex-Spark" : limitName ?? (limitId == "codex" ? "Codex" : nil) }
    }
    public struct Credits: Codable, Sendable, Equatable {
        public let hasCredits: Bool
        public let unlimited: Bool
        public let balance: String?
    }
    public struct ResetCredits: Codable, Sendable, Equatable {
        public let availableCount: Int
    }
    public struct Billing: Codable, Sendable, Equatable {
        public struct Costs: Codable, Sendable, Equatable {
            public let configured: Bool
            public let organizationId: String?
            public let projectId: String?
            public let status: String
            public let usd: Double?
            public let startTime: Double?
            public let endTime: Double?
        }
        public let actualCosts: Costs?
    }
    public let billing: Billing?
    public let authMode: String
    public let authenticated: Bool
    public let accountKey: String?
    public let planType: String?
    public let windows: [Window]
    public let credits: Credits?
    public let resetCredits: ResetCredits?
    public let observedAt: Double

    public var weeklyUsage: WeeklyUsage? {
        guard authMode == "chatgpt", let window = windows.first(where: { $0.limitId == "codex" && $0.windowDurationMins == 10080 }) else { return nil }
        let formatter = ISO8601DateFormatter()
        return WeeklyUsage(source: "codex-account", limitId: window.limitId, usedPercent: window.usedPercent,
            remainingPercent: window.remainingPercent, windowDurationMins: 10080,
            resetsAt: window.resetsAt.map { formatter.string(from: Date(timeIntervalSince1970: $0)) },
            observedAt: formatter.string(from: Date(timeIntervalSince1970: observedAt / 1000)))
    }
    public var menuSparkWindows: [Window] {
        guard authMode == "chatgpt" else { return [] }
        return windows.filter { $0.isSpark && $0.remainingPercent < 100 }
            .sorted { $0.windowDurationMins > $1.windowDurationMins }
    }
    /// Balance is not a spend ledger. Surface it only when a plan window is exhausted.
    public var menuCreditBalance: String? {
        guard authMode == "chatgpt", let credits, credits.hasCredits, !credits.unlimited,
              let balance = credits.balance, let amount = Decimal(string: balance, locale: Locale(identifier: "en_US_POSIX")), amount > 0,
              windows.contains(where: { $0.limitId == "codex" && $0.remainingPercent <= 0 }) else { return nil }
        return balance
    }
    public func sharesKnownAccount(with other: Self) -> Bool {
        guard let accountKey, !accountKey.isEmpty else { return false }
        return authMode == other.authMode && accountKey == other.accountKey
    }
}

public enum CodexSettingsRefreshPolicy {
    public static func interval(isVisible: Bool, installationInProgress: Bool) -> Double? {
        isVisible ? (installationInProgress ? 2 : 30) : nil
    }
}

public struct CodexTokenUsage: Codable, Sendable, Equatable {
    public let inputTokens: Int
    public let cachedInputTokens: Int
    public let outputTokens: Int
    public let totalTokens: Int
}


public struct CodexBillingInput: Encodable, Sendable {
    public let adminKey: String
    public let organizationId: String
    public let projectId: String?
    public init(adminKey: String, organizationId: String, projectId: String?) {
        self.adminKey = adminKey
        self.organizationId = organizationId
        self.projectId = projectId
    }
}
