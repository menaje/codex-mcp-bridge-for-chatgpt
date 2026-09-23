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
    func testStatusPanelsUseTheLoadedSnapshotAndHistoryLoadsOnlyWhenOpened() async throws {
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
        XCTAssertEqual(f.state.dashboardReadCount, initialReads + 1)
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
        let history = Task { await model.toggleDashboardPanel(.history) }
        for _ in 0..<50 {
            if model.dashboardDetailLoading { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(model.dashboard?.counts.running, 3)
        XCTAssertTrue(model.dashboardDetailLoading)
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
    private var slowHistory = false
    private var pagedHistoryValue = false
    private var runningRowCount = 0
    private var usageContextValue: String?
    private var usageAccountValue: [String: Any]?
    private var usageWeeklyValue: [String: Any]?
    private var authenticatedValue = true
    private var failEnrichmentValue = false
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
        let result: [String: Any]
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
                "force": false, "phase": "completed", "createdAt": "2026-09-10T00:00:00Z", "updatedAt": "2026-09-10T00:00:00Z",
                "reasons": [], "cancellable": false]
            lock.withLock { operation = result }
        case "dashboard.snapshot":
            let filter = params["statusFilter"] as? String ?? "all"
            let includeHistory = params["includeHistory"] as? Bool ?? true
            lock.withLock { dashboardReads += 1 }
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
                "history": [], "historyCount": 1, "historyRevision": rowHistoryRevision
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
                    "history": [], "historyCount": 1, "historyRevision": rowHistoryRevision
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
            if let usageContext { snapshot["usageContext"] = usageContext }
            if let usageAccount { snapshot["codexAccount"] = usageAccount }
            if let usageWeekly { snapshot["weeklyUsage"] = usageWeekly }
            result = snapshot
        case "dashboard.history-detail":
            let rowKey = params["rowKey"] as? String ?? ""
            let historyRevision = lock.withLock { deferredHistoryRevision }
            result = [
                "kind": "dashboard-history", "rowKey": rowKey, "historyCount": 1,
                "historyRevision": historyRevision,
                "history": [[
                    "activityKey": "earlier-activity", "activityTitle": "Earlier task", "status": "completed",
                    "startedAt": "2026-09-09T23:59:55Z", "updatedAt": "2026-09-10T00:00:00Z",
                    "endedAt": "2026-09-10T00:00:00Z", "durationMs": 5000
                ]]
            ]
        default: return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"Fixture method unavailable"}}"#)
        }
        let data = try! JSONSerialization.data(withJSONObject: ["result": result])
        return NativeFixtureReply(body: String(decoding: data, as: UTF8.self), delay: delay)
    }
}
