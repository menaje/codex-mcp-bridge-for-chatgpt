import CodexBridgeKit
import SwiftUI

struct CodexRuntimeUpdateControls: View {
    @EnvironmentObject private var model: AppModel
    let runtime: CodexRuntimeSnapshot
    let kind: String

    private var checking: Bool { model.checkingCodexUpdates.contains(kind) }
    private var failed: Bool { runtime.updateCheckError != nil || (runtime.operation?.action == "check-updates" && runtime.operation?.phase == "failed") }

    var body: some View {
        Toggle("macos.keepcurrentversion", isOn: Binding(
            get: { runtime.preferences.pinnedVersion != nil },
            set: { value in preferences(pin: .some(value ? runtime.installedVersion : nil)) }
        ))
        HStack {
            Toggle("macos.updatenotifications", isOn: Binding(
                get: { runtime.preferences.notifications },
                set: { preferences(notifications: $0) }
            ))
            Spacer()
            if checking { ProgressView().controlSize(.small) }
            Button("macos.checknow") { action("check-updates") }
                .disabled(checking || runtime.isInstalling)
        }
        VStack(alignment: .leading, spacing: 5) {
            if let checked = runtime.checkedAt {
                LabeledContent("macos.lastchecked", value: DisplayFormat.dateTime(checked, locale: model.interfaceLocale))
            } else { Text("macos.updateshavenotbeencheckedyet") }
            if failed {
                Text("macos.couldnotcheckforupdatespleasetryagain").foregroundStyle(.orange)
                if let checked = runtime.lastSuccessfulCheckAt {
                    LabeledContent("macos.lastsuccessfulcheck", value: DisplayFormat.dateTime(checked, locale: model.interfaceLocale))
                }
            }
            if let latest = runtime.latestVersion {
                if latest.compare(runtime.installedVersion ?? "", options: .numeric) == .orderedDescending {
                    LabeledContent("macos.newversion", value: "\(runtime.installedVersion ?? "—") → \(latest)")
                } else if !failed { Text("macos.uptodate") }
            }
            if runtime.preferences.pinnedVersion != nil { Text("macos.keepingthecurrentversion") }
        }
        .font(.caption).foregroundStyle(.secondary)
        if let version = runtime.updateVersion, runtime.stagedVersion != version {
            HStack {
                Text(verbatim: version).monospacedDigit()
                Button("macos.updatecodex") { action("update") }
                    .disabled(!runtime.actions.update)
                Button("macos.skipthisversion") { preferences(skip: version) }
                    .disabled(!runtime.actions.skip)
            }
        }
        if let skipped = runtime.preferences.skippedVersion {
            HStack {
                LabeledContent("macos.skippedversion", value: skipped)
                Button("macos.stopskippingthisversion") { preferences(skip: .some(nil)) }
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
