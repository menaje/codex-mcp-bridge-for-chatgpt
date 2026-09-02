import Foundation
import XCTest
@testable import CodexBridgeKit

final class HelperBootstrapTests: XCTestCase {
    func testFailedBootoutRestoresDefinitionWithoutStartingReplacement() async throws {
        let fixture = try LaunchAgentFixture(previous: Data("old-definition".utf8))
        defer { fixture.remove() }
        let launchctl = LaunchctlStub(results: [(5, "bootout denied")])
        let bootstrap = HelperBootstrap { arguments in
            await launchctl.run(arguments)
        }

        await XCTAssertThrowsErrorAsync {
            try await bootstrap.replaceLaunchAgentDefinition(
                data: Data("new-definition".utf8),
                previous: fixture.previous,
                plistURL: fixture.plistURL,
                domain: "gui/501",
                service: "gui/501/test.helper",
                loaded: true,
                needsRestart: true
            )
        }

        XCTAssertEqual(try Data(contentsOf: fixture.plistURL), fixture.previous)
        let commands = await launchctl.commands
        XCTAssertEqual(commands.map(\.first), ["bootout"])
    }

    func testFailedReplacementRestoresPreviousDefinitionAndService() async throws {
        let fixture = try LaunchAgentFixture(previous: Data("old-definition".utf8))
        defer { fixture.remove() }
        let launchctl = LaunchctlStub(results: [
            (0, ""),
            (5, "new bootstrap failed"),
            (0, ""),
            (0, ""),
            (0, "")
        ])
        let bootstrap = HelperBootstrap { arguments in
            await launchctl.run(arguments)
        }

        await XCTAssertThrowsErrorAsync {
            try await bootstrap.replaceLaunchAgentDefinition(
                data: Data("new-definition".utf8),
                previous: fixture.previous,
                plistURL: fixture.plistURL,
                domain: "gui/501",
                service: "gui/501/test.helper",
                loaded: true,
                needsRestart: true
            )
        }

        XCTAssertEqual(try Data(contentsOf: fixture.plistURL), fixture.previous)
        let commands = await launchctl.commands
        XCTAssertEqual(
            commands.map(\.first),
            ["bootout", "bootstrap", "bootout", "bootstrap", "kickstart"]
        )
    }

    func testFailedReplacementKickstartUnloadsNewServiceBeforeRollback() async throws {
        let fixture = try LaunchAgentFixture(previous: Data("old-definition".utf8))
        defer { fixture.remove() }
        let launchctl = LaunchctlStub(results: [
            (0, ""),
            (0, ""),
            (5, "new kickstart failed"),
            (0, ""),
            (0, ""),
            (0, "")
        ])
        let bootstrap = HelperBootstrap { arguments in
            await launchctl.run(arguments)
        }

        await XCTAssertThrowsErrorAsync {
            try await bootstrap.replaceLaunchAgentDefinition(
                data: Data("new-definition".utf8),
                previous: fixture.previous,
                plistURL: fixture.plistURL,
                domain: "gui/501",
                service: "gui/501/test.helper",
                loaded: true,
                needsRestart: true
            )
        }

        XCTAssertEqual(try Data(contentsOf: fixture.plistURL), fixture.previous)
        let commands = await launchctl.commands
        XCTAssertEqual(
            commands.map(\.first),
            ["bootout", "bootstrap", "kickstart", "bootout", "bootstrap", "kickstart"]
        )
    }

    func testFailedFreshInstallRemovesUnusableDefinition() async throws {
        let fixture = try LaunchAgentFixture(previous: nil)
        defer { fixture.remove() }
        let launchctl = LaunchctlStub(results: [
            (0, ""),
            (5, "kickstart failed"),
            (0, "")
        ])
        let bootstrap = HelperBootstrap { arguments in
            await launchctl.run(arguments)
        }

        await XCTAssertThrowsErrorAsync {
            try await bootstrap.replaceLaunchAgentDefinition(
                data: Data("new-definition".utf8),
                previous: nil,
                plistURL: fixture.plistURL,
                domain: "gui/501",
                service: "gui/501/test.helper",
                loaded: false,
                needsRestart: true
            )
        }

        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.plistURL.path))
    }

    func testReadinessFailureRollsBackPreviousDefinitionAndService() async throws {
        let fixture = try LaunchAgentFixture(previous: Data("old-definition".utf8))
        defer { fixture.remove() }
        let launchctl = LaunchctlStub(results: [
            (0, ""),
            (0, ""),
            (0, ""),
            (0, ""),
            (0, ""),
            (0, "")
        ])
        let bootstrap = HelperBootstrap { arguments in
            await launchctl.run(arguments)
        }

        await XCTAssertThrowsErrorAsync {
            try await bootstrap.replaceLaunchAgentDefinition(
                data: Data("new-definition".utf8),
                previous: fixture.previous,
                plistURL: fixture.plistURL,
                domain: "gui/501",
                service: "gui/501/test.helper",
                loaded: true,
                needsRestart: true,
                verifyReady: { false }
            )
        }

        XCTAssertEqual(try Data(contentsOf: fixture.plistURL), fixture.previous)
        let commands = await launchctl.commands
        XCTAssertEqual(
            commands.map(\.first),
            ["bootout", "bootstrap", "kickstart", "bootout", "bootstrap", "kickstart"]
        )
    }
}

private actor LaunchctlStub {
    private var results: [HelperBootstrap.LaunchctlResult]
    private(set) var commands: [[String]] = []

    init(results: [HelperBootstrap.LaunchctlResult]) {
        self.results = results
    }

    func run(_ arguments: [String]) -> HelperBootstrap.LaunchctlResult {
        commands.append(arguments)
        guard !results.isEmpty else { return (0, "") }
        return results.removeFirst()
    }
}

private struct LaunchAgentFixture {
    let directory: URL
    let plistURL: URL
    let previous: Data?

    init(previous: Data?) throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("helper-bootstrap-\(UUID().uuidString)", isDirectory: true)
        plistURL = directory.appendingPathComponent("test.helper.plist")
        self.previous = previous
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        if let previous {
            try previous.write(to: plistURL, options: .atomic)
        }
    }

    func remove() {
        try? FileManager.default.removeItem(at: directory)
    }
}

private func XCTAssertThrowsErrorAsync(
    _ expression: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await expression()
        XCTFail("Expected an error to be thrown", file: file, line: line)
    } catch {
        // Expected.
    }
}
