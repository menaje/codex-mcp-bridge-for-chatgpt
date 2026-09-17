import AppKit
import CodexBridgeKit
import SwiftUI

enum ApplicationQuitConfirmationPolicy {
    static func requiresConfirmation(
        for impact: RuntimeAdmissionSnapshot?,
        refreshFailed: Bool
    ) -> Bool {
        guard !refreshFailed, let impact else { return true }
        return impact.activeJobs > 0 ||
            impact.pendingAdmissions > 0 ||
            impact.backgroundProcesses > 0 ||
            impact.backgroundProcessUnknownAgents > 0 ||
            impact.backgroundProcessState != "confirmed"
    }
}

struct DashboardPopoverView: View {
    var onContentSizeChange: ((CGSize) -> Void)?
    var onRequestClose: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @State private var showForceStopConfirmation = false
    @State private var showForceRestartConfirmation = false
    @State private var showRepairConfirmation = false
    @State private var showApplicationQuitConfirmation = false
    @State private var isRefreshingOverview = false
    @State private var regionHeights: [DashboardPopoverRegion: CGFloat] = [:]
    @State private var screenHeight: CGFloat = NSScreen.main?.visibleFrame.height ?? 800

    init(
        onContentSizeChange: ((CGSize) -> Void)? = nil,
        onRequestClose: (() -> Void)? = nil
    ) {
        self.onContentSizeChange = onContentSizeChange
        self.onRequestClose = onRequestClose
    }

    var body: some View {
        VStack(spacing: 0) {
            headerSection.dashboardHeight(.header)
            Group {
                if !model.hasConnectionTarget {
                    runtimeUnavailableView.frame(height: fallbackHeight)
                } else if model.needsSetup {
                    ConnectionSetupRequiredPopoverView {
                        presentConnectionSetupWindow()
                    }
                } else if !model.bridgeConnected, model.isBridgeConnectionChecking, model.dashboard == nil {
                    connectionCheckingView
                } else if !model.bridgeConnected, !model.isBridgeConnectionChecking {
                    runtimeUnavailableView.frame(height: fallbackHeight)
                } else if let dashboard = model.dashboard {
                    dashboardContent(dashboard)
                } else {
                    loadingView
                }
            }
            Divider()
            footer.dashboardHeight(.footer)
        }
        .frame(width: DashboardPopoverLayout.width)
        .fixedSize(horizontal: false, vertical: true)
        .background(DashboardPopoverScreen {
            screenHeight = $0
        })
        .background(GeometryReader { geometry in
            Color.clear.preference(key: DashboardPopoverContentSize.self, value: geometry.size)
        })
        .onPreferenceChange(DashboardPopoverHeights.self) { regionHeights = $0 }
        .onPreferenceChange(DashboardPopoverContentSize.self) { size in
            guard size.width > 0, size.height > 0 else { return }
            onContentSizeChange?(size)
        }
        .environment(\.locale, model.interfaceLocale)
        .task {
            if model.isRemoteClient ? model.remoteHello == nil : model.helperStatus == nil {
                await model.start()
            }
        }
        .confirmationDialog(
            "macos.interrupttasksandbackgroundprocessesandforcestop",
            isPresented: $showForceStopConfirmation
        ) {
            Button("macos.forcequit", role: .destructive) {
                Task { await model.stopRuntime(force: true) }
            }
        } message: {
            Text(forceImpactMessage(restarting: false))
        }
        .confirmationDialog(
            "macos.interrupttasksandbackgroundprocessesandforcerestart",
            isPresented: $showForceRestartConfirmation
        ) {
            Button("macos.forcerestart", role: .destructive) {
                Task { await model.restartRuntime(force: true) }
            }
        } message: {
            Text(forceImpactMessage(restarting: true))
        }
        .confirmationDialog(
            "macos.rebuildthesecuremcptunnelprofile",
            isPresented: $showRepairConfirmation
        ) {
            Button("macos.repairprofileafterfinishingwork") {
                Task { await model.repairTunnelProfile() }
            }
        } message: {
            Text("macos.keepstheprivateenvandbridgestateand")
        }
        .confirmationDialog(
            "macos.quittheappandallrelatedprocesses",
            isPresented: $showApplicationQuitConfirmation
        ) {
            Button("macos.quitafterfinishingwork") {
                shutdownAndQuit(force: false)
            }
            Button("macos.forcequit", role: .destructive) {
                shutdownAndQuit(force: true)
            }
            Button("common.cancel", role: .cancel) {}
        } message: {
            Text(applicationQuitImpactMessage)
        }
    }

    private var fallbackHeight: CGFloat {
        min(440, max(160, screenHeight - DashboardPopoverLayout.screenMargin -
            (regionHeights[.header] ?? 80) - (regionHeights[.footer] ?? 50)))
    }

    private var detailHeight: CGFloat {
        DashboardPopoverLayout.detailHeight(
            for: model.dashboardPanel ?? .running,
            content: regionHeights[.detail] ?? 100,
            fixed: (regionHeights[.header] ?? 80) + (regionHeights[.summary] ?? 260) +
                (regionHeights[.footer] ?? 50) + 2,
            screen: screenHeight
        )
    }

