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
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @State private var showForceStopConfirmation = false
    @State private var showForceRestartConfirmation = false
    @State private var showRepairConfirmation = false
    @State private var showApplicationQuitConfirmation = false
    @State private var idleSectionExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            header
            if let problem = model.operationalProblem {
                Button {
                    model.showOperationalProblem(problem)
                } label: {
                    Label(BridgeAppLocalization.string(problem.messageKey, locale: model.interfaceLocale),
                        systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
            Divider()
            Group {
                if !model.hasConnectionTarget {
                    runtimeUnavailableView
                } else if model.needsSetup {
                    ConnectionRepairView()
                } else if !model.bridgeConnected, model.isBridgeConnectionChecking {
                    connectionCheckingView
                } else if !model.bridgeConnected {
                    runtimeUnavailableView
                } else if let dashboard = model.dashboard {
                    dashboardContent(dashboard)
                } else {
                    loadingView
                }
            }
            Divider()
            footer
        }
        .frame(width: 460, height: 660)
        .environment(\.locale, model.interfaceLocale)
        .task {
            if model.isRemoteClient {
                await model.refreshAll()
            } else if model.helperStatus == nil {
                await model.start()
            } else {
                await model.refreshStatus()
                await model.refreshAuthStatus()
                await model.refreshDashboard()
            }
        }
        .confirmationDialog(
            "작업과 백그라운드 프로세스를 중단하고 서버를 강제 종료할까요?",
            isPresented: $showForceStopConfirmation
        ) {
            Button("강제 종료", role: .destructive) {
                Task { await model.stopRuntime(force: true) }
            }
        } message: {
            Text(forceImpactMessage(restarting: false))
        }
        .confirmationDialog(
            "작업과 백그라운드 프로세스를 중단하고 서버를 강제 재시작할까요?",
            isPresented: $showForceRestartConfirmation
        ) {
            Button("강제 재시작", role: .destructive) {
                Task { await model.restartRuntime(force: true) }
            }
        } message: {
            Text(forceImpactMessage(restarting: true))
        }
        .confirmationDialog(
            "Secure MCP Tunnel 프로필을 다시 만들까요?",
            isPresented: $showRepairConfirmation
        ) {
            Button("작업을 마치고 프로필 복구") {
                Task { await model.repairTunnelProfile() }
            }
        } message: {
            Text("private .env와 Bridge 상태는 유지하고, 현재 Tunnel ID로 로컬 프로필만 다시 만듭니다.")
        }
        .confirmationDialog(
            "앱과 관련 프로세스를 모두 종료할까요?",
            isPresented: $showApplicationQuitConfirmation
        ) {
            Button("작업을 마치고 종료") {
                shutdownAndQuit(force: false)
            }
            Button("강제 종료", role: .destructive) {
                shutdownAndQuit(force: true)
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text(applicationQuitImpactMessage)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            BridgeBrandStatusIcon(health: model.health, size: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Codex MCP Bridge for ChatGPT")
                    .font(.headline)
                Text("\(model.connectionTargetName) · \(model.health.accessibilityLabel(locale: model.interfaceLocale))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.isBusy { ProgressView().controlSize(.small) }
            Button {
                Task {
                    await model.refreshStatus()
                    await model.refreshAuthStatus()
                    await model.refreshDashboard()
                }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("새로고침")
            .accessibilityLabel("현황 새로고침")
        }
        .padding(14)
    }

    private var loadingView: some View {
        VStack(spacing: 12) {
            BridgeBrandMark()
                .frame(width: 42, height: 42)
            ProgressView()
            Text("현황을 불러오는 중…")
                .foregroundStyle(.secondary)
            if let error = model.connectionErrorMessage ?? model.startupErrorMessage ??
                model.statusErrorMessage ?? model.dashboardErrorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                Button(BridgeAppLocalization.string(
                    model.isRemoteClient ? "서버 다시 연결" : "helper 다시 연결",
                    locale: model.interfaceLocale
                )) {
                    Task {
                        if model.isRemoteClient { await model.refreshAll() }
                        else { await model.start() }
                    }
                }
                .disabled(model.isBusy)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var connectionCheckingView: some View {
        VStack(spacing: 12) {
            BridgeBrandStatusIcon(health: .checking, size: 48)
            ProgressView()
            Text("브리지 연결을 확인하고 있습니다…")
                .font(.headline)
            Text("연결되는 대로 현황을 표시합니다.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(28)
    }

    private var runtimeUnavailableView: some View {
        VStack(spacing: 14) {
            BridgeBrandStatusIcon(health: .unavailable, size: 48)
            Text("브리지 서버에 연결할 수 없습니다")
                .font(.headline)
            Text(model.connectionErrorMessage ?? model.helperStatusErrorMessage ??
                 model.runtimeErrorMessage ?? model.statusErrorMessage ??
                 BridgeAppLocalization.string(
                    model.isRemoteClient
                        ? "연결 탭에서 서버를 선택하거나 페어링해 주세요."
                        : "브리지 서버가 중지되었습니다.",
                    locale: model.interfaceLocale
                 ))
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            if model.isRemoteClient {
                HStack {
                    Button("다시 연결") { Task { await model.refreshAll() } }
                        .buttonStyle(.borderedProminent)
                    Button("연결 설정") { presentSettingsWindow() }
                }
                .disabled(model.isBusy)
            } else {
                HStack {
                    Button("시작") { Task { await model.startRuntime() } }
                        .buttonStyle(.borderedProminent)
                    Button("재시작") { Task { await model.restartRuntime(force: false) } }
                }
                .disabled(model.isBusy)
                Button("Tunnel 프로필 복구…") { showRepairConfirmation = true }
                    .disabled(model.isBusy)
            }
            if !model.isRemoteClient, model.helperStatus?.phase == "safe-mode" {
                Label("반복 충돌로 자동 재시작이 중지되었습니다.", systemImage: "exclamationmark.octagon")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(28)
    }

    private func dashboardContent(_ dashboard: DashboardSnapshot) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                Text("이 개인 브리지가 보존 중인 작업·Agent·대화만 표시합니다. 전체 ChatGPT 기록은 아닙니다.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if shouldOfferCodexThreadPersistence {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(
                            "새 Agent 작업을 Codex 앱에서 열 수 있게 할까요?",
                            systemImage: "arrow.up.forward.app"
                        )
                        .font(.caption.weight(.semibold))
                        Text("켜면 이후 새 작업과 새 컨텍스트를 Codex 앱에 보존하고 각 Agent의 Codex 대화를 열 수 있습니다. 기존 임시 작업에는 소급 적용되지 않습니다.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Button("새 작업부터 켜기") {
                            model.enableCodexThreadPersistence()
                        }
                        .buttonStyle(.link)
                        .disabled(model.generalSettingsSaveState.isActive)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                }
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
                        "최근 현황을 갱신하지 못했습니다: \(error)",
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
                            "Secure MCP Tunnel 연결을 확인하고 있습니다.",
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
                if let account = dashboard.codexAccount {
                    CodexMenuAccountView(account: account, fallbackWeekly: dashboard.weeklyUsage)
                } else if let usage = dashboard.weeklyUsage, model.shouldShowCodexWeeklyUsage {
                    WeeklyUsageView(usage: usage)
                }
                CountsGrid(counts: dashboard.counts)
                DashboardSection(
                    title: "활성",
                    emptyText: "현재 활성 Agent가 없습니다.",
                    rows: dashboard.activeRows,
                    total: dashboard.pagination.active.total,
                    groupsByActivity: true
                )
                if dashboard.pagination.active.hasNext {
                    Label(
                        "활성 항목 중 \(dashboard.pagination.active.returned)개만 표시됩니다.",
                        systemImage: "ellipsis.circle"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                DashboardSection(
                    title: "최근 활동",
                    emptyText: "보존된 최근 실행이 없습니다.",
                    rows: dashboard.terminalRows,
                    total: dashboard.pagination.terminal.total,
                    groupsByActivity: true,
                    hasMore: dashboard.pagination.terminal.hasNext,
                    loadMore: { Task { await model.loadMoreRecent() } }
                )
                DashboardSection(
                    title: "유휴 에이전트",
                    emptyText: "유휴 에이전트가 없습니다.",
                    rows: dashboard.idleRows,
                    total: dashboard.pagination.idle.total,
                    groupsByActivity: true,
                    marksRecentActivity: true,
                    hasMore: dashboard.pagination.idle.hasNext,
                    disclosureExpanded: $idleSectionExpanded,
                    loadMore: { Task { await model.loadMoreIdle() } }
                )
            }
            .padding(14)
        }
    }

    private var authenticationNotice: String {
        let key: String
        if model.authErrorMessage != nil {
            key = "Codex 로그인 상태를 확인하지 못했습니다. 연결 설정을 확인하세요."
        } else if model.authStatus?.installed == false {
            key = "Codex CLI를 찾을 수 없습니다. 연결 설정을 확인하세요."
        } else {
            key = "Codex 로그인이 필요합니다. 첫 작업 전에 로그인하세요."
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
                presentSettingsWindow()
            } label: {
                Label("설정", systemImage: "gearshape")
            }
            .keyboardShortcut(",")

            if !model.isRemoteClient, model.codexRuntime?.showsMenuUpdate == true,
               model.helperStatus?.configuration.operatorConfiguration.defaultBackend != "codex-sdk" {
                Button("코덱스 업데이트") {
                    Task { await model.manageCodex(.init(action: "update")) }
                }
            }

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
                    Button("서버 연결 관리") { presentSettingsWindow() }
                } label: {
                    Label(model.connectionTargetName, systemImage: "network")
                }
                .disabled(model.isBusy)
            } else {
                Menu {
                    Button("작업 완료 후 서버 재시작") {
                        Task { await model.restartRuntime(force: false) }
                    }
                    Button("작업 중단 후 서버 강제 재시작", role: .destructive) {
                        Task {
                            await model.refreshRuntimeImpact()
                            showForceRestartConfirmation = true
                        }
                    }
                    Divider()
                    Button("연결 정보 및 Codex 로그인") {
                        presentConnectionRepairWindow()
                    }
                    Button("Secure MCP Tunnel 프로필 복구") {
                        showRepairConfirmation = true
                    }
                    Divider()
                    Button("작업 완료 후 서버 중지") {
                        Task { await model.stopRuntime(force: false) }
                    }
                    Button("작업 중단 후 서버 강제 중지", role: .destructive) {
                        Task {
                            await model.refreshRuntimeImpact()
                            showForceStopConfirmation = true
                        }
                    }
                } label: {
                    Label("서버", systemImage: "server.rack")
                }
                .disabled(model.needsSetup || model.isBusy)
            }

            Spacer()
            Button(BridgeAppLocalization.string(
                model.isRemoteClient ? "앱 종료" : "앱 종료…",
                locale: model.interfaceLocale
            )) {
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
            }
            .disabled(model.isBusy)
            .help(BridgeAppLocalization.string(
                model.isRemoteClient
                    ? "이 클라이언트 앱만 종료하며 원격 서버는 변경하지 않습니다."
                    : "메뉴 막대 앱과 helper, 브리지 서버 및 관련 프로세스를 모두 종료합니다.",
                locale: model.interfaceLocale
            ))
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
            "활성 작업 %d개와 백그라운드 프로세스 %d개가 중단될 수 있습니다. 파일 변경은 되돌아가지 않습니다.",
            locale: model.interfaceLocale,
            activeJobCount,
            backgroundProcessCount
        )]
        if backgroundProcessUnknownAgents > 0 {
            messages.append(BridgeAppLocalization.format(
                "%d개 Agent의 백그라운드 상태를 확인하지 못했습니다.",
                locale: model.interfaceLocale,
                backgroundProcessUnknownAgents
            ))
        }
        if model.runtimeImpactErrorMessage != nil {
            messages.append(BridgeAppLocalization.string(
                "최신 영향 범위를 확인하지 못했으므로 강제 종료 시 표시된 수보다 더 많은 작업이 중단될 수 있습니다.",
                locale: model.interfaceLocale
            ))
        }
        if restarting {
            messages.append(BridgeAppLocalization.string(
                "중단된 작업은 자동으로 다시 실행하지 않습니다.",
                locale: model.interfaceLocale
            ))
        }
        return messages.joined(separator: " ")
    }

    private var applicationQuitImpactMessage: String {
        var messages = [BridgeAppLocalization.string(
            "메뉴 막대 앱, helper, 브리지 서버와 Tunnel을 모두 종료합니다. 앱을 다시 열거나 다음 사용자 로그인 전까지 ChatGPT의 브리지 연결을 사용할 수 없습니다.",
            locale: model.interfaceLocale
        )]
        if activeJobCount > 0 || backgroundProcessCount > 0 {
            messages.append(BridgeAppLocalization.format(
                "현재 활성 작업 %d개와 백그라운드 프로세스 %d개가 있습니다. 안전 종료는 작업이 끝날 때까지 기다리며, 강제 종료는 즉시 중단합니다.",
                locale: model.interfaceLocale,
                activeJobCount,
                backgroundProcessCount
            ))
        }
        if backgroundProcessUnknownAgents > 0 {
            messages.append(BridgeAppLocalization.format(
                "%d개 Agent의 백그라운드 상태를 확인하지 못했습니다.",
                locale: model.interfaceLocale,
                backgroundProcessUnknownAgents
            ))
        }
        if model.runtimeImpactErrorMessage != nil {
            messages.append(BridgeAppLocalization.string(
                "최신 영향 범위를 확인하지 못했으므로 강제 종료 시 표시된 수보다 더 많은 작업이 중단될 수 있습니다.",
                locale: model.interfaceLocale
            ))
        }
        messages.append(BridgeAppLocalization.string(
            "파일 변경은 되돌아가지 않습니다.",
            locale: model.interfaceLocale
        ))
        return messages.joined(separator: " ")
    }

    private func shutdownAndQuit(force: Bool) {
        Task {
            guard await model.shutdownApplication(force: force) else {
                presentApplicationQuitFailure()
                return
            }
            NSApp.terminate(nil)
        }
    }

    private func presentSettingsWindow() {
        dismissMenuBarWindow()
        SettingsWindowController.shared.show(model: model)
    }

    private func presentConnectionRepairWindow() {
        dismissMenuBarWindow()
        ConnectionRepairWindowController.shared.show(model: model)
    }

    private func dismissMenuBarWindow() {
        let menuBarWindow = NSApp.keyWindow
        dismiss()
        menuBarWindow?.orderOut(nil)
    }

    private func presentApplicationQuitFailure() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        let title = model.generalSettingsSaveState == .failed
            ? "설정 변경사항을 저장하지 못했습니다"
            : "앱을 종료하지 못했습니다"
        alert.messageText = BridgeAppLocalization.string(title, locale: model.interfaceLocale)
        alert.informativeText = model.runtimeErrorMessage ?? BridgeAppLocalization.string(
            "앱을 종료하지 않았습니다. 현황을 확인한 뒤 다시 시도해 주세요.",
            locale: model.interfaceLocale
        )
        alert.addButton(withTitle: BridgeAppLocalization.string(
            "확인",
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
                Text("주간 사용량").font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(Int(remainingPercent.rounded()))% 남음")
                    .font(.caption.monospacedDigit())
            }
            ProgressView(value: remainingPercent, total: 100)
            if let resetsAt = usage.resetsAt {
                Text("초기화: \(DisplayFormat.dateTime(resetsAt, locale: locale))")
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
                    Text("API 사용 중").font(.subheadline.weight(.semibold))
                    if let costs = account.billing?.actualCosts, costs.configured {
                        if costs.status == "available", let usd = costs.usd {
                            LabeledContent(costs.projectId == nil ? "이번 달 조직 비용 (UTC)" : "이번 달 프로젝트 비용 (UTC)",
                                value: usd.formatted(.currency(code: "USD")))
                        } else { Text("비용 정보를 확인할 수 없습니다.") }
                    }
                } else if account.authMode == "chatgpt" {
                    Text("사용량 정보를 확인할 수 없습니다.")
                    CodexMenuPlanDetails(account: account)
                } else { Text("로그인이 필요합니다") }
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
        if !account.menuSparkWindows.isEmpty {
            Divider().padding(.vertical, 3)
            Text(verbatim: "GPT-5.3-Codex-Spark").font(.caption.weight(.semibold))
            ForEach(account.menuSparkWindows) { window in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        if window.windowDurationMins == 10080 { Text("주간 사용량") }
                        else { Text(Duration.seconds(Int64(window.windowDurationMins * 60)).formatted(.units(allowed: [.days, .hours, .minutes], width: .abbreviated))) }
                        Spacer()
                        Text(min(99.9, floor(max(0, window.remainingPercent) * 10) / 10) / 100,
                            format: .percent.precision(.fractionLength(0...1))).monospacedDigit()
                        Text("남음")
                    }.font(.caption)
                    ProgressView(value: max(0, min(100, window.remainingPercent)), total: 100)
                }
            }
        }
        if let balance = account.menuCreditBalance {
            HStack {
                Text("추가 크레딧")
                Text("잔액")
                Spacer()
                Text(verbatim: balance).monospacedDigit()
            }.font(.caption)
        }
        if (account.weeklyUsage?.remainingPercent ?? 0) > 0,
           account.windows.contains(where: { $0.limitId == "codex" && $0.windowDurationMins != 10080 && $0.remainingPercent <= 0 }) {
            Label("단기 사용 한도에 도달했습니다.", systemImage: "exclamationmark.triangle")
                .font(.caption).foregroundStyle(.orange)
        }
    }
}

private struct CountsGrid: View {
    let counts: DashboardCounts
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            CountTile(title: "실행 중", value: counts.running, symbol: "play.fill")
            CountTile(title: "입력 필요", value: counts.inputRequired, symbol: "text.bubble.fill")
            CountTile(title: "승인 필요", value: counts.approvalRequired, symbol: "checkmark.shield.fill")
            CountTile(title: "종료 중", value: counts.terminating, symbol: "stop.circle.fill")
            CountTile(title: "주의", value: counts.needsAttention, symbol: "exclamationmark.triangle.fill")
            CountTile(title: "백그라운드", value: counts.backgroundProcesses, symbol: "terminal.fill")
            CountTile(title: "유휴", value: counts.idleAgents, symbol: "pause.fill")
        }
        HStack {
            Label("프로젝트 \(counts.trackedProjects)", systemImage: "folder")
            Spacer()
            Label("대화 \(counts.trackedConversations)", systemImage: "bubble.left.and.bubble.right")
            Spacer()
            Label("실행 기록 \(counts.retainedJobs)", systemImage: "clock.arrow.circlepath")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

private struct CountTile: View {
    @Environment(\.locale) private var locale
    let title: String
    let value: Int
    let symbol: String

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: symbol)
                Text(BridgeAppLocalization.string(title, locale: locale)).lineLimit(1)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            Text("\(value)")
                .font(.title3.bold().monospacedDigit())
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
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
                    Button("더 보기", action: { loadMore?() })
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
                disclosureExpanded.wrappedValue ? "펼침" : "접힘",
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
                Text("\(total)")
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
                            Text("최근 Activity")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Text(activityTitle)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                        Text(first.projectName ?? BridgeAppLocalization.string(
                            "프로젝트 없음",
                            locale: locale
                        ))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let url = DashboardLink.conversation(first.conversationUrl) {
                        Link("대화", destination: url)
                    }
                }
                Text("Agent \(group.rows.count)명")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if let cancellation = activityCancellation {
                    CancellationDisclosure(cancellation: cancellation)
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
            marksRecentActivity ? "최근 Activity 없음" : "제목 없는 Activity",
            locale: locale
        )
    }
}

