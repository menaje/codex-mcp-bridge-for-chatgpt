import AppKit
import Combine
import Foundation
import SwiftUI
import XCTest
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

final class DashboardPopoverTests: XCTestCase {
    private func usageAccount(
        remaining: Double?, status: String, checkedAt: Double?,
        observedAt: Double, key: String = "account-a", plan: String = "plus"
    ) -> [String: Any] {
        var account: [String: Any] = [
            "authMode": "chatgpt", "authenticated": true, "accountKey": key,
            "ownershipKey": key,
            "planType": plan, "usageStatus": status, "observedAt": observedAt,
            "windows": remaining.map { [[
                "limitId": "codex", "usedPercent": 100 - $0, "remainingPercent": $0,
                "windowDurationMins": 10080
            ]] } ?? []
        ]
        if let checkedAt { account["usageObservedAt"] = checkedAt }
        return account
    }

    @MainActor
    func testUsageRemainsInTheNativePopoverAcrossMissingDelayedAndFailedReplies() async throws {
        let f = try PopoverFixture()
        defer { f.state.releaseEnrichment(); f.remove() }
        let oldTime = 1_780_000_000_000.0
        let newTime = oldTime + 60_000
        let oldCheckedAt = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: oldTime / 1000))
        f.state.usageContext = "account-a:cli-one"
        f.state.usageAccount = usageAccount(remaining: 60, status: "available", checkedAt: oldTime, observedAt: oldTime)
        await f.model.refreshDashboard(enrich: false)
        let screen = try XCTUnwrap(NSScreen.main)
        let anchorWindow = NSPanel(contentRect: NSRect(
            x: screen.visibleFrame.midX, y: screen.visibleFrame.maxY - 80,
            width: 40, height: 30
        ), styleMask: [.borderless], backing: .buffered, defer: false)
        anchorWindow.isReleasedWhenClosed = false
        let anchor = NSButton(frame: NSRect(x: 0, y: 0, width: 40, height: 30))
        anchorWindow.contentView = anchor
        anchorWindow.orderFrontRegardless()
        let popover = NSPopover()
        popover.animates = false
        let host = NSHostingController(rootView: AnyView(
            DashboardPopoverView(onContentSizeChange: { size in
                popover.contentSize = NSSize(width: DashboardPopoverLayout.width, height: ceil(size.height))
            }).environmentObject(f.model)
        ))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
        defer { popover.performClose(nil); anchorWindow.close() }
        func settle() async throws {
            for _ in 0..<25 {
                host.view.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(10))
            }
        }
        try await settle()
        let initialHeight = popover.contentSize.height
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.remainingPercent, 60)

        f.state.rowCount = 1
        f.state.usageAccount = nil
        f.state.holdEnrichment = true
        await f.model.refreshDashboard()
        for _ in 0..<100 {
            if f.state.enrichmentReadCount > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        try await settle()
        XCTAssertEqual(f.model.dashboard?.counts.running, 1)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.remainingPercent, 60)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.observedAt, oldCheckedAt)
        XCTAssertEqual(popover.contentSize.height, initialHeight, accuracy: 1)

        f.state.usageAccount = usageAccount(remaining: nil, status: "unavailable", checkedAt: nil,
                                           observedAt: newTime, plan: "plus")
        f.state.releaseEnrichment()
        for _ in 0..<100 {
            if f.model.dashboard?.codexAccount?.observedAt == newTime { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        try await settle()
        XCTAssertEqual(f.model.dashboard?.codexAccount?.planType, "plus")
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.remainingPercent, 60)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.observedAt, oldCheckedAt)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.usageObservedAt, oldTime)
        XCTAssertEqual(popover.contentSize.height, initialHeight, accuracy: 1)

        f.state.usageAccount = nil
        f.state.failEnrichment = true
        await f.model.refreshDashboard()
        for _ in 0..<100 {
            if f.model.dashboardEnrichmentFailed { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        try await settle()
        XCTAssertTrue(f.model.dashboardEnrichmentFailed)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.remainingPercent, 60)
        XCTAssertEqual(popover.contentSize.height, initialHeight, accuracy: 1)

        f.state.failEnrichment = false
        f.state.usageAccount = usageAccount(remaining: 0, status: "available", checkedAt: newTime, observedAt: newTime)
        await f.model.refreshDashboard(enrich: false)
        try await settle()
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.remainingPercent, 0)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.usageObservedAt, newTime)
        XCTAssertEqual(popover.contentSize.height, initialHeight, accuracy: 1)

        f.state.usageAccount = usageAccount(remaining: nil, status: "unavailable", checkedAt: nil,
                                           observedAt: newTime, plan: "pro")
        await f.model.refreshDashboard(enrich: false)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.planType, "pro")
        XCTAssertNil(f.model.dashboard?.codexAccount?.weeklyUsage)
        f.state.usageAccount = usageAccount(remaining: 0, status: "available", checkedAt: newTime,
                                           observedAt: newTime)
        await f.model.refreshDashboard(enrich: false)

        f.state.usageAccount = usageAccount(remaining: nil, status: "unavailable", checkedAt: nil,
                                           observedAt: newTime, key: "account-b")
        await f.model.refreshDashboard(enrich: false)
        XCTAssertNil(f.model.dashboard?.codexAccount?.weeklyUsage)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.accountKey, "account-b")
        f.state.usageContext = "account-b:cli-one"
        f.state.usageAccount = nil
        await f.model.refreshDashboard(enrich: false)
        XCTAssertNil(f.model.dashboard?.codexAccount)
        f.state.usageAccount = usageAccount(remaining: nil, status: "none", checkedAt: nil,
                                           observedAt: newTime, key: "account-b")
        await f.model.refreshDashboard(enrich: false)
        XCTAssertNil(f.model.dashboard?.codexAccount?.weeklyUsage)
        f.state.authenticated = false
        await f.model.refreshAuthStatus()
        f.state.usageAccount = usageAccount(remaining: 80, status: "available", checkedAt: newTime,
                                           observedAt: newTime, key: "account-b")
        await f.model.refreshDashboard(enrich: false)
        XCTAssertNil(f.model.dashboard?.codexAccount)
        XCTAssertFalse(f.model.shouldShowCodexWeeklyUsage)
    }

    @MainActor
    func testLoadMoreRecentAndIdleRetainUsageFromTheActualPagedReply() async throws {
        let f = try PopoverFixture()
        defer { f.remove() }
        let checkedAt = 1_780_000_000_000.0
        f.state.pagedHistory = true
        f.state.usageContext = "account-a:cli-one"
        f.state.usageAccount = usageAccount(remaining: 60, status: "available",
                                            checkedAt: checkedAt, observedAt: checkedAt)
        await f.model.refreshDashboard(enrich: false)
        await f.model.toggleDashboardPanel(.history)
        XCTAssertTrue(f.model.dashboard?.pagination.terminal.hasNext == true)
        XCTAssertTrue(f.model.dashboard?.pagination.idle.hasNext == true)

        f.state.usageAccount = nil
        await f.model.loadMoreRecent()
        XCTAssertEqual(f.model.dashboard?.terminalRows.count, 2)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.remainingPercent, 60)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.usageObservedAt, checkedAt)

        await f.model.loadMoreIdle()
        XCTAssertEqual(f.model.dashboard?.idleRows.count, 2)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.remainingPercent, 60)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.usageObservedAt, checkedAt)

        let newerCheckedAt = checkedAt + 300_000
        f.state.usageAccount = usageAccount(remaining: 40, status: "unavailable",
                                            checkedAt: newerCheckedAt,
                                            observedAt: newerCheckedAt + 60_000)
        await f.model.refreshDashboard(enrich: false)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.remainingPercent, 40)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.usageObservedAt, newerCheckedAt)
    }

    @MainActor
    func testAnimatedNativePopoverKeepsUsageFrameThroughLoadMoreAndReopen() async throws {
        let f = try PopoverFixture()
        defer { f.remove() }
        let checkedAt = 1_780_000_000_000.0
        f.state.pagedHistory = true
        f.state.usageContext = "account-a:cli-one"
        f.state.usageAccount = usageAccount(remaining: 60, status: "available",
                                            checkedAt: checkedAt, observedAt: checkedAt)
        await f.model.refreshDashboard(enrich: false)
        await f.model.toggleDashboardPanel(.history)

        let screen = try XCTUnwrap(NSScreen.main)
        let anchorWindow = NSPanel(contentRect: NSRect(
            x: screen.visibleFrame.midX, y: screen.visibleFrame.maxY - 80,
            width: 40, height: 30
        ), styleMask: [.borderless], backing: .buffered, defer: false)
        anchorWindow.isReleasedWhenClosed = false
        let button = NSButton(frame: NSRect(x: 0, y: 0, width: 40, height: 30))
        anchorWindow.contentView = button
        anchorWindow.orderFrontRegardless()
        let popover = NSPopover()
        popover.animates = true
        var observedUsageFrames: [CGRect?] = []
        let host = NSHostingController(rootView: AnyView(
            DashboardPopoverView(onContentSizeChange: { size in
                popover.contentSize = NSSize(width: DashboardPopoverLayout.width, height: ceil(size.height))
            }, onUsageFrameChange: { observedUsageFrames.append($0) })
            .environmentObject(f.model)
        ))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        defer {
            popover.performClose(nil)
            anchorWindow.close()
        }
        for _ in 0..<25 {
            host.view.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(popover.isShown)
        XCTAssertTrue(popover.animates)
        let initialUsageFrame = try XCTUnwrap(observedUsageFrames.last ?? nil)
        let initialHeight = popover.contentSize.height
        let initialTop = try XCTUnwrap(host.view.window).frame.maxY
        XCTAssertGreaterThan(initialUsageFrame.height, 30)

        observedUsageFrames.removeAll()
        var publishedUsage: [Double?] = []
        let usageSubscription = f.model.$dashboard.sink {
            publishedUsage.append($0?.codexAccount?.weeklyUsage?.remainingPercent)
        }
        defer { usageSubscription.cancel() }
        f.state.usageAccount = nil
        f.state.delayHistory = true
        let load = Task { await f.model.loadMoreRecent() }
        var sampledHeights: [CGFloat] = []
        var sampledTops: [CGFloat] = []
        for _ in 0..<35 {
            host.view.layoutSubtreeIfNeeded()
            sampledHeights.append(popover.contentSize.height)
            if let window = host.view.window { sampledTops.append(window.frame.maxY) }
            XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.remainingPercent, 60)
            try await Task.sleep(for: .milliseconds(10))
        }
        await load.value
        XCTAssertEqual(f.model.dashboard?.terminalRows.count, 2)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.usageObservedAt, checkedAt)
        XCTAssertTrue(publishedUsage.allSatisfy { $0 == 60 })
        XCTAssertFalse(observedUsageFrames.contains { $0 == nil })
        for frame in observedUsageFrames.compactMap({ $0 }) {
            XCTAssertEqual(frame.minY, initialUsageFrame.minY, accuracy: 2)
            XCTAssertEqual(frame.height, initialUsageFrame.height, accuracy: 2)
        }
        XCTAssertTrue(sampledHeights.allSatisfy { $0 >= initialHeight - 2 })
        XCTAssertFalse(sampledTops.isEmpty)
        for top in sampledTops { XCTAssertEqual(top, initialTop, accuracy: 4) }

        popover.performClose(nil)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        for _ in 0..<20 {
            host.view.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(popover.isShown)
        XCTAssertNotNil(host.view.window)
        XCTAssertEqual(f.model.dashboard?.codexAccount?.weeklyUsage?.remainingPercent, 60)
        XCTAssertTrue(publishedUsage.allSatisfy { $0 == 60 })
    }

    @MainActor
    func testStatusChangesStayLocalWhileReopeningRefreshesAndSharesPendingEnrichment() async throws {
        let f = try PopoverFixture()
        defer { f.state.releaseEnrichment(); f.remove() }
        f.state.holdEnrichment = true
        await f.model.refreshDashboard()
        for _ in 0..<100 {
            if f.state.enrichmentReadCount > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(f.state.enrichmentReadCount, 1)

        let readsBeforeFilters = f.state.dashboardReadCount
        for panel in [DashboardPanel.running, .responseRequired, .problems] {
            await f.model.toggleDashboardPanel(panel)
            XCTAssertEqual(f.model.dashboardLoadedFilter, .all)
            XCTAssertEqual(f.model.dashboard?.scope, "all")
        }
        XCTAssertEqual(f.state.dashboardReadCount, readsBeforeFilters)
        f.model.setDashboardVisible(false)
        f.model.setDashboardVisible(true)
        await f.model.toggleDashboardPanel(.running)
        // Allow the same debounced refresh used by work-change notices to run.
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(f.state.enrichmentReadCount, 1)
        XCTAssertEqual(f.state.maximumConcurrentEnrichments, 1)

        f.state.releaseEnrichment()
        for _ in 0..<100 {
            if (f.model.dashboard?.enrichment?.cacheHits ?? 0) > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(f.model.dashboardPanel, .running)
        XCTAssertEqual(f.model.dashboardLoadedFilter, .all)
        XCTAssertEqual(f.model.dashboard?.scope, "all")
        XCTAssertEqual(f.model.dashboard?.enrichment?.cacheHits, 1)
        XCTAssertEqual(f.state.enrichmentReadCount, 1)
        XCTAssertTrue(f.model.bridgeConnected)
        XCTAssertNil(f.model.dashboardErrorMessage)
    }

    @MainActor
    func testPreparedSnapshotPaneChangesDoNotRequestHistory() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let model = f.model
        await model.refreshDashboard(enrich: false)
        XCTAssertNil(model.dashboardPanel)
        XCTAssertEqual(model.dashboard?.counts.running, 3)
        let initialReads = f.state.dashboardReadCount
        for panel in [DashboardPanel.running, .responseRequired, .problems] {
            await model.toggleDashboardPanel(panel)
            XCTAssertEqual(model.dashboardPanel, panel)
            XCTAssertEqual(model.dashboardLoadedFilter, .all)
            XCTAssertEqual(model.dashboard?.scope, "all")
        }
        XCTAssertEqual(f.state.dashboardReadCount, initialReads)
        await model.toggleDashboardPanel(.history)
        XCTAssertEqual(model.dashboardPanel, .history)
        XCTAssertEqual(f.state.dashboardReadCount, initialReads)
        XCTAssertEqual(model.dashboard?.historyIncluded, true)
        await model.toggleDashboardPanel(.history)
        XCTAssertNil(model.dashboardPanel)
        XCTAssertNotNil(model.dashboard)
        await model.toggleDashboardPanel(.problems)
        model.setDashboardVisible(false)
        XCTAssertNil(model.dashboardPanel)
        XCTAssertEqual(model.dashboardStatusFilter, .all)
    }

    @MainActor
    func testStatusRowLoadsItsEarlierExecutionsOnlyWhenExpanded() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.rowCount = 1
        await f.model.refreshDashboard(enrich: false)
        let row = try XCTUnwrap(f.model.dashboard?.statusRows?.first)
        XCTAssertEqual(row.history?.count, 0)
        XCTAssertEqual(row.historyCount, 1)
        XCTAssertNil(f.model.dashboardHistory(for: row))

        await f.model.loadDashboardHistory(row)

        XCTAssertEqual(f.model.dashboardHistory(for: row)?.historyCount, 1)
        XCTAssertEqual(f.model.dashboardHistory(for: row)?.history.first?.activityTitle, "Earlier task")
    }

    @MainActor
    func testIssue251EmbeddedHistoryAndCacheSurviveRefreshAndTabs() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.rowCount = 1
        await f.model.refreshDashboard(enrich: false)
        let row = try XCTUnwrap(f.model.dashboard?.statusRows?.first)
        await f.model.loadDashboardHistory(row)
        let cached = try XCTUnwrap(f.model.dashboardHistory(for: row))
        await f.model.toggleDashboardPanel(.running)
        await f.model.toggleDashboardPanel(.problems)
        await f.model.refreshDashboard(enrich: false)
        let refreshed = try XCTUnwrap(f.model.dashboard?.statusRows?.first)
        XCTAssertEqual(f.model.dashboardHistory(for: refreshed)?.history.count, cached.history.count)
        await f.model.loadDashboardHistory(refreshed)
        XCTAssertEqual(f.state.historyReadCount, 1)

        var policyChanged = refreshed
        policyChanged.policyRevision = String(repeating: "e", count: 64)
        XCTAssertNil(f.model.dashboardHistory(for: policyChanged))
        var executionChanged = refreshed
        executionChanged.representativeExecutionKey = String(repeating: "e", count: 32)
        XCTAssertNil(f.model.dashboardHistory(for: executionChanged))
        var expired = refreshed
        expired.nextExpiryAt = "2000-01-01T00:00:00.000Z"
        XCTAssertNil(f.model.dashboardHistory(for: expired))
        XCTAssertTrue(f.model.dashboardEmbeddedHistory(for: expired).isEmpty)
        var otherProject = refreshed
        // Context isolation is checked independently from the server revisions.
        otherProject.policyRevision = nil
        XCTAssertNil(f.model.dashboardHistory(for: otherProject))
    }

    @MainActor
    func testIssue251EmbeddedSummariesOnlyFetchExplicitAdditionalPages() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.rowCount = 1
        f.state.pagedDetail = true
        await f.model.refreshDashboard(enrich: false)
        let base = try XCTUnwrap(f.model.dashboard?.statusRows?.first)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(base)) as? [String: Any])
        func turn(_ i: Int) -> [String: Any] {
            ["executionKey": String(format: "%032d", i), "activityTitle": "History \(i)", "status": "completed",
             "startedAt": "2026-09-09T23:59:55Z", "updatedAt": "2026-09-10T00:00:00Z", "durationMs": 5000]
        }
        object["history"] = (1...3).map(turn)
        object["historyCount"] = 16
        object["historyHasMore"] = true
        let row = try JSONDecoder().decode(DashboardRow.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(f.model.dashboardEmbeddedHistory(for: row).count, 3)
        await f.model.loadDashboardHistory(row)
        XCTAssertEqual(f.state.historyReadCount, 0)
        await f.model.loadDashboardHistory(row, more: true)
        XCTAssertEqual(f.model.dashboardHistory(for: row)?.history.count, 12)
        await f.model.loadDashboardHistory(row, more: true)
        XCTAssertEqual(f.model.dashboardHistory(for: row)?.history.count, 16)
        XCTAssertEqual(f.state.historyReadCount, 2)
        await f.model.loadDashboardHistory(row, more: true)
        XCTAssertEqual(f.state.historyReadCount, 2)
        object["projectKey"] = "different-project"
        let other = try JSONDecoder().decode(DashboardRow.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(f.model.dashboardHistory(for: other))
    }

    @MainActor
    func testR2ExpiredPageCannotBorrowNewSnapshotExpiryBeforePhysicalCleanup() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let start = Date(timeIntervalSince1970: 1_000_000)
        var clock = start
        f.model.dashboardHistoryNow = { clock }
        let oldExpiry = ISO8601DateFormatter().string(from: start.addingTimeInterval(1))
        let nextExpiry = ISO8601DateFormatter().string(from: start.addingTimeInterval(86_400))
        f.state.rowCount = 1
        f.state.expiryScenario = true
        f.state.rowExpiry = oldExpiry; f.state.detailExpiry = oldExpiry
        f.state.retainedHistoryCount = 2
        await f.model.refreshDashboard(enrich: false)
        let original = try XCTUnwrap(f.model.dashboard?.statusRows?.first)
        await f.model.loadDashboardHistory(original)
        XCTAssertEqual(f.model.dashboardHistory(for: original)?.history.count, 2)
        clock = start.addingTimeInterval(0.999)
        await f.model.loadDashboardHistory(original)
        XCTAssertEqual(f.state.historyReadCount, 1, "Still-valid caches do not issue another read")
        clock = start.addingTimeInterval(1)
        XCTAssertNil(f.model.dashboardHistory(for: original), "The page expires at its own boundary")
        // No physical sweep or content revision change: only the logical set advances.
        f.state.rowExpiry = nextExpiry; f.state.detailExpiry = nextExpiry
        f.state.retainedHistoryCount = 1
        await f.model.refreshDashboard(enrich: false)
        let fresh = try XCTUnwrap(f.model.dashboard?.statusRows?.first)
        XCTAssertEqual(fresh.historyRevision, original.historyRevision)
        XCTAssertNil(f.model.dashboardHistory(for: fresh), "A later nextExpiryAt must not revive the old page")
        XCTAssertEqual(f.state.historyReadCount, 1, "Structural refresh never fetches history implicitly")
        await f.model.loadDashboardHistory(fresh)
        XCTAssertEqual(f.model.dashboardHistory(for: fresh)?.history.count, 1)
        XCTAssertEqual(f.state.historyReadCount, 2)
    }

    @MainActor
    func testR2InflightAdditionalPageCrossingExpiryCannotMergeOldBase() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let start = Date(timeIntervalSince1970: 1_000_000)
        var clock = start
        f.model.dashboardHistoryNow = { clock }
        let oldExpiry = ISO8601DateFormatter().string(from: start.addingTimeInterval(1))
        let nextExpiry = ISO8601DateFormatter().string(from: start.addingTimeInterval(86_400))
        f.state.rowCount = 1; f.state.expiryScenario = true
        f.state.rowExpiry = oldExpiry; f.state.detailExpiry = oldExpiry
        f.state.retainedHistoryCount = 2
        await f.model.refreshDashboard(enrich: false)
        let original = try XCTUnwrap(f.model.dashboard?.statusRows?.first)
        await f.model.loadDashboardHistory(original)
        f.state.detailResponseDelay = 0.1
        let page = Task { await f.model.loadDashboardHistory(original, more: true) }
        while f.state.historyReadCount < 2 { await Task.yield() }
        clock = start.addingTimeInterval(1)
        f.state.rowExpiry = nextExpiry; f.state.detailExpiry = nextExpiry
        f.state.retainedHistoryCount = 1
        await page.value
        let fresh = try XCTUnwrap(f.model.dashboard?.statusRows?.first)
        XCTAssertNil(f.model.dashboardHistory(for: fresh))
        XCTAssertTrue(f.model.dashboardHistoryDetails.isEmpty)
        XCTAssertEqual(f.state.historyReadCount, 2)
    }

    func testReviewBackgroundIndependentPageFromActualServerWithTwentySixProgressJobs() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let snapshot = try JSONDecoder().decode(DashboardSnapshot.self,
            from: Data(contentsOf: root.appendingPathComponent("test/fixtures/background-independent-page.json")))
        XCTAssertEqual(snapshot.activeRows.count, 12)
        XCTAssertEqual(snapshot.counts.progressJobCount, 26)
        XCTAssertEqual(snapshot.counts.executionCount, 1)
        XCTAssertEqual(snapshot.backgroundPagination?.total, 1)
        XCTAssertEqual(DashboardPanel.background.rows(in: snapshot).count, 1)
        XCTAssertEqual(DashboardPanel.running.rows(in: snapshot).count, 12)
    }

    @MainActor
    func testReviewBackgroundPagingWorksAndRejectsChangedOrLatePages() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        var first = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("test/fixtures/background-independent-page.json"))) as? [String: Any])
        let original = (first["backgroundRows"] as! [[String: Any]])[0]
        func owner(_ i: Int) -> [String: Any] { var row = original; row["rowKey"] = String(format: "%032d", i + 1); row["conversationKey"] = "owner-scope-\(i)"; return row }
        let initial = (0..<12).map(owner)
        first["backgroundRows"] = initial; first["backgroundRevision"] = String(repeating: "a", count: 64)
        first["backgroundPagination"] = ["offset": 0, "limit": 12, "returned": 12, "total": 13, "returnedConversations": 12, "conversationTotal": 13, "hasNext": true, "hasPrevious": false]
        var counts = first["counts"] as! [String: Any]; counts["backgroundProcesses"] = 13; counts["backgroundProcessAgents"] = 13; first["counts"] = counts
        var next = first; next["backgroundRows"] = [owner(12)]
        next["backgroundPagination"] = ["offset": 12, "limit": 12, "returned": 1, "total": 13, "returnedConversations": 1, "conversationTotal": 13, "hasNext": false, "hasPrevious": true]
        func encoded(_ object: [String: Any]) throws -> String { String(data: try JSONSerialization.data(withJSONObject: object), encoding: .utf8)! }
        f.state.dashboardJSON = try encoded(first); f.state.backgroundPageJSON = try encoded(next)
        await f.model.refreshDashboard(enrich: false); await f.model.loadMoreBackground()
        XCTAssertEqual(f.model.dashboard?.backgroundRows?.count, 13)
        XCTAssertEqual(f.model.dashboard?.backgroundPagination?.hasNext, false)
        XCTAssertEqual(f.state.backgroundPageOffsets, [12])
        XCTAssertEqual(f.model.dashboard?.activeRows.count, 12)
        XCTAssertEqual(f.model.dashboard?.terminalRows.count, 1)

        await f.model.refreshDashboard(enrich: false)
        next["backgroundRevision"] = String(repeating: "b", count: 64); f.state.backgroundPageJSON = try encoded(next)
        let before = f.state.dashboardReadCount
        await f.model.loadMoreBackground()
        XCTAssertGreaterThanOrEqual(f.state.dashboardReadCount, before + 2)
        XCTAssertEqual(f.model.dashboard?.backgroundRows?.count, 12, "Changed owner identities must rebase, not merge")

        next["backgroundRevision"] = first["backgroundRevision"]
        f.state.backgroundPageJSON = try encoded(next); f.state.backgroundPageDelay = 0.1
        let beforeLate = f.state.dashboardReadCount
        let pending = Task { await f.model.loadMoreBackground() }
        while f.state.dashboardReadCount == beforeLate { await Task.yield() }
        await f.model.refreshDashboard(enrich: false); await pending.value
        XCTAssertEqual(f.model.dashboard?.backgroundRows?.count, 12, "A late page cannot cross a newer snapshot generation")
    }

    func testReviewCompletedJobUsesOneCurrentBackgroundOwnerFromServerProjection() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let snapshot = try JSONDecoder().decode(DashboardSnapshot.self,
            from: Data(contentsOf: root.appendingPathComponent("test/fixtures/terminal-background-projection.json")))
        XCTAssertEqual(snapshot.counts.backgroundProcesses, 1)
        XCTAssertEqual(snapshot.counts.progressJobCount, 0)
        XCTAssertEqual(snapshot.counts.executionCount, 1)
        XCTAssertEqual(snapshot.terminalRows.count, 1)
        XCTAssertEqual(snapshot.terminalRows.first?.status, "completed")
        XCTAssertEqual(snapshot.terminalRows.first?.backgroundProcessCount, 0)
        XCTAssertEqual(DashboardPanel.background.rows(in: snapshot).count, 1)
        XCTAssertEqual(DashboardPanel.history.rows(in: snapshot).count, 1)
        // Identity cannot be reduced to a name or Activity heading.
        let original = try XCTUnwrap(DashboardPanel.background.rows(in: snapshot).first)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        object["rowKey"] = String(repeating: "b", count: 32); object["conversationKey"] = "another-scope"
        let distinct = try JSONDecoder().decode(DashboardRow.self, from: JSONSerialization.data(withJSONObject: object))
        var twoOwners = snapshot; twoOwners.activeRows.append(distinct)
        XCTAssertEqual(DashboardPanel.background.rows(in: twoOwners).count, 2)
    }

    @MainActor
    func testReviewBackgroundIncludesAnActiveJobOutsideTheTerminalStatusPage() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true; f.state.rowCount = 1
        await f.model.refreshDashboard(enrich: false)
        var snapshot = try XCTUnwrap(f.model.dashboard)
        let original = try XCTUnwrap(snapshot.activeRows.first)
        var activeObject = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        activeObject["backgroundProcessCount"] = 1
        let active = try JSONDecoder().decode(DashboardRow.self, from: JSONSerialization.data(withJSONObject: activeObject))
        snapshot.activeRows = [active]; snapshot.terminalRows = []; snapshot.statusRows = []
        XCTAssertEqual(DashboardPanel.background.rows(in: snapshot).map { $0.jobId }, [active.jobId])
    }

    @MainActor
    func testProblemHistoryHidesExpiredJobEvenWhenItsRecoveryIncidentIsRetained() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true; f.state.rowCount = 1
        let start = ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")!
        var clock = start
        f.model.dashboardHistoryNow = { clock }
        await f.model.refreshDashboard(enrich: false)
        let problems = try XCTUnwrap(f.model.dashboard?.problems)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(try XCTUnwrap(problems.rows.first))) as? [String: Any])
        var row = object["row"] as! [String: Any], turn = row["latestTurn"] as! [String: Any]
        turn["endedAt"] = ISO8601DateFormatter().string(from: start.addingTimeInterval(-30 * 86400 + 1)); turn["error"] = "Retained incident failure"
        row["latestTurn"] = turn; object["row"] = row; object["reason"] = "Retained incident failure"
        object["occurredAt"] = ISO8601DateFormatter().string(from: start)
        let problem = try JSONDecoder().decode(DashboardProblem.self, from: JSONSerialization.data(withJSONObject: object))
        let section = DashboardProblemsSection(problems: problems)
        XCTAssertNil(section.contextReason(problem, using: f.model), "Valid linked execution renders the reason once")
        clock = start.addingTimeInterval(1)
        XCTAssertFalse(ExecutionRecordPresentation.retained(problem.row, days: 30, now: clock))
        var retainedObject = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(problems)) as? [String: Any])
        retainedObject["rows"] = [object]
        let retained = try JSONDecoder().decode(DashboardProblems.self, from: JSONSerialization.data(withJSONObject: retainedObject))
        XCTAssertEqual(f.model.dashboardRetainedProblems(retained).count, 0)
        XCTAssertEqual(section.contextReason(problem, using: f.model), "Retained incident failure",
            "An unavailable execution cannot consume the still-retained incident reason")
    }

    @MainActor
    func testProblemHistoryAppendsJobsUnderOneAgentAndRejectsChangedPages() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true
        f.model.dashboardHistoryNow = { ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")! }
        await f.model.refreshDashboard(enrich: false)
        var first = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(try XCTUnwrap(f.model.dashboard))) as? [String: Any])
        let original = (first["problems"] as! [String: Any])["rows"] as! [[String: Any]]
        func problem(_ index: Int) -> [String: Any] {
            var value = original[0], row = value["row"] as! [String: Any]
            let id = "problem-\(index)"
            value["problemKey"] = id; value["jobId"] = id
            row["jobId"] = id; row["rowKey"] = id
            value["row"] = row
            return value
        }
        func collection(_ rows: [[String: Any]], offset: Int, revision: String = "stable-jobs") -> [String: Any] {
            ["query": ["review": "pending", "kind": "all", "offset": offset], "revision": revision, "affectedExecutionCount": 13,
             "pendingCount": 0, "acknowledgedCount": 0, "reviewableCount": 0, "rows": rows,
             "page": ["offset": offset, "limit": 12, "total": 13, "returned": rows.count, "hasPrevious": offset > 0, "hasNext": offset == 0]]
        }
        func encoded(_ object: [String: Any]) throws -> String { String(data: try JSONSerialization.data(withJSONObject: object), encoding: .utf8)! }
        first["problems"] = collection((0..<12).map(problem), offset: 0)
        var next = first; next["problems"] = collection([problem(12)], offset: 12)
        f.state.dashboardJSON = try encoded(first); f.state.problemPageJSON = try encoded(next)
        await f.model.refreshDashboard(enrich: false); await f.model.loadMoreProblems()
        let merged = try XCTUnwrap(f.model.dashboard?.problems)
        XCTAssertEqual(merged.rows.count, 13)
        XCTAssertEqual(Set(merged.rows.compactMap(\.jobId)).count, 13)
        XCTAssertFalse(merged.page.hasNext)
        XCTAssertEqual(DashboardAgentGroup.group(merged.rows.map(\.row)).count, 1)
        XCTAssertEqual(f.model.dashboardRetainedProblems(merged).count, 13)
        XCTAssertEqual(f.state.problemPageOffsets, [12])
        XCTAssertEqual(f.state.exactDetailReads, 0)

        await f.model.refreshDashboard(enrich: false)
        XCTAssertEqual(f.model.dashboard?.problems?.rows.count, 13, "An unchanged refresh keeps the expanded problem page")
        first["problems"] = collection((0..<12).map(problem), offset: 0, revision: "reloaded-jobs")
        f.state.dashboardJSON = try encoded(first)
        await f.model.refreshDashboard(enrich: false)
        var changed = next["problems"] as! [String: Any]; changed["revision"] = "changed-jobs"; next["problems"] = changed
        f.state.problemPageJSON = try encoded(next)
        let before = f.state.dashboardReadCount
        await f.model.loadMoreProblems()
        XCTAssertGreaterThanOrEqual(f.state.dashboardReadCount, before + 2)
        XCTAssertEqual(f.model.dashboard?.problems?.rows.count, 12)
        XCTAssertFalse(f.model.loadingMoreProblems)

        next["problems"] = collection([problem(12)], offset: 12, revision: "reloaded-jobs")
        f.state.problemPageJSON = try encoded(next); f.state.problemPageDelay = 0.1
        let beforeLate = f.state.dashboardReadCount
        let pending = Task { await f.model.loadMoreProblems() }
        for _ in 0..<100 {
            if f.state.dashboardReadCount > beforeLate { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertGreaterThan(f.state.dashboardReadCount, beforeLate)
        await f.model.refreshDashboard(enrich: false); await pending.value
        XCTAssertEqual(f.model.dashboard?.problems?.rows.count, 12)
    }

    @MainActor
    func testProblemHistoryOmitsDuplicateSystemAndUnavailableRows() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true
        f.model.dashboardHistoryNow = { ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")! }
        await f.model.refreshDashboard(enrich: false)
        let problems = try XCTUnwrap(f.model.dashboard?.problems)
        let visible = f.model.dashboardRetainedProblems(problems)
        XCTAssertEqual(visible.count, 2)
        XCTAssertEqual(Set(visible.compactMap(\.jobId)).count, 2)
        XCTAssertTrue(visible.allSatisfy { $0.source == "execution" && $0.executionAvailability == "retained" })
    }

    @MainActor
    func testReviewProblemReasonKeepsOnlyDistinctIncidentContext() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true; f.state.rowCount = 1
        await f.model.refreshDashboard(enrich: false)
        let original = try XCTUnwrap(f.model.dashboard?.problems?.rows.first)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        var row = object["row"] as! [String: Any], turn = row["latestTurn"] as! [String: Any]
        turn["error"] = "Exact failure"; object["reason"] = "Exact failure"
        row["latestTurn"] = turn; object["row"] = row
        func decoded() throws -> DashboardProblem { try JSONDecoder().decode(DashboardProblem.self, from: JSONSerialization.data(withJSONObject: object)) }
        var problem = try decoded()
        XCTAssertNil(ProblemReasonPresentation.contextReason(problem, turn: problem.row.latestTurn))
        object["reason"] = "Worker recovery pending"; problem = try decoded()
        XCTAssertEqual(ProblemReasonPresentation.contextReason(problem, turn: problem.row.latestTurn), "Worker recovery pending")
        object["reason"] = "Exact failure"; object["jobId"] = NSNull(); object["source"] = "runtime"; object["executionAvailability"] = "not-linked"
        problem = try decoded()
        XCTAssertEqual(ProblemReasonPresentation.contextReason(problem, turn: problem.row.latestTurn), "Exact failure")
    }

    @MainActor
    func testReviewMergedPagesScheduleEarlierLocalExpiryEvenIfRefreshFails() async throws {
        for background in [false, true] {
            let f = try PopoverFixture(); defer { f.remove() }
            f.state.jobsContract = true; f.state.rowCount = 1
            let start = ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")!
            var clock = start
            f.model.dashboardHistoryNow = { clock }
            await f.model.refreshDashboard(enrich: false)
            var first = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(try XCTUnwrap(f.model.dashboard))) as? [String: Any])
            let row = (first["terminalRows"] as! [[String: Any]])[0]
            let page: [String: Any] = ["offset": 0, "limit": 12, "returned": 1, "total": 2, "returnedConversations": 1, "conversationTotal": 2, "hasNext": true, "hasPrevious": false]
            first["activeRows"] = []; first["statusRows"] = []; first["problems"] = NSNull()
            first["terminalRows"] = [row]
            var pagination = first["pagination"] as! [String: Any]; pagination["terminal"] = page; first["pagination"] = pagination
            first["backgroundRows"] = background ? [row] : []
            first["backgroundPagination"] = page; first["backgroundRevision"] = "stable-owners"
            func encoded(_ object: [String: Any]) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self) }
            f.state.dashboardJSON = try encoded(first)
            await f.model.refreshDashboard(enrich: false)
            var expiring = row, turn = row["latestTurn"] as! [String: Any]
            turn["endedAt"] = ISO8601DateFormatter().string(from: start.addingTimeInterval(-30 * 86400 + 1))
            turn["summary"] = "Expiring appended detail"
            expiring["latestTurn"] = turn; expiring["rowKey"] = "appended-row"; expiring["jobId"] = "appended-job"
            var next = first, nextPage = page
            nextPage["offset"] = 1; nextPage["returned"] = 1; nextPage["hasNext"] = false; nextPage["hasPrevious"] = true
            if background {
                next["backgroundRows"] = [expiring]; next["backgroundPagination"] = nextPage
                f.state.backgroundPageJSON = try encoded(next)
                await f.model.loadMoreBackground()
            } else {
                next["terminalRows"] = [expiring]; pagination["terminal"] = nextPage; next["pagination"] = pagination
                f.state.dashboardJSON = try encoded(next)
                await f.model.loadMoreRecent()
            }
            let rows = background ? f.model.dashboard?.backgroundRows : f.model.dashboard?.terminalRows
            XCTAssertEqual(rows?.count, 2)
            let appended = try XCTUnwrap(rows?.last)
            let target = try XCTUnwrap(f.model.executionTarget(row: appended))
            XCTAssertGreaterThan(try XCTUnwrap(target.expiresAt), clock)
            let before = f.state.dashboardReadCount
            var invalidations = 0
            let subscription = f.model.objectWillChange.sink { invalidations += 1 }
            f.state.failDashboard = true; clock = start.addingTimeInterval(1)
            try await Task.sleep(for: .milliseconds(1200))
            XCTAssertGreaterThan(f.state.dashboardReadCount, before, "Merged \(background ? "Background" : "History") must reschedule the earlier boundary")
            XCTAssertGreaterThan(invalidations, 0, "Local expiry must repaint even if refresh fails")
            XCTAssertFalse(ExecutionRecordPresentation.retained(appended, days: 30, now: clock), "The repainted record must hide its expired summary and detail")
            XCTAssertNotNil(f.model.dashboardErrorMessage)
            subscription.cancel()
        }
    }

    @MainActor
    func testReviewProblemOnlyExpiryRepaintsWithoutSuccessfulRefresh() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true; f.state.rowCount = 1
        let start = ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")!
        var clock = start
        f.model.dashboardHistoryNow = { clock }
        await f.model.refreshDashboard(enrich: false)
        let snapshot = try XCTUnwrap(f.model.dashboard)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any])
        var failed = try XCTUnwrap((object["problems"] as? [String: Any])?["rows"] as? [[String: Any]]).first!
        var row = failed["row"] as! [String: Any], turn = row["latestTurn"] as! [String: Any]
        let ended = start.addingTimeInterval(-30 * 86400 + 1)
        turn["endedAt"] = ISO8601DateFormatter().string(from: ended); turn["summary"] = "Expiring preview"; turn["error"] = "Expiring failure"
        row["latestTurn"] = turn; row["nextExpiryAt"] = ISO8601DateFormatter().string(from: start.addingTimeInterval(1))
        failed["row"] = row; failed["occurredAt"] = turn["endedAt"]; failed["reason"] = "Expiring failure"
        var problems = object["problems"] as! [String: Any]; problems["rows"] = [failed]; object["problems"] = problems
        object["statusRows"] = []; object["activeRows"] = []; object["terminalRows"] = Array(repeating: (object["terminalRows"] as! [[String: Any]])[0], count: 12)
        f.state.dashboardJSON = String(data: try JSONSerialization.data(withJSONObject: object), encoding: .utf8)
        await f.model.refreshDashboard(enrich: false)
        let before = f.state.dashboardReadCount
        var invalidations = 0
        let subscription = f.model.objectWillChange.sink { invalidations += 1 }
        f.state.failDashboard = true; clock = start.addingTimeInterval(1)
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertGreaterThan(f.state.dashboardReadCount, before)
        XCTAssertGreaterThan(invalidations, 0, "A local expiry must invalidate views even without a replacement snapshot")
        XCTAssertNotNil(f.model.dashboard, "A failed refresh retains the other valid summaries")
        XCTAssertNotNil(f.model.dashboardErrorMessage)
        XCTAssertTrue(f.model.dashboardRetainedProblems(try XCTUnwrap(f.model.dashboard?.problems)).isEmpty,
            "Expired problem preview and duplicated error must disappear from the rendered collection")
        XCTAssertEqual(DashboardPanel.history.rows(in: try XCTUnwrap(f.model.dashboard), now: clock).count, 12)
        subscription.cancel()
    }

    @MainActor
    func testJobModeCountsEveryTerminalJobAndSeparatesSystemEvents() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true; f.state.rowCount = 1
        f.model.dashboardHistoryNow = { ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")! }
        await f.model.refreshDashboard(enrich: false)
        let snapshot = try XCTUnwrap(f.model.dashboard)
        XCTAssertEqual(snapshot.historyModeApplied, "jobs")
        XCTAssertEqual(snapshot.counts.executionCount, 4)
        XCTAssertEqual(snapshot.counts.progressJobCount, 1)
        XCTAssertEqual(DashboardPanel.history.rows(in: snapshot, now: f.model.dashboardHistoryNow()).count, 4)
        XCTAssertEqual(DashboardPanel.running.rows(in: snapshot).count, 1, "Progress consumes its own Job page, not the terminal status page")
        XCTAssertEqual(Set(snapshot.terminalRows.map { $0.status }), ["completed", "failed", "interrupted", "cancelled"])
        XCTAssertEqual(Set(snapshot.terminalRows.map { $0.agentId }).count, 1)
        XCTAssertEqual(Set(snapshot.terminalRows.map { $0.jobId }).count, 4)
        XCTAssertTrue(snapshot.terminalRows.allSatisfy { $0.historyCount == 0 })
        XCTAssertEqual(snapshot.problems?.affectedExecutionCount, 2)
        XCTAssertEqual(snapshot.problems?.systemIncidentCount, 1)
        XCTAssertEqual(snapshot.problems?.unavailableExecutionCount, 1)
        XCTAssertEqual(snapshot.problems?.incidentCount, 5)
        XCTAssertEqual(ExecutionRecordPresentation.statusKey("cancelled"), "execution.cancelled")
        XCTAssertEqual(snapshot.terminalRows.last?.reasonAvailability, "unrecorded")
    }

    @MainActor
    func testHistoryPagesPreserveNewestEndOrderWhenStartOrderDiffers() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true; f.state.rowCount = 1
        let clock = ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")!
        f.model.dashboardHistoryNow = { clock }
        await f.model.refreshDashboard(enrich: false)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(try XCTUnwrap(f.model.dashboard))) as? [String: Any])
        var rows = object["terminalRows"] as! [[String: Any]]
        for index in rows.indices {
            var turn = rows[index]["latestTurn"] as! [String: Any]
            let start = ISO8601DateFormatter().string(from: clock.addingTimeInterval(Double(-1000 + index * 100)))
            turn["startedAt"] = start
            turn["endedAt"] = ISO8601DateFormatter().string(from: clock.addingTimeInterval(Double(-10 - index * 10)))
            rows[index]["createdAt"] = start; rows[index]["latestTurn"] = turn
        }
        let expected = rows.map { $0["jobId"] as! String }
        func encoded(_ value: [String: Any]) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
        }
        var pagination = object["pagination"] as! [String: Any]
        var page: [String: Any] = ["offset": 0, "limit": 2, "returned": 2, "total": 4,
            "returnedConversations": 1, "conversationTotal": 1, "hasPrevious": false, "hasNext": true]
        object["terminalRows"] = Array(rows.prefix(2)); object["activeRows"] = []; object["statusRows"] = []
        pagination["terminal"] = page; object["pagination"] = pagination; object["historyIncluded"] = true
        f.state.dashboardJSON = try encoded(object)
        await f.model.refreshDashboard(enrich: false)
        XCTAssertEqual(DashboardPanel.history.rows(in: try XCTUnwrap(f.model.dashboard), now: clock).compactMap(\.jobId), Array(expected.prefix(2)))
        page["offset"] = 2; page["hasPrevious"] = true; page["hasNext"] = false
        object["terminalRows"] = Array(rows.suffix(2)); pagination["terminal"] = page; object["pagination"] = pagination
        f.state.dashboardJSON = try encoded(object)
        await f.model.loadMoreRecent()
        let displayed = DashboardPanel.history.rows(in: try XCTUnwrap(f.model.dashboard), now: clock)
        XCTAssertEqual(displayed.compactMap(\.jobId), expected)
        XCTAssertEqual(DashboardAgentGroup.group(displayed).flatMap(\.rows).compactMap(\.jobId), expected)
    }

    @MainActor
    func testReviewLiveBadgeSurvivesHealthyExactDetailBeforeAndAfterHealthLoss() async throws {
        for cacheBefore in [true, false] {
            for (runtime, status) in [("orphaned", "orphaned"), ("idle", "liveness-unknown"), ("not-loaded", "liveness-unknown")] {
                let f = try PopoverFixture(); defer { f.remove() }
                f.state.jobsContract = true; f.state.rowCount = 1; f.state.exactDetailIsActive = true
                f.model.dashboardHistoryNow = { ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")! }
                await f.model.refreshDashboard(enrich: false)
                var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(try XCTUnwrap(f.model.dashboard))) as? [String: Any])
                var row = (object["activeRows"] as! [[String: Any]])[0]
                var turn = row["latestTurn"] as! [String: Any]
                row["rowKey"] = "job-running"; row["jobId"] = "job-running"; row["status"] = "running"
                turn["jobId"] = "job-running"; turn["status"] = "running"; turn["endedAt"] = NSNull(); row["latestTurn"] = turn
                func publish(_ current: [String: Any]) async throws {
                    object["activeRows"] = [current]; object["statusRows"] = [current]; object["terminalRows"] = []; object["problems"] = NSNull()
                    f.state.dashboardJSON = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
                    await f.model.refreshDashboard(enrich: false)
                }
                try await publish(row)
                let healthy = try XCTUnwrap(f.model.dashboard?.activeRows.first)
                let original = try XCTUnwrap(f.model.executionTarget(row: healthy))
                if cacheBefore { await f.model.loadExecutionDetail(original) }
                row["status"] = status; turn["status"] = status; row["latestTurn"] = turn
                try await publish(row)
                let unhealthy = try XCTUnwrap(f.model.dashboard?.activeRows.first)
                let target = try XCTUnwrap(f.model.executionTarget(row: unhealthy))
                XCTAssertEqual(target.revision, original.revision, "Runtime health does not mutate durable content identity")
                await f.model.loadExecutionDetail(target)
                XCTAssertEqual(f.state.exactDetailReads, 1, "Healthy cached detail must remain reusable")
                XCTAssertEqual(f.model.executionDetail(target)?.execution.status, "running")
                XCTAssertEqual(ExecutionRecordView(row: unhealthy).presentationStatus(using: f.model), status,
                    "\(runtime), detail cached before health loss: \(cacheBefore)")
                XCTAssertNotNil(f.model.executionDetail(original), "Badge correction must preserve the exact detail cache")
                for currentStatus in ["running", "input-required", "approval-required", "terminating", "termination-failed"] {
                    row["status"] = currentStatus; turn["status"] = currentStatus; row["latestTurn"] = turn
                    row["backgroundProcessCount"] = currentStatus == "running" ? 1 : 0
                    try await publish(row)
                    let current = try XCTUnwrap(f.model.dashboard?.activeRows.first)
                    XCTAssertEqual(ExecutionRecordView(row: current).presentationStatus(using: f.model), currentStatus)
                    XCTAssertNotNil(f.model.executionDetail(f.model.executionTarget(row: current)))
                }
                XCTAssertEqual(f.state.exactDetailReads, 1)
            }
        }
    }

    @MainActor
    func testReviewTerminalBadgeKeepsExactDetailPrecedence() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true; f.state.rowCount = 1
        f.model.dashboardHistoryNow = { ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")! }
        await f.model.refreshDashboard(enrich: false)
        for row in try XCTUnwrap(f.model.dashboard?.terminalRows) {
            let target = try XCTUnwrap(f.model.executionTarget(row: row))
            await f.model.loadExecutionDetail(target)
            XCTAssertEqual(ExecutionRecordView(row: row).presentationStatus(using: f.model), row.status)
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(row)) as? [String: Any])
            object["status"] = "orphaned"
            let staleRow = try JSONDecoder().decode(DashboardRow.self, from: JSONSerialization.data(withJSONObject: object))
            XCTAssertEqual(ExecutionRecordView(row: staleRow).presentationStatus(using: f.model), row.status,
                "An ended Job retains exact terminal semantics")
        }
        XCTAssertEqual(f.state.exactDetailReads, 4)
    }

    @MainActor
    func testExactJobDetailCacheSurvivesRefreshAndRejectsExpiryAndLateReplies() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true; f.state.rowCount = 1
        var now = ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")!
        f.model.dashboardHistoryNow = { now }
        await f.model.refreshDashboard(enrich: false)
        let row = try XCTUnwrap(f.model.dashboard?.terminalRows.first)
        let target = try XCTUnwrap(f.model.executionTarget(row: row))
        XCTAssertEqual(f.state.exactDetailReads, 0, "Prepared summary rendering never loads exact detail")
        await f.model.loadExecutionDetail(target)
        await f.model.loadExecutionDetail(target)
        XCTAssertEqual(f.state.exactDetailReads, 1)
        XCTAssertEqual(f.model.executionDetail(target)?.jobId, "job-completed")
        await f.model.refreshDashboard(enrich: false)
        XCTAssertNotNil(f.model.executionDetail(target))
        now = ISO8601DateFormatter().date(from: "2026-10-10T00:00:00Z")!
        XCTAssertNil(f.model.executionDetail(target))
        now = ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")!
        let other = try XCTUnwrap(f.model.dashboard?.terminalRows[1])
        let delayed = try XCTUnwrap(f.model.executionTarget(row: other))
        f.state.exactDetailDelay = 0.1
        let request = Task { await f.model.loadExecutionDetail(delayed) }
        while f.state.exactDetailReads < 2 { await Task.yield() }
        await f.model.refreshDashboard(enrich: false)
        await request.value
        XCTAssertNil(f.model.executionDetail(delayed), "A late exact reply cannot replace a newer snapshot")
        XCTAssertEqual(f.state.exactDetailReads, 2)
    }

    @MainActor
    func testUnsupportedJobModeRetriesLegacyWithoutInventingJobIdentity() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.rowCount = 1; f.state.rejectJobsMode = true
        await f.model.refreshDashboard(enrich: false)
        XCTAssertEqual(f.state.dashboardReadCount, 2)
        XCTAssertNil(f.model.dashboard?.historyModeApplied)
        XCTAssertNil(f.model.dashboard?.statusRows?.first?.jobId)
        XCTAssertEqual(f.state.exactDetailReads, 0)
    }

    @MainActor
    func testStaleDeferredHistoryRefreshesInsteadOfAttachingToANewExecution() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.rowCount = 1
        await f.model.refreshDashboard(enrich: false)
        let row = try XCTUnwrap(f.model.dashboard?.statusRows?.first)
        let readsBefore = f.state.dashboardReadCount
        f.state.detailHistoryRevision = String(repeating: "b", count: 64)

        await f.model.loadDashboardHistory(row)

        XCTAssertNil(f.model.dashboardHistory(for: row))
        XCTAssertNil(f.model.dashboardHistoryError(for: row))
        XCTAssertEqual(f.state.dashboardReadCount, readsBefore + 1)
    }

    @MainActor
    func testCachedHistoryIsDiscardedWhenTheSameAgentRowRepresentsANewExecution() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.rowCount = 1
        await f.model.refreshDashboard(enrich: false)
        let row = try XCTUnwrap(f.model.dashboard?.statusRows?.first)
        await f.model.loadDashboardHistory(row)
        XCTAssertNotNil(f.model.dashboardHistory(for: row))

        var replacement = row
        replacement.historyRevision = String(repeating: "b", count: 64)
        f.state.detailHistoryRevision = replacement.historyRevision!
        XCTAssertNil(f.model.dashboardHistory(for: replacement))

        await f.model.loadDashboardHistory(replacement)
        XCTAssertEqual(
            f.model.dashboardHistory(for: replacement)?.historyRevision,
            replacement.historyRevision
        )
    }

    @MainActor
    func testLateHistoryResultCannotChangeTheLocallySelectedPanel() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let model = f.model
        await model.refreshDashboard(enrich: false)
        f.state.delayHistory = true
        await model.toggleDashboardPanel(.history)
        let history = Task { await model.refreshDashboard(enrich: false) }
        while f.state.dashboardReadCount < 2 { await Task.yield() }
        XCTAssertEqual(model.dashboard?.counts.running, 3)
        XCTAssertFalse(model.dashboardDetailLoading, "Prepared rows remain visible while an explicit refresh is pending")
        await model.toggleDashboardPanel(.problems)
        await history.value
        XCTAssertEqual(model.dashboardPanel, .problems)
        XCTAssertEqual(model.dashboardLoadedFilter, .all)
        XCTAssertEqual(model.dashboard?.scope, "all")
        XCTAssertFalse(model.dashboardDetailLoading)
        model.setDashboardVisible(false)
        XCTAssertNil(model.dashboardPanel)
        XCTAssertEqual(model.dashboard?.scope, "all")
    }

    func testDetailHeightFitsEmptyShortAndLongListsToTheOwningScreen() {
        XCTAssertEqual(DashboardPopoverLayout.detailHeight(content: 72, fixed: 280, screen: 900), 72)
        XCTAssertEqual(DashboardPopoverLayout.detailHeight(content: 4000, fixed: 280, screen: 900), 596)
        XCTAssertEqual(DashboardPopoverLayout.detailHeight(content: 4000, fixed: 400, screen: 600), 176)
        XCTAssertGreaterThan(DashboardPopoverLayout.detailHeight(content: 0, fixed: 400, screen: 600), 0)
        XCTAssertEqual(
            DashboardPopoverLayout.detailHeight(
                for: .history,
                content: 72,
                fixed: 280,
                screen: 900
            ),
            596
        )
        XCTAssertEqual(
            DashboardPopoverLayout.detailHeight(
                for: .responseRequired,
                content: 72,
                fixed: 280,
                screen: 900
            ),
            72
        )
        let animatedMeasurements: [CGFloat] = [1049, 1205, 1049, 1205, 1049]
        let clampedHeights = animatedMeasurements.map {
            DashboardPopoverLayout.popoverHeight(measured: $0, screen: 1073)
        }
        XCTAssertEqual(Set(clampedHeights), [1049])
        XCTAssertEqual(
            DashboardPopoverLayout.popoverHeight(measured: 360, screen: 1073),
            360
        )
    }

    @MainActor
    func testDashboardLongListAndEmptyPanelResizeTheNativePopoverContent() async throws {
        let f = try PopoverFixture()
        defer { f.remove() }
        f.state.rowCount = 24
        await f.model.refreshDashboard(enrich: false)
        let screen = try XCTUnwrap(NSScreen.main)
        let anchorWindow = NSPanel(contentRect: NSRect(
            x: screen.visibleFrame.midX,
            y: screen.visibleFrame.maxY - 80,
            width: 40,
            height: 30
        ), styleMask: [.borderless], backing: .buffered, defer: false)
        anchorWindow.isReleasedWhenClosed = false
        let anchor = NSButton(frame: NSRect(x: 0, y: 0, width: 40, height: 30))
        anchorWindow.contentView = anchor
        anchorWindow.orderFrontRegardless()

        let popover = NSPopover()
        popover.animates = false
        let host = NSHostingController(rootView: AnyView(
            DashboardPopoverView(onContentSizeChange: { size in
                popover.contentSize = NSSize(
                    width: DashboardPopoverLayout.width,
                    height: ceil(size.height)
                )
            })
            .environmentObject(f.model)
        ))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
        defer { popover.performClose(nil); anchorWindow.close() }

        func settle() async throws {
            for _ in 0..<30 {
                host.view.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(10))
            }
        }
        try await settle()
        let compactHeight = popover.contentSize.height
        XCTAssertGreaterThan(compactHeight, 100)

        await f.model.toggleDashboardPanel(.running)
        try await settle()
        let longHeight = popover.contentSize.height
        XCTAssertGreaterThan(longHeight, compactHeight + 100)
        XCTAssertLessThanOrEqual(longHeight, screen.visibleFrame.height)

        await f.model.toggleDashboardPanel(.responseRequired)
        try await settle()
        XCTAssertLessThan(popover.contentSize.height, longHeight)
        XCTAssertGreaterThan(popover.contentSize.height, compactHeight)

        await f.model.toggleDashboardPanel(.responseRequired)
        try await settle()
        XCTAssertEqual(popover.contentSize.height, compactHeight, accuracy: 1)
    }

    @MainActor
    func testHistoryLoadingAndLoadedListKeepTheSameExpandedViewport() async throws {
        let f = try PopoverFixture()
        defer { f.remove() }
        f.state.rowCount = 24
        f.state.delayHistory = true
        await f.model.refreshDashboard(enrich: false)
        let screen = try XCTUnwrap(NSScreen.main)
        let anchorWindow = NSPanel(contentRect: NSRect(
            x: screen.visibleFrame.midX,
            y: screen.visibleFrame.maxY - 80,
            width: 40,
            height: 30
        ), styleMask: [.borderless], backing: .buffered, defer: false)
        anchorWindow.isReleasedWhenClosed = false
        let anchor = NSButton(frame: NSRect(x: 0, y: 0, width: 40, height: 30))
        anchorWindow.contentView = anchor
        anchorWindow.orderFrontRegardless()

        let popover = NSPopover()
        popover.animates = false
        let host = NSHostingController(rootView: AnyView(
            DashboardPopoverView(onContentSizeChange: { size in
                popover.contentSize = NSSize(
                    width: DashboardPopoverLayout.width,
                    height: ceil(size.height)
                )
            })
            .environmentObject(f.model)
        ))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
        defer { popover.performClose(nil); anchorWindow.close() }

        func settle(_ iterations: Int = 30) async throws {
            for _ in 0..<iterations {
                host.view.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(10))
            }
        }
        try await settle()
        let compactHeight = popover.contentSize.height

        let history = Task { await f.model.toggleDashboardPanel(.history) }
        for _ in 0..<30 {
            host.view.layoutSubtreeIfNeeded()
            if f.model.dashboardDetailLoading { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        try await settle(8)
        let loadingHeight = popover.contentSize.height
        await history.value
        try await settle()
        let loadedHeight = popover.contentSize.height

        XCTAssertGreaterThan(loadingHeight, compactHeight + 100)
        XCTAssertEqual(loadedHeight, loadingHeight, accuracy: 1)
    }

    @MainActor
    func testHistoryExpansionKeepsTheNativePopoverAndHeaderAnchoredAtTheTop() async throws {
        let f = try PopoverFixture()
        defer { f.remove() }
        f.state.rowCount = 24
        f.state.delayHistory = true
        await f.model.refreshDashboard(enrich: false)

        let controller = BridgeMenuBarController()
        controller.install(model: f.model)
        defer {
            controller.uninstall()
            f.model.cancelAllPolling()
        }

        let screen = try XCTUnwrap(NSScreen.main)
        let anchorWindow = NSPanel(contentRect: NSRect(
            x: screen.visibleFrame.midX,
            y: screen.visibleFrame.maxY - 80,
            width: 40,
            height: 80
        ), styleMask: [.borderless], backing: .buffered, defer: false)
        anchorWindow.isReleasedWhenClosed = false
        let anchorContainer = NSView(frame: NSRect(x: 0, y: 0, width: 40, height: 80))
        // A status-item popover is attached at the visible screen's top edge.
        // Use a one-point anchor at that edge without asking AppKit to create a
        // one-point window, which it expands to its minimum height.
        let anchor = NSButton(frame: NSRect(x: 0, y: 79, width: 40, height: 1))
        anchorContainer.addSubview(anchor)
        anchorWindow.contentView = anchorContainer
        anchorWindow.orderFrontRegardless()
        controller.popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
        defer { anchorWindow.close() }

        func settle(_ iterations: Int = 8) async throws {
            for _ in 0..<iterations {
                controller.popover.contentViewController?.view.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(10))
            }
        }

        func screenMetrics() throws -> (popover: NSRect, headerTop: CGFloat) {
            let host = try XCTUnwrap(controller.popover.contentViewController?.view)
            let window = try XCTUnwrap(host.window)
            let hostFrame = window.convertToScreen(host.convert(host.bounds, to: nil))
            // DashboardPopoverView places its header at the top of this root
            // host. Tracking the host top catches the visual recentering that
            // can happen during an AppKit popover resize.
            return (window.frame, hostFrame.maxY)
        }

        try await settle()
        XCTAssertTrue(controller.popover.animates)
        let compact = try screenMetrics()
        let transition = Task { await f.model.toggleDashboardPanel(.history) }
        var samples: [(popover: NSRect, headerTop: CGFloat)] = []
        for _ in 0..<36 {
            controller.popover.contentViewController?.view.layoutSubtreeIfNeeded()
            samples.append(try screenMetrics())
            try await Task.sleep(for: .milliseconds(10))
        }
        await transition.value
        try await settle()
        let expanded = try screenMetrics()

        XCTAssertGreaterThan(expanded.popover.height, compact.popover.height + 100)
        XCTAssertEqual(expanded.popover.maxY, compact.popover.maxY, accuracy: 1)
        // AppKit may adjust the bubble's arrow/chrome inset by a few points
        // as its size changes. Anything larger is visible as the unwanted
        // center-then-top content jump.
        XCTAssertEqual(expanded.headerTop, compact.headerTop, accuracy: 4)
        for sample in samples {
            XCTAssertEqual(sample.popover.maxY, compact.popover.maxY, accuracy: 1)
            XCTAssertEqual(sample.headerTop, compact.headerTop, accuracy: 4)
        }
    }

    @MainActor
    func testAppLaunchSubmitsStartOnceAndLaterBootstrapDoesNotUndoAManualStop() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        async let first: Void = f.model.start()
        async let second: Void = f.model.start()
        _ = await (first, second)
        let launches = f.state.launchRequests
        XCTAssertEqual(launches.count, 1)
        XCTAssertNotNil(launches.first?["applicationLaunchAt"] as? String)
        XCTAssertEqual(launches.first?["kind"] as? String, "start")
        XCTAssertNil(f.model.startupErrorMessage)
        _ = await f.model.stopRuntime(force: false)
        await f.model.start()
        XCTAssertEqual(f.state.launchRequests.count, 1)
        XCTAssertEqual(f.state.dashboardReadCount, 0)
    }

    @MainActor
    func testLostInitialLaunchReceiptReconnectReusesIntentAndAttemptBudget() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.pendingInitialStart = true
        f.state.lostStartReceipts = 2
        await f.model.start()
        let deadline = f.model.lifecycleOperation?.startup?.deadlineAt
        await f.model.refreshStatus()
        for _ in 0..<50 {
            if f.state.launchRequests.count == 3 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let requests = f.state.launchRequests
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(Set(requests.compactMap { $0["requestId"] as? String }).count, 1)
        XCTAssertEqual(Set(requests.compactMap { $0["applicationLaunchAt"] as? String }).count, 1)
        XCTAssertEqual(f.model.lifecycleOperation?.startup?.attempts, 1)
        XCTAssertEqual(f.model.lifecycleOperation?.startup?.deadlineAt, deadline)
        XCTAssertNil(f.model.startupErrorMessage)
    }

    @MainActor
    func testStopAfterLostLaunchReceiptReplacesBackoffAndPreventsLateAutomaticReceipt() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.pendingInitialStart = true
        f.state.lostStartReceipts = 2
        await f.model.start()
        let initialID = try XCTUnwrap(f.state.launchRequests.first?["requestId"] as? String)
        let sentBeforeStop = f.state.launchRequests.count
        let stopped = await f.model.stopRuntime(force: false)
        XCTAssertTrue(stopped)
        await f.model.refreshStatus()
        XCTAssertEqual(f.state.launchRequests.count, sentBeforeStop)
        XCTAssertEqual(f.state.stopRequests.last?["replacesRequestId"] as? String, initialID)
        XCTAssertEqual(f.model.lifecycleOperation?.kind, "stop")
    }

    @MainActor
    func testCancelInitialBackoffDoesNotRetransmitLostLaunchReceipt() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.pendingInitialStart = true
        f.state.lostStartReceipts = 2
        await f.model.start()
        let sentBeforeCancel = f.state.launchRequests.count
        await f.model.cancelLifecycle()
        await f.model.refreshStatus()
        XCTAssertEqual(f.state.launchRequests.count, sentBeforeCancel)
        XCTAssertEqual(f.model.lifecycleOperation?.phase, "cancelled")
    }

    @MainActor
    func testLateInitialLaunchReceiptCannotReplaceNewerUserStop() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.pendingInitialStart = true
        f.state.initialStartReceiptDelay = 0.2
        let starting = Task { @MainActor in await f.model.start() }
        for _ in 0..<50 {
            if !f.state.launchRequests.isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let stopped = await f.model.stopRuntime(force: false)
        XCTAssertTrue(stopped)
        let stopID = f.model.lifecycleOperation?.requestId
        await starting.value
        XCTAssertEqual(f.model.lifecycleOperation?.kind, "stop")
        XCTAssertEqual(f.model.lifecycleOperation?.requestId, stopID)
        XCTAssertEqual(f.state.launchRequests.count, 1)
    }

    @MainActor
    func testOpeningDuringStartupCoalescesIntoOneStagedDashboardRefresh() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.model.setDashboardVisible(true)
        await f.model.start()
        for _ in 0..<100 {
            if f.state.enrichmentReadCount == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(f.state.dashboardReadCount, 2)
        XCTAssertEqual(f.state.enrichmentReadCount, 1)
    }

    @MainActor
    func testAppLaunchCanObserveAnExistingOperationWithoutAnIdentityError() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.coalesceStart = true
        await f.model.start()
        XCTAssertNil(f.model.startupErrorMessage)
        XCTAssertEqual(f.model.lifecycleOperation?.requestId, PopoverReplyState.existingRequestID)
    }

    @MainActor
    func testFailedLaunchKeepsTheSameRequestIdentityForAnExplicitRetry() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.failStart = true
        await f.model.start()
        XCTAssertNotNil(f.model.startupErrorMessage)
        f.state.failStart = false
        await f.model.start()
        XCTAssertNil(f.model.startupErrorMessage)
        let requests = f.state.launchRequests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0]["requestId"] as? String, requests[1]["requestId"] as? String)
        XCTAssertEqual(requests[0]["applicationLaunchAt"] as? String, requests[1]["applicationLaunchAt"] as? String)
    }
}

