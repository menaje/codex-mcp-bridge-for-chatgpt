import Foundation
import CodexBridgeKit
import SwiftUI

struct ExecutionRecordView: View {
    @EnvironmentObject private var model: AppModel
    let row: DashboardRow
    var problem: DashboardProblem? = nil
    @State private var expanded = false

    private var target: AppModel.ExecutionTarget? { model.executionTarget(row: row, problem: problem) }
    private var turn: DashboardTurn? { model.executionDetail(target)?.execution ?? row.latestTurn }
    private var jobId: String? { problem?.jobId ?? row.jobId ?? turn?.jobId }
    private var status: String { turn?.status ?? (problem?.source == "execution" ? problem?.kind.rawValue : nil) ?? row.status }
    private func localized(_ key: String) -> String { BridgeAppLocalization.string(key, locale: model.interfaceLocale) }

    @ViewBuilder var body: some View {
        if !ExecutionRecordPresentation.retained(row, days: model.dashboard?.historyPolicy?.retentionDays, now: model.dashboardHistoryNow()) || target?.expiresAt.map({ $0 <= model.dashboardHistoryNow() }) == true {
            Text(localized("execution.unavailable")).font(.caption2).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline) {
                    Text(problem?.executionName ?? row.executionName ?? turn?.executionName ?? localized("execution.job"))
                        .font(.caption.weight(.semibold)).textSelection(.enabled)
                    Spacer()
                    Text(localized(ExecutionRecordPresentation.statusKey(status)))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(status == "failed" ? Color.red : Color.secondary)
                }
                if let id = jobId { Text("Job " + id).font(.caption2.monospaced()).textSelection(.enabled) }
                Text([row.activityTitle, row.agentName, row.projectName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.secondary)
                if problem?.executionAvailability == "unavailable" {
                    Text(localized("execution.unavailable")).font(.caption2).foregroundStyle(.secondary)
                }
                if let turn {
                    Text([turn.startedAt.map { DisplayFormat.dateTime($0, locale: model.interfaceLocale) },
                          turn.endedAt.map { DisplayFormat.dateTime($0, locale: model.interfaceLocale) }].compactMap { $0 }.joined(separator: " → "))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if status == "cancelled" {
                    Text(localized("execution.cancellationReason") + ": " + (turn?.cancellation?.reason ?? localized("execution.cancellationUnrecorded")))
                        .font(.caption).textSelection(.enabled)
                    if let cancellation = turn?.cancellation {
                        Text(BridgeAppLocalization.format("execution.cancellationRequestedAt", locale: model.interfaceLocale,
                            DisplayFormat.dateTime(cancellation.requestedAt, locale: model.interfaceLocale)))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                } else if ["failed", "interrupted"].contains(status) {
                    Text(turn?.error ?? problem?.error ?? row.error ?? localized("execution.errorUnrecorded"))
                        .font(.caption).textSelection(.enabled)
                }
                DisclosureGroup(isExpanded: $expanded) {
                    VStack(alignment: .leading, spacing: 5) {
                        if let summary = turn?.summary ?? problem?.summary ?? row.summary, !summary.isEmpty {
                            Text(summary).font(.caption).textSelection(.enabled)
                        }
                        if turn?.detailAvailability == "legacy-partial" {
                            Text(localized("execution.legacyPartial")).font(.caption2).foregroundStyle(.secondary)
                        }
                        if let target {
                            Button(localized("execution.loadDetail")) { Task { await model.loadExecutionDetail(target) } }
                                .disabled(model.executionDetailIsLoading(target) || model.executionDetail(target) != nil)
                        }
                        if let error = model.executionDetailError(target) { Text(error).font(.caption2).foregroundStyle(.secondary) }
                    }.padding(.top, 4)
                } label: { Text(localized("execution.details")).font(.caption) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

enum ExecutionRecordPresentation {
    static func retained(_ row: DashboardRow, days: Int?, now: Date) -> Bool {
        guard row.jobId != nil, let days, days > 0, let raw = row.latestTurn?.endedAt else { return true }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let ended = formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) else { return false }
        return ended.addingTimeInterval(Double(days) * 86_400) > now
    }
    static func statusKey(_ status: String) -> String {
        switch status {
        case "cancelled": return "execution.cancelled"
        case "failed": return "macos.failed"
        case "interrupted": return "macos.interrupted"
        case "completed": return "macos.completed"
        case "input-required": return "macos.inputrequired"
        case "approval-required": return "macos.approvalrequired"
        case "terminating": return "macos.terminating"
        case "termination-failed": return "macos.terminationfailed"
        case "running": return "macos.running"
        case "orphaned": return "macos.disconnected"
        default: return "problem.kind.unknown"
        }
    }
}
