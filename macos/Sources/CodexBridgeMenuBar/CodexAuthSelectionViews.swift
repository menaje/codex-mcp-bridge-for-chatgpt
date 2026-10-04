import CodexBridgeKit
import SwiftUI

/// Shared by first setup and later settings; authentication changes require
/// explicit actions and never ride on the general-settings autosave path.
struct CodexAuthSelectionControls: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedKind = "shared"
    @State private var apiKey = ""
    @State private var billingConfirmed = false
    @State private var profileToRemove: CodexAuthSelection.OwnedProfile?
    @State private var reviewStoppedActivation = false

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
                    if let method = authenticationMethod(connection.mode) {
                        LabeledContent("macos.authenticationmethod", value: method)
                    }
                }
                Text("macos.auth.remoteManaged")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } else if let auth = model.codexRuntime?.authSelection {
            VStack(alignment: .leading, spacing: 12) {
                if let selected = model.codexRuntime?.selection {
                    LabeledContent("macos.selectedcodex", value: selectedCliLabel(selected))
                }
                LabeledContent("macos.auth.current", value: label(auth.applied.kind))
                if auth.applied.kind == "external",
                   let home = auth.knownHomes?.first(where: { $0.id == auth.applied.homeId }) {
                    LabeledContent("macos.auth.shared", value: home.home)
                }
                if let email = auth.appliedAccountEmail {
                    LabeledContent("macos.auth.emailAtSelection", value: email)
                }
                if let account = model.codexRuntime?.account, account.authenticated {
                    if let method = authenticationMethod(account.authMode) {
                        LabeledContent("macos.authenticationmethod", value: method)
                    }
                    if let billing = billingTarget(account.billing?.kind ?? account.authMode) {
                        LabeledContent("macos.auth.billingTarget", value: billing)
                    }
                    if let plan = account.planType, !plan.isEmpty, plan != "unknown", account.authMode == "chatgpt" {
                        LabeledContent("macos.auth.plan", value: plan)
                    }
                }
                if auth.overrideActive {
                    Text("macos.auth.override")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    if let activation = auth.activation {
                        Text(activation.status == "uncertain" ? "macos.auth.activationUncertain" : "macos.auth.activationStarting")
                            .font(.caption).foregroundStyle(.orange)
                        Button("macos.auth.reviewStopped") {
                            reviewStoppedActivation = true
                        }
                        .disabled(model.isBusy)
                    }
                    if let pending = auth.pending {
                        LabeledContent("macos.auth.pending", value: label(pending.kind))
                        if pending.kind == "external",
                           let home = auth.knownHomes?.first(where: { $0.id == pending.homeId }) {
                            LabeledContent("macos.auth.shared", value: home.home)
                        }
                        if let email = auth.pendingAccountEmail {
                            LabeledContent("macos.auth.accountEmail", value: email)
                        }
                        if pending.kind != "disconnected", let billing = billingTarget(auth.pendingBillingTarget) {
                            LabeledContent("macos.auth.billingTarget", value: billing)
                        }
                        Text("macos.auth.waiting")
                            .font(.caption).foregroundStyle(.orange)
                        Button("macos.auth.applyWhenSafe") {
                            Task { _ = await model.restartRuntime(force: false) }
                        }
                        .disabled(model.isBusy || auth.activation != nil)
                        Button("common.cancel") {
                            Task { await model.manageCodex(.init(action: "auth-cancel-pending", authRevision: auth.revision)) }
                        }
                        .disabled(model.isBusy || auth.activation != nil)
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
                        .disabled(model.isBusy || auth.pending != nil || auth.activation != nil)
                    }
                    if selectedKind == "shared", let homes = auth.knownHomes {
                        if homes.contains(where: { $0.id != auth.applied.homeId && $0.id != auth.pending?.homeId }) {
                            Text("macos.auth.externalHomeImpact")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(homes.filter { $0.id != auth.applied.homeId && $0.id != auth.pending?.homeId }) { home in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text("macos.auth.shared")
                                    Text(home.home).font(.caption).foregroundStyle(.secondary)
                                        .lineLimit(1).help(home.home)
                                }
                                Spacer()
                                Button("macos.auth.requestChange") {
                                    Task {
                                        await model.manageCodex(.init(action: "auth-apply", authKind: "external",
                                                                      authHomeId: home.id, authRevision: auth.revision,
                                                                      authBillingConfirmed: billingConfirmed))
                                        await model.refreshAuthStatus()
                                    }
                                }
                                .disabled(model.isBusy || auth.pending != nil || auth.activation != nil)
                            }
                        }
                    }
                    if let profiles = auth.profiles {
                        ForEach(profiles.filter { $0.status != "removed" && $0.id != auth.applied.profileId &&
                            $0.id != auth.pending?.profileId && $0.id != auth.candidate?.id }) { profile in
                            HStack {
                                Text(label(profile.kind))
                                Text(String(profile.id.prefix(8))).foregroundStyle(.secondary)
                                Spacer()
                                if profile.status == "logout-unconfirmed" || profile.status == "login-unconfirmed" {
                                    Text(profile.status == "login-unconfirmed"
                                         ? "macos.auth.profileLoginUnconfirmed" : "macos.auth.logoutUnconfirmed")
                                        .font(.caption).foregroundStyle(.orange)
                                } else {
                                    Button("macos.auth.useSavedProfile") {
                                        selectedKind = profile.kind
                                        Task { await model.manageCodex(.init(action: "auth-select-profile",
                                                                            authProfileId: profile.id,
                                                                            authRevision: auth.revision)) }
                                    }
                                    .disabled(model.isBusy || auth.pending != nil || auth.candidate != nil || auth.activation != nil)
                                    Button(profile.kind == "bridge-api" ? "macos.auth.removeOwnedKey" : "macos.auth.logoutOwned") {
                                        profileToRemove = profile
                                    }
                                    .disabled(model.isBusy || auth.activation != nil)
                                }
                            }
                        }
                    }
                }
            }
            .onAppear {
                let kind = auth.pending?.kind ?? auth.applied.kind
                selectedKind = kind == "external" ? "shared" : kind
            }
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
            .confirmationDialog(profileToRemove?.kind == "bridge-api" ? "macos.auth.removeKeyWarning" : "macos.auth.removalWarning", isPresented: Binding(
                get: { profileToRemove != nil }, set: { if !$0 { profileToRemove = nil } }),
                titleVisibility: .visible) {
                if let profile = profileToRemove {
                    Button(profile.kind == "bridge-api" ? "macos.auth.removeOwnedKey" : "macos.auth.logoutOwned",
                           role: .destructive) {
                        profileToRemove = nil
                        Task { await model.manageCodex(.init(action: profile.kind == "bridge-api"
                                                              ? "auth-remove-api-key" : "auth-logout-profile",
                                                              authProfileId: profile.id, authRevision: auth.revision,
                                                              authRemovalConfirmed: true)) }
                    }
                }
                Button("common.cancel", role: .cancel) { profileToRemove = nil }
            }
            .confirmationDialog("macos.auth.reviewStoppedWarning", isPresented: $reviewStoppedActivation,
                                titleVisibility: .visible) {
                if let activation = auth.activation {
                    Button("macos.auth.reviewStopped") {
                        Task {
                            await model.manageCodex(.init(action: "auth-reconcile-stopped",
                                                          authActivationId: activation.id,
                                                          authRevision: auth.revision,
                                                          authResolutionConfirmed: true))
                        }
                    }
                }
                Button("common.cancel", role: .cancel) { reviewStoppedActivation = false }
            }
        } else {
            Text("macos.auth.unavailable").font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func candidateControls(_ auth: CodexAuthSelection) -> some View {
        if let candidate = auth.candidate, candidate.connection.kind == selectedKind {
            LabeledContent("macos.auth.candidate", value: candidateStatus(candidate.status))
            if let email = candidate.accountEmail {
                LabeledContent("macos.auth.accountEmail", value: email)
            }
            if candidate.status == "verified", let billing = billingTarget(candidate.billingTarget) {
                LabeledContent("macos.auth.billingTarget", value: billing)
            }
            if selectedKind == "bridge-chatgpt" {
                if candidate.reused != true {
                    Button("macos.auth.startLogin") {
                        Task { await model.manageCodex(.init(action: "auth-login", authCandidateId: candidate.id)) }
                    }
                    .disabled(model.isBusy || auth.pending != nil || auth.activation != nil || !["prepared", "login-failed"].contains(candidate.status))
                }
            } else if candidate.status != "verified" && candidate.reused != true {
                SecureField("macos.auth.apiKey", text: $apiKey)
                    .textContentType(.password)
                Button("macos.auth.saveCandidateKey") {
                    BridgeTextInput.commitPendingComposition()
                    let submitted = apiKey
                    apiKey = ""
                    Task { await model.manageCodex(.init(action: "auth-api-key", authCandidateId: candidate.id,
                                                        authApiKey: submitted)) }
                }
                .disabled(model.isBusy || auth.pending != nil || auth.activation != nil || apiKey.isEmpty ||
                          !["prepared", "login-failed"].contains(candidate.status))
            }
            Button("macos.auth.verify") {
                Task { await model.manageCodex(.init(action: "auth-verify", authCandidateId: candidate.id)) }
            }
            .disabled(model.isBusy || auth.pending != nil || auth.activation != nil ||
                      ["login-started", "login-unconfirmed"].contains(candidate.status))
            Button("macos.auth.requestChange") {
                Task {
                    await model.manageCodex(.init(action: "auth-apply", authKind: selectedKind,
                                                  authCandidateId: candidate.id, authRevision: auth.revision,
                                                  authBillingConfirmed: billingConfirmed))
                    await model.refreshAuthStatus()
                }
            }
            .disabled(model.isBusy || candidate.status != "verified" ||
                      (selectedKind == "bridge-api" && !billingConfirmed) || auth.pending != nil || auth.activation != nil)
            Button("common.cancel") {
                Task { await model.manageCodex(.init(action: "auth-cancel", authCandidateId: candidate.id,
                                                     authRevision: auth.revision)) }
            }
            .disabled(model.isBusy || auth.pending != nil || auth.activation != nil)
        } else if let candidate = auth.candidate {
            Text("macos.auth.candidate")
                .font(.caption).foregroundStyle(.secondary)
            Button("common.cancel") {
                Task { await model.manageCodex(.init(action: "auth-cancel", authCandidateId: candidate.id,
                                                     authRevision: auth.revision)) }
            }
            .disabled(model.isBusy || auth.pending != nil || auth.activation != nil)
        } else {
            Button("macos.auth.prepare") {
                Task { await model.manageCodex(.init(action: "auth-prepare", authKind: selectedKind,
                                                     authRevision: auth.revision)) }
            }
            .disabled(model.isBusy || auth.pending != nil || auth.activation != nil)
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

    private func selectedCliLabel(_ installation: CodexInstallation) -> String {
        let sourceKey = switch installation.source {
        case "app": "macos.codexapp"
        case "terminal": "macos.terminalcli"
        default: "macos.bridgecli"
        }
        return [localized(sourceKey), installation.version].compactMap { $0 }.joined(separator: " · ")
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

    private func authenticationMethod(_ mode: String?) -> String? {
        switch mode {
        case "api-key": localized("macos.openaiapikey")
        case "chatgpt": "ChatGPT"
        default: nil
        }
    }

    private func billingTarget(_ mode: String?) -> String? {
        return switch mode {
        case "api", "api-key", "bridge-api": localized("macos.auth.apiBilling")
        case "chatgpt-plan", "chatgpt", "bridge-chatgpt": localized("macos.auth.chatgptBilling")
        default: nil
        }
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
