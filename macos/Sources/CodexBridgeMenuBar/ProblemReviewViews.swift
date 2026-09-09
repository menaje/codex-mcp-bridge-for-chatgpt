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
            Picker("문제 확인 상태", selection: Binding(get: { model.dashboardProblemQuery.review }, set: { review in
                Task { await model.selectProblemQuery(review: review) }
            })) {
                Text("처리 필요").tag(ProblemReview.pending)
                Text("확인한 기록").tag(ProblemReview.acknowledged)
            }.pickerStyle(.segmented)
            Picker("문제 유형", selection: Binding(get: { model.dashboardProblemQuery.kind }, set: { kind in
                Task { await model.selectProblemQuery(kind: kind) }
            })) {
                Text("전체 유형").tag(ProblemKind.all)
                Text("실패·중단").tag(ProblemKind.failed)
                Text("상태 확인 불가").tag(ProblemKind.unknown)
                Text("종료 실패").tag(ProblemKind.terminationFailed)
                Text("연결 끊김").tag(ProblemKind.orphaned)
            }.pickerStyle(.menu)
            if problems.query.review == .pending && (problems.query.kind == .all || problems.query.kind == .failed) {
                Button("종료된 실패 모두 확인") { Task { await model.acknowledgeAllFinishedProblems() } }
                    .buttonStyle(.link).font(.caption).disabled(problems.reviewableCount == 0)
            }
            if let notice = model.problemActionNotice {
                Text(notice).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if problems.rows.isEmpty {
                Text(problems.query.review == .pending
                     ? BridgeAppLocalization.string("처리할 문제가 없습니다.", locale: model.interfaceLocale)
                     : BridgeAppLocalization.string("확인한 문제 기록이 없습니다.", locale: model.interfaceLocale))
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

    private func actionButton(_ title: String, problem: DashboardProblem, action: ProblemActionKind) -> some View {
        Button(BridgeAppLocalization.string(title, locale: model.interfaceLocale)) {
            Task { await model.changeProblem(problem, action: action) }
        }
    }
}
