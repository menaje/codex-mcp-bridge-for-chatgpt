import AppKit
import SwiftUI
import XCTest
@testable import CodexBridgeMenuBar

final class EditSessionTests: XCTestCase {
    @MainActor
    func testUndoToOriginalValueAfterSubmissionSurvivesSuccessAndFailureRefresh() throws {
        let session = BridgeEditSession(target: "A", values: [.content: "9"], version: "v9")
        session.edit(.content, "10")
        let ten = try XCTUnwrap(session.prepareSubmission())
        session.edit(.content, "9")
        XCTAssertFalse(session.isDirty, "Undo matches the old baseline before acknowledgement")
        XCTAssertFalse(session.acknowledge(ten, version: "v10"))
        XCTAssertEqual(session.value(.content), "9")
        XCTAssertTrue(session.isDirty, "The response saved 10, so the newer undo to 9 must stay unsaved")
        let nine = try XCTUnwrap(session.prepareSubmission())
        session.edit(.content, "10")
        XCTAssertFalse(session.isDirty)
        session.fail(nine)
        session.receive([.content: "11"], version: "v11")
        XCTAssertEqual(session.value(.content), "10")
        XCTAssertEqual(session.baseVersion, "v10")
        XCTAssertTrue(session.hasConflicts)
        XCTAssertTrue(session.hasUnsavedChanges)
        session.resolveConflicts(keepingDraft: true)
        XCTAssertEqual(try XCTUnwrap(session.prepareSubmission()).value(.content), "10")
    }
    @MainActor
    func testCreationReceiptPinsActualTargetAndVersionWithoutClosingOverNewerInput() async throws {
        let session = BridgeEditSession(target: "new-document", values: [.name: "", .description: ""])
        session.edit(.name, "created")
        let started = expectation(description: "creation started")
        var continuation: CheckedContinuation<BridgeEditReceipt?, Never>?
        var isCurrent: (@MainActor () -> Bool)?
        var closed = false
        session.submitReceipt(operation: { submitted, guardUI in
            XCTAssertEqual(submitted.targetID, "new-document")
            XCTAssertNil(submitted.expectedVersion)
            isCurrent = guardUI
            return await withCheckedContinuation { pending in
                continuation = pending
                started.fulfill()
            }
        }, onClean: { closed = true })
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(try XCTUnwrap(isCurrent)())
        session.edit(.name, "edited during creation")
        XCTAssertFalse(try XCTUnwrap(isCurrent)(), "Feature-specific navigation must not hide newer input")
        try XCTUnwrap(continuation).resume(returning: BridgeEditReceipt(
            version: "7", target: "created-document", confirmed: [.description: "server description"]
        ))
        for _ in 0..<50 where session.isSubmitting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(session.isSubmitting)
        XCTAssertFalse(closed)
        XCTAssertEqual(session.targetID, "created-document")
        XCTAssertEqual(session.baseVersion, "7")
        XCTAssertEqual(session.value(.name), "edited during creation")
        XCTAssertEqual(session.value(.description), "server description")
        XCTAssertTrue(session.isDirty)
        let update = try XCTUnwrap(session.prepareSubmission(requireChanges: true))
        XCTAssertEqual(update.targetID, "created-document", "A second save updates the created resource")
        XCTAssertEqual(update.expectedVersion, "7")
        session.fail(update)
    }

    @MainActor
    func testCreationResponseCannotRetargetAReopenedForm() async throws {
        let session = BridgeEditSession(target: "new-document", values: [.content: "first"])
        let started = expectation(description: "first creation started")
        var continuation: CheckedContinuation<BridgeEditReceipt?, Never>?
        var isCurrent: (@MainActor () -> Bool)?
        var closed = false
        session.submitReceipt(operation: { _, guardUI in
            isCurrent = guardUI
            return await withCheckedContinuation { pending in continuation = pending; started.fulfill() }
        }, onClean: { closed = true })
        await fulfillment(of: [started], timeout: 2)
        session.discard()
        session.reset(target: "another-document", values: [.content: "another base"], version: "12")
        session.edit(.content, "another draft")
        XCTAssertFalse(try XCTUnwrap(isCurrent)())
        try XCTUnwrap(continuation).resume(returning: BridgeEditReceipt(version: "1", target: "first-created"))
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(closed)
        XCTAssertEqual(session.targetID, "another-document")
        XCTAssertEqual(session.baseVersion, "12")
        XCTAssertEqual(session.value(.content), "another draft")
        XCTAssertTrue(session.isDirty)
    }

