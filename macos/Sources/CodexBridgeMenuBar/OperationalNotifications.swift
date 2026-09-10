import AppKit
import CodexBridgeKit
import CryptoKit
import Foundation
import UserNotifications

/// Deliberately accepts operational state only. Codex task/Activity events are not inputs.
enum OperationalProblem: String, Codable, CaseIterable, Sendable {
    case runtime, tunnel, configuration, authentication, installation, remoteConnection, remoteSecurity, compatibility

    var isSecurity: Bool { self == .remoteSecurity }
    var settingsTab: String {
        switch self {
        case .authentication, .installation: return "codex"
        default: return "connection"
        }
    }
    var messageKey: String {
        switch self {
        case .runtime: return "브리지를 사용할 수 없습니다. 연결 설정에서 상태와 복구 방법을 확인해 주세요."
        case .tunnel: return "ChatGPT 연결을 복구하지 못했습니다. 연결 설정에서 터널을 확인해 주세요."
        case .configuration: return "브리지 설정을 확인해야 합니다. 연결 설정을 열어 필수 항목을 확인해 주세요."
        case .authentication: return "Codex 인증을 확인해야 합니다. Codex 설정에서 로그인 상태를 확인해 주세요."
        case .installation: return "사용할 Codex를 찾지 못했습니다. Codex 설정에서 설치 또는 선택해 주세요."
        case .remoteConnection: return "원격 서버에 연결하지 못했습니다. 연결 설정에서 서버 상태를 확인해 주세요."
        case .remoteSecurity: return "원격 연결의 보안 확인이 필요합니다. 연결 설정에서 서버와 기기 등록을 확인해 주세요."
        case .compatibility: return "구성 요소가 호환되지 않습니다. 연결 설정에서 업데이트 또는 복구 방법을 확인해 주세요."
        }
    }

    static func remoteError(_ error: Error) -> Self {
        switch error {
        case RemoteCompanionError.certificateMismatch, RemoteCompanionError.serverIdentityMismatch,
             RemoteCompanionError.invalidCertificatePin, RemoteCompanionError.credentialMissing,
             RemoteCompanionError.unauthorized, RemoteCompanionError.forbidden: return .remoteSecurity
        case RemoteCompanionError.incompatibleProtocol: return .compatibility
        default: return .remoteConnection
        }
    }
}

enum OperationalObservation: Equatable {
    case unknown
    case healthy
    case problem(OperationalProblem)
}

struct OperationalNotificationPolicy: Codable {
    // Persist unresolved causes, not a recovery interval that cannot be observed
    // while the app is closed. Older saved healthySince values are ignored.
    private enum CodingKeys: String, CodingKey { case entries }
    struct Entry: Codable {
        var firstObserved: Date
        var delivered = false
    }
    var entries: [String: Entry] = [:]
    var healthySince: [String: Date] = [:]
    private var lastObservationAt: [String: Date] = [:]
    static let grace: TimeInterval = 60
    private static let maximumObservationGap: TimeInterval = 30

    static func scope(_ identity: String) -> String {
        SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func key(scope: String, problem: OperationalProblem) -> String { "\(scope):\(problem.rawValue)" }

    mutating func observe(_ observation: OperationalObservation, scope: String, now: Date) -> OperationalProblem? {
        if let previous = lastObservationAt[scope],
           now < previous || now.timeIntervalSince(previous) > Self.maximumObservationGap {
            healthySince.removeValue(forKey: scope)
        }
        lastObservationAt[scope] = now
        switch observation {
        case .unknown:
            healthySince.removeValue(forKey: scope)
            return nil // A gap in observations is not proof of continuous recovery.
        case .healthy:
            entries = entries.filter { !$0.key.hasPrefix(scope + ":") || $0.value.delivered }
            if healthySince[scope] == nil { healthySince[scope] = now }
            if now.timeIntervalSince(healthySince[scope]!) >= Self.grace {
                entries = entries.filter { !$0.key.hasPrefix(scope + ":") }
            }
            return nil
        case .problem(let problem):
            healthySince.removeValue(forKey: scope)
            let key = Self.key(scope: scope, problem: problem)
            if entries[key] == nil { entries[key] = Entry(firstObserved: now) }
            // Retain a bounded restart-safe record without storing server addresses or diagnostics.
            if entries.count > 128, let oldest = entries.filter({ $0.key != key })
                .min(by: { $0.value.firstObserved < $1.value.firstObserved })?.key {
                entries.removeValue(forKey: oldest)
            }
            healthySince = healthySince.filter { now.timeIntervalSince($0.value) < 86_400 }
            guard let entry = entries[key], !entry.delivered,
                  now.timeIntervalSince(entry.firstObserved) >= Self.grace else { return nil }
            return problem
        }
    }

    mutating func markDelivered(scope: String, problem: OperationalProblem) {
        entries[Self.key(scope: scope, problem: problem)]?.delivered = true
    }
}

enum OperationalNotificationPermission: Equatable, Sendable {
    case unknown, notDetermined, denied, authorized
}

@MainActor
protocol OperationalNotificationDelivering: AnyObject {
    func isAuthorized() async -> Bool
    func permission() async -> OperationalNotificationPermission
    func requestAuthorization() async -> Bool
    func deliver(identifier: String, problem: OperationalProblem, scope: String, locale: Locale) async throws
}

@MainActor
extension OperationalNotificationDelivering {
    func permission() async -> OperationalNotificationPermission {
        await isAuthorized() ? .authorized : .denied
    }
}

@MainActor
final class SystemOperationalNotificationDelivery: NSObject, OperationalNotificationDelivering, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    var onOpen: (@MainActor (OperationalProblem, String) -> Void)?

