import AppKit
import CodexBridgeKit
import SwiftUI
import SystemConfiguration

private func detectedRemoteManagementEndpoint() -> String {
    let configuredLocalName = (SCDynamicStoreCopyLocalHostName(nil) as String?)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let processHostName = ProcessInfo.processInfo.hostName
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let host: String
    if let configuredLocalName, !configuredLocalName.isEmpty {
        host = configuredLocalName.hasSuffix(".local")
            ? configuredLocalName
            : "\(configuredLocalName).local"
    } else if !processHostName.isEmpty {
        host = processHostName
    } else {
        host = "localhost"
    }
    var components = URLComponents()
    components.scheme = "https"
    components.host = host
    components.port = 8766
    return components.string ?? "https://\(host):8766"
}

struct NativeSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var syncState = SettingsDraftSyncState()
    @State private var showDiscardDraftConfirmation = false
    @AppStorage("settings.selectedPane") private var selectedTab = "general"
    var onSelectedPaneChange: ((String) -> Void)?

    init(onSelectedPaneChange: ((String) -> Void)? = nil) {
        self.onSelectedPaneChange = onSelectedPaneChange
    }

    var body: some View {
        VStack(spacing: 10) {
            RuntimeLifecycleNoticeView()
            if syncState.externalChangeDetected {
                HStack(spacing: 10) {
                    Label(
                        "macos.settingschangedelsewheresoautomaticsavingpausedreview",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                    Spacer()
                    Button("macos.reloadlatestvalues") {
                        showDiscardDraftConfirmation = true
                    }
                }
            }
            TabView(selection: $selectedTab) {
                ConnectionSettingsPane()
                    .environmentObject(model)
                    .tabItem { Label("macos.link", systemImage: "network") }
                    .tag("connection")

                if !model.isRemoteClient {
                    CodexRuntimeSettingsPane(isSelected: selectedTab == "codex")
                        .environmentObject(model)
                        .tabItem { Label("macos.codex", systemImage: "terminal") }
                        .tag("codex")
                }

                if model.needsSetup {
                    ConnectionRepairView()
                        .tabItem { Label("macos.server", systemImage: "wrench.and.screwdriver") }
                        .tag("general")
                } else {
                    Group {
                        if let snapshot = model.settings, let draft = syncState.draft {
                            GeneralSettingsPane(
                                snapshot: snapshot,
                                draft: binding(for: draft),
                                didReset: {
                                    synchronizeDraft(force: true)
                                    model.restorePersistedInterfaceLocale()
                                }
                            )
                            .environmentObject(model)
                        } else {
                            SettingsConnectionUnavailablePane()
                                .environmentObject(model)
                        }
                    }
                    .tabItem { Label("macos.general", systemImage: "gearshape") }
                    .tag("general")

                    Group {
                        if let snapshot = model.settings {
                            ProjectsSettingsPane(
                                snapshot: snapshot,
                                usesRemotePaths: model.isRemoteClient
                            )
                            .environmentObject(model)
                        } else {
                            SettingsConnectionUnavailablePane()
                                .environmentObject(model)
                        }
                    }
                    .tabItem { Label("settings.projects", systemImage: "folder") }
                    .tag("projects")

                    SkillsLibraryView()
                        .environmentObject(model)
                        .tabItem { Label("macos.skills", systemImage: "books.vertical") }
                        .tag("skills")

                    if !model.isRemoteClient {
                        Group {
                            if let snapshot = model.settings {
                                RuntimeStatusPane(snapshot: snapshot)
                                    .environmentObject(model)
                            } else {
                                SettingsConnectionUnavailablePane()
                                    .environmentObject(model)
                            }
                        }
                        .tabItem { Label("macos.server", systemImage: "server.rack") }
                        .tag("server")
                    }
                }
            }
        }
        .padding(18)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.locale, model.interfaceLocale)
        .onAppear {
            synchronizeDraft()
            if let target = model.requestedSettingsTab { selectedTab = target; model.requestedSettingsTab = nil }
            reportSelectedPane()
        }
        .onChange(of: selectedTab) { _ in reportSelectedPane() }
        .onChange(of: model.requestedSettingsTab) { target in
            if let target { selectedTab = target; model.requestedSettingsTab = nil }
        }
        .onChange(of: model.connectionContextID) { _ in
            syncState = SettingsDraftSyncState()
            synchronizeDraft(force: true)
            selectedTab = model.settings == nil ? "connection" : "general"
        }
        .onChange(of: model.settings?.settings.settingsRevision) { revision in
            guard let snapshot = model.settings else { return }
            if revision == model.lastAutosavedSettingsRevision,
               let submitted = model.lastAutosavedDraft {
                syncState.acknowledgePersisted(snapshot: snapshot, submitted: submitted)
                model.consumeAutosaveAcknowledgement(revision: revision ?? -1)
            } else {
                synchronizeDraft()
            }
            reportSelectedPane()
        }
        .onChange(of: model.needsSetup) { _ in reportSelectedPane() }
        .onChange(of: model.interfaceLocalePreference) { _ in reportSelectedPane() }
        .alert("macos.settingsconflict", isPresented: Binding(
            get: { model.settingsConflictMessage != nil },
            set: { if !$0 { model.settingsConflictMessage = nil } }
        )) {
            Button("macos.ok", role: .cancel) {}
        } message: {
            Text(model.settingsConflictMessage ?? "")
        }
        .confirmationDialog(
            "macos.discardyourcurrenteditsandloadthelatest",
            isPresented: $showDiscardDraftConfirmation
        ) {
            Button("macos.discardedits", role: .destructive) {
                model.cancelPendingSettingsAutosave()
                synchronizeDraft(force: true)
                model.restorePersistedInterfaceLocale()
            }
        }
    }

    private func synchronizeDraft(force: Bool = false) {
        guard let snapshot = model.settings else { return }
        syncState.synchronize(with: snapshot, force: force)
    }

    private func reportSelectedPane() {
        let key: String
        switch selectedTab {
        case "connection": key = "macos.link"
        case "codex": key = "macos.codex"
        case "projects": key = "settings.projects"
        case "skills": key = "macos.skills"
        case "server": key = "macos.server"
        default:
            key = model.needsSetup ? "macos.serversettings" : "macos.general"
        }
        onSelectedPaneChange?(BridgeAppLocalization.string(key, locale: model.interfaceLocale))
    }

    private func binding(for value: SettingsDraft) -> Binding<SettingsDraft> {
        Binding(
            get: { syncState.draft ?? value },
            set: { next in
                syncState.updateDraft(next)
                model.previewInterfaceLocale(next.uiLocalePreference)
                if !syncState.externalChangeDetected {
                    model.scheduleSettingsAutosave(next)
                }
            }
        )
    }
}

