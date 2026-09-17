import XCTest
@testable import CodexBridgeKit

final class BridgeModelsTests: XCTestCase {
    func testBridgeProjectDecodesTheServerProjectContract() throws {
        let data = #"""
        {
          "id":"project-1",
          "projectRef":"project_ref_1",
          "projectRevision":3,
          "name":"Bridge",
          "nameKey":"bridge",
          "cwd":"/private/bridge",
          "sortOrder":0,
          "createdAt":1700000000000,
          "updatedAt":1700000001000
        }
        """#.data(using: .utf8)!

        let project = try JSONDecoder().decode(BridgeProject.self, from: data)

        XCTAssertEqual(project.id, "project-1")
        XCTAssertEqual(project.name, "Bridge")
        XCTAssertEqual(project.cwd, "/private/bridge")
        XCTAssertNil(project.archivedAt)
    }

    func testBridgeSkillMutationAndVersionContractsPreserveFreeformMarkdown() throws {
        let create = BridgeSkillCreateRequest(
            requestId: "00000000-0000-4000-8000-000000000114",
            name: "Report review",
            description: "Review a report with evidence.",
            content: "# Review\n\nCheck each claim against its source.",
            files: [.init(path: "references/evidence.md", content: "# Evidence")]
        )
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(create)) as? [String: Any])
        XCTAssertEqual(encoded["requestId"] as? String, "00000000-0000-4000-8000-000000000114")
        XCTAssertEqual(encoded["content"] as? String, "# Review\n\nCheck each claim against its source.")
        XCTAssertNil(encoded["document"])
        XCTAssertEqual((encoded["files"] as? [[String: Any]])?.first?["path"] as? String, "references/evidence.md")
        XCTAssertNil(encoded["instructions"])
        XCTAssertNil(encoded["references"])

        let history = try JSONDecoder().decode(
            BridgeSkillVersionList.self,
            from: Data(#"""
            {
              "skillId":"bridge_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "source":"bridge",
              "currentVersion":"2",
              "enabled":true,
              "versions":[{
                "skillId":"bridge_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "source":"bridge",
                "version":"2",
                "name":"Report review",
                "description":"Review a report with evidence.",
                "contentDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "createdAt":"2026-09-15T00:00:00.000Z",
                "format":"markdown",
                "legacy":false
              }]
            }
            """#.utf8)
        )
        XCTAssertEqual(history.currentVersion, "2")
        XCTAssertEqual(history.versions.first?.reference.version, "2")
        XCTAssertEqual(history.versions.first?.format, "markdown")
        XCTAssertFalse(history.versions.first?.legacy ?? true)

        let skill = try JSONDecoder().decode(
            BridgeSkill.self,
            from: Data(#"""
            {
              "skill":{
                "skillId":"bridge_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "source":"bridge",
                "version":"2",
                "name":"Report review",
                "description":"Review a report with evidence.",
                "contentDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "enabled":true,
                "availability":"available"
              },
              "content":"# Review\r\n\r\n- preserve source",
              "files":[{
                "path":"references/evidence.md",
                "format":"markdown",
                "bytes":10,
                "contentDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
              }],
              "format":"markdown",
              "legacy":false,
              "sourceSnapshot":"versioned-bridge-record",
              "warnings":[]
            }
            """#.utf8)
        )
        XCTAssertEqual(skill.content, "# Review\r\n\r\n- preserve source")
        XCTAssertEqual(skill.format, "markdown")
        XCTAssertFalse(skill.legacy)
        XCTAssertEqual(skill.files.first?.path, "references/evidence.md")

        let deletion = BridgeSkillDeleteRequest(
            requestId: "00000000-0000-4000-8000-000000000115",
            skillId: "bridge_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            expectedVersion: "2"
        )
        let deletionJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(deletion)) as? [String: Any])
        XCTAssertNil(deletionJSON["confirmName"])

        let deleted = try JSONDecoder().decode(
            BridgeSkillDeletion.self,
            from: Data(#"""
            {
              "skillId":"bridge_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "source":"bridge",
              "deletedAt":"2026-09-15T00:00:00.000Z"
            }
            """#.utf8)
        )
        XCTAssertEqual(deleted.skillId, deletion.skillId)
        XCTAssertEqual(deleted.source, "bridge")

        let packageUpdate = BridgeSkillPackageUpdateRequest(
            requestId: "00000000-0000-4000-8000-000000000116",
            skillId: deletion.skillId,
            expectedVersion: "2",
            uploadId: "00000000-0000-4000-8000-000000000117",
            mainPath: nil,
            includePaths: ["references/evidence.md"]
        )
        let packageJSON = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(packageUpdate)) as? [String: Any]
        )
        XCTAssertTrue(packageJSON["mainPath"] is NSNull)
        XCTAssertEqual(packageJSON["includePaths"] as? [String], ["references/evidence.md"])
    }

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
                dashboardAutoOpenBackground: true,
                completionFollowUp: true
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
        XCTAssertEqual(settings["dashboardAutoOpenBackground"] as? Bool, true)
        XCTAssertEqual(settings["completionFollowUp"] as? Bool, true)
        XCTAssertNil(settings["activityCard"])
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

    func testNativeCompletionNotificationDecodesOnlyItsOpaqueReceipt() throws {
        let notification = try JSONDecoder().decode(
            NativeCompletionNotification.self,
            from: Data(#"{"eventId":"completion-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","outboxId":7}"#.utf8)
        )
        XCTAssertEqual(notification.id, notification.eventId)
        XCTAssertEqual(notification.outboxId, 7)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(notification)) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), ["eventId", "outboxId"])
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
                "setup.discovery.import",
                "runtime.configure",
                "helper.prepare-shutdown"
            ]
        )
        XCTAssertTrue(HelperBootstrap.isCompatible(compatible, runtimeBuildID: "build-current"))
        XCTAssertFalse(HelperBootstrap.isCompatible(compatible, runtimeBuildID: "build-old"))
        XCTAssertFalse(HelperBootstrap.isCompatible(
            try hello(
                name: HelperHello.expectedProtocolName,
                version: HelperHello.expectedProtocolVersion,
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
                version: 1,
                buildID: "build-current",
                capabilities: [
                    "setup.dotenv.atomic-apply",
                    "setup.dotenv.repair-permissions",
                    "setup.discovery.import",
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

    func testTunnelSetupInputParserExtractsBothValuesFromOnePaste() {
        let secret = "sk-pasted-1234567890123456"
        let tunnelID = "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        let parsed = TunnelSetupInputParser.parse("""
        CONTROL_PLANE_API_KEY=\(secret)
        CONTROL_PLANE_TUNNEL_ID=\(tunnelID)
        """)

        XCTAssertEqual(parsed.apiKey, secret)
        XCTAssertEqual(parsed.tunnelId, tunnelID)
        XCTAssertFalse(parsed.isEmpty)
        XCTAssertTrue(TunnelSetupInputParser.parse("unrelated text").isEmpty)
        XCTAssertNil(TunnelSetupInputParser.parse("prefix\(tunnelID)x").tunnelId)
        XCTAssertNil(TunnelSetupInputParser.parse("\(tunnelID)_extra").tunnelId)
        XCTAssertNil(
            TunnelSetupInputParser.parse("sk-admin-12345678901234567890").apiKey
        )
    }

    func testTunnelSetupDiscoveryDecodesOnlyRedactedCandidateMetadata() throws {
        let data = #"""
        {
          "kind":"setup-discovery",
          "candidates":[{
            "id":"setup_aaaaaaaaaaaaaaaaaaaaaaaa",
            "source":"tunnel-client-profile",
            "profileName":"local",
            "tunnelId":"tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "hasApiKey":true,
            "apiKeySource":"profile-file"
          }]
        }
        """#.data(using: .utf8)!

        let discovery = try JSONDecoder().decode(TunnelSetupDiscovery.self, from: data)

        XCTAssertEqual(discovery.kind, "setup-discovery")
        XCTAssertEqual(discovery.candidates.first?.profileName, "local")
        XCTAssertEqual(discovery.candidates.first?.apiKeySource, "profile-file")
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("sk-"))
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
        codexAccount: nil,
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
            responseRequired: nil,
            problems: nil,
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
        tokenUsage: nil,
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
