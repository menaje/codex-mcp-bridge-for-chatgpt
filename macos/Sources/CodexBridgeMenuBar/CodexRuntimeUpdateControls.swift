import CodexBridgeKit
import SwiftUI

struct CodexRuntimeUpdateControls: View {
    @EnvironmentObject private var model: AppModel
    let runtime: CodexRuntimeSnapshot
    let kind: String

    private var checking: Bool { model.checkingCodexUpdates.contains(kind) }
    private var failed: Bool { runtime.updateCheckError != nil || (runtime.operation?.action == "check-updates" && runtime.operation?.phase == "failed") }

    var body: some View {
        Toggle("현재 버전 유지", isOn: Binding(
            get: { runtime.preferences.pinnedVersion != nil },
            set: { value in preferences(pin: .some(value ? runtime.installedVersion : nil)) }
        ))
        HStack {
            Toggle("업데이트 알림", isOn: Binding(
                get: { runtime.preferences.notifications },
                set: { preferences(notifications: $0) }
            ))
            Spacer()
            if checking { ProgressView().controlSize(.small) }
            Button("지금 확인") { action("check-updates") }
                .disabled(checking || runtime.isInstalling)
        }
        VStack(alignment: .leading, spacing: 5) {
            if let checked = runtime.checkedAt {
                LabeledContent("마지막 확인", value: DisplayFormat.dateTime(checked, locale: model.interfaceLocale))
            } else { Text("아직 업데이트를 확인하지 않았습니다.") }
            if failed {
                Text("업데이트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.").foregroundStyle(.orange)
                if let checked = runtime.lastSuccessfulCheckAt {
                    LabeledContent("마지막 성공", value: DisplayFormat.dateTime(checked, locale: model.interfaceLocale))
                }
            }
            if let latest = runtime.latestVersion {
                if latest.compare(runtime.installedVersion ?? "", options: .numeric) == .orderedDescending {
                    LabeledContent("새 버전", value: "\(runtime.installedVersion ?? "—") → \(latest)")
                } else if !failed { Text("최신 버전입니다.") }
            }
            if runtime.preferences.pinnedVersion != nil { Text("현재 버전 유지 중") }
        }
        .font(.caption).foregroundStyle(.secondary)
        if let version = runtime.updateVersion {
            HStack {
                Text(verbatim: version).monospacedDigit()
                Button("코덱스 업데이트") { action("update") }
                Button("이 버전 건너뛰기") { preferences(skip: version) }
            }
        }
        if let skipped = runtime.preferences.skippedVersion {
            HStack {
                LabeledContent("건너뛴 버전", value: skipped)
                Button("건너뛰기 해제") { preferences(skip: .some(nil)) }
            }
        }
    }

    private func action(_ action: String) { Task { await model.manageCodex(.init(action: action, kind: kind)) } }
    private func preferences(pin: String?? = nil, skip: String?? = nil, notifications: Bool? = nil) {
        let value = CodexRuntimePreferences(pinnedVersion: pin ?? runtime.preferences.pinnedVersion,
            skippedVersion: skip ?? runtime.preferences.skippedVersion, notifications: notifications ?? runtime.preferences.notifications)
        Task { await model.manageCodex(.init(action: "preferences", kind: kind, preferences: value)) }
    }
}