private actor PopoverBootstrap: HelperBootstrapping {
    func ensureRunning(paths: RuntimePaths) async throws {}
    func shutdown(paths: RuntimePaths) async throws {}
}

@MainActor
private final class PopoverFixture {
    let root: URL
    let state = PopoverReplyState()
    let helper: NativeRPCFixture
    let bridge: NativeRPCFixture
    let model: AppModel

    init() throws {
        root = URL(fileURLWithPath: "/tmp/cb-menu-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path], currentDirectory: root)
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let state = self.state
        helper = try NativeRPCFixture(path: paths.helperSocket.path, requestReply: { state.reply($0, $1) })
        bridge = try NativeRPCFixture(path: paths.bridgeSocket.path, requestReply: { state.reply($0, $1) })
        model = AppModel(paths: paths, bootstrapper: PopoverBootstrap())
        model.recordLocalConnectionStatus(try JSONDecoder().decode(HelperStatus.self,
            from: JSONSerialization.data(withJSONObject: PopoverReplyState.helperStatus)))
    }

    func remove() {
        model.cancelAllPolling()
        helper.stop(); bridge.stop()
        try? FileManager.default.removeItem(at: root)
    }
}

private final class PopoverReplyState: @unchecked Sendable {
    static let existingRequestID = "11111111-1111-4111-8111-111111111111"
    private let lock = NSLock()
    private var requests: [[String: Any]] = []
    private var fail = false
    private var coalesce = false
    private var operation: [String: Any]?
    private let enrichmentGate = DispatchSemaphore(value: 0)
    private var pausedEnrichment = false
    private var enrichmentReads = 0
    private var activeEnrichments = 0
    private var maximumEnrichments = 0
    private var completedEnrichments = 0
    private var dashboardReads = 0
    private var backgroundPageJSONValue: String?
    private var backgroundPageDelayValue: TimeInterval = 0
    private var backgroundOffsets: [Int] = []
    var backgroundPageJSON: String? { get { lock.withLock { backgroundPageJSONValue } } set { lock.withLock { backgroundPageJSONValue = newValue } } }
    var backgroundPageDelay: TimeInterval { get { lock.withLock { backgroundPageDelayValue } } set { lock.withLock { backgroundPageDelayValue = newValue } } }
    var backgroundPageOffsets: [Int] { lock.withLock { backgroundOffsets } }
    private var dashboardJSONValue: String?
    private var dashboardAppendJSONValue: String?
    private var runningPageJSONValue: String?
    private var dashboardAppendDelayValue: TimeInterval = 0
    private var dashboardEnrichmentJSONValue: String?
    private var failDashboardValue = false
    var dashboardJSON: String? { get { lock.withLock { dashboardJSONValue } } set { lock.withLock { dashboardJSONValue = newValue } } }
    var dashboardAppendDelay: TimeInterval { get { lock.withLock { dashboardAppendDelayValue } } set { lock.withLock { dashboardAppendDelayValue = newValue } } }
    var runningPageJSON: String? { get { lock.withLock { runningPageJSONValue } } set { lock.withLock { runningPageJSONValue = newValue } } }
    var dashboardAppendJSON: String? { get { lock.withLock { dashboardAppendJSONValue } } set { lock.withLock { dashboardAppendJSONValue = newValue } } }
    var dashboardEnrichmentJSON: String? { get { lock.withLock { dashboardEnrichmentJSONValue } } set { lock.withLock { dashboardEnrichmentJSONValue = newValue } } }
    var failDashboard: Bool { get { lock.withLock { failDashboardValue } } set { lock.withLock { failDashboardValue = newValue } } }
    private var slowHistory = false
    private var pagedHistoryValue = false
    private var runningRowCount = 0
    private var usageContextValue: String?
    private var usageAccountValue: [String: Any]?
    private var usageWeeklyValue: [String: Any]?
    private var authenticatedValue = true
    private var failEnrichmentValue = false
    private var initialStartReceipts: [String: [String: Any]] = [:]
    private var initialStartReceiptDelayValue: TimeInterval = 0
    var initialStartReceiptDelay: TimeInterval { get { lock.withLock { initialStartReceiptDelayValue } } set { lock.withLock { initialStartReceiptDelayValue = newValue } } }
    private var pendingInitialStartValue = false
    private var lostStartReceiptCount = 0
    var pendingInitialStart: Bool { get { lock.withLock { pendingInitialStartValue } } set { lock.withLock { pendingInitialStartValue = newValue } } }
    var lostStartReceipts: Int { get { lock.withLock { lostStartReceiptCount } } set { lock.withLock { lostStartReceiptCount = newValue } } }
    var stopRequests: [[String: Any]] { lock.withLock { requests.filter { $0["kind"] as? String == "stop" } } }
    private var deferredHistoryRevision = String(repeating: "a", count: 64)
    var rowCount: Int { get { lock.withLock { runningRowCount } } set { lock.withLock { runningRowCount = newValue } } }
    var usageContext: String? { get { lock.withLock { usageContextValue } } set { lock.withLock { usageContextValue = newValue } } }
    var usageAccount: [String: Any]? { get { lock.withLock { usageAccountValue } } set { lock.withLock { usageAccountValue = newValue } } }
    var usageWeekly: [String: Any]? { get { lock.withLock { usageWeeklyValue } } set { lock.withLock { usageWeeklyValue = newValue } } }
    var authenticated: Bool { get { lock.withLock { authenticatedValue } } set { lock.withLock { authenticatedValue = newValue } } }
    var failEnrichment: Bool { get { lock.withLock { failEnrichmentValue } } set { lock.withLock { failEnrichmentValue = newValue } } }
    var holdEnrichment: Bool { get { lock.withLock { pausedEnrichment } } set { lock.withLock { pausedEnrichment = newValue } } }
    var enrichmentReadCount: Int { lock.withLock { enrichmentReads } }
    var maximumConcurrentEnrichments: Int { lock.withLock { maximumEnrichments } }
    var dashboardReadCount: Int { lock.withLock { dashboardReads } }

