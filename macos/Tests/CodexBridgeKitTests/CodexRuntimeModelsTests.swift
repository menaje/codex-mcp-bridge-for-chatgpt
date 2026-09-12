import XCTest
@testable import CodexBridgeKit

final class CodexRuntimeModelsTests: XCTestCase {
    func testMenuKeepsCodexWeeklyUsageAndOnlyIncludesUsedSparkWindows() throws {
        let usage = try account(windows: [window("codex", minutes: 10080, remaining: 42),
            window("codex_bengalfox", minutes: 300, remaining: 100), window("codex_bengalfox", minutes: 10080, remaining: 99)])
        XCTAssertEqual(usage.weeklyUsage?.remainingPercent, 42)
        XCTAssertEqual(usage.menuSparkWindows.count, 1)
        XCTAssertEqual(usage.menuSparkWindows.first?.windowDurationMins, 10080)
        XCTAssertEqual(usage.menuSparkWindows.first?.displayName, "GPT-5.3-Codex-Spark")
        XCTAssertTrue(try account(windows: [window("codex_bengalfox", minutes: 10080, remaining: 100)]).menuSparkWindows.isEmpty)
        XCTAssertEqual(try account(windows: [window("codex_bengalfox", minutes: 300, remaining: 99.95)]).menuSparkWindows.count, 1)
        XCTAssertTrue(try account(mode: "api-key", windows: [window("codex_bengalfox", minutes: 300, remaining: 80)]).menuSparkWindows.isEmpty)
    }

    func testCreditBalanceIsNotPresentedAsSpendingOrDisplayedBeforePlanExhaustion() throws {
        let credits: [String: Any] = ["hasCredits": true, "unlimited": false, "balance": "12.5"]
        XCTAssertNil(try account(windows: [window("codex", minutes: 10080, remaining: 30)], credits: credits).menuCreditBalance)
        XCTAssertEqual(try account(windows: [window("codex", minutes: 10080, remaining: 0)], credits: credits).menuCreditBalance, "12.5")
        XCTAssertNil(try account(mode: "api-key", windows: [window("codex", minutes: 10080, remaining: 0)], credits: credits).menuCreditBalance)
    }

    func testAccountGroupingRequiresKnownMatchingIdentity() throws {
        let first = try account(key: "one")
        XCTAssertTrue(first.sharesKnownAccount(with: try account(key: "one")))
        XCTAssertFalse(first.sharesKnownAccount(with: try account(key: "two")))
        XCTAssertFalse(first.sharesKnownAccount(with: try account(mode: "api-key", key: "one")))
        XCTAssertFalse(try account().sharesKnownAccount(with: account()))
    }

    func testSettingsPollsFastOnlyForVisibleInstallationProgress() {
        XCTAssertEqual(CodexSettingsRefreshPolicy.interval(isVisible: true, installationInProgress: false), 30)
        XCTAssertEqual(CodexSettingsRefreshPolicy.interval(isVisible: true, installationInProgress: true), 2)
        XCTAssertNil(CodexSettingsRefreshPolicy.interval(isVisible: false, installationInProgress: true))
    }

    private func window(_ id: String, minutes: Double, remaining: Double) -> [String: Any] {
        ["limitId": id, "windowDurationMins": minutes, "remainingPercent": remaining, "usedPercent": 100 - remaining]
    }

    private func account(mode: String = "chatgpt", key: String? = nil, windows: [[String: Any]] = [], credits: [String: Any]? = nil) throws -> CodexAccountUsage {
        var value: [String: Any] = ["authMode": mode, "authenticated": true, "windows": windows, "observedAt": 123]
        if let key { value["accountKey"] = key }
        if let credits { value["credits"] = credits }
        return try JSONDecoder().decode(CodexAccountUsage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    func testAPIUnknownCostsDoNotDecodeAsZeroOrAsPlanQuota() throws {
        let data = Data(#"{"authMode":"api-key","authenticated":true,"windows":[],"observedAt":123,"billing":{"actualCosts":{"configured":true,"status":"unavailable","usd":null}}}"#.utf8)
        let usage = try JSONDecoder().decode(CodexAccountUsage.self, from: data)
        XCTAssertTrue(usage.windows.isEmpty)
        XCTAssertNil(usage.credits)
        XCTAssertNil(usage.billing?.actualCosts?.usd)
        XCTAssertEqual(usage.billing?.actualCosts?.status, "unavailable")
    }

    func testCreditsAndResetCouponsRemainSeparateAndVerifiedZeroCostsRemainZero() throws {
        let data = Data(#"{"authMode":"chatgpt","authenticated":true,"windows":[],"observedAt":123,"credits":{"hasCredits":true,"unlimited":false,"balance":"12"},"resetCredits":{"availableCount":2}}"#.utf8)
        let usage = try JSONDecoder().decode(CodexAccountUsage.self, from: data)
        XCTAssertEqual(usage.credits?.balance, "12")
        XCTAssertEqual(usage.resetCredits?.availableCount, 2)
        let api = Data(#"{"authMode":"api-key","authenticated":true,"windows":[],"observedAt":123,"billing":{"actualCosts":{"configured":true,"status":"available","usd":0}}}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(CodexAccountUsage.self, from: api).billing?.actualCosts?.usd, 0)
    }

    func testMenuUpdateRequiresManagedSelectionAvailableUpdateAndNotifications() throws {
        XCTAssertTrue(try snapshot(source: "bridge", update: true, notifications: true).showsMenuUpdate)
        XCTAssertFalse(try snapshot(source: "app", update: true, notifications: true).showsMenuUpdate)
        XCTAssertFalse(try snapshot(source: "terminal", update: true, notifications: true).showsMenuUpdate)
        XCTAssertFalse(try snapshot(source: "bridge", update: false, notifications: true).showsMenuUpdate)
        XCTAssertFalse(try snapshot(source: "bridge", update: true, notifications: false).showsMenuUpdate)
    }

    func testOnlyActiveInstallationPhasesShowProgress() throws {
        for phase in ["downloading", "installing", "verifying"] {
            XCTAssertTrue(try snapshot(phase: phase).isInstalling)
        }
        for phase in ["pending", "failed", "complete"] {
            XCTAssertFalse(try snapshot(phase: phase).isInstalling)
        }
    }

    private func snapshot(source: String = "bridge", update: Bool = false, notifications: Bool = true, phase: String? = nil) throws -> CodexRuntimeSnapshot {
        let selection: [String: Any] = ["id": "fixture", "source": source, "command": "/fixture/codex", "physicalPath": "/fixture/codex", "version": "0.153.3", "available": true, "compatible": true]
        var value: [String: Any] = [
            "selection": selection, "candidates": [selection], "selectionRequired": false,
            "installedVersion": "0.153.3", "runningVersions": [], "reclaimableBytes": 0,
            "preferences": ["notifications": notifications],
            "actions": ["install": false, "update": update, "remove": true, "reinstall": false, "rollback": false, "cleanup": false, "retry": false, "applyPending": false, "skip": update]
        ]
        if let phase { value["operation"] = ["action": "update", "phase": phase] }
        return try JSONDecoder().decode(CodexRuntimeSnapshot.self, from: JSONSerialization.data(withJSONObject: value))
    }
}
