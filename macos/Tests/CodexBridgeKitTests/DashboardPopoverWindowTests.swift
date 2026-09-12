import AppKit
import SwiftUI
import XCTest
@testable import CodexBridgeMenuBar

final class DashboardPopoverWindowTests: XCTestCase {
    @MainActor
    func testActualWindowGrowsAndShrinksBelowTheSameTopEdge() async throws {
        let fixture = try WindowFixture()
        defer { fixture.close() }
        let openingFrame = fixture.window.frame

        try await fixture.waitForHeight(180)
        XCTAssertEqual(fixture.window.frame.maxY, openingFrame.maxY, accuracy: 1)
        XCTAssertEqual(fixture.window.frame.minX, openingFrame.minX, accuracy: 1)
        XCTAssertEqual(fixture.window.frame.width, openingFrame.width, accuracy: 1)
        let available = try XCTUnwrap(fixture.state.available)

        fixture.state.height = 420
        try await fixture.waitForHeight(420)
        XCTAssertEqual(fixture.window.frame.maxY, openingFrame.maxY, accuracy: 1)
        XCTAssertEqual(fixture.window.frame.minY, openingFrame.maxY - 420, accuracy: 1)

        fixture.state.height = 180
        try await fixture.waitForHeight(180)
        XCTAssertEqual(fixture.window.frame.maxY, openingFrame.maxY, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(fixture.state.available), available, accuracy: 1)
    }

    @MainActor
    func testHostResizingAroundItsCenterDoesNotMoveThePopoverAnchor() async throws {
        let fixture = try WindowFixture()
        defer { fixture.close() }
        try await fixture.waitForHeight(180)
        let top = fixture.window.frame.maxY

        // Reproduce a host that responds to larger content by resizing around
        // its center before the dashboard's AppKit update runs.
        fixture.state.height = 380
        var centered = fixture.window.frame
        centered.origin.y -= 100
        centered.size.height += 200
        fixture.window.setFrame(centered, display: false)

        try await fixture.waitForHeight(380, top: top)
        XCTAssertEqual(fixture.window.frame.maxY, top, accuracy: 1)
    }

    @MainActor
    func testWindowFitRetainsPaddingAddedByTheNativeHost() async throws {
        let fixture = try WindowFixture(hostPadding: 12, sizingOptions: [.minSize])
        defer { fixture.close() }
        let top = fixture.window.frame.maxY
        try await fixture.waitForHeight(204, top: top)
        fixture.state.height = 360
        try await fixture.waitForHeight(384, top: top)
        fixture.state.height = 180
        try await fixture.waitForHeight(204, top: top)
    }

    @MainActor
    func testReopeningAcceptsANewMenuPosition() async throws {
        let fixture = try WindowFixture()
        defer { fixture.close() }
        try await fixture.waitForHeight(180)
        fixture.state.presented = false
        await fixture.flushLayout()

        fixture.window.setFrameOrigin(NSPoint(
            x: fixture.window.frame.minX + 25, y: fixture.window.frame.minY - 70))
        let reopenedTop = fixture.window.frame.maxY
        fixture.state.height = 240
        fixture.state.presented = true
        try await fixture.waitForHeight(240, top: reopenedTop)
        XCTAssertEqual(fixture.window.frame.maxY, reopenedTop, accuracy: 1)
    }

    @MainActor
    func testOrdinaryDashboardWindowKeepsItsOwnSizingPolicy() async throws {
        let fixture = try WindowFixture(fitsWindow: false)
        defer { fixture.close() }
        let frame = fixture.window.frame
        await fixture.flushLayout()
        fixture.state.height = 300
        await fixture.flushLayout()
        XCTAssertEqual(fixture.window.frame, frame)
    }
}

@MainActor
private final class WindowState: ObservableObject {
    @Published var height: CGFloat = 180
    @Published var presented = true
    var available: CGFloat?
}

private struct WindowContent: View {
    @ObservedObject var state: WindowState
    let fitsWindow: Bool
    let hostPadding: CGFloat

    var body: some View {
        Color.clear
            .frame(width: DashboardPopoverLayout.width, height: state.height)
            .fixedSize()
            .background(DashboardPopoverScreen(fitsWindow: fitsWindow, isPresented: state.presented) {
                state.available = $0
            })
            .padding(hostPadding)
    }
}

@MainActor
private final class WindowFixture {
    let state = WindowState()
    let window: NSPanel
    let host: NSHostingView<WindowContent>

    init(fitsWindow: Bool = true, hostPadding: CGFloat = 0,
         sizingOptions: NSHostingSizingOptions = []) throws {
        let screen = try XCTUnwrap(NSScreen.main)
        window = NSPanel(contentRect: NSRect(x: screen.visibleFrame.midX - 230,
            y: screen.visibleFrame.maxY - 612, width: 460, height: 600),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        host = NSHostingView(rootView: WindowContent(state: state, fitsWindow: fitsWindow, hostPadding: hostPadding))
        // Model the stale MenuBarExtra host: its frame is independent of the
        // SwiftUI content's current ideal size. The production bridge must
        // resize the NSWindow itself, including when content becomes shorter.
        host.sizingOptions = sizingOptions
        window.contentView = host
    }

    func flushLayout() async {
        for _ in 0..<8 {
            host.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func waitForHeight(_ height: CGFloat, top: CGFloat? = nil,
                       file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<100 {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(10))
            if abs(window.frame.height - height) < 1,
               top.map({ abs(window.frame.maxY - $0) < 1 }) ?? true { return }
        }
        XCTFail("Window did not fit content: \(window.frame), expected height \(height), top \(String(describing: top))",
                file: file, line: line)
    }

    func close() {
        window.contentView = nil
        window.close()
    }
}
