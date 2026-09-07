import AppKit
import CodexBridgeKit
import SwiftUI

struct CodexRuntimeSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let isSelected: Bool
    @State private var showInstallation = false
    @State private var showOtherAccount = false
    @State private var showSelection = false
    @State private var showVersions = false
    @State private var showDeleteConfirmation = false

    var body: some View {
        Form {
            executionSection
            accountSection
            if let runtime = model.codexRuntime {
                Section("CLI 설치본") {
                    if model.usesSdkForNewAgents {
                        Text("CLI 선택은 CLI 방식으로 돌아갈 때 사용합니다.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let selected = runtime.selection {
                        HStack {
                            Text(sourceName(selected.source))
                            Spacer()
                            Text(selected.version ?? "—").monospacedDigit()
                        }
                        if selected.available == false {
                            Label("선택한 Codex를 찾을 수 없습니다. 복구하거나 다른 설치본을 선택해 주세요.", systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.orange)
                            if runtime.actions.reinstall { Button("같은 버전 다시 설치") { action("reinstall") } }
                        } else if selected.compatible == false {
                            Text("이 버전은 아직 호환성을 확인하지 않았습니다. 선택한 버전은 유지됩니다.")
                                .font(.caption).foregroundStyle(.orange)
                        }
                        if selected.source != "bridge" {
                            Text("업데이트와 삭제는 해당 앱 또는 터미널에서 직접 관리합니다.")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("브리지가 전용으로 설치하고 업데이트·삭제를 관리하는 Codex입니다.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if !runtime.runningVersions.isEmpty && runtime.runningVersions != [selected.version ?? ""] {
                            LabeledContent("실행 중인 버전", value: runtime.runningVersions.joined(separator: ", "))
                        }
                    } else {
                        Text("사용할 Codex를 선택하거나 설치해 주세요.")
                    }
                    if runtime.configuredCommand != nil {
                        Text("환경 설정에서 지정한 Codex를 사용 중입니다. 여기서 변경하려면 지정된 경로를 먼저 해제해 주세요.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if runtime.selectionRequired {
                        selectionControls(runtime)
                    } else {
                        FullRowDisclosure("다른 Codex 사용", isExpanded: $showSelection) {
                            selectionControls(runtime)
                        }
                    }
                    if let selected = runtime.selection {
                        FullRowDisclosure("설치 정보", isExpanded: $showInstallation) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(selected.command).font(.caption).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                HStack {
                                    Button("경로 복사") {
                                        NSPasteboard.general.clearContents()
                                        NSPasteboard.general.setString(selected.command, forType: .string)
                                    }
                                    Button("폴더 열기") { NSWorkspace.shared.selectFile(selected.command, inFileViewerRootedAtPath: "") }
                                }
                            }
                        }
                    }
                }

                if runtime.isInstalling {
                    Section {
                        ProgressView(operationName(runtime.operation?.phase))
                        if let bytes = runtime.operation?.downloadedBytes,
                           let total = runtime.operation?.totalBytes, total > 0 {
                            ProgressView(value: Double(bytes), total: Double(total))
                        }
                    }
                }
                if runtime.configuredCommand == nil && (runtime.operation?.phase == "pending" || runtime.pendingSelection != nil) {
                    Section("적용 대기") {
                        Text("현재 실행환경은 유지됩니다. 작업과 승인이 끝난 뒤 서버를 다시 시작하면 적용됩니다.")
                            .font(.caption)
                        Button("작업을 마치고 적용") {
                            Task { _ = await model.restartRuntime(force: false) }
                        }
                        .disabled(model.isBusy)
                    }
                }

                if runtime.selection?.source == "bridge" && runtime.configuredCommand == nil {
                    Section("버전 관리") {
                        CodexRuntimeUpdateControls(runtime: runtime, kind: "cli")
                        FullRowDisclosure("설치 및 복구", isExpanded: $showVersions) {
                            ForEach(Array((runtime.managedVersions ?? []).enumerated()), id: \.offset) { _, version in
                                HStack {
                                    Text(verbatim: version.version)
                                    Spacer()
                                    Text(ByteCountFormatter.string(fromByteCount: Int64(version.bytes), countStyle: .file))
                                }
                            }
                            if !runtime.runningVersions.isEmpty {
                                LabeledContent("실행 중인 버전", value: runtime.runningVersions.joined(separator: ", "))
                            }
                            if runtime.actions.rollback, let version = runtime.recoveryVersion {
                                HStack {
                                    Button("이전 버전으로 복구") { action("rollback") }
                                    Text(verbatim: version).foregroundStyle(.secondary)
                                }
                            }
                            if runtime.actions.cleanup {
                                HStack {
                                    Button("사용하지 않는 설치본 정리") { action("cleanup") }
                                    Text(ByteCountFormatter.string(fromByteCount: Int64(runtime.reclaimableBytes), countStyle: .file))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Button("브리지 CLI 삭제", role: .destructive) { showDeleteConfirmation = true }
                                .disabled(!runtime.actions.remove)
                            if !runtime.actions.remove {
                                Text("삭제하려면 서버를 먼저 안전하게 종료해 주세요.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if runtime.actions.retry && runtime.operation?.action != "check-updates" {
                    Section {
                        Text("설치를 완료하지 못했습니다. 기존 설치본은 유지됩니다.")
                            .foregroundStyle(.orange)
                        Button("다시 시도") { action("retry") }
                        if runtime.actions.install {
                            ForEach(runtime.knownVersions ?? [], id: \.self) { version in
                                HStack {
                                    Button("확인된 버전 설치") { Task { await model.manageCodex(.init(action: "install", version: version)) } }
                                    Text(verbatim: version)
                                }
                            }
                        }
                        if runtime.actions.rollback { Button("이전 버전으로 복구") { action("rollback") } }
                    }
                }
            } else {
                ProgressView()
                Button("새로고침") { action("status") }
            }
            if let error = model.codexRuntimeError {
                Section("확인할 사항") { Text(error).font(.caption).foregroundStyle(.orange) }
            }
            CodexSdkSettingsSection()
        }
        .formStyle(.grouped)
        .onAppear { model.codexSettingsVisible = isSelected }
        .onChange(of: isSelected) { model.codexSettingsVisible = $0 }
        .onDisappear { model.codexSettingsVisible = false }
        .task(id: "\(isSelected):\(installing):\(model.helperChangesAvailable)") {
            while !Task.isCancelled, let interval = CodexSettingsRefreshPolicy.interval(isVisible: isSelected, installationInProgress: installing) {
                await model.manageCodex(.init(action: "status", includeAccount: !installing))
                guard !Task.isCancelled else { return }
                await model.manageCodex(.init(action: "status", kind: "sdk", includeAccount: !installing))
                do { try await Task.sleep(for: .seconds(model.helperChangesAvailable ? 60 : interval)) } catch { return }
            }
        }
        .confirmationDialog("브리지가 설치한 Codex를 삭제할까요?", isPresented: $showDeleteConfirmation) {
            Button("삭제", role: .destructive) { action("remove") }
            Button("취소", role: .cancel) {}
        } message: {
            Text("로그인 정보, 대화 기록, 프로젝트와 브리지 설정은 유지됩니다.")
        }
    }

    private var installing: Bool { model.codexRuntime?.isInstalling == true || model.sdkRuntime?.isInstalling == true }

    private var executionSection: some View {
        Section("새 작업 실행 방식") {
            HStack {
                Button {
                    Task { _ = await model.configureRuntime(defaultBackend: model.sdkRuntime?.previousBackend ?? "app-server",
                        maximumAccess: model.helperStatus?.configuration.operatorConfiguration.maximumAccess ?? "read-only") }
                } label: {
                    HStack { Text(verbatim: "CLI"); if !model.usesSdkForNewAgents { Image(systemName: "checkmark") } }
                }.disabled(model.isBusy || !model.usesSdkForNewAgents)
                Button {
                    Task { _ = await model.configureRuntime(defaultBackend: "codex-sdk",
                        maximumAccess: model.helperStatus?.configuration.operatorConfiguration.maximumAccess ?? "read-only") }
                } label: {
                    HStack { Text(verbatim: "SDK"); if model.usesSdkForNewAgents { Image(systemName: "checkmark") } }
                }.disabled(model.isBusy || model.usesSdkForNewAgents || model.sdkRuntime?.selection?.available != true)
            }
            Text("새 작업부터 선택한 방식으로 실행합니다. 기존 작업은 원래 실행 방식을 유지합니다.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var accountSection: some View {
        Section("계정 사용량") {
            if let account = model.selectedCodexAccount {
                CodexAccountUsageView(account: account, runtimeKind: model.usesSdkForNewAgents ? "sdk" : "cli")
            } else {
                Text("계정 정보를 확인할 수 없습니다.").font(.caption).foregroundStyle(.secondary)
            }
            if let other = model.otherCodexAccount {
                FullRowDisclosure("다른 실행환경의 계정", isExpanded: $showOtherAccount) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(verbatim: model.usesSdkForNewAgents ? "CLI" : "SDK").font(.caption.weight(.semibold))
                        CodexAccountUsageView(account: other, runtimeKind: model.usesSdkForNewAgents ? "cli" : "sdk")
                    }
                }
            }
        }
        if let billing = model.codexRuntime?.billing ?? model.sdkRuntime?.billing, billing.configured,
           model.selectedCodexAccount?.authMode != "api-key", model.otherCodexAccount?.authMode != "api-key" {
            Section("API 비용 연결") {
                if let organization = billing.organizationId { Text(verbatim: organization) }
                if let project = billing.projectId { Text(verbatim: project) }
                Button("비용 연결 해제") { action("remove-billing") }
            }
        }
    }

    @ViewBuilder private func selectionControls(_ runtime: CodexRuntimeSnapshot) -> some View {
        ForEach(runtime.candidates) { candidate in
            HStack {
                Text(sourceName(candidate.source))
                Text(candidate.version ?? "—").foregroundStyle(.secondary)
                Spacer()
                if candidate.id == runtime.selection?.id {
                    Image(systemName: "checkmark")
                } else {
                    Button("선택") { Task { await model.manageCodex(.init(action: "select", selectionId: candidate.id)) } }
                        .disabled(candidate.available == false || runtime.isInstalling)
                }
            }
            .help(candidate.command)
        }
        if runtime.actions.install {
            HStack {
                Text("브리지 CLI")
                Spacer()
                Button("설치") { action("install") }
            }
        }
        Text("브리지가 전용으로 설치하고 업데이트·삭제를 관리하는 Codex입니다.")
            .font(.caption).foregroundStyle(.secondary)
        if runtime.selection?.source != "bridge", runtime.candidates.contains(where: { $0.source == "bridge" }) {
            FullRowDisclosure("브리지 CLI 관리", isExpanded: $showVersions) {
                VStack(alignment: .leading, spacing: 6) {
                    if runtime.actions.cleanup {
                        Button("사용하지 않는 설치본 정리") { action("cleanup") }
                        Text(ByteCountFormatter.string(fromByteCount: Int64(runtime.reclaimableBytes), countStyle: .file))
                    }
                    Button("브리지 CLI 삭제", role: .destructive) { showDeleteConfirmation = true }
                        .disabled(!runtime.actions.remove)
                }
            }
        }
    }

    private func action(_ action: String) {
        Task { await model.manageCodex(.init(action: action)) }
    }

    private func sourceName(_ source: String) -> String {
        let key = source == "app" ? "Codex 앱" : source == "terminal" ? "터미널 CLI" : "브리지 CLI"
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    private func operationName(_ phase: String?) -> String {
        let key = phase == "downloading" ? "다운로드 중…" : phase == "verifying" ? "설치 확인 중…" : "설치 중…"
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }
}
