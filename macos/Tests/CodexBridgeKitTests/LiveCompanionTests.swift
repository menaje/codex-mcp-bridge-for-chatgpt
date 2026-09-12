import Foundation
import XCTest
@testable import CodexBridgeKit

final class LiveCompanionTests: XCTestCase {
    func testLiveDashboardAndSettingsContractsWhenRequested() async throws {
        guard let socketPath = ProcessInfo.processInfo.environment[
            "CODEX_MCP_BRIDGE_LIVE_COMPANION_SOCKET"
        ] else {
            throw XCTSkip("Set CODEX_MCP_BRIDGE_LIVE_COMPANION_SOCKET for the opt-in live contract smoke test.")
        }

        let client = BridgeCompanionClient(socketPath: socketPath)
        let dashboard = try await client.dashboard(limit: 12)
        XCTAssertEqual(dashboard.kind, "dashboard")
        XCTAssertEqual(dashboard.scope, "bridge-wide")
        XCTAssertGreaterThanOrEqual(dashboard.counts.trackedProjects, 0)

        let settings = try await client.settings()
        XCTAssertGreaterThanOrEqual(settings.settings.settingsRevision, 0)
        XCTAssertGreaterThanOrEqual(settings.settings.registryRevision, 0)
        XCTAssertFalse(settings.capabilities.availableAccessStrategies.isEmpty)
    }
}