    @MainActor
    func testSubmittedRevisionAcknowledgesOnlyItselfAndUsesNextServerVersion() throws {
        let session = BridgeEditSession(target: "A", values: [.content: "9"], version: "v9")
        session.edit(.content, "10")
        let ten = try XCTUnwrap(session.prepareSubmission(requireChanges: true))
        session.edit(.content, "11")
        XCTAssertFalse(session.acknowledge(ten, version: "v10"))
        XCTAssertEqual(session.value(.content), "11")
        XCTAssertTrue(session.isDirty)
        let eleven = try XCTUnwrap(session.prepareSubmission(requireChanges: true))
        XCTAssertEqual(eleven.expectedVersion, "v10")
        XCTAssertEqual(eleven.value(.content), "11")
        XCTAssertTrue(session.acknowledge(eleven, version: "v11"))
    }

    @MainActor
    func testOldResponseCannotAcknowledgeAnotherTargetOrReopenedSession() throws {
        let session = BridgeEditSession(target: "A", values: [.content: "base"])
        let oldBinding = session.binding(.content)
        session.edit(.content, "submitted")
        let request = try XCTUnwrap(session.prepareSubmission())
        session.reset(target: "B", values: [.content: "B"])
        session.edit(.content, "B draft")
        oldBinding.wrappedValue = "delayed native callback from A"
        XCTAssertFalse(session.acknowledge(request))
        XCTAssertEqual(session.value(.content), "B draft")
        session.reset(target: "A", values: [.content: "reopened"])
        XCTAssertFalse(session.acknowledge(request))
        XCTAssertEqual(session.value(.content), "reopened")
    }

    @MainActor
    func testByteChangeEventsAndSemanticDirtyAreDifferentAndUndoClearsDirty() throws {
        let original = "\u{feff}  café\r\n\r\n"
        let session = BridgeEditSession(target: "document", values: [.content: original, .name: "café"])
        session.binding(.content).wrappedValue = original.decomposedStringWithCanonicalMapping
        XCTAssertTrue(session.isDirty)
        XCTAssertEqual(session.revision, 1)
        let submitted = try XCTUnwrap(session.prepareSubmission())
        XCTAssertEqual(Data(submitted.value(.content).utf8), Data(original.decomposedStringWithCanonicalMapping.utf8))
        session.fail(submitted)
        session.binding(.content).wrappedValue = original
        XCTAssertFalse(session.isDirty)
        session.binding(.name).wrappedValue = "  cafe\u{301}  "
        XCTAssertEqual(session.revision, 3)
        XCTAssertFalse(session.isDirty)
        for suffix in ["", "\n", "\r\n", " "] {
            session.edit(.content, "\u{feff}é" + suffix)
            let snapshot = try XCTUnwrap(session.prepareSubmission())
            XCTAssertEqual(Data(snapshot.value(.content).utf8), Data(("\u{feff}é" + suffix).utf8))
            session.fail(snapshot)
        }
    }

    @MainActor
    func testExternalUpdatesArePerFieldAndRequireExplicitConflictResolution() throws {
        let session = BridgeEditSession(target: "server", values: [.name: "A", .endpoint: "old"], version: "1")
        session.edit(.name, "my name")
        session.receive([.name: "A", .endpoint: "new"], version: "2")
        XCTAssertEqual(session.value(.endpoint), "new")
        XCTAssertEqual(session.value(.name), "my name")
        XCTAssertFalse(session.hasConflicts)
        session.receive([.name: "their name", .endpoint: "newer"], version: "3")
        XCTAssertTrue(session.hasConflicts)
        XCTAssertEqual(session.baseVersion, "2")
        XCTAssertNil(session.prepareSubmission())
        session.resolveConflicts(keepingDraft: true)
        let request = try XCTUnwrap(session.prepareSubmission())
        XCTAssertEqual(request.expectedVersion, "3")
        XCTAssertEqual(request.value(.name), "my name")
        session.fail(request)
        session.receive([.name: "another name"], version: "4")
        session.resolveConflicts(keepingDraft: false)
        XCTAssertEqual(session.value(.name), "another name")
        XCTAssertFalse(session.isDirty)
    }

