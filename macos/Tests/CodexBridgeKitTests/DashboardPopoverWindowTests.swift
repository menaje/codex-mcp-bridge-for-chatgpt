import AppKit
import SwiftUI
import XCTest
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

final class DashboardPopoverWindowTests: XCTestCase {
    @MainActor
    func testNativePopoverCannotCollapseWhileTheModelIsStillStarting() async throws {
        let root = URL(fileURLWithPath: "/tmp/cb-empty-popover-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(
            environment: ["XDG_CONFIG_HOME": root.path, "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1"],
            currentDirectory: root
        )
        let model = AppModel(paths: paths)
        let controller = BridgeMenuBarController()
        controller.install(model: model)
        defer {
            controller.uninstall()
            model.cancelAllPolling()
            try? FileManager.default.removeItem(at: root)
        }

        let button = try XCTUnwrap(controller.statusItem?.button)
        button.performClick(nil)
        for _ in 0..<12 {
            controller.popover.contentViewController?.view.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertEqual(controller.popover.contentSize.width, DashboardPopoverLayout.width)
        XCTAssertGreaterThan(controller.popover.contentSize.height, 80)
        XCTAssertEqual(
            controller.popover.contentViewController?.preferredContentSize,
            controller.popover.contentSize
        )
    }

    @MainActor
    func testScreenMeasurementIsStableAndDoesNotMutateTheNativeHostWindow() async throws {
        let screen = try XCTUnwrap(NSScreen.main)
        let state = WindowState()
        let window = NSPanel(
            contentRect: NSRect(
                x: screen.visibleFrame.midX - 230,
                y: screen.visibleFrame.maxY - 400,
                width: DashboardPopoverLayout.width,
                height: 240
            ),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: ScreenMeasurementContent(state: state))
        host.sizingOptions = []
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        let originalFrame = window.frame

        for _ in 0..<12 {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertNotNil(state.availableHeight)
        XCTAssertEqual(state.availableHeight, floor(screen.visibleFrame.height))
        XCTAssertEqual(window.frame, originalFrame)

        window.setFrame(NSRect(
            x: originalFrame.minX,
            y: screen.visibleFrame.minY + 10,
            width: originalFrame.width,
            height: screen.visibleFrame.height - 40
        ), display: true)
        for _ in 0..<12 {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(state.availableHeight, floor(screen.visibleFrame.height))
    }

    func testContentSizePreferenceAcceptsTheLatestValidMeasurement() {
        var size = CGSize.zero
        DashboardPopoverContentSize.reduce(value: &size) {
            CGSize(width: DashboardPopoverLayout.width, height: 180.2)
        }
        DashboardPopoverContentSize.reduce(value: &size) { .zero }
        XCTAssertEqual(size.width, DashboardPopoverLayout.width)
        XCTAssertEqual(size.height, 180.2)

        DashboardPopoverContentSize.reduce(value: &size) {
            CGSize(width: DashboardPopoverLayout.width, height: 420.8)
        }
        XCTAssertEqual(size.height, 420.8)
    }
}

@MainActor
private final class WindowState: ObservableObject {
    @Published var availableHeight: CGFloat?
}

private struct ScreenMeasurementContent: View {
    @ObservedObject var state: WindowState

    var body: some View {
        Color.clear
            .frame(width: DashboardPopoverLayout.width, height: 180)
            .background(DashboardPopoverScreen { state.availableHeight = $0 })
    }
}
