import AppKit
import SwiftUI
import XCTest
@testable import CodexBridgeMenuBar

final class NativeTextInputTests: XCTestCase {
    /// Drives the same NSTextInputClient calls as an IME. Before the fix, the
    /// multiline editor lost marked text at ㄱ, ㅇ and ㄹ after a previous commit.
    @MainActor
    func testHangulCompositionSurvivesBindingAndUnrelatedViewUpdates() async throws {
        let fixture = try await InputFixture()
        defer { fixture.close() }
        let fields = fixture.descendants.compactMap { $0 as? NSTextField }
            .filter { $0.isEditable && !($0 is NSSecureTextField) }
        let search = fields.filter { $0 is NSSearchField }
        XCTAssertEqual(fields.count, 3, "Default field, rounded field and sidebar search must be exercised")
        XCTAssertEqual(search.count, 1)
        for field in fields {
            XCTAssertTrue(fixture.window.makeFirstResponder(field))
            let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
            try await composeHangul(in: editor, fixture: fixture)
            XCTAssertEqual(field.stringValue, "한글 입력")
            fixture.window.makeFirstResponder(nil)
        }
        XCTAssertEqual(fixture.state.field, "한글 입력")
        XCTAssertEqual(fixture.state.roundedField, "한글 입력")
        XCTAssertEqual(fixture.state.search, "한글 입력")

        let editor = try fixture.editor()
        XCTAssertTrue(fixture.window.makeFirstResponder(editor))
        try await composeHangul(in: editor, fixture: fixture)
        XCTAssertEqual(editor.string, "한글 입력")
        XCTAssertEqual(fixture.state.editor, "한글 입력")
    }

