import AppKit
import CodexBridgeKit
import SwiftUI
import UserNotifications

@MainActor
final class OperationalAcceptance: ObservableObject {
    let model: AppModel
    let root: URL
    private let delivery: SystemOperationalNotificationDelivery
    private var helper: NativeRPCFixture?
    private var bridge: NativeRPCFixture?
    @Published var status = "정상"
    @Published var dark = false

    init() {
        root = URL(fileURLWithPath: Bundle.main.object(forInfoDictionaryKey: "AcceptanceRoot") as! String)
        delivery = SystemOperationalNotificationDelivery()
        let defaults = UserDefaults(suiteName: "com.menaje.bridge-operations-acceptance.policy")!
        defaults.removePersistentDomain(forName: "com.menaje.bridge-operations-acceptance.policy")
        model = AppModel(paths: RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path,
            "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1"]),
            operationalNotifications: OperationalNotifications(defaults: defaults, delivery: delivery))
        model.previewInterfaceLocale("ko")
        let stateFile = root.appendingPathComponent("state.json")
        try! Self.writeState(to: stateFile, state: "healthy")
        let initial = try! Self.state(at: stateFile)
        model.helperStatus = try! Self.decode(HelperStatus.self, initial["helper"]!)
        model.authStatus = try! Self.decode(CodexLoginStatus.self, initial["auth"]!)
        model.dashboard = try! Self.decode(DashboardSnapshot.self, initial["dashboard"]!)
        let run = root.appendingPathComponent("codex-mcp-bridge/run")
        for name in ["helper", "bridge"] {
            let socket = run.appendingPathComponent("\(name).sock").path
            try? FileManager.default.removeItem(atPath: socket)
            let fixture = try! NativeRPCFixture(path: socket) { method in
                let key = ["helper.health": "helper", "helper.status": "helper", "auth.status": "auth",
                    "dashboard.snapshot": "dashboard"][method]
                let result: [String: Any]
                if let key, let state = try? Self.state(at: stateFile), let value = state[key] {
                    result = ["result": value]
                } else if method == "helper.hello" { result = ["result": [:]] }
                else { result = ["error": ["code": -32601, "message": "Not provided by this acceptance fixture."]] }
                return NativeFixtureReply(body: String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
            }
            if name == "helper" { helper = fixture } else { bridge = fixture }
        }
        delivery.onOpen = { [weak self] problem, scope in
            guard let self else { return }
            self.model.showOperationalProblem(problem, scope: scope)
            self.status = "알림 클릭 → \(self.model.requestedSettingsTab ?? "unknown")"
            try? Data(self.status.utf8).write(to: self.root.appendingPathComponent("notification-click.txt"), options: .atomic)
        }
    }

    func select(_ state: String, aged: Bool = false) async {
        try! Self.writeState(to: root.appendingPathComponent("state.json"), state: state)
        await model.refreshStatus()
        await model.refreshAuthStatus()
        await model.refreshDashboard()
        let now = Date()
        await model.refreshOperationalNotifications(at: now)
        if aged { await model.refreshOperationalNotifications(at: now.addingTimeInterval(61)) }
        status = "\(state) · \(model.health.accessibilityLabel(locale: Locale(identifier: "ko")))"
    }

    func clearNotifications() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        status = "검증 앱의 알림을 정리했습니다"
    }

    func authorize() async {
        do {
            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            status = "알림 권한: \(allowed)"
        } catch { status = "알림 권한 오류: \(error)" }
        try? Data(status.utf8).write(to: root.appendingPathComponent("authorization.txt"), options: .atomic)
    }

    nonisolated private static func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
    nonisolated private static func state(at file: URL) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
    }
    nonisolated private static func writeState(to file: URL, state: String) throws {
        let page: [String: Any] = ["offset": 0, "limit": 12, "returned": 0, "total": 0,
            "returnedConversations": 0, "conversationTotal": 0, "hasPrevious": false, "hasNext": false]
        let countNames = ["trackedProjects", "trackedConversations", "retainedJobs", "active", "running", "inputRequired",
            "approvalRequired", "terminating", "needsAttention", "backgroundProcesses", "backgroundProcessAgents",
            "runtimeUnknownAgents", "runtimeProbeSkippedAgents", "completed", "failed", "interrupted", "cancelled", "idleAgents", "orphanedAgents"]
        let data: [String: Any] = [
            "helper": ["kind": "helper-status", "generatedAt": "2026-09-07T00:00:00Z",
                "phase": state == "runtime" ? "starting" : "running", "restartAttempt": 0,
                "configuration": ["path": "/private/acceptance/.env", "exists": true, "valid": true, "hasApiKey": true, "hasTunnelId": true],
                "bridge": ["socketPath": "/private/acceptance/bridge.sock", "connected": true],
                "tunnel": ["phase": "connected", "doctorPassed": true, "processRunning": true, "connected": true]],
            "auth": ["installed": true, "authenticated": state != "authentication", "summary": "Synthetic acceptance"],
            "dashboard": ["kind": "dashboard", "generatedAt": "2026-09-07T00:00:00Z", "scope": "bridge-wide",
                "statusSource": "codex-runtime-only", "coverage": "complete", "counts": Dictionary(uniqueKeysWithValues: countNames.map { ($0, 0) }),
                "activeRows": [], "terminalRows": [], "idleRows": [], "pagination": ["active": page, "terminal": page, "idle": page], "uiLocalePreference": "ko"]]
        try JSONSerialization.data(withJSONObject: data).write(to: file, options: .atomic)
    }
}

@main
struct NativeOperationalAcceptanceApp: App {
    @StateObject private var acceptance = OperationalAcceptance()
    var body: some Scene {
        WindowGroup("운영 알림·접근성 검증") {
            VStack(spacing: 10) {
                HStack {
                    Button("정상 상태") { Task { await acceptance.select("healthy") } }
                    Button("일시적 연결 확인") { Task { await acceptance.select("runtime") } }
                    Button("조치 필요 알림") { Task { await acceptance.select("runtime", aged: true) } }
                }
                HStack {
                    Button("알림 권한 요청") { Task { await acceptance.authorize() } }
                    Button("인증 문제 알림") { Task { await acceptance.select("authentication", aged: true) } }
                    Button("검증 알림 정리") { acceptance.clearNotifications() }
                    Toggle("다크 모드", isOn: $acceptance.dark)
                }
                Text(acceptance.status).accessibilityIdentifier("acceptance-status")
                Divider()
                DashboardPopoverView().environmentObject(acceptance.model)
            }
            .padding(12)
            .environment(\.locale, Locale(identifier: "ko"))
            .preferredColorScheme(acceptance.dark ? .dark : .light)
        }
    }
}
