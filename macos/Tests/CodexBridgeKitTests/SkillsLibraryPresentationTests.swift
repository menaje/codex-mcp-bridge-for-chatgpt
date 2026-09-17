import XCTest
import UniformTypeIdentifiers
@testable import CodexBridgeMenuBar

@MainActor
final class SkillsLibraryPresentationTests: XCTestCase {
    func testRendererRecognizesWholeDocumentMarkdownStructures() {
        let source = """
        # Heading

        Paragraph with [relative](references/a.md) and [external](https://example.com).

        - first
        - second

        3. third
        4. fourth

        > quoted

        ```swift
        let value = 1
        print(value)
        ```

        | Name | Value |
        | --- | --- |
        | A | B |

        ---
        """
        let document = SafeMarkdownDocument(markdown: source)

        XCTAssertTrue(document.blocks.contains(.heading(level: 1, text: "Heading")))
        XCTAssertTrue(document.blocks.contains(.unordered(["first", "second"])))
        XCTAssertTrue(document.blocks.contains(.ordered(start: 3, items: ["third", "fourth"])))
        XCTAssertTrue(document.blocks.contains(.quote("quoted")))
        XCTAssertTrue(document.blocks.contains(.code(language: "swift", source: "let value = 1\nprint(value)")))
        XCTAssertTrue(document.blocks.contains(.table(headers: ["Name", "Value"], rows: [["A", "B"]])))
        XCTAssertTrue(document.blocks.contains(.divider))
    }

    func testRendererParsingDoesNotMutateFreeformSource() {
        let source = "# 제목\r\n\r\ne\u{301}\r\n\r\n```text\r\nkeep CRLF\r\n```\r\n"
        let first = SafeMarkdownDocument(markdown: source)
        let second = SafeMarkdownDocument(markdown: source)

        XCTAssertEqual(first, second)
        XCTAssertEqual(source, "# 제목\r\n\r\ne\u{301}\r\n\r\n```text\r\nkeep CRLF\r\n```\r\n")
        XCTAssertNotEqual(
            Array(source.precomposedStringWithCanonicalMapping.utf8),
            Array(source.utf8)
        )
    }

