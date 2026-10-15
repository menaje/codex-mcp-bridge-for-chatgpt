import CodexBridgeKit
import SwiftUI

@MainActor
enum DashboardTimePresentation {
    static func text(
        turn: DashboardTurn?,
        fallbackUpdatedAt: String,
        fallbackStatus: String? = nil,
        fallbackDurationMs: Int? = nil,
        locale: Locale,
        now: Date = Date()
    ) -> String {
        let status = fallbackStatus ?? turn?.status
        let live = turn?.endedAt == nil && ["running", "input-required", "approval-required", "terminating", "termination-failed", "liveness-unknown", "orphaned", "background-process-running"].contains(status ?? "")
        if live {
            guard let startedAt = turn?.startedAt, DisplayFormat.parseDate(startedAt) != nil else { return "" }
            return BridgeAppLocalization.string("dashboard.time.started", locale: locale)
                .replacingOccurrences(of: "{time}", with: DisplayFormat.dateTime(startedAt, locale: locale))
        }
        let duration = turn?.durationMs ?? fallbackDurationMs
        let workTime = duration.map {
            BridgeAppLocalization.format("macos.worktime", locale: locale, DisplayFormat.duration($0, locale: locale))
        } ?? BridgeAppLocalization.string("dashboard.time.durationUnknown", locale: locale)
        let timestamp = turn?.endedAt ?? turn?.updatedAt ?? fallbackUpdatedAt
        let relative = DisplayFormat.relative(timestamp, relativeTo: now, locale: locale)
        return BridgeAppLocalization.format(
            "macos.format.dotSeparatedPair",
            locale: locale,
            workTime,
            relative
        )
    }
}

struct WorkHistoryPolicyView: View {
    @EnvironmentObject private var model: AppModel
    let policy: WorkHistoryPolicy

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if policy.retentionDays == 0 {
                Text("history.unlimited")
            } else {
                Text(BridgeAppLocalization.format("macos.finishedrunsareautomaticallycleanedupafterdays", locale: model.interfaceLocale, policy.retentionDays))
            }
            if policy.automaticRecovery == true {
                Text("problem.automaticHistoryNotice")
            } else if policy.reviewUntilRetention == true {
                Text("problem.historyNotice")
            } else {
                Text("history.notice")
            }
            if let date = policy.lastCleanupAt {
                Text(BridgeAppLocalization.format("macos.lastcleanupruns", locale: model.interfaceLocale,
                    DisplayFormat.dateTime(date, locale: model.interfaceLocale), policy.lastCleanupCount))
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
