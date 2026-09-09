import Darwin
import Foundation
import Metal
import XCTest
import SwiftUI
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

final class RuntimeLifecycleTests: XCTestCase {
    @MainActor
    func testCancellationWinningAtAcknowledgementDoesNotBecomeAHandoffFailure() async throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        _ = await model.shutdownApplication(force: false)
        f.state.setPhase("handoff-ready")
        f.state.cancelOnNextAcknowledgement()
        model.recordLocalConnectionStatus(try f.state.status())
        for _ in 0..<100 {
            if model.lifecycleOperation?.phase == "cancelled" { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(model.lifecycleOperation?.phase, "cancelled")
        XCTAssertEqual(f.server.count("lifecycle.acknowledge"), 1)
        let helperShutdownStarted = await f.bootstrap.started
        XCTAssertFalse(helperShutdownStarted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.receiptFile.path))
        XCTAssertNil(model.runtimeErrorMessage)
    }

    @MainActor
    func testCancelledHandoffDoesNotWriteALateFailureOrStopTheHelper() async throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        _ = await model.shutdownApplication(force: false)
        f.state.setPhase("handoff-ready")
        f.state.cancelOnNextHandoffStatus()
        model.recordLocalConnectionStatus(try f.state.status())
        for _ in 0..<100 {
            if model.lifecycleOperation?.phase == "cancelled" { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(model.lifecycleOperation?.phase, "cancelled")
        XCTAssertEqual(f.server.count("lifecycle.acknowledge"), 0)
        let helperShutdownStarted = await f.bootstrap.started
        XCTAssertFalse(helperShutdownStarted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.receiptFile.path))
        XCTAssertNil(model.runtimeErrorMessage)
    }

