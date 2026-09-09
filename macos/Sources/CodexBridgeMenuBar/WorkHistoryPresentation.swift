import CodexBridgeKit
import SwiftUI

@MainActor
enum DashboardTimePresentation {
    static func text(turn: DashboardTurn?, fallbackUpdatedAt: String, locale: Locale, now: Date = Date()) -> String {
        let live = turn.map { $0.endedAt == nil && ["running", "input-required", "approval-required", "terminating", "liveness-unknown"].contains($0.status) } ?? false
        var duration = turn?.durationMs
        if live, let startedAt = turn?.startedAt, let start = DisplayFormat.parseDate(startedAt) {
            duration = max(0, Int(now.timeIntervalSince(start) * 1_000))
        }
        let workTime = duration.map {
            BridgeAppLocalization.format("작업시간 %@", locale: locale, DisplayFormat.duration($0, locale: locale))
        } ?? BridgeAppLocalization.string("작업시간 확인 불가", locale: locale)
        let timestamp = live ? (turn?.startedAt ?? turn?.updatedAt ?? fallbackUpdatedAt)
            : (turn?.endedAt ?? turn?.updatedAt ?? fallbackUpdatedAt)
        let relative = DisplayFormat.relative(timestamp, relativeTo: now, locale: locale)
        let elapsed = live ? BridgeAppLocalization.format("시작 %@", locale: locale, relative) : relative
        return "\(workTime) · \(elapsed)"
    }
}

struct WorkHistoryPolicyView: View {
    @EnvironmentObject private var model: AppModel
    let policy: WorkHistoryPolicy

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if policy.retentionDays == 0 {
                Text("실행 기록을 계속 보관합니다.")
            } else {
                Text(BridgeAppLocalization.format("종료한 실행 기록은 %d일 뒤 자동 정리됩니다.", locale: model.interfaceLocale, policy.retentionDays))
            }
            if policy.automaticRecovery == true {
                Text("종료된 실패는 확인 의무 없이 기록으로 보관됩니다. 브리지가 안전한 복구를 자동 수행하고 확인된 결과를 기록합니다. 진행 중인 작업, 미전달 결과, Codex 대화와 프로젝트 파일은 보존합니다.")
            } else if policy.reviewUntilRetention == true {
                Text("문제는 보관 기간 동안 확인할 수 있습니다. 확인함을 눌러도 실패 결과는 유지됩니다. 진행 중인 작업과 미전달 결과는 보존하며, Codex 대화와 프로젝트 파일은 유지됩니다.")
            } else {
                Text("실패·중단은 최근 7일 동안 확인이 필요합니다. 확인함을 누르면 문제 집계에서 제외됩니다. 진행 중인 작업과 미전달 결과는 보존하며, Codex 대화와 프로젝트 파일은 유지됩니다.")
            }
            if let date = policy.lastCleanupAt {
                Text(BridgeAppLocalization.format("최근 정리: %@ · %d건", locale: model.interfaceLocale,
                    DisplayFormat.dateTime(date, locale: model.interfaceLocale), policy.lastCleanupCount))
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
