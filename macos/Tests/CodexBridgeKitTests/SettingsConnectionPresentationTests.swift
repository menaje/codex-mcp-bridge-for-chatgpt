import XCTest
@testable import CodexBridgeMenuBar

final class SettingsConnectionPresentationTests: XCTestCase {
    func testSettingsSidebarAvailabilityMatchesConnectionContext() {
        let local = SettingsNavigationPane.allCases.filter {
            $0.isAvailable(isRemoteClient: false, hasSettings: true, needsSetup: false)
        }
        XCTAssertEqual(local, [.general, .modelExecution, .projects, .codex, .connection, .server])

        let remote = SettingsNavigationPane.allCases.filter {
            $0.isAvailable(isRemoteClient: true, hasSettings: true, needsSetup: false)
        }
        XCTAssertEqual(remote, [.general, .modelExecution, .projects, .connection])

        let firstRun = SettingsNavigationPane.allCases.filter {
            $0.isAvailable(isRemoteClient: false, hasSettings: false, needsSetup: true)
        }
        XCTAssertEqual(firstRun, [.general, .codex, .connection])
        XCTAssertFalse(local.map(\.rawValue).contains("skills"))
    }

    func testSettingsSelectionMigratesRemovedAndUnavailablePanes() {
        let available: [SettingsNavigationPane] = [.general, .connection]
        XCTAssertEqual(
            SettingsNavigationPane.resolved(
                rawValue: "skills",
                available: available,
                needsSetup: false
            ),
            .general
        )
        XCTAssertEqual(
            SettingsNavigationPane.resolved(
                rawValue: "server",
                available: available,
                needsSetup: true
            ),
            .connection
        )
    }

    func testConnectionSetupJourneyKeepsLocalAndRemoteTasksFocused() {
        XCTAssertEqual(
            ConnectionSetupJourney.steps(for: .localHost),
            [.role, .discovery, .credentials, .codexLogin, .complete]
        )
        XCTAssertEqual(
            ConnectionSetupJourney.steps(for: .remoteClient),
            [.role, .remoteConnection, .complete]
        )
        XCTAssertEqual(
            ConnectionSetupJourney.previous(from: .codexLogin, role: .localHost),
            .credentials
        )
        XCTAssertNil(ConnectionSetupJourney.previous(from: .role, role: .remoteClient))
    }

    func testDiscoveryUsesCandidatesBeforeManualCredentials() {
        XCTAssertEqual(
            ConnectionSetupJourney.discoveryAction(
                candidateID: nil,
                candidateTunnelID: nil,
                candidateHasAPIKey: false,
                savedAPIKeyAvailable: false
            ),
            .enterCredentials(prefilledTunnelID: nil)
        )
        XCTAssertEqual(
            ConnectionSetupJourney.discoveryAction(
                candidateID: "complete",
                candidateTunnelID: "tunnel_complete",
                candidateHasAPIKey: true,
                savedAPIKeyAvailable: false
            ),
            .importCandidate(id: "complete")
        )
        XCTAssertEqual(
            ConnectionSetupJourney.discoveryAction(
                candidateID: "id-only",
                candidateTunnelID: "tunnel_id_only",
                candidateHasAPIKey: false,
                savedAPIKeyAvailable: false
            ),
            .enterCredentials(prefilledTunnelID: "tunnel_id_only")
        )
        XCTAssertEqual(
            ConnectionSetupJourney.discoveryAction(
                candidateID: "id-with-saved-key",
                candidateTunnelID: "tunnel_saved",
                candidateHasAPIKey: false,
                savedAPIKeyAvailable: true
            ),
            .importCandidate(id: "id-with-saved-key")
        )
    }

    func testCodexSetupSeparatesCheckingLoginInstallationAndCompletion() {
        XCTAssertEqual(
            ConnectionSetupJourney.codexAction(
                installed: nil,
                authenticated: nil,
                loginInProgress: false,
                statusCheckFailed: false
            ),
            .waitForStatus
        )
        XCTAssertEqual(
            ConnectionSetupJourney.codexAction(
                installed: true,
                authenticated: false,
                loginInProgress: false,
                statusCheckFailed: false
            ),
            .startBrowserLogin
        )
        XCTAssertEqual(
            ConnectionSetupJourney.codexAction(
                installed: false,
                authenticated: false,
                loginInProgress: false,
                statusCheckFailed: false
            ),
            .openInstallationSettings
        )
        XCTAssertEqual(
            ConnectionSetupJourney.codexAction(
                installed: true,
                authenticated: true,
                loginInProgress: false,
                statusCheckFailed: false
            ),
            .finish
        )
        XCTAssertEqual(
            ConnectionSetupJourney.codexAction(
                installed: nil,
                authenticated: nil,
                loginInProgress: false,
                statusCheckFailed: true
            ),
            .startBrowserLogin
        )
    }

