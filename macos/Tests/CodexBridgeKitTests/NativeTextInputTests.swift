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

    /// Protocol simulation, not a claim about any particular installed IME.
    @MainActor
    func testJapaneseAndChineseCandidateConversionSurvivesViewUpdates() async throws {
        let fixture = try await InputFixture()
        defer { fixture.close() }
        let fields = fixture.descendants.compactMap { $0 as? NSTextField }
            .filter { $0.isEditable && !($0 is NSSecureTextField) }
        XCTAssertEqual(fields.count, 3)
        let conversions: [(name: String, groups: [[String]], expected: String)] = [
            ("Japanese", [["に", "にほ", "にほん", "日本"], ["ご", "語"]], "日本語"),
            ("Simplified Chinese", [["h", "han", "汉"], ["y", "yu", "语"]], "汉语"),
            ("Traditional Chinese", [["ㄏ", "ㄏㄢ", "漢"], ["ㄩ", "語"]], "漢語")
        ]
        for conversion in conversions {
            for field in fields {
                XCTAssertTrue(fixture.window.makeFirstResponder(field))
                let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
                try await compose(conversion.groups, in: editor, fixture: fixture)
                XCTAssertEqual(field.stringValue, conversion.expected, conversion.name)
                fixture.window.makeFirstResponder(nil)
            }
            XCTAssertEqual(fixture.state.field, conversion.expected, conversion.name)
            XCTAssertEqual(fixture.state.roundedField, conversion.expected, conversion.name)
            XCTAssertEqual(fixture.state.search, conversion.expected, conversion.name)
            let editor = try fixture.editor()
            XCTAssertTrue(fixture.window.makeFirstResponder(editor))
            try await compose(conversion.groups, in: editor, fixture: fixture)
            XCTAssertEqual(editor.string, conversion.expected, conversion.name)
            XCTAssertEqual(fixture.state.editor, conversion.expected, conversion.name)
        }
    }

    @MainActor
    func testCombiningAndIndicCompositionPreservesExactBytes() async throws {
        let fixture = try await InputFixture()
        defer { fixture.close() }
        let editor = try fixture.editor()
        fixture.window.makeFirstResponder(editor)
        let compositions = [
            ["e", "e\u{301}"],
            ["か", "か\u{3099}"],
            ["क", "क्", "क्\u{200d}", "क्\u{200d}ष"],
            ["ก", "กิ", "กี่"],
            ["م", "مر", "مَرْحَبًا"]
        ]
        for stages in compositions {
            try await compose([stages], in: editor, fixture: fixture)
            let expected = try XCTUnwrap(stages.last)
            XCTAssertEqual(Data(editor.string.utf8), Data(expected.utf8))
            XCTAssertEqual(Data(fixture.state.editor.utf8), Data(expected.utf8))
        }
    }

    @MainActor
    func testCandidateSelectionReplacementAndSaveAfterEmojiAndBeforeRTLText() async throws {
        let fixture = try await InputFixture(initialText: "😀 placeholder / العربية")
        defer { fixture.close() }
        let editor = try fixture.editor()
        fixture.window.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: 3, length: 11))
        for stage in ["にほんご", "日本語"] {
            let length = (stage as NSString).length
            editor.setMarkedText(stage, selectedRange: NSRange(location: 0, length: length), replacementRange: unspecifiedRange)
            fixture.state.editor = "external update"
            try await fixture.refresh()
            XCTAssertTrue(editor.hasMarkedText())
            XCTAssertEqual(editor.markedRange(), NSRange(location: 3, length: length))
            XCTAssertEqual(editor.string, "😀 \(stage) / العربية")
        }
        commitFixtureComposition(in: fixture.window)
        XCTAssertEqual(fixture.state.editor, "😀 日本語 / العربية")
        XCTAssertFalse(editor.hasMarkedText())

        // Reconversion replaces an explicit UTF-16 range, not a Swift Character index.
        editor.setMarkedText("hanzi", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 3, length: 3))
        try await fixture.refresh()
        XCTAssertEqual(editor.string, "😀 hanzi / العربية")
        editor.insertText("漢字", replacementRange: unspecifiedRange)
        try await fixture.refresh()
        XCTAssertEqual(fixture.state.editor, "😀 漢字 / العربية")

        // An input source can cancel reconversion by restoring its original text.
        editor.setMarkedText("hanzi", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 3, length: 2))
        try await fixture.refresh()
        editor.insertText("漢字", replacementRange: unspecifiedRange)
        try await fixture.refresh()
        XCTAssertEqual(fixture.state.editor, "😀 漢字 / العربية")
        XCTAssertFalse(editor.hasMarkedText())
    }

    @MainActor
    func testMultilingualInsertionPreservesBytesInFieldsSearchSecureFieldAndEditor() async throws {
        let fixture = try await InputFixture()
        defer { fixture.close() }
        let samples = [
            "日本語 か\u{3099}", "简体中文 汉语", "繁體中文 漢語", "cafe\u{301} français",
            "Tiếng Việt", "Кириллица И\u{306}", "Ελληνικά α\u{301}", "العَرَبِيَّة",
            "עִבְרִית", "हिन्दी क्\u{200d}ष क्\u{200c}ष", "ภาษาไทย กี่", "𠮷 👩🏽‍💻 ✈️"
        ]
        let singleLine = samples.joined(separator: " | ")
        let fields = fixture.descendants.compactMap { $0 as? NSTextField }.filter { $0.isEditable }
        XCTAssertEqual(fields.count, 4)
        for field in fields {
            fixture.window.makeFirstResponder(field)
            let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
            editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
            editor.insertText(singleLine, replacementRange: unspecifiedRange)
            try await fixture.refresh()
            fixture.window.makeFirstResponder(nil)
            XCTAssertEqual(Data(field.stringValue.utf8), Data(singleLine.utf8))
        }
        for stored in [fixture.state.field, fixture.state.roundedField, fixture.state.search, fixture.state.secret] {
            XCTAssertEqual(Data(stored.utf8), Data(singleLine.utf8))
        }

        let multiline = "\u{feff}" + samples.joined(separator: "\r\n") + "\r\n"
        let editor = try fixture.editor()
        fixture.window.makeFirstResponder(editor)
        editor.insertText(multiline, replacementRange: unspecifiedRange)
        try await fixture.refresh()
        XCTAssertEqual(Data(editor.string.utf8), Data(multiline.utf8))
        XCTAssertEqual(Data(fixture.state.editor.utf8), Data(multiline.utf8))
        for sample in samples {
            fixture.state.editor = sample
            try await fixture.refresh()
            XCTAssertEqual(Data(editor.string.utf8), Data(sample.utf8))
        }
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
        commitFixtureComposition(in: fixture.window)
        XCTAssertEqual(fixture.state.field, "한", "A save action must read the complete field immediately")
        XCTAssertFalse(fieldEditor.hasMarkedText())

        let editor = try fixture.editor()
        fixture.window.makeFirstResponder(editor)
        editor.setMarkedText("글", selectedRange: NSRange(location: 1, length: 0), replacementRange: unspecifiedRange)
        XCTAssertEqual(fixture.state.editor, "글")
        XCTAssertTrue(editor.hasMarkedText())
        commitFixtureComposition(in: fixture.window)
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

    @MainActor
    func testServerRefreshPreservesEachEditedDraftAndUpdatesUntouchedFields() throws {
        let draft = BridgeEditSession(target: "hosted", values: [.endpoint: "https://initial.local", .displayName: "초기 서버"])
        draft.receive([.endpoint: "https://server.local", .displayName: "서버"])
        XCTAssertEqual(draft.value(.endpoint), "https://server.local")
        draft.edit(.displayName, "한글로 바꾸는 중")
        draft.receive([.endpoint: "https://new.local", .displayName: "다른 이름"])
        XCTAssertEqual(draft.value(.endpoint), "https://new.local")
        XCTAssertEqual(draft.value(.displayName), "한글로 바꾸는 중")
        XCTAssertTrue(draft.hasConflicts)
        draft.resolveConflicts(keepingDraft: true)
        let submitted = try XCTUnwrap(draft.prepareSubmission())
        XCTAssertTrue(draft.acknowledge(submitted))
        draft.receive([.endpoint: "https://saved.local", .displayName: "저장된 이름"])
        XCTAssertEqual(draft.value(.displayName), "저장된 이름")
    }

    @MainActor
    func testFocusedFieldIsProtectedBeforeTheIMEPublishesItsDraft() async throws {
        let fixture = try await InputFixture()
        defer { fixture.close() }
        let draft = fixture.state.inputs
        draft.edit(.displayName, "초기 서버")
        let initial = try XCTUnwrap(draft.prepareSubmission())
        XCTAssertTrue(draft.acknowledge(initial))
        try await fixture.refresh()
        let field = try XCTUnwrap(fixture.descendants.compactMap { $0 as? NSTextField }.first { $0.placeholderString == "Rounded field" })
        XCTAssertTrue(fixture.window.makeFirstResponder(field))
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        draft.receive([.displayName: "외부 변경", .endpoint: "https://new.local"])
        XCTAssertEqual(draft.value(.displayName), "초기 서버")
        XCTAssertEqual(draft.value(.endpoint), "https://new.local")
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        editor.setMarkedText("한글", selectedRange: NSRange(location: 2, length: 0), replacementRange: unspecifiedRange)
        try await fixture.refresh()
        XCTAssertEqual(draft.value(.displayName), "한글")
        XCTAssertTrue(editor.hasMarkedText())
        XCTAssertNil(draft.prepareSubmission(), "Pending external value becomes an explicit conflict after confirmation")
        XCTAssertEqual(draft.value(.displayName), "한글")
        XCTAssertTrue(draft.hasConflicts)
    }

    @MainActor
    private func composeHangul(in editor: NSTextView, fixture: InputFixture) async throws {
        try await compose([["ㅎ", "하", "한"], ["ㄱ", "그", "글"], [" "], ["ㅇ", "이", "입"], ["ㄹ", "려", "력"]], in: editor, fixture: fixture)
    }

    @MainActor
    private func compose(_ groups: [[String]], in editor: NSTextView, fixture: InputFixture) async throws {
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        for group in groups {
            if group == [" "] { editor.insertText(" ", replacementRange: unspecifiedRange); continue }
            for stage in group {
                editor.setMarkedText(stage, selectedRange: NSRange(location: (stage as NSString).length, length: 0), replacementRange: unspecifiedRange)
                try await fixture.refresh()
                XCTAssertTrue(editor.hasMarkedText(), "Composition lost after \(stage)")
            }
            editor.insertText(try XCTUnwrap(group.last), replacementRange: unspecifiedRange)
            // Start the next group immediately, before SwiftUI's pending update.
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
    let inputs = BridgeEditSession(target: "native-fixture", values: [.name: "", .displayName: "", .content: "", .apiKey: ""])
    let searchInput = BridgeEditSession(target: "native-search", values: [.query: ""])
    var field: String { get { inputs.value(.name) } set { inputs.edit(.name, newValue) } }
    var roundedField: String { get { inputs.value(.displayName) } set { inputs.edit(.displayName, newValue) } }
    var editor: String { get { inputs.value(.content) } set { inputs.edit(.content, newValue) } }
    var search: String { get { searchInput.value(.query) } set { searchInput.edit(.query, newValue) } }
    var secret: String { get { inputs.value(.apiKey) } set { inputs.edit(.apiKey, newValue) } }
    @Published var tick = 0
}

private struct TextInputTestView: View {
    @ObservedObject var state: TextInputTestState
    var body: some View {
        NavigationSplitView {
            List { Text(state.search) }
        } detail: {
            VStack {
                TextField("Default field", text: state.inputs.binding(.name)).bridgeInput(state.inputs, field: .name)
                TextField("Rounded field", text: state.inputs.binding(.displayName)).textFieldStyle(.roundedBorder).bridgeInput(state.inputs, field: .displayName)
                SecureField("Synthetic secret", text: state.inputs.binding(.apiKey)).bridgeInput(state.inputs, field: .apiKey)
                BridgeTextEditor(text: state.inputs.binding(.content)).bridgeInput(state.inputs, field: .content)
                Text("\(state.tick)")
            }.padding()
        }.searchable(text: state.searchInput.binding(.query), placement: .sidebar).bridgeSearchInput(state.searchInput)
    }
}

@MainActor
private func commitFixtureComposition(in window: NSWindow) {
    guard let editor = window.firstResponder as? NSTextView, editor.hasMarkedText() else { return }
    editor.unmarkText(); editor.inputContext?.discardMarkedText(); editor.didChangeText()
}
