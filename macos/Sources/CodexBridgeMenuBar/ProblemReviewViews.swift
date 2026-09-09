import CodexBridgeKit
import SwiftUI

struct DashboardProblemsSection: View {
    @EnvironmentObject private var model: AppModel
    let problems: DashboardProblems
    @State private var stopCandidate: DashboardProblem?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("문제").font(.headline)
                Spacer()
                Text(problems.page.total, format: .number).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if model.changingProblems { ProgressView().controlSize(.small) }
            }
            queryControls
            if (automaticViews ? problems.query.view == .history : problems.query.review == .pending)
                && (problems.query.kind == .all || problems.query.kind == .failed) {
                Button("종료된 실패 모두 확인") { Task { await model.acknowledgeAllFinishedProblems() } }
                    .buttonStyle(.link).font(.caption).disabled(problems.reviewableCount == 0)
            }
            if let notice = model.problemActionNotice {
                Text(notice).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if problems.rows.isEmpty {
                Text(BridgeAppLocalization.string(emptyMessage, locale: model.interfaceLocale))
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(problems.rows) { problem in
                VStack(alignment: .leading, spacing: 6) {
                    if let title = problem.row.activityTitle {
                        Text(title).font(.caption.weight(.semibold)).lineLimit(2)
                    }
                    DashboardRowView(row: problem.row, presentation: .nestedAgent, enclosingActivityTitle: problem.row.activityTitle)
                    if let reason = problem.reason, !reason.isEmpty {
                        Text(reason).font(.caption).textSelection(.enabled)
                    } else if problem.source == "execution" {
                        Text("이전 실행의 상세 오류 정보는 보관되어 있지 않습니다.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if problem.source == "runtime" {
                        Text(BridgeAppLocalization.format("상태 점검 %@", locale: model.interfaceLocale, DisplayFormat.relative(problem.observedAt, locale: model.interfaceLocale)))
                            .font(.caption2).foregroundStyle(.secondary)
                        if problem.review == .pending {
                            Text("실행 여부가 확인될 때까지 문제로 유지됩니다.")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    if let acknowledged = problem.acknowledgedAt {
                        Text(BridgeAppLocalization.format("확인 %@", locale: model.interfaceLocale, DisplayFormat.relative(acknowledged, locale: model.interfaceLocale)))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if let automatic = problem.automatic {
                        AutomaticRecoveryView(recovery: automatic)
                        if problem.source == "recovery" {
                            Text(DisplayFormat.relative(problem.observedAt, locale: model.interfaceLocale))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    HStack(spacing: 12) {
                        if problem.canAcknowledge { actionButton("확인함", problem: problem, action: .acknowledge) }
                        if problem.canUnacknowledge { actionButton("확인 취소", problem: problem, action: .unacknowledge) }
                        if problem.canRecheck { actionButton("상태 다시 확인", problem: problem, action: .recheck) }
                        if problem.canRetryStop && !model.isRemoteClient {
                            Button("종료 재시도", role: .destructive) { stopCandidate = problem }
                        }
                    }.buttonStyle(.link).font(.caption)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
            }
            if problems.page.hasPrevious || problems.page.hasNext {
                HStack {
                    Button("이전") { Task { await model.selectProblemQuery(offset: max(0, problems.page.offset - problems.page.limit)) } }
                        .disabled(!problems.page.hasPrevious)
                    Spacer()
                    Text(verbatim: "\(problems.page.offset + 1)–\(problems.page.offset + problems.page.returned) / \(problems.page.total)")
                        .font(.caption.monospacedDigit())
                    Spacer()
                    Button("다음") { Task { await model.selectProblemQuery(offset: problems.page.offset + problems.page.returned) } }
                        .disabled(!problems.page.hasNext)
                }.font(.caption)
            }
        }
        .disabled(model.changingProblems)
        .confirmationDialog("종료 재시도", isPresented: Binding(get: { stopCandidate != nil }, set: { if !$0 { stopCandidate = nil } }), titleVisibility: .visible) {
            if let candidate = stopCandidate {
                Button("종료 재시도", role: .destructive) {
                    stopCandidate = nil
                    Task { await model.changeProblem(candidate, action: .retryStop) }
                }
            }
            Button("취소", role: .cancel) { stopCandidate = nil }
        } message: {
            if let impact = stopCandidate?.stopImpact {
                Text(BridgeAppLocalization.format("연결된 실행 %d개를 중단할까요? 파일 변경사항은 되돌리지 않습니다.",
                    locale: model.interfaceLocale, impact.affectedJobIds.count) + "\n" + impact.agentNames.filter { !$0.isEmpty }.joined(separator: ", "))
            }
        }
    }

    private var automaticViews: Bool { model.dashboard?.historyPolicy?.automaticRecovery == true }
    private var emptyMessage: String {
        if automaticViews {
            switch problems.query.view ?? .actionable {
            case .actionable: return "처리할 문제가 없습니다."
            case .history: return "보관된 실패 기록이 없습니다."
            case .automatic: return "자동 처리 내역이 없습니다."
            }
        }
        return problems.query.review == .pending ? "처리할 문제가 없습니다." : "확인한 문제 기록이 없습니다."
    }

    @ViewBuilder private var queryControls: some View {
        if automaticViews {
            Picker("문제 확인 상태", selection: Binding(get: { model.dashboardProblemQuery.view ?? .actionable }, set: { view in
                Task { await model.selectProblemQuery(kind: .all, view: view) }
            })) {
                Text("처리 필요").tag(ProblemView.actionable)
                Text("실패 기록").tag(ProblemView.history)
                Text("자동 처리").tag(ProblemView.automatic)
            }.pickerStyle(.segmented)
            if model.dashboardProblemQuery.view == .history {
                Text("종료된 실패는 기록으로 보관됩니다. 확인 처리는 선택 사항이며 원래 결과는 유지됩니다.")
                    .font(.caption2).foregroundStyle(.secondary)
            } else if model.dashboardProblemQuery.view == .automatic {
                Text("브리지가 수행한 조치와 결과를 보관합니다. 작업의 성공 여부는 별도로 검증합니다.")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                Text("브리지가 안전하게 처리할 수 있는 상황을 자동 점검·복구하며, 같은 조치는 최대 3회 시도합니다. 해결되지 않은 실행 문제만 여기에 남습니다.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        } else {
            Picker("문제 확인 상태", selection: Binding(get: { model.dashboardProblemQuery.review }, set: { review in
                Task { await model.selectProblemQuery(review: review) }
            })) {
                Text("처리 필요").tag(ProblemReview.pending)
                Text("확인한 기록").tag(ProblemReview.acknowledged)
            }.pickerStyle(.segmented)
        }
        if !automaticViews || model.dashboardProblemQuery.view == .actionable {
            Picker("문제 유형", selection: Binding(get: { model.dashboardProblemQuery.kind }, set: { kind in
                Task { await model.selectProblemQuery(kind: kind) }
            })) {
                Text("전체 유형").tag(ProblemKind.all)
                if !automaticViews { Text("실패·중단").tag(ProblemKind.failed) }
                Text("상태 확인 불가").tag(ProblemKind.unknown)
                Text("종료 실패").tag(ProblemKind.terminationFailed)
                Text("연결 끊김").tag(ProblemKind.orphaned)
            }.pickerStyle(.menu)
        }
    }

    private func actionButton(_ title: String, problem: DashboardProblem, action: ProblemActionKind) -> some View {
        Button(BridgeAppLocalization.string(title, locale: model.interfaceLocale)) {
            Task { await model.changeProblem(problem, action: action) }
        }
    }
}

private struct AutomaticRecoveryView: View {
    @EnvironmentObject private var model: AppModel
    let recovery: AutomaticRecoverySummary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text([localized(kindLabel), localized(stateLabel), BridgeAppLocalization.format("3회 중 %d회 시도", locale: model.interfaceLocale, recovery.attempts)].joined(separator: " · "))
            if recovery.reason != "inspection-pending" { Text(localized(reasonLabel)) }
        }.font(.caption2).foregroundStyle(.secondary)
    }
    private func localized(_ value: String) -> String { BridgeAppLocalization.string(value, locale: model.interfaceLocale) }
    private var kindLabel: String {
        switch recovery.kind {
        case "release": return "종료된 작업의 연결 정리"
        case "retry-stop": return "요청된 종료 재시도"
        default: return "실행 상태 재점검"
        }
    }
    private var stateLabel: String {
        switch recovery.state {
        case "resolved": return "처리 결과 확인됨"
        case "blocked": return "자동 처리 중단"
        default: return "자동 처리 중"
        }
    }
    private var reasonLabel: String {
        if recovery.evidence != nil { return "브리지가 조치 결과를 확인했습니다. 작업 결과는 실행 기록에 보관됩니다." }
        if recovery.reason == "work-changed" { return "작업 상태가 바뀌어 이전 상태의 자동 처리를 중단했습니다." }
        if ["active-work", "background", "pending-request", "shared-worker"].contains(where: { recovery.reason.contains($0) }) {
            return "진행 중이거나 백그라운드에서 실행 중인 작업을 보존합니다."
        }
        return "안전한 조치 여부나 처리 결과를 확정하지 못했습니다."
    }
}
