import AppKit
import CodexBridgeKit
import XCTest
@testable import CodexBridgeMenuBar

final class SkillsLibraryFileReadTests: XCTestCase {
    @MainActor
    func testCachedSelectionInvalidatesAnEarlierFileRead() async throws {
        _ = NSApplication.shared
        let root = URL(fileURLWithPath: "/tmp/cb-file-read-\(UUID().uuidString.prefix(8))")
        let paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path])
        try FileManager.default.createDirectory(at: paths.bridgeSocket.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fixture = try NativeRPCFixture(path: paths.bridgeSocket.path) { method, params in
            let summary: [String: Any] = ["skillId": "bridge_file_fixture", "source": "bridge", "version": "1",
                "name": "File fixture", "description": "", "enabled": true, "availability": "available"]
            let request = (try? JSONSerialization.jsonObject(with: Data(params.utf8)) as? [String: Any]) ?? [:]
            let path = request["path"] as? String ?? ""
            let result: [String: Any]
            switch method {
            case "skills.read":
                result = ["skill": summary, "content": "# Main", "files": [], "format": "markdown", "legacy": false,
                    "sourceSnapshot": "versioned-bridge-record", "warnings": []]
            case "skills.versions":
                result = ["skillId": "bridge_file_fixture", "source": "bridge", "currentVersion": "1", "enabled": true, "versions": []]
            case "skills.read-file":
                result = ["kind": "skill-file", "skill": summary, "path": path, "content": "Content of \(path)",
                    "format": "markdown", "bytes": 16, "contentDigest": String(repeating: "a", count: 64)]
            default:
                return NativeFixtureReply(body: #"{"error":{"code":-32601,"message":"Unsupported fixture method"}}"#)
            }
            let data = try! JSONSerialization.data(withJSONObject: ["result": result])
            return NativeFixtureReply(body: String(decoding: data, as: UTF8.self), delay: path == "a.md" ? 0.3 : 0)
        }
        let model = AppModel(paths: paths)
        defer { model.cancelAllPolling(); fixture.stop(); try? FileManager.default.removeItem(at: root) }
        model.helperStatus = try JSONDecoder().decode(HelperStatus.self, from: Data(#"""
        {"kind":"helper-status","generatedAt":"2026-10-04T00:00:00Z","phase":"running","restartAttempt":0,
         "configuration":{"path":"fixture","exists":true,"valid":true,"hasApiKey":true,"hasTunnelId":true},
         "bridge":{"socketPath":"fixture","connected":true},
         "tunnel":{"phase":"connected","doctorPassed":true,"processRunning":true,"connected":true}}
        """#.utf8))
        await model.loadBridgeSkill(.init(skillId: "bridge_file_fixture", version: "1"))
        XCTAssertNil(model.skillLibraryErrorMessage)
        await model.loadBridgeSkillFile(path: "b.md")
        XCTAssertEqual(model.selectedBridgeSkillFile?.path, "b.md")
        let delayed = Task { await model.loadBridgeSkillFile(path: "a.md") }
        for _ in 0..<100 {
            if fixture.count("skills.read-file") == 2 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(fixture.count("skills.read-file"), 2)
        XCTAssertTrue(model.bridgeSkillFileLoading)
        await model.loadBridgeSkillFile(path: "b.md")
        XCTAssertFalse(model.bridgeSkillFileLoading)
        await delayed.value
        XCTAssertEqual(model.selectedBridgeSkillFile?.path, "b.md")
        XCTAssertEqual(model.selectedBridgeSkillFile?.content, "Content of b.md")
        XCTAssertFalse(model.bridgeSkillFileLoading)
        XCTAssertNil(model.skillLibraryErrorMessage)
        XCTAssertEqual(fixture.count("skills.read-file"), 2, "The cached selection must not issue another RPC")
    }
}
