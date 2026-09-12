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

    static func detailHeight(content: CGFloat, fixed: CGFloat, screen: CGFloat) -> CGFloat {
        min(max(1, content), max(1, screen - 24 - fixed))
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

extension View {
    func dashboardHeight(_ region: DashboardPopoverRegion) -> some View {
        background(GeometryReader { geometry in
            Color.clear.preference(key: DashboardPopoverHeights.self, value: [region: geometry.size.height])
        })
    }
}

/// Fit below the popover's actual top edge, including on a secondary display.
struct DashboardPopoverScreen: NSViewRepresentable {
    let changed: (CGFloat) -> Void

    func makeNSView(context: Context) -> ScreenView { ScreenView(changed: changed) }
    func updateNSView(_ view: ScreenView, context: Context) { view.changed = changed }

    final class ScreenView: NSView {
        var changed: (CGFloat) -> Void
        private var lastAvailable: CGFloat?

        init(changed: @escaping (CGFloat) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            NotificationCenter.default.removeObserver(self)
            if let window {
                NotificationCenter.default.addObserver(self, selector: #selector(screenChanged),
                    name: NSWindow.didChangeScreenNotification, object: window)
                NotificationCenter.default.addObserver(self, selector: #selector(screenChanged),
                    name: NSWindow.didMoveNotification, object: window)
                NotificationCenter.default.addObserver(self, selector: #selector(screenChanged),
                    name: NSWindow.didResizeNotification, object: window)
            }
            reportScreen()
        }

        @objc private func screenChanged(_ notification: Notification) { reportScreen() }

        override func layout() {
            super.layout()
            reportScreen()
        }

        private func reportScreen() {
            guard let window, let screen = window.screen, bounds.height > 0 else { return }
            let top = window.convertPoint(toScreen: convert(
                NSPoint(x: bounds.minX, y: isFlipped ? bounds.minY : bounds.maxY), to: nil)).y
            let available = floor(min(screen.visibleFrame.maxY, top) - screen.visibleFrame.minY)
            guard available > 0, available != lastAvailable else { return }
            lastAvailable = available
            DispatchQueue.main.async { [weak self] in self?.changed(available) }
        }

        deinit { NotificationCenter.default.removeObserver(self) }
    }
}
