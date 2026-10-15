import CodexBridgeKit
import SwiftUI

struct DashboardProblemsSection: View {
    @EnvironmentObject private var model: AppModel
    let problems: DashboardProblems

    var body: some View {
        DashboardSection(title: "dashboard.problems", emptyText: "problem.historyEmpty",
            rows: model.dashboardRetainedProblems(problems).map { problem in
                var row = problem.row
                if problem.kind != .cancelled { row.error = row.error ?? problem.error ?? problem.reason }
                return row
            },
            total: problems.affectedExecutionCount ?? problems.page.total,
            groupsByActivity: true, hasMore: problems.page.hasNext,
            loadMore: { Task { await model.loadMoreProblems() } })
            .disabled(model.loadingMoreProblems)
    }

    func contextReason(_ problem: DashboardProblem, using model: AppModel) -> String? {
        let record = ExecutionRecordView(row: problem.row, problem: problem)
        guard record.presentationAvailable(using: model) else { return problem.reason }
        let target = model.executionTarget(row: problem.row, problem: problem)
        let turn = model.executionDetail(target)?.execution ?? problem.row.latestTurn
        return ProblemReasonPresentation.contextReason(problem, turn: turn, renderedStatus: record.presentationStatus(using: model))
    }

}

private struct AutomaticRecoveryView: View {
    @EnvironmentObject private var model: AppModel
    let recovery: AutomaticRecoverySummary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text([localized(kindLabel), localized(stateLabel), BridgeAppLocalization.format("macos.of3attempts", locale: model.interfaceLocale, recovery.attempts)].joined(separator: " · "))
            if recovery.reason != "inspection-pending" { Text(localized(reasonLabel)) }
        }.font(.caption2).foregroundStyle(.secondary)
    }
    private func localized(_ value: String) -> String { BridgeAppLocalization.string(value, locale: model.interfaceLocale) }
    private var kindLabel: String {
        switch recovery.kind {
        case "release": return "problem.auto.release"
        case "retry-stop": return "problem.auto.retry-stop"
        default: return "problem.auto.recheck"
        }
    }
    private var stateLabel: String {
        switch recovery.state {
        case "resolved": return "problem.auto.resolved"
        case "blocked": return "problem.auto.blocked"
        default: return "problem.auto.retrying"
        }
    }
    private var reasonLabel: String {
        if recovery.evidence != nil { return "problem.auto.confirmed" }
        if recovery.reason == "work-changed" { return "problem.auto.changed" }
        if ["active-work", "background", "pending-request", "shared-worker"].contains(where: { recovery.reason.contains($0) }) {
            return "problem.auto.protected"
        }
        return "problem.auto.unconfirmed"
    }
}

// The surrounding incident can add recovery context, but the execution record owns
// its exact error or cancellation reason.
enum ProblemReasonPresentation {
    static func contextReason(_ problem: DashboardProblem, turn: DashboardTurn?, renderedStatus: String? = nil) -> String? {
        guard let reason = problem.reason else { return nil }
        guard problem.jobId != nil || (problem.source == "execution" && problem.executionAvailability == nil) else { return reason }
        let status = renderedStatus ?? turn?.status ?? (problem.source == "execution" ? problem.kind.rawValue : nil) ?? problem.row.status
        let rendered: String?
        if status == "cancelled" {
            rendered = turn?.cancellation?.reason
        } else if ["failed", "interrupted"].contains(status) {
            rendered = turn?.error ?? problem.error ?? problem.row.error
        } else {
            rendered = nil
        }
        return reason == rendered ? nil : reason
    }
}
