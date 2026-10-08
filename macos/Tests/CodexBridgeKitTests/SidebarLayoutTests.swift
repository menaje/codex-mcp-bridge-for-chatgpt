import AppKit
import CodexBridgeKit
import SwiftUI
import XCTest
@testable import CodexBridgeMenuBar

final class SidebarLayoutTests: XCTestCase {
    @MainActor
    func testSettingsSearchAndMenuStayAtTheTopWhenWindowGrows() async throws {
        let fixture = SidebarLayoutFixture(skills: false)
        defer { fixture.close() }
        try await checkSearchPosition(in: fixture)
    }

    @MainActor
    func testSkillsSearchAndScopeStayAtTheTopWhenWindowGrows() async throws {
        let fixture = SidebarLayoutFixture(skills: true)
        defer { fixture.close() }
        try await checkSearchPosition(in: fixture)
    }

    @MainActor
    private func checkSearchPosition(in fixture: SidebarLayoutFixture) async throws {
        var firstTop: CGFloat?
        for height: CGFloat in [600, 900] {
            fixture.window.setContentSize(NSSize(width: 1120, height: height))
            try await fixture.settle()
            let root = try XCTUnwrap(fixture.window.contentView)
            let search = try XCTUnwrap(fixture.descendants.compactMap { $0 as? NSSearchField }.first)
            let searchFrame = search.convert(search.bounds, to: root)
            let top = root.isFlipped ? searchFrame.minY : root.bounds.height - searchFrame.maxY
            XCTAssertLessThan(top, 40, "Search belongs at the top of the sidebar, not the center")
            XCTAssertGreaterThanOrEqual(searchFrame.height, 18)
            XCTAssertLessThanOrEqual(searchFrame.height, 30, "The search row must not absorb the sidebar's vertical space")
            if let firstTop {
                XCTAssertEqual(top, firstTop, accuracy: 1, "Window growth must extend the menu area below the search")
            } else { firstTop = top }

            if fixture.skills {
                let scope = try XCTUnwrap(fixture.descendants.compactMap { $0 as? NSSegmentedControl }.first)
                let scopeFrame = scope.convert(scope.bounds, to: root)
                let scopeTop = root.isFlipped ? scopeFrame.minY : root.bounds.height - scopeFrame.maxY
                XCTAssertGreaterThanOrEqual(scopeTop - top - searchFrame.height, 0)
                XCTAssertLessThanOrEqual(scopeTop - top - searchFrame.height, 30, "The scope menu stays immediately below search")
            } else {
                let menu = try XCTUnwrap(fixture.descendants.compactMap { $0 as? NSScrollView }
                    .first { $0.bounds.width < 300 && $0.bounds.height > 100 })
                let menuFrame = menu.convert(menu.bounds, to: root)
                let menuTop = root.isFlipped ? menuFrame.minY : root.bounds.height - menuFrame.maxY
                XCTAssertGreaterThanOrEqual(menuTop - top - searchFrame.height, 0)
                XCTAssertLessThanOrEqual(menuTop - top - searchFrame.height, 30, "Settings menus stay immediately below search")
            }
        }
    }
}

@MainActor
private final class SidebarLayoutFixture {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("cb-sidebar-layout-\(UUID().uuidString)")
    let model: AppModel
    let window: NSWindow
    let skills: Bool

    init(skills: Bool) {
        _ = NSApplication.shared
        self.skills = skills
        model = AppModel(paths: RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path]))
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 600),
                          styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let content: AnyView = skills
            ? AnyView(SkillsLibraryWindowView().environmentObject(SkillsLibraryWindowState()))
            : AnyView(NativeSettingsView())
        window.contentView = NSHostingView(rootView: content.environmentObject(model))
    }

    var descendants: [NSView] {
        func collect(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + collect($0) } }
        return window.contentView.map(collect) ?? []
    }

    func settle() async throws {
        for _ in 0..<8 {
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(15))
        }
    }

    func close() {
        window.contentView = nil
        window.close()
        model.cancelAllPolling()
        try? FileManager.default.removeItem(at: root)
    }
}
