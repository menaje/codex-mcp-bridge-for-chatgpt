import CodexBridgeKit
import SwiftUI

struct CodexSdkSettingsSection: View {
    @EnvironmentObject private var model: AppModel
    @State private var showInfo = false
    @State private var showDetails = false
    @State private var showApiSettings = false
    @State private var apiKey = ""
    @State private var confirmApiBilling = false
    @State private var showDelete = false

    var body: some View {
        Section("Python SDK · 실험적") {
            Text("SDK 작업은 SDK에 포함된 전용 Codex로 실행합니다.")
                .font(.caption).foregroundStyle(.secondary)
            FullRowDisclosure("SDK 안내", isExpanded: $showInfo) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("SDK와 전용 Python·Codex를 한 묶음으로 설치합니다.")
                    Text("백그라운드 터미널 목록 조회와 개별 종료는 이 SDK 버전에서 지원하지 않습니다.")
                    Text("실행 중인 프로세스를 확인할 수 없으면 서버 재시작과 업데이트 적용이 보류될 수 있습니다.")
                    Text("브리지 전용 저장소에는 별도 ChatGPT 로그인이 필요할 수 있습니다.")
                }.font(.caption).foregroundStyle(.secondary)
            }
            if let runtime = model.sdkRuntime {
                if runtime.actions.install {
                    HStack {
                        Text("SDK 실행환경")
                        Spacer()
                        Button("설치") { action("install") }
                    }
                }
                if runtime.isInstalling { ProgressView("SDK 실행환경 설치 중…") }
                if runtime.actions.reinstall {
                    Text("선택한 Codex를 찾을 수 없습니다. 복구하거나 다른 설치본을 선택해 주세요.").foregroundStyle(.orange)
                    Button("같은 버전 다시 설치") { action("reinstall") }
                }
                if let bundle = runtime.bundle, runtime.selection != nil {
                    Text(verbatim: "Python \(bundle.python) · SDK \(bundle.sdk) · Codex \(bundle.codex)")
                        .font(.caption).textSelection(.enabled)
                    Text(model.usesSdkForNewAgents ? "사용 중" : "설치됨 · 미사용")
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    if model.usesSdkForNewAgents, let storage = runtime.sessionStorage {
                        Text(storage.visibleInCodexApp ? "Codex 앱과 같은 저장소를 사용합니다. 목록 갱신 시점은 앱 동작을 따릅니다." : "세션은 브리지에 저장됩니다. Codex 앱에는 연결되지 않습니다.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if runtime.account?.authenticated == false, runtime.requestedAuthMode != "api-key" {
                        Button("SDK ChatGPT 로그인") { action("login") }
                    }
                    FullRowDisclosure("SDK 인증 변경", isExpanded: $showApiSettings) {
                        LabeledContent("인증 방식", value: runtime.requestedAuthMode == "api-key" ? "OpenAI API Key" : "ChatGPT")
                        if let auth = runtime.auth {
                            LabeledContent("확인된 인증", value: auth.resolvedAuthMode == "api-key" ? "OpenAI API Key" : auth.resolvedAuthMode == "chatgpt" ? "ChatGPT" : "—")
                        }
                        Text("서버를 안전하게 종료한 뒤 변경해 주세요. API Key는 브리지 전용 로그인 저장소에서 관리됩니다.")
                            .font(.caption).foregroundStyle(.secondary)
                        if runtime.requestedAuthMode == "api-key" {
                            Button("ChatGPT 로그인 사용") {
                                Task { await model.configureSdkAuthentication(.init(authMode: "chatgpt")) }
                            }
                        }
                        SecureField("OpenAI API Key", text: $apiKey)
                        Toggle("API 사용에 별도 과금 정책이 적용됨을 확인했습니다", isOn: $confirmApiBilling)
                        Button("API Key 저장하고 사용") {
                            let submitted = apiKey
                            apiKey = ""
                            Task { await model.configureSdkAuthentication(.init(authMode: "api-key", confirmApiBilling: true, apiKey: submitted)) }
                        }
                        .disabled(!confirmApiBilling || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !runtime.runningVersions.isEmpty)
                        if let status = model.sdkAuthStatus {
                            Label(status.authenticated ? "인증 확인 완료" : "로그인이 필요합니다", systemImage: status.authenticated ? "checkmark.circle" : "exclamationmark.triangle")
                        }
                    }
                    CodexRuntimeUpdateControls(runtime: runtime, kind: "sdk")
                    if runtime.operation?.phase == "pending" {
                        Text("적용 대기")
                        Button("작업을 마치고 적용") { Task { _ = await model.restartRuntime(force: false) } }
                    }
                    FullRowDisclosure("설치 및 복구", isExpanded: $showDetails) {
                        if runtime.actions.rollback { Button("이전 버전으로 복구") { action("rollback") } }
                        if runtime.actions.cleanup {
                            Button("사용하지 않는 설치본 정리") { action("cleanup") }
                            Text(ByteCountFormatter.string(fromByteCount: Int64(runtime.reclaimableBytes), countStyle: .file))
                        }
                        Button("SDK 실행환경 삭제", role: .destructive) { showDelete = true }
                            .disabled(!runtime.actions.remove)
                    }
                }
                if runtime.actions.retry && runtime.operation?.action != "check-updates" {
                    Text("설치를 완료하지 못했습니다. 기존 설치본은 유지됩니다.")
                    Button("다시 시도") { action("retry") }
                    if runtime.actions.install {
                        ForEach(runtime.knownVersions ?? [], id: \.self) { version in
                            HStack {
                                Button("확인된 버전 설치") { Task { await model.manageCodex(.init(action: "install", kind: "sdk", version: version)) } }
                                Text(verbatim: version)
                            }
                        }
                    }
                    if runtime.actions.rollback { Button("이전 버전으로 복구") { action("rollback") } }
                }
            }
            if let error = model.sdkRuntimeError { Text(error).font(.caption).foregroundStyle(.orange) }
        }
        .confirmationDialog("브리지가 설치한 SDK 실행환경을 삭제할까요?", isPresented: $showDelete) {
            Button("삭제", role: .destructive) { action("remove") }
            Button("취소", role: .cancel) {}
        } message: {
            Text("로그인 정보, 대화 기록, 프로젝트와 브리지 설정은 유지됩니다.")
        }
    }

    private func action(_ action: String) { Task { await model.manageCodex(.init(action: action, kind: "sdk")) } }
}