    override init() {
        super.init()
        center.delegate = self
    }

    func isAuthorized() async -> Bool {
        await permission() == .authorized
    }

    func permission() async -> OperationalNotificationPermission {
        await withCheckedContinuation { continuation in
            center.getNotificationSettings { settings in
                // Older SDKs do not mark the settings object Sendable; pass only the result across actors.
                continuation.resume(returning: Self.permission(for: settings.authorizationStatus))
            }
        }
    }

    nonisolated static func permission(for status: UNAuthorizationStatus) -> OperationalNotificationPermission {
        switch status {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .authorized, .provisional: return .authorized
        @unknown default: return .unknown
        }
    }

    func requestAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                continuation.resume(returning: error == nil && granted)
            }
        }
    }

    func deliver(identifier: String, problem: OperationalProblem, scope: String, locale: Locale) async throws {
        let request = UNNotificationRequest(identifier: identifier,
            content: Self.content(problem: problem, scope: scope, locale: locale), trigger: nil)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    static func content(problem: OperationalProblem, scope: String, locale: Locale) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "Codex MCP Bridge for ChatGPT"
        content.body = BridgeAppLocalization.string(problem.messageKey, locale: locale)
        content.userInfo = ["problem": problem.rawValue, "scope": scope]
        content.threadIdentifier = "bridge-operations"
        content.sound = .default
        // Ordinary notifications respect the user's macOS notification settings and Focus.
        return content
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let raw = info["problem"] as? String, let problem = OperationalProblem(rawValue: raw),
           let scope = info["scope"] as? String {
            Task { @MainActor [weak self] in self?.onOpen?(problem, scope) }
        }
        completionHandler()
    }
}

@MainActor
final class OperationalNotifications {
    private let defaults: UserDefaults
    private let delivery: any OperationalNotificationDelivering
    private var policy: OperationalNotificationPolicy
    private var inFlight = Set<String>()
    private var latestObservation: OperationalObservation = .unknown
    private var latestScope = ""
    private let stateKey = "bridgeOperationalNotifications.state.v1"
    private(set) var authorized = false
    private(set) var actionRequired: OperationalProblem?

    init(defaults: UserDefaults, delivery: any OperationalNotificationDelivering) {
        self.defaults = defaults
        self.delivery = delivery
        policy = defaults.data(forKey: stateKey).flatMap { try? JSONDecoder().decode(OperationalNotificationPolicy.self, from: $0) }
            ?? OperationalNotificationPolicy()
    }

    var bridgeEnabled: Bool {
        get { defaults.object(forKey: "bridgeOperationalNotifications.enabled") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "bridgeOperationalNotifications.enabled") }
    }
    var securityEnabled: Bool {
        get { defaults.object(forKey: "bridgeOperationalNotifications.security") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "bridgeOperationalNotifications.security") }
    }

    func permission() async -> OperationalNotificationPermission {
        let value = await delivery.permission()
        authorized = value == .authorized
        return value
    }

    func requestAuthorization() async -> Bool {
        authorized = await delivery.requestAuthorization()
        return authorized
    }

    func refresh(observation: OperationalObservation, scope: String, locale: Locale, now: Date = Date()) async {
        latestObservation = observation
        latestScope = scope
        let candidate = policy.observe(observation, scope: scope, now: now)
        if case .problem(let problem) = observation,
           let entry = policy.entries[OperationalNotificationPolicy.key(scope: scope, problem: problem)],
           now.timeIntervalSince(entry.firstObserved) >= OperationalNotificationPolicy.grace {
            actionRequired = problem
        } else { actionRequired = nil }
        save()
        guard let candidate else { return }
        let key = OperationalNotificationPolicy.key(scope: scope, problem: candidate)
        guard candidate.isSecurity ? securityEnabled : bridgeEnabled, inFlight.insert(key).inserted else { return }
        defer { inFlight.remove(key) }
        authorized = await delivery.isAuthorized()
        guard authorized, latestScope == scope, latestObservation == .problem(candidate),
              candidate.isSecurity ? securityEnabled : bridgeEnabled else { return }
        do {
            try await delivery.deliver(identifier: key, problem: candidate, scope: scope, locale: locale)
            policy.markDelivered(scope: scope, problem: candidate)
            save()
        } catch {
            // Leave the menu's repair action available and retry on the next operational refresh.
        }
    }

    private func save() { if let data = try? JSONEncoder().encode(policy) { defaults.set(data, forKey: stateKey) } }
}