    @MainActor
    func testCompositionReplacementUsesUTF16RangesAndSurvivesAnExternalRefresh() async throws {
        let fixture = try await InputFixture(initialText: "😀 처음 끝")
        defer { fixture.close() }
        let editor = try fixture.editor()
        fixture.window.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: 3, length: 2))
        for stage in ["ㅎ", "하", "한"] {
            editor.setMarkedText(stage, selectedRange: NSRange(location: 1, length: 0), replacementRange: unspecifiedRange)
            fixture.state.editor = "갱신된 서버 원문"
            try await fixture.refresh()
            XCTAssertTrue(editor.hasMarkedText())
            XCTAssertEqual(editor.markedRange(), NSRange(location: 3, length: 1))
            XCTAssertEqual(editor.string, "😀 \(stage) 끝")
        }
        editor.unmarkText()
        try await fixture.refresh()
        XCTAssertEqual(fixture.state.editor, "😀 한 끝")
        XCTAssertEqual(editor.string, fixture.state.editor)
        XCTAssertFalse(editor.hasMarkedText())
        XCTAssertEqual(editor.selectedRange(), NSRange(location: 4, length: 0))
    }

    @MainActor
    func testFocusChangeCommitsTheLastSyllableAndCompositionBackspace() async throws {
        let fixture = try await InputFixture()
        defer { fixture.close() }
        let editor = try fixture.editor()
        fixture.window.makeFirstResponder(editor)
        for stage in ["ㄱ", "가", "각", "가"] {
            editor.setMarkedText(stage, selectedRange: NSRange(location: 1, length: 0), replacementRange: unspecifiedRange)
            try await fixture.refresh()
            XCTAssertTrue(editor.hasMarkedText())
            XCTAssertEqual(editor.string, stage)
            XCTAssertEqual(fixture.state.editor, stage, "Dirty state and validation must see the visible composition")
        }
        let field = try XCTUnwrap(fixture.descendants.compactMap { $0 as? NSTextField }.first { $0.isEditable })
        fixture.window.makeFirstResponder(field)
        try await fixture.refresh()
        XCTAssertFalse(editor.hasMarkedText())
        XCTAssertEqual(fixture.state.editor, "가")
    }

    @MainActor
    func testPlainTextPreservesHangulBytesLineEndingsAndPunctuation() async throws {
        let original = "\u{feff}# 한글 한\r\n'따옴표' -- `코드` 😀 e\u{301}\n\n"
        let fixture = try await InputFixture(initialText: original)
        defer { fixture.close() }
        let editor = try fixture.editor()
        XCTAssertTrue(editor.string.utf8.elementsEqual(original.utf8))
        XCTAssertFalse(editor.isAutomaticQuoteSubstitutionEnabled)
        XCTAssertFalse(editor.isAutomaticDashSubstitutionEnabled)
        XCTAssertFalse(editor.isAutomaticTextReplacementEnabled)
        XCTAssertFalse(editor.isAutomaticSpellingCorrectionEnabled)
        XCTAssertFalse(editor.isRichText)
        XCTAssertTrue(editor.usesFindBar)
        XCTAssertTrue(editor.allowsUndo)

        let inserted = "각\r\n\"한글\" -- 😀"
        fixture.window.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        editor.insertText(inserted, replacementRange: unspecifiedRange)
        try await fixture.refresh()
        XCTAssertTrue(editor.string.utf8.elementsEqual(inserted.utf8))
        XCTAssertTrue(fixture.state.editor.utf8.elementsEqual(inserted.utf8))

        // Canonically equivalent Swift Strings may still have different bytes.
        fixture.state.editor = "각"
        try await fixture.refresh()
        fixture.state.editor = "각"
        try await fixture.refresh()
        XCTAssertTrue(editor.string.utf8.elementsEqual("각".utf8))
    }

    @MainActor
    func testSecureInputAcceptsExactPastedUnicodeWithoutExposingItInLogs() async throws {
        let fixture = try await InputFixture()
        defer { fixture.close() }
        let field = try XCTUnwrap(fixture.descendants.compactMap { $0 as? NSSecureTextField }.first)
        fixture.window.makeFirstResponder(field)
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        let synthetic = "fixture-한글-각-e\u{301}-😀"
        editor.insertText(synthetic, replacementRange: unspecifiedRange)
        try await fixture.refresh()
        fixture.window.makeFirstResponder(nil)
        XCTAssertTrue(field.stringValue.utf8.elementsEqual(synthetic.utf8))
        XCTAssertTrue(fixture.state.secret.utf8.elementsEqual(synthetic.utf8))
    }

    @MainActor
    func testExplicitActionsCommitTheLastSyllableWithoutChangingFocus() async throws {
        let fixture = try await InputFixture()
        defer { fixture.close() }
        let field = try XCTUnwrap(fixture.descendants.compactMap { $0 as? NSTextField }.first { $0.placeholderString == "Default field" })
        fixture.window.makeFirstResponder(field)
        let fieldEditor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        fieldEditor.setMarkedText("한", selectedRange: NSRange(location: 1, length: 0), replacementRange: unspecifiedRange)
        BridgeTextInput.commitPendingComposition(in: fixture.window)
        XCTAssertEqual(fixture.state.field, "한", "A save action must read the complete field immediately")
        XCTAssertFalse(fieldEditor.hasMarkedText())

        let editor = try fixture.editor()
        fixture.window.makeFirstResponder(editor)
        editor.setMarkedText("글", selectedRange: NSRange(location: 1, length: 0), replacementRange: unspecifiedRange)
        XCTAssertEqual(fixture.state.editor, "글")
        XCTAssertTrue(editor.hasMarkedText())
        BridgeTextInput.commitPendingComposition(in: fixture.window)
        XCTAssertEqual(fixture.state.editor, "글")
        XCTAssertFalse(editor.hasMarkedText())
        XCTAssertTrue(fixture.window.firstResponder === editor)

        // A custom Paste button replaces the draft only after committing IME text.
        fixture.state.editor = "새 초대장"
        try await fixture.refresh()
        XCTAssertEqual(editor.string, "새 초대장")
    }

    @MainActor
    func testCommittedEditsKeepUndoRedoAndScrollLayoutAcrossRefreshes() async throws {
        let fixture = try await InputFixture()
        defer { fixture.close() }
        let editor = try fixture.editor()
        fixture.window.makeFirstResponder(editor)
        let undo = try XCTUnwrap(editor.undoManager)
        undo.groupsByEvent = false
        undo.beginUndoGrouping()
        editor.insertText("한글 초안", replacementRange: unspecifiedRange)
        undo.endUndoGrouping()
        try await fixture.refresh()
        XCTAssertTrue(undo.canUndo)
        undo.undo()
        try await fixture.refresh()
        XCTAssertEqual(fixture.state.editor, "")
        XCTAssertTrue(undo.canRedo)
        undo.redo()
        try await fixture.refresh()
        XCTAssertEqual(fixture.state.editor, "한글 초안")

        fixture.state.editor = String(repeating: "한글 문서 한 줄\n", count: 300)
        try await fixture.refresh()
        let scrollView = try XCTUnwrap(editor.enclosingScrollView)
        XCTAssertGreaterThan(editor.frame.width, 200)
        XCTAssertGreaterThan(editor.frame.height, scrollView.contentSize.height)
        XCTAssertEqual(editor.frame.width, scrollView.contentSize.width, accuracy: 1)
        fixture.window.setContentSize(NSSize(width: 840, height: 520))
        try await fixture.refresh()
        XCTAssertEqual(editor.frame.width, scrollView.contentSize.width, accuracy: 1)
    }

    func testEveryProductionMultilineInputUsesTheCompositionSafeEditor() throws {
        var macos = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { macos.deleteLastPathComponent() }
        let directory = macos.appendingPathComponent("Sources/CodexBridgeMenuBar")
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        let unsafeEditor = try NSRegularExpression(pattern: #"\bTextEditor\s*\("#)
        var protectedInputs = 0
        for file in files {
            let source = try String(contentsOf: file, encoding: .utf8)
            XCTAssertEqual(unsafeEditor.numberOfMatches(in: source, range: NSRange(source.startIndex..., in: source)), 0, file.lastPathComponent)
            protectedInputs += source.components(separatedBy: "BridgeTextEditor(text:").count - 1
        }
        XCTAssertEqual(protectedInputs, 6, "Review the native input inventory when adding an editor")
    }

    func testServerRefreshPreservesEachEditedDraftAndUpdatesUntouchedFields() {
        var draft = HostedConnectionDraft(endpoint: "https://initial.local", displayName: "초기 서버")
        draft.synchronize(endpoint: "https://server.local", displayName: "서버", editing: nil)
        XCTAssertEqual(draft.endpoint, "https://server.local")
        XCTAssertEqual(draft.displayName, "서버")
        draft.displayName = "한글로 바꾸는 중"
        draft.synchronize(endpoint: "https://new.local", displayName: "다른 이름", editing: nil)
        XCTAssertEqual(draft.endpoint, "https://new.local")
        XCTAssertEqual(draft.displayName, "한글로 바꾸는 중")
        draft.endpoint = "https://my-draft.local"
        draft.synchronize(endpoint: "https://remote.local", displayName: "주기적 갱신", editing: nil)
        XCTAssertEqual(draft.endpoint, "https://my-draft.local")
        XCTAssertEqual(draft.displayName, "한글로 바꾸는 중")

        draft.acknowledge(endpoint: draft.endpoint, displayName: draft.displayName)
        draft.synchronize(endpoint: "https://saved.local", displayName: "저장된 이름", editing: nil)
        XCTAssertEqual(draft.endpoint, "https://saved.local")
        XCTAssertEqual(draft.displayName, "저장된 이름")
    }

    func testFocusedFieldIsProtectedBeforeTheIMEPublishesItsDraft() {
        var draft = HostedConnectionDraft(endpoint: "https://initial.local", displayName: "초기 서버")
        draft.synchronize(endpoint: "https://new.local", displayName: "외부 변경", editing: .displayName)
        XCTAssertEqual(draft.displayName, "초기 서버")
        draft.displayName = "한글 조합 완료"
        draft.synchronize(endpoint: "https://new.local", displayName: "외부 변경", editing: nil)
        XCTAssertEqual(draft.displayName, "한글 조합 완료")

        var untouched = HostedConnectionDraft(endpoint: "https://initial.local", displayName: "초기 서버")
        untouched.synchronize(endpoint: "https://updated.local", displayName: nil, editing: .endpoint)
        XCTAssertEqual(untouched.endpoint, "https://initial.local")
        untouched.synchronize(endpoint: "https://updated.local", displayName: nil, editing: nil)
        XCTAssertEqual(untouched.endpoint, "https://updated.local")
    }

    @MainActor
    private func composeHangul(in editor: NSTextView, fixture: InputFixture) async throws {
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        for syllable in [["ㅎ", "하", "한"], ["ㄱ", "그", "글"], [" "], ["ㅇ", "이", "입"], ["ㄹ", "려", "력"]] {
            if syllable == [" "] { editor.insertText(" ", replacementRange: unspecifiedRange); continue }
            for stage in syllable {
                editor.setMarkedText(stage, selectedRange: NSRange(location: (stage as NSString).length, length: 0), replacementRange: unspecifiedRange)
                try await fixture.refresh()
                XCTAssertTrue(editor.hasMarkedText(), "Composition lost after \(stage)")
            }
            editor.insertText(syllable.last!, replacementRange: unspecifiedRange)
            // Start the next syllable immediately, before SwiftUI's pending update.
        }
        try await fixture.refresh()
    }

    private var unspecifiedRange: NSRange { NSRange(location: NSNotFound, length: 0) }
}

