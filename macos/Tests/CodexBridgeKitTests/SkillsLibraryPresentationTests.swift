import XCTest
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
        XCTAssertTrue(source.contains(".inspector(isPresented: $showsInspector)"))
        XCTAssertTrue(source.contains("SkillsLibraryShowsInspectorV2\") private var showsInspector = false"))
        XCTAssertTrue(source.contains("compactInspectorPreviousVisibility"))
        XCTAssertTrue(source.contains("columnVisibility = .detailOnly"))
        XCTAssertTrue(source.contains("NSWindow.didResizeNotification"))
        XCTAssertEqual(source.components(separatedBy: "HSplitView").count - 1, 1)
        XCTAssertTrue(source.contains("OutlineGroup"))
        XCTAssertTrue(source.contains(".searchable"))
        XCTAssertTrue(source.contains("SafeMarkdownView"))
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

    func testFinderFolderImportKeepsRelativeMarkdownPathsAndReportsUnsupportedFiles() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("bridge-skill-import-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("references", isDirectory: true),
            withIntermediateDirectories: true
        )
        let source = "# Skill\n\ne\u{301}\n"
        try (Data([0xef, 0xbb, 0xbf]) + Data(source.utf8)).write(to: root.appendingPathComponent("SKILL.md"))
        try Data("# Reference\n".utf8).write(to: root.appendingPathComponent("references/api.markdown"))
        try Data("# Hidden but supported\n".utf8).write(to: root.appendingPathComponent(".notes.md"))
        try Data("metadata".utf8).write(to: root.appendingPathComponent(".DS_Store"))
        try Data([0x89, 0x50, 0x4e, 0x47]).write(to: root.appendingPathComponent("image.png"))

        let review = BridgeSkillImportCollector.collect(urls: [root])
        XCTAssertEqual(review.paths, [".notes.md", "references/api.markdown", "SKILL.md"])
        XCTAssertEqual(review.suggestedMainPath, "SKILL.md")
        guard case .direct(let files) = review.payload else { return XCTFail("Expected direct files") }
        XCTAssertEqual(files.first(where: { $0.path == "SKILL.md" })?.content, "\u{feff}" + source)
        XCTAssertTrue(review.issues.contains { $0.path == "image.png" && $0.reason == "unsupported-file" })
        XCTAssertTrue(review.issues.contains { $0.path == ".DS_Store" && $0.reason == "macos-metadata" })
    }

    func testImportIssueReasonsAreLocalizedInsteadOfShowingServerCodes() {
        XCTAssertEqual(
            BridgeSkillImportIssue(path: "image.png", reason: "unsupported-file")
                .localizedReason(locale: Locale(identifier: "ko")),
            "현재는 .md와 .markdown만 지원합니다."
        )
        XCTAssertEqual(
            BridgeSkillImportIssue(path: "__MACOSX", reason: "macos-metadata")
                .localizedReason(locale: Locale(identifier: "ko")),
            "macOS 메타데이터 파일은 가져오지 않습니다."
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

    func testRelativeMarkdownNavigationUsesCanonicalStoredAttachmentPath() {
        let storedPath = "references/Caf\u{e9}.md"
        XCTAssertEqual(
            resolveBridgeSkillMarkdownNavigationTarget(
                linkPath: "REFERENCES/Cafe\u{301}.MD",
                currentFilePath: nil,
                availableFilePaths: [storedPath]
            ),
            .file(storedPath)
        )
        XCTAssertEqual(
            resolveBridgeSkillMarkdownNavigationTarget(
                linkPath: "../references/Cafe%CC%81.md",
                currentFilePath: "guides/setup.md",
                availableFilePaths: [storedPath]
            ),
            .file(storedPath)
        )
        XCTAssertEqual(
            resolveBridgeSkillMarkdownNavigationTarget(
                linkPath: "DOCUMENT.MD",
                currentFilePath: nil,
                availableFilePaths: [storedPath]
            ),
            .main
        )
        XCTAssertNil(resolveBridgeSkillMarkdownNavigationTarget(
            linkPath: "../references/Caf\u{e9}.md",
            currentFilePath: nil,
            availableFilePaths: [storedPath]
        ))
    }

    func testInspectorAdaptiveColumnPolicyTracksLiveWindowWidth() {
        XCTAssertFalse(SkillsLibraryAdaptiveColumns.shouldCollapseForInspector(
            isPresented: false,
            contentWidth: 820
        ))
        XCTAssertTrue(SkillsLibraryAdaptiveColumns.shouldCollapseForInspector(
            isPresented: true,
            contentWidth: 820
        ))
        XCTAssertFalse(SkillsLibraryAdaptiveColumns.shouldCollapseForInspector(
            isPresented: true,
            contentWidth: 1_120
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
}
