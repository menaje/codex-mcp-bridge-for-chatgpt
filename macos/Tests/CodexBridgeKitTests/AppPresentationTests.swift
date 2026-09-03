import XCTest
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

final class AppPresentationTests: XCTestCase {
    func testBrandMarkScalesInsideItsSquare() {
        let bounds = CGRect(x: 0, y: 0, width: 18, height: 18)
        let mark = BridgeBrandMarkShape().path(in: bounds).boundingRect

        XCTAssertGreaterThan(mark.width, 10)
        XCTAssertGreaterThan(mark.height, 10)
        XCTAssertTrue(bounds.contains(mark))
    }

    @MainActor
    func testMenuBarBrandImagesAreDistinctTemplates() {
        let healthy = BridgeMenuBarIcon.templateImage(for: .healthy)
        let attention = BridgeMenuBarIcon.templateImage(for: .attention)
        let unavailable = BridgeMenuBarIcon.templateImage(for: .unavailable)

        for image in [healthy, attention, unavailable] {
            XCTAssertTrue(image.isTemplate)
            XCTAssertEqual(image.size, CGSize(width: 18, height: 18))
            XCTAssertNotNil(image.tiffRepresentation)
        }
        XCTAssertNotEqual(healthy.tiffRepresentation, attention.tiffRepresentation)
        XCTAssertNotEqual(attention.tiffRepresentation, unavailable.tiffRepresentation)
    }

    @MainActor
    func testLoginItemRegistrationUsesSystemStateWithoutSharedSettings() {
        let controller = TestLoginItemController(status: .notRegistered)
        let model = AppModel(loginItemController: controller)

        XCTAssertEqual(model.menuBarLoginItemStatus, .notRegistered)
        model.setMenuBarLaunchAtLogin(true)
        XCTAssertEqual(controller.registerCalls, 1)
        XCTAssertEqual(model.menuBarLoginItemStatus, .enabled)

        model.setMenuBarLaunchAtLogin(false)
        XCTAssertEqual(controller.unregisterCalls, 1)
        XCTAssertEqual(model.menuBarLoginItemStatus, .notRegistered)
        XCTAssertNil(model.loginItemErrorMessage)
    }

    @MainActor
    func testLoginItemApprovalOpensSystemSettingsInsteadOfReregistering() {
        let controller = TestLoginItemController(status: .requiresApproval)
        let model = AppModel(loginItemController: controller)

        model.setMenuBarLaunchAtLogin(true)

        XCTAssertEqual(controller.registerCalls, 0)
        XCTAssertEqual(controller.openSystemSettingsCalls, 1)
        XCTAssertEqual(model.menuBarLoginItemStatus, .requiresApproval)
    }

    @MainActor
    func testLoginItemRegistrationFailureKeepsActualSystemState() {
        let controller = TestLoginItemController(status: .notRegistered)
        controller.registrationError = TestLoginItemError.denied
        let model = AppModel(loginItemController: controller)

        model.setMenuBarLaunchAtLogin(true)

        XCTAssertEqual(model.menuBarLoginItemStatus, .notRegistered)
        XCTAssertNotNil(model.loginItemErrorMessage)
        XCTAssertFalse(model.loginItemOperationInProgress)
    }

    @MainActor
    func testHealthyRuntimeStillRequiresCodexAuthentication() throws {
        let model = AppModel()
        model.helperStatus = try helperStatus()

        XCTAssertEqual(model.health, .attention)
        model.authStatus = try loginStatus(installed: true, authenticated: false)
        XCTAssertEqual(model.health, .attention)
        model.authStatus = try loginStatus(installed: false, authenticated: false)
        XCTAssertEqual(model.health, .unavailable)
        model.authStatus = try loginStatus(installed: true, authenticated: true)
        XCTAssertEqual(model.health, .attention)
        model.dashboard = try dashboardStatus()
        XCTAssertEqual(model.health, .healthy)
        model.dashboard = try dashboardStatus(runtimeUnknownAgents: 18)
        XCTAssertEqual(model.health, .healthy)
        model.dashboardErrorMessage = "stale"
        XCTAssertEqual(model.health, .attention)
    }

