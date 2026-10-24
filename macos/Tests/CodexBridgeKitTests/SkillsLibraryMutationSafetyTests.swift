import AppKit
import CodexBridgeKit
import XCTest
@testable import CodexBridgeMenuBar

final class SkillsLibraryMutationSafetyTests: XCTestCase {
    @MainActor
    func testRenameRejectsOccupiedCaseAndUnicodeAliasesBeforeReadingOrUpdatingFiles() async throws {
        let fixture = try RenameSafetyFixture()
        defer { fixture.close() }
        for destination in ["b.md", "B.MD", "references/Caf\u{e9}.md"] {
            let result = await fixture.model.submitBridgeSkillFileRename(
                .init(skillId: "bridge_rename_fixture", version: "1"), from: "a.md", to: destination,
                requestId: UUID().uuidString, shouldSelect: { false })
            XCTAssertNil(result)
            XCTAssertNotNil(fixture.model.skillMutationErrorMessage)
        }
        XCTAssertEqual(fixture.bridge.count("skills.read"), 3)
        XCTAssertEqual(fixture.bridge.count("skills.read-file"), 0)
        XCTAssertEqual(fixture.bridge.count("skills.update"), 0, "An occupied destination must never become an upsert")
    }

    @MainActor
    func testUniqueRenameUsesPinnedVersionOriginalContentAndMutationIdentity() async throws {
        let fixture = try RenameSafetyFixture()
        defer { fixture.close() }
        let requestId = UUID().uuidString
        let result = await fixture.model.submitBridgeSkillFileRename(
            .init(skillId: "bridge_rename_fixture", version: "1"), from: "a.md", to: "references/new.md",
            requestId: requestId, shouldSelect: { false })
        XCTAssertEqual(result?.version, "2")
        XCTAssertNil(fixture.model.skillMutationErrorMessage)
        XCTAssertEqual(fixture.bridge.count("skills.read-file"), 1)
        XCTAssertEqual(fixture.bridge.count("skills.update"), 1)
        let update = try XCTUnwrap(fixture.responses.update)
        XCTAssertEqual(update["requestId"] as? String, requestId)
        XCTAssertEqual(update["expectedVersion"] as? String, "1")
        let changes = try XCTUnwrap(update["files"] as? [String: Any])
        XCTAssertEqual(changes["remove"] as? [String], ["a.md"])
        let upsert = try XCTUnwrap(changes["upsert"] as? [[String: Any]])
        XCTAssertEqual(upsert.first?["path"] as? String, "references/new.md")
        XCTAssertEqual(Data(try XCTUnwrap(upsert.first?["content"] as? String).utf8), Data("# A\r\ne\u{301}\n".utf8))
    }

    @MainActor
    func testNewAttachmentAlsoRejectsOccupiedCaseAndUnicodeAliases() async throws {
        let fixture = try RenameSafetyFixture()
        defer { fixture.close() }
        for path in ["b.md", "B.MD", "references/Caf\u{e9}.md"] {
            let result = await fixture.model.submitBridgeSkillFileCreation(
                .init(skillId: "bridge_rename_fixture", version: "1"), path: path, content: "# Replacement",
                requestId: UUID().uuidString, shouldSelect: { false })
            XCTAssertNil(result)
            XCTAssertNotNil(fixture.model.skillMutationErrorMessage)
        }
        XCTAssertEqual(fixture.bridge.count("skills.update"), 0)
    }

    @MainActor
    func testNewAttachmentAcceptsUnusedPathWithoutReadingAnotherFile() async throws {
        let fixture = try RenameSafetyFixture()
        defer { fixture.close() }
        let requestId = UUID().uuidString
        let result = await fixture.model.submitBridgeSkillFileCreation(
            .init(skillId: "bridge_rename_fixture", version: "1"), path: "new.md", content: "# New",
            requestId: requestId, shouldSelect: { false })
        XCTAssertEqual(result?.version, "2")
        XCTAssertEqual(fixture.bridge.count("skills.read-file"), 0)
        let update = try XCTUnwrap(fixture.responses.update)
        XCTAssertEqual(update["requestId"] as? String, requestId)
        XCTAssertEqual(update["expectedVersion"] as? String, "1")
        let files = try XCTUnwrap(update["files"] as? [String: Any])
        XCTAssertNil(files["remove"])
        XCTAssertEqual((files["upsert"] as? [[String: String]])?.first, ["path": "new.md", "content": "# New"])
    }

    func testOversizedStatRejectsImportWithoutReadingAnyBytes() throws {
        var reads = 0
        let result = try BridgeSkillImportCollector.readBoundedMarkdown(size: 4 * 1_024 * 1_024 * 1_024) { _ in
            reads += 1
            return Data()
        }
        XCTAssertNil(result)
        XCTAssertEqual(reads, 0)
    }

