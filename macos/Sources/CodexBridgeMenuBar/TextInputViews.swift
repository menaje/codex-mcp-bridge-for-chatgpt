import AppKit
import SwiftUI

/// Keep AppKit's live buffer authoritative while an input method is composing.
/// SwiftUI may deliver a previous binding value just after a syllable commits;
/// writing that value back would erase the next syllable's marked text.
struct BridgeTextEditor: NSViewRepresentable {
    @Binding var text: String
    var font: NSFont = .systemFont(ofSize: NSFont.systemFontSize)
    @Environment(\.isEnabled) private var isEnabled
    // Swift String equality treats NFC/NFD as equal. Give SwiftUI an exact
    // snapshot too, so a byte-distinct external document still updates the view.
    private let sourceUTF8: Data

    init(text: Binding<String>, font: NSFont = .systemFont(ofSize: NSFont.systemFontSize)) {
        _text = text
        self.font = font
        sourceUTF8 = Data(text.wrappedValue.utf8)
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false

        let editor = BridgeEditableTextView(frame: .zero)
        editor.isRichText = false
        editor.importsGraphics = false
        editor.allowsUndo = true
        editor.usesFindBar = true
        editor.isIncrementalSearchingEnabled = true
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.isAutomaticLinkDetectionEnabled = false
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.minSize = .zero
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.containerSize = editor.maxSize
        editor.textContainer?.widthTracksTextView = true
        editor.textContainerInset = NSSize(width: 5, height: 5)
        editor.font = font
        editor.textColor = .textColor
        editor.backgroundColor = .textBackgroundColor
        editor.string = text
        editor.delegate = context.coordinator
        editor.onTextChange = { [weak coordinator = context.coordinator, weak editor] in
            if let editor { coordinator?.publish(editor) }
        }
        scrollView.documentView = editor
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.text = $text
        guard let editor = scrollView.documentView as? NSTextView else { return }
        editor.isEditable = isEnabled
        editor.isSelectable = true
        // Attribute changes can also disturb the input method's marked range.
        guard !editor.hasMarkedText() else { return }
        if editor.font != font { editor.font = font }
        guard !editor.string.utf8.elementsEqual(text.utf8) else { return }
        let selection = editor.selectedRange()
        editor.string = text
        let length = (text as NSString).length
        let location = min(selection.location, length)
        editor.setSelectedRange(NSRange(location: location, length: min(selection.length, length - location)))
        editor.undoManager?.removeAllActions()
    }

    static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
        guard let editor = scrollView.documentView as? BridgeEditableTextView else { return }
        editor.delegate = nil
        editor.onTextChange = nil
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var text: Binding<String>

        init(text: Binding<String>) { self.text = text }

        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            publish(editor)
        }

        func publish(_ editor: NSTextView) {
            // Preserve exact bytes, including decomposed Hangul and line endings.
            if !text.wrappedValue.utf8.elementsEqual(editor.string.utf8) {
                text.wrappedValue = editor.string
            }
        }
    }
}

@MainActor
private final class BridgeEditableTextView: NSTextView {
    var onTextChange: (() -> Void)?
    private weak var observedUndoManager: UndoManager?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observeUndoManager()
    }

    override func becomeFirstResponder() -> Bool {
        guard super.becomeFirstResponder() else { return false }
        observeUndoManager()
        return true
    }

    private func observeUndoManager() {
        let nextManager = window == nil ? nil : undoManager
        guard nextManager !== observedUndoManager else { return }
        if let observedUndoManager {
            NotificationCenter.default.removeObserver(self, name: .NSUndoManagerDidUndoChange, object: observedUndoManager)
            NotificationCenter.default.removeObserver(self, name: .NSUndoManagerDidRedoChange, object: observedUndoManager)
        }
        observedUndoManager = nextManager
        if let nextManager {
            NotificationCenter.default.addObserver(self, selector: #selector(undoOrRedoCompleted(_:)), name: .NSUndoManagerDidUndoChange, object: nextManager)
            NotificationCenter.default.addObserver(self, selector: #selector(undoOrRedoCompleted(_:)), name: .NSUndoManagerDidRedoChange, object: nextManager)
        }
    }

    @objc private func undoOrRedoCompleted(_ notification: Notification) {
        onTextChange?()
    }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
        // Draft/dirty state and save-button validation must include the visible
        // composition even before AppKit posts its committed-text notification.
        onTextChange?()
    }

    override func unmarkText() {
        super.unmarkText()
        onTextChange?()
    }

    override func resignFirstResponder() -> Bool {
        guard super.resignFirstResponder() else { return false }
        if hasMarkedText() {
            unmarkText()
            inputContext?.discardMarkedText()
        }
        onTextChange?()
        return true
    }
}