    func testRecoveryRecommendsAnActionThatCanRepairEachLocalFailure() {
        XCTAssertEqual(
            ConnectionRecoveryPlan.recommendedActions(
                for: .configuration,
                isRemoteClient: false,
                configurationValid: false,
                bridgeConnected: false,
                helperPhase: "stopped",
                codexInstalled: nil,
                permissionsRepairAvailable: true
            ),
            [.configureConnection, .repairPermissions]
        )
        XCTAssertEqual(
            ConnectionRecoveryPlan.recommendedActions(
                for: .bridge,
                isRemoteClient: false,
                configurationValid: true,
                bridgeConnected: false,
                helperPhase: "stopped",
                codexInstalled: nil,
                permissionsRepairAvailable: false
            ),
            [.startRuntime]
        )
        XCTAssertEqual(
            ConnectionRecoveryPlan.recommendedActions(
                for: .bridge,
                isRemoteClient: false,
                configurationValid: true,
                bridgeConnected: false,
                helperPhase: "running",
                codexInstalled: nil,
                permissionsRepairAvailable: false
            ),
            [.restartRuntime]
        )
        XCTAssertEqual(
            ConnectionRecoveryPlan.recommendedActions(
                for: .tunnel,
                isRemoteClient: false,
                configurationValid: true,
                bridgeConnected: true,
                helperPhase: "running",
                codexInstalled: nil,
                permissionsRepairAvailable: false
            ),
            [.restartRuntime]
        )
        XCTAssertEqual(
            ConnectionRecoveryPlan.recommendedActions(
                for: .codex,
                isRemoteClient: false,
                configurationValid: true,
                bridgeConnected: true,
                helperPhase: "running",
                codexInstalled: false,
                permissionsRepairAvailable: false
            ),
            [.openCodexSettings]
        )
        XCTAssertEqual(
            ConnectionRecoveryPlan.recommendedActions(
                for: .codex,
                isRemoteClient: false,
                configurationValid: true,
                bridgeConnected: true,
                helperPhase: "running",
                codexInstalled: true,
                permissionsRepairAvailable: false
            ),
            [.startCodexLogin]
        )
        XCTAssertTrue(ConnectionRecoveryPlan.recommendedActions(
            for: .bridge,
            isRemoteClient: true,
            configurationValid: true,
            bridgeConnected: false,
            helperPhase: nil,
            codexInstalled: nil,
            permissionsRepairAvailable: false
        ).isEmpty)
    }

    func testProductionSettingsUsesSidebarAndSeparateDraftDestinations() throws {
        let source = try source("SettingsViews.swift")
        XCTAssertTrue(source.contains("HStack(spacing: 0)"))
        XCTAssertTrue(source.contains(".frame(width: 238)"))
        XCTAssertFalse(source.contains("NavigationSplitView(columnVisibility:"))
        XCTAssertFalse(source.contains("columnVisibility"))
        XCTAssertTrue(source.contains("ScrollViewReader"))
        XCTAssertTrue(source.contains("settings-sidebar-top"))
        XCTAssertTrue(source.contains(".listStyle(.sidebar)"))
        XCTAssertTrue(source.contains(".toolbar(removing: .sidebarToggle)"))
        XCTAssertFalse(source.contains(".toolbar(.hidden, for: .windowToolbar)"))
        XCTAssertTrue(source.contains("SettingsTitlebarSanitizerView"))
        XCTAssertTrue(source.contains("navigationSplitView.toggleSidebar"))
        XCTAssertTrue(source.contains("splitViewSeparator"))
        XCTAssertTrue(source.contains("item.view?.isHidden = true"))
        XCTAssertTrue(source.contains("toolbar.removeItem(at: index)"))
        XCTAssertFalse(source.contains("SettingsSidebarToggleAccessory"))
        XCTAssertFalse(source.contains("addTitlebarAccessoryViewController"))
        XCTAssertFalse(source.contains("SettingsToolbarCleanup"))
        XCTAssertFalse(source.contains("settings-sidebar-toggle"))
        XCTAssertTrue(source.contains("SettingsSidebarSearchField"))
        XCTAssertTrue(source.contains("NSSearchField"))
        XCTAssertTrue(source.contains("settings-search-field"))
        XCTAssertFalse(source.contains(".searchable("))
        XCTAssertTrue(source.contains("macos.settings.searchPrompt"))
        XCTAssertTrue(source.contains("settingsConnectionStatusCard"))
        XCTAssertTrue(source.contains("AppGeneralSettingsPane"))
        XCTAssertTrue(source.contains("ModelExecutionSettingsPane"))
        XCTAssertFalse(source.contains("TabView(selection:"))
        XCTAssertFalse(source.contains(".tag(\"skills\")"))
        XCTAssertFalse(source.contains("SkillsLibraryView"))
        XCTAssertFalse(source.contains("onSelectedPaneChange"))
    }