    @MainActor
    func testFailurePreservesDraftAndDoesNotRebaseAConflict() throws {
        let session = BridgeEditSession(target: "A", values: [.content: "base"], version: "1")
        session.edit(.content, "my draft")
        let request = try XCTUnwrap(session.prepareSubmission())
        session.receive([.content: "external"], version: "2")
        session.fail(request)
        XCTAssertEqual(session.value(.content), "my draft")
        XCTAssertEqual(session.baseVersion, "1")
        XCTAssertTrue(session.hasConflicts)
        XCTAssertNil(session.prepareSubmission())
    }

    @MainActor
    func testUnversionedLateExternalValueIsNotMistakenForOurReceipt() throws {
        let session = BridgeEditSession(target: "server", values: [.name: "old"])
        session.edit(.name, "sent")
        let request = try XCTUnwrap(session.prepareSubmission())
        session.receive([.name: "external"])
        session.edit(.name, "new local")
        XCTAssertFalse(session.acknowledge(request))
        XCTAssertEqual(session.value(.name), "new local")
        XCTAssertTrue(session.hasConflicts)
    }

    @MainActor
    func testNumericIncompleteAndInvalidValuesAreRetainedWithoutZeroCoercion() throws {
        let session = BridgeEditSession(target: "number", values: [.number: "4"], policies: [.number: .integer(1...12)])
        for value in ["", "-", "1e", "13", "0"] {
            session.edit(.number, value)
            XCTAssertNil(session.prepareSubmission())
            XCTAssertEqual(session.value(.number), value)
        }
        session.edit(.number, "١٢")
        XCTAssertEqual(try XCTUnwrap(session.prepareSubmission()).value(.number), "12")
    }

    @MainActor
    func testSecretDiagnosticsAreRedactedAndOnlyTheSubmittedSecretIsCleared() throws {
        let secret = "synthetic-秘密-비밀"
        let session = BridgeEditSession(target: "auth", values: [.apiKey: ""])
        session.edit(.apiKey, secret)
        let request = try XCTUnwrap(session.prepareSubmission())
        var diagnostics = "\(session) \(request) \(String(reflecting: request))"
        dump(session, to: &diagnostics); dump(request, to: &diagnostics)
        let receipt = BridgeEditReceipt(confirmed: [.apiKey: secret])
        diagnostics += "\(receipt) \(String(reflecting: receipt))"
        dump(receipt, to: &diagnostics)
        XCTAssertFalse(diagnostics.contains(secret))
        session.edit(.apiKey, "new synthetic secret")
        XCTAssertFalse(session.acknowledge(request))
        XCTAssertEqual(session.value(.apiKey), "new synthetic secret")
        session.discard()
        XCTAssertEqual(session.value(.apiKey), "")
    }

    @MainActor
    func testServerVersionConflictRequiresFreshSnapshotAndExplicitReviewEvenWithoutFieldConflict() throws {
        let session = BridgeEditSession(target: "A", values: [.content: "base"], version: "1")
        session.edit(.content, "draft")
        let submitted = try XCTUnwrap(session.prepareSubmission())
        session.fail(submitted, conflict: true)
        XCTAssertTrue(session.hasConflicts)
        XCTAssertFalse(session.canResolveConflicts)
        session.resolveConflicts(keepingDraft: true)
        XCTAssertNil(session.prepareSubmission())
        session.receive([.content: "base"], version: "2")
        XCTAssertEqual(session.baseVersion, "1", "Do not silently retry against a new server version")
        XCTAssertTrue(session.canResolveConflicts)
        session.resolveConflicts(keepingDraft: true)
        let retry = try XCTUnwrap(session.prepareSubmission())
        XCTAssertEqual(retry.expectedVersion, "2")
        XCTAssertEqual(retry.value(.content), "draft")
        session.fail(retry, conflict: true)
        session.receive([.content: "base"], version: "3")
        session.resolveConflicts(keepingDraft: false)
        XCTAssertEqual(session.value(.content), "base")
        XCTAssertFalse(session.isDirty)
    }

    @MainActor
    func testVersionOnlyRefreshCannotRebaseAPendingOrFailedSubmission() throws {
        let session = BridgeEditSession(target: "A", values: [.content: "base"], version: "1")
        session.edit(.content, "draft")
        let submitted = try XCTUnwrap(session.prepareSubmission())
        session.receive([:], version: "2")
        XCTAssertEqual(session.baseVersion, "1")
        session.fail(submitted, conflict: true)
        XCTAssertEqual(session.baseVersion, "1")
        XCTAssertTrue(session.canResolveConflicts, "A fresh snapshot arrived after the submission")
        XCTAssertNil(session.prepareSubmission())
        session.resolveConflicts(keepingDraft: true)
        XCTAssertEqual(try XCTUnwrap(session.prepareSubmission()).expectedVersion, "2")
    }

