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
        let live = try turn(#"{"status":"running","startedAt":"2026-09-09T01:00:00Z","updatedAt":"2026-09-09T01:09:59Z","durationMs":599000}"#)
        let liveText = DashboardTimePresentation.text(turn: live, fallbackUpdatedAt: live.updatedAt, locale: locale, now: now)
        XCTAssertEqual(liveText, BridgeAppLocalization.string("dashboard.time.started", locale: locale)
            .replacingOccurrences(of: "{time}", with: DisplayFormat.dateTime(live.startedAt!, locale: locale)))
        XCTAssertFalse(liveText.contains(DisplayFormat.duration(599_000, locale: locale)))
        XCTAssertFalse(liveText.contains(" · "))
        XCTAssertFalse(liveText.contains(DisplayFormat.relative(live.startedAt!, relativeTo: now, locale: locale)))
        let ended = try turn(#"{"status":"failed","updatedAt":"2026-09-09T01:09:59Z","endedAt":"2026-09-09T01:02:00Z","durationMs":120000}"#)
        let endedText = DashboardTimePresentation.text(turn: ended, fallbackUpdatedAt: ended.updatedAt, locale: locale, now: now)
        XCTAssertTrue(endedText.contains(DisplayFormat.duration(120_000, locale: locale)))
        XCTAssertTrue(endedText.contains(DisplayFormat.relative(ended.endedAt!, relativeTo: now, locale: locale)))
        XCTAssertFalse(endedText.contains(BridgeAppLocalization.format("macos.started", locale: locale,
            DisplayFormat.relative(ended.endedAt!, relativeTo: now, locale: locale))))
        let missing = try turn(#"{"status":"failed","updatedAt":"2026-09-01T01:00:00Z","durationMs":null}"#)
        let missingText = DashboardTimePresentation.text(turn: missing, fallbackUpdatedAt: missing.updatedAt, locale: locale, now: now)
        XCTAssertTrue(missingText.contains(BridgeAppLocalization.string("dashboard.time.durationUnknown", locale: locale)))
        XCTAssertFalse(missingText.contains(DisplayFormat.duration(0, locale: locale)))

        let fallbackRunning = DashboardTimePresentation.text(
            turn: nil,
            fallbackUpdatedAt: "2026-09-09T01:00:00Z",
            fallbackStatus: "running",
            fallbackDurationMs: 60_000,
            locale: locale,
            now: now
        )
        XCTAssertEqual(fallbackRunning, "")
    }

    func testEveryOngoingStatusUsesRecordedStartTimeAcrossLocales() throws {
        let turn = try JSONDecoder().decode(DashboardTurn.self, from: Data(#"{"status":"running","startedAt":"2026-09-09T01:00:00Z","updatedAt":"2026-09-09T01:09:59Z","durationMs":599000}"#.utf8))
        for language in ["en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"] {
            let locale = Locale(identifier: language)
            let expected = BridgeAppLocalization.string("dashboard.time.started", locale: locale)
                .replacingOccurrences(of: "{time}", with: DisplayFormat.dateTime(turn.startedAt!, locale: locale))
            for status in ["running", "input-required", "approval-required", "terminating", "termination-failed", "liveness-unknown", "orphaned", "background-process-running"] {
                XCTAssertEqual(DashboardTimePresentation.text(turn: turn, fallbackUpdatedAt: turn.updatedAt, fallbackStatus: status, locale: locale), expected)
            }
        }
    }

    func testMissingOrInvalidStartIsOmittedAndFinishedTurnsKeepTheirDuration() throws {
        let locale = Locale(identifier: "ko")
        for start in ["null", #""invalid""#] {
            let json = "{\"status\":\"running\",\"startedAt\":\(start),\"updatedAt\":\"2026-09-09T01:09:59Z\",\"durationMs\":599000}"
            let turn = try JSONDecoder().decode(DashboardTurn.self, from: Data(json.utf8))
            XCTAssertEqual(DashboardTimePresentation.text(turn: turn, fallbackUpdatedAt: turn.updatedAt, locale: locale), "")
        }
        let ended = try JSONDecoder().decode(DashboardTurn.self, from: Data(#"{"status":"completed","startedAt":"2026-09-09T01:00:00Z","endedAt":"2026-09-09T01:02:00Z","updatedAt":"2026-09-09T01:09:59Z","durationMs":120000}"#.utf8))
        let text = DashboardTimePresentation.text(turn: ended, fallbackUpdatedAt: ended.updatedAt, fallbackStatus: "running", locale: locale)
        XCTAssertTrue(text.contains(DisplayFormat.duration(120_000, locale: locale)))
        XCTAssertFalse(text.contains(BridgeAppLocalization.string("dashboard.time.started", locale: locale).components(separatedBy: "{time}")[0]))
    }
}