    private var headerSection: some View {
        VStack(spacing: 0) {
            header
            RuntimeLifecycleNoticeView().padding(.horizontal, 12)
            if let problem = model.operationalProblem {
                Button { model.showOperationalProblem(problem) } label: {
                    Label(BridgeAppLocalization.string(problem.messageKey, locale: model.interfaceLocale),
                          systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
            Divider()
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            BridgeBrandStatusIcon(health: model.health, size: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("macos.codexmcpbridgeforchatgpt")
                    .font(.headline)
                Text(BridgeAppLocalization.format(
                    "macos.format.dotSeparatedPair",
                    locale: model.interfaceLocale,
                    model.connectionTargetName,
                    model.health.accessibilityLabel(locale: model.interfaceLocale)
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.isBusy { ProgressView().controlSize(.small) }
            Button {
                guard !isRefreshingOverview else { return }
                isRefreshingOverview = true
                let feedbackDeadline = ContinuousClock.now.advanced(by: .milliseconds(400))
                Task {
                    defer { isRefreshingOverview = false }
                    await model.refreshStatus()
                    await model.refreshAuthStatus()
                    await model.refreshDashboard()
                    // Keep the click visible even when every response is cached.
                    try? await Task.sleep(until: feedbackDeadline, clock: .continuous)
                }
            } label: {
                Group {
                    if isRefreshingOverview {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .frame(width: 28, height: 28)
            }
            .buttonStyle(.borderless)
            .disabled(isRefreshingOverview)
            .help("macos.common.refreshAction")
            .accessibilityLabel("macos.refreshoverview")
            .accessibilityValue(isRefreshingOverview ? Text("macos.loadingoverview") : Text(verbatim: ""))
        }
        .padding(14)
    }

    @ViewBuilder
    private var loadingView: some View {
        if let error = model.connectionErrorMessage ?? model.startupErrorMessage ??
            model.statusErrorMessage ?? model.dashboardErrorMessage {
            VStack(spacing: 10) {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                Button(BridgeAppLocalization.string(
                    model.isRemoteClient ? "macos.reconnectserver" : "macos.reconnecthelper",
                    locale: model.interfaceLocale
                )) {
                    Task {
                        if model.isRemoteClient { await model.refreshAll() }
                        else { await model.start() }
                    }
                }
                .disabled(model.isBusy)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        } else if !hasStartupLifecycleNotice {
            compactProgress("macos.loadingoverview")
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
        }
    }

    private var connectionCheckingView: some View {
        Group {
            if !hasStartupLifecycleNotice {
                compactProgress("macos.checkingthebridgeconnection")
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            }
        }
    }

    private var hasStartupLifecycleNotice: Bool {
        model.lifecycleOperation?.kind == "start" && model.lifecycleOperation?.isPending == true
    }

    private func compactProgress(_ title: LocalizedStringKey) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(title)
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var runtimeUnavailableView: some View {
        VStack(spacing: 14) {
            BridgeBrandStatusIcon(health: .unavailable, size: 48)
            Text("macos.cannotconnecttothebridgeserver")
                .font(.headline)
            Text(model.connectionErrorMessage ?? model.helperStatusErrorMessage ??
                 model.runtimeErrorMessage ?? model.statusErrorMessage ??
                 model.runtimeUnavailableExplanation)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            if model.isRemoteClient {
                HStack {
                    Button("macos.reconnect") { Task { await model.refreshAll() } }
                        .buttonStyle(.borderedProminent)
                    Button("macos.connectionsettings") { presentSettingsWindow() }
                }
                .disabled(model.isBusy)
            } else {
                HStack {
                    if model.helperStatus?.phase == "stopped" {
                        Button("macos.start") { Task { await model.startRuntime() } }
                            .buttonStyle(.borderedProminent)
                    } else {
                        Button("macos.reconnect") { Task { await model.refreshAll() } }
                            .buttonStyle(.borderedProminent)
                    }
                    Button("macos.runtime.restartAction") { Task { await model.restartRuntime(force: false) } }
                }
                .disabled(model.isBusy)
                Button("macos.repairtunnelprofile") { showRepairConfirmation = true }
                    .disabled(model.isBusy)
            }
            if !model.isRemoteClient, model.helperStatus?.phase == "safe-mode" {
                Label("macos.automaticrestartstoppedafterrepeatedcrashes", systemImage: "exclamationmark.octagon")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(28)
    }

    private func dashboardContent(_ dashboard: DashboardSnapshot) -> some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                if model.shouldShowCodexAuthenticationNotice {
                    Button {
                        presentConnectionRepairWindow()
                    } label: {
                        Label(
                            authenticationNotice,
                            systemImage: "person.crop.circle.badge.exclamationmark"
                        )
                    }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                if let error = model.dashboardErrorMessage {
                    Label(
                        BridgeAppLocalization.format(
                            "macos.couldnotrefreshthelateststatus",
                            locale: model.interfaceLocale,
                            error
                        ),
                        systemImage: "clock.badge.exclamationmark"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                }
                if let error = model.runtimeErrorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                }
                if !model.isRemoteClient, model.helperStatus?.tunnel.connected != true {
                    if model.isTunnelConnectionChecking {
                        Label(
                            "macos.checkingthesecuremcptunnelconnection",
                            systemImage: "arrow.triangle.2.circlepath"
                        )
                        .font(.caption)
                        .foregroundStyle(.blue)
                    } else if let error = model.tunnelStatusErrorMessage {
                        Label(error, systemImage: "network.slash")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .textSelection(.enabled)
                    }
                }
                if model.shouldShowCodexWeeklyUsage {
                    if let account = dashboard.codexAccount {
                        CodexMenuAccountView(account: account, fallbackWeekly: dashboard.weeklyUsage)
                    } else if let usage = dashboard.weeklyUsage {
                        WeeklyUsageView(usage: usage)
                    }
                }
                DashboardSummary(counts: dashboard.counts)
                dashboardBackgroundStatus(dashboard)
                dashboardFreshness(dashboard)
            }
            .padding(14)
            .dashboardHeight(.summary)
            if let panel = model.dashboardPanel {
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if model.dashboardDetailLoading {
                            if let error = model.dashboardErrorMessage {
                                Text(error).font(.caption).foregroundStyle(.secondary)
                                Button("macos.common.refreshAction") { Task { await model.refreshDashboard() } }
                            } else {
                                ProgressView("macos.loadingoverview")
                                    .frame(maxWidth: .infinity)
                            }
                        } else {
                            dashboardDetails(dashboard, panel: panel)
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .dashboardHeight(.detail)
                }
                .frame(height: detailHeight)
                .id(panel)
                .accessibilityIdentifier("dashboard-detail")
            }
        }
    }

    @ViewBuilder
    private func dashboardDetails(_ dashboard: DashboardSnapshot, panel: DashboardPanel) -> some View {
        if panel == .history {
            Text("macos.showsonlytasksagentsandconversationsretainedby")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if shouldOfferCodexThreadPersistence {
                VStack(alignment: .leading, spacing: 6) {
                    Label(
                        "macos.opennewagenttasksinthecodexapp",
                        systemImage: "arrow.up.forward.app"
                    )
                    .font(.caption.weight(.semibold))
                    Text("macos.newtasksandfreshcontextswillbekept")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Button("macos.enablefornewtasks") {
                        model.enableCodexThreadPersistence()
                    }
                    .buttonStyle(.link)
                    .disabled(model.generalSettingsSaveState.isActive)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
            }
        }
        if dashboard.counts.runtimeUnknownAgents > 0,
           !model.dashboardEnrichmentPending || model.dashboardEnrichmentFailed {
            Label(
                BridgeAppLocalization.format(
                    "macos.runtimeorprocessstatuscouldnotbeconfirmed",
                    locale: model.interfaceLocale,
                    dashboard.counts.runtimeUnknownAgents
                ),
                systemImage: "questionmark.circle"
            )
            .font(.caption)
            .foregroundStyle(.orange)
        }
        if dashboard.counts.runtimeProbeSkippedAgents > 0 {
            Label(
                BridgeAppLocalization.format(
                    "macos.processstatushasnotyetbeencheckedfor",
                    locale: model.interfaceLocale,
                    dashboard.counts.runtimeProbeSkippedAgents
                ),
                systemImage: "ellipsis.circle"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        if panel == .problems {
            if let problems = dashboard.problems {
                DashboardProblemsSection(problems: problems)
            } else {
                let rows = panel.rows(in: dashboard)
                DashboardSection(title: "dashboard.problems", emptyText: "problem.empty",
                    rows: rows,
                    total: rows.count,
                    groupsByActivity: true)
            }
        } else {
            let rows = panel.rows(in: dashboard)
            let currentRows = panel == .history
                ? dashboard.activeRows
                : rows.filter { $0.bucket == "active" }
            let recentRows = panel == .history
                ? dashboard.terminalRows
                : rows.filter { $0.bucket != "active" }
            DashboardSection(
                title: panel == .history ? "dashboard.active" : panel.title,
                emptyText: "dashboard.noActive",
                rows: currentRows,
                total: currentRows.count,
                groupsByActivity: true
            )
            if panel == .history, dashboard.pagination.active.hasNext {
                Label(BridgeAppLocalization.format(
                    "macos.onlyactiveitemsareshown",
                    locale: model.interfaceLocale,
                    dashboard.pagination.active.returned
                ), systemImage: "ellipsis.circle")
                    .font(.caption).foregroundStyle(.orange)
            }
            if panel == .history || !recentRows.isEmpty {
                DashboardSection(title: "dashboard.recent", emptyText: "macos.therearenoretainedrecentruns",
                    rows: recentRows,
                    total: panel == .history ? dashboard.pagination.terminal.total : recentRows.count,
                    groupsByActivity: true, hasMore: panel == .history && dashboard.pagination.terminal.hasNext,
                    loadMore: { Task { await model.loadMoreRecent() } })
                if panel == .history, let policy = dashboard.historyPolicy { WorkHistoryPolicyView(policy: policy) }
            }
        }
    }

    @ViewBuilder
    private func dashboardBackgroundStatus(_ dashboard: DashboardSnapshot) -> some View {
        if dashboard.counts.backgroundProcesses > 0 {
            Button {
                Task { await model.toggleDashboardPanel(.background) }
            } label: {
                Label(BridgeAppLocalization.format(
                    "macos.dashboard.backgroundProcessCount",
                    locale: model.interfaceLocale,
                    dashboard.counts.backgroundProcesses
                ), systemImage: "terminal.fill")
            }
            .buttonStyle(.link)
            .font(.caption)
            .foregroundStyle(model.dashboardPanel == .background ? Color.accentColor : Color.primary)
            .accessibilityAddTraits(model.dashboardPanel == .background ? [.isSelected] : [])
            .accessibilityIdentifier("dashboard-background")
        } else if dashboard.counts.runtimeUnknownAgents > 0 || dashboard.counts.runtimeProbeSkippedAgents > 0 {
            Label("dashboard.backgroundUnknown", systemImage: "questionmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func dashboardFreshness(_ dashboard: DashboardSnapshot) -> some View {
        HStack {
            Text("macos.lastchecked")
            Spacer()
            Text(DisplayFormat.dateTime(dashboard.generatedAt, locale: model.interfaceLocale))
        }
        .font(.caption2)
        .foregroundStyle(.secondary)

        if model.dashboardEnrichmentFailed || dashboard.enrichment?.hasFailures == true {
            Label(
                "common.detailsRefreshFailed",
                systemImage: "clock.badge.exclamationmark"
            )
            .font(.caption)
            .foregroundStyle(.orange)
        } else if model.dashboardEnrichmentPending || dashboard.enrichment?.isUpdating == true {
            Label("macos.updatingadditionaldetailsconfirmedinformationisshownas", systemImage: "arrow.triangle.2.circlepath")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if (model.dashboardEnrichmentFailed || model.dashboardEnrichmentPending),
           let observed = model.dashboardObservationDate {
            Text(BridgeAppLocalization.format(
                "macos.detailsobserved",
                locale: model.interfaceLocale,
                observed.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(model.interfaceLocale))
            ))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var authenticationNotice: String {
        let key: String
        if model.authErrorMessage != nil {
            key = "macos.couldnotcheckthecodexloginstatuscheck"
        } else if model.authStatus?.installed == false {
            key = "macos.codexclicouldnotbefoundcheckthe"
        } else {
            key = "macos.codexloginisrequiredsigninbeforethe"
        }
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    private var shouldOfferCodexThreadPersistence: Bool {
        guard let settings = model.settings else { return false }
        return !model.isRemoteClient &&
            settings.capabilities.defaultBackend == "app-server" &&
            !settings.settings.showBridgeThreadsInCodexApp
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button {
                presentSkillsLibraryWindow()
            } label: {
                Label("macos.skilllibrary", systemImage: "books.vertical")
                    .labelStyle(.iconOnly)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.borderless)
            .help("macos.skilllibrary")
            .accessibilityLabel("macos.skilllibrary")

            Button {
                Task { await model.toggleDashboardPanel(.history) }
            } label: {
                Label("macos.workrunhistory", systemImage: "clock.arrow.circlepath")
                    .labelStyle(.iconOnly)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(model.dashboardPanel == .history ? Color.accentColor : Color.primary)
            .help("macos.workrunhistory")
            .accessibilityLabel("macos.workrunhistory")
            .accessibilityAddTraits(model.dashboardPanel == .history ? [.isSelected] : [])
            .accessibilityIdentifier("dashboard-history")
            .disabled(model.dashboard == nil || !model.bridgeConnected || model.changingProblems)

            Spacer()

            Button {
                presentSettingsWindow()
            } label: {
                Label("macos.settings", systemImage: "gearshape")
                    .labelStyle(.iconOnly)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.borderless)
            .keyboardShortcut(",")
            .help("macos.settings")
            .accessibilityLabel("macos.settings")

            if model.isRemoteClient {
                Menu {
                    ForEach(model.connectionPreferences.profiles) { profile in
                        Button {
                            Task { await model.activateRemoteServer(profile.serverId) }
                        } label: {
                            if profile.serverId == model.connectionPreferences.activeServerId {
                                Label(profile.name, systemImage: "checkmark")
                            } else {
                                Text(profile.name)
                            }
                        }
                    }
                    Divider()
                    Button("macos.manageserverconnections") { presentSettingsWindow() }
                } label: {
                    Label("macos.server", systemImage: "server.rack")
                        .labelStyle(.iconOnly)
                        .frame(width: 28, height: 28)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .help(Text("macos.server") + Text(verbatim: " · \(model.connectionTargetName)"))
                .accessibilityLabel("macos.server")
                .accessibilityValue(Text(verbatim: model.connectionTargetName))
                .disabled(model.isBusy)
            } else {
                Menu {
                    if model.codexRuntime?.showsMenuUpdate == true {
                        Button("macos.updatecodex") {
                            Task { await model.manageCodex(.init(action: "update")) }
                        }
                        Divider()
                    }
                    Button("macos.restartserveraftertasksfinish") {
                        Task { await model.restartRuntime(force: false) }
                    }
                    Button("macos.stoptasksandforcerestartserver", role: .destructive) {
                        Task {
                            await model.refreshRuntimeImpact()
                            showForceRestartConfirmation = true
                        }
                    }
                    Divider()
                    Button("macos.connectioninformationandcodexsignin") {
                        presentConnectionRepairWindow()
                    }
                    Button("macos.repairsecuremcptunnelprofile") {
                        showRepairConfirmation = true
                    }
                    Divider()
                    Button("macos.stopserveraftertasksfinish") {
                        Task { await model.stopRuntime(force: false) }
                    }
                    Button("macos.stoptasksandforcestopserver", role: .destructive) {
                        Task {
                            await model.refreshRuntimeImpact()
                            showForceStopConfirmation = true
                        }
                    }
                } label: {
                    Label("macos.server", systemImage: "server.rack")
                        .labelStyle(.iconOnly)
                        .frame(width: 28, height: 28)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .help("macos.server")
                .accessibilityLabel("macos.server")
                .disabled(model.needsSetup || model.isBusy)
            }

            Button {
                if model.isRemoteClient {
                    shutdownAndQuit(force: false)
                } else {
                    Task {
                        await model.refreshRuntimeImpact()
                        if ApplicationQuitConfirmationPolicy.requiresConfirmation(
                            for: model.runtimeImpact,
                            refreshFailed: model.runtimeImpactErrorMessage != nil
                        ) {
                            showApplicationQuitConfirmation = true
                        } else {
                            shutdownAndQuit(force: false)
                        }
                    }
                }
            } label: {
                Label("macos.quitapp", systemImage: "power")
                    .labelStyle(.iconOnly)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.borderless)
            .disabled(model.isBusy)
            .help("macos.quitapp")
            .accessibilityLabel("macos.quitapp")
            .accessibilityHint(Text(verbatim: BridgeAppLocalization.string(
                model.isRemoteClient
                    ? "macos.quitsonlythisclientappanddoesnot"
                    : "macos.runtime.quitAllProcessesDescription",
                locale: model.interfaceLocale
            )))
        }
        .padding(12)
    }

    private var activeJobCount: Int {
        if let runtimeImpact = model.runtimeImpact {
            return runtimeImpact.activeJobs + runtimeImpact.pendingAdmissions
        }
        if let bridge = model.helperStatus?.bridge {
            return (bridge.activeJobs ?? 0) + (bridge.pendingAdmissions ?? 0)
        }
        return model.dashboard?.counts.active ?? 0
    }

    private var backgroundProcessCount: Int {
        if let runtimeImpact = model.runtimeImpact {
            return runtimeImpact.backgroundProcesses
        }
        if model.helperStatus?.bridge.backgroundProcessState == "confirmed",
           let count = model.helperStatus?.bridge.backgroundProcesses {
            return count
        }
        return model.dashboard?.counts.backgroundProcesses ?? 0
    }

    private var backgroundProcessUnknownAgents: Int {
        model.runtimeImpact?.backgroundProcessUnknownAgents ??
            model.helperStatus?.bridge.backgroundProcessUnknownAgents ?? 0
    }

    private func forceImpactMessage(restarting: Bool) -> String {
        var messages = [BridgeAppLocalization.format(
            "macos.activetasksandbackgroundprocessesmaybeinterrupted",
            locale: model.interfaceLocale,
            activeJobCount,
            backgroundProcessCount
        )]
        if backgroundProcessUnknownAgents > 0 {
            messages.append(BridgeAppLocalization.format(
                "macos.thebackgroundstateofagentscouldnotbe",
                locale: model.interfaceLocale,
                backgroundProcessUnknownAgents
            ))
        }
        if model.runtimeImpactErrorMessage != nil {
            messages.append(BridgeAppLocalization.string(
                "macos.thelatestimpactcouldnotbeverifiedso",
                locale: model.interfaceLocale
            ))
        }
        if restarting {
            messages.append(BridgeAppLocalization.string(
                "macos.interruptedtaskswillnotrestartautomatically",
                locale: model.interfaceLocale
            ))
        }
        return messages.joined(separator: " ")
    }

    private var applicationQuitImpactMessage: String {
        var messages = [BridgeAppLocalization.string(
            "macos.quitsthemenubarapphelperbridgeserver",
            locale: model.interfaceLocale
        )]
        if activeJobCount > 0 || backgroundProcessCount > 0 {
            messages.append(BridgeAppLocalization.format(
                "macos.thereareactivetasksandbackgroundprocessessafe",
                locale: model.interfaceLocale,
                activeJobCount,
                backgroundProcessCount
            ))
        }
        if backgroundProcessUnknownAgents > 0 {
            messages.append(BridgeAppLocalization.format(
                "macos.thebackgroundstateofagentscouldnotbe",
                locale: model.interfaceLocale,
                backgroundProcessUnknownAgents
            ))
        }
        if model.runtimeImpactErrorMessage != nil {
            messages.append(BridgeAppLocalization.string(
                "macos.thelatestimpactcouldnotbeverifiedso",
                locale: model.interfaceLocale
            ))
        }
        messages.append(BridgeAppLocalization.string(
            "macos.filesystemchangesarenotrolledback",
            locale: model.interfaceLocale
        ))
        return messages.joined(separator: " ")
    }

    private func shutdownAndQuit(force: Bool) {
        guard SkillsLibraryWindowController.shared.confirmDiscardBeforeApplicationShutdown() else { return }
        Task {
            guard await model.shutdownApplication(force: force) else {
                SkillsLibraryWindowController.shared.cancelApplicationShutdownDiscard()
                if !model.applicationShutdownReserved { presentApplicationQuitFailure() }
                return
            }
            SkillsLibraryWindowController.shared.completeApplicationShutdownDiscard()
            NSApp.terminate(nil)
        }
    }

    private func presentSettingsWindow() {
        dismissMenuBarWindow()
        SettingsWindowController.shared.show(model: model)
    }

    private func presentSkillsLibraryWindow() {
        dismissMenuBarWindow()
        SkillsLibraryWindowController.shared.show(model: model)
    }

    private func presentConnectionRepairWindow() {
        dismissMenuBarWindow()
        ConnectionAssistantWindowController.shared.show(model: model)
    }

    private func presentConnectionSetupWindow() {
        dismissMenuBarWindow()
        ConnectionAssistantWindowController.shared.show(model: model, presentation: .setup)
    }

    private func dismissMenuBarWindow() {
        if let onRequestClose {
            onRequestClose()
            return
        }
        let menuBarWindow = NSApp.keyWindow
        dismiss()
        menuBarWindow?.orderOut(nil)
    }

    private func presentApplicationQuitFailure() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        let title = model.generalSettingsSaveState == .failed
            ? "macos.couldnotsavesettings"
            : "macos.couldnotquittheapp"
        alert.messageText = BridgeAppLocalization.string(title, locale: model.interfaceLocale)
        alert.informativeText = model.runtimeErrorMessage ?? BridgeAppLocalization.string(
            "macos.theappwasnotquitreviewthestatus",
            locale: model.interfaceLocale
        )
        alert.addButton(withTitle: BridgeAppLocalization.string(
            "macos.ok",
            locale: model.interfaceLocale
        ))
        alert.runModal()
    }
}

private struct WeeklyUsageView: View {
    @Environment(\.locale) private var locale
    let usage: WeeklyUsage
    var account: CodexAccountUsage? = nil

    private var remainingPercent: Double {
        min(100, max(0, usage.remainingPercent))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("macos.weeklyusage").font(.subheadline.weight(.semibold))
                Spacer()
                Text(BridgeAppLocalization.format(
                    "macos.remaining",
                    locale: locale,
                    Int(remainingPercent.rounded())
                ))
                    .font(.caption.monospacedDigit())
            }
            ProgressView(value: remainingPercent, total: 100)
            Text(BridgeAppLocalization.format(
                "macos.usagelastchecked",
                locale: locale,
                DisplayFormat.dateTime(usage.observedAt, locale: locale)
            ))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let resetsAt = usage.resetsAt {
                Text(BridgeAppLocalization.format(
                    "macos.accountUsage.resetsAt",
                    locale: locale,
                    DisplayFormat.dateTime(resetsAt, locale: locale)
                ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let account { CodexMenuPlanDetails(account: account) }
        }
        .padding(10)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}

private struct CodexMenuAccountView: View {
    let account: CodexAccountUsage
    let fallbackWeekly: WeeklyUsage?

    var body: some View {
        if account.authMode == "chatgpt", let weekly = account.weeklyUsage ?? fallbackWeekly {
            WeeklyUsageView(usage: weekly, account: account)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if account.authMode == "api-key" {
                    Text("macos.usingapi").font(.subheadline.weight(.semibold))
                    if let costs = account.billing?.actualCosts, costs.configured {
                        if costs.status == "available", let usd = costs.usd {
                            LabeledContent(costs.projectId == nil ? "macos.organizationcostthismonthutc" : "macos.projectcostthismonthutc",
                                value: usd.formatted(.currency(code: "USD")))
                        } else { Text("macos.costinformationisunavailable") }
                    }
                } else if account.authMode == "chatgpt" {
                    Text("macos.usageinformationisunavailable")
                    CodexMenuPlanDetails(account: account)
                } else { Text("macos.loginrequired") }
            }
            .font(.caption)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

private struct CodexMenuPlanDetails: View {
    let account: CodexAccountUsage
    var body: some View {
        if let balance = account.menuCreditBalance {
            HStack {
                Text("macos.additionalcredits")
                Text("macos.balance")
                Spacer()
                Text(verbatim: balance).monospacedDigit()
            }.font(.caption)
        }
        if (account.weeklyUsage?.remainingPercent ?? 0) > 0,
           account.windows.contains(where: { $0.limitId == "codex" && $0.windowDurationMins != 10080 && $0.remainingPercent <= 0 }) {
            Label("macos.theshorttermusagelimithasbeenreached", systemImage: "exclamationmark.triangle")
                .font(.caption).foregroundStyle(.orange)
        }
    }
}

private struct DashboardSummary: View {
    @EnvironmentObject private var model: AppModel
    let counts: DashboardCounts
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            summaryButton("macos.running", value: counts.running, symbol: "play.fill", panel: .running)
            summaryButton("dashboard.responseRequired", value: counts.responseRequiredCount, symbol: "text.bubble.fill", panel: .responseRequired)
            summaryButton("dashboard.problems", value: counts.problemCount, symbol: "exclamationmark.triangle.fill", panel: .problems)
        }
        .disabled(model.changingProblems)
    }

    private func summaryButton(_ title: String, value: Int, symbol: String, panel: DashboardPanel) -> some View {
        let selected = model.dashboardPanel == panel
        return Button {
            Task { await model.toggleDashboardPanel(panel) }
        } label: {
            VStack(spacing: 4) {
                HStack(spacing: 4) {
                    Image(systemName: symbol)
                    Text(BridgeAppLocalization.string(title, locale: model.interfaceLocale))
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                Text(value, format: .number)
                    .font(.title3.bold().monospacedDigit())
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(selected ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("dashboard-\(panel.rawValue)")
    }
}

private struct DashboardSection: View {
    @Environment(\.locale) private var locale
    @EnvironmentObject private var model: AppModel
    let title: String
    let emptyText: String
    let rows: [DashboardRow]
    var total: Int?
    var groupsByActivity = false
    var marksRecentActivity = false
    var hasMore = false
    var disclosureExpanded: Binding<Bool>? = nil
    var loadMore: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader
            if isExpanded {
                if rows.isEmpty {
                    Text(BridgeAppLocalization.string(emptyText, locale: locale))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 4)
                } else {
                    if groupsByActivity {
                        ForEach(activityGroups) { group in
                            DashboardActivityGroupView(
                                group: group,
                                marksRecentActivity: marksRecentActivity
                            )
                        }
                    } else {
                        ForEach(rows) { row in
                            DashboardRowView(
                                row: row,
                                presentation: .idle,
                                enclosingActivityTitle: row.activityTitle
                            )
                        }
                    }
                }
                if hasMore {
                    Button("macos.showmore", action: { loadMore?() })
                        .buttonStyle(.link)
                        .disabled(model.isBusy)
                }
            }
        }
    }

    @ViewBuilder
    private var sectionHeader: some View {
        if let disclosureExpanded {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    disclosureExpanded.wrappedValue.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .rotationEffect(.degrees(disclosureExpanded.wrappedValue ? 90 : 0))
                        .accessibilityHidden(true)
                    sectionTitle
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(BridgeAppLocalization.string(
                disclosureExpanded.wrappedValue ? "macos.expanded" : "macos.collapsed",
                locale: locale
            ))
        } else {
            sectionTitle
        }
    }

    private var sectionTitle: some View {
        HStack(spacing: 6) {
            Text(BridgeAppLocalization.string(title, locale: locale)).font(.headline)
            if let total {
                Text(BridgeAppLocalization.format("macos.format.integer", locale: locale, total))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var isExpanded: Bool {
        disclosureExpanded?.wrappedValue ?? true
    }

    private var activityGroups: [DashboardActivityGroup] {
        var order: [String] = []
        var grouped: [String: [DashboardRow]] = [:]
        for row in rows {
            if grouped[row.activityKey] == nil { order.append(row.activityKey) }
            grouped[row.activityKey, default: []].append(row)
        }
        return order.compactMap { key in
            guard let rows = grouped[key] else { return nil }
            return DashboardActivityGroup(id: key, rows: rows)
        }
    }
}

private struct DashboardActivityGroup: Identifiable {
    let id: String
    let rows: [DashboardRow]
}

private struct DashboardActivityGroupView: View {
    @Environment(\.locale) private var locale
    let group: DashboardActivityGroup
    let marksRecentActivity: Bool

    var body: some View {
        if let first = group.rows.first {
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        if marksRecentActivity {
                            Text("macos.recentactivity")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Text(activityTitle)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                        Text(first.projectName ?? BridgeAppLocalization.string(
                            "macos.noproject",
                            locale: locale
                        ))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let url = DashboardLink.conversation(first.conversationUrl) {
                        Link("macos.conversations", destination: url)
                    }
                }
                Text(BridgeAppLocalization.format(
                    "macos.agents",
                    locale: locale,
                    group.rows.count
                ))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if let cancellation = activityCancellation {
                    CancellationReason(cancellation: cancellation)
                }
                ForEach(group.rows) { row in
                    DashboardRowView(
                        row: row,
                        presentation: marksRecentActivity ? .nestedIdleAgent : .nestedAgent,
                        enclosingActivityTitle: activityTitle
                    )
                }
            }
            .padding(10)
            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 11))
        }
    }

    private var activityCancellation: CancellationDisplay? {
        group.rows.compactMap(\.latestTurn?.cancellation).first {
            $0.targetKind == "activity"
        }
    }

    private var activityTitle: String {
        for row in group.rows {
            for candidate in [row.activityTitle, row.latestTurn?.activityTitle] {
                if let candidate, !candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return candidate
                }
            }
        }
        return BridgeAppLocalization.string(
            marksRecentActivity ? "macos.norecentactivity" : "macos.untitledactivity",
            locale: locale
        )
    }
}

enum DashboardRowPresentation {
    case nestedAgent
    case nestedIdleAgent
    case idle

    var suppressesRedundantIdleStatus: Bool {
        switch self {
        case .nestedAgent:
            return false
        case .nestedIdleAgent, .idle:
            return true
        }
    }
}

private struct CancellationReason: View {
    @Environment(\.locale) private var locale
    let cancellation: CancellationDisplay

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("macos.cancellationreason")
                .font(.caption.weight(.semibold))
            Text(cancellation.reason)
                .textSelection(.enabled)
            Text(BridgeAppLocalization.format(
                "macos.format.dotSeparatedTriple",
                locale: locale,
                cancellationTargetLabel(cancellation.targetKind, locale: locale),
                cancellationStatusLabel(cancellation.status, locale: locale),
                DisplayFormat.dateTime(cancellation.requestedAt, locale: locale)
            ))
                .foregroundStyle(.secondary)
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DashboardExecutionLabel: View {
    let text: String
    let execution: DashboardExecution?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(text)
                .lineLimit(2)
            if DashboardExecutionPresentation.usesFastProcessing(execution) {
                Label("dashboard.execution.fast", systemImage: "bolt.fill")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
                    .fixedSize()
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct DashboardRowView: View {
    @EnvironmentObject private var model: AppModel
    let row: DashboardRow
    let presentation: DashboardRowPresentation
    let enclosingActivityTitle: String?
    @State private var historyExpanded = false
    @State private var changingHistory = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: StatusPresentation.symbol(row.status))
                    .foregroundStyle(StatusPresentation.color(row.status))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.agentName)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    if let secondaryTitle {
                        Text(secondaryTitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                if row.status != "idle" || !presentation.suppressesRedundantIdleStatus {
                    Text(StatusPresentation.label(row.status, locale: model.interfaceLocale))
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(.quaternary, in: Capsule())
                }
            }
            if row.latestTurn != nil {
                DashboardExecutionLabel(text: BridgeAppLocalization.format(
                    "macos.format.labelValue",
                    locale: model.interfaceLocale,
                    BridgeAppLocalization.string(
                        row.bucket == "idle" ? "macos.latestrun" : "macos.run",
                        locale: model.interfaceLocale
                    ),
                    DashboardExecutionPresentation.turnText(
                        row.latestTurn?.execution,
                        locale: model.interfaceLocale
                    )
                ), execution: row.latestTurn?.execution)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let next = nextExecution {
                DashboardExecutionLabel(text: BridgeAppLocalization.format(
                    "macos.nextrunsettings",
                    locale: model.interfaceLocale,
                    executionText(next)
                ), execution: next)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(rowTimeText)
                    .lineLimit(2)
                HStack(spacing: 10) {
                    if row.backgroundProcessCount > 0 {
                        Label(BridgeAppLocalization.format(
                            "macos.format.integer",
                            locale: model.interfaceLocale,
                            row.backgroundProcessCount
                        ), systemImage: "terminal")
                    }
                    Spacer()
                    if presentation == .idle {
                        if let url = DashboardLink.conversation(row.conversationUrl) {
                            Link("macos.conversations", destination: url)
                        }
                    }
                    if !model.isRemoteClient,
                       DashboardLink.availableCodexThread(row.codexThreadUrl) != nil {
                        Button {
                            model.continueInCodex(row)
                        } label: {
                            Label("macos.continueincodex", systemImage: "arrow.up.forward.app")
                        }
                        .buttonStyle(.link)
                        .help("macos.openscodexafteractiveworkfinishesandthe")
                        if let handoff = model.threadHandoffs[row.rowKey] ?? row.handoff,
                           handoff.requested && !handoff.canOpen {
                            Button("macos.cancelhandoff") { model.cancelThreadHandoff(row) }
                                .buttonStyle(.link)
                        }
                    }
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            if let controls = row.historyControls {
                HStack {
                    if controls.canAcknowledge { acknowledgeHistoryButton("history.acknowledge") }
                    if changingHistory { ProgressView().controlSize(.mini) }
                }
                .font(.caption2)
                .disabled(changingHistory)
            }
            if !model.isRemoteClient,
               let handoff = model.threadHandoffs[row.rowKey] ?? row.handoff,
               handoff.requested && !handoff.canOpen {
                Group {
                    switch handoff.reason {
                    case "active-work": Text("macos.waitingforactiveworktofinish")
                    case "ephemeral", "persistence-unknown": Text("macos.keepingtheconnectionbecauseconversationstoragecouldnot")
                    case "background-work", "background-unknown": Text("macos.handoffwillproceedafterbackgroundworkisconfirmed")
                    case "shared-worker-protected", "upstream-unload-grace": Text("macos.waitingforotherconversationsandcodextorelease")
                    case "unsupported", "ownership-unconfirmed": Text("macos.couldnotconfirmconnectionreleasepleasetryagain")
                    default: Text("macos.checkingthattheconnectionisreleasedcodexwill")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            if let cancellation = row.latestTurn?.cancellation,
               presentation == .idle || cancellation.targetKind != "activity" {
                CancellationReason(cancellation: cancellation)
            }
            if historyTotal > 0 {
                Button {
                    let shouldLoad = !historyExpanded && displayedHistory.isEmpty
                    withAnimation(.easeInOut(duration: 0.15)) {
                        historyExpanded.toggle()
                    }
                    if shouldLoad {
                        Task { await model.loadDashboardHistory(row) }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(historyExpanded ? 90 : 0))
                            .accessibilityHidden(true)
                        Text(BridgeAppLocalization.format(
                            "macos.recentruns",
                            locale: model.interfaceLocale,
                            historyTotal
                        ))
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .font(.caption)
                .accessibilityValue(BridgeAppLocalization.string(
                    historyExpanded ? "macos.expanded" : "macos.collapsed",
                    locale: model.interfaceLocale
                ))

                if historyExpanded {
                    VStack(alignment: .leading, spacing: 6) {
                        if displayedHistory.isEmpty {
                            if let error = model.dashboardHistoryError(for: row) {
                                Text(error)
                                    .foregroundStyle(.secondary)
                                Button("macos.common.refreshAction") {
                                    Task { await model.loadDashboardHistory(row) }
                                }
                                .buttonStyle(.link)
                            } else if model.dashboardHistory(for: row) != nil {
                                Text("macos.therearenoretainedrecentruns")
                                    .foregroundStyle(.secondary)
                            } else {
                                HStack(spacing: 6) {
                                    ProgressView()
                                        .controlSize(.mini)
                                    Text("macos.loadingoverview")
                                }
                                .foregroundStyle(.secondary)
                                .task(id: row.rowKey) {
                                    await model.loadDashboardHistory(row)
                                }
                            }
                        } else {
                            ForEach(Array(historyItems.enumerated()), id: \.offset) { _, item in
                                HStack(alignment: .top, spacing: 7) {
                                    Image(systemName: StatusPresentation.symbol(item.turn.status))
                                        .foregroundStyle(StatusPresentation.color(item.turn.status))
                                        .accessibilityHidden(true)
                                    VStack(alignment: .leading, spacing: 2) {
                                        switch item.heading {
                                        case .none:
                                            EmptyView()
                                        case .boundary:
                                            Text("dashboard.history.activityBoundary")
                                                .font(.caption2.weight(.medium))
                                                .foregroundStyle(.secondary)
                                        case .title(let title):
                                            Text(title)
                                                .fontWeight(.semibold)
                                        }
                                        Text(turnTimeText(item.turn))
                                            .foregroundStyle(.secondary)
                                        DashboardExecutionLabel(text: DashboardExecutionPresentation.turnText(
                                            item.turn.execution,
                                            locale: model.interfaceLocale
                                        ), execution: item.turn.execution)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(.secondary)
                                        if let cancellation = item.turn.cancellation {
                                            CancellationReason(cancellation: cancellation)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .font(.caption)
                    .padding(.top, 3)
                    .padding(.leading, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(10)
        .background(.background, in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(.quaternary, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            BridgeAppLocalization.format(
                "macos.format.commaSeparatedTriple",
                locale: model.interfaceLocale,
                row.agentName,
                row.activityTitle ?? "Activity",
                StatusPresentation.label(row.status, locale: model.interfaceLocale)
            )
        )
    }

    private var secondaryTitle: String? {
        if presentation == .idle {
            let activity = row.latestTurn?.activityTitle ?? row.activityTitle ??
                BridgeAppLocalization.string("macos.norecentactivity", locale: model.interfaceLocale)
            let project = row.projectName ??
                BridgeAppLocalization.string("macos.noproject", locale: model.interfaceLocale)
            return BridgeAppLocalization.format(
                "macos.format.dotSeparatedPair",
                locale: model.interfaceLocale,
                activity,
                project
            )
        }
        return nil
    }

    private var nextExecution: DashboardExecution? {
        return DashboardExecutionPresentation.next(
            current: row.execution,
            latest: row.latestTurn?.execution
        )
    }

    private var displayedHistory: [DashboardTurn] {
        if let history = row.history, !history.isEmpty {
            return history
        }
        return model.dashboardHistory(for: row)?.history ?? []
    }

    private var historyTotal: Int {
        max(
            row.historyCount ?? 0,
            max(displayedHistory.count, model.dashboardHistory(for: row)?.historyCount ?? 0)
        )
    }

    private var historyItems: [DashboardHistoryItem] {
        DashboardHistoryPresentation.items(
            history: displayedHistory,
            latestTurn: row.latestTurn,
            enclosingActivityKey: row.activityKey,
            enclosingActivityTitle: enclosingActivityTitle ?? row.activityTitle
        )
    }

    private func executionText(_ execution: DashboardExecution) -> String {
        DashboardExecutionPresentation.text(execution, locale: model.interfaceLocale)
    }

    private var rowTimeText: String {
        DashboardTimePresentation.text(
            turn: row.latestTurn,
            fallbackUpdatedAt: row.updatedAt,
            fallbackStatus: row.status,
            fallbackDurationMs: row.elapsedMs,
            locale: model.interfaceLocale
        )
    }

    private func turnTimeText(_ turn: DashboardTurn) -> String {
        StatusPresentation.label(turn.status, locale: model.interfaceLocale) + " · " +
            DashboardTimePresentation.text(turn: turn, fallbackUpdatedAt: turn.updatedAt, locale: model.interfaceLocale)
    }

    private func acknowledgeHistoryButton(_ title: LocalizedStringKey) -> some View {
        Button(title) {
            changingHistory = true
            Task {
                await model.acknowledgeHistory(row)
                changingHistory = false
            }
        }
        .buttonStyle(.link)
    }
}

private enum StatusPresentation {
    static func label(_ status: String, locale: Locale) -> String {
        let key: String
        switch status {
        case "running": key = "macos.running"
        case "background-process-running": key = "macos.backgroundprocessrunning"
        case "input-required": key = "macos.inputrequired"
        case "approval-required": key = "macos.approvalrequired"
        case "terminating": key = "macos.terminating"
        case "termination-failed": key = "macos.terminationfailed"
        case "liveness-unknown": key = "problem.kind.unknown"
        case "completed": key = "macos.completed"
        case "failed": key = "macos.failed"
        case "interrupted": key = "macos.interrupted"
        case "cancelled": key = "common.cancel"
        case "idle": key = "macos.idle"
        case "orphaned": key = "macos.disconnected"
        default: return status
        }
        return BridgeAppLocalization.string(key, locale: locale)
    }

    static func symbol(_ status: String) -> String {
        switch status {
        case "running", "background-process-running": return "play.circle.fill"
        case "input-required": return "text.bubble.fill"
        case "approval-required": return "checkmark.shield.fill"
        case "completed": return "checkmark.circle.fill"
        case "idle": return "pause.circle"
        case "terminating": return "stop.circle"
        default: return "exclamationmark.circle.fill"
        }
    }

    static func color(_ status: String) -> Color {
        switch status {
        case "running", "background-process-running": return .blue
        case "completed": return .green
        case "idle": return .secondary
        case "input-required", "approval-required", "terminating": return .orange
        default: return .red
        }
    }
}

enum DashboardLink {
    private static let codexApplicationBundleIdentifiers = Set(["com.openai.codex"])

    static func conversation(_ value: String?) -> URL? {
        guard let value,
              let url = URL(string: value),
              url.scheme?.lowercased() == "https",
              url.host?.lowercased() == "chatgpt.com",
              url.user == nil,
              url.password == nil,
              url.port == nil,
              url.query == nil,
              url.fragment == nil,
              let urlComponents = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let components = url.pathComponents.filter { $0 != "/" }
        guard components.count == 2,
              components[0] == "c",
              UUID(uuidString: components[1]) != nil,
              urlComponents.percentEncodedPath == "/c/\(components[1])" else {
            return nil
        }
        return url
    }

    static func codexThread(_ value: String?) -> URL? {
        guard let value,
              let url = URL(string: value),
              url.scheme?.lowercased() == "codex",
              url.host?.lowercased() == "threads",
              url.user == nil,
              url.password == nil,
              url.port == nil,
              url.query == nil,
              url.fragment == nil,
              let urlComponents = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let components = url.pathComponents.filter { $0 != "/" }
        guard components.count == 1,
              UUID(uuidString: components[0]) != nil,
              urlComponents.percentEncodedPath == "/\(components[0])" else {
            return nil
        }
        return url
    }

    static func availableCodexThread(_ value: String?) -> URL? {
        guard let url = codexThread(value),
              let applicationURL = NSWorkspace.shared.urlForApplication(toOpen: url),
              let bundleIdentifier = Bundle(url: applicationURL)?.bundleIdentifier,
              codexApplicationBundleIdentifiers.contains(bundleIdentifier) else {
            return nil
        }
        return url
    }
}

enum DashboardHistoryActivityHeading: Equatable {
    case none
    case boundary
    case title(String)
}

struct DashboardHistoryItem {
    let turn: DashboardTurn
    let heading: DashboardHistoryActivityHeading
}

enum DashboardHistoryPresentation {
    static func items(
        history: [DashboardTurn],
        latestTurn: DashboardTurn?,
        enclosingActivityKey: String?,
        enclosingActivityTitle: String?
    ) -> [DashboardHistoryItem] {
        var previousTurn = latestTurn
        var items: [DashboardHistoryItem] = []
        for turn in history {
            items.append(DashboardHistoryItem(
                turn: turn,
                heading: heading(
                    for: turn,
                    previousTurn: previousTurn,
                    enclosingActivityKey: enclosingActivityKey,
                    enclosingActivityTitle: enclosingActivityTitle
                )
            ))
            previousTurn = turn
        }
        return items
    }

    static func heading(
        for turn: DashboardTurn,
        previousTurn: DashboardTurn?,
        enclosingActivityKey: String?,
        enclosingActivityTitle: String?
    ) -> DashboardHistoryActivityHeading {
        let currentIdentity = activityIdentity(
            key: turn.activityKey,
            title: turn.activityTitle
        )
        let previousIdentity = previousTurn.flatMap {
            activityIdentity(key: $0.activityKey, title: $0.activityTitle)
        } ?? activityIdentity(key: enclosingActivityKey, title: enclosingActivityTitle)
        if currentIdentity == previousIdentity { return .none }

        guard let title = nonEmpty(turn.activityTitle) else { return .boundary }
        if title == nonEmpty(previousTurn?.activityTitle) ||
            title == nonEmpty(enclosingActivityTitle) {
            return .boundary
        }
        return .title(title)
    }

    private static func activityIdentity(key: String?, title: String?) -> String? {
        if let key = nonEmpty(key) { return "key:\(key)" }
        if let title = nonEmpty(title) { return "legacy-title:\(title)" }
        return nil
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

enum DashboardExecutionPresentation {
    static func next(
        current: DashboardExecution?,
        latest: DashboardExecution?
    ) -> DashboardExecution? {
        guard let current, current.isCurrent else { return nil }
        guard let latest else { return current }
        return matches(current, latest) ? nil : current
    }

    static func matches(_ left: DashboardExecution, _ right: DashboardExecution) -> Bool {
        normalized(left.model) == normalized(right.model) &&
            !normalized(left.model).isEmpty &&
            normalized(left.reasoningEffort) == normalized(right.reasoningEffort) &&
            !normalized(left.reasoningEffort).isEmpty &&
            normalizedServiceTier(left.serviceTier) == normalizedServiceTier(right.serviceTier) &&
            normalized(left.reroutedModel ?? "") == normalized(right.reroutedModel ?? "")
    }

    static func usesFastProcessing(_ execution: DashboardExecution?) -> Bool {
        normalizedServiceTier(execution?.serviceTier) == "fast"
    }

    private static func normalizedServiceTier(_ value: String?) -> String {
        let tier = normalized(value ?? "")
        if tier == "priority" { return "fast" }
        return tier.isEmpty ? "default" : tier
    }

    static func text(
        _ execution: DashboardExecution,
        locale: Locale = Locale(identifier: "ko")
    ) -> String {
        let model = execution.modelDisplayName ?? execution.model
        let effort = BridgeAppLocalization.reasoningEffortLabel(
            execution.reasoningEffort,
            locale: locale
        )
        let actualModel = (execution.reroutedModelDisplayName ?? execution.reroutedModel)
            .map { "\(model) → \($0)" } ?? model
        return "\(actualModel) · \(effort)"
    }

    static func turnText(
        _ execution: DashboardExecution?,
        locale: Locale = Locale(identifier: "ko")
    ) -> String {
        execution.map { text($0, locale: locale) } ?? BridgeAppLocalization.string(
            "macos.modelreasoningunavailable",
            locale: locale
        )
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

private func cancellationTargetLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "activity": key = "Activity"
    case "job": key = "macos.task"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func cancellationStatusLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "requested": key = "macos.requested"
    case "succeeded": key = "macos.processed"
    case "failed": key = "macos.failed"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}
