import Foundation
import XCTest
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

@MainActor
final class WorkHistoryPresentationTests: XCTestCase {
    func testLiveAndFinishedTurnsUseTheirActualTimesAndUnknownDurationStaysUnknown() throws {
        let locale = Locale(identifier: "en")
        let now = try XCTUnwrap(DisplayFormat.parseDate("2026-09-09T01:10:00Z"))
        func turn(_ json: String) throws -> DashboardTurn {
            try JSONDecoder().decode(DashboardTurn.self, from: Data(json.utf8))
        }
        let live = try turn(#"{"status":"running","startedAt":"2026-09-09T01:00:00Z","updatedAt":"2026-09-09T01:09:59Z","durationMs":0}"#)
        let liveText = DashboardTimePresentation.text(turn: live, fallbackUpdatedAt: live.updatedAt, locale: locale, now: now)
        XCTAssertTrue(liveText.contains(DisplayFormat.duration(600_000, locale: locale)))
        XCTAssertTrue(liveText.contains(BridgeAppLocalization.format("시작 %@", locale: locale,
            DisplayFormat.relative(live.startedAt!, relativeTo: now, locale: locale))))
        XCTAssertTrue(liveText.contains(DisplayFormat.relative(live.startedAt!, relativeTo: now, locale: locale)))
        let ended = try turn(#"{"status":"failed","updatedAt":"2026-09-09T01:09:59Z","endedAt":"2026-09-09T01:02:00Z","durationMs":120000}"#)
        let endedText = DashboardTimePresentation.text(turn: ended, fallbackUpdatedAt: ended.updatedAt, locale: locale, now: now)
        XCTAssertTrue(endedText.contains(DisplayFormat.duration(120_000, locale: locale)))
        XCTAssertTrue(endedText.contains(DisplayFormat.relative(ended.endedAt!, relativeTo: now, locale: locale)))
        XCTAssertFalse(endedText.contains(BridgeAppLocalization.format("시작 %@", locale: locale,
            DisplayFormat.relative(ended.endedAt!, relativeTo: now, locale: locale))))
        let missing = try turn(#"{"status":"failed","updatedAt":"2026-09-01T01:00:00Z","durationMs":null}"#)
        let missingText = DashboardTimePresentation.text(turn: missing, fallbackUpdatedAt: missing.updatedAt, locale: locale, now: now)
        XCTAssertTrue(missingText.contains(BridgeAppLocalization.string("작업시간 확인 불가", locale: locale)))
        XCTAssertFalse(missingText.contains(DisplayFormat.duration(0, locale: locale)))
    }
}