    func testSettingsSearchFindsIndividualLocalizedControlsAndRespectsContext() {
        let localPanes = SettingsNavigationPane.allCases.filter {
            $0.isAvailable(isRemoteClient: false, hasSettings: true, needsSetup: false)
        }
        XCTAssertEqual(SettingsSearchIndex.results(
            query: "Fast",
            locale: Locale(identifier: "en"),
            availablePanes: localPanes,
            isRemoteClient: false,
            hasSettings: true,
            needsSetup: false
        ), [.modelFastMode])
        XCTAssertTrue(SettingsSearchIndex.results(
            query: "notify",
            locale: Locale(identifier: "en"),
            availablePanes: localPanes,
            isRemoteClient: false,
            hasSettings: true,
            needsSetup: false
        ).contains(.generalNotifications))

        let firstRunPanes = SettingsNavigationPane.allCases.filter {
            $0.isAvailable(isRemoteClient: false, hasSettings: false, needsSetup: true)
        }
        XCTAssertTrue(SettingsSearchIndex.results(
            query: "API Key",
            locale: Locale(identifier: "en"),
            availablePanes: firstRunPanes,
            isRemoteClient: false,
            hasSettings: false,
            needsSetup: true
        ).contains(.connectionSetup))
        XCTAssertFalse(SettingsSearchIndex.results(
            query: "API Key",
            locale: Locale(identifier: "en"),
            availablePanes: localPanes,
            isRemoteClient: false,
            hasSettings: true,
            needsSetup: false
        ).contains(.connectionSetup))

        let remotePanes = SettingsNavigationPane.allCases.filter {
            $0.isAvailable(isRemoteClient: true, hasSettings: true, needsSetup: false)
        }
        XCTAssertTrue(SettingsSearchIndex.results(
            query: "active server",
            locale: Locale(identifier: "en"),
            availablePanes: remotePanes,
            isRemoteClient: true,
            hasSettings: true,
            needsSetup: false
        ).contains(.connectionActiveServer))
        XCTAssertFalse(SettingsSearchIndex.results(
            query: "device pairing",
            locale: Locale(identifier: "en"),
            availablePanes: remotePanes,
            isRemoteClient: true,
            hasSettings: true,
            needsSetup: false
        ).contains(.connectionDevicePairing))
    }

    func testSettingsWindowKeepsALocalizedAccessibleTitleButHidesItVisually() throws {
        let application = try source("CodexBridgeMenuBarApp.swift")
        let settings = try source("SettingsViews.swift")

        XCTAssertTrue(application.contains("settingsWindow.title = BridgeAppLocalization.string(\n                \"macos.settings\""))
        XCTAssertTrue(application.contains("settingsWindow.titleVisibility = .hidden"))
        XCTAssertTrue(application.contains("settingsWindow.toolbarStyle = .unifiedCompact"))
        XCTAssertTrue(application.contains("NativeSettingsView(onWindowTitleChange:"))
        XCTAssertTrue(settings.contains("onWindowTitleChange?(BridgeAppLocalization.string(\n            \"macos.settings\""))
        XCTAssertFalse(settings.contains("selectedPane.titleKey,\n            locale: model.interfaceLocale\n        ))"))
    }

    func testFirstRunPopoverAndConnectionWindowNoLongerReuseTheLegacyForm() throws {
        let dashboard = try source("DashboardViews.swift")
        let assistant = try source("ConnectionAssistantViews.swift")
        let application = try source("CodexBridgeMenuBarApp.swift")

        XCTAssertTrue(dashboard.contains("ConnectionSetupRequiredPopoverView"))
        XCTAssertFalse(dashboard.contains("ConnectionRepairView().frame"))
        XCTAssertTrue(assistant.contains("ConnectionSetupFlowView"))
        XCTAssertTrue(assistant.contains("ConnectionRecoveryView"))
        XCTAssertTrue(assistant.contains("setupFooter"))
        XCTAssertTrue(assistant.contains("recoveryFooter"))
        XCTAssertTrue(assistant.contains("attemptedRecovery ? Color.red : Color.orange"))
        XCTAssertTrue(assistant.contains("advancedDetails"))
        XCTAssertTrue(assistant.contains("await model.startRuntime()"))
        XCTAssertTrue(assistant.contains("await model.restartRuntime(force: false)"))
        XCTAssertTrue(assistant.contains("openSettings(.codex)"))
        XCTAssertTrue(application.contains("styleMask: [.titled, .closable, .resizable]"))
        XCTAssertTrue(application.contains("CodexBridgeConnectionAssistantWindow"))
        XCTAssertFalse(application.contains("repairWindow.title = \"macos."))
    }

    func testPrimaryOpenLabelsDoNotUseAnEllipsis() {
        for localeIdentifier in ["ko", "en", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"] {
            for key in [
                "macos.connectionAssistant.openSetup",
                "macos.connectionAssistant.openCodexSettings",
                "macos.connectionAssistant.openProjectSettings"
            ] {
                let value = BridgeAppLocalization.string(
                    key,
                    locale: Locale(identifier: localeIdentifier)
                )
                XCTAssertFalse(value.contains("…"), "\(key) must not use an ellipsis in \(localeIdentifier)")
                XCTAssertFalse(value.contains("..."), "\(key) must not use three periods in \(localeIdentifier)")
            }
        }
    }

    private func source(_ name: String) throws -> String {
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { repository.deleteLastPathComponent() }
        return try String(
            contentsOf: repository
                .appendingPathComponent("Sources/CodexBridgeMenuBar")
                .appendingPathComponent(name),
            encoding: .utf8
        )
    }
}
