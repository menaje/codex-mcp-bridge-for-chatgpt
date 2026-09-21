import AppKit
import CodexBridgeKit
import SwiftUI

enum ConnectionAssistantPresentation: Equatable {
    case setup
    case recovery
}

@MainActor
final class ConnectionAssistantWindowState: ObservableObject {
    @Published private(set) var presentation: ConnectionAssistantPresentation = .recovery
    @Published private(set) var sessionID = UUID()

    func begin(_ presentation: ConnectionAssistantPresentation) {
        self.presentation = presentation
        sessionID = UUID()
    }
}

enum ConnectionSetupRole: String, CaseIterable, Identifiable {
    case localHost
    case remoteClient

    var id: String { rawValue }
}

enum ConnectionSetupStep: String, Equatable {
    case role
    case discovery
    case credentials
    case remoteConnection
    case codexLogin
    case complete
}

enum ConnectionSetupJourney {
    enum DiscoveryAction: Equatable {
        case enterCredentials(prefilledTunnelID: String?)
        case importCandidate(id: String)
    }

    enum CodexAction: Equatable {
        case waitForStatus
        case finish
        case openInstallationSettings
        case startBrowserLogin
    }

    static func steps(for role: ConnectionSetupRole) -> [ConnectionSetupStep] {
        switch role {
        case .localHost:
            return [.role, .discovery, .credentials, .codexLogin, .complete]
        case .remoteClient:
            return [.role, .remoteConnection, .complete]
        }
    }

    static func previous(
        from step: ConnectionSetupStep,
        role: ConnectionSetupRole
    ) -> ConnectionSetupStep? {
        let route = steps(for: role)
        guard let index = route.firstIndex(of: step), index > 0 else { return nil }
        return route[index - 1]
    }

    static func discoveryAction(
        candidateID: String?,
        candidateTunnelID: String?,
        candidateHasAPIKey: Bool,
        savedAPIKeyAvailable: Bool
    ) -> DiscoveryAction {
        guard let candidateID else {
            return .enterCredentials(prefilledTunnelID: nil)
        }
        if candidateHasAPIKey || savedAPIKeyAvailable {
            return .importCandidate(id: candidateID)
        }
        return .enterCredentials(prefilledTunnelID: candidateTunnelID)
    }

    static func codexAction(
        installed: Bool?,
        authenticated: Bool?,
        loginInProgress: Bool,
        statusCheckFailed: Bool
    ) -> CodexAction {
        if loginInProgress { return .waitForStatus }
        if authenticated == true { return .finish }
        if installed == false { return .openInstallationSettings }
        if installed == true || statusCheckFailed { return .startBrowserLogin }
        return .waitForStatus
    }
}

enum ConnectionRecoveryComponent: String, Hashable {
    case configuration
    case bridge
    case tunnel
    case codex
}

enum ConnectionRecoveryRecommendedAction: Hashable {
    case configureConnection
    case repairPermissions
    case startRuntime
    case restartRuntime
    case startCodexLogin
    case openCodexSettings
}

enum ConnectionRecoveryPlan {
    static func recommendedActions(
        for component: ConnectionRecoveryComponent,
        isRemoteClient: Bool,
        configurationValid: Bool,
        bridgeConnected: Bool,
        helperPhase: String?,
        codexInstalled: Bool?,
        permissionsRepairAvailable: Bool,
        bridgeObservation: String? = nil
    ) -> [ConnectionRecoveryRecommendedAction] {
        switch component {
        case .configuration:
            return permissionsRepairAvailable
                ? [.configureConnection, .repairPermissions]
                : [.configureConnection]
        case .bridge:
            guard !isRemoteClient, configurationValid else { return [] }
            if bridgeObservation == "timed-out" { return [] }
            return helperPhase == "stopped" ? [.startRuntime] : [.restartRuntime]
        case .tunnel:
            guard !isRemoteClient, configurationValid, bridgeConnected else { return [] }
            return [.restartRuntime]
        case .codex:
            guard !isRemoteClient else { return [] }
            switch codexInstalled {
            case true: return [.startCodexLogin]
            case false: return [.openCodexSettings]
            case nil: return []
            }
        }
    }
}

struct ConnectionAssistantRootView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var windowState: ConnectionAssistantWindowState
    let onClose: () -> Void
    let onTitleChange: (String) -> Void

    var body: some View {
        Group {
            switch windowState.presentation {
            case .setup:
                ConnectionSetupFlowView(onClose: onClose)
            case .recovery:
                ConnectionRecoveryView(
                    onConfigure: { windowState.begin(.setup) },
                    onClose: onClose
                )
            }
        }
        .id(windowState.sessionID)
        .environment(\.locale, model.interfaceLocale)
        .onAppear(perform: reportTitle)
        .onChange(of: windowState.presentation) { _ in reportTitle() }
        .onChange(of: model.interfaceLocalePreference) { _ in reportTitle() }
    }

    private func reportTitle() {
        let key = windowState.presentation == .setup
            ? "macos.connectionAssistant.setupWindowTitle"
            : "macos.connectionAssistant.recoveryWindowTitle"
        onTitleChange(BridgeAppLocalization.string(key, locale: model.interfaceLocale))
    }
}

