import XCTest
@testable import CodexBridgeKit

final class BridgeModelsTests: XCTestCase {
    @MainActor
    func testDisplayFormatParsesBackendTimestampsWithAndWithoutFractions() {
        XCTAssertNotNil(DisplayFormat.parseDate("2026-09-02T00:00:00.000Z"))
        XCTAssertNotNil(DisplayFormat.parseDate("2026-09-02T00:00:00Z"))
        XCTAssertNil(DisplayFormat.parseDate("not-a-date"))
    }

    @MainActor
    func testDisplayFormatUsesRequestedLocaleForDurations() {
        let english = DisplayFormat.duration(65_000, locale: Locale(identifier: "en"))
        let korean = DisplayFormat.duration(65_000, locale: Locale(identifier: "ko"))

        XCTAssertEqual(english, "1m 5s")
        XCTAssertEqual(korean, "1분 5초")
        XCTAssertNotEqual(english, korean)
    }

    func testSettingsMutationKeepsIndependentRevisionsAndNestedPatch() throws {
        let mutation = SettingsMutation(
            expectedSettingsRevision: 7,
            expectedRegistryRevision: nil,
            operation: .patch(SettingsPatch(
                accessStrategy: "adaptive",
                modelPolicy: ModelPolicy(
                    mode: "fixed",
                    selection: ModelChoice(model: "gpt-5.6", reasoningEffort: "high"),
                    constraints: ModelPolicyConstraints(allowDelegation: true)
                ),
                usePriorityServiceTier: true,
                activityCard: ActivityCardPatch(
                    visibility: "background-only",
                    completionHandoff: "auto-handoff"
                )
            ))
        )

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(mutation)) as? [String: Any]
        )
        XCTAssertEqual(object["expectedSettingsRevision"] as? Int, 7)
        XCTAssertNil(object["expectedRegistryRevision"])
        let operation = try XCTUnwrap(object["operation"] as? [String: Any])
        XCTAssertEqual(operation["kind"] as? String, "patch")
        let settings = try XCTUnwrap(operation["settings"] as? [String: Any])
        XCTAssertEqual(settings["accessStrategy"] as? String, "adaptive")
        XCTAssertEqual(settings["usePriorityServiceTier"] as? Bool, true)
        let policy = try XCTUnwrap(settings["modelPolicy"] as? [String: Any])
        XCTAssertEqual(policy["mode"] as? String, "fixed")
        XCTAssertNil(policy["fallbackSelection"])
    }

    func testSettingsPatchOmitsUntouchedModelPolicy() throws {
        let mutation = SettingsMutation(
            expectedSettingsRevision: 7,
            expectedRegistryRevision: nil,
            operation: .patch(SettingsPatch(
                accessStrategy: "adaptive",
                modelPolicy: nil,
                usePriorityServiceTier: false
            ))
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(mutation)) as? [String: Any]
        )
        let operation = try XCTUnwrap(object["operation"] as? [String: Any])
        let settings = try XCTUnwrap(operation["settings"] as? [String: Any])
        XCTAssertFalse(settings.keys.contains("modelPolicy"))
    }

    func testProjectOperationsUseExplicitDeltaShapes() throws {
        let operations: [ProjectOperation] = [
            .add(name: "Bridge", cwd: "/Volumes/Data/Bridge"),
            .rename(projectId: "00000000-0000-4000-8000-000000000001", name: "Renamed"),
            .restore(
                projectId: "00000000-0000-4000-8000-000000000002",
                name: "Restored",
                cwd: "/Volumes/Data/Restored"
            )
        ]
        let data = try JSONEncoder().encode(operations)
        let array = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertEqual(array.map { $0["kind"] as? String }, ["add", "rename", "restore"])
        XCTAssertNotNil(array[0]["project"] as? [String: Any])
        XCTAssertNil(array[0]["projectId"])
        XCTAssertEqual(array[1]["projectId"] as? String, "00000000-0000-4000-8000-000000000001")
    }

    func testHelperStatusDoesNotRequireCredentialValues() throws {
        let json = #"""
        {
          "kind":"helper-status",
          "generatedAt":"2026-09-02T00:00:00.000Z",
          "phase":"running",
          "pid":42,
          "startedAt":"2026-09-02T00:00:00.000Z",
          "lastExit":null,
          "lastError":null,
          "restartAttempt":0,
          "configuration":{
            "path":"/private/config/.env",
            "exists":true,
            "valid":true,
            "hasApiKey":true,
            "hasTunnelId":true,
            "tunnelId":"tunnel_native123",
            "issue":null
          },
          "bridge":{
            "socketPath":"/private/config/run/bridge.sock",
            "connected":true,
            "acceptingNewJobs":true,
            "activeJobs":2,
            "pendingAdmissions":0
          },
          "tunnel":{
            "phase":"connected",
            "profile":"codex-mcp-bridge-stdio",
            "transport":"stdio",
            "doctorPassed":true,
            "processRunning":true,
            "connected":true,
            "lastCheckedAt":"2026-09-02T00:00:00.000Z",
            "lastError":null
          }
        }
        """#.data(using: .utf8)!
        let status = try JSONDecoder().decode(HelperStatus.self, from: json)
        XCTAssertEqual(status.phase, "running")
        XCTAssertTrue(status.configuration.hasApiKey)
        XCTAssertEqual(status.bridge.activeJobs, 2)
        XCTAssertTrue(status.tunnel.connected)
        XCTAssertFalse(String(data: json, encoding: .utf8)!.contains("CONTROL_PLANE_API_KEY"))
    }

    func testHelperCompatibilityRequiresProtocolBuildAndNativeSetupCapabilities() throws {
        let statusData = #"""
        {
          "kind":"helper-status","generatedAt":"2026-09-02T00:00:00.000Z",
          "phase":"running","pid":42,"startedAt":null,"lastExit":null,"lastError":null,
          "restartAttempt":0,
          "configuration":{"path":"/private/.env","exists":true,"valid":true,"hasApiKey":true,"hasTunnelId":true,"tunnelId":"tunnel_native123","issue":null},
          "bridge":{"socketPath":"/private/bridge.sock","connected":true,"acceptingNewJobs":true,"activeJobs":0,"pendingAdmissions":0},
          "tunnel":{"phase":"connected","profile":"managed","transport":"stdio","doctorPassed":true,"processRunning":true,"connected":true,"lastCheckedAt":null,"lastError":null}
        }
        """#.data(using: .utf8)!
        let status = try JSONDecoder().decode(HelperStatus.self, from: statusData)
        func hello(name: String, version: Int, buildID: String, capabilities: [String]) throws -> HelperHello {
            let statusObject = try JSONSerialization.jsonObject(with: statusData)
            let object: [String: Any] = [
                "protocol": ["name": name, "version": version],
                "runtime": ["buildId": buildID, "version": "0.3.0"],
                "capabilities": capabilities,
                "status": statusObject
            ]
            return try JSONDecoder().decode(
                HelperHello.self,
                from: JSONSerialization.data(withJSONObject: object)
            )
        }
        let compatible = try hello(
            name: HelperHello.expectedProtocolName,
            version: HelperHello.expectedProtocolVersion,
            buildID: "build-current",
            capabilities: [
                "setup.dotenv.atomic-apply",
                "setup.dotenv.repair-permissions",
                "runtime.configure",
                "helper.prepare-shutdown"
            ]
        )
        XCTAssertTrue(HelperBootstrap.isCompatible(compatible, runtimeBuildID: "build-current"))
        XCTAssertFalse(HelperBootstrap.isCompatible(compatible, runtimeBuildID: "build-old"))
        XCTAssertFalse(HelperBootstrap.isCompatible(
            try hello(
                name: HelperHello.expectedProtocolName,
                version: 1,
                buildID: "build-current",
                capabilities: [
                    "setup.dotenv.atomic-apply",
                    "setup.dotenv.repair-permissions",
                    "runtime.configure",
                    "helper.prepare-shutdown"
                ]
            ),
            runtimeBuildID: "build-current"
        ))
        XCTAssertFalse(HelperBootstrap.isCompatible(
            try hello(
                name: HelperHello.expectedProtocolName,
                version: HelperHello.expectedProtocolVersion,
                buildID: "build-current",
                capabilities: [
                    "setup.dotenv.atomic-apply",
                    "setup.dotenv.repair-permissions",
                    "runtime.configure"
                ]
            ),
            runtimeBuildID: "build-current"
        ))
        XCTAssertEqual(status.phase, "running")
    }

    func testDashboardLoadMoreRetainsIndependentPageCaches() {
        let initial = dashboardSnapshot(
            terminalRows: [dashboardRow("recent-1", bucket: "recent")],
            idleRows: [dashboardRow("idle-1", bucket: "idle")],
            terminalPage: dashboardPage(offset: 0, returned: 1, total: 2, hasNext: true),
            idlePage: dashboardPage(offset: 0, returned: 1, total: 2, hasNext: true)
        )
        let nextRecent = dashboardSnapshot(
            terminalRows: [dashboardRow("recent-2", bucket: "recent")],
            idleRows: [dashboardRow("idle-1", bucket: "idle")],
            terminalPage: dashboardPage(offset: 1, returned: 1, total: 2, hasNext: false),
            idlePage: dashboardPage(offset: 0, returned: 1, total: 2, hasNext: true)
        )
        let afterRecent = initial.mergingPage(
            nextRecent,
            bucket: .terminal,
            requestedOffset: 1
        )
        XCTAssertEqual(afterRecent.terminalRows.map(\.rowKey), ["recent-1", "recent-2"])
        XCTAssertEqual(afterRecent.idleRows.map(\.rowKey), ["idle-1"])

        let nextIdle = dashboardSnapshot(
            terminalRows: [dashboardRow("recent-1", bucket: "recent")],
            idleRows: [dashboardRow("idle-2", bucket: "idle")],
            terminalPage: dashboardPage(offset: 0, returned: 1, total: 2, hasNext: true),
            idlePage: dashboardPage(offset: 1, returned: 1, total: 2, hasNext: false)
        )
        let afterIdle = afterRecent.mergingPage(nextIdle, bucket: .idle, requestedOffset: 1)
        XCTAssertEqual(afterIdle.terminalRows.map(\.rowKey), ["recent-1", "recent-2"])
        XCTAssertEqual(afterIdle.idleRows.map(\.rowKey), ["idle-1", "idle-2"])
    }

    func testDashboardLoadMoreEvictsRowsThatBecomeActive() {
        let initial = dashboardSnapshot(
            terminalRows: [dashboardRow("moved", bucket: "recent")],
            idleRows: [dashboardRow("idle-1", bucket: "idle")],
            terminalPage: dashboardPage(offset: 0, returned: 1, total: 2, hasNext: true),
            idlePage: dashboardPage(offset: 0, returned: 1, total: 1, hasNext: false)
        )
        let next = dashboardSnapshot(
            activeRows: [dashboardRow("moved", bucket: "active")],
            terminalRows: [dashboardRow("recent-2", bucket: "recent")],
            idleRows: [dashboardRow("idle-1", bucket: "idle")],
            terminalPage: dashboardPage(offset: 1, returned: 1, total: 2, hasNext: false),
            idlePage: dashboardPage(offset: 0, returned: 1, total: 1, hasNext: false)
        )
        let merged = initial.mergingPage(next, bucket: .terminal, requestedOffset: 1)
        XCTAssertEqual(merged.activeRows.map(\.rowKey), ["moved"])
        XCTAssertEqual(merged.terminalRows.map(\.rowKey), ["recent-2"])
    }
}

private func dashboardSnapshot(
    activeRows: [DashboardRow] = [],
    terminalRows: [DashboardRow],
    idleRows: [DashboardRow],
    terminalPage: DashboardPage,
    idlePage: DashboardPage
) -> DashboardSnapshot {
    DashboardSnapshot(
        kind: "dashboard",
        generatedAt: "2026-09-02T00:00:00.000Z",
        scope: "bridge-wide",
        statusSource: "codex-runtime-only",
        coverage: "bridge-known-retained",
        enrichment: nil,
        weeklyUsage: nil,
        counts: DashboardCounts(
            trackedProjects: 1,
            trackedConversations: 1,
            retainedJobs: 1,
            active: activeRows.count,
            running: activeRows.count,
            inputRequired: 0,
            approvalRequired: 0,
            terminating: 0,
            needsAttention: 0,
            backgroundProcesses: 0,
            backgroundProcessAgents: 0,
            runtimeUnknownAgents: 0,
            runtimeProbeSkippedAgents: 0,
            completed: terminalRows.count,
            failed: 0,
            interrupted: 0,
            cancelled: 0,
            idleAgents: idleRows.count,
            orphanedAgents: 0
        ),
        activeRows: activeRows,
        terminalRows: terminalRows,
        idleRows: idleRows,
        pagination: DashboardPagination(
            active: dashboardPage(
                offset: 0,
                returned: activeRows.count,
                total: activeRows.count,
                hasNext: false
            ),
            terminal: terminalPage,
            idle: idlePage
        ),
        uiLocalePreference: "auto"
    )
}

private func dashboardPage(
    offset: Int,
    returned: Int,
    total: Int,
    hasNext: Bool
) -> DashboardPage {
    DashboardPage(
        offset: offset,
        limit: 12,
        returned: returned,
        total: total,
        returnedConversations: returned,
        conversationTotal: total,
        hasPrevious: offset > 0,
        hasNext: hasNext
    )
}

private func dashboardRow(_ key: String, bucket: String) -> DashboardRow {
    DashboardRow(
        rowKey: key,
        activityKey: "activity-\(key)",
        conversationKey: "conversation-\(key)",
        sessionAlias: "session-\(key)",
        conversationUrl: nil,
        codexThreadUrl: nil,
        bucket: bucket,
        projectKey: "project-\(key)",
        projectName: "Project",
        agentName: "Agent",
        activityTitle: "Activity",
        execution: nil,
        status: bucket == "active" ? "running" : bucket == "idle" ? "idle" : "completed",
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        elapsedMs: 0,
        backgroundProcessCount: 0,
        latestTurn: nil,
        history: [],
        historyCount: 0
    )
}