private enum DashboardRowPresentation {
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

private struct CancellationDisclosure: View {
    @Environment(\.locale) private var locale
    let cancellation: CancellationDisplay
    @State private var isExpanded = false

    var body: some View {
        FullRowDisclosure("취소 사유", isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 3) {
                Text(cancellation.reason).textSelection(.enabled)
                Text("\(cancellationTargetLabel(cancellation.targetKind, locale: locale)) · \(cancellationStatusLabel(cancellation.status, locale: locale)) · \(DisplayFormat.dateTime(cancellation.requestedAt, locale: locale))")
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
        }
        .font(.caption)
    }
}

private struct DashboardRowView: View {
    @EnvironmentObject private var model: AppModel
    let row: DashboardRow
    let presentation: DashboardRowPresentation
    let enclosingActivityTitle: String?
    @State private var historyExpanded = false

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
                Text(BridgeAppLocalization.format(
                    "%@: %@",
                    locale: model.interfaceLocale,
                    BridgeAppLocalization.string(
                        row.bucket == "idle" ? "최근 실행" : "실행",
                        locale: model.interfaceLocale
                    ),
                    DashboardExecutionPresentation.turnText(
                        row.latestTurn?.execution,
                        locale: model.interfaceLocale
                    )
                ))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let tokens = row.tokenUsage {
                DisclosureGroup("세션 누적 토큰") {
                    LabeledContent("입력 토큰", value: tokens.inputTokens.formatted())
                    LabeledContent("캐시 토큰", value: tokens.cachedInputTokens.formatted())
                    LabeledContent("출력 토큰", value: tokens.outputTokens.formatted())
                }
            }
            if let next = nextExecution {
                Text(BridgeAppLocalization.format(
                    "다음 실행 설정: %@",
                    locale: model.interfaceLocale,
                    executionText(next)
                ))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(rowTimeText)
                    .lineLimit(2)
                HStack(spacing: 10) {
                    if row.backgroundProcessCount > 0 {
                        Label("\(row.backgroundProcessCount)", systemImage: "terminal")
                    }
                    Spacer()
                    if presentation == .idle {
                        if let url = DashboardLink.conversation(row.conversationUrl) {
                            Link("대화", destination: url)
                        }
                    }
                    if !model.isRemoteClient,
                       let url = DashboardLink.availableCodexThread(row.codexThreadUrl) {
                        Button {
                            NSWorkspace.shared.open(url)
                        } label: {
                            Label("Codex 대화 열기", systemImage: "arrow.up.forward.app")
                        }
                        .buttonStyle(.link)
                        .help("Codex 앱에서 이 Agent의 대화를 엽니다.")
                    }
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            if let cancellation = row.latestTurn?.cancellation,
               presentation == .idle || cancellation.targetKind != "activity" {
                CancellationDisclosure(cancellation: cancellation)
            }
            if let history = row.history, !history.isEmpty {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        historyExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(historyExpanded ? 90 : 0))
                            .accessibilityHidden(true)
                        Text("최근 실행 기록 \(row.historyCount ?? history.count)")
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .font(.caption)
                .accessibilityValue(BridgeAppLocalization.string(
                    historyExpanded ? "펼침" : "접힘",
                    locale: model.interfaceLocale
                ))

                if historyExpanded {
                    VStack(alignment: .leading, spacing: 6) {
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
                                        Text("이전 Activity")
                                            .font(.caption2.weight(.medium))
                                            .foregroundStyle(.secondary)
                                    case .title(let title):
                                        Text(title)
                                            .fontWeight(.semibold)
                                    }
                                    Text(turnTimeText(item.turn))
                                        .foregroundStyle(.secondary)
                                    Text(DashboardExecutionPresentation.turnText(
                                        item.turn.execution,
                                        locale: model.interfaceLocale
                                    ))
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                    if let cancellation = item.turn.cancellation {
                                        Text(cancellation.reason)
                                            .foregroundStyle(.secondary)
                                        Text("\(cancellationTargetLabel(cancellation.targetKind, locale: model.interfaceLocale)) · \(cancellationStatusLabel(cancellation.status, locale: model.interfaceLocale))")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
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
            "\(row.agentName), \(row.activityTitle ?? "Activity"), \(StatusPresentation.label(row.status, locale: model.interfaceLocale))"
        )
    }

    private var secondaryTitle: String? {
        if presentation == .idle {
            let activity = row.latestTurn?.activityTitle ?? row.activityTitle ??
                BridgeAppLocalization.string("최근 Activity 없음", locale: model.interfaceLocale)
            let project = row.projectName ??
                BridgeAppLocalization.string("프로젝트 없음", locale: model.interfaceLocale)
            return "\(activity) · \(project)"
        }
        return nil
    }

    private var nextExecution: DashboardExecution? {
        return DashboardExecutionPresentation.next(
            current: row.execution,
            latest: row.latestTurn?.execution
        )
    }

    private var historyItems: [DashboardHistoryItem] {
        DashboardHistoryPresentation.items(
            history: row.history ?? [],
            latestTurn: row.latestTurn,
            enclosingActivityKey: row.activityKey,
            enclosingActivityTitle: enclosingActivityTitle ?? row.activityTitle
        )
    }

    private func executionText(_ execution: DashboardExecution) -> String {
        DashboardExecutionPresentation.text(execution, locale: model.interfaceLocale)
    }

    private var rowTimeText: String {
        let workTime: String
        if row.bucket == "active" {
            workTime = BridgeAppLocalization.format(
                "작업시간 %@",
                locale: model.interfaceLocale,
                DisplayFormat.duration(row.elapsedMs, locale: model.interfaceLocale)
            )
        } else if let duration = row.latestTurn?.durationMs {
            workTime = BridgeAppLocalization.format(
                "작업시간 %@",
                locale: model.interfaceLocale,
                DisplayFormat.duration(duration, locale: model.interfaceLocale)
            )
        } else {
            workTime = BridgeAppLocalization.string(
                "작업시간 확인 불가",
                locale: model.interfaceLocale
            )
        }
        guard row.bucket != "active" else { return workTime }
        let lastWorkedAt = row.latestTurn?.endedAt ?? row.latestTurn?.updatedAt ?? row.updatedAt
        return "\(workTime) · \(DisplayFormat.relative(lastWorkedAt, locale: model.interfaceLocale))"
    }

    private func turnTimeText(_ turn: DashboardTurn) -> String {
        var values = [StatusPresentation.label(turn.status, locale: model.interfaceLocale)]
        if let duration = turn.durationMs {
            values.append(BridgeAppLocalization.format(
                "작업시간 %@",
                locale: model.interfaceLocale,
                DisplayFormat.duration(duration, locale: model.interfaceLocale)
            ))
        } else {
            values.append(BridgeAppLocalization.string(
                "작업시간 확인 불가",
                locale: model.interfaceLocale
            ))
        }
        values.append(DisplayFormat.relative(
            turn.endedAt ?? turn.updatedAt,
            locale: model.interfaceLocale
        ))
        return values.joined(separator: " · ")
    }
}

struct ConnectionRepairView: View {
    @EnvironmentObject private var model: AppModel
    @State private var apiKey = ""
    @State private var tunnelId = ""
    @State private var pasteMessage: String?
    @State private var discoveredSettingsExpanded = false
    @State private var diagnosticLogsExpanded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    BridgeBrandStatusIcon(health: model.health, size: 34)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Codex MCP Bridge for ChatGPT")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("최초 연결 또는 복구")
                            .font(.title3.bold())
                    }
                }
                Text("기존 private .env가 유효하면 그대로 사용합니다. Keychain은 사용하지 않습니다.")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                GroupBox("연결 상태") {
                    VStack(alignment: .leading, spacing: 7) {
                        LabeledContent(
                            "Bridge",
                            value: BridgeAppLocalization.string(
                                model.helperStatus?.bridge.connected == true ? "준비됨" : "연결 안 됨",
                                locale: model.interfaceLocale
                            )
                        )
                        LabeledContent(
                            "Secure MCP Tunnel",
                            value: BridgeAppLocalization.string(
                                model.helperStatus?.tunnel.connected == true ? "연결됨" : "연결 안 됨",
                                locale: model.interfaceLocale
                            )
                        )
                        if let profile = model.helperStatus?.tunnel.profile {
                            LabeledContent("프로필", value: profile)
                        }
                        if model.isTunnelConnectionChecking {
                            Label(
                                "Secure MCP Tunnel 연결을 확인하고 있습니다.",
                                systemImage: "arrow.triangle.2.circlepath"
                            )
                                .font(.caption)
                                .foregroundStyle(.blue)
                        } else if let error = model.tunnelStatusErrorMessage {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(.orange)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.top, 4)
                }

                GroupBox("Secure MCP Tunnel") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Runtime API 키와 Tunnel을 OpenAI Platform에서 만든 뒤 연결합니다.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(spacing: 12) {
                                Link(
                                    "Runtime API 키 만들기",
                                    destination: URL(
                                        string: "https://platform.openai.com/settings/organization/api-keys"
                                    )!
                                )
                                Link(
                                    "Tunnel 만들기",
                                    destination: URL(
                                        string: "https://platform.openai.com/settings/organization/tunnels"
                                    )!
                                )
                                Spacer()
                            }
                            Button("기존 설정 다시 찾기") {
                                Task { await model.refreshSetupDiscovery() }
                            }
                            .disabled(model.isBusy)
                        }