@MainActor
private final class InputFixture {
    let state = TextInputTestState()
    let window: NSWindow

    init(initialText: String = "") async throws {
        _ = NSApplication.shared
        state.editor = initialText
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 480),
                          styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: TextInputTestView(state: state))
        for _ in 0..<8 { try await refresh() }
    }

    var descendants: [NSView] {
        func collect(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + collect($0) } }
        return window.contentView.map(collect) ?? []
    }

    func editor() throws -> NSTextView {
        try XCTUnwrap(descendants.compactMap { $0 as? NSTextView }.first { $0.isEditable && !$0.isFieldEditor })
    }

    func refresh() async throws {
        state.tick += 1
        window.contentView?.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(15))
    }

    func close() { window.contentView = nil; window.close() }
}

@MainActor
private final class TextInputTestState: ObservableObject {
    @Published var field = ""
    @Published var roundedField = ""
    @Published var editor = ""
    @Published var search = ""
    @Published var secret = ""
    @Published var tick = 0
}

private struct TextInputTestView: View {
    @ObservedObject var state: TextInputTestState
    var body: some View {
        NavigationSplitView {
            List { Text(state.search) }
        } detail: {
            VStack {
                TextField("Default field", text: $state.field)
                TextField("Rounded field", text: $state.roundedField).textFieldStyle(.roundedBorder)
                SecureField("Synthetic secret", text: $state.secret)
                BridgeTextEditor(text: $state.editor)
                Text("\(state.tick)")
            }.padding()
        }.searchable(text: $state.search, placement: .sidebar)
    }
}
