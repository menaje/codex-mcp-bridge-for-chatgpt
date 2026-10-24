import Darwin
import Foundation
import XCTest
@testable import CodexBridgeKit

final class HelperBootstrapTests: XCTestCase {
    func testLoadedHelperWithoutHandshakeWaitsEvenWhenDefinitionChanged() {
        XCTAssertEqual(HelperBootstrap.launchDecision(loaded: true, definitionMatches: true, compatible: nil), .awaitLoaded)
        XCTAssertEqual(HelperBootstrap.launchDecision(loaded: true, definitionMatches: false, compatible: nil), .awaitLoaded)
        XCTAssertEqual(HelperBootstrap.launchDecision(loaded: true, definitionMatches: true, compatible: false), .replaceLoaded)
        XCTAssertEqual(HelperBootstrap.launchDecision(loaded: true, definitionMatches: false, compatible: true), .replaceLoaded)
        XCTAssertEqual(HelperBootstrap.launchDecision(loaded: true, definitionMatches: true, compatible: true), .useLoaded)
        XCTAssertEqual(HelperBootstrap.launchDecision(loaded: false, definitionMatches: true, compatible: nil), .installMissing)
    }

    func testColdHelperWaitIncludesRPCAndSleepInOneDeadline() async throws {
        let clock = BootstrapTestClock()
        let deadline = clock.now().addingTimeInterval(150)
        try await HelperBootstrap.waitForCompatibility(deadline: deadline, now: { clock.now() },
            sleep: { clock.advance($0) }, read: { timeout in
                XCTAssertLessThanOrEqual(timeout, 2)
                if clock.elapsed >= 120 { return true }
                clock.advance(timeout)
                throw LocalRPCError.transport(phase: .connect, code: ENOENT)
            })
        XCTAssertGreaterThanOrEqual(clock.elapsed, 120)
        XCTAssertLessThan(clock.elapsed, 150)
    }

    func testFailedObservationNeverRenewsBudgetOrPermitsReplacement() async throws {
        let clock = BootstrapTestClock()
        let deadline = clock.now().addingTimeInterval(3)
        await XCTAssertThrowsErrorAsync {
            try await HelperBootstrap.waitForCompatibility(deadline: deadline, now: { clock.now() },
                sleep: { clock.advance($0) }, read: { timeout in
                    clock.advance(timeout)
                    throw LocalRPCError.deadlineExceeded(phase: .receive)
                })
        }
        let observed = clock.elapsed
        await XCTAssertThrowsErrorAsync {
            try await HelperBootstrap.waitForCompatibility(deadline: deadline, now: { clock.now() },
                sleep: { clock.advance($0) }, read: { _ in XCTFail("Expired budget must not issue an RPC"); return true })
        }
        XCTAssertEqual(clock.elapsed, observed)
    }

    func testConfirmedMismatchPermissionAndCancellationAreNotReadinessRetries() async throws {
        for error in [LocalRPCError.peerIdentityMismatch, .malformedResponse("contract")] {
            await XCTAssertThrowsErrorAsync {
                try await HelperBootstrap.waitForCompatibility(deadline: Date().addingTimeInterval(10),
                    sleep: { _ in XCTFail("Permanent failure must not sleep") }, read: { _ in throw error })
            }
        }
        do {
            try await HelperBootstrap.waitForCompatibility(deadline: Date().addingTimeInterval(10), read: { _ in false })
            XCTFail("Confirmed mismatch must not be accepted")
        } catch HelperBootstrapError.incompatibleHelper { }
        do {
            try await HelperBootstrap.waitForCompatibility(deadline: Date().addingTimeInterval(10), read: { _ in throw CancellationError() })
            XCTFail("Cancellation must propagate")
        } catch is CancellationError { }
    }

    func testLoadedHelperReconnectDoesNotReplaceService() async throws {
        try await verifyLoadedHelper(delay: 0.05)
    }

    func testNinetySecondLoadedHelperPreparation() async throws {
        guard ProcessInfo.processInfo.environment["CODEX_MCP_BRIDGE_TEST_COLD_HELPER"] == "1" else {
            throw XCTSkip("Opt-in Issue 246 cold-helper scenario; run once in an isolated fixture.")
        }
        try await verifyLoadedHelper(delay: 90)
    }