                        if let candidates = model.setupDiscovery?.candidates,
                           !candidates.isEmpty {
                            FullRowDisclosure(
                                "기존 설정 가져오기",
                                isExpanded: $discoveredSettingsExpanded
                            ) {
                                VStack(alignment: .leading, spacing: 8) {
                                    ForEach(candidates) { candidate in
                                        HStack(alignment: .center, spacing: 10) {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(candidateSourceLabel(candidate))
                                                    .font(.caption.weight(.semibold))
                                                Text(candidate.tunnelId)
                                                    .font(.caption2.monospaced())
                                                    .textSelection(.enabled)
                                                Text(
                                                    candidate.hasApiKey
                                                        ? "Runtime API 키 사용 가능"
                                                        : "Tunnel ID만 발견"
                                                )
                                                .font(.caption2)
                                                .foregroundStyle(.secondary)
                                            }
                                            Spacer()
                                            Button(
                                                candidateCanConnect(candidate)
                                                    ? "가져와 연결"
                                                    : "Tunnel ID 사용"
                                            ) {
                                                useDiscoveredCandidate(candidate)
                                            }
                                            .disabled(model.isBusy)
                                        }
                                        .padding(8)
                                        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                                    }
                                }
                                .padding(.top, 6)
                            }
                        }
                        if let discoveryError = model.setupDiscoveryErrorMessage {
                            Text(discoveryError)
                                .font(.caption2)
                                .foregroundStyle(.orange)
                                .textSelection(.enabled)
                        }

