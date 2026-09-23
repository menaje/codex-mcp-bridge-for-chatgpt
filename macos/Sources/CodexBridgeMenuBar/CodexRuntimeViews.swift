import AppKit
import CodexBridgeKit
import SwiftUI

struct CodexRuntimeSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let isSelected: Bool
    let searchRequest: SettingsSearchRequest?
    @State private var showInstallation = false
    @State private var showSelection = false
    @State private var showVersions = false
    @State private var showDeleteConfirmation = false

    var body: some View {
        SettingsSearchScrollContainer(request: searchRequest, pane: .codex) {
            Form {
                accountSection
                if let runtime = model.codexRuntime {
                    Section("macos.cliinstallation") {
                    if let selected = runtime.selection {
                        HStack {
                            Text(sourceName(selected.source))
                            Spacer()
                            Text(selected.version ?? "—").monospacedDigit()
                        }
                        if selected.available == false {
                            Label("macos.theselectedcodexinstallationisunavailablerestoreit", systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.orange)
                            if runtime.actions.reinstall { Button("macos.reinstallthisversion") { action("reinstall") } }
                        }
                        if selected.source != "bridge" {
                            Text("macos.manageupdatesandremovalintheoriginalapp")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("macos.adedicatedcodexinstallationthatthebridgeinstalls")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if !runtime.runningVersions.isEmpty && runtime.runningVersions != [selected.version ?? ""] {
                            LabeledContent("macos.runningversion", value: runtime.runningVersions.joined(separator: ", "))
                        }
                    } else {
                        Text("macos.chooseorinstallcodextouse")
                    }
                    if runtime.configuredCommand != nil {
                        Text("macos.codexisselectedbyanenvironmentsettingremove")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if runtime.selectionRequired {
                        selectionControls(runtime)
                    } else {
                        FullRowDisclosure("macos.useanothercodexinstallation", isExpanded: $showSelection) {
                            selectionControls(runtime)
                        }
                    }
                    if let selected = runtime.selection {
                        FullRowDisclosure("macos.installationdetails", isExpanded: $showInstallation) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(selected.command).font(.caption).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                HStack {
                                    Button("macos.copypath") {
                                        NSPasteboard.general.clearContents()
                                        NSPasteboard.general.setString(selected.command, forType: .string)
                                    }
                                    Button("macos.openfolder") { NSWorkspace.shared.selectFile(selected.command, inFileViewerRootedAtPath: "") }
                                }
                            }
                        }
                    }
                    }
                    .id(SettingsSearchTarget.codexInstallation.anchorID)

                    if runtime.isInstalling {
                        Section {
                        ProgressView(operationName(runtime.operation?.phase))
                        if let bytes = runtime.operation?.downloadedBytes,
                           let total = runtime.operation?.totalBytes, total > 0 {
                            ProgressView(value: Double(bytes), total: Double(total))
                        }
                        }
                    }
                    if runtime.environmentPending == true || (runtime.configuredCommand == nil && (runtime.operation?.phase == "pending" || runtime.pendingSelection != nil)) {
                        Section("macos.waitingtoapply") {
                        Text("macos.thecurrentenvironmentstaysinuserestartthe")
                            .font(.caption)
                        Button("macos.applyafterworkfinishes") {
                            Task { _ = await model.restartRuntime(force: false) }
                        }
                        .disabled(model.isBusy)
                        }
                    }

                    if runtime.selection?.source == "bridge" && runtime.configuredCommand == nil {
                        Section("macos.versionmanagement") {
                        CodexRuntimeUpdateControls(runtime: runtime, kind: "cli")
                        FullRowDisclosure("macos.installationandrecovery", isExpanded: $showVersions) {
                            ForEach(Array((runtime.managedVersions ?? []).enumerated()), id: \.offset) { _, version in
                                HStack {
                                    Text(verbatim: version.version)
                                    Spacer()
                                    Text(ByteCountFormatter.string(fromByteCount: Int64(version.bytes), countStyle: .file))
                                }
                            }
                            if !runtime.runningVersions.isEmpty {
                                LabeledContent("macos.runningversion", value: runtime.runningVersions.joined(separator: ", "))
                            }
                            if runtime.actions.rollback, let version = runtime.recoveryVersion {
                                HStack {
                                    Button("macos.restorepreviousversion") { action("rollback") }
                                    Text(verbatim: version).foregroundStyle(.secondary)
                                }
                            }
                            if runtime.actions.cleanup {
                                HStack {
                                    Button("macos.cleanupunusedinstallations") { action("cleanup") }
                                    Text(ByteCountFormatter.string(fromByteCount: Int64(runtime.reclaimableBytes), countStyle: .file))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Button("macos.removebridgecli", role: .destructive) { showDeleteConfirmation = true }
                                .disabled(!runtime.actions.remove)
                            if !runtime.actions.remove {
                                Text("macos.safelystoptheserverbeforeremovingit")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        }
                    }
                    if runtime.actions.retry && runtime.operation?.action != "check-updates" {
                        Section {
                        Text("macos.installationfailedyourpreviousinstallationispreserved")
                            .foregroundStyle(.orange)
                        Button("macos.tryagain") { action("retry") }
                        if runtime.actions.install {
                            ForEach(runtime.knownVersions ?? [], id: \.self) { version in
                                HStack {
                                    Button("macos.installthisversion") { Task { await model.manageCodex(.init(action: "install", version: version)) } }
                                    Text(verbatim: version)
                                }
                            }
                        }
                        if runtime.actions.rollback { Button("macos.restorepreviousversion") { action("rollback") } }
                        }
                    }
                } else {
                    ProgressView()
                    Button("macos.common.refreshAction") { action("status") }
                }
                if let error = model.codexRuntimeError {
                    Section("macos.needsattention") { Text(error).font(.caption).foregroundStyle(.orange) }
                }
            }
            .formStyle(.grouped)
        }
        .onAppear { model.codexSettingsVisible = isSelected }
        .onChange(of: isSelected) { model.codexSettingsVisible = $0 }
        .onDisappear { model.codexSettingsVisible = false }
        .task(id: "\(isSelected):\(installing):\(model.helperChangesAvailable)") {
            while !Task.isCancelled, let interval = CodexSettingsRefreshPolicy.interval(isVisible: isSelected, installationInProgress: installing) {
                await model.manageCodex(.init(action: "status", includeAccount: !installing))
                guard !Task.isCancelled else { return }
                do { try await Task.sleep(for: .seconds(model.helperChangesAvailable ? 60 : interval)) } catch { return }
            }
        }
        .confirmationDialog("macos.removethecodexinstallationmanagedbythebridge", isPresented: $showDeleteConfirmation) {
            Button("settings.removeProject", role: .destructive) { action("remove") }
            Button("common.cancel", role: .cancel) {}
        } message: {
            Text("macos.logininformationconversationhistoryprojectsandbridgesettings")
        }
    }

    private var installing: Bool { model.codexRuntime?.isInstalling == true }

    @ViewBuilder private var accountSection: some View {
        Section("macos.accountusage") {
            if let account = model.selectedCodexAccount {
                CodexAccountUsageView(account: account, runtimeKind: "cli")
            } else {
                Text("macos.accountinformationisunavailable").font(.caption).foregroundStyle(.secondary)
            }

        }
        .id(SettingsSearchTarget.codexAccount.anchorID)
        if let billing = model.codexRuntime?.billing, billing.configured,
           model.selectedCodexAccount?.authMode != "api-key" {
            Section("macos.apicostconnection") {
                if let organization = billing.organizationId { Text(verbatim: organization) }
                if let project = billing.projectId { Text(verbatim: project) }
                Button("macos.disconnectcostreporting") { action("remove-billing") }
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
                    Button("problem.selectShort") { Task { await model.manageCodex(.init(action: "select", selectionId: candidate.id)) } }
                        .disabled(candidate.available == false || runtime.isInstalling)
                }
            }
            .help(candidate.command)
        }
        if runtime.actions.install {
            HStack {
                Text("macos.bridgecli")
                Spacer()
                Button("macos.install") { action("install") }
            }
        }
        Text("macos.adedicatedcodexinstallationthatthebridgeinstalls")
            .font(.caption).foregroundStyle(.secondary)
        if runtime.selection?.source != "bridge", runtime.candidates.contains(where: { $0.source == "bridge" }) {
            FullRowDisclosure("macos.managebridgecli", isExpanded: $showVersions) {
                VStack(alignment: .leading, spacing: 6) {
                    if runtime.actions.cleanup {
                        Button("macos.cleanupunusedinstallations") { action("cleanup") }
                        Text(ByteCountFormatter.string(fromByteCount: Int64(runtime.reclaimableBytes), countStyle: .file))
                    }
                    Button("macos.removebridgecli", role: .destructive) { showDeleteConfirmation = true }
                        .disabled(!runtime.actions.remove)
                }
            }
        }
    }

    private func action(_ action: String) {
        Task { await model.manageCodex(.init(action: action)) }
    }

    private func sourceName(_ source: String) -> String {
        let key = source == "app" ? "macos.codexapp" : source == "terminal" ? "macos.terminalcli" : "macos.bridgecli"
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    private func operationName(_ phase: String?) -> String {
        let key = phase == "downloading" ? "macos.downloading" : phase == "verifying" ? "macos.verifyinginstallation" : "macos.installing"
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }
}