    private func verifyLoadedHelper(delay: TimeInterval) async throws {
        let root = URL(fileURLWithPath: "/tmp/cb246-helper-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let socket = root.appendingPathComponent("helper.sock")
        let response = #"{"protocol":{"name":"codex-mcp-bridge-macos-helper","version":2},"runtime":{"buildId":"fixture","version":"0.4.1"},"capabilities":["setup.dotenv.atomic-apply","setup.dotenv.repair-permissions","setup.discovery.import","runtime.configure","helper.prepare-shutdown"],"status":{"kind":"helper-status","generatedAt":"2026-10-13T00:00:00Z","phase":"running","pid":123,"restartAttempt":0,"configuration":{"path":"/fixture/.env","exists":true,"valid":true,"hasApiKey":true,"hasTunnelId":true},"bridge":{"socketPath":"/fixture/bridge.sock","connected":true},"tunnel":{"phase":"connected","doctorPassed":true,"processRunning":true,"connected":true}}}"#
        let initial = try NativeRPCFixture(path: socket.path) { _ in NativeFixtureReply(body: "{\"result\":\(response)}") }
        let launchctl = LaunchctlStub(results: [(113, "Could not find service"), (0, ""), (0, ""), (0, "loaded")])
        let bootstrap = HelperBootstrap { await launchctl.run($0) }
        let client = MacOSHelperClient(socketPath: socket.path)
        let launchAgents = root.appendingPathComponent("LaunchAgents")
        let connect: () async throws -> Void = {
            try await bootstrap.installAndStartLaunchAgent(
                nodeExecutable: root.appendingPathComponent("node"), helperScript: root.appendingPathComponent("helper.js"),
                bridgeRoot: root, workingDirectory: root, environmentFile: root.appendingPathComponent(".env"),
                helperSocket: socket, bridgeSocket: root.appendingPathComponent("bridge.sock"),
                runtimeLockDirectory: root.appendingPathComponent("launcher.lock"), runtimeBuildID: "fixture",
                forceRestart: false, client: client, helperIsReachable: false,
                deadline: Date().addingTimeInterval(150), launchAgentDirectory: launchAgents)
        }
        try await connect()
        initial.stop()
        let holder = BootstrapFixtureHolder()
        let preparing = Task {
            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            holder.set(try NativeRPCFixture(path: socket.path) { _ in NativeFixtureReply(body: "{\"result\":\(response)}") })
        }
        defer { preparing.cancel(); holder.stop() }
        let started = Date()
        try await connect()
        try await preparing.value
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), delay)
        let commands = await launchctl.commands
        XCTAssertEqual(commands.map(\.first), ["print", "bootstrap", "kickstart", "print"])
        let hello = try await client.hello()
        XCTAssertTrue(hello.status.bridge.connected)
        XCTAssertTrue(hello.status.tunnel.connected)
    }

    func testLaunchAgentUsesPersistentConfigurationWorkingDirectory() throws {
        let configurationDirectory = URL(fileURLWithPath: "/Users/fixture/.config/codex-mcp-bridge")
        let plist = HelperBootstrap.launchAgentPropertyList(
            programArguments: ["/fixture/node", "/fixture/helper.js"],
            workingDirectory: configurationDirectory,
            environment: ["HOME": "/Users/fixture"]
        )

        XCTAssertEqual(plist["WorkingDirectory"] as? String, configurationDirectory.path)
        XCTAssertNotEqual(plist["WorkingDirectory"] as? String, "/fixture/App.app/Contents/Resources/Runtime")
    }

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

    func testReplacementRetriesTransientLaunchdBootstrapRace() async throws {
        let fixture = try LaunchAgentFixture(previous: Data("old-definition".utf8))
        defer { fixture.remove() }
        let launchctl = LaunchctlStub(results: [
            (0, ""),
            (5, "Bootstrap failed: 5: Input/output error"),
            (0, ""),
            (0, "")
        ])
        let bootstrap = HelperBootstrap { arguments in
            await launchctl.run(arguments)
        }

        try await bootstrap.replaceLaunchAgentDefinition(
            data: Data("new-definition".utf8),
            previous: fixture.previous,
            plistURL: fixture.plistURL,
            domain: "gui/501",
            service: "gui/501/test.helper",
            loaded: true,
            needsRestart: true
        )

        XCTAssertEqual(try Data(contentsOf: fixture.plistURL), Data("new-definition".utf8))
        let commands = await launchctl.commands
        XCTAssertEqual(
            commands.map(\.first),
            ["bootout", "bootstrap", "bootstrap", "kickstart"]
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

    func testStopLaunchAgentBootsOutAndVerifiesServiceRemoval() async throws {
        let launchctl = LaunchctlStub(results: [
            (0, "loaded"),
            (0, ""),
            (113, "Could not find service")
        ])
        let bootstrap = HelperBootstrap { arguments in
            await launchctl.run(arguments)
        }

        try await bootstrap.stopLaunchAgent(service: "gui/501/test.helper")

        let commands = await launchctl.commands
        XCTAssertEqual(commands, [
            ["print", "gui/501/test.helper"],
            ["bootout", "gui/501/test.helper"],
            ["print", "gui/501/test.helper"]
        ])
    }

    func testStopLaunchAgentTreatsAlreadyMissingServiceAsStopped() async throws {
        let launchctl = LaunchctlStub(results: [
            (113, "Could not find service")
        ])
        let bootstrap = HelperBootstrap { arguments in
            await launchctl.run(arguments)
        }

        try await bootstrap.stopLaunchAgent(service: "gui/501/test.helper")

        let commands = await launchctl.commands
        XCTAssertEqual(commands, [["print", "gui/501/test.helper"]])
    }

    func testStopLaunchAgentReportsBootoutFailureWithoutClaimingShutdown() async throws {
        let launchctl = LaunchctlStub(results: [
            (0, "loaded"),
            (5, "bootout denied")
        ])
        let bootstrap = HelperBootstrap { arguments in
            await launchctl.run(arguments)
        }

        await XCTAssertThrowsErrorAsync {
            try await bootstrap.stopLaunchAgent(service: "gui/501/test.helper")
        }

        let commands = await launchctl.commands
        XCTAssertEqual(commands.map(\.first), ["print", "bootout"])
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

private final class BootstrapTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var seconds: TimeInterval = 0
    var elapsed: TimeInterval { lock.lock(); defer { lock.unlock() }; return seconds }
    func now() -> Date { Date(timeIntervalSince1970: elapsed) }
    func advance(_ value: TimeInterval) { lock.lock(); defer { lock.unlock() }; seconds += value }
}

private final class BootstrapFixtureHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var fixture: NativeRPCFixture?
    func set(_ value: NativeRPCFixture) { lock.lock(); defer { lock.unlock() }; fixture = value }
    func stop() { lock.lock(); defer { lock.unlock() }; fixture?.stop(); fixture = nil }
}
