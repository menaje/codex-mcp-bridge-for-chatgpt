import AppKit
import CodexBridgeKit
import SwiftUI

enum DashboardPanel: String, CaseIterable {
    case running, responseRequired, problems, history, background

    var filter: DashboardStatusFilter {
        switch self {
        case .running: return .running
        case .responseRequired: return .responseRequired
        case .problems: return .problems
        case .history: return .all
        case .background: return .background
        }
    }

    var title: String {
        switch self {
        case .running: return "실행 중"
        case .responseRequired: return "응답 필요"
        case .problems: return "문제"
        case .history: return "작업·실행 기록"
        case .background: return "백그라운드 프로세스"
        }
    }

    func rows(in snapshot: DashboardSnapshot) -> [DashboardRow] {
        if self == .history {
            return snapshot.activeRows + snapshot.terminalRows
        }
        let rows = snapshot.statusRowsComplete == true
            ? snapshot.statusRows ?? []
            : snapshot.activeRows + snapshot.terminalRows
        return rows.filter(matches)
    }

    private func matches(_ row: DashboardRow) -> Bool {
        switch self {
        case .history:
            return true
        case .running:
            return row.status == "running"
        case .responseRequired:
            return ["input-required", "approval-required"].contains(row.status)
        case .problems:
            return ["failed", "interrupted", "termination-failed", "liveness-unknown", "orphaned"].contains(row.status)
        case .background:
            return row.backgroundProcessCount > 0
        }
    }
}

enum DashboardPopoverLayout {
    static let width: CGFloat = 460
    static let initialHeight: CGFloat = 160
    static let screenMargin: CGFloat = 24

    static func detailHeight(content: CGFloat, fixed: CGFloat, screen: CGFloat) -> CGFloat {
        min(max(1, content), max(1, screen - screenMargin - fixed))
    }

    static func detailHeight(
        for panel: DashboardPanel,
        content: CGFloat,
        fixed: CGFloat,
        screen: CGFloat
    ) -> CGFloat {
        let available = max(1, screen - screenMargin - fixed)
        // History is fetched only after the user opens it. Reserve its final
        // scroll viewport immediately so the loading view and populated list
        // do not repeatedly resize and re-anchor the native popover.
        if panel == .history { return available }
        return min(max(1, content), available)
    }

    static func popoverHeight(measured: CGFloat, screen: CGFloat) -> CGFloat {
        min(ceil(measured), max(1, floor(screen - screenMargin)))
    }
}

enum DashboardPopoverRegion: Hashable {
    case header, summary, footer, detail
}

struct DashboardPopoverHeights: PreferenceKey {
    static let defaultValue: [DashboardPopoverRegion: CGFloat] = [:]

    static func reduce(value: inout [DashboardPopoverRegion: CGFloat],
                       nextValue: () -> [DashboardPopoverRegion: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

struct DashboardPopoverContentSize: PreferenceKey {
    static let defaultValue = CGSize.zero

    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        if next.width > 0, next.height > 0 { value = next }
    }
}

extension View {
    func dashboardHeight(_ region: DashboardPopoverRegion) -> some View {
        background(GeometryReader { geometry in
            Color.clear.preference(key: DashboardPopoverHeights.self, value: [region: geometry.size.height])
        })
    }
}

/// Report the stable vertical space for the screen that owns the popover. The
/// native NSPopover owns its animated window frame. Deriving this value from
/// that moving frame feeds the animation back into SwiftUI's requested height
/// and makes the popover repeatedly grow and shrink.
struct DashboardPopoverScreen: NSViewRepresentable {
    let changed: (CGFloat) -> Void

    func makeNSView(context: Context) -> ScreenView { ScreenView(changed: changed) }
    func updateNSView(_ view: ScreenView, context: Context) {
        view.changed = changed
        view.scheduleUpdate()
    }

    final class ScreenView: NSView {
        var changed: (CGFloat) -> Void
        private var lastAvailable: CGFloat?
        private var updatePending = false

        init(changed: @escaping (CGFloat) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            NotificationCenter.default.removeObserver(self)
            lastAvailable = nil
            if let window {
                NotificationCenter.default.addObserver(self, selector: #selector(screenChanged),
                    name: NSWindow.didChangeScreenNotification, object: window)
                NotificationCenter.default.addObserver(self, selector: #selector(windowChanged),
                    name: NSWindow.didMoveNotification, object: window)
                NotificationCenter.default.addObserver(self, selector: #selector(windowChanged),
                    name: NSWindow.didResizeNotification, object: window)
            }
            scheduleUpdate()
        }

        @objc private func screenChanged(_ notification: Notification) {
            lastAvailable = nil
            scheduleUpdate()
        }

        @objc private func windowChanged(_ notification: Notification) { scheduleUpdate() }

        override func layout() {
            super.layout()
            scheduleUpdate()
        }

        func scheduleUpdate() {
            guard !updatePending else { return }
            updatePending = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.updatePending = false
                self.updateAvailableHeight()
            }
        }

        private func updateAvailableHeight() {
            guard let window, let screen = window.screen, bounds.height > 0 else { return }
            let available = floor(screen.visibleFrame.height)
            guard available > 0, available != lastAvailable else { return }
            lastAvailable = available
            changed(available)
        }

        deinit { NotificationCenter.default.removeObserver(self) }
    }
}