    @MainActor
    func testMountedAmbiguousInputBlocksSubmissionWithoutLosingDraft() throws {
        _ = NSApplication.shared
        let session = BridgeEditSession(target: "A", values: [.name: "base"])
        session.edit(.name, "draft")
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let root = NSView(); window.contentView = root
        let owner = BridgeNativeInputOwner(session: session, field: .name)
        owner.connect(root: root, session: session)
        defer { owner.disconnect(); window.close() }
        XCTAssertNil(session.prepareSubmission())
        XCTAssertEqual(session.value(.name), "draft")
        XCTAssertTrue(session.hasUnsavedChanges)
        XCTAssertFalse(session.isSubmitting)
    }

    @MainActor
    func testNativeOwnershipIgnoresReadOnlyLabelsAndKeepsTheDocumentWithFindBarOpen() async throws {
        _ = NSApplication.shared
        let session = BridgeEditSession(target: "A", values: [.name: "base", .content: "document"])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.contentView = nil; window.close() }
        let root = NSView(frame: window.contentRect(forFrameRect: window.frame))
        let label = NSTextField(labelWithString: "Read-only label")
        let field = NSTextField(string: "base")
        root.addSubview(label); root.addSubview(field); window.contentView = root
        let owner = BridgeNativeInputOwner(session: session, field: .name)
        owner.connect(root: root, session: session)
        let fieldRequest = try XCTUnwrap(session.prepareSubmission(), "Read-only labels are not additional inputs")
        session.fail(fieldRequest)
        owner.disconnect()