    func releaseEnrichment() {
        let active = lock.withLock { pausedEnrichment = false; return activeEnrichments }
        for _ in 0..<active { enrichmentGate.signal() }
    }
    var delayHistory: Bool { get { lock.withLock { slowHistory } } set { lock.withLock { slowHistory = newValue } } }
    var pagedHistory: Bool { get { lock.withLock { pagedHistoryValue } } set { lock.withLock { pagedHistoryValue = newValue } } }
    var pagedDetail = false
    var problemPageJSON: String?
    var problemPageDelay: TimeInterval = 0
    private var problemOffsets: [Int] = []
    var problemPageOffsets: [Int] { lock.withLock { problemOffsets } }
    var jobsContract = false
    var rejectJobsMode = false
    var exactDetailIsActive = false
    var exactDetailDelay: TimeInterval = 0
    private var exactReads = 0
    var exactDetailReads: Int { lock.withLock { exactReads } }
    private func executionFixture(_ status: String) -> [String: Any] {
        let id = "job-" + status
        let turn: [String: Any] = ["jobId": id, "scopeId": "11111111-1111-4111-8111-111111111111", "activityId": "shared-activity", "agentId": "shared-agent",
            "executionKey": String(repeating: "a", count: 32), "executionRevision": String(repeating: "e", count: 64),
            "executionName": "Run " + id, "summary": "Stored " + status, "error": NSNull(), "reasonAvailability": "unrecorded",
            "activityTitle": "Shared activity", "status": status, "startedAt": "2026-09-09T00:00:00Z",
            "updatedAt": "2026-09-10T00:00:00Z", "endedAt": "2026-09-10T00:00:00Z", "durationMs": 86400000]
        return ["rowKey": id, "jobId": id, "scopeId": "11111111-1111-4111-8111-111111111111", "activityId": "shared-activity", "agentId": "shared-agent",
            "executionRevision": String(repeating: "e", count: 64), "policyRevision": String(repeating: "c", count: 64), "executionName": "Run " + id,
            "summary": "Stored " + status, "error": NSNull(), "reasonAvailability": "unrecorded",
            "activityKey": "shared-activity", "conversationKey": "shared-conversation", "sessionAlias": "Shared scope",
            "bucket": status == "input-required" ? "active" : "recent", "projectKey": "window-project", "projectName": "Job fixture", "agentName": "Same Agent",
            "activityTitle": "Shared activity", "status": status, "createdAt": "2026-09-09T00:00:00Z", "updatedAt": "2026-09-10T00:00:00Z",
            "elapsedMs": 86400000, "backgroundProcessCount": 0, "latestTurn": turn, "history": [], "historyCount": 0]
    }
    var expiryScenario = false
    private var rowExpiryValue: String?
    private var detailExpiryValue: String?
    private var retainedHistoryCountValue = 1
    private var detailResponseDelayValue: TimeInterval = 0
    var rowExpiry: String? { get { lock.withLock { rowExpiryValue } } set { lock.withLock { rowExpiryValue = newValue } } }
    var detailExpiry: String? { get { lock.withLock { detailExpiryValue } } set { lock.withLock { detailExpiryValue = newValue } } }
    var retainedHistoryCount: Int { get { lock.withLock { retainedHistoryCountValue } } set { lock.withLock { retainedHistoryCountValue = newValue } } }
    var detailResponseDelay: TimeInterval { get { lock.withLock { detailResponseDelayValue } } set { lock.withLock { detailResponseDelayValue = newValue } } }
    private var historyReads = 0
    var historyReadCount: Int { lock.withLock { historyReads } }
    var detailHistoryRevision: String { get { lock.withLock { deferredHistoryRevision } } set { lock.withLock { deferredHistoryRevision = newValue } } }
    var failStart: Bool { get { lock.withLock { fail } } set { lock.withLock { fail = newValue } } }
    var coalesceStart: Bool { get { lock.withLock { coalesce } } set { lock.withLock { coalesce = newValue } } }
    var launchRequests: [[String: Any]] { lock.withLock { requests.filter { $0["applicationLaunchAt"] != nil } } }
    static var helperStatus: [String: Any] { [
        "kind": "helper-status", "generatedAt": "2026-09-10T00:00:00Z", "phase": "running", "restartAttempt": 0,
        "configuration": ["path": "/private/fixture/.env", "exists": true, "valid": true, "hasApiKey": true, "hasTunnelId": true],
        "bridge": ["socketPath": "/private/fixture/bridge.sock", "connected": true],
        "tunnel": ["phase": "connected", "doctorPassed": true, "processRunning": true, "connected": true]
    ] }

