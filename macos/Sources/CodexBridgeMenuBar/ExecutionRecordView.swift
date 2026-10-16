import Foundation
import CodexBridgeKit
import SwiftUI

struct ExecutionRecordView: View {
    @EnvironmentObject private var model: AppModel
    let row: DashboardRow
    var problem: DashboardProblem? = nil

    // Keep the badge path callable with the same model/cache in native regressions.
    func presentationStatus(using model: AppModel) -> String {
        let turn = model.executionDetail(model.executionTarget(row: row, problem: problem))?.execution ?? row.latestTurn
        // Exact detail retains durable Job content; a live list row owns current
        // runtime health and blocking status, even when that detail is cached.
        if row.jobId != nil, row.latestTurn?.endedAt == nil,
           ["running", "input-required", "approval-required", "terminating", "termination-failed", "orphaned", "liveness-unknown"].contains(row.status) {
            return row.status
        }
        return turn?.status ?? (problem?.source == "execution" ? problem?.kind.rawValue : nil) ?? row.status
    }
    func presentationAvailable(using model: AppModel) -> Bool {
        let target = model.executionTarget(row: row, problem: problem)
        return ExecutionRecordPresentation.retained(row, days: model.dashboard?.historyPolicy?.retentionDays, now: model.dashboardHistoryNow())
            && !(target?.expiresAt.map { $0 <= model.dashboardHistoryNow() } ?? false)
    }
    var body: some View {
        DashboardRowView(row: row, presentation: .nestedJob, enclosingActivityTitle: row.activityTitle)
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
        case "completed": return "dashboard.status.completed"
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
