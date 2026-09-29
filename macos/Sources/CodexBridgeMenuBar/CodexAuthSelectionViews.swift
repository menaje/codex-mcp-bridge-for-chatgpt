import CodexBridgeKit
import SwiftUI

/// Shared by first setup and later settings; authentication changes require
/// explicit actions and never ride on the general-settings autosave path.
struct CodexAuthSelectionControls: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedKind = "shared"
    @State private var apiKey = ""
    @State private var billingConfirmed = false

    var body: some View {
        authSelectionContent
            .task {
                if !model.isRemoteClient { await model.manageCodex(.init(action: "status")) }
            }
    }

    @ViewBuilder private var authSelectionContent: some View {
        if model.isRemoteClient {
            VStack(alignment: .leading, spacing: 6) {
                if let connection = model.remoteAuthConnection {
                    LabeledContent("macos.auth.current", value: label(connection.source))
                    LabeledContent("macos.authenticationmethod", value: connection.mode == "api-key"
                                   ? localized("macos.openaiapikey") : connection.mode == "chatgpt" ? "ChatGPT" : "—")
                }
                Text("macos.auth.remoteManaged")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } else if let auth = model.codexRuntime?.authSelection {
            VStack(alignment: .leading, spacing: 12) {
                LabeledContent("macos.auth.current", value: label(auth.applied.kind))
                if auth.overrideActive {
                    Text("macos.auth.override")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    if let pending = auth.pending {
                        LabeledContent("macos.auth.pending", value: label(pending.kind))
                        Text("macos.auth.waiting")
                            .font(.caption).foregroundStyle(.orange)
                        Button("macos.auth.applyWhenSafe") {
                            Task { _ = await model.restartRuntime(force: false) }
                        }
                        .disabled(model.isBusy)
                        Button("common.cancel") {
                            Task { await model.manageCodex(.init(action: "auth-cancel-pending", authRevision: auth.revision)) }
                        }
                        .disabled(model.isBusy)
                    }
                    Picker("macos.auth.choice", selection: $selectedKind) {
                        Text("macos.auth.shared").tag("shared")
                        Text("macos.auth.bridgeChatgpt").tag("bridge-chatgpt")
                        Text("macos.auth.bridgeApi").tag("bridge-api")
                        Text("macos.auth.disconnect").tag("disconnected")
                    }
                    .pickerStyle(.menu)
                    .onChange(of: selectedKind) { _ in
                        billingConfirmed = false
                        apiKey = ""
                    }
                    Text(explanationKey(selectedKind))
                        .font(.caption).foregroundStyle(.secondary)
                    if selectedKind == "bridge-api" || selectedKind == "shared" {
                        Toggle("macos.auth.billingConsent", isOn: $billingConfirmed)
                    }
                    if selectedKind == "bridge-chatgpt" || selectedKind == "bridge-api" {
                        candidateControls(auth)
                    } else {
                        Button("macos.auth.requestChange") {
                            Task {
                                await model.manageCodex(.init(action: "auth-apply", authKind: selectedKind,
                                                              authRevision: auth.revision,
                                                              authBillingConfirmed: billingConfirmed))
                                await model.refreshAuthStatus()
                            }
                        }
                        .disabled(model.isBusy || auth.pending != nil)
                    }
                }
            }
            .onAppear { selectedKind = auth.pending?.kind ?? auth.applied.kind }
            .task(id: auth.candidate?.status) {
                guard auth.candidate?.status == "login-started" else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                    // The browser login exits asynchronously. Refresh its status
                    // while this view is visible without polling account auth.
                    await model.manageCodex(.init(action: "status", includeAccount: false))
                    if model.codexRuntime?.authSelection?.candidate?.status != "login-started" { return }
                }
            }
        } else {
            Text("macos.auth.unavailable").font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func candidateControls(_ auth: CodexAuthSelection) -> some View {
        if let candidate = auth.candidate, candidate.connection.kind == selectedKind {
            LabeledContent("macos.auth.candidate", value: candidateStatus(candidate.status))
            if selectedKind == "bridge-chatgpt" {
                Button("macos.auth.startLogin") {
                    Task { await model.manageCodex(.init(action: "auth-login", authCandidateId: candidate.id)) }
                }
                .disabled(model.isBusy || !["prepared", "login-failed"].contains(candidate.status))
            } else if candidate.status != "verified" {
                SecureField("macos.auth.apiKey", text: $apiKey)
                    .textContentType(.password)
                Button("macos.auth.saveCandidateKey") {
                    let submitted = apiKey
                    apiKey = ""
                    Task { await model.manageCodex(.init(action: "auth-api-key", authCandidateId: candidate.id,
                                                        authApiKey: submitted)) }
                }
                .disabled(model.isBusy || apiKey.isEmpty)
            }
            Button("macos.auth.verify") {
                Task { await model.manageCodex(.init(action: "auth-verify", authCandidateId: candidate.id)) }
            }
            .disabled(model.isBusy || candidate.status == "login-started")
            Button("macos.auth.requestChange") {
                Task {
                    await model.manageCodex(.init(action: "auth-apply", authKind: selectedKind,
                                                  authCandidateId: candidate.id, authRevision: auth.revision,
                                                  authBillingConfirmed: billingConfirmed))
                    await model.refreshAuthStatus()
                }
            }
            .disabled(model.isBusy || candidate.status != "verified" ||
                      (selectedKind == "bridge-api" && !billingConfirmed) || auth.pending != nil)
            Button("common.cancel") {
                Task { await model.manageCodex(.init(action: "auth-cancel", authCandidateId: candidate.id,
                                                     authRevision: auth.revision)) }
            }
            .disabled(model.isBusy)
        } else if let candidate = auth.candidate {
            Text("macos.auth.candidate")
                .font(.caption).foregroundStyle(.secondary)
            Button("common.cancel") {
                Task { await model.manageCodex(.init(action: "auth-cancel", authCandidateId: candidate.id,
                                                     authRevision: auth.revision)) }
            }
            .disabled(model.isBusy)
        } else {
            Button("macos.auth.prepare") {
                Task { await model.manageCodex(.init(action: "auth-prepare", authKind: selectedKind,
                                                     authRevision: auth.revision)) }
            }
            .disabled(model.isBusy || auth.pending != nil)
        }
    }

    private func label(_ kind: String) -> String {
        let key: String = switch kind {
        case "bridge-chatgpt": "macos.auth.bridgeChatgpt"
        case "bridge-api": "macos.auth.bridgeApi"
        case "disconnected": "macos.auth.disconnect"
        default: "macos.auth.shared"
        }
        return localized(key)
    }

    private func candidateStatus(_ status: String) -> String {
        let key: String = switch status {
        case "verified": "macos.auth.verified"
        case "login-started": "macos.auth.loginInProgress"
        case "login-failed": "macos.auth.loginFailed"
        case "login-unconfirmed": "macos.auth.loginUnconfirmed"
        default: "macos.auth.needsVerification"
        }
        return localized(key)
    }

    private func explanationKey(_ kind: String) -> LocalizedStringKey {
        switch kind {
        case "bridge-chatgpt": "macos.auth.bridgeChatgptHint"
        case "bridge-api": "macos.auth.bridgeApiHint"
        case "disconnected": "macos.auth.disconnectHint"
        default: "macos.auth.sharedHint"
        }
    }

    private func localized(_ key: String) -> String {
        BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }
}
