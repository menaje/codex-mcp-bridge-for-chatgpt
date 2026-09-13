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

/// Keep the menu window fitted to its content, growing down from its opening position.
/// Ordinary windows using the same dashboard only report their available space.
struct DashboardPopoverScreen: NSViewRepresentable {
    var fitsWindow = false
    var isPresented = true
    let changed: (CGFloat) -> Void

    func makeNSView(context: Context) -> ScreenView { ScreenView(changed: changed) }
    func updateNSView(_ view: ScreenView, context: Context) {
        view.changed = changed
        view.configure(fitsWindow: fitsWindow, isPresented: isPresented)
    }

    final class ScreenView: NSView {
        var changed: (CGFloat) -> Void
        private var lastAvailable: CGFloat?
        private var fitsWindow = false
        private var isPresented = false
        private var topEdge: CGFloat?
        private var lastWindowFrame: NSRect?
        private var contentChromeHeight: CGFloat?
        private var updatePending = false
        private var applyingFrame = false

        init(changed: @escaping (CGFloat) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        func configure(fitsWindow: Bool, isPresented: Bool) {
            if self.isPresented != isPresented || self.fitsWindow != fitsWindow {
                resetAnchor()
            }
            self.fitsWindow = fitsWindow
            self.isPresented = isPresented
            scheduleUpdate()
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            NotificationCenter.default.removeObserver(self)
            resetAnchor()
            if let window {
                NotificationCenter.default.addObserver(self, selector: #selector(screenChanged),
                    name: NSWindow.didChangeScreenNotification, object: window)
                NotificationCenter.default.addObserver(self, selector: #selector(windowGeometryChanged),
                    name: NSWindow.didMoveNotification, object: window)
                NotificationCenter.default.addObserver(self, selector: #selector(windowGeometryChanged),
                    name: NSWindow.didResizeNotification, object: window)
            }
            scheduleUpdate()
        }

        @objc private func screenChanged(_ notification: Notification) {
            resetAnchor()
            scheduleUpdate()
        }

        @objc private func windowGeometryChanged(_ notification: Notification) {
            guard !applyingFrame else { return }
            scheduleUpdate()
        }

        override func layout() {
            super.layout()
            scheduleUpdate()
        }

        private func resetAnchor() {
            topEdge = nil
            lastWindowFrame = nil
            contentChromeHeight = nil
            lastAvailable = nil
        }

        private func scheduleUpdate() {
            guard !updatePending else { return }
            updatePending = true
            // AppKit resizing during a SwiftUI layout pass can feed a stale size
            // back into that pass. Coalesce measurements after layout instead.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.updatePending = false
                self.updateWindow()
            }
        }

        func updateWindow() {
            guard let window, let screen = window.screen, bounds.height > 0 else { return }
            let top: CGFloat
            if fitsWindow {
                guard isPresented else { return }
                let currentFrame = window.frame
                // A move without a resize is a new placement (for example when
                // reopening at a different status-item position). A content
                // resize must retain the previous top edge, even if SwiftUI
                // has already resized the host around its center.
                if topEdge == nil || (lastWindowFrame?.size == currentFrame.size &&
                    lastWindowFrame?.origin != currentFrame.origin) {
                    topEdge = currentFrame.maxY
                }
                let anchoredTop = min(topEdge ?? currentFrame.maxY, screen.visibleFrame.maxY)
                topEdge = anchoredTop
                let contentRect = window.contentRect(forFrameRect: currentFrame)
                // Some SwiftUI hosts expose their fixed outer padding through
                // contentMinSize instead of their intrinsic/fitting size. That
                // minimum can retain the largest prior height on Intel, though,
                // so use it only to learn the fixed chrome around this view.
                // The current ScreenView bounds remain the source of the
                // changing content height, which lets a collapsed panel shrink.
                let hostContentHeight = max(window.contentMinSize.height,
                    window.contentView?.fittingSize.height ?? 0)
                let measuredChromeHeight = max(0, hostContentHeight - bounds.height)
                if let contentChromeHeight {
                    self.contentChromeHeight = contentChromeHeight > 0
                        ? min(contentChromeHeight, measuredChromeHeight)
                        : measuredChromeHeight
                } else {
                    contentChromeHeight = measuredChromeHeight
                }
                let height = ceil(bounds.height + (contentChromeHeight ?? 0))
                var frame = window.frameRect(forContentRect: NSRect(
                    x: contentRect.minX, y: contentRect.minY, width: contentRect.width, height: height))
                frame.origin.y = anchoredTop - frame.height
                if frame != currentFrame {
                    applyingFrame = true
                    window.setFrame(frame, display: true)
                    applyingFrame = false
                }
                lastWindowFrame = window.frame
                // Available height must use the window anchor, not the inner
                // view's position inside a previously oversized, centered host.
                top = anchoredTop - (frame.height - bounds.height)
            } else {
                top = window.convertPoint(toScreen: convert(
                    NSPoint(x: bounds.minX, y: isFlipped ? bounds.minY : bounds.maxY), to: nil)).y
            }
            let available = floor(min(screen.visibleFrame.maxY, top) - screen.visibleFrame.minY)
            guard available > 0, available != lastAvailable else { return }
            lastAvailable = available
            changed(available)
        }

        deinit { NotificationCenter.default.removeObserver(self) }
    }
}
