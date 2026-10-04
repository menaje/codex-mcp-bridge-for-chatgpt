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
            if bridge.count("skills.update") > 0 && !model.skillMutationInProgress { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(bridge.count("skills.update"), 1)
        XCTAssertNil(model.skillMutationErrorMessage)
        XCTAssertEqual(Data(responses.content.utf8), Data(edited.utf8))
        let saved = try XCTUnwrap(model.selectedBridgeSkill)
        XCTAssertEqual(Data(saved.content.utf8), Data(edited.utf8))
        XCTAssertFalse(state.hasUnsavedChanges)
    }
}

private final class SkillTextResponses: @unchecked Sendable {
    private let lock = NSLock()
    private var storedContent: String
    private var version = 1

    init(content: String) { storedContent = content }
    var content: String { lock.withLock { storedContent } }

    func reply(_ method: String, _ params: String) -> NativeFixtureReply {
        lock.withLock {
            if method == "skills.update",
               let request = try? JSONSerialization.jsonObject(with: Data(params.utf8)) as? [String: Any],
               let next = request["content"] as? String {
                storedContent = next
                version += 1
            }
            let summary: [String: Any] = [
                "skillId": "bridge_text_fixture", "source": "bridge", "version": String(version),
                "name": "Multilingual fixture", "description": "", "enabled": true, "availability": "available"
            ]
            let result: Any
            switch method {
            case "skills.snapshot": result = ["skills": [summary]]
            case "skills.read": result = [
                "skill": summary, "content": storedContent, "files": [], "format": "markdown",
                "legacy": false, "sourceSnapshot": "versioned-bridge-record", "warnings": []
            ]
            case "skills.versions": result = [
                "skillId": "bridge_text_fixture", "source": "bridge", "currentVersion": String(version),
                "enabled": true, "versions": []
            ]
            case "skills.update": result = summary
            default: return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"Unsupported fixture method"}}"#)
            }
            let data = try! JSONSerialization.data(withJSONObject: ["result": result])
            return NativeFixtureReply(body: String(decoding: data, as: UTF8.self))
        }
    }
}