                        if let currentTunnelID = model.helperStatus?.configuration.tunnelId {
                            LabeledContent("현재 Tunnel ID") {
                                HStack(spacing: 8) {
                                    Text(currentTunnelID)
                                        .font(.caption.monospaced())
                                        .textSelection(.enabled)
                                    Button {
                                        NSPasteboard.general.clearContents()
                                        NSPasteboard.general.setString(currentTunnelID, forType: .string)
                                    } label: {
                                        Image(systemName: "doc.on.doc")
                                    }
                                    .buttonStyle(.borderless)
                                    .help("Tunnel ID 복사")
                                    .accessibilityLabel("Tunnel ID 복사")
                                }
                            }
                        }
                        SecureField(
                            BridgeAppLocalization.string(
                                model.helperStatus?.configuration.hasApiKey == true
                                    ? "새 키를 입력할 때만 교체"
                                    : "Runtime API key",
                                locale: model.interfaceLocale
                            ),
                            text: $apiKey
                        )
                        TextField("tunnel_…", text: $tunnelId)
                        Button("클립보드에서 두 값 가져오기") {
                            importSetupFromPasteboard()
                        }
                        .disabled(model.isBusy)
                        if let pasteMessage {
                            Text(pasteMessage)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Text("Tunnel ID는 tunnel_ 다음에 영문 소문자 또는 숫자 32자로 입력합니다.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text("저장 위치: \(model.helperStatus?.configuration.path ?? "~/.config/codex-mcp-bridge/.env")")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        if let issue = model.runtimeConfigurationIssueMessage {
                            Label(
                                issue,
                                systemImage: "exclamationmark.triangle"
                            )
                                .font(.caption)
                                .foregroundStyle(.orange)
                            if model.helperStatus?.configuration.issueProblem?.code ==
                                "runtime-env-permissions-too-broad" ||
                                model.helperStatus?.configuration.issue?.contains(
                                    "permissions are too broad"
                                ) == true {
                                Button("앱 전용 권한으로 복구") {
                                    Task { await model.repairConfigurationPermissions() }
                                }
                                .disabled(model.isBusy)
                            }
                        }
                        Button("안전하게 저장하고 연결") {
                            Task {
                                if await model.saveSetup(apiKey: apiKey, tunnelId: tunnelId) {
                                    apiKey = ""
                                    tunnelId = ""
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(
                            model.isBusy ||
                            (!(model.helperStatus?.configuration.hasApiKey ?? false) && apiKey.isEmpty) ||
                            !tunnelIDInputIsValid
                        )
                    }
                    .padding(.top, 4)
                }

                GroupBox("Codex 로그인") {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(
                            codexLoginStatusText,
                            systemImage: model.authStatus?.authenticated == true
                                ? "checkmark.circle.fill"
                                : "person.crop.circle.badge.exclamationmark"
                        )
                        .font(.caption)
                        HStack {
                            Button("Codex 브라우저 로그인 시작") {
                                Task { await model.launchCodexLogin() }
                            }
                            .disabled(
                                model.isBusy ||
                                model.loginInProgress ||
                                model.authStatus?.authenticated == true ||
                                (model.authStatus == nil && model.authErrorMessage == nil)
                            )
                            Button("상태 새로고침") {
                                Task { await model.refreshAuthStatus() }
                            }
                            .disabled(model.isBusy)
                        }
                        if let error = model.authErrorMessage {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.red)
                                .textSelection(.enabled)
                        }
                    }
                }

