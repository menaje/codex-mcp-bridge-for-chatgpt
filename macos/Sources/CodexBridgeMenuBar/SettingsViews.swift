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
    @State private var selectedTab = "general"

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                BridgeBrandStatusIcon(health: model.health, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Codex MCP Bridge for ChatGPT")
                        .font(.headline)
                    HStack(spacing: 5) {
                        Image(systemName: model.isRemoteClient ? "network" : "desktopcomputer")
                        Text(model.connectionTargetName)
                        Text(BridgeAppLocalization.string(
                            model.isRemoteClient ? "· 원격 서버 설정" : "· 이 Mac의 서버 설정",
                            locale: model.interfaceLocale
                        ))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    if model.health == .checking {
                        Text("브리지 연결을 확인하고 있습니다…")
                            .font(.caption2)
                            .foregroundStyle(.blue)
                    }
                }
                Spacer()
            }
            if syncState.externalChangeDetected {
                HStack(spacing: 10) {
                    Label(
                        "다른 화면에서 설정이 변경되어 자동 저장을 멈췄습니다. 편집 내용을 유지하려면 확인한 뒤 최신 값을 다시 불러와 주세요.",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                    Spacer()
                    Button("최신 값 불러오기…") {
                        showDiscardDraftConfirmation = true
                    }
                }
            }
            TabView(selection: $selectedTab) {
                ConnectionSettingsPane()
                    .environmentObject(model)
                    .tabItem { Label("연결", systemImage: "network") }
                    .tag("connection")

                if !model.isRemoteClient {
                    CodexRuntimeSettingsPane(isSelected: selectedTab == "codex")
                        .environmentObject(model)
                        .tabItem { Label("Codex", systemImage: "terminal") }
                        .tag("codex")
                }

                if model.needsSetup {
                    ConnectionRepairView()
                        .tabItem { Label("서버", systemImage: "wrench.and.screwdriver") }
                        .tag("general")
                } else if let snapshot = model.settings, let draft = syncState.draft {
                    GeneralSettingsPane(
                        snapshot: snapshot,
                        draft: binding(for: draft),
                        didReset: {
                            synchronizeDraft(force: true)
                            model.restorePersistedInterfaceLocale()
                        }
                    )
                        .environmentObject(model)
                        .tabItem { Label("일반", systemImage: "gearshape") }
                        .tag("general")
                    ProjectsSettingsPane(snapshot: snapshot, usesRemotePaths: model.isRemoteClient)
                        .environmentObject(model)
                        .tabItem { Label("프로젝트", systemImage: "folder") }
                        .tag("projects")
                    if !model.isRemoteClient {
                        RuntimeStatusPane(snapshot: snapshot)
                            .environmentObject(model)
                            .tabItem { Label("서버", systemImage: "server.rack") }
                            .tag("server")
                    }
                } else {
                    SettingsConnectionUnavailablePane()
                        .environmentObject(model)
                        .tabItem { Label("서버 설정", systemImage: "gearshape") }
                        .tag("general")
                }
            }
        }
        .padding(18)
        .environment(\.locale, model.interfaceLocale)
        .onAppear {
            synchronizeDraft()
            if let target = model.requestedSettingsTab { selectedTab = target; model.requestedSettingsTab = nil }
            else if model.settings == nil { selectedTab = "connection" }
        }
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
        }
        .alert("설정 충돌", isPresented: Binding(
            get: { model.settingsConflictMessage != nil },
            set: { if !$0 { model.settingsConflictMessage = nil } }
        )) {
            Button("확인", role: .cancel) {}
        } message: {
            Text(model.settingsConflictMessage ?? "")
        }
        .confirmationDialog(
            "현재 편집 내용을 버리고 최신 설정을 불러올까요?",
            isPresented: $showDiscardDraftConfirmation
        ) {
            Button("편집 내용 버리기", role: .destructive) {
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
            Section("앱 역할") {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: model.isRemoteClient ? "network" : "desktopcomputer")
                        .font(.title2)
                        .foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(BridgeAppLocalization.string(
                            model.isRemoteClient ? "기존 서버에 연결" : "이 Mac에서 서버 실행",
                            locale: model.interfaceLocale
                        ))
                            .font(.headline)
                        Text(BridgeAppLocalization.string(
                            model.isRemoteClient
                                ? "이 앱은 선택한 서버의 현황과 설정만 사용하며, 이 Mac에서 helper·Bridge·Tunnel·Codex를 시작하지 않습니다."
                                : "이 Mac이 helper·Bridge·Tunnel·Codex runtime을 소유하고 실행합니다.",
                            locale: model.interfaceLocale
                        ))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.isRemoteClient {
                        Button("이 Mac에서 실행") {
                            Task { await model.setConnectionMode(.localHost) }
                        }
                    } else {
                        Button("기존 서버에 연결…") {
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

            Section("이 Mac의 앱 설정") {
                Toggle("브리지 문제 발생 시 알림", isOn: $model.bridgeProblemNotificationsEnabled)
                Toggle("보안 및 연결 승인 알림", isOn: $model.securityNotificationsEnabled)
                Button("macOS 알림 허용 확인") {
                    Task { await model.requestNotificationAuthorization() }
                }
                Text("알림은 macOS 알림 설정과 집중 모드를 따릅니다. 알림을 꺼도 메뉴바에서 연결 문제를 확인할 수 있습니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Toggle(
                    "로그인 시 메뉴 막대 앱 실행",
                    isOn: Binding(
                        get: { model.menuBarLoginItemStatus.isEnabled },
                        set: { model.setMenuBarLaunchAtLogin($0) }
                    )
                )
                .disabled(model.loginItemOperationInProgress)

                Text(BridgeAppLocalization.string(
                    model.isRemoteClient
                        ? "이 앱은 선택한 서버의 현황과 설정만 사용하며, 이 Mac에서 helper·Bridge·Tunnel·Codex를 시작하지 않습니다."
                        : "이 Mac에만 즉시 적용됩니다. 이 설정을 꺼도 ChatGPT 연결을 위한 브리지 helper와 서버는 백그라운드에서 계속 실행됩니다.",
                    locale: model.interfaceLocale
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                switch model.menuBarLoginItemStatus {
                case .enabled:
                    Label("다음 사용자 로그인부터 메뉴 막대 앱이 자동으로 열립니다.", systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case .requiresApproval:
                    Label("macOS에서 로그인 항목 실행 승인이 필요합니다.", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                    Button("로그인 항목 설정 열기") {
                        model.openLoginItemsSystemSettings()
                    }
                case .notFound:
                    Label("설치된 앱 번들에서 로그인 항목을 찾지 못했습니다.", systemImage: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                case .unknown:
                    Label("로그인 항목 상태를 확인할 수 없습니다.", systemImage: "questionmark.circle")
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
        .onAppear {
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
            "원격 클라이언트 모드로 전환할까요?",
            isPresented: $showRemoteModeConfirmation
        ) {
            Button("작업을 마치고 원격 모드로 전환") {
                Task { await model.setConnectionMode(.remoteClient) }
            }
            Button("강제로 중지하고 전환", role: .destructive) {
                Task { await model.setConnectionMode(.remoteClient, force: true) }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("이 Mac이 실행 중인 서버와 Tunnel을 먼저 종료합니다. 원격 모드에서는 앱을 종료해도 선택한 원격 서버를 중지하지 않습니다.")
        }
        .confirmationDialog(
            "다른 Mac 연결을 끌까요?",
            isPresented: $showDisableRemoteConnectionConfirmation
        ) {
            Button("다른 Mac 연결 끄기", role: .destructive) {
                Task {
                    await model.configureRemoteManagement(
                        enabled: false,
                        endpoint: hostedEndpoint,
                        displayName: hostedDisplayName
                    )
                }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("등록된 기기는 유지되지만 다시 켤 때까지 이 서버에 연결할 수 없습니다.")
        }
        .confirmationDialog(
            "저장된 서버를 이 Mac에서 삭제할까요?",
            isPresented: Binding(
                get: { profileDeletionTarget != nil },
                set: { if !$0 { profileDeletionTarget = nil } }
            ),
            presenting: profileDeletionTarget
        ) { profile in
            Button("서버 프로필 및 자격 증명 삭제", role: .destructive) {
                Task {
                    if await model.removeRemoteServer(profile.serverId) {
                        profileDeletionTarget = nil
                    }
                }
            }
        } message: { profile in
            Text("‘\(profile.name)’ 서버 자체와 다른 기기의 등록은 변경하지 않습니다.")
        }
        .confirmationDialog(
            "이 기기의 원격 접속 권한을 폐기할까요?",
            isPresented: Binding(
                get: { deviceRevocationTarget != nil },
                set: { if !$0 { deviceRevocationTarget = nil } }
            ),
            presenting: deviceRevocationTarget
        ) { device in
            Button("접속 권한 폐기", role: .destructive) {
                Task {
                    if await model.revokeRemoteDevice(device.id) {
                        deviceRevocationTarget = nil
                    }
                }
            }
        } message: { device in
            Text("‘\(device.name)’의 자격 증명은 즉시 더 이상 사용할 수 없습니다.")
        }
    }

    @ViewBuilder
    private var remoteClientSections: some View {
        Section("활성 서버") {
            if model.connectionPreferences.profiles.isEmpty {
                Label("저장된 서버가 없습니다. 아래 페어링 초대를 입력해 첫 서버를 등록하세요.", systemImage: "server.rack")
                    .foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("새 서버 페어링") {
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
                                    Text("활성").font(.caption2).padding(4).background(.quaternary, in: Capsule())
                                }
                            }
                            Text(profile.endpoint)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                            Text("서버 ID \(profile.serverId)")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        if profile.serverId != model.connectionPreferences.activeServerId {
                            Button("전환") {
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
                    Button("새 서버 페어링") {
                        showRemoteConnectionSheet = true
                    }
                    .disabled(model.isBusy)
                }
            }
            if let profile = model.activeRemoteProfile {
                HStack {
                    TextField("활성 서버 표시 이름", text: $activeProfileName)
                    Button("이름 저장") {
                        _ = model.renameRemoteServer(profile.serverId, name: activeProfileName)
                    }
                    .disabled(activeProfileName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if let hello = model.remoteHello {
                Label(
                    "\(hello.server.displayName) · Bridge \(hello.bridge.version) · 연결됨",
                    systemImage: "checkmark.circle.fill"
                )
                .foregroundStyle(.green)
            } else if model.activeRemoteProfile != nil {
                Label("선택한 서버에 연결되지 않았습니다.", systemImage: "network.slash")
                    .foregroundStyle(.orange)
                Button("다시 연결") { Task { await model.refreshAll() } }
            }
        }

        if let error = model.connectionErrorMessage {
            Section("연결 오류") {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private var hostedServerSections: some View {
        Section("다른 Mac에서 이 서버 관리") {
            Text("이 Mac의 이름과 접속 주소를 자동으로 사용합니다. 연결할 기기에 전달할 것은 아래에서 만드는 페어링 초대뿐입니다.")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("다른 기기에 표시할 서버 이름", text: $hostedDisplayName)
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
                    Button("연결 끄기…", role: .destructive) {
                        showDisableRemoteConnectionConfirmation = true
                    }
                    .disabled(model.isBusy)
                }
            }
            FullRowDisclosure(
                "고급 연결 설정",
                isExpanded: $advancedConnectionSettingsExpanded
            ) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("자동 감지한 주소입니다. 다른 사설 DNS 또는 VPN 주소를 사용해야 할 때만 변경하세요.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text("HTTPS 주소")
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
                            Text("서버 ID: \(status.serverId)")
                            if let fingerprint = status.certificateSha256 {
                                Text("인증서 SHA-256: \(fingerprint)")
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
            Section("기기 페어링") {
                Text("클라이언트 Mac의 연결 화면에 붙여넣을 1회용 초대를 만듭니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("5분 동안 유효한 새 페어링 초대 만들고 복사") {
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
                        Label("페어링 초대를 클립보드에 복사했습니다.", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                    HStack {
                        Text("\(DisplayFormat.dateTime(pairing.expiresAt, locale: model.interfaceLocale))까지 1회만 사용할 수 있습니다.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("초대 복사") {
                            copyToPasteboard(pairing.invitation)
                            pairingInvitationCopied = true
                        }
                    }
                }
            }

            Section("등록된 기기") {
                if model.remoteManagementStatus?.devices.isEmpty != false {
                    Text("등록된 원격 기기가 없습니다.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.remoteManagementStatus?.devices ?? []) { device in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.name).font(.headline)
                            Text(device.lastSeenAt.map {
                                BridgeAppLocalization.format(
                                    "마지막 접속 %@",
                                    locale: model.interfaceLocale,
                                    $0
                                )
                            } ?? BridgeAppLocalization.string(
                                "아직 접속하지 않음",
                                locale: model.interfaceLocale
                            ))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("폐기…", role: .destructive) {
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
                "연결 받을 준비됨",
                locale: model.interfaceLocale
            )
        }
        if status.enabled {
            return BridgeAppLocalization.string("시작 실패", locale: model.interfaceLocale)
        }
        return BridgeAppLocalization.string("꺼짐", locale: model.interfaceLocale)
    }

    private var remoteManagementActionTitle: String {
        if model.remoteManagementStatus?.listening == true {
            return BridgeAppLocalization.string("설정 저장", locale: model.interfaceLocale)
        }
        if model.remoteManagementStatus?.enabled == true {
            return BridgeAppLocalization.string("다시 시작", locale: model.interfaceLocale)
        }
        return BridgeAppLocalization.string("다른 Mac 연결 켜기", locale: model.interfaceLocale)
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
                    Text(model.isRemoteClient ? "새 서버 페어링" : "기존 서버에 연결")
                        .font(.title2.bold())
                    Text("서버에서 복사한 페어링 초대 하나로 주소와 보안 정보를 함께 확인합니다.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(20)

            Divider()

            Form {
                if !model.isRemoteClient, !model.connectionPreferences.profiles.isEmpty {
                    Section("저장된 서버 사용") {
                        Picker("서버", selection: $selectedServerId) {
                            ForEach(model.connectionPreferences.profiles) { profile in
                                Text(profile.name).tag(profile.serverId)
                            }
                        }
                        HStack {
                            Spacer()
                            Button("선택한 서버로 연결") {
                                if model.prepareRemoteServerForModeSwitch(selectedServerId) {
                                    onComplete(true)
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(selectedServerId.isEmpty || model.isBusy)
                        }
                    }
                }

                Section("새 서버 페어링") {
                    Text("서버 Mac에서 ‘새 페어링 초대 만들고 복사’를 누른 뒤 여기에 붙여넣으세요.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $invitation)
                        .font(.caption.monospaced())
                        .frame(minHeight: 76)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                    HStack {
                        Button("클립보드에서 붙여넣기") {
                            if let copied = NSPasteboard.general.string(forType: .string) {
                                invitation = copied.trimmingCharacters(in: .whitespacesAndNewlines)
                            }
                        }
                        Spacer()
                    }
                    TextField("서버에 표시할 이 기기 이름", text: $deviceName)
                    FullRowDisclosure("선택 사항", isExpanded: $optionalFieldsExpanded) {
                        TextField("저장할 서버 이름(선택)", text: $profileName)
                    }
                    HStack {
                        Spacer()
                        Button(model.isRemoteClient ? "페어링하고 활성화" : "서버 확인 및 등록") {
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
                    Text("기기 자격 증명은 macOS Keychain에만 저장됩니다. 서버 주소나 프로필에는 비밀값이 포함되지 않습니다.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if let error = model.connectionErrorMessage {
                    Section("연결 오류") {
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
                Button("취소") { onComplete(false) }
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
            BridgeBrandStatusIcon(
                health: model.isBridgeConnectionChecking ? .checking : .unavailable,
                size: 52
            )
            if !model.bridgeConnected, model.isBridgeConnectionChecking {
                ProgressView()
                Text("브리지 연결을 확인하고 있습니다…")
                    .font(.headline)
                Text("연결되는 대로 현황을 표시합니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if model.isRemoteClient {
                if model.activeRemoteProfile == nil {
                    Text("연결 탭에서 서버를 페어링해 주세요.")
                        .font(.headline)
                    Text("원격 모드에서는 이 Mac의 helper나 Codex runtime을 시작하지 않습니다.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("원격 서버 설정을 불러오지 못했습니다.")
                        .font(.headline)
                    if let error = model.connectionErrorMessage ??
                        model.statusErrorMessage ?? model.settingsLoadErrorMessage {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                    Button("다시 연결") { Task { await model.refreshAll() } }
                        .buttonStyle(.borderedProminent)
                }
            } else if !model.bridgeConnected {
                Text("설정을 불러오려면 이 Mac의 브리지 서버를 시작해 주세요.")
                Button("서버 시작") { Task { await model.startRuntime() } }
                    .buttonStyle(.borderedProminent)
                if let error = model.runtimeErrorMessage ?? model.statusErrorMessage {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            } else if let error = model.settingsLoadErrorMessage {
                Text("설정을 불러오지 못했습니다.").font(.headline)
                Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                Button("다시 시도") { Task { await model.refreshSettings() } }
            } else {
                ProgressView("설정을 불러오는 중…")
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
                    "이 설정은 이 브리지 연결을 사용하는 모든 대화에 공유됩니다.",
                    systemImage: "person.2"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Section("접근 권한") {
                Picker("접근 전략", selection: $draft.accessStrategy) {
                    ForEach(snapshot.capabilities.availableAccessStrategies, id: \.self) {
                        Text(accessLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                Text(accessDescription(draft.accessStrategy, locale: model.interfaceLocale))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("각 작업이 요청할 기본 권한입니다. 서버 탭의 최대 접근 권한을 넘을 수 없습니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if draft.accessStrategy == "always-full" {
                    Label(
                        BridgeAppLocalization.string(
                            snapshot.capabilities.allowDangerFullAccess
                                ? "전체 접근은 이 macOS 사용자의 파일시스템과 네트워크 권한으로 Codex를 실행합니다."
                                : "전체 접근 선택은 보존되어 있지만 현재 최대 접근 권한이 제한되어 읽기 전용으로 실행됩니다. 서버 탭에서 최대 권한을 변경할 수 있습니다.",
                            locale: model.interfaceLocale
                        ),
                        systemImage: "exclamationmark.shield.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }

            Section("모델 정책") {
                Picker("선택 방식", selection: policyModeBinding) {
                    Text("고정").tag("fixed")
                    Text("자동").tag("automatic")
                }
                .pickerStyle(.segmented)

                if draft.policyMode == "fixed" {
                    Picker("모델", selection: fixedModelIDBinding) {
                        ForEach(modelIDs, id: \.self) { modelID in
                            Text(modelLabel(modelID)).tag(modelID)
                        }
                    }
                    Picker("추론 수준", selection: fixedEffortBinding) {
                        ForEach(choicesForFixedModel, id: \.key) { choice in
                            Text(effortLabel(choice)).tag(choice.reasoningEffort)
                        }
                    }
                } else {
                    Picker("자동 허용 범위", selection: $draft.allowedKind) {
                        Text("표시되는 전체 카탈로그").tag("catalog-visible")
                        Text("명시적으로 선택").tag("explicit")
                    }
                    if draft.allowedKind == "explicit" {
                        FullRowDisclosure(
                            "허용 모델과 추론 수준",
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
                                                        !selectableChoiceKeys.contains(choice.key) &&
                                                        !draft.explicitSelectionKeys.contains(choice.key)
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
                    "Ultra 추론 및 하위 에이전트 위임 허용",
                    isOn: $draft.allowDelegation
                )
                Text("끄면 Ultra 추론이 모델 목록에서 제외되고 하위 에이전트 위임이 차단됩니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Toggle("빠른 처리 우선 사용", isOn: $draft.usePriorityServiceTier)
                Text("지원되는 모델에서 Priority/Fast 처리 계층을 요청합니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if snapshot.catalog.stale {
                    Label("모델 카탈로그가 오래되어 정책 저장이 제한될 수 있습니다.", systemImage: "clock.badge.exclamationmark")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let warning = snapshot.catalog.warning {
                    Text(warning)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                }
                Button("모델 목록 새로고침") {
                    Task { await model.refreshSettings(refreshModels: true) }
                }
                .disabled(model.generalSettingsSaveState.isActive)
            }

            Section("표시와 실행") {
                Picker("앱 및 카드 언어", selection: $draft.uiLocalePreference) {
                    ForEach(snapshot.capabilities.availableUiLocalePreferences, id: \.self) {
                        Text(localeLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                Text("자동을 선택하면 macOS 앱은 Mac의 언어를, GPT 카드는 ChatGPT의 표시 언어를 따릅니다. 두 화면의 언어가 다를 수 있습니다. 언어를 직접 선택하면 앱과 GPT 카드에 동일하게 적용됩니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                LabeledContent("동시 실행 에이전트 작업 수") {
                    HStack(spacing: 6) {
                        TextField(value: concurrentJobsBinding, format: .number) {
                            EmptyView()
                        }
                        .frame(width: 46)
                        .multilineTextAlignment(.trailing)
                        .textFieldStyle(.roundedBorder)
                        Stepper(
                            "",
                            value: concurrentJobsBinding,
                            in: 1...snapshot.capabilities.maxConcurrentJobs
                        )
                        .labelsHidden()
                    }
                }
                Text(BridgeAppLocalization.format(
                    "1부터 운영 한도 %d까지 직접 입력할 수 있습니다. 등록된 에이전트 수가 아니라 동시에 실행할 작업의 상한입니다.",
                    locale: model.interfaceLocale,
                    snapshot.capabilities.maxConcurrentJobs
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if draft.maxConcurrentJobs > 30 {
                    Label(
                        "30을 넘기면 CPU·메모리·API 사용량이 크게 증가할 수 있습니다.",
                        systemImage: "gauge.with.dots.needle.67percent"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                Toggle("새 Agent 작업을 Codex 앱에 보존", isOn: $draft.showBridgeThreadsInCodexApp)
                Text(threadVisibilityDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Picker("액티비티 카드 표시", selection: activityCardVisibilityBinding) {
                    ForEach(snapshot.capabilities.availableActivityCardVisibilities, id: \.self) {
                        Text(activityVisibilityLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                Picker("완료 후 ChatGPT에 넘기기", selection: $draft.completionHandoff) {
                    ForEach(snapshot.capabilities.availableCompletionHandoffs, id: \.self) {
                        Text(handoffLabel($0, locale: model.interfaceLocale)).tag($0)
                    }
                }
                .disabled(draft.activityCardVisibility == "never")
                if draft.activityCardVisibility == "never" {
                    Text("자동으로 넘기려면 액티비티 카드가 표시되어야 합니다.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let error = model.settingsErrorMessage ?? model.settingsLoadErrorMessage {
                Section("저장하지 못한 이유") {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }

            Section {
                HStack {
                    Button("일반 설정 초기화…", role: .destructive) {
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
        .confirmationDialog("일반 설정을 운영자 기본값으로 되돌릴까요?", isPresented: $showResetConfirmation) {
            Button("일반 설정 초기화", role: .destructive) {
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
            Text("변경사항 자동 저장")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .pending:
            Label("저장 대기 중…", systemImage: "ellipsis")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .saving:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("저장 중…")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        case .saved:
            Label("저장됨", systemImage: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .failed:
            Label("저장하지 못함", systemImage: "exclamationmark.triangle.fill")
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
        let key: String
        if snapshot.capabilities.defaultBackend == "app-server" {
            key = "켜면 이후 새 작업과 새 컨텍스트를 영구 스레드로 저장하고 현황에서 Codex 대화를 열 수 있습니다. 기존 임시 작업에는 소급 적용되지 않습니다. 끄면 임시 스레드로 실행되어 서버 재시작 뒤 이어갈 수 없습니다."
        } else {
            key = "MCP Server에서는 이 설정으로 Codex 앱 연결 여부를 바꿀 수 없습니다. App Server로 전환한 뒤 만드는 새 작업과 새 컨텍스트부터 적용됩니다."
        }
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

    private var activityCardVisibilityBinding: Binding<String> {
        Binding(
            get: { draft.activityCardVisibility },
            set: { draft.setActivityCardVisibility($0) }
        )
    }

    private func modelLabel(_ modelID: String) -> String {
        modelsByID[modelID]?.displayName ?? modelID
    }

    private func effortLabel(_ choice: ModelChoice) -> String {
        let effort = modelsByID[choice.model]?.supportedReasoningEfforts.first {
            $0.effort == choice.reasoningEffort
        }
        let unavailable: String
        if selectableChoiceKeys.contains(choice.key) {
            unavailable = ""
        } else if SettingsDraft.savedChoiceKeys(in: snapshot).contains(choice.key) {
            unavailable = BridgeAppLocalization.string(
                " (저장됨 · 현재 선택 불가)",
                locale: model.interfaceLocale
            )
        } else {
            unavailable = BridgeAppLocalization.string(
                " (현재 선택 불가)",
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
    @State private var defaultBackend = "mcp-server"
    @State private var maximumAccess = "read-only"
    @State private var showApplyConfirmation = false
    @State private var showForceConfirmation = false
    @State private var backendTransitionDetailsExpanded = false

    private var savedConfiguration: RuntimeOperatorConfiguration? {
        model.helperStatus?.configuration.operatorConfiguration
    }

    private var isDirty: Bool {
        guard let savedConfiguration else { return false }
        return defaultBackend != savedConfiguration.defaultBackend ||
            maximumAccess != savedConfiguration.maximumAccess
    }

    private var nonRoutingWarnings: [String] {
        snapshot.warnings.filter { warning in
            !warning.localizedCaseInsensitiveContains("Backend routing:") &&
                !warning.contains("백엔드 라우팅:")
        }
    }

    private var canRetryWithForce: Bool {
        model.runtimeFailureCanRetryWithForce
    }

    private var backendDescription: String {
        let key: String
        if defaultBackend == "codex-sdk" {
            key = "SDK와 전용 Python·Codex를 한 묶음으로 설치합니다. 기존 CLI 선택은 유지됩니다."
        } else if defaultBackend == "app-server" {
            key = "실험적 방식입니다. 스레드와 백그라운드 프로세스를 더 세밀하게 제어하고 Codex 앱에 표시되지 않는 임시 스레드를 지원합니다."
        } else {
            key = "안정적인 기본 방식입니다. 호환성과 복구 안정성을 우선하며 일부 스레드·백그라운드 프로세스 제어는 제한됩니다."
        }
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    var body: some View {
        Form {
            Section("서버 설정") {
                Picker("Codex 실행 백엔드", selection: $defaultBackend) {
                    Text("App Server").tag("app-server")
                    Text("MCP Server").tag("mcp-server")
                    Text("Python SDK · 실험적").tag("codex-sdk")
                        .disabled(model.sdkRuntime?.selection?.available != true)
                }
                Text(backendDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                FullRowDisclosure(
                    "백엔드 전환 시 알아둘 점",
                    isExpanded: $backendTransitionDetailsExpanded
                ) {
                    Text("변경 사항은 서버를 재시작한 뒤 새 에이전트 또는 새로 시작한 에이전트부터 적용됩니다. 기존 에이전트는 생성 당시 백엔드를 계속 사용하며, 다른 백엔드로 새로 시작할 때는 이전 작업을 요약해 전달해야 합니다.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 3)
                }
                Picker("허용할 최대 접근 권한", selection: $maximumAccess) {
                    Text("읽기 전용").tag("read-only")
                    Text("작업 폴더 쓰기").tag("workspace-write")
                    Text("전체 접근").tag("full-access")
                }
                Text("일반 탭의 접근 전략과 별개인 서버 안전 상한입니다. 어떤 작업도 이 권한을 넘을 수 없습니다. 변경하면 진행 중인 작업을 안전하게 비운 뒤 서버가 재시작됩니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if maximumAccess == "full-access" {
                    Label(
                        "전체 접근은 이 macOS 사용자의 파일시스템과 네트워크 권한으로 Codex를 실행할 수 있게 합니다.",
                        systemImage: "exclamationmark.shield.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                HStack {
                    Spacer()
                    if model.isBusy { ProgressView().controlSize(.small) }
                    Button("저장하고 서버 재시작…") {
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
                Section("필요한 조치") {
                    Label(
                        "실행 한도가 바뀌었습니다. ChatGPT 개발자 모드에서 플러그인을 새로고침해 주세요.",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }

            if !nonRoutingWarnings.isEmpty {
                Section("확인할 사항") {
                    ForEach(nonRoutingWarnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .textSelection(.enabled)
                    }
                }
            }

            if let error = model.runtimeErrorMessage {
                Section("적용하지 못한 이유") {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                    if canRetryWithForce {
                        Button("강제로 저장하고 재시작…", role: .destructive) {
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
            "런타임 설정을 저장하고 서버를 재시작할까요?",
            isPresented: $showApplyConfirmation
        ) {
            Button("저장하고 재시작") {
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
            Text("진행 중인 작업이 있으면 완료될 때까지 기다린 뒤 적용합니다.")
        }
        .confirmationDialog(
            "확인할 수 없는 백그라운드 프로세스를 무시하고 강제로 재시작할까요?",
            isPresented: $showForceConfirmation
        ) {
            Button("강제로 저장하고 재시작", role: .destructive) {
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
            Text("실제로 실행 중인 Codex 작업이나 백그라운드 프로세스가 있으면 중단될 수 있습니다.")
        }
    }

    private func synchronize() {
        guard let savedConfiguration else { return }
        defaultBackend = savedConfiguration.defaultBackend
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
                    Text("프로젝트").font(.title2.bold())
                    Text(BridgeAppLocalization.string(
                        usesRemotePaths
                            ? "선택한 서버의 프로젝트를 관리합니다. 모든 경로는 원격 서버 호스트의 파일시스템 기준입니다."
                            : "프로젝트 이름과 연결할 기존 폴더를 관리합니다. 앱은 실제 폴더나 파일을 이동하지 않습니다.",
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
                    Label("프로젝트 추가", systemImage: "plus")
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
                        Text("등록된 프로젝트 없음").font(.headline)
                        Text("Codex 작업을 시작하려면 기존 폴더를 하나 이상 등록하세요.")
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

            Text("등록을 삭제해도 실제 폴더·파일과 기존 작업 기록은 그대로 유지됩니다.")
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
            "보관된 프로젝트 등록을 삭제할까요?",
            isPresented: Binding(
                get: { deletionTarget != nil },
                set: { if !$0 { deletionTarget = nil } }
            ),
            presenting: deletionTarget
        ) { project in
            Button("등록 삭제", role: .destructive) {
                Task {
                    if await model.applyProjectOperation(.delete(projectId: project.id)) {
                        deletionTarget = nil
                    }
                }
            }
        } message: { project in
            Text(BridgeAppLocalization.format(
                "‘%@’ 폴더와 기존 작업 기록은 그대로 유지됩니다.",
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
        panel.prompt = BridgeAppLocalization.string("연결", locale: model.interfaceLocale)
        panel.message = BridgeAppLocalization.string(
            "연결할 폴더를 선택합니다. 실제 폴더나 파일은 이동하지 않습니다.",
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
                        Text("보관됨").font(.caption2).padding(4).background(.quaternary, in: Capsule())
                    }
                    if availability?.available == false {
                        Label("폴더 사용 불가", systemImage: "exclamationmark.triangle")
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
                    Button("이름 변경…", action: rename)
                    Button("연결 폴더 변경…", action: relocate)
                    Divider()
                    Button("보관", action: archive)
                } else {
                    Button("복원…", action: restore)
                    Divider()
                    Button("등록 삭제…", role: .destructive, action: delete)
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
            TextField("프로젝트 이름", text: $name)
            if case .rename = editor {
                EmptyView()
            } else {
                HStack {
                    TextField(
                        BridgeAppLocalization.string(
                            usesRemotePaths ? "서버의 절대 폴더 경로" : "폴더",
                            locale: locale
                        ),
                        text: $cwd
                    )
                    .textFieldStyle(.roundedBorder)
                    if !usesRemotePaths {
                        Button("선택…") {
                            let panel = NSOpenPanel()
                            panel.canChooseFiles = false
                            panel.canChooseDirectories = true
                            panel.prompt = BridgeAppLocalization.string("연결", locale: locale)
                            panel.message = BridgeAppLocalization.string(
                                "연결할 폴더를 선택합니다. 실제 폴더나 파일은 이동하지 않습니다.",
                                locale: locale
                            )
                            if panel.runModal() == .OK, let url = panel.url { cwd = url.path }
                        }
                    }
                }
                if usesRemotePaths {
                    Label(
                        "이 Mac의 폴더가 아니라 원격 서버에서 존재하는 절대 경로를 입력하세요. 서버가 최종 경로와 허용 범위를 검증합니다.",
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
                Button("취소", role: .cancel) { dismiss() }
                Spacer()
                if isSaving { ProgressView().controlSize(.small) }
                Button("저장") {
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
        case .add: key = "프로젝트 추가"
        case .rename: key = "프로젝트 이름 변경"
        case .relocate: key = "연결 폴더 변경"
        case .restore: key = "프로젝트 복원"
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
    case "read-only": key = "읽기 전용"
    case "adaptive": key = "작업별 선택"
    case "always-full": key = "항상 전체 접근"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func accessDescription(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "read-only": key = "모든 새 작업을 읽기 전용으로 제한합니다."
    case "adaptive": key = "허용된 범위 안에서 작업마다 필요한 접근 수준을 선택합니다."
    case "always-full": key = "모든 새 작업에 전체 접근을 적용합니다."
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func localeLabel(_ value: String, locale: Locale) -> String {
    switch value {
    case "auto": return BridgeAppLocalization.string("자동", locale: locale)
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
    case "always": key = "항상"
    case "background-only": key = "백그라운드 작업만"
    case "never": key = "표시 안 함"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func handoffLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "off": key = "사용 안 함"
    case "auto-handoff": key = "완료 시 자동으로 ChatGPT에 넘기기"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func phaseLabel(_ value: String?, locale: Locale) -> String {
    let key: String
    switch value {
    case "running": key = "실행 중"
    case "starting": key = "시작 중"
    case "draining": key = "작업 종료 대기 중"
    case "stopping": key = "중지 중"
    case "backoff": key = "재시작 대기 중"
    case "safe-mode": key = "안전 모드"
    default: key = "중지됨"
    }
    return BridgeAppLocalization.string(key, locale: locale)
}
