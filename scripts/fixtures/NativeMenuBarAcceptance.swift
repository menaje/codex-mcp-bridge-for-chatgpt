import AppKit
import CodexBridgeKit
import SwiftUI

/// The production popover and its real socket clients, with synthetic work only.
@MainActor
final class MenuBarAcceptance: ObservableObject {
    let model: AppModel
    private let helper: NativeRPCFixture
    private let bridge: NativeRPCFixture

    init() {
        let root = URL(fileURLWithPath: Bundle.main.object(forInfoDictionaryKey: "AcceptanceRoot") as! String)
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path], currentDirectory: root)
        let stateFile = root.appendingPathComponent("state.json")
        let state = try! Self.state(at: stateFile)
        model = AppModel(paths: paths)
        model.previewInterfaceLocale("ko")
        model.helperStatus = try! Self.decode(HelperStatus.self, state["helper"]!)
        model.authStatus = try! Self.decode(CodexLoginStatus.self, state["auth"]!)
        model.dashboard = try! Self.decode(DashboardSnapshot.self, state["dashboard"]!)
        helper = try! NativeRPCFixture(path: paths.helperSocket.path, requestReply: { Self.reply($0, $1, file: stateFile) })
        bridge = try! NativeRPCFixture(path: paths.bridgeSocket.path, requestReply: { Self.reply($0, $1, file: stateFile) })
    }

    nonisolated private static func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }

    nonisolated private static func state(at file: URL) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
    }

    nonisolated private static func reply(_ method: String, _ raw: String, file: URL) -> NativeFixtureReply {
        let state = try! state(at: file)
        let params = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] ?? [:]
        let result: Any
        var delay: TimeInterval = 0
        switch method {
        case "helper.health", "helper.status": result = state["helper"]!
        case "auth.status": result = state["auth"]!
        case "dashboard.snapshot":
            var dashboard = state["dashboard"] as! [String: Any]
            let filter = params["statusFilter"] as? String ?? "all"
            let all = dashboard["activeRows"] as! [[String: Any]]
            let rows = all.filter { row in
                switch filter {
                case "running": return row["status"] as? String == "running"
                case "response-required": return row["status"] as? String == "approval-required"
                case "problems": return false
                default: return true
                }
            }
            dashboard["activeRows"] = rows
            if filter != "all" { dashboard["terminalRows"] = [] }
            var pagination = dashboard["pagination"] as! [String: [String: Any]]
            pagination["active"]?["returned"] = rows.count
            pagination["active"]?["total"] = rows.count
            if filter != "all" {
                pagination["terminal"]?["returned"] = 0
                pagination["terminal"]?["total"] = 0
                pagination["terminal"]?["hasNext"] = false
            }
            dashboard["pagination"] = pagination
            if var problems = dashboard["problems"] as? [String: Any], let query = params["problems"] {
                problems["query"] = query
                dashboard["problems"] = problems
            }
            result = dashboard
            delay = state["delay"] as? Double ?? 0
        case "dashboard.problem": result = ["ok": true, "changed": 1]
        default: return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"Synthetic fixture method unavailable"}}"#)
        }
        return NativeFixtureReply(body: String(decoding: try! JSONSerialization.data(withJSONObject: ["result": result]), as: UTF8.self), delay: delay)
    }
}

@main
struct NativeMenuBarAcceptanceApp: App {
    @StateObject private var acceptance = MenuBarAcceptance()
    @State private var visible = true
    @State private var dark = false
    var body: some Scene {
        WindowGroup("메뉴바 보기 검증") {
            VStack(spacing: 0) {
                HStack {
                    Toggle("화면 표시", isOn: $visible)
                    Toggle("다크 모드", isOn: $dark)
                }.padding(8)
                if visible {
                    DashboardPopoverView(fitsMenuBarWindow: true).environmentObject(acceptance.model)
                }
            }
            .preferredColorScheme(dark ? .dark : .light)
            .fixedSize()
        }
        MenuBarExtra {
            DashboardPopoverView(fitsMenuBarWindow: true).environmentObject(acceptance.model)
        } label: {
            Text("89").accessibilityLabel("Bridge Menu Acceptance")
        }
        .menuBarExtraStyle(.window)
    }
}