struct ConnectionSetupRequiredPopoverView: View {
    @EnvironmentObject private var model: AppModel
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                Text("macos.connectionAssistant.setupRequiredTitle")
                    .font(.headline)
            } icon: {
                Image(systemName: "link.badge.plus")
                    .font(.title2)
                    .foregroundStyle(Color.accentColor)
            }
            Text("macos.connectionAssistant.setupRequiredDescription")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let issue = model.runtimeConfigurationIssueMessage {
                Label(issue, systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .lineLimit(3)
            }

            Button("macos.connectionAssistant.openSetup", action: onOpen)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .accessibilityElement(children: .contain)
    }
}

struct ConnectionSetupSettingsPane: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "link.badge.plus")
                .font(.system(size: 40, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            Text("macos.connectionAssistant.setupRequiredTitle")
                .font(.title3.bold())
            Text("macos.connectionAssistant.setupRequiredSettingsDescription")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 440)
            Button("macos.connectionAssistant.openSetup") {
                ConnectionAssistantWindowController.shared.show(
                    model: model,
                    presentation: .setup
                )
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}

struct ConnectionSetupFlowView: View {
    private enum RemoteMethod: String, CaseIterable, Identifiable {
        case saved
        case invitation

        var id: String { rawValue }
    }

    @EnvironmentObject private var model: AppModel
    let onClose: () -> Void
    private let automaticRefresh: Bool

    @State private var role: ConnectionSetupRole = .localHost
    @State private var step: ConnectionSetupStep = .role
    @State private var didInitialize = false
    @State private var selectedCandidateID: String?
    @State private var apiKey = ""
    @State private var tunnelID = ""
    @State private var pasteMessage: String?
    @State private var attemptedConnection = false
    @State private var attemptedCodexAction = false
    @State private var remoteMethod: RemoteMethod = .invitation
    @State private var selectedServerID = ""
    @State private var invitation = ""
    @State private var profileName = ""
    @State private var deviceName = Host.current().localizedName ?? "Mac"

    init(
        onClose: @escaping () -> Void,
        initialRole: ConnectionSetupRole? = nil,
        initialStep: ConnectionSetupStep = .role,
        automaticRefresh: Bool = true
    ) {
        self.onClose = onClose
        self.automaticRefresh = automaticRefresh
        _role = State(initialValue: initialRole ?? .localHost)
        _step = State(initialValue: initialStep)
        _didInitialize = State(initialValue: initialRole != nil || initialStep != .role)
    }

    var body: some View {
        VStack(spacing: 0) {
            setupHeader
            Divider()
            ScrollView {
                stepContent
                    .padding(.horizontal, 34)
                    .padding(.vertical, 26)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            setupFooter
        }
        .frame(minWidth: 620, minHeight: 520)
        .onAppear(perform: initialize)
        .task(id: step) {
            guard automaticRefresh else { return }
            switch step {
            case .discovery:
                await model.refreshSetupDiscovery()
            case .codexLogin:
                await model.refreshAuthStatus()
            default:
                break
            }
        }
    }

    private var route: [ConnectionSetupStep] {
        ConnectionSetupJourney.steps(for: role)
    }

    private var stepPosition: Int {
        (route.firstIndex(of: step) ?? 0) + 1
    }

    private var setupHeader: some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: stepSymbol)
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text(stepTitle)
                    .font(.title2.bold())
                Text(BridgeAppLocalization.format(
                    "macos.connectionAssistant.stepProgress",
                    locale: model.interfaceLocale,
                    stepPosition,
                    route.count
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 5) {
                ForEach(Array(route.enumerated()), id: \.offset) { index, _ in
                    Capsule()
                        .fill(index < stepPosition ? Color.accentColor : Color.secondary.opacity(0.22))
                        .frame(width: index + 1 == stepPosition ? 22 : 8, height: 6)
                }
            }
            .accessibilityHidden(true)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
    }

    @ViewBuilder
    private var stepContent: some View {
        switch step {
        case .role:
            roleStep
        case .discovery:
            discoveryStep
        case .credentials:
            credentialsStep
        case .remoteConnection:
            remoteConnectionStep
        case .codexLogin:
            codexLoginStep
        case .complete:
            completionStep
        }
    }

    private var roleStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("macos.connectionAssistant.chooseRoleDescription")
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 14) {
                roleCard(
                    role: .localHost,
                    symbol: "desktopcomputer",
                    titleKey: "macos.runserveronthismac",
                    descriptionKey: "macos.thismacownsandrunsthehelperbridge"
                )
                roleCard(
                    role: .remoteClient,
                    symbol: "network",
                    titleKey: "macos.connecttoexistingserver",
                    descriptionKey: "macos.thisappusesonlytheselectedservers"
                )
            }
        }
    }

    private func roleCard(
        role candidate: ConnectionSetupRole,
        symbol: String,
        titleKey: String,
        descriptionKey: String
    ) -> some View {
        Button {
            role = candidate
            if candidate == .remoteClient {
                remoteMethod = model.connectionPreferences.profiles.isEmpty ? .invitation : .saved
            }
        } label: {
            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Image(systemName: symbol)
                        .font(.title2)
                        .foregroundStyle(role == candidate ? Color.accentColor : Color.secondary)
                    Spacer()
                    Image(systemName: role == candidate ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(role == candidate ? Color.accentColor : Color.secondary)
                }
                Text(BridgeAppLocalization.string(titleKey, locale: model.interfaceLocale))
                    .font(.headline)
                Text(BridgeAppLocalization.string(descriptionKey, locale: model.interfaceLocale))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
            .background(
                role == candidate ? Color.accentColor.opacity(0.10) : Color(nsColor: .controlBackgroundColor),
                in: RoundedRectangle(cornerRadius: 12)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(
                        role == candidate ? Color.accentColor : Color.secondary.opacity(0.22),
                        lineWidth: role == candidate ? 2 : 1
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(role == candidate ? [.isSelected] : [])
    }

    private var discoveryStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("macos.connectionAssistant.findExistingDescription")
                .font(.callout)
                .foregroundStyle(.secondary)

            if let candidates = model.setupDiscovery?.candidates, !candidates.isEmpty {
                VStack(spacing: 10) {
                    ForEach(candidates) { candidate in
                        Button {
                            selectedCandidateID = candidate.id
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: selectedCandidateID == candidate.id
                                      ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selectedCandidateID == candidate.id
                                                     ? Color.accentColor : Color.secondary)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(candidateSourceLabel(candidate))
                                        .font(.headline)
                                    Text(candidate.tunnelId)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                    Text(candidate.hasApiKey
                                         ? "macos.runtimeapikeyavailable"
                                         : "macos.onlytunnelidfound")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                selectedCandidateID == candidate.id
                                    ? Color.accentColor.opacity(0.10)
                                    : Color(nsColor: .controlBackgroundColor),
                                in: RoundedRectangle(cornerRadius: 10)
                            )
                            .overlay {
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(
                                        selectedCandidateID == candidate.id
                                            ? Color.accentColor
                                            : Color.secondary.opacity(0.18)
                                    )
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(
                            selectedCandidateID == candidate.id ? [.isSelected] : []
                        )
                    }
                }
            } else if model.setupDiscovery == nil, model.setupDiscoveryErrorMessage == nil {
                HStack(spacing: 9) {
                    ProgressView().controlSize(.small)
                    Text("macos.connectionAssistant.searchingExistingSettings")
                        .foregroundStyle(.secondary)
                }
            } else {
                Label(
                    "macos.connectionAssistant.noExistingSettings",
                    systemImage: "magnifyingglass"
                )
                .foregroundStyle(.secondary)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
            }

            if let error = model.setupDiscoveryErrorMessage {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
            }

            Button("macos.findexistingsettingsagain") {
                Task { await model.refreshSetupDiscovery() }
            }
            .disabled(model.isBusy)
        }
    }

    private var credentialsStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("macos.connectionAssistant.connectionDetailsDescription")
                .font(.callout)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 12) {
                SecureField(
                    BridgeAppLocalization.string(
                        model.helperStatus?.configuration.hasApiKey == true
                            ? "macos.replaceonlywhenenteringanewkey"
                            : "macos.runtimeapikey",
                        locale: model.interfaceLocale
                    ),
                    text: $apiKey
                )
                TextField("macos.tunnel", text: $tunnelID)
                HStack(spacing: 12) {
                    Button("macos.importbothvaluesfromclipboard") {
                        importSetupFromPasteboard()
                    }
                    Link(
                        "macos.createruntimeapikey",
                        destination: URL(
                            string: "https://platform.openai.com/settings/organization/api-keys"
                        )!
                    )
                    Link(
                        "macos.createtunnel",
                        destination: URL(
                            string: "https://platform.openai.com/settings/organization/tunnels"
                        )!
                    )
                }
                if let pasteMessage {
                    Text(pasteMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text("macos.entertunnelfollowedby32lowercaselettersor")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(16)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))

            Label(
                "macos.connectionAssistant.credentialsStayOnThisMac",
                systemImage: "lock.shield"
            )
            .font(.caption)
            .foregroundStyle(.secondary)

            if let issue = model.runtimeConfigurationIssueMessage {
                Label(issue, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(attemptedConnection ? Color.red : Color.orange)
                    .textSelection(.enabled)
                if model.helperStatus?.configuration.issueProblem?.code ==
                    "runtime-env-permissions-too-broad" ||
                    model.helperStatus?.configuration.issue?.contains(
                        "permissions are too broad"
                    ) == true {
                    Button("macos.repairwithapponlypermissions") {
                        Task { _ = await model.repairConfigurationPermissions() }
                    }
                    .disabled(model.isBusy)
                }
            }

            if let error = model.runtimeErrorMessage ?? model.startupErrorMessage ?? model.statusErrorMessage,
               attemptedConnection {
                Label(error, systemImage: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
    }

    private var remoteConnectionStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("macos.connectionAssistant.remoteConnectionDescription")
                .font(.callout)
                .foregroundStyle(.secondary)

            if !model.connectionPreferences.profiles.isEmpty {
                Picker("", selection: $remoteMethod) {
                    Text("macos.connectionAssistant.savedServer").tag(RemoteMethod.saved)
                    Text("macos.pairnewserver").tag(RemoteMethod.invitation)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

            if remoteMethod == .saved, !model.connectionPreferences.profiles.isEmpty {
                Picker("macos.server", selection: $selectedServerID) {
                    ForEach(model.connectionPreferences.profiles) { profile in
                        Text(profile.name).tag(profile.serverId)
                    }
                }
                if let profile = model.connectionPreferences.profiles.first(where: {
                    $0.serverId == selectedServerID
                }) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(profile.endpoint)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                        Text(BridgeAppLocalization.format(
                            "macos.serverid",
                            locale: model.interfaceLocale,
                            profile.serverId
                        ))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                }
            } else {
                Text("macos.ontheservermacclickcreateandcopy")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextEditor(text: $invitation)
                    .font(.caption.monospaced())
                    .frame(minHeight: 86)
                    .padding(5)
                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(.quaternary))
                    .accessibilityLabel("macos.thepairinginvitationcopiedfromtheserververifies")
                Button("macos.pastefromclipboard") {
                    if let copied = NSPasteboard.general.string(forType: .string) {
                        invitation = copied.trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
                TextField("macos.nameofthisdeviceshownontheserver", text: $deviceName)
                TextField("macos.servernametosaveoptional", text: $profileName)
                Text("macos.devicecredentialsarestoredonlyinthemacos")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if let error = model.connectionErrorMessage {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(attemptedConnection ? Color.red : Color.orange)
                    .textSelection(.enabled)
            }
        }
    }

    private var codexLoginStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("macos.connectionAssistant.codexSignInDescription")
                .font(.callout)
                .foregroundStyle(.secondary)

            HStack(alignment: .top, spacing: 14) {
                Image(systemName: codexStatusSymbol)
                    .font(.title2)
                    .foregroundStyle(codexStatusColor)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 5) {
                    Text(codexLoginStatusText)
                        .font(.headline)
                    if model.loginInProgress {
                        ProgressView()
                            .controlSize(.small)
                    }
                    if let error = model.authErrorMessage {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(attemptedCodexAction ? Color.red : Color.orange)
                            .textSelection(.enabled)
                    }
                }
                Spacer()
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))

            HStack(spacing: 12) {
                Button("macos.refreshstatus") {
                    Task { await model.refreshAuthStatus() }
                }
                .disabled(model.isBusy)
                if model.authStatus?.installed == false {
                    Button("macos.connectionAssistant.openCodexSettings") {
                        openSettings(.codex)
                    }
                }
            }
        }
    }

    private var completionStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 38))
                    .foregroundStyle(.green)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text("macos.connectionAssistant.completeTitle")
                        .font(.title3.bold())
                    Text(role == .localHost
                         ? "macos.connectionAssistant.completeLocalDescription"
                         : "macos.connectionAssistant.completeRemoteDescription")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if role == .localHost {
                VStack(alignment: .leading, spacing: 9) {
                    Label("macos.connectthistunnelwithnoauthinchatgpt", systemImage: "1.circle")
                    Label("macos.registerthefirstworkfolderintheprojects", systemImage: "2.circle")
                }
                .font(.callout)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))

                Button("macos.connectionAssistant.openProjectSettings") {
                    openSettings(.projects)
                }
            } else if model.remoteHello == nil {
                Label(
                    model.connectionErrorMessage ??
                        BridgeAppLocalization.string(
                            "macos.notconnectedtotheselectedserver",
                            locale: model.interfaceLocale
                        ),
                    systemImage: "network.slash"
                )
                .font(.caption)
                .foregroundStyle(.orange)
                Button("macos.tryagain") {
                    Task { await model.refreshAll() }
                }
            }
        }
    }

    private var setupFooter: some View {
        HStack(spacing: 10) {
            Button("common.cancel", action: onClose)
                .keyboardShortcut(.cancelAction)
            if let previous = ConnectionSetupJourney.previous(from: step, role: role) {
                Button("problem.previous") {
                    withAnimation(.easeInOut(duration: 0.15)) { step = previous }
                }
                .disabled(model.isBusy)
            }
            Spacer()
            if model.isBusy { ProgressView().controlSize(.small) }
            Button {
                performPrimaryAction()
            } label: {
                Text(primaryActionTitle)
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
            .disabled(primaryActionDisabled)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var primaryActionTitle: String {
        let key: String
        switch step {
        case .role:
            key = "macos.connectionAssistant.continueAction"
        case .discovery:
            key = selectedCandidateID == nil
                ? "macos.connectionAssistant.enterManually"
                : "macos.connectionAssistant.useExistingSettings"
        case .credentials:
            key = "macos.saveandconnectsafely"
        case .remoteConnection:
            key = "macos.connectionAssistant.connectAction"
        case .codexLogin:
            switch codexAction {
            case .finish:
                key = "macos.connectionAssistant.continueAction"
            case .openInstallationSettings:
                key = "macos.connectionAssistant.openCodexSettings"
            case .startBrowserLogin:
                key = "macos.startcodexbrowserlogin"
            case .waitForStatus:
                key = "macos.checkingloginstatus"
            }
        case .complete:
            key = "macos.connectionAssistant.doneAction"
        }
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    private var primaryActionDisabled: Bool {
        if model.isBusy { return true }
        switch step {
        case .credentials:
            return !canSaveCredentials
        case .remoteConnection:
            if remoteMethod == .saved, !model.connectionPreferences.profiles.isEmpty {
                return selectedServerID.isEmpty
            }
            return invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .codexLogin:
            return codexAction == .waitForStatus
        default:
            return false
        }
    }

    private func performPrimaryAction() {
        switch step {
        case .role:
            Task { await continueFromRole() }
        case .discovery:
            Task { await continueFromDiscovery() }
        case .credentials:
            Task { await saveCredentials() }
        case .remoteConnection:
            Task { await connectRemoteServer() }
        case .codexLogin:
            Task { await continueFromCodexLogin() }
        case .complete:
            onClose()
        }
    }

    private func initialize() {
        guard !didInitialize else { return }
        didInitialize = true
        role = model.isRemoteClient ? .remoteClient : .localHost
        remoteMethod = model.connectionPreferences.profiles.isEmpty ? .invitation : .saved
        selectedServerID = model.connectionPreferences.activeServerId ??
            model.connectionPreferences.profiles.first?.serverId ?? ""
    }

    private func continueFromRole() async {
        if role == .localHost, model.isRemoteClient {
            guard await model.setConnectionMode(.localHost) else { return }
        }
        withAnimation(.easeInOut(duration: 0.15)) {
            step = role == .localHost ? .discovery : .remoteConnection
        }
    }

    private func continueFromDiscovery() async {
        let action = ConnectionSetupJourney.discoveryAction(
            candidateID: selectedCandidate?.id,
            candidateTunnelID: selectedCandidate?.tunnelId,
            candidateHasAPIKey: selectedCandidate?.hasApiKey ?? false,
            savedAPIKeyAvailable: model.helperStatus?.configuration.hasApiKey ?? false
        )
        switch action {
        case .enterCredentials(let prefilledTunnelID):
            if let prefilledTunnelID { tunnelID = prefilledTunnelID }
            withAnimation(.easeInOut(duration: 0.15)) { step = .credentials }
        case .importCandidate(let id):
            attemptedConnection = true
            if await model.importDiscoveredSetup(candidateId: id) {
                selectedCandidateID = nil
                await model.refreshAuthStatus()
                withAnimation(.easeInOut(duration: 0.15)) { step = .codexLogin }
            }
        }
    }

    private func saveCredentials() async {
        attemptedConnection = true
        if await model.saveSetup(apiKey: apiKey, tunnelId: tunnelID) {
            apiKey = ""
            tunnelID = ""
            pasteMessage = nil
            await model.refreshAuthStatus()
            withAnimation(.easeInOut(duration: 0.15)) { step = .codexLogin }
        }
    }

    private func connectRemoteServer() async {
        attemptedConnection = true
        let prepared: Bool
        if remoteMethod == .saved, !model.connectionPreferences.profiles.isEmpty {
            prepared = model.isRemoteClient
                ? await model.activateRemoteServer(selectedServerID)
                : model.prepareRemoteServerForModeSwitch(selectedServerID)
        } else {
            prepared = await model.pairRemoteServer(
                invitation: invitation,
                profileName: profileName,
                deviceName: deviceName
            )
        }
        guard prepared else { return }
        if !model.isRemoteClient {
            guard await model.setConnectionMode(.remoteClient) else { return }
        }
        invitation = ""
        withAnimation(.easeInOut(duration: 0.15)) { step = .complete }
    }

    private func continueFromCodexLogin() async {
        attemptedCodexAction = true
        switch codexAction {
        case .finish:
            withAnimation(.easeInOut(duration: 0.15)) { step = .complete }
        case .openInstallationSettings:
            openSettings(.codex)
        case .startBrowserLogin:
            _ = await model.launchCodexLogin()
        case .waitForStatus:
            break
        }
    }

    private var selectedCandidate: TunnelSetupCandidate? {
        guard let selectedCandidateID else { return nil }
        return model.setupDiscovery?.candidates.first { $0.id == selectedCandidateID }
    }

    private func candidateSourceLabel(_ candidate: TunnelSetupCandidate) -> String {
        switch candidate.source {
        case "runtime-config":
            return BridgeAppLocalization.string(
                "macos.existingbridgeconnectionfile",
                locale: model.interfaceLocale
            )
        case "environment":
            return BridgeAppLocalization.string(
                "macos.environmentvariables",
                locale: model.interfaceLocale
            )
        default:
            return BridgeAppLocalization.format(
                "macos.tunnelclientprofile",
                locale: model.interfaceLocale,
                candidate.profileName ?? "tunnel-client"
            )
        }
    }

    private func importSetupFromPasteboard() {
        guard let contents = NSPasteboard.general.string(forType: .string) else {
            pasteMessage = BridgeAppLocalization.string(
                "macos.noconnectioninformationwasfoundontheclipboard",
                locale: model.interfaceLocale
            )
            return
        }
        let parsed = TunnelSetupInputParser.parse(contents)
        if let discoveredAPIKey = parsed.apiKey { apiKey = discoveredAPIKey }
        if let discoveredTunnelID = parsed.tunnelId { tunnelID = discoveredTunnelID }
        pasteMessage = BridgeAppLocalization.string(
            parsed.isEmpty
                ? "macos.noconnectioninformationwasfoundontheclipboard"
                : "macos.thediscoveredconnectioninformationwasentered",
            locale: model.interfaceLocale
        )
    }

    private var canSaveCredentials: Bool {
        let hasAPIKey = model.helperStatus?.configuration.hasApiKey == true ||
            !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return hasAPIKey && tunnelIDInputIsValid
    }

    private var tunnelIDInputIsValid: Bool {
        let candidate = tunnelID.trimmingCharacters(in: .whitespacesAndNewlines)
        if candidate.isEmpty {
            return model.helperStatus?.configuration.hasTunnelId ?? false
        }
        return candidate.range(
            of: #"^tunnel_[a-z0-9]{32}$"#,
            options: .regularExpression
        ) != nil
    }

    private var stepTitle: String {
        let key: String
        switch step {
        case .role: key = "macos.connectionAssistant.chooseRoleTitle"
        case .discovery: key = "macos.connectionAssistant.findExistingTitle"
        case .credentials: key = "macos.connectionAssistant.connectionDetailsTitle"
        case .remoteConnection: key = "macos.connectionAssistant.remoteConnectionTitle"
        case .codexLogin: key = "macos.connectionAssistant.codexSignInTitle"
        case .complete: key = "macos.connectionAssistant.completeTitle"
        }
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    private var stepSymbol: String {
        switch step {
        case .role: return "person.crop.circle.badge.questionmark"
        case .discovery: return "magnifyingglass"
        case .credentials: return "key.horizontal"
        case .remoteConnection: return "network"
        case .codexLogin: return "person.crop.circle"
        case .complete: return "checkmark.circle"
        }
    }

    private var codexLoginStatusText: String {
        let key: String
        if model.loginInProgress {
            key = "macos.waitingforbrowserlogin"
        } else if model.authErrorMessage != nil {
            key = "macos.couldnotcheckthecodexloginstatuscheck"
        } else if let status = model.authStatus {
            if !status.installed {
                key = "macos.codexclicouldnotbefoundcheckthe"
            } else if status.authenticated {
                key = "macos.signedintocodex"
            } else {
                key = "macos.codexloginisrequiredsigninbeforethe"
            }
        } else {
            key = "macos.checkingloginstatus"
        }
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    private var codexAction: ConnectionSetupJourney.CodexAction {
        ConnectionSetupJourney.codexAction(
            installed: model.authStatus?.installed,
            authenticated: model.authStatus?.authenticated,
            loginInProgress: model.loginInProgress,
            statusCheckFailed: model.authErrorMessage != nil
        )
    }

    private var codexStatusSymbol: String {
        if model.authStatus?.authenticated == true { return "checkmark.circle.fill" }
        if model.loginInProgress { return "arrow.triangle.2.circlepath.circle.fill" }
        return "person.crop.circle.badge.exclamationmark"
    }

    private var codexStatusColor: Color {
        if model.authStatus?.authenticated == true { return .green }
        if model.loginInProgress || model.authStatus == nil { return .blue }
        return .orange
    }

    private func openSettings(_ pane: SettingsNavigationPane) {
        model.requestedSettingsTab = pane.rawValue
        SettingsWindowController.shared.show(model: model)
    }
}

private struct ConnectionRecoveryIssue: Identifiable {
    let kind: ConnectionRecoveryComponent
    let title: String
    let detail: String
    let symbol: String
    let checking: Bool

    var id: String { kind.rawValue }
}

struct ConnectionRecoveryView: View {
    @EnvironmentObject private var model: AppModel
    let onConfigure: () -> Void
    let onClose: () -> Void
    private let automaticRefresh: Bool
    @State private var attemptedRecovery = false
    @State private var advancedExpanded = false

    init(
        onConfigure: @escaping () -> Void,
        onClose: @escaping () -> Void,
        automaticRefresh: Bool = true
    ) {
        self.onConfigure = onConfigure
        self.onClose = onClose
        self.automaticRefresh = automaticRefresh
    }

    var body: some View {
        VStack(spacing: 0) {
            recoveryHeader
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if issues.isEmpty {
                        allReadyContent
                    } else {
                        Text("macos.connectionAssistant.recoveryDescription")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        ForEach(issues) { issue in
                            recoveryIssueRow(issue)
                        }
                        if readyCount > 0 {
                            Label(
                                BridgeAppLocalization.format(
                                    "macos.connectionAssistant.readyCount",
                                    locale: model.interfaceLocale,
                                    readyCount
                                ),
                                systemImage: "checkmark.circle.fill"
                            )
                            .font(.caption)
                            .foregroundStyle(.green)
                        }
                    }

                    advancedDetails
                }
                .padding(.horizontal, 32)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            recoveryFooter
        }
        .frame(minWidth: 620, minHeight: 520)
        .task {
            guard automaticRefresh else { return }
            await model.refreshStatus()
            await model.refreshAuthStatus()
        }
        .onChange(of: advancedExpanded) { expanded in
            guard expanded else { return }
            Task { await model.refreshLogs() }
        }
    }

    private var recoveryHeader: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: issues.isEmpty ? "checkmark.circle.fill" : "wrench.and.screwdriver")
                .font(.title2.weight(.semibold))
                .foregroundStyle(issues.isEmpty ? Color.green : Color.accentColor)
                .frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text(issues.isEmpty
                     ? "macos.connectionAssistant.allReadyTitle"
                     : "macos.connectionAssistant.recoveryTitle")
                    .font(.title2.bold())
                Text(model.connectionTargetName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
    }

    private var allReadyContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("macos.connectionAssistant.allReadyDescription")
                .font(.callout)
                .foregroundStyle(.secondary)
            Label(
                model.health.accessibilityLabel(locale: model.interfaceLocale),
                systemImage: "checkmark.circle.fill"
            )
            .foregroundStyle(.green)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
    }

    private func recoveryIssueRow(_ issue: ConnectionRecoveryIssue) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if issue.checking {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 24, height: 24)
            } else {
                Image(systemName: issue.symbol)
                    .font(.title3)
                    .foregroundStyle(attemptedRecovery ? Color.red : Color.orange)
                    .frame(width: 24, height: 24)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(issue.title)
                    .font(.headline)
                Text(issue.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                recoveryActions(for: issue)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 11))
    }

    @ViewBuilder
    private func recoveryActions(for issue: ConnectionRecoveryIssue) -> some View {
        let actions = ConnectionRecoveryPlan.recommendedActions(
            for: issue.kind,
            isRemoteClient: model.isRemoteClient,
            configurationValid: model.helperStatus?.configuration.valid == true,
            bridgeConnected: model.helperStatus?.bridge.connected == true,
            helperPhase: model.helperStatus?.phase,
            codexInstalled: model.authStatus?.installed,
            permissionsRepairAvailable: configurationPermissionsCanBeRepaired,
            bridgeObservation: model.helperStatus?.bridge.observation
        )
        if !actions.isEmpty {
            HStack(spacing: 12) {
                ForEach(actions, id: \.self) { action in
                    switch action {
                    case .configureConnection:
                        Button("macos.connectionAssistant.configureConnection", action: onConfigure)
                    case .repairPermissions:
                        Button("macos.repairwithapponlypermissions") {
                            attemptedRecovery = true
                            Task { _ = await model.repairConfigurationPermissions() }
                        }
                        .disabled(model.isBusy)
                    case .startRuntime:
                        Button("macos.start") {
                            attemptedRecovery = true
                            Task { _ = await model.startRuntime() }
                        }
                        .disabled(model.isBusy)
                    case .restartRuntime:
                        Button("macos.runtime.restartAction") {
                            attemptedRecovery = true
                            Task { _ = await model.restartRuntime(force: false) }
                        }
                        .disabled(model.isBusy)
                    case .startCodexLogin:
                        Button("macos.startcodexbrowserlogin") {
                            attemptedRecovery = true
                            Task { _ = await model.launchCodexLogin() }
                        }
                        .disabled(model.isBusy || model.loginInProgress)
                    case .openCodexSettings:
                        Button("macos.connectionAssistant.openCodexSettings") {
                            attemptedRecovery = true
                            openSettings(.codex)
                        }
                    }
                }
            }
        }
    }

    private var advancedDetails: some View {
        DisclosureGroup(isExpanded: $advancedExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                if let configuration = model.helperStatus?.configuration {
                    LabeledContent("macos.storagelocation") {
                        Text(configuration.path)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                    }
                    if let tunnelID = configuration.tunnelId {
                        LabeledContent("macos.currenttunnelid") {
                            Text(tunnelID)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                }
                Button("macos.refreshlogs") {
                    Task { await model.refreshLogs() }
                }
                if model.logs.isEmpty {
                    Text("macos.therearenohelperorruntimelogsto")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.logs) { entry in
                        Text(BridgeAppLocalization.format(
                            "macos.format.dotSeparatedLabelValue",
                            locale: model.interfaceLocale,
                            DisplayFormat.dateTime(entry.at, locale: model.interfaceLocale),
                            entry.source,
                            entry.message
                        ))
                            .font(.caption2.monospaced())
                            .textSelection(.enabled)
                    }
                }
                if let error = model.logsErrorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }
            .padding(.top, 10)
        } label: {
            Label(
                "macos.connectionAssistant.advancedDetails",
                systemImage: "info.circle"
            )
        }
        .font(.caption)
    }

    private var recoveryFooter: some View {
        HStack(spacing: 10) {
            Button("common.cancel", action: onClose)
                .keyboardShortcut(.cancelAction)
            Spacer()
            if model.isBusy { ProgressView().controlSize(.small) }
            if issues.isEmpty {
                Button("macos.connectionAssistant.doneAction", action: onClose)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            } else {
                Button("macos.tryagain") {
                    attemptedRecovery = true
                    Task {
                        await model.refreshAll()
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(model.isBusy)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var issues: [ConnectionRecoveryIssue] {
        var result: [ConnectionRecoveryIssue] = []
        if !model.isRemoteClient, model.helperStatus?.configuration.valid != true {
            result.append(ConnectionRecoveryIssue(
                kind: .configuration,
                title: localized("macos.connectionAssistant.configurationIssue"),
                detail: model.runtimeConfigurationIssueMessage ??
                    localized("macos.runtimeconnectiondetailshavenotbeensavedyet"),
                symbol: "key.horizontal",
                checking: model.helperStatus == nil && model.statusErrorMessage == nil
            ))
        }
        if !model.isRemoteClient, model.helperStatus?.bridge.connected != true {
            result.append(ConnectionRecoveryIssue(
                kind: .bridge,
                title: localized("macos.bridge"),
                detail: model.runtimeErrorMessage ?? model.startupErrorMessage ??
                    model.statusErrorMessage ?? model.runtimeUnavailableExplanation,
                symbol: "server.rack",
                checking: model.isBridgeConnectionChecking
            ))
        }
        if !model.isRemoteClient, model.helperStatus?.tunnel.connected != true {
            result.append(ConnectionRecoveryIssue(
                kind: .tunnel,
                title: localized("macos.securemcptunnel"),
                detail: model.tunnelStatusErrorMessage ?? localized("macos.notconnected"),
                symbol: "network.slash",
                checking: model.isTunnelConnectionChecking
            ))
        }
        if !model.isRemoteClient, model.authStatus?.authenticated != true {
            result.append(ConnectionRecoveryIssue(
                kind: .codex,
                title: localized("macos.codexlogin"),
                detail: codexIssueDescription,
                symbol: "person.crop.circle.badge.exclamationmark",
                checking: model.authStatus == nil && model.authErrorMessage == nil
            ))
        }
        if model.isRemoteClient, model.remoteHello == nil {
            result.append(ConnectionRecoveryIssue(
                kind: .bridge,
                title: localized("macos.link"),
                detail: model.connectionErrorMessage ?? model.statusErrorMessage ??
                    localized("macos.notconnectedtotheselectedserver"),
                symbol: "network.slash",
                checking: model.isBridgeConnectionChecking
            ))
        }
        return result
    }

    private var readyCount: Int {
        let total = model.isRemoteClient ? 1 : 4
        return max(0, total - issues.count)
    }

    private var configurationPermissionsCanBeRepaired: Bool {
        model.helperStatus?.configuration.issueProblem?.code ==
            "runtime-env-permissions-too-broad" ||
            model.helperStatus?.configuration.issue?.contains(
                "permissions are too broad"
            ) == true
    }

    private var codexIssueDescription: String {
        if let error = model.authErrorMessage { return error }
        guard let status = model.authStatus else {
            return localized("macos.checkingloginstatus")
        }
        if !status.installed { return localized("macos.codexclicouldnotbefoundcheckthe") }
        return localized("macos.codexloginisrequiredsigninbeforethe")
    }

    private func localized(_ key: String) -> String {
        BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    private func openSettings(_ pane: SettingsNavigationPane) {
        model.requestedSettingsTab = pane.rawValue
        SettingsWindowController.shared.show(model: model)
    }
}