    func testGrowingImportStopsAtLimitPlusOneEvenWithShortReads() throws {
        var bytesRead = 0
        let result = try BridgeSkillImportCollector.readBoundedMarkdown(size: 0) { requested in
            let count = min(requested, 17 * 1_024)
            bytesRead += count
            return Data(repeating: 0x61, count: count)
        }
        XCTAssertNil(result)
        XCTAssertEqual(bytesRead, BridgeSkillImportCollector.fileByteLimit + 1)
    }

    func testExactLimitImportKeepsAllBytesAcrossShortReads() throws {
        let input = Data(repeating: 0x61, count: BridgeSkillImportCollector.fileByteLimit)
        var offset = 0
        let result = try BridgeSkillImportCollector.readBoundedMarkdown(size: Int64(input.count)) { requested in
            let end = min(offset + min(requested, 31 * 1_024), input.count)
            defer { offset = end }
            return input.subdata(in: offset..<end)
        }
        XCTAssertEqual(result, input)
        XCTAssertEqual(offset, input.count)
    }

    @MainActor
    func testDirectAndFolderImportsSkipSparseMultiGigabyteMarkdown() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("bridge-import-bound-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let oversized = root.appendingPathComponent("huge.md")
        XCTAssertTrue(FileManager.default.createFile(atPath: oversized.path, contents: Data()))
        let file = try FileHandle(forWritingTo: oversized)
        try file.truncate(atOffset: 4 * 1_024 * 1_024 * 1_024)
        try file.close()
        let valid = root.appendingPathComponent("valid.md")
        try Data("# Kept\r\n".utf8).write(to: valid)
        for urls in [[oversized, valid], [root]] {
            let review = BridgeSkillImportCollector.collect(urls: urls)
            XCTAssertEqual(review.paths, ["valid.md"])
            XCTAssertTrue(review.issues.contains { $0.path == "huge.md" && $0.reason == "file-too-large" })
            guard case .direct(let files) = review.payload else { return XCTFail("Expected direct import") }
            XCTAssertEqual(files.first?.content, "# Kept\r\n")
        }
    }
}

@MainActor
private final class RenameSafetyFixture {
    let root: URL
    let responses = RenameSafetyResponses()
    let bridge: NativeRPCFixture
    let model: AppModel

    init() throws {
        _ = NSApplication.shared
        root = URL(fileURLWithPath: "/tmp/cb-rename-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let responses = responses
        bridge = try NativeRPCFixture(path: paths.bridgeSocket.path) { method, params in responses.reply(method, params) }
        model = AppModel(paths: paths)
    }

    func close() {
        model.cancelAllPolling()
        bridge.stop()
        try? FileManager.default.removeItem(at: root)
    }
}

private final class RenameSafetyResponses: @unchecked Sendable {
    private let lock = NSLock()
    private var storedUpdate: [String: Any]?
    var update: [String: Any]? { lock.withLock { storedUpdate } }

    func reply(_ method: String, _ params: String) -> NativeFixtureReply {
        lock.withLock {
            let request = (try? JSONSerialization.jsonObject(with: Data(params.utf8)) as? [String: Any]) ?? [:]
            if method == "skills.update" { storedUpdate = request }
            let summary: [String: Any] = ["skillId": "bridge_rename_fixture", "source": "bridge",
                "version": method == "skills.update" ? "2" : "1", "name": "Rename fixture", "description": "",
                "enabled": true, "availability": "available"]
            let result: [String: Any]
            switch method {
            case "skills.snapshot": result = ["skills": [summary]]
            case "skills.read": result = ["skill": summary, "content": "# Main", "format": "markdown", "legacy": false,
                "sourceSnapshot": "versioned-bridge-record", "warnings": [],
                "files": ["a.md", "b.md", "references/Cafe\u{301}.md"].map {
                    ["path": $0, "format": "markdown", "bytes": 8, "contentDigest": String(repeating: "a", count: 64)] as [String: Any]
                }]
            case "skills.read-file": result = ["kind": "skill-file", "skill": summary, "path": "a.md",
                "content": "# A\r\ne\u{301}\n", "format": "markdown", "bytes": 10, "contentDigest": String(repeating: "a", count: 64)]
            case "skills.update": result = summary
            default: return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"Unsupported fixture method"}}"#)
            }
            return NativeFixtureReply(body: String(decoding: try! JSONSerialization.data(withJSONObject: ["result": result]), as: UTF8.self))
        }
    }
}
