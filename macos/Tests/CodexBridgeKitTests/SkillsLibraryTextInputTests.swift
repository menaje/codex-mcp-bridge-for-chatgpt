import AppKit
import CodexBridgeKit
import SwiftUI
import XCTest
@testable import CodexBridgeMenuBar

final class SkillsLibraryTextInputTests: XCTestCase {
    @MainActor
    func testCanonicallyEquivalentDocumentEditIsDirtyAndSavesExactBytes() async throws {
        _ = NSApplication.shared
        let original = "# café が Й ά 각\r\n"
        let edited = original.decomposedStringWithCanonicalMapping
        XCTAssertEqual(original, edited, "Swift equality alone cannot detect this edit")
        XCTAssertNotEqual(Data(original.utf8), Data(edited.utf8))

        let root = URL(fileURLWithPath: "/tmp/cb-skill-text-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let responses = SkillTextResponses(content: original)
        let bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method, params in responses.reply(method, params) }
        let model = AppModel(paths: paths)
        model.helperStatus = try JSONDecoder().decode(HelperStatus.self, from: Data(#"""
        {"kind":"helper-status","generatedAt":"2026-10-04T00:00:00Z","phase":"running","restartAttempt":0,
         "configuration":{"path":"fixture","exists":true,"valid":true,"hasApiKey":true,"hasTunnelId":true},
         "bridge":{"socketPath":"fixture","connected":true},
         "tunnel":{"phase":"connected","doctorPassed":true,"processRunning":true,"connected":true}}
        """#.utf8))
        let state = SkillsLibraryWindowState()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 720),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: SkillsLibraryWindowView().environmentObject(model).environmentObject(state))
        defer {
            window.contentView = nil
            window.close()
            model.cancelAllPolling()
            bridge.stop()
            try? FileManager.default.removeItem(at: root)
        }
        func settle() async throws {
            for _ in 0..<8 {
                window.contentView?.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(15))
            }
        }
        try await settle()
        await model.loadBridgeSkill(.init(skillId: "bridge_text_fixture", version: "1"))
        try await settle()
        XCTAssertNil(model.skillLibraryErrorMessage)
        NotificationCenter.default.post(name: .bridgeSkillCommandToggleEdit, object: nil)
        try await settle()
        func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        let editor = try XCTUnwrap(window.contentView.map(descendants)?.compactMap { $0 as? NSTextView }.first { $0.isEditable && !$0.isFieldEditor })
        XCTAssertEqual(Data(editor.string.utf8), Data(original.utf8))
        XCTAssertFalse(state.hasUnsavedChanges)
        window.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        editor.insertText(edited, replacementRange: NSRange(location: NSNotFound, length: 0))
        try await settle()
        XCTAssertTrue(state.hasUnsavedChanges, "Byte-distinct Markdown must enable saving and discard protection")
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        editor.insertText(original, replacementRange: NSRange(location: NSNotFound, length: 0))
        try await settle()
        XCTAssertFalse(state.hasUnsavedChanges, "Restoring the original bytes must clear dirty state")
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        editor.insertText(edited, replacementRange: NSRange(location: NSNotFound, length: 0))
        try await settle()
        XCTAssertTrue(state.hasUnsavedChanges)
        NotificationCenter.default.post(name: .bridgeSkillCommandSave, object: nil)
        for _ in 0..<50 {
            if bridge.count("skills.update") > 0 && !model.skillMutationInProgress && model.selectedBridgeSkill?.skill.version == "2" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(bridge.count("skills.update"), 1)
        XCTAssertNil(model.skillMutationErrorMessage)
        XCTAssertEqual(Data(responses.content.utf8), Data(edited.utf8))
        let saved = try XCTUnwrap(model.selectedBridgeSkill)
        XCTAssertEqual(Data(saved.content.utf8), Data(edited.utf8))
        XCTAssertFalse(state.hasUnsavedChanges)
    }
    @MainActor
    func testSavingMarkedInputKeepsNewerCompositionAndUsesAcknowledgedVersionForNextSave() async throws {
        let fixture = try await SkillTextFixture(content: "9", delay: 0.5)
        defer { fixture.close() }
        let editor = try await fixture.openEditor()
        editor.setSelectedRange(NSRange(location: 0, length: 1))
        editor.setMarkedText("10", selectedRange: NSRange(location: 2, length: 0), replacementRange: .init(location: NSNotFound, length: 0))
        try await fixture.settle()
        XCTAssertTrue(fixture.state.hasUnsavedChanges)
        NotificationCenter.default.post(name: .bridgeSkillCommandSave, object: nil)
        try await fixture.waitForUpdateStart()
        XCTAssertEqual(fixture.responses.content, "10", "Save includes the final preedit")
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        editor.setMarkedText("11", selectedRange: NSRange(location: 2, length: 0), replacementRange: .init(location: NSNotFound, length: 0))
        try await fixture.waitForSaveCompletion()
        XCTAssertEqual(editor.string, "11")
        XCTAssertTrue(editor.hasMarkedText())
        XCTAssertTrue(fixture.state.hasUnsavedChanges)
        XCTAssertEqual(fixture.model.selectedBridgeSkill?.content, "10")
        NotificationCenter.default.post(name: .bridgeSkillCommandSave, object: nil)
        try await fixture.waitForSaveCompletion(expectedVersion: "3")
        XCTAssertEqual(fixture.responses.content, "11")
        XCTAssertEqual(fixture.responses.expectedVersions, ["1", "2"])
        XCTAssertFalse(fixture.state.hasUnsavedChanges)
    }

    @MainActor
    func testLateSaveAfterMovingToAnotherDocumentDoesNotSelectOrCleanThatDocument() async throws {
        let fixture = try await SkillTextFixture(content: "A", delay: 0.5)
        defer { fixture.close() }
        let editor = try await fixture.openEditor()
        editor.setSelectedRange(NSRange(location: 0, length: 1))
        editor.insertText("A sent", replacementRange: NSRange(location: NSNotFound, length: 0))
        NotificationCenter.default.post(name: .bridgeSkillCommandSave, object: nil)
        try await fixture.waitForUpdateStart()
        XCTAssertTrue(fixture.state.confirmDiscardIfNeeded { true })
        await fixture.model.loadBridgeSkill(.init(skillId: "bridge_other_fixture", version: "1"))
        try await fixture.settle()
        let current = try XCTUnwrap(fixture.state.editSession)
        current.edit(.content, "B draft")
        try await fixture.waitForSaveCompletion()
        XCTAssertEqual(fixture.model.selectedBridgeSkill?.skill.skillId, "bridge_other_fixture")
        XCTAssertEqual(current.value(.content), "B draft")
        XCTAssertTrue(current.hasUnsavedChanges)
    }

    @MainActor
    func testServerConflictPreservesMountedDraftAndRequiresExplicitResolution() async throws {
        let fixture = try await SkillTextFixture(content: "base")
        defer { fixture.close() }
        let editor = try await fixture.openEditor()
        editor.setSelectedRange(NSRange(location: 0, length: 4))
        editor.insertText("my draft", replacementRange: NSRange(location: NSNotFound, length: 0))
        fixture.responses.externalChange("external")
        NotificationCenter.default.post(name: .bridgeSkillCommandSave, object: nil)
        for _ in 0..<80 {
            if fixture.state.editSession?.canResolveConflicts == true { break }
            try await Task.sleep(for: .milliseconds(15))
        }
        let session = try XCTUnwrap(fixture.state.editSession)
        XCTAssertTrue(session.hasConflicts)
        XCTAssertEqual(session.baseVersion, "1")
        XCTAssertEqual(session.value(.content), "my draft")
        XCTAssertEqual(editor.string, "my draft")
        XCTAssertNil(session.prepareSubmission())
        session.resolveConflicts(keepingDraft: true)
        NotificationCenter.default.post(name: .bridgeSkillCommandSave, object: nil)
        try await fixture.waitForSaveCompletion(expectedVersion: "3")
        XCTAssertEqual(fixture.responses.content, "my draft")
        XCTAssertEqual(fixture.responses.expectedVersions, ["1", "2"])
        XCTAssertFalse(session.hasUnsavedChanges)
    }

    @MainActor
    func testFeatureReloadRechecksDraftAfterItsAsynchronousRead() async throws {
        let fixture = try await SkillTextFixture(content: "base", readDelay: 0.3)
        defer { fixture.close() }
        let editor = try await fixture.openEditor()
        let session = try XCTUnwrap(fixture.state.editSession)
        session.edit(.content, "sent")
        let submitted = try XCTUnwrap(session.prepareSubmission())
        let readsBeforeSave = fixture.bridge.count("skills.read")
        let saving = Task { @MainActor in
            await fixture.model.submitBridgeSkillUpdate(.init(skillId: "bridge_text_fixture", expectedVersion: "1", content: submitted.value(.content)), shouldSelect: {
                session.accepts(submitted) && session.observeInputs() && session.revision == submitted.revision
            })
        }
        for _ in 0..<100 {
            if fixture.bridge.count("skills.read") > readsBeforeSave { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertGreaterThan(fixture.bridge.count("skills.read"), readsBeforeSave)
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        editor.setMarkedText("newer", selectedRange: .init(location: 5, length: 0), replacementRange: .init(location: NSNotFound, length: 0))
        let result = await saving.value
        let receipt = try XCTUnwrap(result)
        XCTAssertEqual(receipt.version, "2")
        XCTAssertEqual(fixture.model.selectedBridgeSkill?.skill.version, "1", "The guarded feature reload must not publish after newer input")
        XCTAssertFalse(session.acknowledge(submitted, version: receipt.version))
        XCTAssertEqual(session.value(.content), "newer")
        XCTAssertTrue(editor.hasMarkedText())
        XCTAssertTrue(session.isDirty)
    }

}

@MainActor
private final class SkillTextFixture {
    let root: URL
    let responses: SkillTextResponses
    let bridge: NativeRPCFixture
    let model: AppModel
    let state = SkillsLibraryWindowState()
    let window: NSWindow

    init(content: String, delay: TimeInterval = 0, readDelay: TimeInterval = 0) async throws {
        _ = NSApplication.shared
        root = URL(fileURLWithPath: "/tmp/cb-edit-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        responses = SkillTextResponses(content: content, delay: delay, readDelay: readDelay)
        let replies = responses
        bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method, params in replies.reply(method, params) }
        model = AppModel(paths: paths)
        model.helperStatus = try JSONDecoder().decode(HelperStatus.self, from: Data(#"""
        {"kind":"helper-status","generatedAt":"2026-10-04T00:00:00Z","phase":"running","restartAttempt":0,
         "configuration":{"path":"fixture","exists":true,"valid":true,"hasApiKey":true,"hasTunnelId":true},
         "bridge":{"socketPath":"fixture","connected":true},
         "tunnel":{"phase":"connected","doctorPassed":true,"processRunning":true,"connected":true}}
        """#.utf8))
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 720), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: SkillsLibraryWindowView().environmentObject(model).environmentObject(state))
        try await settle()
    }
    func settle() async throws {
        for _ in 0..<8 { window.contentView?.layoutSubtreeIfNeeded(); try await Task.sleep(for: .milliseconds(15)) }
    }
    func openEditor() async throws -> NSTextView {
        await model.loadBridgeSkill(.init(skillId: "bridge_text_fixture", version: "1"))
        try await settle()
        NotificationCenter.default.post(name: .bridgeSkillCommandToggleEdit, object: nil)
        try await settle()
        func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        let editor = try XCTUnwrap(window.contentView.map(descendants)?.compactMap { $0 as? NSTextView }.first { $0.isEditable && !$0.isFieldEditor })
        XCTAssertTrue(window.makeFirstResponder(editor))
        return editor
    }
    func waitForUpdateStart() async throws {
        for _ in 0..<80 {
            if bridge.count("skills.update") > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertGreaterThan(bridge.count("skills.update"), 0)
        XCTAssertTrue(model.skillMutationInProgress)
    }
    func waitForSaveCompletion(expectedVersion: String? = nil) async throws {
        for _ in 0..<150 {
            if bridge.count("skills.update") > 0 && !model.skillMutationInProgress &&
                (expectedVersion == nil || model.selectedBridgeSkill?.skill.version == expectedVersion) { break }
            try await Task.sleep(for: .milliseconds(15))
        }
        try await settle()
        XCTAssertFalse(model.skillMutationInProgress)
    }
    func close() {
        window.contentView = nil; window.close(); model.cancelAllPolling(); bridge.stop()
        try? FileManager.default.removeItem(at: root)
    }
}

private final class SkillTextResponses: @unchecked Sendable {
    private let lock = NSLock()
    private var storedContent: String
    private var version = 1
    private var requests: [String] = []
    private let delay: TimeInterval
    private let readDelay: TimeInterval
    init(content: String, delay: TimeInterval = 0, readDelay: TimeInterval = 0) {
        storedContent = content; self.delay = delay; self.readDelay = readDelay
    }
    var content: String { lock.withLock { storedContent } }
    var expectedVersions: [String] { lock.withLock { requests } }
    func externalChange(_ content: String) { lock.withLock { storedContent = content; version += 1 } }

    func reply(_ method: String, _ params: String) -> NativeFixtureReply {
        lock.withLock {
            let request = (try? JSONSerialization.jsonObject(with: Data(params.utf8)) as? [String: Any]) ?? [:]
            if method == "skills.update", let next = request["content"] as? String {
                let expected = request["expectedVersion"] as? String ?? ""
                requests.append(expected)
                guard expected == String(version) else {
                    return NativeFixtureReply(body: #"{"error":{"code":-32000,"message":"SKILL_VERSION_CHANGED"}}"#, delay: delay)
                }
                storedContent = next; version += 1
            }
            let other = request["skillId"] as? String == "bridge_other_fixture"
            let summary: [String: Any] = [
                "skillId": other ? "bridge_other_fixture" : "bridge_text_fixture", "source": "bridge", "version": other ? "1" : String(version),
                "name": "Multilingual fixture", "description": "", "enabled": true, "availability": "available"
            ]
            let result: Any
            switch method {
            case "skills.snapshot": result = ["skills": [summary]]
            case "skills.read": result = [
                "skill": summary, "content": other ? "B base" : storedContent, "files": [], "format": "markdown",
                "legacy": false, "sourceSnapshot": "versioned-bridge-record", "warnings": []
            ]
            case "skills.versions": result = [
                "skillId": summary["skillId"]!, "source": "bridge", "currentVersion": summary["version"]!,
                "enabled": true, "versions": []
            ]
            case "skills.update": result = summary
            default: return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"Unsupported fixture method"}}"#)
            }
            let data = try! JSONSerialization.data(withJSONObject: ["result": result])
            return NativeFixtureReply(body: String(decoding: data, as: UTF8.self), delay: method == "skills.update" ? delay : method == "skills.read" ? readDelay : 0)
        }
    }
}
