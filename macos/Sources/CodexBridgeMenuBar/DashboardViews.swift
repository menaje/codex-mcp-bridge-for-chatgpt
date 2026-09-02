import AppKit
import CodexBridgeKit
import SwiftUI

struct DashboardPopoverView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showForceStopConfirmation = false
    @State private var showForceRestartConfirmation = false
    @State private var showRepairConfirmation = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Group {
                if model.helperStatus == nil {
                    loadingView
                } else if model.needsSetup {
                    ConnectionRepairView()
                } else if model.helperStatus?.bridge.connected != true {
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
        .task {
            if model.helperStatus == nil {
                await model.start()
            } else {
                await model.refreshStatus()
                await model.refreshDashboard()
            }
        }
        .confirmationDialog(
            "실행 중인 작업을 중단하고 서버를 강제 종료할까요?",
            isPresented: $showForceStopConfirmation
        ) {
            Button("강제 종료", role: .destructive) {
                Task { await model.stopRuntime(force: true) }
            }
        } message: {
            Text("파일 변경은 되돌아가지 않으며, 활성 작업 \(activeJobCount)개가 중단될 수 있습니다.")
        }
        .confirmationDialog(
            "실행 중인 작업을 중단하고 서버를 강제 재시작할까요?",
            isPresented: $showForceRestartConfirmation
        ) {
            Button("강제 재시작", role: .destructive) {
                Task { await model.restartRuntime(force: true) }
            }
        } message: {
            Text("활성 작업 \(activeJobCount)개가 중단될 수 있으며, 작업을 자동으로 다시 실행하지 않습니다.")
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
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: model.health.symbol)
                .font(.title2)
                .foregroundStyle(healthColor)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Codex MCP Bridge for ChatGPT")
                    .font(.headline)
                Text(model.health.accessibilityLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.isBusy { ProgressView().controlSize(.small) }
            Button {
                Task {
                    await model.refreshStatus()
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
            ProgressView()
            Text("현황을 불러오는 중…")
                .foregroundStyle(.secondary)
            if let error = model.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                Button("helper 다시 연결") {
                    Task { await model.start() }
                }
                .disabled(model.isBusy)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var runtimeUnavailableView: some View {
        VStack(spacing: 14) {
            Image(systemName: "bolt.slash.fill")
                .font(.system(size: 34))
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            Text("브리지 서버에 연결할 수 없습니다")
                .font(.headline)
            Text(model.helperStatus?.lastError ?? model.errorMessage ?? "서버가 중지되었거나 시작 중입니다.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            HStack {
                Button("시작") { Task { await model.startRuntime() } }
                    .buttonStyle(.borderedProminent)
                Button("재시작") { Task { await model.restartRuntime(force: false) } }
            }
            Button("Tunnel 프로필 복구…") { showRepairConfirmation = true }
            if model.helperStatus?.phase == "safe-mode" {
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
                if model.helperStatus?.tunnel.connected != true {
                    Label(
                        model.helperStatus?.tunnel.lastError ?? "Secure MCP Tunnel 연결을 확인하고 있습니다.",
                        systemImage: "network.slash"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                }
                if let usage = dashboard.weeklyUsage {
                    WeeklyUsageView(usage: usage)
                }
                CountsGrid(counts: dashboard.counts)
                if dashboard.counts.runtimeUnknownAgents > 0 ||
                    dashboard.counts.runtimeProbeSkippedAgents > 0 {
                    Label(
                        "런타임 상태 불명 \(dashboard.counts.runtimeUnknownAgents) · 확인 생략 \(dashboard.counts.runtimeProbeSkippedAgents)",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                DashboardSection(
                    title: "활성",
                    emptyText: "현재 활성 Agent가 없습니다.",
                    rows: dashboard.activeRows
                )
                DashboardSection(
                    title: "최근 종료",
                    emptyText: "보존된 최근 실행이 없습니다.",
                    rows: dashboard.terminalRows,
                    hasMore: dashboard.pagination.terminal.hasNext,
                    loadMore: { Task { await model.loadMoreRecent() } }
                )
                DashboardSection(
                    title: "유휴 Agent",
                    emptyText: "유휴 Agent가 없습니다.",
                    rows: dashboard.idleRows,
                    hasMore: dashboard.pagination.idle.hasNext,
                    loadMore: { Task { await model.loadMoreIdle() } }
                )
            }
            .padding(14)
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button {
                SettingsWindowController.shared.show(model: model)
            } label: {
                Label("설정", systemImage: "gearshape")
            }
            .keyboardShortcut(",")

            Menu {
                Button("작업을 마치고 재시작") {
                    Task { await model.restartRuntime(force: false) }
                }
                Button("강제 재시작…", role: .destructive) {
                    showForceRestartConfirmation = true
                }
                Divider()
                Button("연결 정보 및 로그인…") {
                    ConnectionRepairWindowController.shared.show(model: model)
                }
                Button("Tunnel 프로필 복구…") {
                    showRepairConfirmation = true
                }
                Divider()
                Button("작업을 마치고 중지") {
                    Task { await model.stopRuntime(force: false) }
                }
                Button("강제 중지…", role: .destructive) {
                    showForceStopConfirmation = true
                }
            } label: {
                Label("서버", systemImage: "server.rack")
            }
            .disabled(model.needsSetup)

            Spacer()
            Button("앱 종료") { NSApp.terminate(nil) }
                .help("메뉴바 앱만 종료합니다. helper와 서버는 계속 실행됩니다.")
        }
        .padding(12)
    }

    private var healthColor: Color {
        switch model.health {
        case .healthy: return .green
        case .attention: return .orange
        case .unavailable: return .red
        }
    }

    private var activeJobCount: Int {
        if let bridge = model.helperStatus?.bridge {
            return (bridge.activeJobs ?? 0) + (bridge.pendingAdmissions ?? 0)
        }
        return model.dashboard?.counts.active ?? 0
    }
}

private struct WeeklyUsageView: View {
    let usage: WeeklyUsage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("주간 사용량").font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(Int(usage.usedPercent.rounded()))% 사용")
                    .font(.caption.monospacedDigit())
            }
            ProgressView(value: usage.usedPercent, total: 100)
            if let resetsAt = usage.resetsAt {
                Text("초기화: \(DisplayFormat.dateTime(resetsAt))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
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
    let title: String
    let value: Int
    let symbol: String

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: symbol)
                Text(title).lineLimit(1)
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
    let title: String
    let emptyText: String
    let rows: [DashboardRow]
    var hasMore = false
    var loadMore: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            if rows.isEmpty {
                Text(emptyText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 4)
            } else {
                ForEach(rows) { row in
                    DashboardRowView(row: row)
                }
            }
            if hasMore {
                Button("더 보기", action: { loadMore?() })
                    .buttonStyle(.link)
            }
        }
    }
}

private struct DashboardRowView: View {
    let row: DashboardRow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: StatusPresentation.symbol(row.status))
                    .foregroundStyle(StatusPresentation.color(row.status))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.activityTitle ?? "제목 없는 Activity")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    Text("\(row.agentName) · \(row.projectName ?? "프로젝트 없음")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Text(StatusPresentation.label(row.status))
                    .font(.caption2.weight(.medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
            }
            if let execution = row.execution {
                Text(executionText(execution))
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
                if let url = row.conversationUrl.flatMap(URL.init(string:)) {
                    Link("대화", destination: url)
                }
                if let url = row.codexThreadUrl.flatMap(URL.init(string:)) {
                    Button("Codex") { NSWorkspace.shared.open(url) }
                        .buttonStyle(.link)
                }
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            if let cancellation = row.latestTurn?.cancellation {
                DisclosureGroup("취소 사유") {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(cancellation.reason).textSelection(.enabled)
                        Text("\(cancellationTargetLabel(cancellation.targetKind)) · \(cancellationStatusLabel(cancellation.status)) · \(DisplayFormat.dateTime(cancellation.requestedAt))")
                            .foregroundStyle(.secondary)
                    }
                    .font(.caption)
                }
                .font(.caption)
            }
            if let history = row.history, !history.isEmpty {
                DisclosureGroup("최근 실행 기록 \(row.historyCount ?? history.count)") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(history.enumerated()), id: \.offset) { _, turn in
                            HStack(alignment: .top) {
                                Image(systemName: StatusPresentation.symbol(turn.status))
                                    .foregroundStyle(StatusPresentation.color(turn.status))
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(turn.activityTitle ?? StatusPresentation.label(turn.status))
                                    Text(turnTimeText(turn))
                                        .foregroundStyle(.secondary)
                                    if let execution = turn.execution {
                                        Text("\(execution.modelDisplayName ?? execution.model) · \(execution.reasoningEffort)")
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(.secondary)
                                    }
                                    if let cancellation = turn.cancellation {
                                        Text(cancellation.reason)
                                            .foregroundStyle(.secondary)
                                        Text("\(cancellationTargetLabel(cancellation.targetKind)) · \(cancellationStatusLabel(cancellation.status))")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    .font(.caption)
                    .padding(.top, 3)
                }
                .font(.caption)
            }
        }
        .padding(10)
        .background(.background, in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(.quaternary, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(row.activityTitle ?? "Activity"), \(row.agentName), \(StatusPresentation.label(row.status))"
        )
    }

    private func executionText(_ execution: DashboardExecution) -> String {
        let model = execution.modelDisplayName ?? execution.model
        let current = "\(model) · \(execution.reasoningEffort)"
        guard let rerouted = execution.reroutedModelDisplayName ?? execution.reroutedModel else {
            return current
        }
        return "\(current) → \(rerouted) (reroute)"
    }

    private var rowTimeText: String {
        var values = ["시작 \(DisplayFormat.dateTime(row.createdAt))"]
        values.append("변경 \(DisplayFormat.relative(row.updatedAt))")
        if let endedAt = row.latestTurn?.endedAt {
            values.append("종료 \(DisplayFormat.dateTime(endedAt))")
        }
        values.append("경과 \(DisplayFormat.duration(row.elapsedMs))")
        return values.joined(separator: " · ")
    }

    private func turnTimeText(_ turn: DashboardTurn) -> String {
        var values = [StatusPresentation.label(turn.status)]
        if let startedAt = turn.startedAt {
            values.append("시작 \(DisplayFormat.dateTime(startedAt))")
        }
        values.append("변경 \(DisplayFormat.dateTime(turn.updatedAt))")
        if let endedAt = turn.endedAt {
            values.append("종료 \(DisplayFormat.dateTime(endedAt))")
        }
        if let duration = turn.durationMs {
            values.append("경과 \(DisplayFormat.duration(duration))")
        }
        return values.joined(separator: " · ")
    }
}

struct ConnectionRepairView: View {
    @EnvironmentObject private var model: AppModel
    @State private var apiKey = ""
    @State private var tunnelId = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Label("최초 연결 또는 복구", systemImage: "wrench.and.screwdriver")
                    .font(.title3.bold())
                Text("기존 private .env가 유효하면 그대로 사용합니다. Keychain은 사용하지 않습니다.")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                GroupBox("연결 상태") {
                    VStack(alignment: .leading, spacing: 7) {
                        LabeledContent(
                            "Bridge",
                            value: model.helperStatus?.bridge.connected == true ? "준비됨" : "연결 안 됨"
                        )
                        LabeledContent(
                            "Secure MCP Tunnel",
                            value: model.helperStatus?.tunnel.connected == true ? "연결됨" : "연결 안 됨"
                        )
                        if let profile = model.helperStatus?.tunnel.profile {
                            LabeledContent("프로필", value: profile)
                        }
                        if let error = model.helperStatus?.tunnel.lastError {
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
                        SecureField(
                            model.helperStatus?.configuration.hasApiKey == true
                                ? "새 키를 입력할 때만 교체"
                                : "Runtime API key",
                            text: $apiKey
                        )
                        TextField("tunnel_…", text: $tunnelId)
                        Text("Tunnel ID는 tunnel_ 다음에 영문 소문자 또는 숫자 32자로 입력합니다.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text("저장 위치: \(model.helperStatus?.configuration.path ?? "~/.config/codex-mcp-bridge/.env")")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        if let issue = model.helperStatus?.configuration.issue {
                            Label(runtimeConfigurationIssue(issue), systemImage: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(.orange)
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
                            model.authStatus?.summary ?? "로그인 상태를 확인하고 있습니다.",
                            systemImage: model.authStatus?.authenticated == true
                                ? "checkmark.circle.fill"
                                : "person.crop.circle.badge.exclamationmark"
                        )
                        .font(.caption)
                        Button("Codex 브라우저 로그인 시작") {
                            Task { await model.launchCodexLogin() }
                        }
                        .disabled(model.isBusy)
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

                if let error = model.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }
            .padding(18)
        }
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
    static func label(_ status: String) -> String {
        switch status {
        case "running": return "실행 중"
        case "background-process-running": return "백그라운드 실행"
        case "input-required": return "입력 필요"
        case "approval-required": return "승인 필요"
        case "terminating": return "종료 중"
        case "termination-failed": return "종료 실패"
        case "liveness-unknown": return "상태 불명"
        case "completed": return "완료"
        case "failed": return "실패"
        case "interrupted": return "중단"
        case "cancelled": return "취소"
        case "idle": return "유휴"
        case "orphaned": return "연결 끊김"
        default: return status
        }
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

enum DisplayFormat {
    private static let iso = ISO8601DateFormatter()
    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()
    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    static func relative(_ value: String) -> String {
        guard let date = iso.date(from: value) else { return value }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    static func dateTime(_ value: String) -> String {
        guard let date = iso.date(from: value) else { return value }
        return dateFormatter.string(from: date)
    }

    static func duration(_ milliseconds: Int) -> String {
        let seconds = max(0, milliseconds / 1_000)
        if seconds < 60 { return "\(seconds)초" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)분 \(seconds % 60)초" }
        let hours = minutes / 60
        return "\(hours)시간 \(minutes % 60)분"
    }
}

private func cancellationTargetLabel(_ value: String) -> String {
    switch value {
    case "activity": return "Activity"
    case "job": return "작업"
    default: return value
    }
}

private func cancellationStatusLabel(_ value: String) -> String {
    switch value {
    case "requested": return "요청됨"
    case "succeeded": return "처리됨"
    case "failed": return "실패"
    default: return value
    }
}

private func runtimeConfigurationIssue(_ value: String) -> String {
    if value.contains("not configured") {
        return "런타임 연결 정보가 아직 저장되지 않았습니다."
    }
    if value.contains("permissions are too broad") {
        return "연결 정보 파일 또는 폴더의 접근 권한이 너무 넓습니다. 앱 전용 권한으로 제한해 주세요."
    }
    if value.contains("regular, non-symlink") {
        return "연결 정보는 심볼릭 링크가 아닌 일반 파일이어야 합니다."
    }
    if value.contains("CONTROL_PLANE_API_KEY") {
        return "Tunnel runtime API key가 없거나 형식이 올바르지 않습니다."
    }
    if value.contains("CONTROL_PLANE_TUNNEL_ID") {
        return "Tunnel ID가 없거나 형식이 올바르지 않습니다."
    }
    return value
}