    func testSettingsDraftPreservesUnavailableSavedSelectionUntilPolicyChanges() throws {
        let saved = ModelChoice(model: "gpt-saved", reasoningEffort: "ultra")
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "fixed",
                "selection": choiceObject(saved),
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])],
            operatorCeiling: [ModelChoice(model: "gpt-current", reasoningEffort: "high")]
        )
        var draft = SettingsDraft(snapshot: snapshot)

        XCTAssertFalse(draft.modelPolicyDirty)
        XCTAssertTrue(SettingsDraft.displayedChoices(
            in: snapshot,
            allowDelegation: true
        ).contains(saved))
        XCTAssertFalse(SettingsDraft.selectableChoices(
            in: snapshot,
            allowDelegation: true
        ).contains(saved))

        draft.accessStrategy = "read-only"
        XCTAssertFalse(draft.modelPolicyDirty)
        draft.allowDelegation = false
        XCTAssertTrue(draft.modelPolicyDirty)
    }

    func testSettingsDraftIgnoresRetiredAutomaticDefaultsWithoutDirtyingPolicy() throws {
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            legacyPreferredModel: "gpt-legacy",
            catalogModels: [catalogModel(id: "gpt-legacy", efforts: ["medium", "high"], defaultEffort: "high")]
        )
        let draft = SettingsDraft(snapshot: snapshot)

        XCTAssertFalse(draft.modelPolicyDirty)
    }

    func testSettingsDraftDoesNotInventMissingAutomaticDefault() throws {
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let draft = SettingsDraft(snapshot: snapshot)

        XCTAssertFalse(draft.modelPolicyDirty)
    }

    func testSettingsDraftDeduplicatesCatalogChoices() throws {
        let duplicate = catalogModel(id: "gpt-current", efforts: ["high"])
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [duplicate, duplicate]
        )

        XCTAssertEqual(
            SettingsDraft.selectableChoices(in: snapshot, allowDelegation: true),
            [ModelChoice(model: "gpt-current", reasoningEffort: "high")]
        )
    }

    func testHidingActivityCardAlsoDisablesAutomaticHandoff() throws {
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        var draft = SettingsDraft(snapshot: snapshot)
        draft.completionHandoff = "auto-handoff"

        draft.setActivityCardVisibility("never")

        XCTAssertEqual(draft.activityCardVisibility, "never")
        XCTAssertEqual(draft.completionHandoff, "off")
    }

    func testSettingsRefreshPreservesDirtyDraftUntilExplicitReload() throws {
        let original = try settingsSnapshot(
            policy: [
                "mode": "fixed",
                "selection": choiceObject(
                    ModelChoice(model: "gpt-current", reasoningEffort: "high")
                ),
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let externallyChanged = try settingsSnapshot(
            settingsRevision: 5,
            accessStrategy: "read-only",
            policy: [
                "mode": "fixed",
                "selection": choiceObject(
                    ModelChoice(model: "gpt-current", reasoningEffort: "high")
                ),
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        var state = SettingsDraftSyncState()
        state.synchronize(with: original)
        var edited = try XCTUnwrap(state.draft)
        edited.maxConcurrentJobs = 3
        state.updateDraft(edited)

        state.synchronize(with: externallyChanged)

        XCTAssertEqual(state.draft?.maxConcurrentJobs, 3)
        XCTAssertEqual(state.draft?.accessStrategy, "adaptive")
        XCTAssertEqual(state.draft?.expectedSettingsRevision, 4)
        XCTAssertTrue(state.externalChangeDetected)
        state.synchronize(with: externallyChanged, force: true)
        XCTAssertEqual(state.draft?.accessStrategy, "read-only")
        XCTAssertEqual(state.draft?.maxConcurrentJobs, 2)
        XCTAssertEqual(state.draft?.expectedSettingsRevision, 5)
        XCTAssertFalse(state.externalChangeDetected)
    }

    func testDashboardLinksAcceptOnlyExpectedLocalContractShapes() {
        XCTAssertNotNil(DashboardLink.conversation(
            "https://chatgpt.com/c/00000000-0000-4000-8000-000000000001"
        ))
        XCTAssertNil(DashboardLink.conversation(
            "https://example.com/c/00000000-0000-4000-8000-000000000001"
        ))
        XCTAssertNil(DashboardLink.conversation(
            "https://chatgpt.com:444/c/00000000-0000-4000-8000-000000000001"
        ))
        XCTAssertNil(DashboardLink.conversation(
            "https://chatgpt.com/c/00000000-0000-4000-8000-000000000001/"
        ))
        XCTAssertNotNil(DashboardLink.codexThread(
            "codex://threads/00000000-0000-4000-8000-000000000001"
        ))
        XCTAssertNil(DashboardLink.codexThread("file:///private/secrets"))
    }

    func testNextExecutionComparisonIgnoresPresentationOnlyFields() throws {
        let current = try dashboardExecution(
            model: " GPT-5.6 ",
            displayName: "새 표시 이름",
            effort: "HIGH",
            reroutedModel: nil,
            isCurrent: true
        )
        let historical = try dashboardExecution(
            model: "gpt-5.6",
            displayName: "Old display name",
            effort: "high",
            reroutedModel: nil,
            isCurrent: false
        )
        XCTAssertNil(DashboardExecutionPresentation.next(
            current: current,
            latest: historical
        ))
        let changed = try dashboardExecution(
            model: "gpt-5.6-terra",
            displayName: nil,
            effort: "high",
            reroutedModel: nil,
            isCurrent: true
        )
        XCTAssertNotNil(DashboardExecutionPresentation.next(
            current: changed,
            latest: historical
        ))
        XCTAssertNotNil(DashboardExecutionPresentation.next(
            current: changed,
            latest: nil
        ))
    }

    func testDashboardHoistsOnlyExecutionSelectionsSharedByEveryAgent() throws {
        let historical = try dashboardExecution(
            model: "gpt-5.6-sol",
            displayName: "Sol",
            effort: "high",
            reroutedModel: nil,
            isCurrent: false
        )
        let current = try dashboardExecution(
            model: "gpt-5.6-terra",
            displayName: "Terra",
            effort: "max",
            reroutedModel: nil,
            isCurrent: true
        )
        let matchingRows = try [
            dashboardRow(id: "agent-a", execution: current, latestExecution: historical),
            dashboardRow(id: "agent-b", execution: current, latestExecution: historical)
        ]

        XCTAssertEqual(
            DashboardExecutionPresentation.commonHistorical(in: matchingRows)?.model,
            historical.model
        )
        XCTAssertEqual(
            DashboardExecutionPresentation.commonNext(in: matchingRows)?.model,
            current.model
        )

        let different = try dashboardExecution(
            model: "gpt-5.6-terra",
            displayName: "Terra",
            effort: "high",
            reroutedModel: nil,
            isCurrent: true
        )
        let mixedRows = try [
            matchingRows[0],
            dashboardRow(id: "agent-c", execution: different, latestExecution: historical)
        ]
        XCTAssertNil(DashboardExecutionPresentation.commonNext(in: mixedRows))
        XCTAssertNil(DashboardExecutionPresentation.commonHistorical(in: [matchingRows[0]]))
    }
}

@MainActor
private final class TestLoginItemController: LoginItemControlling {
    var status: MenuBarLoginItemStatus
    var registrationError: Error?
    var unregistrationError: Error?
    private(set) var registerCalls = 0
    private(set) var unregisterCalls = 0
    private(set) var openSystemSettingsCalls = 0

    init(status: MenuBarLoginItemStatus) {
        self.status = status
    }

    func register() throws {
        registerCalls += 1
        if let registrationError { throw registrationError }
        status = .enabled
    }

    func unregister() throws {
        unregisterCalls += 1
        if let unregistrationError { throw unregistrationError }
        status = .notRegistered
    }

    func openSystemSettings() {
        openSystemSettingsCalls += 1
    }
}

private enum TestLoginItemError: LocalizedError {
    case denied

    var errorDescription: String? {
        "승인되지 않음"
    }
}

private func helperStatus() throws -> HelperStatus {
    let json = #"""
    {
      "kind":"helper-status","generatedAt":"2026-09-03T00:00:00.000Z",
      "phase":"running","pid":42,"startedAt":null,"lastExit":null,"lastError":null,
      "restartAttempt":0,
      "configuration":{"path":"/private/.env","exists":true,"valid":true,"hasApiKey":true,"hasTunnelId":true,"tunnelId":"tunnel_native123","issue":null},
      "bridge":{"socketPath":"/private/bridge.sock","connected":true,"acceptingNewJobs":true,"activeJobs":0,"pendingAdmissions":0,"backgroundProcessState":"confirmed","backgroundProcesses":0,"backgroundProcessAgents":0,"backgroundProcessUnknownAgents":0},
      "tunnel":{"phase":"connected","profile":"managed","transport":"stdio","doctorPassed":true,"processRunning":true,"connected":true,"lastCheckedAt":null,"lastError":null}
    }
    """#.data(using: .utf8)!
    return try JSONDecoder().decode(HelperStatus.self, from: json)
}

private func loginStatus(installed: Bool, authenticated: Bool) throws -> CodexLoginStatus {
    let data = try JSONSerialization.data(withJSONObject: [
        "installed": installed,
        "authenticated": authenticated,
        "summary": authenticated ? "ready" : "login required"
    ])
    return try JSONDecoder().decode(CodexLoginStatus.self, from: data)
}

private func dashboardStatus(runtimeUnknownAgents: Int = 0) throws -> DashboardSnapshot {
    let counts: [String: Any] = [
        "trackedProjects": 0,
        "trackedConversations": 0,
        "retainedJobs": 0,
        "active": 0,
        "running": 0,
        "inputRequired": 0,
        "approvalRequired": 0,
        "terminating": 0,
        "needsAttention": 0,
        "backgroundProcesses": 0,
        "backgroundProcessAgents": 0,
        "runtimeUnknownAgents": runtimeUnknownAgents,
        "runtimeProbeSkippedAgents": 0,
        "completed": 0,
        "failed": 0,
        "interrupted": 0,
        "cancelled": 0,
        "idleAgents": 0,
        "orphanedAgents": 0
    ]
    let page: [String: Any] = [
        "offset": 0,
        "limit": 12,
        "returned": 0,
        "total": 0,
        "returnedConversations": 0,
        "conversationTotal": 0,
        "hasPrevious": false,
        "hasNext": false
    ]
    let data = try JSONSerialization.data(withJSONObject: [
        "kind": "dashboard",
        "generatedAt": "2026-09-03T00:00:00.000Z",
        "scope": "bridge-wide",
        "statusSource": "codex-runtime-only",
        "coverage": "complete",
        "counts": counts,
        "activeRows": [],
        "terminalRows": [],
        "idleRows": [],
        "pagination": ["active": page, "terminal": page, "idle": page],
        "uiLocalePreference": "auto"
    ])
    return try JSONDecoder().decode(DashboardSnapshot.self, from: data)
}

private func settingsSnapshot(
    settingsRevision: Int = 4,
    accessStrategy: String = "adaptive",
    policy: [String: Any],
    legacyPreferredModel: String? = nil,
    catalogModels: [[String: Any]],
    operatorCeiling: [ModelChoice]? = nil
) throws -> SettingsSnapshot {
    var settings: [String: Any] = [
        "schemaVersion": 1,
        "settingsRevision": settingsRevision,
        "registryRevision": 2,
        "revision": settingsRevision,
        "accessStrategy": accessStrategy,
        "modelPolicy": policy,
        "usePriorityServiceTier": false,
        "projects": [],
        "uiLocalePreference": "auto",
        "maxConcurrentJobs": 2,
        "showBridgeThreadsInCodexApp": true,
        "activityCardVisibility": "always",
        "completionHandoff": "off"
    ]
    if let legacyPreferredModel {
        settings["legacyPreferredModel"] = legacyPreferredModel
    }
    var capabilities: [String: Any] = [
        "availableAccessStrategies": ["read-only", "adaptive"],
        "availableUiLocalePreferences": ["auto", "ko", "en"],
        "availableActivityCardVisibilities": ["always", "background-only", "never"],
        "availableCompletionHandoffs": ["off", "auto-handoff"],
        "projectAvailability": [],
        "maxConcurrentJobs": 4,
        "defaultBackend": "mcp-server",
        "allowWorkspaceWrite": true,
        "allowDangerFullAccess": false,
        "persistent": true
    ]
    if let operatorCeiling {
        capabilities["operatorModelCeiling"] = operatorCeiling.map(choiceObject)
    }
    let object: [String: Any] = [
        "settings": settings,
        "operatorDefaults": settings,
        "capabilities": capabilities,
        "catalog": [
            "cached": false,
            "stale": false,
            "lastKnownGood": false,
            "validation": "valid",
            "translationCoverage": ["missingEffortIds": []],
            "models": catalogModels
        ],
        "warnings": [],
        "scopeNotice": "test",
        "policyActivation": [
            "policyRevision": settingsRevision,
            "executionPolicyActive": true,
            "descriptorProjectionUpdated": false,
            "developerModeRefreshRequired": false
        ]
    ]
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(SettingsSnapshot.self, from: data)
}

private func choiceObject(_ choice: ModelChoice) -> [String: Any] {
    ["model": choice.model, "reasoningEffort": choice.reasoningEffort]
}

private func catalogModel(
    id: String,
    efforts: [String],
    defaultEffort: String? = nil
) -> [String: Any] {
    var model: [String: Any] = [
        "id": id,
        "displayName": id,
        "supportedReasoningEfforts": efforts.map { ["effort": $0] },
        "serviceTiers": [],
        "inputModalities": ["text"]
    ]
    if let defaultEffort { model["defaultReasoningEffort"] = defaultEffort }
    return model
}

private func dashboardExecution(
    model: String,
    displayName: String?,
    effort: String,
    reroutedModel: String?,
    isCurrent: Bool
) throws -> DashboardExecution {
    var object: [String: Any] = [
        "model": model,
        "reasoningEffort": effort,
        "isCurrent": isCurrent
    ]
    if let displayName { object["modelDisplayName"] = displayName }
    if let reroutedModel { object["reroutedModel"] = reroutedModel }
    return try JSONDecoder().decode(
        DashboardExecution.self,
        from: JSONSerialization.data(withJSONObject: object)
    )
}

private func dashboardRow(
    id: String,
    execution: DashboardExecution?,
    latestExecution: DashboardExecution?
) throws -> DashboardRow {
    var row: [String: Any] = [
        "rowKey": id,
        "activityKey": "activity-shared",
        "conversationKey": "conversation-shared",
        "sessionAlias": "Session TEST",
        "bucket": "idle",
        "projectKey": "project-shared",
        "agentName": id,
        "status": "idle",
        "createdAt": "2026-09-03T00:00:00.000Z",
        "updatedAt": "2026-09-03T00:01:00.000Z",
        "elapsedMs": 60_000,
        "backgroundProcessCount": 0,
        "history": [],
        "historyCount": 0
    ]
    if let execution {
        row["execution"] = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(execution)
        )
    }
    if let latestExecution {
        row["latestTurn"] = [
            "activityKey": "activity-shared",
            "activityTitle": "Shared Activity",
            "execution": try JSONSerialization.jsonObject(
                with: JSONEncoder().encode(latestExecution)
            ),
            "status": "completed",
            "startedAt": "2026-09-03T00:00:00.000Z",
            "updatedAt": "2026-09-03T00:01:00.000Z",
            "endedAt": "2026-09-03T00:01:00.000Z",
            "durationMs": 60_000
        ]
    }
    return try JSONDecoder().decode(
        DashboardRow.self,
        from: JSONSerialization.data(withJSONObject: row)
    )
}
