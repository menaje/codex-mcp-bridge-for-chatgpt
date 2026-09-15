import CodexBridgeKit
import SwiftUI

struct DashboardProblemsSection: View {
    @EnvironmentObject private var model: AppModel
    let problems: DashboardProblems
    @State private var stopCandidate: DashboardProblem?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("dashboard.problems").font(.headline)
                Spacer()
                Text(problems.page.total, format: .number).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if model.changingProblems { ProgressView().controlSize(.small) }
            }
            queryControls
            if (automaticViews ? problems.query.view == .history : problems.query.review == .pending)
                && (problems.query.kind == .all || problems.query.kind == .failed) {
                Button("problem.ackAll") { Task { await model.acknowledgeAllFinishedProblems() } }
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
                        Text("problem.noDetails")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if problem.source == "runtime" {
                        Text(BridgeAppLocalization.format("macos.statuschecked", locale: model.interfaceLocale, DisplayFormat.relative(problem.observedAt, locale: model.interfaceLocale)))
                            .font(.caption2).foregroundStyle(.secondary)
                        if problem.review == .pending {
                            Text("problem.liveNotice")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    if let acknowledged = problem.acknowledgedAt {
                        Text(BridgeAppLocalization.format("macos.reviewed", locale: model.interfaceLocale, DisplayFormat.relative(acknowledged, locale: model.interfaceLocale)))
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
                        if problem.canAcknowledge { actionButton("history.acknowledge", problem: problem, action: .acknowledge) }
                        if problem.canUnacknowledge { actionButton("problem.undo", problem: problem, action: .unacknowledge) }
                        if problem.canRecheck { actionButton("problem.recheck", problem: problem, action: .recheck) }
                        if problem.canRetryStop && !model.isRemoteClient {
                            Button("problem.retryStop", role: .destructive) { stopCandidate = problem }
                        }
                    }.buttonStyle(.link).font(.caption)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
            }
            if problems.page.hasPrevious || problems.page.hasNext {
                HStack {
                    Button("macos.previous") { Task { await model.selectProblemQuery(offset: max(0, problems.page.offset - problems.page.limit)) } }
                        .disabled(!problems.page.hasPrevious)
                    Spacer()
                    Text(verbatim: "\(problems.page.offset + 1)–\(problems.page.offset + problems.page.returned) / \(problems.page.total)")
                        .font(.caption.monospacedDigit())
                    Spacer()
                    Button("macos.next") { Task { await model.selectProblemQuery(offset: problems.page.offset + problems.page.returned) } }
                        .disabled(!problems.page.hasNext)
                }.font(.caption)
            }
        }
        .disabled(model.changingProblems)
        .confirmationDialog("problem.retryStop", isPresented: Binding(get: { stopCandidate != nil }, set: { if !$0 { stopCandidate = nil } }), titleVisibility: .visible) {
            if let candidate = stopCandidate {
                Button("problem.retryStop", role: .destructive) {
                    stopCandidate = nil
                    Task { await model.changeProblem(candidate, action: .retryStop) }
                }
            }
            Button("common.cancel", role: .cancel) { stopCandidate = nil }
        } message: {
            if let impact = stopCandidate?.stopImpact {
                Text(BridgeAppLocalization.format("macos.stopconnectedexecutionsfilechangeswillnotbe",
                    locale: model.interfaceLocale, impact.affectedJobIds.count) + "\n" + impact.agentNames.filter { !$0.isEmpty }.joined(separator: ", "))
            }
        }
    }

    private var automaticViews: Bool { model.dashboard?.historyPolicy?.automaticRecovery == true }
    private var emptyMessage: String {
        if automaticViews {
            switch problems.query.view ?? .actionable {
            case .actionable: return "problem.empty"
            case .history: return "problem.historyEmpty"
            case .automatic: return "problem.automaticEmpty"
            }
        }
        return problems.query.review == .pending ? "problem.empty" : "problem.emptyAcknowledged"
    }

    @ViewBuilder private var queryControls: some View {
        if automaticViews {
            Picker("problem.reviewLabel", selection: Binding(get: { model.dashboardProblemQuery.view ?? .actionable }, set: { view in
                Task { await model.selectProblemQuery(kind: .all, view: view) }
            })) {
                Text("problem.pending").tag(ProblemView.actionable)
                Text("problem.history").tag(ProblemView.history)
                Text("problem.automatic").tag(ProblemView.automatic)
            }.pickerStyle(.segmented)
            if model.dashboardProblemQuery.view == .history {
                Text("problem.historyOptional")
                    .font(.caption2).foregroundStyle(.secondary)
            } else if model.dashboardProblemQuery.view == .automatic {
                Text("problem.automaticLogNotice")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                Text("problem.autoNotice")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        } else {
            Picker("problem.reviewLabel", selection: Binding(get: { model.dashboardProblemQuery.review }, set: { review in
                Task { await model.selectProblemQuery(review: review) }
            })) {
                Text("problem.pending").tag(ProblemReview.pending)
                Text("problem.acknowledged").tag(ProblemReview.acknowledged)
            }.pickerStyle(.segmented)
        }
        if !automaticViews || model.dashboardProblemQuery.view == .actionable {
            Picker("problem.kindLabel", selection: Binding(get: { model.dashboardProblemQuery.kind }, set: { kind in
                Task { await model.selectProblemQuery(kind: kind) }
            })) {
                Text("problem.kind.all").tag(ProblemKind.all)
                if !automaticViews { Text("problem.kind.failed").tag(ProblemKind.failed) }
                Text("problem.kind.unknown").tag(ProblemKind.unknown)
                Text("macos.terminationfailed").tag(ProblemKind.terminationFailed)
                Text("macos.disconnected").tag(ProblemKind.orphaned)
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