    func reply(_ method: String, _ parameters: String) -> NativeFixtureReply {
        let params = (try? JSONSerialization.jsonObject(with: Data(parameters.utf8))) as? [String: Any] ?? [:]
        var delay: TimeInterval = 0
        var result: [String: Any]
        switch method {
        case "helper.status", "helper.health":
            var status = Self.helperStatus
            if let operation = lock.withLock({ operation }) { status["lifecycle"] = operation }
            result = status
        case "auth.status": result = ["installed": true, "authenticated": authenticated, "summary": "fixture"]
        case "lifecycle.request":
            lock.withLock { requests.append(params) }
            if failStart { return NativeFixtureReply(body: #"{"error":{"code":-32000,"message":"FIXTURE_START_FAILED"}}"#) }
            result = ["requestId": coalesceStart ? Self.existingRequestID : params["requestId"]!, "kind": params["kind"]!,
                "force": false, "phase": pendingInitialStart && params["kind"] as? String == "start" ? "waiting" : "completed", "createdAt": "2026-09-10T00:00:00Z", "updatedAt": "2026-09-10T00:00:00Z",
                "reasons": [], "cancellable": false]
            if pendingInitialStart, params["kind"] as? String == "start" {
                let began = Int64(Date().timeIntervalSince1970 * 1000)
                result["startup"] = ["source": "application-launch", "startedAt": began, "deadlineAt": began + 300000,
                    "attempts": 1, "stage": "backoff", "failureCode": "STARTUP_HTTP_TIMEOUT"]
                result["cancellable"] = true
                let id = params["requestId"] as? String ?? ""
                if let retained = lock.withLock({ initialStartReceipts[id] }) { result = retained }
                else { lock.withLock { initialStartReceipts[id] = result } }
                delay = initialStartReceiptDelay
            }
            lock.withLock { operation = result }
            if params["applicationLaunchAt"] != nil, lock.withLock({ () -> Bool in
                if lostStartReceiptCount > 0 { lostStartReceiptCount -= 1; return true }; return false
            }) { return NativeFixtureReply(body: "") }
        case "lifecycle.cancel":
            result = lock.withLock { operation ?? [:] }
            result["phase"] = "cancelled"; result["cancellable"] = false
            lock.withLock { operation = result }
        case "dashboard.snapshot":
            let filter = params["statusFilter"] as? String ?? "all"
            let includeHistory = params["includeHistory"] as? Bool ?? true
            lock.withLock { dashboardReads += 1 }
            if failDashboard { return NativeFixtureReply(body: #"{"error":{"code":-32000,"message":"FIXTURE_DASHBOARD_UNAVAILABLE"}}"#) }
            if let offset = params["backgroundOffset"] as? Int, let body = backgroundPageJSON {
                lock.withLock { backgroundOffsets.append(offset) }
                return NativeFixtureReply(body: "{\"result\":\(body)}", delay: backgroundPageDelay)
            }
            if let query = params["problems"] as? [String: Any], let offset = query["offset"] as? Int,
               offset > 0, let body = problemPageJSON {
                lock.withLock { problemOffsets.append(offset) }
                return NativeFixtureReply(body: "{\"result\":\(body)}", delay: problemPageDelay)
            }
            if (params["statusOffset"] as? Int ?? 0) > 0, let body = runningPageJSON {
                return NativeFixtureReply(body: "{\"result\":\(body)}", delay: dashboardAppendDelay)
            }
            if params["enrich"] as? Bool == true, let body = dashboardEnrichmentJSON {
                lock.withLock { enrichmentReads += 1 }
                return NativeFixtureReply(body: "{\"result\":\(body)}", delay: 0.1)
            }
            if ((params["statusOffset"] as? Int ?? 0) > 0 || (params["terminalOffset"] as? Int ?? 0) > 0), let body = dashboardAppendJSON {
                return NativeFixtureReply(body: "{\"result\":\(body)}", delay: dashboardAppendDelay)
            }
            if let dashboardJSON { return NativeFixtureReply(body: "{\"result\":\(dashboardJSON)}") }
            if rejectJobsMode && params["historyMode"] != nil { return NativeFixtureReply(body: #"{"error":{"code":-32602,"message":"Unrecognized key: historyMode"}}"#) }
            if params["enrich"] as? Bool == true {
                let paused = lock.withLock {
                    enrichmentReads += 1
                    activeEnrichments += 1
                    maximumEnrichments = max(maximumEnrichments, activeEnrichments)
                    return pausedEnrichment
                }
                if paused { _ = enrichmentGate.wait(timeout: .now() + 5) }
                lock.withLock { activeEnrichments -= 1; completedEnrichments += 1 }
                if failEnrichment {
                    return NativeFixtureReply(body: #"{"error":{"code":-32000,"message":"FIXTURE_USAGE_UNAVAILABLE"}}"#)
                }
            }
            if includeHistory, delayHistory { delay = 0.2 }
            let names = ["trackedProjects", "trackedConversations", "retainedJobs", "active", "running", "inputRequired",
                "approvalRequired", "terminating", "needsAttention", "backgroundProcesses", "backgroundProcessAgents",
                "runtimeUnknownAgents", "runtimeProbeSkippedAgents", "completed", "failed", "interrupted", "cancelled", "idleAgents", "orphanedAgents"]
            let rowCount = self.rowCount
            let rowHistoryRevision = String(repeating: "a", count: 64)
            let rows: [[String: Any]] = (0..<rowCount).map { index in [
                "rowKey": "window-row-\(index)", "activityKey": "window-activity-\(index)",
                "conversationKey": "window-conversation-\(index)", "bucket": "active",
                "sessionAlias": "window-session-\(index)", "projectKey": "window-project",
                "projectName": "Window fixture", "agentName": "Task \(index)",
                "activityTitle": "Running task \(index)", "status": "running",
                "createdAt": "2026-09-10T00:00:00Z", "updatedAt": "2026-09-10T00:00:00Z",
                "elapsedMs": 5000, "backgroundProcessCount": 0,
                "history": [], "historyCount": retainedHistoryCount, "historyRevision": rowHistoryRevision,
                "nextExpiryAt": rowExpiry as Any? ?? NSNull(),
                "policyRevision": String(repeating: "c", count: 64), "representativeExecutionKey": String(repeating: "d", count: 32)
            ] }
            var counts = Dictionary(uniqueKeysWithValues: names.map { ($0, 0) })
            counts["running"] = rowCount == 0 ? 3 : rowCount
            let page: [String: Any] = ["offset": 0, "limit": 12, "returned": 0, "total": 0,
                "returnedConversations": 0, "conversationTotal": 0, "hasPrevious": false, "hasNext": false]
            var snapshot: [String: Any] = ["kind": "dashboard", "generatedAt": "2026-09-10T00:00:00Z", "scope": filter,
                "statusSource": "codex-runtime-only", "coverage": "complete", "counts": counts,
                "activeRows": rows, "terminalRows": [], "idleRows": [], "statusRows": rows,
                "statusRowsComplete": true,
                "historyIncluded": includeHistory,
                "pagination": ["active": page, "terminal": page, "idle": page],
                "enrichment": ["state": "structural", "runtimeRequests": 0,
                    "cacheHits": lock.withLock { completedEnrichments }, "timeouts": 0,
                    "durationMs": 0, "usageTimedOut": false, "pendingReads": 0],
                "uiLocalePreference": "ko"]
            if pagedHistory, includeHistory {
                func historyRow(_ index: Int, bucket: String) -> [String: Any] { [
                    "rowKey": "\(bucket)-row-\(index)", "activityKey": "\(bucket)-activity-\(index)",
                    "conversationKey": "\(bucket)-conversation-\(index)", "bucket": bucket,
                    "sessionAlias": "\(bucket)-session-\(index)", "projectKey": "window-project",
                    "projectName": "Window fixture", "agentName": "Task \(index)",
                    "activityTitle": "\(bucket) task \(index)",
                    "status": bucket == "idle" ? "idle" : "completed",
                    "createdAt": "2026-09-10T00:00:00Z", "updatedAt": "2026-09-10T00:00:00Z",
                    "elapsedMs": 5000, "backgroundProcessCount": 0,
                    "history": [], "historyCount": retainedHistoryCount, "historyRevision": rowHistoryRevision,
                "nextExpiryAt": rowExpiry as Any? ?? NSNull(),
                "policyRevision": String(repeating: "c", count: 64), "representativeExecutionKey": String(repeating: "d", count: 32)
                ] }
                let terminalOffset = params["terminalOffset"] as? Int ?? 0
                let idleOffset = params["idleOffset"] as? Int ?? 0
                func historyPage(_ offset: Int) -> [String: Any] { [
                    "offset": offset, "limit": 12, "returned": 1, "total": 2,
                    "returnedConversations": 1, "conversationTotal": 2,
                    "hasPrevious": offset > 0, "hasNext": offset == 0
                ] }
                snapshot["terminalRows"] = [historyRow(terminalOffset, bucket: "recent")]
                snapshot["idleRows"] = [historyRow(idleOffset, bucket: "idle")]
                snapshot["pagination"] = ["active": page,
                    "terminal": historyPage(terminalOffset), "idle": historyPage(idleOffset)]
            }
            if jobsContract && params["historyMode"] as? String == "jobs" {
                let terminal = ["completed", "failed", "interrupted", "cancelled"].map(executionFixture)
                let active = executionFixture("input-required")
                snapshot["executionContractVersion"] = 2; snapshot["historyModeApplied"] = "jobs"
                counts["executionCount"] = 4; counts["progressJobCount"] = 1; snapshot["counts"] = counts
                snapshot["activeRows"] = [active]; snapshot["terminalRows"] = terminal; snapshot["statusRows"] = terminal
                snapshot["historyIncluded"] = true
                var terminalPage = page; terminalPage["total"] = 4; terminalPage["returned"] = 4
                snapshot["pagination"] = ["active": page, "terminal": terminalPage, "idle": page]
                snapshot["historyPolicy"] = ["retentionDays": 30, "issueAttentionDays": 7, "lastCleanupCount": 0, "totalRemoved": 0, "policyRevision": String(repeating: "c", count: 64)]
                func problem(_ index: Int, _ row: [String: Any], _ availability: String) -> [String: Any] {
                    ["problemKey": "event-\(index)", "revision": "revision", "kind": row["status"] as? String == "cancelled" ? "cancelled" : "failed",
                     "source": "execution", "review": "automatic", "observedAt": "2026-09-10T00:00:00Z", "occurredAt": "2026-09-10T00:00:00Z",
                     "canAcknowledge": false, "canUnacknowledge": false, "canRecheck": false, "canRetryStop": false,
                     "jobId": availability == "not-linked" ? NSNull() : row["jobId"]!, "scopeId": row["scopeId"]!,
                     "executionRevision": String(repeating: "e", count: 64), "executionAvailability": availability, "reasonAvailability": "unrecorded", "row": row]
                }
                snapshot["problems"] = ["query": ["review": "pending", "kind": "all", "offset": 0], "revision": "events",
                    "incidentCount": 5, "affectedExecutionCount": 2, "systemIncidentCount": 1, "unavailableExecutionCount": 1,
                    "pendingCount": 0, "acknowledgedCount": 0, "reviewableCount": 0,
                    "rows": [problem(0, terminal[1], "retained"), problem(1, terminal[1], "retained"), problem(2, terminal[3], "retained"), problem(3, active, "not-linked"), problem(4, terminal[2], "unavailable")],
                    "page": ["offset": 0, "limit": 12, "total": 5, "returned": 5, "hasPrevious": false, "hasNext": false]]
            }
            if let usageContext { snapshot["usageContext"] = usageContext }
            if let usageAccount { snapshot["codexAccount"] = usageAccount }
            if let usageWeekly { snapshot["weeklyUsage"] = usageWeekly }
            result = snapshot
        case "dashboard.execution-detail":
            lock.withLock { exactReads += 1 }
            let job = params["jobId"] as? String ?? ""
            let status = job.replacingOccurrences(of: "job-", with: "")
            let row = executionFixture(status)
            var execution = row["latestTurn"] as! [String: Any]
            if exactDetailIsActive { execution["endedAt"] = NSNull() }
            result = ["kind": "dashboard-execution", "jobId": job, "scopeId": params["scopeId"]!,
                "executionRevision": String(repeating: "e", count: 64), "policyRevision": String(repeating: "c", count: 64), "execution": execution]
            delay = exactDetailDelay
        case "dashboard.history-detail":
            lock.withLock { historyReads += 1 }
            let rowKey = params["rowKey"] as? String ?? ""
            let historyRevision = lock.withLock { deferredHistoryRevision }
            result = [
                "kind": "dashboard-history", "rowKey": rowKey, "historyCount": 1,
                "historyRevision": historyRevision,
                "policyRevision": String(repeating: "c", count: 64), "representativeExecutionKey": String(repeating: "d", count: 32),
                "history": [[
                    "activityKey": "earlier-activity", "activityTitle": "Earlier task", "status": "completed",
                    "startedAt": "2026-09-09T23:59:55Z", "updatedAt": "2026-09-10T00:00:00Z",
                    "endedAt": "2026-09-10T00:00:00Z", "durationMs": 5000
                ]]
            ]
            delay = detailResponseDelay
            if expiryScenario {
                result["historyCount"] = retainedHistoryCount
                result["nextExpiryAt"] = detailExpiry as Any? ?? NSNull()
                result["historyHasMore"] = true
                result["nextCursor"] = "page2"
                result["history"] = (1...retainedHistoryCount).map { i in [
                    "executionKey": String(format: "%032d", i), "activityTitle": "Retained \(i)", "status": "completed",
                    "startedAt": "2026-09-09T23:59:55Z", "updatedAt": "2026-09-10T00:00:00Z", "durationMs": 5000
                ] as [String: Any] }
            }
            if pagedDetail {
                let lastPage = params["historyCursor"] as? String == "page2"
                let range = lastPage ? Array(13...16) : Array(1...12)
                result["historyCount"] = 16
                result["historyHasMore"] = !lastPage
                result["nextCursor"] = lastPage ? NSNull() : "page2"
                result["history"] = range.map { i in [
                    "executionKey": String(format: "%032d", i), "activityTitle": "History \(i)", "status": "completed",
                    "startedAt": "2026-09-09T23:59:55Z", "updatedAt": "2026-09-10T00:00:00Z", "durationMs": 5000
                ] as [String: Any] }
            }
        default: return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"Fixture method unavailable"}}"#)
        }
        let data = try! JSONSerialization.data(withJSONObject: ["result": result])
        return NativeFixtureReply(body: String(decoding: data, as: UTF8.self), delay: delay)
    }
}

extension DashboardPopoverTests {
    private func tabJSON(_ object: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    @MainActor
    private func tabBase(_ f: PopoverFixture) async throws -> [String: Any] {
        f.state.jobsContract = true
        f.model.dashboardHistoryNow = { ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")! }
        await f.model.refreshDashboard(enrich: false)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(try XCTUnwrap(f.model.dashboard))) as? [String: Any])
    }

    private func tabSnapshot(_ base: [String: Any], running: [Int] = Array((1...24).reversed()), history: [Int] = Array((1...24).reversed()), activeOffset: Int = 0, historyOffset: Int = 0, problemOffset: Int = 0, progressRevision: String = "progress-a", historyRevision: String = "history-a") -> [String: Any] {
        var result = base
        let template = (base["terminalRows"] as! [[String: Any]])[0]
        func row(_ n: Int, active: Bool) -> [String: Any] {
            var value = template, turn = template["latestTurn"] as! [String: Any]
            let id = "\(active ? "R" : "H")\(n)"
            value["rowKey"] = id; value["jobId"] = id; value["status"] = active ? "running" : "failed"; value["bucket"] = active ? "active" : "recent"
            turn["jobId"] = id; turn["status"] = value["status"]
            if active { turn["endedAt"] = NSNull(); turn["durationMs"] = NSNull() }
            value["latestTurn"] = turn
            return value
        }
        func page(_ offset: Int) -> [String: Any] {
            ["offset": offset, "limit": 12, "returned": 12, "total": 24, "returnedConversations": 1, "conversationTotal": 1, "hasPrevious": offset > 0, "hasNext": offset == 0]
        }
        var counts = result["counts"] as! [String: Any]
        counts["progressJobCount"] = 24; counts["executionCount"] = 24; result["counts"] = counts
        result["progressRevision"] = progressRevision; result["executionHistoryRevision"] = historyRevision; result["historyIncluded"] = true
        result["activeRows"] = running.dropFirst(activeOffset).prefix(12).map { row($0, active: true) }; result["statusRows"] = result["activeRows"]
        result["terminalRows"] = history.dropFirst(historyOffset).prefix(12).map { row($0, active: false) }
        var pagination = result["pagination"] as! [String: Any]
        pagination["active"] = page(activeOffset); pagination["terminal"] = page(historyOffset); result["pagination"] = pagination
        if var problems = result["problems"] as? [String: Any], let problemTemplate = (problems["rows"] as? [[String: Any]])?.first {
            problems["revision"] = "problems-a"
            problems["rows"] = history.dropFirst(problemOffset).prefix(12).map { n -> [String: Any] in
                var problem = problemTemplate
                problem["problemKey"] = "problem-H\(n)"; problem["jobId"] = "H\(n)"; problem["row"] = row(n, active: false)
                return problem
            }
            problems["affectedExecutionCount"] = 24; problems["page"] = page(problemOffset); result["problems"] = problems
        }
        return result
    }

    @MainActor
    func testRunningPagesRebaseOnSameCountMembershipChange() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let base = try await tabBase(f)
        for retired in [24, 1] {
            f.state.dashboardJSON = try tabJSON(tabSnapshot(base))
            await f.model.refreshDashboard(enrich: false)
            let changed = [25] + (1...24).reversed().filter { $0 != retired }
            f.state.dashboardJSON = try tabJSON(tabSnapshot(base, running: changed, progressRevision: "progress-b"))
            f.state.dashboardAppendJSON = try tabJSON(tabSnapshot(base, running: changed, activeOffset: 12, progressRevision: "progress-b"))
            await f.model.loadMoreRunning()
            XCTAssertEqual(f.model.dashboard?.activeRows.compactMap(\.jobId), changed.prefix(12).map { "R\($0)" })
            XCTAssertTrue(try XCTUnwrap(f.model.dashboard).hasMoreRunning)
            await f.model.loadMoreRunning()
            XCTAssertEqual(f.model.dashboard?.activeRows.compactMap(\.jobId), changed.map { "R\($0)" })
            XCTAssertFalse(try XCTUnwrap(f.model.dashboard).hasMoreRunning)
            let reads = f.state.dashboardReadCount
            await f.model.loadMoreRunning()
            XCTAssertEqual(f.state.dashboardReadCount, reads)
        }
    }

    @MainActor
    func testHistoryPagesRebaseOnSameCountMembershipChange() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let base = try await tabBase(f)
        f.state.dashboardJSON = try tabJSON(tabSnapshot(base)); await f.model.refreshDashboard(enrich: false)
        let changed = Array((2...25).reversed())
        f.state.dashboardJSON = try tabJSON(tabSnapshot(base, history: changed, historyRevision: "history-b"))
        f.state.dashboardAppendJSON = try tabJSON(tabSnapshot(base, history: changed, historyOffset: 12, historyRevision: "history-b"))
        await f.model.loadMoreRecent()
        XCTAssertEqual(f.model.dashboard?.terminalRows.compactMap(\.jobId), changed.prefix(12).map { "H\($0)" })
        await f.model.loadMoreRecent()
        XCTAssertEqual(f.model.dashboard?.terminalRows.compactMap(\.jobId), changed.map { "H\($0)" })
        XCTAssertFalse(try XCTUnwrap(f.model.dashboard).pagination.terminal.hasNext)
    }

    @MainActor
    func testExpandedRunningRefreshUpdatesBlockingStateWithoutCollapsing() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let base = try await tabBase(f)
        f.state.dashboardJSON = try tabJSON(tabSnapshot(base))
        await f.model.refreshDashboard(enrich: false)
        var tail = tabSnapshot(base, activeOffset: 12)
        f.state.runningPageJSON = try tabJSON(tail)
        await f.model.loadMoreRunning()
        var rows = tail["activeRows"] as! [[String: Any]]
        rows[11]["status"] = "approval-required"
        rows[11]["summary"] = "Updated progress outside the first page"
        tail["activeRows"] = rows
        f.state.runningPageJSON = try tabJSON(tail)
        await f.model.refreshDashboard(enrich: false)
        XCTAssertEqual(f.model.dashboard?.activeRows.count, 24)
        XCTAssertEqual(f.model.dashboard?.activeRows.last?.status, "approval-required")
        XCTAssertEqual(f.model.dashboard?.activeRows.last?.summary, "Updated progress outside the first page")
        XCTAssertEqual(f.model.dashboard?.pagination.active.offset, 12)
        XCTAssertFalse(try XCTUnwrap(f.model.dashboard).hasMoreRunning)
        // Enrichment and history paging also refresh the expanded running rows.
        rows[11]["status"] = "input-required"; tail["activeRows"] = rows
        f.state.runningPageJSON = try tabJSON(tail)
        f.state.dashboardAppendJSON = try tabJSON(tabSnapshot(base, historyOffset: 12))
        await f.model.loadMoreRecent()
        XCTAssertEqual(f.model.dashboard?.activeRows.last?.status, "input-required")
        XCTAssertEqual(f.model.dashboard?.activeRows.count, 24)
    }

    @MainActor
    func testPendingEnrichmentSurvivesMoreBeforeAndAfterPageCompletion() async throws {
        for panel in ["problems", "running", "history"] {
            for inspectionFinishesFirst in [false, true] {
                let f = try PopoverFixture(); defer { f.remove() }
                let base = try await tabBase(f), first = tabSnapshot(base)
                var observed = first, counts = first["counts"] as! [String: Any]
                counts["backgroundProcesses"] = 2; observed["counts"] = counts
                f.state.dashboardJSON = try tabJSON(first)
                f.state.dashboardEnrichmentJSON = try tabJSON(observed)
                f.state.problemPageJSON = try tabJSON(tabSnapshot(base, problemOffset: 12))
                f.state.problemPageDelay = inspectionFinishesFirst ? 0.3 : 0
                f.state.dashboardAppendDelay = inspectionFinishesFirst ? 0.3 : 0
                f.state.runningPageJSON = try tabJSON(tabSnapshot(base, activeOffset: 12))
                f.state.dashboardAppendJSON = try tabJSON(tabSnapshot(base, historyOffset: 12))
                await f.model.refreshDashboard(enrich: true)
                for _ in 0..<100 {
                    if f.state.enrichmentReadCount > 0 { break }
                    try await Task.sleep(for: .milliseconds(5))
                }
                // The completed inspection's observations are available to cached reads.
                f.state.dashboardJSON = try tabJSON(observed)
                if panel == "problems" { await f.model.loadMoreProblems() }
                else if panel == "running" { await f.model.loadMoreRunning() }
                else { await f.model.loadMoreRecent() }
                for _ in 0..<100 {
                    if f.model.dashboard?.counts.backgroundProcesses == 2 { break }
                    try await Task.sleep(for: .milliseconds(10))
                }
                XCTAssertEqual(f.model.dashboard?.counts.backgroundProcesses, 2, panel)
                XCTAssertEqual(f.state.enrichmentReadCount, 1, panel)
                if panel == "problems" { XCTAssertEqual(f.model.dashboard?.problems?.rows.count, 24) }
                else if panel == "running" { XCTAssertEqual(f.model.dashboard?.activeRows.count, 24) }
                else { XCTAssertEqual(f.model.dashboard?.terminalRows.count, 24) }
            }
        }
    }

    @MainActor
    func testUnchangedRefreshAndEnrichmentPreserveAllExpandedTabs() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        let base = try await tabBase(f), first = tabSnapshot(base)
        f.state.dashboardJSON = try tabJSON(first); await f.model.refreshDashboard(enrich: false)
        f.state.runningPageJSON = try tabJSON(tabSnapshot(base, activeOffset: 12)); await f.model.loadMoreRunning()
        f.state.dashboardAppendJSON = try tabJSON(tabSnapshot(base, historyOffset: 12)); await f.model.loadMoreRecent()
        f.state.problemPageJSON = try tabJSON(tabSnapshot(base, problemOffset: 12)); await f.model.loadMoreProblems()
        XCTAssertEqual(f.model.dashboard?.activeRows.count, 24); XCTAssertEqual(f.model.dashboard?.terminalRows.count, 24); XCTAssertEqual(f.model.dashboard?.problems?.rows.count, 24)
        f.state.dashboardEnrichmentJSON = try tabJSON(first)
        await f.model.refreshDashboard(enrich: true)
        for _ in 0..<100 {
            if f.state.enrichmentReadCount > 0 && !f.model.dashboardEnrichmentPending { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let refreshed = try XCTUnwrap(f.model.dashboard)
        XCTAssertEqual(f.state.enrichmentReadCount, 1)
        XCTAssertEqual(refreshed.activeRows.compactMap(\.jobId), (1...24).reversed().map { "R\($0)" })
        XCTAssertEqual(refreshed.terminalRows.compactMap(\.jobId), (1...24).reversed().map { "H\($0)" })
        XCTAssertEqual(refreshed.problems?.rows.count, 24)
        XCTAssertEqual(refreshed.pagination.active.offset, 12); XCTAssertEqual(refreshed.pagination.terminal.offset, 12); XCTAssertEqual(refreshed.problems?.page.offset, 12)
        XCTAssertFalse(refreshed.hasMoreRunning)
        f.state.dashboardJSON = try tabJSON(tabSnapshot(base, progressRevision: "progress-b"))
        await f.model.refreshDashboard(enrich: false)
        XCTAssertEqual(f.model.dashboard?.activeRows.count, 12); XCTAssertEqual(f.model.dashboard?.terminalRows.count, 24)
    }
}

extension DashboardPopoverTests {
    @MainActor
    func testIssue264ListFailurePreservesExactExecutionDetailsAndPanel() async throws {
        let f = try PopoverFixture(); defer { f.remove() }
        f.state.jobsContract = true
        f.model.dashboardHistoryNow = { ISO8601DateFormatter().date(from: "2026-09-11T00:00:00Z")! }
        await f.model.refreshDashboard(enrich: false)
        let row = try XCTUnwrap(f.model.dashboard?.terminalRows.first)
        let target = try XCTUnwrap(f.model.executionTarget(row: row))
        await f.model.loadExecutionDetail(target)
        let detail = try XCTUnwrap(f.model.executionDetail(target))
        let checked = f.model.lastDashboardRefresh
        await f.model.toggleDashboardPanel(.history)
        f.state.failDashboard = true
        await f.model.refreshDashboard(enrich: false)
        XCTAssertNotNil(f.model.dashboardReadFailure)
        XCTAssertEqual(f.model.executionDetail(target)?.jobId, detail.jobId)
        XCTAssertEqual(f.model.executionDetail(target)?.executionRevision, detail.executionRevision)
        XCTAssertEqual(f.model.dashboardPanel, .history)
        XCTAssertEqual(f.model.lastDashboardRefresh, checked)
        f.state.failDashboard = false
        await f.model.recoverDashboardRead()
        XCTAssertNil(f.model.dashboardReadFailure)
        XCTAssertEqual(f.model.executionDetail(target)?.jobId, detail.jobId)
        XCTAssertEqual(f.model.dashboardPanel, .history)
    }
}