    @MainActor
    func testFailureBeforeHandoffAcknowledgementRecordsCauseAndCanBeRetried() async throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        _ = await model.shutdownApplication(force: false)
        f.state.setPhase("handoff-ready")
        f.state.failNextHandoffStatus()
        model.recordLocalConnectionStatus(try f.state.status())
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: f.receiptFile.path) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let receipt = try XCTUnwrap(RuntimeLifecycleHandoffStore.read(runtimeLockDirectory: f.paths.runtimeLockDirectory))
        XCTAssertEqual(receipt.outcome, "failed")
        XCTAssertEqual(receipt.failureCode, "LIFECYCLE_HANDOFF_CONNECTION_FAILED")
        XCTAssertEqual(f.server.count("lifecycle.acknowledge"), 0)
        XCTAssertFalse(model.applicationShutdownCompleted)
        f.state.setFailure("LIFECYCLE_HANDOFF_FAILED: LIFECYCLE_HANDOFF_CONNECTION_FAILED")
        await model.refreshStatus()
        XCTAssertEqual(model.lifecycleOperation?.phase, "failed")
        XCTAssertTrue(model.runtimeErrorMessage?.contains("로컬 서비스의 응답") == true)
        _ = await model.shutdownApplication(force: false)
        XCTAssertEqual(f.server.count("lifecycle.request"), 2)
        XCTAssertTrue(model.applicationShutdownReserved)
        await model.cancelLifecycle()
    }

    func testFailureCopyIncludesCauseAndActualConfigurationRecoveryOutcome() {
        let secret = "sk-test-secret-must-not-appear"
        let timeout = "RUNTIME_READINESS_TIMEOUT: \(secret)"
        let restored = BridgeAppLocalization.lifecycleFailureDescription(
            "CONFIG_APPLY_FAILED: \(timeout) Previous runtime configuration was restored.", locale: Locale(identifier: "ko"))
        XCTAssertTrue(restored.contains("설정 적용에 실패"))
        XCTAssertTrue(restored.contains("제한 시간"))
        XCTAssertTrue(restored.contains("이전 설정을 복원했습니다"))
        XCTAssertFalse(restored.contains(secret))
        let failed = BridgeAppLocalization.lifecycleFailureDescription(
            "\(timeout) CONFIG_ROLLBACK_FAILED: token=\(secret)", locale: Locale(identifier: "ko"))
        XCTAssertTrue(failed.contains("이전 설정을 복원하지 못했습니다"))
        XCTAssertFalse(failed.contains(secret))
        let restartFailed = BridgeAppLocalization.lifecycleFailureDescription(
            "\(timeout) CONFIG_ROLLBACK_RESTART_FAILED: startup failed", locale: Locale(identifier: "ko"))
        XCTAssertTrue(restartFailed.contains("복원했지만 서버를 다시 시작하지 못했습니다"))
    }

    func testHandoffFailurePersistsOnlyTheErrorCategory() throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        let secret = "sk-receipt-secret-must-not-appear"
        let code = RuntimeLifecycleHandoffStore.failureCode(for: HelperBootstrapError.launchFailed(secret), fallback: "HELPER_REPLACEMENT_FAILED")
        try RuntimeLifecycleHandoffStore.write(requestId: UUID().uuidString, completed: false,
            runtimeLockDirectory: f.paths.runtimeLockDirectory, failureCode: code)
        let value = try String(contentsOf: f.receiptFile, encoding: .utf8)
        XCTAssertTrue(value.contains("HELPER_LAUNCH_FAILED"))
        XCTAssertFalse(value.contains(secret))
    }

    @MainActor
    func testFailedReservationNoticeRendersRecoveryReason() throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        f.state.setFailure("RUNTIME_READINESS_TIMEOUT: timeout CONFIG_ROLLBACK_RESTART_FAILED: startup failed")
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        model.recordLocalConnectionStatus(try f.state.status())
        XCTAssertTrue(model.runtimeErrorMessage?.contains("이전 설정을 복원했지만") == true)
        try XCTSkipIf(MTLCreateSystemDefaultDevice() == nil, "SwiftUI image rendering requires a Metal device.")
        let content = RuntimeLifecycleNoticeView().environmentObject(model).padding(12).frame(width: 440)
            .background(Color.white).environment(\.colorScheme, .light)
        let renderer = ImageRenderer(content: content); renderer.scale = 2
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(renderer.nsImage?.tiffRepresentation)))
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        XCTAssertGreaterThan(png.count, 1000)
        if let file = ProcessInfo.processInfo.environment["CODEX_MCP_BRIDGE_LIFECYCLE_FAILURE_PREVIEW"] {
            try png.write(to: URL(fileURLWithPath: file))
        }
    }

    @MainActor
    func testReservationNoticeRendersAtPopoverWidth() throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        f.state.setPhase("blocked")
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        model.recordLocalConnectionStatus(try f.state.status())
        try XCTSkipIf(MTLCreateSystemDefaultDevice() == nil, "SwiftUI image rendering requires a Metal device.")
        let content = RuntimeLifecycleNoticeView().environmentObject(model).padding(12).frame(width: 440)
            .background(Color.white).environment(\.colorScheme, .light)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        let rendered = try XCTUnwrap(renderer.nsImage)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(rendered.tiffRepresentation)))
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        XCTAssertGreaterThan(png.count, 1000)
        if let file = ProcessInfo.processInfo.environment["CODEX_MCP_BRIDGE_LIFECYCLE_PREVIEW"] {
            try png.write(to: URL(fileURLWithPath: file))
        }
    }

    @MainActor
    func testAppReentryFinishesModePersistenceAfterVerifiedHelperExit() async throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        f.server.stop()
        try RuntimeLifecycleHandoffStore.write(requestId: UUID().uuidString, kind: "mode-switch", outcome: "runtime-stopped", runtimeLockDirectory: f.paths.runtimeLockDirectory)
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        await model.start()
        XCTAssertTrue(model.isRemoteClient)
        XCTAssertEqual(try RuntimeLifecycleHandoffStore.read(runtimeLockDirectory: f.paths.runtimeLockDirectory)?.outcome, "completed")
        _ = await model.shutdownApplication(force: false)
    }
    @MainActor
    func testReservationReturnsWithoutLockingTheAppAndCanBeCancelled() async throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        let accepted = await model.restartRuntime(force: false)
        XCTAssertTrue(accepted)
        XCTAssertFalse(model.isBusy)
        XCTAssertEqual(model.lifecycleOperation?.phase, "waiting")
        await model.refreshStatus()
        XCTAssertNotEqual(model.health, .unavailable)
        XCTAssertEqual(f.server.count("runtime.restart"), 0)
        await model.cancelLifecycle()
        XCTAssertEqual(model.lifecycleOperation?.phase, "cancelled")
        XCTAssertEqual(f.server.count("lifecycle.cancel"), 1)
    }

    @MainActor
    func testNewAppModelRecoversThePendingReservationFromHelperStatus() async throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        let client = MacOSHelperClient(socketPath: f.paths.helperSocket.path)
        let receipt = try await client.requestLifecycle(.init(kind: "restart"))
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        await model.refreshStatus()
        XCTAssertEqual(model.lifecycleOperation?.requestId, receipt.requestId)
        XCTAssertFalse(model.isBusy)
        XCTAssertEqual(f.server.count("lifecycle.request"), 1)
    }

    @MainActor
    func testIntentionalTransitionShowsCheckingInsteadOfUnavailable() throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        f.state.setPhase("reconnecting")
        model.recordLocalConnectionStatus(try f.state.status())
        XCTAssertEqual(model.health, .checking)
        if case .unknown = model.operationalObservation {} else { XCTFail("A planned transition should not notify a connection failure") }
    }

    @MainActor
    func testQuitWaitsForVerifiedExternalShutdownAfterTheHandoff() async throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        var terminationCalls = 0
        model.lifecycleTerminationHandler = { terminationCalls += 1 }
        let immediate = await model.shutdownApplication(force: false)
        XCTAssertFalse(immediate)
        XCTAssertTrue(model.applicationShutdownReserved)
        XCTAssertFalse(model.isBusy)
        f.state.setPhase("handoff-ready")
        await model.refreshStatus()
        for _ in 0..<100 { if await f.bootstrap.started { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(model.applicationShutdownCompleted)
        XCTAssertEqual(terminationCalls, 0)
        XCTAssertEqual(f.server.count("lifecycle.acknowledge"), 1)
        await f.bootstrap.release()
        for _ in 0..<100 { if model.applicationShutdownCompleted { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(model.applicationShutdownCompleted)
        XCTAssertEqual(terminationCalls, 1)
        let receipt = try Data(contentsOf: f.receiptFile)
        XCTAssertTrue(String(decoding: receipt, as: UTF8.self).contains("completed"))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: f.receiptFile.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    @MainActor
    func testFailedExternalShutdownDoesNotReportCompletionOrQuit() async throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        await f.bootstrap.release(failing: true)
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        _ = await model.shutdownApplication(force: false)
        f.state.setPhase("handoff-ready")
        await model.refreshStatus()
        for _ in 0..<100 { if FileManager.default.fileExists(atPath: f.receiptFile.path) { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(model.applicationShutdownCompleted)
        XCTAssertNotNil(model.runtimeErrorMessage)
        XCTAssertTrue(String(decoding: try Data(contentsOf: f.receiptFile), as: UTF8.self).contains("failed"))
    }

    @MainActor
    func testRemoteModeIsCommittedOnlyAfterLocalOwnershipIsReleased() async throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        let model = AppModel(paths: f.paths, bootstrapper: f.bootstrap)
        let reserved = await model.setConnectionMode(.remoteClient)
        XCTAssertTrue(reserved)
        XCTAssertFalse(model.isRemoteClient)
        f.state.setPhase("handoff-ready")
        await model.refreshStatus()
        await f.bootstrap.release()
        for _ in 0..<100 { if model.isRemoteClient { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(model.isRemoteClient)
        XCTAssertTrue(String(decoding: try Data(contentsOf: f.receiptFile), as: UTF8.self).contains("completed"))
    }

    func testHelperReplacementReusesReservationAndClaimsOnlyWhenReady() async throws {
        let f = try LifecycleNativeFixture(); defer { f.remove() }
        let client = MacOSHelperClient(socketPath: f.paths.helperSocket.path)
        do { _ = try await client.reserveReplacement(targetBuildID: "next"); XCTFail("Should wait") }
        catch HelperBootstrapError.replacementPending {} catch { throw error }
        f.state.setPhase("handoff-ready")
        let id = try await client.reserveReplacement(targetBuildID: "next")
        XCTAssertNotNil(id)
        XCTAssertEqual(f.server.count("lifecycle.request"), 1)
        XCTAssertEqual(f.server.count("lifecycle.acknowledge"), 1)
        XCTAssertEqual(f.server.count("runtime.stop"), 0)
    }

    func testLostReceiptRetriesTheSameReservationID() async throws {
        let f = try LifecycleNativeFixture(dropFirstReceipt: true); defer { f.remove() }
        let client = MacOSHelperClient(socketPath: f.paths.helperSocket.path)
        let request = RuntimeLifecycleRequest(kind: "restart")
        let receipt = try await client.requestLifecycle(request)
        XCTAssertEqual(receipt.requestId, request.requestId)
        XCTAssertEqual(f.state.requestIDs(), [request.requestId, request.requestId])
    }
}

private actor LifecycleBootstrapStub: HelperBootstrapping {
    private(set) var started = false
    private var released = false
    private var failing = false
    func release(failing: Bool = false) { self.failing = failing; released = true }
    func ensureRunning(paths: RuntimePaths) async throws {}
    func shutdown(paths: RuntimePaths) async throws {
        started = true
        while !released { try await Task.sleep(for: .milliseconds(5)) }
        if failing { throw HelperBootstrapError.shutdownTimeout }
    }
}

private final class LifecycleNativeFixture {
    let root: URL
    let paths: RuntimePaths
    let state: LifecycleReplyState
    let server: NativeRPCFixture
    let bootstrap = LifecycleBootstrapStub()
    var receiptFile: URL { paths.runtimeLockDirectory.deletingLastPathComponent().appendingPathComponent("lifecycle-handoff.json") }
    init(dropFirstReceipt: Bool = false) throws {
        root = URL(fileURLWithPath: "/tmp/lc-\(UUID().uuidString.prefix(8))", isDirectory: true)
        paths = RuntimePaths(environment: ["XDG_CONFIG_HOME": root.path, "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1"], currentDirectory: root)
        try FileManager.default.createDirectory(at: paths.helperSocket.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let state = LifecycleReplyState(dropFirstReceipt: dropFirstReceipt)
        self.state = state
        server = try NativeRPCFixture(path: paths.helperSocket.path, requestReply: { method, params in state.reply(method, params) })
    }
    func remove() { server.stop(); try? FileManager.default.removeItem(at: root) }
}

private final class LifecycleReplyState: @unchecked Sendable {
    private let lock = NSLock()
    private var phase = "waiting"
    private var id = UUID().uuidString
    private var kind = "restart"
    private var force = false
    private var target: String?
    private var error: String?
    private var statusFailures = 0
    private var cancelOnStatus = false
    private var cancelOnAcknowledgement = false
    private var ids: [String] = []
    private let dropFirstReceipt: Bool
    init(dropFirstReceipt: Bool) { self.dropFirstReceipt = dropFirstReceipt }
    func setPhase(_ value: String) { lock.withLock { phase = value } }
    func setFailure(_ value: String) { lock.withLock { phase = "failed"; error = value } }
    func failNextHandoffStatus() { lock.withLock { statusFailures = 1 } }
    func cancelOnNextHandoffStatus() { lock.withLock { cancelOnStatus = true } }
    func cancelOnNextAcknowledgement() { lock.withLock { cancelOnAcknowledgement = true } }
    func requestIDs() -> [String] { lock.withLock { ids } }
    func status() throws -> HelperStatus { try lock.withLock { try JSONDecoder().decode(HelperStatus.self, from: JSONSerialization.data(withJSONObject: helperStatus())) } }
    private func operation() -> [String: Any] {
        var value: [String: Any] = ["requestId": id, "kind": kind, "force": force, "phase": phase,
            "createdAt": "2026-09-09T00:00:00Z", "updatedAt": "2026-09-09T00:00:00Z", "reasons": phase == "blocked" ? [["code": "memory-only-threads", "count": 1]] : [], "error": error as Any? ?? NSNull(),
            "cancellable": ["waiting", "blocked", "handoff-ready"].contains(phase)]
        if let target { value["targetBuildId"] = target }
        return value
    }
    private func helperStatus() -> [String: Any] {
        let running = ["waiting", "blocked", "cancelled"].contains(phase)
        return ["kind": "helper-status", "generatedAt": "2026-09-09T00:00:00Z", "phase": running ? "running" : "stopped",
            "pid": running ? 42 : NSNull(), "restartAttempt": 0,
            "configuration": ["path": "/private/.env", "exists": true, "valid": true, "hasApiKey": true, "hasTunnelId": true],
            "bridge": ["socketPath": "/private/test.sock", "connected": running],
            "tunnel": ["phase": running ? "connected" : "stopped", "profile": "managed", "transport": "stdio", "doctorPassed": true, "processRunning": running, "connected": running],
            "lifecycle": operation()]
    }
    func reply(_ method: String, _ params: String) -> NativeFixtureReply {
        lock.withLock {
            let parameters = (try? JSONSerialization.jsonObject(with: Data(params.utf8))) as? [String: Any] ?? [:]
            var result: [String: Any]
            switch method {
            case "lifecycle.request":
                id = parameters["requestId"] as? String ?? id; kind = parameters["kind"] as? String ?? kind
                force = parameters["force"] as? Bool ?? false; target = parameters["targetBuildId"] as? String
                phase = "waiting"; error = nil; ids.append(id)
                if dropFirstReceipt && ids.count == 1 { return NativeFixtureReply(body: "") }
                result = operation()
            case "lifecycle.status": result = ["operation": ids.isEmpty ? NSNull() : operation()]
            case "lifecycle.cancel": phase = "cancelled"; result = operation()
            case "lifecycle.acknowledge" where cancelOnAcknowledgement:
                cancelOnAcknowledgement = false; phase = "cancelled"
                return NativeFixtureReply(body: "{\"error\":{\"code\":-32603,\"message\":\"LIFECYCLE_NOT_READY: Reservation was cancelled\"}}")
            case "lifecycle.acknowledge": phase = "handing-off"; result = operation()
            case "helper.status" where statusFailures > 0:
                statusFailures -= 1
                return NativeFixtureReply(body: "{\"error\":{\"code\":-32603,\"message\":\"Handoff status request failed\"}}")
            case "helper.status" where cancelOnStatus:
                cancelOnStatus = false; phase = "cancelled"; result = helperStatus()
            case "helper.status", "helper.health": result = helperStatus()
            case "changes.wait": result = ["revision": phase, "topics": ["runtime"]]
            default: return NativeFixtureReply(body: "{\"error\":{\"code\":-32601,\"message\":\"Unsupported method\"}}")
            }
            let data = try! JSONSerialization.data(withJSONObject: ["result": result])
            return NativeFixtureReply(body: String(decoding: data, as: UTF8.self), delay: method == "changes.wait" ? 0.2 : 0)
        }
    }
}