                GroupBox("연결 후 다음 단계") {
                    VStack(alignment: .leading, spacing: 7) {
                        Label("앱이 Tunnel 프로필을 확인하고 Bridge 서버를 시작합니다.", systemImage: "1.circle")
                        Label("ChatGPT Developer mode에서 이 Tunnel을 No Auth로 연결합니다.", systemImage: "2.circle")
                        Label("설정 창의 프로젝트 탭에서 첫 작업 폴더를 등록합니다.", systemImage: "3.circle")
                    }
                    .font(.caption)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 3)
                }

                FullRowDisclosure(
                    "진단 로그 (민감정보 가림)",
                    isExpanded: $diagnosticLogsExpanded
                ) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Button("로그 새로고침") { Task { await model.refreshLogs() } }
                            Spacer()
                        }
                        if model.logs.isEmpty {
                            Text("표시할 helper 또는 runtime 로그가 없습니다.")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(model.logs) { entry in
                                Text("\(DisplayFormat.dateTime(entry.at, locale: model.interfaceLocale)) · \(entry.source): \(entry.message)")
                                    .textSelection(.enabled)
                            }
                        }
                        if let error = model.logsErrorMessage {
                            Text(error).foregroundStyle(.red).textSelection(.enabled)
                        }
                    }
                    .font(.caption2.monospaced())
                    .padding(.top, 4)
                }

                if let error = model.runtimeErrorMessage ?? model.startupErrorMessage ?? model.statusErrorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }
            .padding(18)
        }
        .environment(\.locale, model.interfaceLocale)
        .task {
            await model.refreshAuthStatus()
            await model.refreshSetupDiscovery()
        }
    }

    private var codexLoginStatusText: String {
        let key: String
        if model.loginInProgress {
            key = "브라우저 로그인을 기다리고 있습니다."
        } else if model.authErrorMessage != nil {
            key = "Codex 로그인 상태를 확인하지 못했습니다. 연결 설정을 확인하세요."
        } else if let status = model.authStatus {
            if !status.installed {
                key = "Codex CLI를 찾을 수 없습니다. 연결 설정을 확인하세요."
            } else if status.authenticated {
                key = "Codex에 로그인되어 있습니다."
            } else {
                key = "Codex 로그인이 필요합니다. 첫 작업 전에 로그인하세요."
            }
        } else {
            key = "로그인 상태를 확인하고 있습니다."
        }
        return BridgeAppLocalization.string(key, locale: model.interfaceLocale)
    }

    private func candidateCanConnect(_ candidate: TunnelSetupCandidate) -> Bool {
        candidate.hasApiKey || (model.helperStatus?.configuration.hasApiKey ?? false)
    }

    private func candidateSourceLabel(_ candidate: TunnelSetupCandidate) -> String {
        switch candidate.source {
        case "runtime-config":
            return BridgeAppLocalization.string(
                "기존 Bridge 연결 파일",
                locale: model.interfaceLocale
            )
        case "environment":
            return BridgeAppLocalization.string(
                "환경 변수",
                locale: model.interfaceLocale
            )
        default:
            return BridgeAppLocalization.format(
                "tunnel-client 프로필 · %@",
                locale: model.interfaceLocale,
                candidate.profileName ?? "tunnel-client"
            )
        }
    }

    private func useDiscoveredCandidate(_ candidate: TunnelSetupCandidate) {
        guard candidateCanConnect(candidate) else {
            tunnelId = candidate.tunnelId
            pasteMessage = BridgeAppLocalization.string(
                "Tunnel ID를 입력했습니다. Runtime API 키를 추가해 주세요.",
                locale: model.interfaceLocale
            )
            return
        }
        Task {
            if await model.importDiscoveredSetup(candidateId: candidate.id) {
                apiKey = ""
                tunnelId = ""
                pasteMessage = nil
            }
        }
    }

    private func importSetupFromPasteboard() {
        guard let contents = NSPasteboard.general.string(forType: .string) else {
            pasteMessage = BridgeAppLocalization.string(
                "클립보드에서 연결 정보를 찾지 못했습니다.",
                locale: model.interfaceLocale
            )
            return
        }
        let parsed = TunnelSetupInputParser.parse(contents)
        if let discoveredAPIKey = parsed.apiKey { apiKey = discoveredAPIKey }
        if let discoveredTunnelID = parsed.tunnelId { tunnelId = discoveredTunnelID }
        pasteMessage = BridgeAppLocalization.string(
            parsed.isEmpty
                ? "클립보드에서 연결 정보를 찾지 못했습니다."
                : "찾은 연결 정보를 입력했습니다.",
            locale: model.interfaceLocale
        )
    }

    private var tunnelIDInputIsValid: Bool {
        let candidate = tunnelId.trimmingCharacters(in: .whitespacesAndNewlines)
        if candidate.isEmpty {
            return model.helperStatus?.configuration.hasTunnelId ?? false
        }
        return candidate.range(
            of: #"^tunnel_[a-z0-9]{32}$"#,
            options: .regularExpression
        ) != nil
    }
}

