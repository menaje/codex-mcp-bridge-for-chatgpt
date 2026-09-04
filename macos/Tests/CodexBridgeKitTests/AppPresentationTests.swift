import Darwin
import AppKit
import XCTest
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

final class AppPresentationTests: XCTestCase {
    @MainActor
    func testPrimaryAppWindowsUseStageManagerPrimaryBehavior() {
        let window = NSWindow(
            contentRect: .zero,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )

        PrimaryAppWindowPresentation.configure(window)

        XCTAssertEqual(window.level, .normal)
        XCTAssertTrue(window.collectionBehavior.contains(.managed))
        XCTAssertTrue(window.collectionBehavior.contains(.primary))
        XCTAssertTrue(window.collectionBehavior.contains(.participatesInCycle))
        XCTAssertFalse(window.collectionBehavior.contains(.auxiliary))
        XCTAssertFalse(window.collectionBehavior.contains(.canJoinAllApplications))
    }

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

    func testSettingsAutosaveAcknowledgementRebasesNewerEdits() throws {
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
        let persisted = try settingsSnapshot(
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
        var submitted = try XCTUnwrap(state.draft)
        submitted.accessStrategy = "read-only"
        state.updateDraft(submitted)
        var newer = submitted
        newer.maxConcurrentJobs = 3
        state.updateDraft(newer)

        state.acknowledgePersisted(snapshot: persisted, submitted: submitted)

        XCTAssertEqual(state.draft?.expectedSettingsRevision, 5)
        XCTAssertEqual(state.draft?.accessStrategy, "read-only")
        XCTAssertEqual(state.draft?.maxConcurrentJobs, 3)
        XCTAssertFalse(state.externalChangeDetected)
    }

    @MainActor
    func testUnchangedSettingsDraftDoesNotEnterAutosaveQueue() throws {
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let model = AppModel()
        model.settings = snapshot

        model.scheduleSettingsAutosave(SettingsDraft(snapshot: snapshot))

        XCTAssertEqual(model.generalSettingsSaveState, .idle)
    }

    @MainActor
    func testDashboardCanEnableCodexThreadPersistenceThroughAutosave() throws {
        let snapshot = try settingsSnapshot(
            showBridgeThreadsInCodexApp: false,
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let model = AppModel()
        model.settings = snapshot

        model.enableCodexThreadPersistence()

        XCTAssertEqual(model.generalSettingsSaveState, .pending)
        model.cancelPendingSettingsAutosave()
    }

    @MainActor
    func testApplicationShutdownStopsWhenPendingSettingsCannotBeSaved() async throws {
        let root = URL(fileURLWithPath:
            "/tmp/cb-save-\(getpid())-\(UUID().uuidString.prefix(8))",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = RuntimePaths(
            environment: [
                "XDG_CONFIG_HOME": root.path,
                "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1",
                "PATH": ProcessInfo.processInfo.environment["PATH"] ?? ""
            ],
            bundle: .main,
            currentDirectory: root
        )
        try FileManager.default.createDirectory(
            at: paths.bridgeSocket.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let listener = try makeTestListener(at: paths.bridgeSocket.path)
        defer {
            Darwin.close(listener)
            unlink(paths.bridgeSocket.path)
        }
        let server = Task.detached {
            try serveSettingsFailureOnce(listener: listener)
        }
        let snapshot = try settingsSnapshot(
            policy: [
                "mode": "automatic",
                "allowedSelections": ["kind": "catalog-visible"],
                "constraints": ["allowDelegation": true]
            ],
            catalogModels: [catalogModel(id: "gpt-current", efforts: ["high"])]
        )
        let model = AppModel(
            paths: paths,
            loginItemController: TestLoginItemController(status: .notRegistered)
        )
        model.settings = snapshot
        var edited = SettingsDraft(snapshot: snapshot)
        edited.maxConcurrentJobs = 3
        model.scheduleSettingsAutosave(edited)

        let didShutdown = await model.shutdownApplication(force: true)

        try await server.value
        XCTAssertFalse(didShutdown)
        XCTAssertFalse(model.applicationShutdownCompleted)
        XCTAssertEqual(model.generalSettingsSaveState, .failed)
        XCTAssertNotNil(model.runtimeErrorMessage)
    }

    @MainActor
    func testApplicationShutdownUsesVerifiedHelperPreparation() async throws {
        let root = URL(fileURLWithPath:
            "/tmp/cb-quit-\(getpid())-\(UUID().uuidString.prefix(8))",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = RuntimePaths(
            environment: [
                "XDG_CONFIG_HOME": root.path,
                "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1",
                "PATH": ProcessInfo.processInfo.environment["PATH"] ?? ""
            ],
            bundle: .main,
            currentDirectory: root
        )
        try FileManager.default.createDirectory(
            at: paths.helperSocket.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let listener = try makeTestListener(at: paths.helperSocket.path)
        defer {
            Darwin.close(listener)
            unlink(paths.helperSocket.path)
        }
        let server = Task.detached {
            try serveHelperShutdownOnce(listener: listener)
        }
        let model = AppModel(
            paths: paths,
            loginItemController: TestLoginItemController(status: .notRegistered)
        )

        let didShutdown = await model.shutdownApplication(force: true)
        let method = try await server.value

        XCTAssertTrue(didShutdown)
        XCTAssertTrue(model.applicationShutdownCompleted)
        XCTAssertEqual(method, "helper.prepare-shutdown")
        XCTAssertNil(model.runtimeErrorMessage)
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
    showBridgeThreadsInCodexApp: Bool = true,
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
        "showBridgeThreadsInCodexApp": showBridgeThreadsInCodexApp,
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

private func makeTestListener(at socketPath: String) throws -> Int32 {
    unlink(socketPath)
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw POSIXError(.EIO) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8)
    guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
        Darwin.close(descriptor)
        throw POSIXError(.ENAMETOOLONG)
    }
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        destination.initializeMemory(as: UInt8.self, repeating: 0)
        destination.copyBytes(from: pathBytes)
    }
    let length = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count + 1)
    let bound = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(descriptor, $0, length)
        }
    }
    guard bound == 0, Darwin.listen(descriptor, 1) == 0 else {
        Darwin.close(descriptor)
        throw POSIXError(.EADDRINUSE)
    }
    return descriptor
}

private func serveHelperShutdownOnce(listener: Int32) throws -> String {
    let connection = Darwin.accept(listener, nil, nil)
    guard connection >= 0 else { throw POSIXError(.ECONNABORTED) }
    defer { Darwin.close(connection) }
    var buffer = [UInt8](repeating: 0, count: 16 * 1_024)
    let count = Darwin.read(connection, &buffer, buffer.count)
    guard count > 0,
          let request = try JSONSerialization.jsonObject(
            with: Data(buffer.prefix(count))
          ) as? [String: Any],
          let requestID = request["id"] as? String,
          let method = request["method"] as? String else {
        throw POSIXError(.EIO)
    }
    let response = try JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0",
        "id": requestID,
        "result": [
            "kind": "helper-status",
            "generatedAt": "2026-09-03T00:00:00.000Z",
            "phase": "stopped",
            "pid": NSNull(),
            "startedAt": NSNull(),
            "lastExit": NSNull(),
            "lastError": NSNull(),
            "restartAttempt": 0,
            "configuration": [
                "path": "/private/.env",
                "exists": true,
                "valid": true,
                "hasApiKey": true,
                "hasTunnelId": true,
                "tunnelId": "tunnel_native123",
                "issue": NSNull()
            ],
            "bridge": [
                "socketPath": "/private/bridge.sock",
                "connected": false,
                "acceptingNewJobs": NSNull(),
                "activeJobs": NSNull(),
                "pendingAdmissions": NSNull(),
                "backgroundProcessState": NSNull(),
                "backgroundProcesses": NSNull(),
                "backgroundProcessAgents": NSNull(),
                "backgroundProcessUnknownAgents": NSNull()
            ],
            "tunnel": [
                "phase": "stopped",
                "profile": NSNull(),
                "transport": NSNull(),
                "doctorPassed": false,
                "processRunning": false,
                "connected": false,
                "lastCheckedAt": NSNull(),
                "lastError": NSNull()
            ]
        ]
    ]) + Data([0x0A])
    try writeTestResponse(response, to: connection)
    return method
}

private func serveSettingsFailureOnce(listener: Int32) throws {
    let connection = Darwin.accept(listener, nil, nil)
    guard connection >= 0 else { throw POSIXError(.ECONNABORTED) }
    defer { Darwin.close(connection) }
    var buffer = [UInt8](repeating: 0, count: 16 * 1_024)
    let count = Darwin.read(connection, &buffer, buffer.count)
    guard count > 0,
          let request = try JSONSerialization.jsonObject(
            with: Data(buffer.prefix(count))
          ) as? [String: Any],
          let requestID = request["id"] as? String else {
        throw POSIXError(.EIO)
    }
    let response = try JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0",
        "id": requestID,
        "error": ["code": -32602, "message": "settings save failed"]
    ]) + Data([0x0A])
    try writeTestResponse(response, to: connection)
}

private func writeTestResponse(_ response: Data, to connection: Int32) throws {
    try response.withUnsafeBytes { bytes in
        guard let base = bytes.baseAddress else { return }
        var sent = 0
        while sent < bytes.count {
            let written = Darwin.write(connection, base.advanced(by: sent), bytes.count - sent)
            guard written > 0 else { throw POSIXError(.EPIPE) }
            sent += written
        }
    }
}