    func testFileTreePreservesNestedLogicalPathsWithoutHostPaths() throws {
        let source = try String(contentsOf: sourceURL("SkillsLibraryViews.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("NavigationSplitView"))
        XCTAssertTrue(source.contains("SkillsLibraryShowsInspectorV2\") private var showsInspector = false"))
        XCTAssertTrue(source.contains("SkillsLibraryAdaptiveLayout.showsDocumentSidebar"))
        XCTAssertTrue(source.contains("SkillsLibraryAdaptiveLayout.showsInlineInspector"))
        XCTAssertTrue(source.contains("SkillsDefaultSidebarToolbarRemovalModifier"))
        XCTAssertTrue(source.contains("SkillsTitlebarSanitizerView"))
        XCTAssertTrue(source.contains(".toolbar(removing: .sidebarToggle)"))
        XCTAssertTrue(source.contains("if visibility != .all"))
        XCTAssertFalse(source.contains("compactInspectorPreviousVisibility"))
        XCTAssertFalse(source.contains("windowState.columnVisibility = .detailOnly"))
        XCTAssertFalse(source.contains(".inspector(isPresented: $showsInspector)"))
        XCTAssertEqual(source.components(separatedBy: "HSplitView").count - 1, 1)
        XCTAssertTrue(source.contains("ForEach(SkillFileTree.visibleRows("))
        XCTAssertTrue(source.contains("toggleFolder(node.id)"))
        XCTAssertTrue(source.contains(".tag(SkillDocumentSelection.file(path))"))
        XCTAssertTrue(source.contains("expandedSkillFileFolderIDs"))
        XCTAssertTrue(source.contains("expandFolders(containing: path)"))
        XCTAssertFalse(source.contains("SkillFileTreeRows"))
        XCTAssertFalse(source.contains("OutlineGroup("))
        XCTAssertTrue(source.contains(".searchable"))
        XCTAssertTrue(source.contains("SafeMarkdownView"))
        XCTAssertTrue(source.contains("Picker(\"macos.skills.viewMode\", selection: $editorMode)"))
        XCTAssertTrue(source.contains(".labelsHidden()"))
        XCTAssertTrue(source.contains("windowState.hasUnsavedChanges"))
        XCTAssertFalse(source.contains("MarkdownLivePreviewBlock"))
        XCTAssertFalse(source.contains("WKWebView"))
        XCTAssertFalse(source.contains("ToolbarItem(placement: .navigation)"))
    }

    func testSettingsDoesNotContainASkillManagementTab() throws {
        let settings = try String(contentsOf: sourceURL("SettingsViews.swift"), encoding: .utf8)
        XCTAssertFalse(settings.contains("SkillsLibraryView"))
        XCTAssertFalse(settings.contains(".tag(\"skills\")"))
        XCTAssertFalse(settings.contains("case \"skills\""))
        XCTAssertFalse(settings.contains("showsStandaloneWindowButton"))
    }

    func testInspectorKeepsLifecycleActionsFixedAndDeleteNeedsNoTypedName() throws {
        let source = try String(contentsOf: sourceURL("SkillsLibraryViews.swift"), encoding: .utf8)

        XCTAssertTrue(source.contains("private func inspectorActions(_ document: BridgeSkill)"))
        XCTAssertTrue(source.contains("let actionsDisabled = windowState.hasUnsavedChanges || model.skillMutationInProgress"))
        XCTAssertTrue(source.contains(".help(Text(verbatim: lifecycleLabel))"))
        XCTAssertTrue(source.contains(".accessibilityLabel(Text(verbatim: lifecycleLabel))"))
        XCTAssertTrue(source.contains(".help(\"macos.skills.deletePermanentlyAction\")"))
        XCTAssertTrue(source.contains("macos.skills.allVersionsAndMarkdownFilesWillBeDeletedAndCannotBeRecovered"))
        XCTAssertTrue(source.contains("Text(verbatim: skillName)"))
        XCTAssertFalse(source.contains("@State private var typedName"))
        XCTAssertFalse(source.contains("confirmName:"))
    }

    func testSkillCommandsDropEllipsesWhileProgressCopyKeepsOne() {
        let commands = [
            "macos.skills.importNewSkillFromFilesFolderOrZip",
            "macos.skills.importIntoCurrentSkill",
            "macos.skills.importFilesFolderOrZip",
            "macos.skills.exportAsZip",
            "macos.skills.renameDialog",
            "macos.skills.deletePermanentlyDialog"
        ]
        let locales = ["en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"]
        for key in commands {
            for identifier in locales {
                XCTAssertFalse(BridgeAppLocalization.string(
                    key,
                    locale: Locale(identifier: identifier)
                ).contains("…"))
            }
        }
        XCTAssertTrue(BridgeAppLocalization.string(
            "macos.skills.loadingMarkdownFile",
            locale: Locale(identifier: "en")
        ).contains("…"))
    }

    func testDashboardHistoryNoLongerOffersTheCodexPersistenceBanner() throws {
        let dashboard = try String(contentsOf: sourceURL("DashboardViews.swift"), encoding: .utf8)
        let model = try String(contentsOf: sourceURL("AppModel.swift"), encoding: .utf8)
        let settings = try String(contentsOf: sourceURL("SettingsViews.swift"), encoding: .utf8)

        XCTAssertFalse(dashboard.contains("macos.opennewagenttasksinthecodexapp"))
        XCTAssertFalse(dashboard.contains("macos.enablefornewtasks"))
        XCTAssertFalse(model.contains("enableCodexThreadPersistence"))
        XCTAssertTrue(settings.contains("showBridgeThreadsInCodexApp"))
    }

    func testVisualAcceptanceFixtureUsesCurrentSkillContentContract() throws {
        let fixture = try String(
            contentsOf: repositoryURL("scripts/fixtures/NativeSkillLibraryVisualAcceptance.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(fixture.contains("\"content\": main"))
        XCTAssertFalse(fixture.contains("\"document\": main"))
        XCTAssertTrue(fixture.contains("\"sourceSnapshot\": \"versioned-bridge-record\""))
        XCTAssertTrue(fixture.contains("active ? \"available\" : \"disabled\""))
    }

    func testSkillsWindowUsesAStableCompactTitlebarAndFreshDefaultFrame() throws {
        let application = try String(
            contentsOf: sourceURL("CodexBridgeMenuBarApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(application.contains("CodexBridgeSkillsLibraryWindowV5"))
        XCTAssertTrue(application.contains("skillsWindow.toolbarStyle = .unifiedCompact"))
        XCTAssertTrue(application.contains("skillsWindow.titleVisibility = .hidden"))
        XCTAssertTrue(application.contains("skillsWindow.contentMinSize = NSSize(width: 900, height: 600)"))
        XCTAssertTrue(application.contains(".frame(minWidth: 900, minHeight: 600)"))
        XCTAssertTrue(application.contains("if !skillsWindow.setFrameUsingName(frameAutosaveName)"))
        XCTAssertTrue(application.contains("skillsWindow.setContentSize(NSSize(width: 1_120, height: 720))"))
        XCTAssertTrue(application.contains("skillsWindow.setFrameAutosaveName(frameAutosaveName)"))
    }

    func testFinderFolderImportKeepsRelativeMarkdownPathsAndReportsUnsupportedFiles() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("bridge-skill-import-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("references", isDirectory: true),
            withIntermediateDirectories: true
        )
        let source = """
        ---
        name: "folder-import-test"
        description: "Imported from SKILL.md metadata."
        ---

        # Skill

        e\u{301}
        """
        try (Data([0xef, 0xbb, 0xbf]) + Data(source.utf8)).write(to: root.appendingPathComponent("SKILL.md"))
        try Data("# Legacy main\n".utf8).write(to: root.appendingPathComponent("document.md"))
        try Data("# Reference\n".utf8).write(to: root.appendingPathComponent("references/api.markdown"))
        try Data("# Hidden but supported\n".utf8).write(to: root.appendingPathComponent(".notes.md"))
        try Data("metadata".utf8).write(to: root.appendingPathComponent(".DS_Store"))
        try Data([0x89, 0x50, 0x4e, 0x47]).write(to: root.appendingPathComponent("image.png"))

        let review = BridgeSkillImportCollector.collect(urls: [root])
        XCTAssertEqual(review.paths, [".notes.md", "document.md", "references/api.markdown", "SKILL.md"])
        XCTAssertEqual(review.suggestedMainPath, "SKILL.md")
        XCTAssertEqual(review.suggestedName, "folder-import-test")
        XCTAssertEqual(review.suggestedDescription, "Imported from SKILL.md metadata.")
        XCTAssertEqual(
            review.initiallySelectedPaths(intoCurrentSkill: false),
            [".notes.md", "references/api.markdown", "SKILL.md"]
        )
        XCTAssertEqual(
            review.initiallySelectedPaths(intoCurrentSkill: true),
            [".notes.md", "references/api.markdown"]
        )
        guard case .direct(let files) = review.payload else { return XCTFail("Expected direct files") }
        XCTAssertEqual(files.first(where: { $0.path == "SKILL.md" })?.content, "\u{feff}" + source)
        XCTAssertTrue(review.issues.contains { $0.path == "image.png" && $0.reason == "unsupported-file" })
        XCTAssertTrue(review.issues.contains { $0.path == ".DS_Store" && $0.reason == "macos-metadata" })
        XCTAssertEqual(review.automaticallyExcludedIssues.map(\.path), [".DS_Store"])
        XCTAssertEqual(review.warningIssues.map(\.path), ["image.png"])
        XCTAssertEqual(review.warningSectionTitleKey, "macos.skills.itemsNotImported")
    }

    func testImportReviewSeparatesAutomaticCleanupFromWarningsAndNamesConflictsOnlyWhenPresent() throws {
        let metadataOnly = BridgeSkillImportReview(
            suggestedName: "Finder package",
            suggestedDescription: nil,
            payload: .direct([]),
            suggestedMainPath: nil,
            issues: [
                .init(path: "__MACOSX/skill/._SKILL.md", reason: "macos-metadata"),
                .init(path: "skill/.DS_Store", reason: "macos-metadata")
            ]
        )
        XCTAssertEqual(metadataOnly.automaticallyExcludedIssues.count, 2)
        XCTAssertTrue(metadataOnly.warningIssues.isEmpty)

        let mixed = BridgeSkillImportReview(
            suggestedName: "Mixed package",
            suggestedDescription: nil,
            payload: .direct([]),
            suggestedMainPath: nil,
            issues: metadataOnly.issues + [
                .init(path: "image.png", reason: "unsupported-file"),
                .init(path: "SKILL.md", reason: "path-conflict")
            ]
        )
        XCTAssertEqual(mixed.automaticallyExcludedIssues.count, 2)
        XCTAssertEqual(mixed.warningIssues.map(\.reason), ["unsupported-file", "path-conflict"])
        XCTAssertEqual(mixed.warningSectionTitleKey, "macos.skills.skippedItemsAndConflicts")

        let source = try String(contentsOf: sourceURL("SkillsLibraryViews.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("ForEach(review.warningIssues)"))
        XCTAssertFalse(source.contains("ForEach(review.issues)"))
        XCTAssertTrue(source.contains("macos.skills.macosMetadataExcludedAutomaticallyCount"))
    }

    func testDroppedItemsAlwaysStartANewSkillImport() throws {
        let source = try String(contentsOf: sourceURL("SkillsLibraryViews.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("beginImport(urls, intoCurrentSkill: false)"))
        XCTAssertFalse(source.contains("let intoCurrent = model.selectedBridgeSkill.map(isCurrentVersion)"))
    }

    func testDroppedFileURLsDecodeFromNativeURLAndDataRepresentations() async throws {
        let markdown = URL(fileURLWithPath: "/tmp/드롭/참고.md")
        XCTAssertEqual(BridgeSkillDropLoader.decodeURL(from: markdown as NSURL), markdown)
        XCTAssertEqual(
            BridgeSkillDropLoader.decodeURL(from: markdown.dataRepresentation as NSData),
            markdown
        )

        let provider = NSItemProvider(
            item: markdown.dataRepresentation as NSData,
            typeIdentifier: UTType.fileURL.identifier
        )
        let dropped = await BridgeSkillDropLoader.urls(from: [provider])
        XCTAssertEqual(dropped, [markdown])
    }

    func testFileFolderAndZipInputsShareOneImportRouter() {
        let markdown = URL(fileURLWithPath: "/tmp/skill/SKILL.md")
        let folder = URL(fileURLWithPath: "/tmp/skill", isDirectory: true)
        let archive = URL(fileURLWithPath: "/tmp/skill.zip")

        XCTAssertEqual(BridgeSkillImportRouter.route(urls: [markdown]), .direct([markdown]))
        XCTAssertEqual(BridgeSkillImportRouter.route(urls: [folder]), .direct([folder]))
        XCTAssertEqual(BridgeSkillImportRouter.route(urls: [archive]), .package(archive))
        XCTAssertEqual(
            BridgeSkillImportRouter.route(urls: [archive, markdown]),
            .direct([archive, markdown])
        )
    }

    func testImportIssueReasonsAreLocalizedInsteadOfShowingServerCodes() {
        XCTAssertEqual(
            BridgeSkillImportIssue(path: "image.png", reason: "unsupported-file")
                .localizedReason(locale: Locale(identifier: "ko")),
            "Only .md and .markdown are currently supported."
        )
        XCTAssertEqual(
            BridgeSkillImportIssue(path: "__MACOSX", reason: "macos-metadata")
                .localizedReason(locale: Locale(identifier: "ko")),
            "macOS metadata files are not imported."
        )
    }

    func testUnsavedDraftRequiresExplicitDiscardAndOnlyClearsAfterConfirmation() {
        let state = SkillsLibraryWindowState()
        var decisionCount = 0
        XCTAssertTrue(state.confirmDiscardIfNeeded {
            decisionCount += 1
            return false
        })
        XCTAssertEqual(decisionCount, 0)

        state.hasUnsavedChanges = true
        XCTAssertFalse(state.confirmDiscardIfNeeded {
            decisionCount += 1
            return false
        })
        XCTAssertTrue(state.hasUnsavedChanges)
        XCTAssertEqual(decisionCount, 1)

        XCTAssertTrue(state.confirmDiscardIfNeeded {
            decisionCount += 1
            return true
        })
        XCTAssertFalse(state.hasUnsavedChanges)
        XCTAssertEqual(decisionCount, 2)
    }

    func testFailedApplicationShutdownPreservesUnsavedDraftState() {
        let state = SkillsLibraryWindowState()
        state.hasUnsavedChanges = true

        XCTAssertTrue(state.confirmDiscardForApplicationShutdown { true })
        XCTAssertTrue(state.hasUnsavedChanges)
        XCTAssertTrue(state.applicationShutdownDiscardApproved)
        XCTAssertTrue(state.confirmDiscardForApplicationShutdown {
            XCTFail("An unchanged draft must not ask twice during one shutdown attempt")
            return false
        })

        state.cancelApplicationShutdownDiscard()
        XCTAssertTrue(state.hasUnsavedChanges)
        XCTAssertFalse(state.applicationShutdownDiscardApproved)

        XCTAssertTrue(state.confirmDiscardForApplicationShutdown { true })
        state.hasUnsavedChanges = true
        XCTAssertFalse(state.applicationShutdownDiscardApproved)
        XCTAssertFalse(state.confirmDiscardForApplicationShutdown { false })
        XCTAssertTrue(state.hasUnsavedChanges)

        XCTAssertTrue(state.confirmDiscardForApplicationShutdown { true })
        state.completeApplicationShutdownDiscard()
        XCTAssertFalse(state.hasUnsavedChanges)
        XCTAssertFalse(state.applicationShutdownDiscardApproved)
    }

    func testApplicationQuitPathsConsultTheSkillsDraftGuard() throws {
        let application = try String(contentsOf: sourceURL("CodexBridgeMenuBarApp.swift"), encoding: .utf8)
        let dashboard = try String(contentsOf: sourceURL("DashboardViews.swift"), encoding: .utf8)
        XCTAssertTrue(application.contains("func applicationShouldTerminate"))
        XCTAssertTrue(application.contains("confirmDiscardBeforeApplicationShutdown()"))
        XCTAssertTrue(dashboard.contains("guard SkillsLibraryWindowController.shared.confirmDiscardBeforeApplicationShutdown()"))
    }

    func testRelativeMarkdownNavigationUsesExactStoredAttachmentPath() {
        let storedPath = "references/Cafe\u{301}.md"
        XCTAssertNotEqual(
            Array(storedPath.utf8),
            Array(storedPath.precomposedStringWithCanonicalMapping.utf8)
        )
        XCTAssertEqual(
            bridgeSkillPathComparisonKey(storedPath),
            bridgeSkillPathComparisonKey("references/Caf\u{e9}.md")
        )
        XCTAssertNotEqual(
            bridgeSkillPathComparisonKey("references/a b.md"),
            bridgeSkillPathComparisonKey("references/a  b.md")
        )
        let direct = resolveBridgeSkillMarkdownNavigationTarget(
            linkPath: "REFERENCES/Caf\u{e9}.MD",
            currentFilePath: nil,
            availableFilePaths: [storedPath]
        )
        guard case .file(let directPath) = direct else { return XCTFail("Expected stored file path") }
        XCTAssertEqual(Array(directPath.utf8), Array(storedPath.utf8))

        let relative = resolveBridgeSkillMarkdownNavigationTarget(
            linkPath: "../references/Caf%C3%A9.md",
            currentFilePath: "guides/setup.md",
            availableFilePaths: [storedPath]
        )
        guard case .file(let relativePath) = relative else { return XCTFail("Expected stored file path") }
        XCTAssertEqual(Array(relativePath.utf8), Array(storedPath.utf8))
        XCTAssertEqual(
            resolveBridgeSkillMarkdownNavigationTarget(
                linkPath: "DOCUMENT.MD",
                currentFilePath: nil,
                availableFilePaths: [storedPath]
            ),
            .main
        )
        XCTAssertEqual(
            resolveBridgeSkillMarkdownNavigationTarget(
                linkPath: "skill.md",
                currentFilePath: nil,
                availableFilePaths: [storedPath]
            ),
            .main
        )
        XCTAssertNil(resolveBridgeSkillMarkdownNavigationTarget(
            linkPath: "../references/Cafe\u{301}.md",
            currentFilePath: nil,
            availableFilePaths: [storedPath]
        ))
    }

    func testAdaptiveLayoutKeepsNarrowWorkspacesUsable() {
        XCTAssertFalse(SkillsLibraryAdaptiveLayout.showsDocumentSidebar(
            workspaceWidth: 679,
            hasSelection: true
        ))
        XCTAssertTrue(SkillsLibraryAdaptiveLayout.showsDocumentSidebar(
            workspaceWidth: 680,
            hasSelection: true
        ))
        XCTAssertFalse(SkillsLibraryAdaptiveLayout.showsDocumentSidebar(
            workspaceWidth: 1_120,
            hasSelection: false
        ))
        XCTAssertFalse(SkillsLibraryAdaptiveLayout.showsInlineInspector(
            isPresented: true,
            detailWidth: 719
        ))
        XCTAssertTrue(SkillsLibraryAdaptiveLayout.showsInlineInspector(
            isPresented: true,
            detailWidth: 720
        ))
        XCTAssertFalse(SkillsLibraryAdaptiveLayout.showsInlineInspector(
            isPresented: false,
            detailWidth: 1_120
        ))
    }

    private func sourceURL(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CodexBridgeMenuBar")
            .appendingPathComponent(name)
    }

    private func repositoryURL(_ relativePath: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(relativePath)
    }
}