        window.contentView = NSHostingView(rootView: BridgeTextEditor(text: session.binding(.content)).bridgeInput(session, field: .content))
        func settle() async throws {
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
        }
        for _ in 0..<5 { try await settle() }
        func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        let editor = try XCTUnwrap(window.contentView.map(descendants)?.compactMap { $0 as? NSTextView }.first { !$0.isFieldEditor && $0.isEditable })
        XCTAssertTrue(window.makeFirstResponder(editor))
        let command = NSMenuItem(); command.tag = Int(NSFindPanelAction.showFindPanel.rawValue)
        editor.performFindPanelAction(command)
        for _ in 0..<5 { try await settle() }
        let scroll = try XCTUnwrap(editor.enclosingScrollView)
        XCTAssertTrue(scroll.isFindBarVisible)
        let findView = try XCTUnwrap(scroll.findBarView)
        let findField = try XCTUnwrap(descendants(findView).compactMap { $0 as? NSTextField }.first { $0.isEditable })
        XCTAssertTrue(window.makeFirstResponder(findField))
        let findEditor = try XCTUnwrap(findField.currentEditor() as? NSTextView)
        findEditor.setMarkedText("찾기", selectedRange: .init(location: 2, length: 0), replacementRange: .init(location: NSNotFound, length: 0))
        let searchSession = BridgeEditSession(target: "sidebar", values: [.query: "sidebar query"])
        let sidebar = NSSearchField(string: "sidebar query")
        try XCTUnwrap(window.contentView).addSubview(sidebar)
        let searchOwner = BridgeNativeInputOwner(session: searchSession, field: .query, search: true)
        searchOwner.connect(root: try XCTUnwrap(window.contentView), session: searchSession)
        defer { searchOwner.disconnect() }
        let searchRequest = try XCTUnwrap(searchSession.prepareSubmission())
        XCTAssertEqual(searchRequest.value(.query), "sidebar query")
        searchSession.fail(searchRequest)
        let documentRequest = try XCTUnwrap(session.prepareSubmission(), "Native Find inputs must not make the document owner ambiguous")
        XCTAssertEqual(documentRequest.value(.content), "document")
        XCTAssertTrue(findEditor.hasMarkedText(), "Document and sidebar saves do not commit the system Find query")
        session.fail(documentRequest)
    }

    @MainActor
    func testNewSessionIdentityDoesNotImportThePreviousTargetsMarkedBuffer() async throws {
        _ = NSApplication.shared
        let session = BridgeEditSession(target: "A", values: [.name: ""])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: IdentityInputFixture(session: session))
        defer { window.contentView = nil; window.close() }
        func settle() async throws {
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
        }
        for _ in 0..<5 { try await settle() }
        func fields(_ view: NSView) -> [NSTextField] {
            view.subviews.flatMap { child in (child as? NSTextField).map { [$0] } ?? fields(child) }
        }
        let field = try XCTUnwrap(fields(try XCTUnwrap(window.contentView)).first)
        XCTAssertTrue(window.makeFirstResponder(field))
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        editor.setMarkedText("이전", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        try await settle()
        XCTAssertTrue(session.hasMarkedText)
        // Target changes are a new identity after the caller's navigation decision.
        session.reset(target: "B", values: [.name: "B baseline", .description: "description baseline"])
        for _ in 0..<5 { try await settle() }
        XCTAssertTrue(session.observeInputs())
        XCTAssertFalse(session.hasMarkedText)
        XCTAssertEqual(session.value(.name), "B baseline")
        XCTAssertFalse(session.isDirty)
        XCTAssertEqual(try XCTUnwrap(fields(try XCTUnwrap(window.contentView)).first).stringValue, "B baseline")
        let currentField = try XCTUnwrap(fields(try XCTUnwrap(window.contentView)).first)
        XCTAssertTrue(window.makeFirstResponder(currentField))
        let currentEditor = try XCTUnwrap(currentField.currentEditor() as? NSTextView)
        currentEditor.setSelectedRange(NSRange(location: 0, length: (currentEditor.string as NSString).length))
        currentEditor.setMarkedText("B draft", selectedRange: .init(location: 7, length: 0), replacementRange: .init(location: NSNotFound, length: 0))
        try await settle()
        session.edit(.path, "description")
        for _ in 0..<5 { try await settle() }
        XCTAssertTrue(session.observeInputs())
        XCTAssertEqual(session.value(.name), "B draft")
        XCTAssertEqual(session.value(.description), "description baseline", "Reusing a view for another field must reconnect its owner")
    }

    @MainActor
    func testScopedNativeCompositionAndSharedFieldEditorDoNotCommitAnotherForm() async throws {
        _ = NSApplication.shared
        let a = BridgeEditSession(target: "A", values: [.name: ""])
        let scope = BridgeEditScope()
        let b = BridgeEditSession(target: "B", values: [.name: ""])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: VStack {
            TextField("A", text: a.binding(.name)).bridgeInput(a, field: .name)
            TextField("B", text: b.binding(.name)).bridgeInput(b, field: .name)
        }.environment(\.bridgeEditScope, scope))
        defer { window.contentView = nil; window.close() }
        func settle() async throws {
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
        }
        for _ in 0..<8 { try await settle() }
        func fields(_ view: NSView) -> [NSTextField] {
            view.subviews.flatMap { child in (child as? NSTextField).map { [$0] } ?? fields(child) }
        }
        let controls = try XCTUnwrap(window.contentView).subviews.flatMap(fields)
        let field = try XCTUnwrap(controls.first { $0.placeholderString == "A" })
        XCTAssertTrue(window.makeFirstResponder(field))
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        editor.setMarkedText("한", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        try await settle()
        XCTAssertTrue(a.canSubmit, "Marked input must enable entry before SwiftUI publishes it")
        XCTAssertNil(a.prepareSubmission(returnKey: true), "Candidate Enter must not submit the form")
        XCTAssertTrue(editor.hasMarkedText())
        let originalID = a.id
        XCTAssertFalse(scope.confirmDiscardIfNeeded { false })
        XCTAssertEqual(a.id, originalID)
        XCTAssertEqual(a.value(.name), "한")
        XCTAssertTrue(editor.hasMarkedText(), "Cancelling navigation preserves preedit")
        let other = try XCTUnwrap(b.prepareSubmission())
        XCTAssertTrue(editor.hasMarkedText(), "B must not commit A's shared field editor")
        b.fail(other)
        let submitted = try XCTUnwrap(a.prepareSubmission(requireChanges: true))
        XCTAssertEqual(submitted.value(.name), "한")
        XCTAssertFalse(editor.hasMarkedText())
        XCTAssertEqual(b.value(.name), "")
        a.fail(submitted)
        XCTAssertTrue(scope.confirmDiscardIfNeeded { true })
        XCTAssertEqual(a.value(.name), "")
        XCTAssertNotEqual(a.id, originalID)
        XCTAssertFalse(a.accepts(submitted))
    }
}

private struct IdentityInputFixture: View {
    @ObservedObject var session: BridgeEditSession
    var body: some View {
        let field: BridgeEditField = session.value(.path) == "description" ? .description : .name
        TextField("Name", text: session.binding(field)).bridgeInput(session, field: field)
    }
}