private enum StatusPresentation {
    static func label(_ status: String, locale: Locale) -> String {
        let key: String
        switch status {
        case "running": key = "실행 중"
        case "background-process-running": key = "백그라운드 실행"
        case "input-required": key = "입력 필요"
        case "approval-required": key = "승인 필요"
        case "terminating": key = "종료 중"
        case "termination-failed": key = "종료 실패"
        case "liveness-unknown": key = "상태 불명"
        case "completed": key = "완료"
        case "failed": key = "실패"
        case "interrupted": key = "중단"
        case "cancelled": key = "취소"
        case "idle": key = "유휴"
        case "orphaned": key = "연결 끊김"
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
            normalized(left.reroutedModel ?? "") == normalized(right.reroutedModel ?? "")
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
        let current = "\(model) · \(effort)"
        guard let rerouted = execution.reroutedModelDisplayName ?? execution.reroutedModel else {
            return current
        }
        let reroute = BridgeAppLocalization.string("경로 변경", locale: locale)
        return "\(current) → \(rerouted) (\(reroute))"
    }

    static func turnText(
        _ execution: DashboardExecution?,
        locale: Locale = Locale(identifier: "ko")
    ) -> String {
        execution.map { text($0, locale: locale) } ?? BridgeAppLocalization.string(
            "모델 · 추론 확인 불가",
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
    case "job": key = "작업"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}

private func cancellationStatusLabel(_ value: String, locale: Locale) -> String {
    let key: String
    switch value {
    case "requested": key = "요청됨"
    case "succeeded": key = "처리됨"
    case "failed": key = "실패"
    default: return value
    }
    return BridgeAppLocalization.string(key, locale: locale)
}
