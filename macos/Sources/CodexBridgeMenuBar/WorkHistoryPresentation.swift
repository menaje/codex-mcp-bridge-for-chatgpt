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
            return BridgeAppLocalization.string("history.started", locale: locale)
                .replacingOccurrences(of: "{relative}", with: DisplayFormat.relative(startedAt, relativeTo: now, locale: locale))
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

/// Refresh only the displayed age; the recorded turn and server snapshot stay intact.
struct DashboardTimeView: View {
    let turn: DashboardTurn?
    let fallbackUpdatedAt: String
    var fallbackStatus: String? = nil
    var fallbackDurationMs: Int? = nil
    var statusLabel: String? = nil
    let locale: Locale

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let time = DashboardTimePresentation.text(
                turn: turn,
                fallbackUpdatedAt: fallbackUpdatedAt,
                fallbackStatus: fallbackStatus,
                fallbackDurationMs: fallbackDurationMs,
                locale: locale,
                now: context.date
            )
            if !time.isEmpty {
                Text(statusLabel.map {
                    BridgeAppLocalization.format("macos.format.dotSeparatedPair", locale: locale, $0, time)
                } ?? time)
            }
        }
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