private struct ConnectionSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    @State private var showRemoteModeConfirmation = false
    @State private var showRemoteConnectionSheet = false
    @State private var confirmRemoteModeAfterSheet = false
    @State private var showDisableRemoteConnectionConfirmation = false
    @State private var profileDeletionTarget: RemoteServerProfile?
    @State private var deviceRevocationTarget: RemoteManagementDevice?
    @State private var activeProfileName = ""
    @State private var hostedEndpoint = detectedRemoteManagementEndpoint()
    @State private var hostedDisplayName = Host.current().localizedName ?? "Codex MCP Bridge"
    @State private var pairingInvitationCopied = false
    @State private var advancedConnectionSettingsExpanded = false

    var body: some View {
        Form {
            Section("macos.approle") {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: model.isRemoteClient ? "network" : "desktopcomputer")
                        .font(.title2)
                        .foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(BridgeAppLocalization.string(
                            model.isRemoteClient ? "macos.connecttoexistingserver" : "macos.runserveronthismac",
                            locale: model.interfaceLocale
                        ))
                            .font(.headline)
                        Text(BridgeAppLocalization.string(
                            model.isRemoteClient
                                ? "macos.thisappusesonlytheselectedservers"
                                : "macos.thismacownsandrunsthehelperbridge",
                            locale: model.interfaceLocale
                        ))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.isRemoteClient {
                        Button("macos.runonthismac") {
                            Task { await model.setConnectionMode(.localHost) }
                        }
                    } else {
                        Button("macos.connecttoexistingserver") {
                            showRemoteConnectionSheet = true
                        }
                    }
                }
            }

            if model.isRemoteClient {
                remoteClientSections
            } else {
                hostedServerSections
            }

            Section("macos.thismacsappsettings") {
                Toggle("macos.notifyaboutbridgeproblems", isOn: $model.bridgeProblemNotificationsEnabled)
                Toggle("macos.securityandconnectionapprovalnotifications", isOn: $model.securityNotificationsEnabled)
                HStack {
                    switch model.notificationPermission {
                    case .authorized:
                        Label("macos.macosnotificationsallowed", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Spacer()
                        Button("macos.openmacosnotificationsettings") { model.openNotificationSettings() }
                    case .denied:
                        Label("macos.macosnotificationsaredisabled", systemImage: "bell.slash")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("macos.openmacosnotificationsettings") { model.openNotificationSettings() }
                    case .notDetermined:
                        Button("macos.checkmacosnotificationpermission") {
                            Task { await model.requestNotificationAuthorization() }
                        }
                        .disabled(model.notificationAuthorizationInProgress)
                    case .unknown:
                        Text("macos.checkingnotificationpermission").foregroundStyle(.secondary)
                    }
                }
                Text("macos.notificationsfollowmacossettingsandfocusconnectionproblems")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Toggle(
                    "macos.launchmenubarappatlogin",
                    isOn: Binding(
                        get: { model.menuBarLoginItemStatus.isEnabled },
                        set: { model.setMenuBarLaunchAtLogin($0) }
                    )
                )
                .disabled(model.loginItemOperationInProgress)

                Text(BridgeAppLocalization.string(
                    model.isRemoteClient
                        ? "macos.thisappusesonlytheselectedservers"
                        : "macos.appliesimmediatelyonthismacturningitoff",
                    locale: model.interfaceLocale
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                switch model.menuBarLoginItemStatus {
                case .enabled:
                    Label("macos.themenubarappwillopenautomaticallyat", systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case .requiresApproval:
                    Label("macos.macosapprovalisrequiredforthisloginitem", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                    Button("macos.openloginitemsettings") {
                        model.openLoginItemsSystemSettings()
                    }
                case .notFound:
                    Label("macos.theloginitemcouldnotbefoundin", systemImage: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                case .unknown:
                    Label("macos.theloginitemstatuscouldnotbedetermined", systemImage: "questionmark.circle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                case .notRegistered:
                    EmptyView()
                }

                if let error = model.loginItemErrorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await model.refreshNotificationPermission() }
        }
        .onAppear {
            Task { await model.refreshNotificationPermission() }
            synchronizeProfileName()
            guard !model.isRemoteClient else { return }
            Task {
                await model.refreshRemoteManagementStatus()
                synchronizeHostedFields()
            }
        }
        .onChange(of: model.connectionPreferences.activeServerId) { _ in
            synchronizeProfileName()
        }
        .onChange(of: model.remoteManagementStatus) { _ in
            synchronizeHostedFields()
        }
        .onChange(of: model.remotePairingInvitation) { invitation in
            if invitation == nil { pairingInvitationCopied = false }
        }
        .onChange(of: model.bridgeConnected) { connected in
            guard connected, !model.isRemoteClient else { return }
            Task { await model.refreshRemoteManagementStatus() }
        }
        .sheet(
            isPresented: $showRemoteConnectionSheet,
            onDismiss: {
                guard confirmRemoteModeAfterSheet else { return }
                confirmRemoteModeAfterSheet = false
                showRemoteModeConfirmation = true
            }
        ) {
            RemoteServerConnectionSheet { shouldSwitchMode in
                confirmRemoteModeAfterSheet = shouldSwitchMode
                showRemoteConnectionSheet = false
            }
            .environmentObject(model)
        }
        .confirmationDialog(
            "macos.switchtoremoteclientmode",
            isPresented: $showRemoteModeConfirmation
        ) {
            Button("macos.switchtoremotemodeafterfinishingwork") {
                Task { await model.setConnectionMode(.remoteClient) }
            }
            Button("macos.forcestopandswitch", role: .destructive) {
                Task { await model.setConnectionMode(.remoteClient, force: true) }
            }
            Button("common.cancel", role: .cancel) {}
        } message: {
            Text("macos.theserverandtunnelrunningonthismac")
        }
        .confirmationDialog(
            "macos.remoteConnections.turnOffConfirmation",
            isPresented: $showDisableRemoteConnectionConfirmation
        ) {
            Button("macos.turnoffconnectionsfromothermacs", role: .destructive) {
                Task {
                    await model.configureRemoteManagement(
                        enabled: false,
                        endpoint: hostedEndpoint,
                        displayName: hostedDisplayName
                    )
                }
            }
            Button("common.cancel", role: .cancel) {}
        } message: {
            Text("macos.registereddevicesarekeptbuttheycannotconnect")
        }
        .confirmationDialog(
            "macos.deletethesavedserverfromthismac",
            isPresented: Binding(
                get: { profileDeletionTarget != nil },
                set: { if !$0 { profileDeletionTarget = nil } }
            ),
            presenting: profileDeletionTarget
        ) { profile in
            Button("macos.deleteserverprofileandcredentials", role: .destructive) {
                Task {
                    if await model.removeRemoteServer(profile.serverId) {
                        profileDeletionTarget = nil
                    }
                }
            }
        } message: { profile in
            Text(BridgeAppLocalization.format(
                "macos.thisdoesnotchangetheserveritselfor",
                locale: model.interfaceLocale,
                profile.name
            ))
        }
        .confirmationDialog(
            "macos.revokethisdevicesremoteaccess",
            isPresented: Binding(
                get: { deviceRevocationTarget != nil },
                set: { if !$0 { deviceRevocationTarget = nil } }
            ),
            presenting: deviceRevocationTarget
        ) { device in
            Button("macos.revokeaccess", role: .destructive) {
                Task {
                    if await model.revokeRemoteDevice(device.id) {
                        deviceRevocationTarget = nil
                    }
                }
            }
        } message: { device in
            Text(BridgeAppLocalization.format(
                "macos.thecredentialsforwillstopworkingimmediately",
                locale: model.interfaceLocale,
                device.name
            ))
        }
    }

    @ViewBuilder
    private var remoteClientSections: some View {
        Section("macos.activeserver") {
            if model.connectionPreferences.profiles.isEmpty {
                Label("macos.noserversaresavedenterapairinginvitation", systemImage: "server.rack")
                    .foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("macos.pairnewserver") {
                        showRemoteConnectionSheet = true
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isBusy)
                }
            } else {
                ForEach(model.connectionPreferences.profiles) { profile in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(profile.name).font(.headline)
                                if profile.serverId == model.connectionPreferences.activeServerId {
                                    Text("agent.active").font(.caption2).padding(4).background(.quaternary, in: Capsule())
                                }
                            }
                            Text(profile.endpoint)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                            Text(BridgeAppLocalization.format(
                                "macos.serverid",
                                locale: model.interfaceLocale,
                                profile.serverId
                            ))
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        if profile.serverId != model.connectionPreferences.activeServerId {
                            Button("macos.switch") {
                                Task { await model.activateRemoteServer(profile.serverId) }
                            }
                        }
                        Button(role: .destructive) {
                            profileDeletionTarget = profile
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                    }
                }
                HStack {
                    Spacer()
                    Button("macos.pairnewserver") {
                        showRemoteConnectionSheet = true
                    }
                    .disabled(model.isBusy)
                }
            }
            if let profile = model.activeRemoteProfile {
                HStack {
                    TextField("macos.activeserverdisplayname", text: $activeProfileName)
                    Button("macos.savename") {
                        _ = model.renameRemoteServer(profile.serverId, name: activeProfileName)
                    }
                    .disabled(activeProfileName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if let hello = model.remoteHello {
                Label(
                    BridgeAppLocalization.format(
                        "macos.bridgeconnected",
                        locale: model.interfaceLocale,
                        hello.server.displayName,
                        hello.bridge.version
                    ),
                    systemImage: "checkmark.circle.fill"
                )
                .foregroundStyle(.green)
            } else if model.activeRemoteProfile != nil {
                Label("macos.notconnectedtotheselectedserver", systemImage: "network.slash")
                    .foregroundStyle(.orange)
                Button("macos.reconnect") { Task { await model.refreshAll() } }
            }
        }

        if let error = model.connectionErrorMessage {
            Section("macos.connectionerror") {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private var hostedServerSections: some View {
        Section("macos.managethisserverfromanothermac") {
            Text("macos.thismacsnameandconnectionaddressare")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("macos.servernameshownonotherdevices", text: $hostedDisplayName)
            HStack {
                if let status = model.remoteManagementStatus {
                    Label(
                        remoteManagementStatusText(status),
                        systemImage: status.listening ? "lock.shield.fill" : "lock.slash"
                    )
                    .foregroundStyle(status.listening ? .green : status.enabled ? .orange : .secondary)
                }
                Spacer()
                Button {
                    Task {
                        await model.configureRemoteManagement(
                            enabled: true,
                            endpoint: hostedEndpoint,
                            displayName: hostedDisplayName
                        )
                    }
                } label: {
                    Text(remoteManagementActionTitle)
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    hostedEndpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        hostedDisplayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        model.isBusy
                )
                if model.remoteManagementStatus?.enabled == true {
                    Button("macos.turnoffconnections", role: .destructive) {
                        showDisableRemoteConnectionConfirmation = true
                    }
                    .disabled(model.isBusy)
                }
            }
            FullRowDisclosure(
                "macos.advancedconnectionsettings",
                isExpanded: $advancedConnectionSettingsExpanded
            ) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("macos.thisaddresswasdetectedautomaticallychangeitonly")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text("macos.httpsaddress")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 76, alignment: .leading)
                        TextField(text: $hostedEndpoint) {
                            EmptyView()
                        }
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity)
                    }
                    if let status = model.remoteManagementStatus {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(BridgeAppLocalization.format(
                                "macos.connection.serverIdLabeled",
                                locale: model.interfaceLocale,
                                status.serverId
                            ))
                            if let fingerprint = status.certificateSha256 {
                                Text(BridgeAppLocalization.format(
                                    "macos.certificatesha256",
                                    locale: model.interfaceLocale,
                                    fingerprint
                                ))
                            }
                        }
                        .font(.caption2.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            if let error = model.remoteManagementErrorMessage ??
                model.remoteManagementStatusErrorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }

        if model.remoteManagementStatus?.listening == true {
            Section("macos.devicepairing") {
                Text("macos.createsaonetimeinvitationtopasteinto")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("macos.createandcopyanewpairinginvitationvalid") {
                    pairingInvitationCopied = false
                    Task {
                        if await model.beginRemotePairing(),
                           let pairing = model.remotePairingInvitation {
                            copyToPasteboard(pairing.invitation)
                            pairingInvitationCopied = true
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
                if let pairing = model.remotePairingInvitation {
                    if pairingInvitationCopied {
                        Label("macos.pairinginvitationcopiedtotheclipboard", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                    HStack {
                        Text(BridgeAppLocalization.format(
                            "macos.usableonceuntil",
                            locale: model.interfaceLocale,
                            DisplayFormat.dateTime(pairing.expiresAt, locale: model.interfaceLocale)
                        ))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("macos.copyinvitation") {
                            copyToPasteboard(pairing.invitation)
                            pairingInvitationCopied = true
                        }
                    }
                }
            }

            Section("macos.registereddevices") {
                if model.remoteManagementStatus?.devices.isEmpty != false {
                    Text("macos.therearenoregisteredremotedevices")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.remoteManagementStatus?.devices ?? []) { device in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.name).font(.headline)
                            Text(device.lastSeenAt.map {
                                BridgeAppLocalization.format(
                                    "macos.lastconnected",
                                    locale: model.interfaceLocale,
                                    $0
                                )
                            } ?? BridgeAppLocalization.string(
                                "macos.neverconnected",
                                locale: model.interfaceLocale
                            ))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("macos.revoke", role: .destructive) {
                            deviceRevocationTarget = device
                        }
                    }
                }
            }
        }
    }

    private func synchronizeProfileName() {
        activeProfileName = model.activeRemoteProfile?.name ?? ""
    }

    private func remoteManagementStatusText(_ status: RemoteManagementStatus) -> String {
        if status.listening {
            return BridgeAppLocalization.string(
                "macos.readyforconnections",
                locale: model.interfaceLocale
            )
        }
        if status.enabled {
            return BridgeAppLocalization.string("macos.failedtostart", locale: model.interfaceLocale)
        }
        return BridgeAppLocalization.string("macos.off", locale: model.interfaceLocale)
    }

    private var remoteManagementActionTitle: String {
        if model.remoteManagementStatus?.listening == true {
            return BridgeAppLocalization.string("macos.savesettings", locale: model.interfaceLocale)
        }
        if model.remoteManagementStatus?.enabled == true {
            return BridgeAppLocalization.string("macos.restart", locale: model.interfaceLocale)
        }
        return BridgeAppLocalization.string("macos.turnonconnectionsfromothermacs", locale: model.interfaceLocale)
    }

    private func synchronizeHostedFields() {
        let detectedEndpoint = detectedRemoteManagementEndpoint()
        if let status = model.remoteManagementStatus {
            hostedEndpoint = status.endpoint ?? detectedEndpoint
            if status.endpoint != nil || status.enabled {
                hostedDisplayName = status.displayName
            }
        } else if hostedEndpoint.isEmpty {
            hostedEndpoint = detectedEndpoint
        }
    }

    private func copyToPasteboard(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}

private struct RemoteServerConnectionSheet: View {
    @EnvironmentObject private var model: AppModel
    let onComplete: (Bool) -> Void
    @State private var invitation = ""
    @State private var profileName = ""
    @State private var deviceName = Host.current().localizedName ?? "Mac"
    @State private var selectedServerId = ""
    @State private var optionalFieldsExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.isRemoteClient ? "macos.pairnewserver" : "macos.connecttoexistingserver")
                        .font(.title2.bold())
                    Text("macos.thepairinginvitationcopiedfromtheserververifies")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(20)

            Divider()

            Form {
                if !model.isRemoteClient, !model.connectionPreferences.profiles.isEmpty {
                    Section("macos.useasavedserver") {
                        Picker("macos.server", selection: $selectedServerId) {
                            ForEach(model.connectionPreferences.profiles) { profile in
                                Text(profile.name).tag(profile.serverId)
                            }
                        }
                        HStack {
                            Spacer()
                            Button("macos.connecttoselectedserver") {
                                if model.prepareRemoteServerForModeSwitch(selectedServerId) {
                                    onComplete(true)
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(selectedServerId.isEmpty || model.isBusy)
                        }
                    }
                }

                Section("macos.pairnewserver") {
                    Text("macos.ontheservermacclickcreateandcopy")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $invitation)
                        .font(.caption.monospaced())
                        .frame(minHeight: 76)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                    HStack {
                        Button("macos.pastefromclipboard") {
                            if let copied = NSPasteboard.general.string(forType: .string) {
                                invitation = copied.trimmingCharacters(in: .whitespacesAndNewlines)
                            }
                        }
                        Spacer()
                    }
                    TextField("macos.nameofthisdeviceshownontheserver", text: $deviceName)
                    FullRowDisclosure("macos.optional", isExpanded: $optionalFieldsExpanded) {
                        TextField("macos.servernametosaveoptional", text: $profileName)
                    }
                    HStack {
                        Spacer()
                        Button(model.isRemoteClient ? "macos.pairandactivate" : "macos.verifyandregisterserver") {
                            let shouldSwitchMode = !model.isRemoteClient
                            Task {
                                if await model.pairRemoteServer(
                                    invitation: invitation,
                                    profileName: profileName,
                                    deviceName: deviceName
                                ) {
                                    onComplete(shouldSwitchMode)
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(
                            invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                model.isBusy
                        )
                    }
                    Text("macos.devicecredentialsarestoredonlyinthemacos")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if let error = model.connectionErrorMessage {
                    Section("macos.connectionerror") {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                Spacer()
                Button("common.cancel") { onComplete(false) }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(16)
        }
        .frame(width: 540, height: model.isRemoteClient ? 480 : 590)
        .environment(\.locale, model.interfaceLocale)
        .onAppear {
            selectedServerId = model.connectionPreferences.activeServerId ??
                model.connectionPreferences.profiles.first?.serverId ?? ""
        }
    }
}

private struct SettingsConnectionUnavailablePane: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 12) {
            if !model.bridgeConnected, model.isBridgeConnectionChecking {
                ProgressView("macos.checkingthebridgeconnection")
                    .controlSize(.small)
            } else if model.isRemoteClient {
                BridgeBrandStatusIcon(health: .unavailable, size: 44)
                if model.activeRemoteProfile == nil {
                    Text("macos.pairaserverintheconnectiontab")
                        .font(.headline)
                    Text("macos.remotemodedoesnotstartthehelperor")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("macos.couldnotloadtheremoteserversettings")
                        .font(.headline)
                    if let error = model.connectionErrorMessage ??
                        model.statusErrorMessage ?? model.settingsLoadErrorMessage {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                    Button("macos.reconnect") { Task { await model.refreshAll() } }
                        .buttonStyle(.borderedProminent)
                }
            } else if !model.bridgeConnected {
                BridgeBrandStatusIcon(health: .unavailable, size: 44)
                Text("macos.startthebridgeserveronthismacto")
                Button("macos.startserver") { Task { await model.startRuntime() } }
                    .buttonStyle(.borderedProminent)
                if let error = model.runtimeErrorMessage ?? model.statusErrorMessage {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            } else if model.settingsLoadErrorMessage != nil {
                BridgeBrandStatusIcon(health: .attention, size: 44)
                Text("macos.settingscouldnotbeloaded").font(.headline)
                Text("macos.logininformationconversationhistoryprojectsandbridgesettings")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("macos.tryagain") { Task { await model.refreshSettings() } }
            } else {
                ProgressView("macos.loadingsettings")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(30)
    }
}

private struct GeneralSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot
    @Binding var draft: SettingsDraft
    let didReset: () -> Void
    @State private var showResetConfirmation = false
    @State private var allowedModelsExpanded = false
    @State private var expandedModelIDs = Set<String>()

    private var choices: [ModelChoice] {
        SettingsDraft.displayedChoices(
            in: snapshot,
            allowDelegation: draft.allowDelegation,
            preservingKeys: draft.explicitSelectionKeys.union([
                draft.fixedSelectionKey
            ])
        )
    }
    private var selectableChoiceKeys: Set<String> {
        Set(SettingsDraft.selectableChoices(
            in: snapshot,
            allowDelegation: draft.allowDelegation
        ).map(\.key))
    }
    private var modelsByID: [String: CatalogModel] {
        snapshot.catalog.models.reduce(into: [:]) { models, model in
            if models[model.id] == nil {
                models[model.id] = model
            }
        }
    }
    private var modelIDs: [String] {
        var seen = Set<String>()
        return choices.map(\.model).filter { seen.insert($0).inserted }
    }

    var body: some View {
        Form {
            Section {
                Label(
                    "macos.thesesettingsaresharedbyeveryconversationusing",
                    systemImage: "person.2"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Section("macos.access") {
                Picker("macos.accessstrategy", selection: $draft.accessStrategy) {
                    ForEach(snapshot.capabilities.availableAccessStrategies, id: \.self) {
                        Text(accessLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                Text(accessDescription(draft.accessStrategy, locale: model.interfaceLocale))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("macos.thisisthedefaultaccessleveleachtask")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if draft.accessStrategy == "always-full" {
                    Label(
                        BridgeAppLocalization.string(
                            snapshot.capabilities.allowDangerFullAccess
                                ? "macos.fullaccessrunscodexwiththismacosuser"
                                : "macos.yourfullaccesspreferenceispreservedbutthe",
                            locale: model.interfaceLocale
                        ),
                        systemImage: "exclamationmark.shield.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }

            Section("macos.modelpolicy") {
                Picker("macos.selectionmode", selection: policyModeBinding) {
                    Text("settings.modelPolicy.fixed").tag("fixed")
                    Text("settings.language.auto").tag("automatic")
                }
                .pickerStyle(.segmented)

                if draft.policyMode == "fixed" {
                    Picker("settings.model", selection: fixedModelIDBinding) {
                        ForEach(modelIDs, id: \.self) { modelID in
                            Text(modelLabel(modelID)).tag(modelID)
                        }
                    }
                    Picker("macos.reasoningeffort", selection: fixedEffortBinding) {
                        ForEach(choicesForFixedModel, id: \.key) { choice in
                            Text(effortLabel(choice)).tag(choice.reasoningEffort)
                                .disabled(draft.isUltraDisabled(choice))
                        }
                    }
                } else {
                    Picker("macos.automaticallowlist", selection: $draft.allowedKind) {
                        Text("macos.allvisiblecatalogmodels").tag("catalog-visible")
                        Text("macos.selectexplicitly").tag("explicit")
                    }
                    if draft.allowedKind == "explicit" {
                        FullRowDisclosure(
                            "macos.allowedmodelsandreasoningefforts",
                            isExpanded: $allowedModelsExpanded
                        ) {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(modelIDs, id: \.self) { modelID in
                                    FullRowDisclosure(
                                        isExpanded: modelExpansionBinding(modelID),
                                        label: { Text(modelLabel(modelID)) },
                                        content: {
                                            VStack(alignment: .leading, spacing: 5) {
                                                ForEach(choices(for: modelID), id: \.key) { choice in
                                                    Toggle(
                                                        effortLabel(choice),
                                                        isOn: explicitBinding(choice.key)
                                                    )
                                                    .disabled(
                                                        draft.isUltraDisabled(choice) ||
                                                        (!selectableChoiceKeys.contains(choice.key) &&
                                                        !draft.explicitSelectionKeys.contains(choice.key))
                                                    )
                                                }
                                            }
                                            .padding(.leading, 2)
                                        }
                                    )
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }

                Toggle(
                    "settings.allowDelegation",
                    isOn: $draft.allowDelegation
                )
                Text("settings.ultraHint")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if draft.policyMode == "fixed", let choice = selectedFixedChoice, draft.isUltraDisabled(choice) {
                    Text("settings.ultraFixedConflict")
                        .font(.caption)
                        .foregroundStyle(.orange)
                } else if draft.policyMode == "automatic", draft.allowedKind == "explicit",
                          choices.contains(where: { draft.explicitSelectionKeys.contains($0.key) && draft.isUltraDisabled($0) }),
                          draft.explicitSelectionKeys.isDisjoint(with: selectableChoiceKeys) {
                    Text("settings.ultraNoSelection")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Toggle("settings.usePriority", isOn: $draft.usePriorityServiceTier)
                Text("settings.usePriorityHint")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if snapshot.catalog.stale {
                    Label("macos.themodelcatalogisstalesopolicychanges", systemImage: "clock.badge.exclamationmark")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let warning = snapshot.catalog.warning {
                    Text(warning)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                }
                Button("macos.refreshmodels") {
                    Task { await model.refreshSettings(refreshModels: true) }
                }
                .disabled(model.generalSettingsSaveState.isActive)
            }

            if draft.policyMode == "automatic", snapshot.settings.modelDescriptionOverrides != nil {
                ModelDescriptionsSettingsSection(snapshot: snapshot)
                    .id(model.connectionContextID)
            }

            Section("macos.displayandexecution") {
                Picker("macos.appandcardlanguage", selection: $draft.uiLocalePreference) {
                    ForEach(snapshot.capabilities.availableUiLocalePreferences, id: \.self) {
                        Text(localeLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                Text("macos.withautomaticthemacosappfollowsyourmac")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                LabeledContent("macos.concurrentagenttasks") {
                    HStack(spacing: 6) {
                        TextField(value: concurrentJobsBinding, format: .number) {
                            EmptyView()
                        }
                        .frame(width: 46)
                        .multilineTextAlignment(.trailing)
                        .textFieldStyle(.roundedBorder)
                        Stepper(value: concurrentJobsBinding, in: 1...snapshot.capabilities.maxConcurrentJobs) {
                            EmptyView()
                        }
                        .labelsHidden()
                    }
                }
                Text(BridgeAppLocalization.format(
                    "macos.enteravaluefrom1totheoperator",
                    locale: model.interfaceLocale,
                    snapshot.capabilities.maxConcurrentJobs
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if draft.maxConcurrentJobs > 30 {
                    Label(
                        "macos.valuesabove30cansubstantiallyincreasecpumemory",
                        systemImage: "gauge.with.dots.needle.67percent"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                Toggle("macos.keepnewagenttasksinthecodexapp", isOn: $draft.showBridgeThreadsInCodexApp)
                Text(threadVisibilityDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Toggle("settings.dashboardAutoOpenBackground", isOn: $draft.dashboardAutoOpenBackground)
                Text("settings.dashboardAutoOpenBackgroundHint")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if model.isRemoteClient {
                    Label(
                        "macos.completionnotificationsaresentbythemenubar",
                        systemImage: "bell.badge"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                } else {
                    Toggle("settings.completionFollowUp", isOn: $draft.completionFollowUp)
                    Text("macos.whenworkcompletesthemenubarappon")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

            }

            if let policy = snapshot.historyPolicy, snapshot.settings.historyRetentionDays != nil {
                Section("history.title") {
                    Picker("history.period", selection: $draft.historyRetentionDays) {
                        Text("macos.history.retention7Days").tag(7)
                        Text("macos.history.retention30Days").tag(30)
                        Text("macos.history.retention90Days").tag(90)
                        Text("history.forever").tag(0)
                    }
                    WorkHistoryPolicyView(policy: policy)
                }
            }

            if let error = model.settingsErrorMessage ?? model.settingsLoadErrorMessage {
                Section("macos.saveerror") {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }

            Section {
                HStack {
                    Button("macos.resetgeneralsettings", role: .destructive) {
                        model.cancelPendingSettingsAutosave()
                        showResetConfirmation = true
                    }
                    .disabled(model.isBusy || model.generalSettingsSaveState.isActive)
                    Spacer()
                    autosaveStatus
                }
            }
        }
        .formStyle(.grouped)
        .disabled(model.modelDescriptionSaveInProgress)
        .confirmationDialog("macos.resetgeneralsettingstotheoperatordefaults", isPresented: $showResetConfirmation) {
            Button("macos.resetgeneralsettings", role: .destructive) {
                Task {
                    if await model.resetGeneralSettings() { didReset() }
                }
            }
        }
    }

    @ViewBuilder
    private var autosaveStatus: some View {
        switch model.generalSettingsSaveState {
        case .idle:
            Text("macos.changessaveautomatically")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .pending:
            Label("macos.waitingtosave", systemImage: "ellipsis")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .saving:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("settings.saving")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        case .saved:
            Label("macos.saved", systemImage: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .failed:
            Label("macos.couldnotsave", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
        }
    }

    private var concurrentJobsBinding: Binding<Int> {
        Binding(
            get: { draft.maxConcurrentJobs },
            set: {
                draft.maxConcurrentJobs = min(
                    snapshot.capabilities.maxConcurrentJobs,
                    max(1, $0)
                )
            }
        )
    }

    private var threadVisibilityDescription: String {
        let key = "macos.whenenablednewtasksandfreshcontextsare"
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    private func modelExpansionBinding(_ modelID: String) -> Binding<Bool> {
        Binding(
            get: { expandedModelIDs.contains(modelID) },
            set: { expanded in
                if expanded { expandedModelIDs.insert(modelID) }
                else { expandedModelIDs.remove(modelID) }
            }
        )
    }

    private func explicitBinding(_ key: String) -> Binding<Bool> {
        Binding(
            get: { draft.explicitSelectionKeys.contains(key) },
            set: { enabled in
                if enabled { draft.explicitSelectionKeys.insert(key) }
                else { draft.explicitSelectionKeys.remove(key) }
            }
        )
    }

    private var policyModeBinding: Binding<String> {
        Binding(
            get: { draft.policyMode },
            set: { mode in
                draft.policyMode = mode
                if mode == "fixed" && !selectableChoiceKeys.contains(draft.fixedSelectionKey),
                   let first = SettingsDraft.selectableChoices(
                       in: snapshot,
                       allowDelegation: draft.allowDelegation
                   ).first {
                    draft.fixedSelectionKey = first.key
                }
            }
        )
    }

    private var selectedFixedChoice: ModelChoice? {
        choices.first { $0.key == draft.fixedSelectionKey }
    }

    private var choicesForFixedModel: [ModelChoice] {
        let selectedModel = selectedFixedChoice?.model ?? modelIDs.first ?? ""
        return choices(for: selectedModel)
    }

    private var fixedModelIDBinding: Binding<String> {
        Binding(
            get: { selectedFixedChoice?.model ?? modelIDs.first ?? "" },
            set: { modelID in
                let candidates = choices(for: modelID)
                let previousEffort = selectedFixedChoice?.reasoningEffort
                let preferredEffort = modelsByID[modelID]?.defaultReasoningEffort
                let next = candidates.first {
                    $0.reasoningEffort == previousEffort && selectableChoiceKeys.contains($0.key)
                } ?? candidates.first {
                    $0.reasoningEffort == preferredEffort && selectableChoiceKeys.contains($0.key)
                } ?? candidates.first { selectableChoiceKeys.contains($0.key) }
                    ?? candidates.first
                if let next { draft.fixedSelectionKey = next.key }
            }
        )
    }

    private var fixedEffortBinding: Binding<String> {
        Binding(
            get: { selectedFixedChoice?.reasoningEffort ?? choicesForFixedModel.first?.reasoningEffort ?? "" },
            set: { effort in
                guard let modelID = selectedFixedChoice?.model ?? modelIDs.first,
                      let choice = choices(for: modelID).first(where: {
                          $0.reasoningEffort == effort
                      }) else { return }
                draft.fixedSelectionKey = choice.key
            }
        )
    }

    private func choices(for modelID: String) -> [ModelChoice] {
        choices.filter { $0.model == modelID }
    }

    private func modelLabel(_ modelID: String) -> String {
        modelsByID[modelID]?.displayName ?? modelID
    }

    private func effortLabel(_ choice: ModelChoice) -> String {
        let effort = modelsByID[choice.model]?.supportedReasoningEfforts.first {
            $0.effort == choice.reasoningEffort
        }
        let unavailable: String
        if draft.isUltraDisabled(choice) {
            unavailable = " (" + BridgeAppLocalization.string(
                "settings.ultraDisabled", locale: model.interfaceLocale
            ) + ")"
        } else if selectableChoiceKeys.contains(choice.key) {
            unavailable = ""
        } else if SettingsDraft.savedChoiceKeys(in: snapshot).contains(choice.key) {
            unavailable = BridgeAppLocalization.string(
                "macos.savedcurrentlyunavailable",
                locale: model.interfaceLocale
            )
        } else {
            unavailable = BridgeAppLocalization.string(
                "macos.currentlyunavailable",
                locale: model.interfaceLocale
            )
        }
        let label = BridgeAppLocalization.reasoningEffortLabel(
            choice.reasoningEffort,
            fallback: effort?.label,
            locale: model.interfaceLocale
        )
        return "\(label)\(unavailable)"
    }
}

private struct RuntimeStatusPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot
    private let defaultBackend = "app-server"
    @State private var maximumAccess = "read-only"
    @State private var showApplyConfirmation = false
    @State private var showForceConfirmation = false

    private var savedConfiguration: RuntimeOperatorConfiguration? {
        model.helperStatus?.configuration.operatorConfiguration
    }

    private var isDirty: Bool {
        guard let savedConfiguration else { return false }
        return maximumAccess != savedConfiguration.maximumAccess
    }

    private var canRetryWithForce: Bool {
        model.runtimeFailureCanRetryWithForce
    }

    var body: some View {
        Form {
            Section("macos.serversettings") {
                Picker("macos.maximumallowedaccess", selection: $maximumAccess) {
                    Text("macos.readonly").tag("read-only")
                    Text("macos.workspacewrite").tag("workspace-write")
                    Text("macos.fullaccess").tag("full-access")
                }
                Text("macos.thisserversafetylimitisseparatefromthe")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if maximumAccess == "full-access" {
                    Label(
                        "macos.fullaccesscanruncodexwiththismacos",
                        systemImage: "exclamationmark.shield.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                HStack {
                    Spacer()
                    if model.isBusy { ProgressView().controlSize(.small) }
                    Button("macos.applyandrestartserver") {
                        showApplyConfirmation = true
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        model.isBusy ||
                            model.generalSettingsSaveState.isActive ||
                            !isDirty
                    )
                }
            }

            if snapshot.policyActivation.developerModeRefreshRequired {
                Section("macos.actionrequired") {
                    Label(
                        "macos.executionlimitschangedrefreshtheplugininchatgpt",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }

            if !snapshot.warnings.isEmpty {
                Section("macos.needsattention") {
                    ForEach(snapshot.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .textSelection(.enabled)
                    }
                }
            }

            if let error = model.runtimeErrorMessage {
                Section("macos.applyerror") {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                    if canRetryWithForce {
                        Button("macos.forceapplyandrestart", role: .destructive) {
                            showForceConfirmation = true
                        }
                        .disabled(model.isBusy)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: synchronize)
        .onChange(of: model.helperStatus?.configuration.operatorConfiguration) { _ in
            if !isDirty { synchronize() }
        }
        .confirmationDialog(
            "macos.applyserversettingsandrestarttheserver",
            isPresented: $showApplyConfirmation
        ) {
            Button("macos.applyandrestart") {
                Task {
                    if await model.configureRuntime(
                        defaultBackend: defaultBackend,
                        maximumAccess: maximumAccess
                    ) {
                        synchronize()
                    }
                }
            }
        } message: {
            Text("macos.theappwaitsforactiveworktofinish")
        }
        .confirmationDialog(
            "macos.ignoreunverifiedbackgroundprocessesandforcearestart",
            isPresented: $showForceConfirmation
        ) {
            Button("macos.forceapplyandrestart", role: .destructive) {
                Task {
                    if await model.configureRuntime(
                        defaultBackend: defaultBackend,
                        maximumAccess: maximumAccess,
                        force: true
                    ) {
                        synchronize()
                    }
                }
            }
        } message: {
            Text("macos.runningcodextasksorbackgroundprocessesmaybe")
        }
    }

    private func synchronize() {
        guard let savedConfiguration else { return }
        maximumAccess = savedConfiguration.maximumAccess
    }
}

private struct ProjectsSettingsPane: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: SettingsSnapshot
    let usesRemotePaths: Bool
    @State private var editor: ProjectEditor?
    @State private var deletionTarget: BridgeProject?

    private var availability: [String: ProjectAvailability] {
        snapshot.capabilities.projectAvailability.reduce(into: [:]) { availability, item in
            if availability[item.projectId] == nil {
                availability[item.projectId] = item
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("settings.projects").font(.title2.bold())
                    Text(BridgeAppLocalization.string(
                        usesRemotePaths
                            ? "macos.manageprojectsontheselectedserverallpaths"
                            : "macos.manageprojectnamesandtheirlinkedexistingfolders",
                        locale: model.interfaceLocale
                    ))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    if usesRemotePaths {
                        editor = .add(name: "", cwd: "")
                    } else if let folder = chooseFolder() {
                        editor = .add(
                            name: folder.lastPathComponent,
                            cwd: folder.path
                        )
                    }
                } label: {
                    Label("macos.addproject", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
            }

            List {
                if snapshot.settings.projects.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "folder.badge.plus")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text("macos.noregisteredprojects").font(.headline)
                        Text("macos.registeratleastoneexistingfolderbeforestarting")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(30)
                }
                ForEach(snapshot.settings.projects) { project in
                    ProjectRow(
                        project: project,
                        availability: availability[project.id],
                        rename: { editor = .rename(project) },
                        relocate: {
                            if usesRemotePaths {
                                editor = .relocate(project)
                            } else if let folder = chooseFolder() {
                                Task {
                                    await model.applyProjectOperation(
                                        .relocate(projectId: project.id, cwd: folder.path)
                                    )
                                }
                            }
                        },
                        archive: {
                            Task { await model.applyProjectOperation(.archive(projectId: project.id)) }
                        },
                        restore: { editor = .restore(project) },
                        delete: { deletionTarget = project }
                    )
                }
            }
            .listStyle(.inset)

            Text("macos.removingaregistrationpreservestheactualfolderfiles")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let error = model.settingsErrorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .sheet(item: $editor) { editor in
            ProjectEditorSheet(editor: editor, usesRemotePaths: usesRemotePaths) { operation in
                let succeeded = await model.applyProjectOperation(operation)
                if succeeded { self.editor = nil }
                return succeeded
            }
        }
        .confirmationDialog(
            "macos.removethisarchivedprojectregistration",
            isPresented: Binding(
                get: { deletionTarget != nil },
                set: { if !$0 { deletionTarget = nil } }
            ),
            presenting: deletionTarget
        ) { project in
            Button("macos.removeregistration", role: .destructive) {
                Task {
                    if await model.applyProjectOperation(.delete(projectId: project.id)) {
                        deletionTarget = nil
                    }
                }
            }
        } message: { project in
            Text(BridgeAppLocalization.format(
                "macos.thefolderandexistingworkhistorywillbe",
                locale: model.interfaceLocale,
                project.name
            ))
        }
    }

    private func chooseFolder() -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = BridgeAppLocalization.string("macos.link", locale: model.interfaceLocale)
        panel.message = BridgeAppLocalization.string(
            "macos.choosethefoldertolinknofoldersor",
            locale: model.interfaceLocale
        )
        return panel.runModal() == .OK ? panel.url : nil
    }
}

private struct ProjectRow: View {
    @EnvironmentObject private var model: AppModel
    let project: BridgeProject
    let availability: ProjectAvailability?
    let rename: () -> Void
    let relocate: () -> Void
    let archive: () -> Void
    let restore: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: project.archivedAt == nil ? "folder.fill" : "archivebox.fill")
                .font(.title2)
                .foregroundStyle(availability?.available == false ? Color.orange : Color.accentColor)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(project.name).font(.headline)
                    if project.archivedAt != nil {
                        Text("settings.projectArchived").font(.caption2).padding(4).background(.quaternary, in: Capsule())
                    }
                    if availability?.available == false {
                        Label("macos.folderunavailable", systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                Text(project.cwd)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            Spacer()
            Menu {
                if project.archivedAt == nil {
                    Button("activity.rename", action: rename)
                    Button("macos.changelinkedfolder", action: relocate)
                    Divider()
                    Button("settings.archiveProject", action: archive)
                } else {
                    Button("settings.restoreProject", action: restore)
                    Divider()
                    Button("macos.removeregistration", role: .destructive, action: delete)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(model.isBusy)
        }
        .padding(.vertical, 5)
    }
}

private enum ProjectEditor: Identifiable {
    case add(name: String, cwd: String)
    case rename(BridgeProject)
    case relocate(BridgeProject)
    case restore(BridgeProject)

    var id: String {
        switch self {
        case .add: return "add"
        case .rename(let project): return "rename-\(project.id)"
        case .relocate(let project): return "relocate-\(project.id)"
        case .restore(let project): return "restore-\(project.id)"
        }
    }
}

private struct ProjectEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @EnvironmentObject private var model: AppModel
    let editor: ProjectEditor
    let usesRemotePaths: Bool
    let save: (ProjectOperation) async -> Bool
    @State private var name: String
    @State private var cwd: String
    @State private var isSaving = false

    init(
        editor: ProjectEditor,
        usesRemotePaths: Bool,
        save: @escaping (ProjectOperation) async -> Bool
    ) {
        self.editor = editor
        self.usesRemotePaths = usesRemotePaths
        self.save = save
        switch editor {
        case .add(let name, let cwd):
            _name = State(initialValue: name)
            _cwd = State(initialValue: cwd)
        case .rename(let project), .relocate(let project), .restore(let project):
            _name = State(initialValue: project.name)
            _cwd = State(initialValue: project.cwd)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title2.bold())
            TextField("macos.projectname", text: $name)
            if case .rename = editor {
                EmptyView()
            } else {
                HStack {
                    TextField(
                        BridgeAppLocalization.string(
                            usesRemotePaths ? "macos.absolutefolderpathontheserver" : "macos.folder",
                            locale: locale
                        ),
                        text: $cwd
                    )
                    .textFieldStyle(.roundedBorder)
                    if !usesRemotePaths {
                        Button("problem.selectShort") {
                            let panel = NSOpenPanel()
                            panel.canChooseFiles = false
                            panel.canChooseDirectories = true
                            panel.prompt = BridgeAppLocalization.string("macos.link", locale: locale)
                            panel.message = BridgeAppLocalization.string(
                                "macos.choosethefoldertolinknofoldersor",
                                locale: locale
                            )
                            if panel.runModal() == .OK, let url = panel.url { cwd = url.path }
                        }
                    }
                }
                if usesRemotePaths {
                    Label(
                        "macos.enteranabsolutepaththatexistsonthe",
                        systemImage: "network"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            if let error = model.settingsErrorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            HStack {
                Button("common.cancel", role: .cancel) { dismiss() }
                Spacer()
                if isSaving { ProgressView().controlSize(.small) }
                Button("macos.save") {
                    isSaving = true
                    Task {
                        if await save(operation) { dismiss() }
                        isSaving = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        requiresPath && cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        isSaving
                )
            }
        }
        .padding(20)
        .frame(width: 480)
    }

    private var title: String {
        let key: String
        switch editor {
        case .add: key = "macos.addproject"
        case .rename: key = "macos.renameproject"
        case .relocate: key = "macos.changelinkedfolder"
        case .restore: key = "macos.restoreproject"
        }
        return BridgeAppLocalization.string(key, locale: locale)
    }

    private var operation: ProjectOperation {
        switch editor {
        case .add:
            return .add(name: name, cwd: cwd)
        case .rename(let project):
            return .rename(projectId: project.id, name: name)
        case .relocate(let project):
            return .relocate(projectId: project.id, cwd: cwd)
        case .restore(let project):
            return .restore(projectId: project.id, name: name, cwd: cwd)
        }
    }

    private var requiresPath: Bool {
        if case .rename = editor { return false }
        return true
    }
}

private func accessLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "read-only": key = "macos.readonly"
    case "adaptive": key = "settings.access.adaptive"
    case "always-full": key = "macos.alwaysfullaccess"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func accessDescription(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "read-only": key = "macos.restrictseverynewtasktoreadonlyaccess"
    case "adaptive": key = "settings.access.adaptiveHint"
    case "always-full": key = "macos.appliesfullaccesstoeverynewtask"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func localeLabel(_ value: String, locale: Locale) -> String {
    switch value {
    case "auto": return BridgeAppLocalization.string("settings.language.auto", locale: locale)
    case "ko": return "한국어"
    case "en": return "English"
    case "ja": return "日本語"
    case "zh-Hans": return "简体中文"
    case "zh-Hant": return "繁體中文"
    case "es": return "Español"
    case "fr": return "Français"
    case "de": return "Deutsch"
    case "pt": return "Português"
    default: return value
    }
}

private func activityVisibilityLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "always": key = "macos.always"
    case "background-only": key = "macos.backgroundtasksonly"
    case "never": key = "macos.never"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func handoffLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "off": key = "macos.runtime.offLabel"
    case "auto-handoff": key = "macos.automaticallyhandoffoncompletion"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func phaseLabel(_ value: String?, locale: Locale) -> String {
    let key: String
    switch value {
    case "running": key = "macos.running"
    case "starting": key = "macos.starting"
    case "draining": key = "macos.waitingfortaskstofinish"
    case "stopping": key = "macos.stopping"
    case "backoff": key = "macos.waitingtorestart"
    case "safe-mode": key = "macos.safemode"
    default: key = "macos.stopped"
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

struct SkillsLibraryView: View {
    @EnvironmentObject private var model: AppModel
    let showsStandaloneWindowButton: Bool
    @State private var showingCreate = false
    @State private var showingEdit = false
    @State private var searchText = ""
    @State private var showsArchivedSkills = true
    @State private var preparingEdit = false
    @State private var editReferences: [BridgeSkillMaterialInput] = []
    @State private var restoreTarget: BridgeSkillVersionSummary?
    @State private var restoreRetry: BridgeSkillRestoreRequest?
    @State private var lifecycleRetry: BridgeSkillSetEnabledRequest?

    init(showsStandaloneWindowButton: Bool = true) {
        self.showsStandaloneWindowButton = showsStandaloneWindowButton
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("macos.skilllibrary")
                            .font(.title3.weight(.semibold))
                    }
                    Spacer()
                    if showsStandaloneWindowButton {
                        Button {
                            SkillsLibraryWindowController.shared.show(model: model)
                        } label: {
                            Label("macos.skilllibrary", systemImage: "macwindow")
                        }
                    }
                    Button("macos.newskill") { showingCreate = true }
                        .buttonStyle(.borderedProminent)
                    Button {
                        Task { await model.refreshSkillLibrary() }
                    } label: {
                        Label("macos.refresh", systemImage: "arrow.clockwise")
                    }
                }

                HStack(spacing: 10) {
                    TextField("macos.searchskills", text: $searchText)
                        .textFieldStyle(.roundedBorder)
                    Toggle("macos.showarchivedskills", isOn: $showsArchivedSkills)
                        .toggleStyle(.checkbox)
                        .font(.caption)
                }

                if let error = model.skillLibraryErrorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
                if let error = model.skillMutationErrorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }

                GroupBox("macos.bridgeskills") {
                    if let snapshot = model.skillLibrary {
                        let bridgeSkills = filteredSkills(snapshot.skills)
                        if bridgeSkills.isEmpty {
                            Text("macos.therearenobridgeownedskillsyetcreate")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(bridgeSkills) { skill in
                                    Button {
                                        Task { await model.loadBridgeSkill(skill) }
                                    } label: {
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack {
                                                Text(skill.name).fontWeight(.medium)
                                                if !skill.enabled {
                                                    Text("settings.projectArchived")
                                                        .font(.caption2.weight(.medium))
                                                        .foregroundStyle(.orange)
                                                }
                                                Spacer()
                                                Text(BridgeAppLocalization.format(
                                                    "macos.v",
                                                    locale: model.interfaceLocale,
                                                    skill.version
                                                ))
                                                    .font(.caption.monospacedDigit())
                                                    .foregroundStyle(.secondary)
                                            }
                                            Text(skill.description)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .multilineTextAlignment(.leading)
                                        }
                                        .padding(.vertical, 5)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    if skill.skillId != bridgeSkills.last?.skillId { Divider() }
                                }
                            }
                        }
                    } else {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("macos.loadingskilllibrary")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if let document = model.selectedBridgeSkill {
                    GroupBox("macos.selectedskill") {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(document.skill.name).fontWeight(.semibold)
                                    Text(BridgeAppLocalization.format(
                                        "macos.bridgeversion",
                                        locale: model.interfaceLocale,
                                        document.skill.version
                                    ))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if let history = history(for: document) {
                                    Menu {
                                        ForEach(history.versions) { version in
                                            Button {
                                                Task { await model.loadBridgeSkill(version.reference) }
                                            } label: {
                                                if version.version == document.skill.version {
                                                    Label(BridgeAppLocalization.format(
                                                        "macos.modelDescription.versionAndSource",
                                                        locale: model.interfaceLocale,
                                                        version.version,
                                                        version.createdAt
                                                    ), systemImage: "checkmark")
                                                } else {
                                                    Text(BridgeAppLocalization.format(
                                                        "macos.modelDescription.versionAndSource",
                                                        locale: model.interfaceLocale,
                                                        version.version,
                                                        version.createdAt
                                                    ))
                                                }
                                            }
                                        }
                                    } label: {
                                        Label("macos.version", systemImage: "clock.arrow.circlepath")
                                    }
                                }
                                if isCurrentVersion(document) {
                                    Button(preparingEdit ? "macos.loadingmaterials" : "macos.common.editAction") {
                                        prepareEditor(for: document)
                                    }
                                    .disabled(preparingEdit)
                                }
                            }
                            Text(document.skill.description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(document.instructions)
                                .font(.system(.body, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if !document.skill.execution.requirements.isEmpty {
                                Divider()
                                Text("macos.executionrequirements")
                                    .font(.caption.weight(.medium))
                                ForEach(document.skill.execution.requirements) { requirement in
                                    BridgeSkillRequirementRow(requirement: requirement, locale: model.interfaceLocale)
                                }
                            }
                            if !document.references.isEmpty {
                                Divider()
                                Text("macos.referencematerials")
                                    .font(.caption.weight(.medium))
                                ForEach(document.references) { reference in
                                    Button {
                                        Task { await model.loadBridgeSkillReference(reference) }
                                    } label: {
                                        HStack {
                                            Text(reference.name)
                                            Spacer()
                                            Text(BridgeAppLocalization.format(
                                                "macos.modelDescription.attachmentSize",
                                                locale: model.interfaceLocale,
                                                reference.mediaType,
                                                reference.bytes
                                            ))
                                                .foregroundStyle(.secondary)
                                        }
                                        .font(.caption)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .buttonStyle(.plain)
                                }
                                if let preview = model.selectedBridgeSkillReference,
                                   preview.skill == document.skill.reference {
                                    Divider()
                                    Text(preview.reference.name)
                                        .font(.caption.weight(.medium))
                                    Text(preview.content)
                                        .font(.system(.caption, design: .monospaced))
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                            if let history = history(for: document), !history.versions.isEmpty {
                                Divider()
                                Text("macos.versionhistory")
                                    .font(.caption.weight(.medium))
                                ForEach(history.versions) { version in
                                    HStack {
                                        Button(BridgeAppLocalization.format(
                                            "macos.v",
                                            locale: model.interfaceLocale,
                                            version.version
                                        )) {
                                            Task { await model.loadBridgeSkill(version.reference) }
                                        }
                                        .buttonStyle(.link)
                                        Text(version.createdAt)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                        Text(BridgeAppLocalization.format(
                                            "macos.materials",
                                            locale: model.interfaceLocale,
                                            version.referenceCount
                                        ))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                        Spacer()
                                        if version.version == history.currentVersion {
                                            Text("macos.current")
                                                .font(.caption.weight(.medium))
                                                .foregroundStyle(Color.accentColor)
                                        }
                                    }
                                }
                                if !isCurrentVersion(document),
                                   let selectedVersion = history.versions.first(where: { $0.version == document.skill.version }) {
                                    Button("macos.restorethisversionasthenewcurrentversion") {
                                        restoreTarget = selectedVersion
                                    }
                                }
                            }
                            if document.skill.enabled {
                                Button("macos.archiveskill", role: .destructive) {
                                    submitLifecycleChange(for: document, enabled: false)
                                }
                                .disabled(model.skillMutationInProgress)
                            } else {
                                Button("macos.reactivateskill") {
                                    submitLifecycleChange(for: document, enabled: true)
                                }
                                .disabled(model.skillMutationInProgress)
                            }
                            if !document.warnings.isEmpty {
                                Divider()
                                ForEach(document.warnings, id: \.self) { warning in
                                    Label(warning, systemImage: "exclamationmark.triangle.fill")
                                        .font(.caption)
                                        .foregroundStyle(.orange)
                                }
                            }
                        }
                    }
                }
            }
            .padding(18)
        }
        .task { await model.refreshSkillLibrary() }
        .sheet(isPresented: $showingCreate) {
            BridgeSkillEditorSheet(
                title: BridgeAppLocalization.string("macos.newbridgeskill", locale: model.interfaceLocale),
                actionLabel: BridgeAppLocalization.string("macos.create", locale: model.interfaceLocale),
                initialName: "",
                initialDescription: "",
                initialInstructions: "",
                initialReferences: [],
                initialExecutionMode: "conversation-or-codex",
                initialRequirements: [],
                isSaving: model.skillMutationInProgress
            ) { requestId, name, description, instructions, references, executionMode, requirements in
                await model.createBridgeSkill(.init(
                    requestId: requestId,
                    name: name,
                    description: description,
                    instructions: instructions,
                    references: references,
                    executionMode: executionMode,
                    requirements: requirements
                ))
            }
        }
        .sheet(isPresented: $showingEdit) {
            if let document = model.selectedBridgeSkill {
                BridgeSkillEditorSheet(
                    title: BridgeAppLocalization.string("macos.editbridgeskill", locale: model.interfaceLocale),
                    actionLabel: BridgeAppLocalization.string("macos.savenewversion", locale: model.interfaceLocale),
                    initialName: document.skill.name,
                    initialDescription: document.skill.description,
                    initialInstructions: document.instructions,
                    initialReferences: editReferences,
                    initialExecutionMode: document.skill.execution.mode,
                    initialRequirements: document.skill.execution.requirements.map {
                        .init(kind: $0.kind, id: $0.requirementId, description: $0.description)
                    },
                    isSaving: model.skillMutationInProgress
                ) { requestId, name, description, instructions, references, executionMode, requirements in
                    await model.updateBridgeSkill(.init(
                        requestId: requestId,
                        skillId: document.skill.skillId,
                        expectedVersion: managementExpectedVersion(for: document),
                        name: name,
                        description: description,
                        instructions: instructions,
                        references: references,
                        executionMode: executionMode,
                        requirements: requirements
                    ))
                }
            }
        }
        .confirmationDialog(
            "macos.restoretheselectedversionasthenewcurrent",
            isPresented: Binding(
                get: { restoreTarget != nil },
                set: { if !$0 { restoreTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("macos.restoreasnewversion") {
                guard let target = restoreTarget, let document = model.selectedBridgeSkill else { return }
                let request = restoreRequest(for: document, target: target)
                Task { @MainActor in
                    if await model.restoreBridgeSkill(request) {
                        restoreRetry = nil
                        restoreTarget = nil
                    }
                }
            }
        } message: {
            Text(BridgeAppLocalization.format(
                "macos.copiesvinstructionsandreferencematerialsintoa",
                locale: model.interfaceLocale,
                restoreTarget?.version ?? ""
            ))
        }
    }

    private func filteredSkills(_ skills: [BridgeSkillSummary]) -> [BridgeSkillSummary] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return skills.filter { skill in
            guard skill.source == "bridge", showsArchivedSkills || skill.enabled else { return false }
            guard !query.isEmpty else { return true }
            let haystack = "\(skill.name) \(skill.description)"
                .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            return haystack.contains(query)
        }
    }

    private func history(for document: BridgeSkillDocument) -> BridgeSkillVersionList? {
        guard let history = model.selectedBridgeSkillVersions,
              history.skillId == document.skill.skillId else { return nil }
        return history
    }

    private func isCurrentVersion(_ document: BridgeSkillDocument) -> Bool {
        history(for: document)?.currentVersion == document.skill.version
    }

    /** Lifecycle mutations always guard the record's actual current version. */
    private func managementExpectedVersion(for document: BridgeSkillDocument) -> String {
        history(for: document)?.currentVersion ?? document.skill.version
    }

    private func submitLifecycleChange(for document: BridgeSkillDocument, enabled: Bool) {
        let expectedVersion = managementExpectedVersion(for: document)
        let request: BridgeSkillSetEnabledRequest
        if let retry = lifecycleRetry,
           retry.skillId == document.skill.skillId,
           retry.expectedVersion == expectedVersion,
           retry.enabled == enabled {
            request = retry
        } else {
            request = .init(
                skillId: document.skill.skillId,
                expectedVersion: expectedVersion,
                enabled: enabled
            )
            lifecycleRetry = request
        }
        Task { @MainActor in
            if await model.setBridgeSkillEnabled(request) {
                lifecycleRetry = nil
            }
        }
    }

    private func restoreRequest(
        for document: BridgeSkillDocument,
        target: BridgeSkillVersionSummary
    ) -> BridgeSkillRestoreRequest {
        let expectedVersion = managementExpectedVersion(for: document)
        if let retry = restoreRetry,
           retry.skillId == document.skill.skillId,
           retry.expectedVersion == expectedVersion,
           retry.sourceVersion == target.version {
            return retry
        }
        let request = BridgeSkillRestoreRequest(
            skillId: document.skill.skillId,
            expectedVersion: expectedVersion,
            sourceVersion: target.version
        )
        restoreRetry = request
        return request
    }

    private func prepareEditor(for document: BridgeSkillDocument) {
        guard !preparingEdit else { return }
        preparingEdit = true
        Task { @MainActor in
            defer { preparingEdit = false }
            guard let references = await model.bridgeSkillMaterialInputs(for: document) else { return }
            editReferences = references
            showingEdit = true
        }
    }

}

private struct BridgeSkillRequirementRow: View {
    let requirement: BridgeSkillRequirement
    let locale: Locale

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(BridgeAppLocalization.format(
                "macos.format.dotSeparatedPair",
                locale: locale,
                requirement.kind,
                requirement.requirementId
            ))
                .font(.caption)
            if let description = requirement.description {
                Text(description)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Text(availabilityLabel)
                .font(.caption2)
                .foregroundStyle(requirement.availability == "available" ? Color.secondary : Color.orange)
        }
    }

    private var availabilityLabel: String {
        let key: String
        switch requirement.availability {
        case "available": key = "macos.capabilityrecognizedbythebridge"
        case "external-environment": key = "macos.requiresseparatepreparationintheexecutionenvironment"
        default: key = "macos.capabilityunsupportedbythebridge"
        }
        return BridgeAppLocalization.string(key, locale: locale)
    }
}

private struct BridgeSkillEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let actionLabel: String
    let isSaving: Bool
    let save: @MainActor (
        String,
        String,
        String,
        String,
        [BridgeSkillMaterialInput],
        String,
        [BridgeSkillRequirementInput]
    ) async -> Bool
    @State private var name: String
    @State private var description: String
    @State private var instructions: String
    @State private var referenceDrafts: [BridgeSkillMaterialDraft]
    @State private var executionMode: String
    @State private var requirementDrafts: [BridgeSkillRequirementDraft]
    @State private var requestId = UUID().uuidString

    init(
        title: String,
        actionLabel: String,
        initialName: String,
        initialDescription: String,
        initialInstructions: String,
        initialReferences: [BridgeSkillMaterialInput],
        initialExecutionMode: String,
        initialRequirements: [BridgeSkillRequirementInput],
        isSaving: Bool,
        save: @escaping @MainActor (
            String,
            String,
            String,
            String,
            [BridgeSkillMaterialInput],
            String,
            [BridgeSkillRequirementInput]
        ) async -> Bool
    ) {
        self.title = title
        self.actionLabel = actionLabel
        self.isSaving = isSaving
        self.save = save
        _name = State(initialValue: initialName)
        _description = State(initialValue: initialDescription)
        _instructions = State(initialValue: initialInstructions)
        _referenceDrafts = State(initialValue: initialReferences.map(BridgeSkillMaterialDraft.init))
        _executionMode = State(initialValue: initialExecutionMode)
        _requirementDrafts = State(initialValue: initialRequirements.map(BridgeSkillRequirementDraft.init))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("macos.name", text: $name)
                    TextField("settings.modelDescriptions.label", text: $description, axis: .vertical)
                        .lineLimit(2...4)
                    Picker("macos.useroute", selection: $executionMode) {
                        Text("macos.conversationorcodex").tag("conversation-or-codex")
                        Text("macos.conversationonly").tag("conversation")
                        Text("macos.codexonly").tag("codex")
                    }
                    Text("macos.instructions")
                        .font(.caption.weight(.medium))
                    TextEditor(text: $instructions)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 190)
                        .overlay {
                            RoundedRectangle(cornerRadius: 5)
                                .stroke(Color.secondary.opacity(0.25))
                        }

                    Divider()
                    HStack {
                        Text("macos.referencematerials").font(.caption.weight(.medium))
                        Spacer()
                        Button("macos.add") {
                            referenceDrafts.append(.init())
                        }
                    }
                    ForEach($referenceDrafts) { $reference in
                        GroupBox {
                            VStack(alignment: .leading, spacing: 8) {
                                TextField("macos.materialname", text: $reference.name)
                                TextField("macos.mimetype", text: $reference.mediaType)
                                TextEditor(text: $reference.content)
                                    .font(.system(.caption, design: .monospaced))
                                    .frame(minHeight: 100)
                                HStack {
                                    Spacer()
                                    Button("settings.removeProject", role: .destructive) {
                                        referenceDrafts.removeAll { $0.id == reference.id }
                                    }
                                }
                            }
                        }
                    }

                    Divider()
                    HStack {
                        Text("macos.executionrequirements").font(.caption.weight(.medium))
                        Spacer()
                        Button("macos.add") {
                            requirementDrafts.append(.init())
                        }
                    }
                    Text("macos.thebridgerecognizesonlyconversationcodextaskand")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    ForEach($requirementDrafts) { $requirement in
                        GroupBox {
                            VStack(alignment: .leading, spacing: 8) {
                                Picker("macos.type", selection: $requirement.kind) {
                                    Text("macos.bridgecapability").tag("bridge-capability")
                                    Text("macos.externalenvironment").tag("environment")
                                }
                                TextField("macos.capabilityorenvironmentname", text: $requirement.requirementId)
                                TextField("macos.descriptionoptional", text: $requirement.description)
                                HStack {
                                    Spacer()
                                    Button("settings.removeProject", role: .destructive) {
                                        requirementDrafts.removeAll { $0.id == requirement.id }
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            HStack {
                Button("common.cancel", role: .cancel) { dismiss() }
                Spacer()
                if isSaving { ProgressView().controlSize(.small) }
                Button(actionLabel) {
                    Task { @MainActor in
                        if await save(
                            requestId,
                            name,
                            description,
                            instructions,
                            referenceDrafts.map(\.input),
                            executionMode,
                            requirementDrafts.map(\.input)
                        ) { dismiss() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSave || isSaving)
            }
        }
        .padding(20)
        .frame(width: 680, height: 760)
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            referenceDrafts.allSatisfy {
                !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                    !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            } &&
            requirementDrafts.allSatisfy {
                !$0.requirementId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
    }
}

private struct BridgeSkillMaterialDraft: Identifiable {
    let id = UUID()
    var name: String
    var content: String
    var mediaType: String

    init() {
        name = ""
        content = ""
        mediaType = "text/plain"
    }

    init(_ input: BridgeSkillMaterialInput) {
        name = input.name
        content = input.content
        mediaType = input.mediaType ?? "text/plain"
    }

    var input: BridgeSkillMaterialInput {
        .init(
            name: name,
            content: content,
            mediaType: mediaType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : mediaType
        )
    }
}

private struct BridgeSkillRequirementDraft: Identifiable {
    let id = UUID()
    var kind: String
    var requirementId: String
    var description: String

    init() {
        kind = "environment"
        requirementId = ""
        description = ""
    }

    init(_ input: BridgeSkillRequirementInput) {
        kind = input.kind
        requirementId = input.requirementId
        description = input.description ?? ""
    }

    var input: BridgeSkillRequirementInput {
        .init(
            kind: kind,
            id: requirementId,
            description: description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : description
        )
    }
}
