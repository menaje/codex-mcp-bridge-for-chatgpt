import CodexBridgeKit
import SwiftUI

struct DashboardProblemsSection: View {
    @EnvironmentObject private var model: AppModel
    let problems: DashboardProblems

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("dashboard.problems").font(.headline)
                Spacer()
                Text(problems.affectedExecutionCount ?? problems.incidentCount ?? problems.page.total, format: .number)
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Text(BridgeAppLocalization.format("problem.currentImpactCount", locale: model.interfaceLocale, problems.currentImpactCount ?? 0))
                .font(.caption2).foregroundStyle(.secondary)
            if problems.affectedExecutionCount != nil {
            Text(BridgeAppLocalization.format("execution.problemUnits", locale: model.interfaceLocale,
                problems.affectedExecutionCount ?? 0, problems.systemIncidentCount ?? 0,
                problems.unavailableExecutionCount ?? 0, problems.incidentCount ?? problems.page.total))
                .font(.caption2).foregroundStyle(.secondary)
            } else {
                Text(BridgeAppLocalization.format("execution.legacyIncidentUnits", locale: model.interfaceLocale,
                    problems.incidentCount ?? problems.page.total)).font(.caption2).foregroundStyle(.secondary)
            }
            if model.dashboardRetainedProblems(problems).isEmpty { Text("problem.historyEmpty").font(.caption).foregroundStyle(.secondary) }
            ForEach(model.dashboardRetainedProblems(problems)) { problem in
                VStack(alignment: .leading, spacing: 6) {
                    if problem.jobId != nil {
                        ExecutionRecordView(row: problem.row, problem: problem)
                    } else if problem.source == "execution" && problem.executionAvailability == nil {
                        Text(BridgeAppLocalization.string("execution.historyGrouped", locale: model.interfaceLocale)).font(.caption2)
                        ExecutionRecordView(row: problem.row, problem: problem)
                    } else {
                        Text(BridgeAppLocalization.string("execution.systemIncident", locale: model.interfaceLocale)).font(.caption.weight(.semibold))
                        Text([problem.row.activityTitle, problem.row.agentName].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Text(DisplayFormat.dateTime(problem.occurredAt ?? problem.observedAt, locale: model.interfaceLocale))
                        .font(.caption2).foregroundStyle(.secondary)
                    if let impact = problem.currentImpact, impact != "none" {
                        Text(BridgeAppLocalization.string(impact == "confirmed" ? "problem.currentImpact.confirmed" : "problem.currentImpact.unknown", locale: model.interfaceLocale))
                            .font(.caption2).foregroundStyle(impact == "confirmed" ? Color.orange : Color.secondary)
                    }
                    if let reason = contextReason(problem, using: model) { Text(reason).font(.caption).textSelection(.enabled) }
                    if let automatic = problem.automatic { AutomaticRecoveryView(recovery: automatic) }
                    ForEach(Array((problem.progress ?? []).enumerated()), id: \.offset) { _, progress in
                        Text([DisplayFormat.dateTime(progress.at, locale: model.interfaceLocale), progress.step,
                              progress.attempt.map { "#" + String($0) }, progress.reason, progress.evidence].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
            }
            if problems.page.hasPrevious || problems.page.hasNext {
                HStack {
                    Button("macos.previous") { Task { await model.selectProblemQuery(offset: max(0, problems.page.offset - problems.page.limit)) } }
                        .disabled(!problems.page.hasPrevious)
                    Spacer()
                    Button("macos.next") { Task { await model.selectProblemQuery(offset: problems.page.offset + problems.page.returned) } }
                        .disabled(!problems.page.hasNext)
                }.font(.caption)
            }
        }
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
