import AppKit
import CodexBridgeKit
import SwiftUI

// Compiled only by native-runtime-acceptance.ts into a temporary, separate app.
// The production pane and model are copied unchanged; only the app entry point differs.
@main
struct NativeRuntimeAcceptanceApp: App {
    @StateObject private var model: AppModel
    @State private var visible = true
    @State private var dark = false

    init() {
        let root = Bundle.main.object(forInfoDictionaryKey: "AcceptanceRoot") as! String
        let model = AppModel(paths: RuntimePaths(environment: [
            "XDG_CONFIG_HOME": root,
            "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1"
        ]))
        model.previewInterfaceLocale("ko")
        _model = StateObject(wrappedValue: model)
    }

    var body: some Scene {
        WindowGroup("CLI 관리 검증") {
            VStack(spacing: 0) {
                HStack {
                    Button(visible ? "화면 나가기" : "화면 다시 열기") { visible.toggle() }
                    Button("상태 다시 읽기") { Task { await model.manageCodex(.init(action: "status")) } }
                    Toggle("검증 화면 다크 모드", isOn: $dark)
                }.padding()
                Divider()
                if visible {
                    CodexRuntimeSettingsPane(isSelected: true)
                } else {
                    Text("설정 화면을 닫았습니다.").frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .environmentObject(model)
            .environment(\.locale, Locale(identifier: "ko"))
            .preferredColorScheme(dark ? .dark : .light)
            .frame(width: 720, height: 860)
        }
    }
}
