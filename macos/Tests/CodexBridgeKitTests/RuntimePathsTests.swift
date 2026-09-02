import Foundation
import XCTest
@testable import CodexBridgeKit

final class RuntimePathsTests: XCTestCase {
    func testExplicitNodeMustReportVersion22OrNewer() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codex-node-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let node = root.appendingPathComponent("node")
        try Data("#!/bin/sh\necho 22.13.1\n".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)

        let paths = RuntimePaths(
            environment: [
                "CODEX_MCP_BRIDGE_NODE": node.path,
                "PATH": ""
            ],
            bundle: .main,
            currentDirectory: root
        )
        XCTAssertEqual(paths.nodeExecutable?.standardizedFileURL, node.standardizedFileURL)
    }

    func testLaunchAgentPathIncludesSelectedNodeAndManagedBinaryLocations() {
        let node = URL(fileURLWithPath: "/Users/example/.nvm/versions/node/v24/bin/node")
        let home = URL(fileURLWithPath: "/Users/example")
        let environment = HelperBootstrap.launchAgentEnvironment(
            nodeExecutable: node,
            home: home
        )
        let entries = environment["PATH"]?.split(separator: ":").map(String.init) ?? []

        XCTAssertEqual(entries.first, "/Users/example/.nvm/versions/node/v24/bin")
        XCTAssertTrue(entries.contains("/opt/homebrew/bin"))
        XCTAssertTrue(entries.contains("/Users/example/.local/bin"))
        XCTAssertEqual(entries.count, Set(entries).count)
    }
}
