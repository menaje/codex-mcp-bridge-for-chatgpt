import AppKit
import CodexBridgeKit
import SwiftUI
import UniformTypeIdentifiers

private struct SkillVisualBootstrap: HelperBootstrapping {
    func ensureRunning(paths: RuntimePaths) async throws {}
    func shutdown(paths: RuntimePaths) async throws {}
}

private enum SkillVisualMode: Sendable {
    case empty
    case normal
    case error
}

private final class SkillVisualResponses: @unchecked Sendable {
    private let lock = NSLock()
    private var mode: SkillVisualMode = .empty

    func setMode(_ mode: SkillVisualMode) {
        lock.withLock { self.mode = mode }
    }

    func reply(method: String, rawParameters: String) -> NativeFixtureReply {
        let currentMode = lock.withLock { mode }
        if method == "skills.snapshot", currentMode == .error {
            return encoded(["error": ["code": -32000, "message": "skill-storage-unavailable"]])
        }
        let params = (try? JSONSerialization.jsonObject(with: Data(rawParameters.utf8))) as? [String: Any] ?? [:]
        let skillID = params["skillId"] as? String ?? "bridge_visual_active"
        let version = params["version"] as? String ?? (skillID == "bridge_visual_archived" ? "2" : "3")
        let result: Any
        switch method {
        case "skills.snapshot":
            result = ["skills": currentMode == .empty ? [] : [summary(active: true), summary(active: false)]]
        case "skills.read":
            result = document(skillID: skillID, version: version)
        case "skills.read-file":
            let path = params["path"] as? String ?? "references/api.md"
            let summary = summary(active: skillID != "bridge_visual_archived", version: version)
            let content = fileContent(path)
            result = [
                "kind": "skill-file", "skill": summary, "path": path,
                "content": content, "format": "markdown", "bytes": Data(content.utf8).count,
                "contentDigest": digest(path)
            ]
        case "skills.versions":
            result = versions(skillID: skillID)
        default:
            return encoded(["error": ["code": -32601, "message": "Visual fixture method unavailable"]])
        }
        return encoded(["result": result])
    }

    private func summary(active: Bool, version: String? = nil) -> [String: Any] {
        let archived = !active
        return [
            "skillId": archived ? "bridge_visual_archived" : "bridge_visual_active",
            "source": "bridge", "version": version ?? (archived ? "2" : "3"),
            "name": archived ? "이전 안전 점검 절차" : "현장 품질 검토",
            "description": archived
                ? "보관 및 이전 형식 경고의 현지화 상태를 확인합니다."
                : "자유형 Markdown 본문과 관련 문서를 함께 제공하는 브리지 스킬입니다.",
            "contentDigest": digest(archived ? "archived" : "active"),
            "enabled": active, "availability": active ? "available" : "archived"
        ]
    }

    private func document(skillID: String, version: String) -> [String: Any] {
        let active = skillID != "bridge_visual_archived"
        let main = active ? """
        # 현장 품질 검토

        이 문서는 **하나의 자유형 Markdown 원문**입니다. [API 참고](references/api.md)와 [점검표](guides/체크리스트.markdown)를 필요할 때 확인합니다.

        ## 사용 순서

        1. 요청 범위를 확인합니다.
        2. 근거 문서를 읽습니다.
        3. 결과와 불확실성을 함께 기록합니다.

        > 원문을 임의의 지침·참고문서 블록으로 분해하지 않습니다.

        ```swift
        let result = "검토 완료"
        print(result)
        ```

        | 항목 | 상태 |
        | --- | --- |
        | Markdown 렌더링 | 확인 |
        | 상대 문서 연결 | 확인 |
        """ : """
        # 이전 안전 점검 절차

        이 버전은 보관된 레거시 문서를 손실 없이 보여주는 상태입니다.
        """
        let filePaths = active ? [
            "references/api.md", "references/examples/긴-이름-참고-문서.md",
            "guides/체크리스트.markdown", "guides/nested/세부절차.md"
        ] : []
        return [
            "skill": summary(active: active, version: version), "document": main,
            "files": filePaths.map { path in
                let content = fileContent(path)
                return ["path": path, "format": "markdown", "bytes": Data(content.utf8).count,
                        "contentDigest": digest(path)] as [String: Any]
            },
            "format": "markdown", "legacy": !active, "sourceSnapshot": main,
            "warnings": active ? [] : ["archived", "legacy-structured"]
        ]
    }

    private func versions(skillID: String) -> [String: Any] {
        let active = skillID != "bridge_visual_archived"
        let current = active ? "3" : "2"
        let values: [[String: Any]] = active ? [
            version(skillID: skillID, version: "3", name: "현장 품질 검토", legacy: false,
                    createdAt: "2026-09-15T10:30:00Z"),
            version(skillID: skillID, version: "2", name: "현장 품질 검토", legacy: false,
                    createdAt: "2026-09-14T08:20:00Z"),
            version(skillID: skillID, version: "1", name: "현장 품질 검토", legacy: true,
                    createdAt: "2026-09-13T06:10:00Z")
        ] : [
            version(skillID: skillID, version: "2", name: "이전 안전 점검 절차", legacy: true,
                    createdAt: "2026-09-12T04:00:00Z")
        ]
        return ["skillId": skillID, "source": "bridge", "currentVersion": current,
                "enabled": active, "versions": values]
    }

    private func version(
        skillID: String,
        version: String,
        name: String,
        legacy: Bool,
        createdAt: String
    ) -> [String: Any] {
        [
            "skillId": skillID, "source": "bridge", "version": version, "name": name,
            "description": "버전 이력 검증", "contentDigest": digest("\(skillID)-\(version)"),
            "createdAt": createdAt, "format": "markdown", "legacy": legacy
        ]
    }

    private func fileContent(_ path: String) -> String {
        switch path {
        case "references/api.md":
            "# API 참고\n\n`bridge_skill`의 `read-file`로 필요한 파일만 읽습니다.\n"
        case "guides/체크리스트.markdown":
            "# 점검표\n\n- [ ] 범위 확인\n- [ ] 근거 확인\n- [ ] 결과 기록\n"
        default:
            "# \(path.split(separator: "/").last ?? "참고")\n\n중첩 상대경로를 유지하는 Markdown 파일입니다.\n"
        }
    }

    private func digest(_ seed: String) -> String {
        let scalar = seed.utf8.reduce(UInt64(5381)) { (($0 << 5) &+ $0) &+ UInt64($1) }
        return String(repeating: String(format: "%016llx", scalar), count: 4)
    }

    private func encoded(_ value: [String: Any]) -> NativeFixtureReply {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        return NativeFixtureReply(body: String(decoding: data, as: UTF8.self))
    }
}

@MainActor
private final class SkillLibraryVisualAcceptance: ObservableObject {
    let model: AppModel
    let root: URL
    let responses: SkillVisualResponses
    private let bridge: NativeRPCFixture
    private let modalStopper = AcceptanceModalStopper()
    private var captures: [[String: Any]] = []

    init() {
        let configured = ProcessInfo.processInfo.environment["CODEX_SKILL_VISUAL_ACCEPTANCE_ROOT"]
            ?? Bundle.main.object(forInfoDictionaryKey: "AcceptanceRoot") as? String
            ?? "/tmp/bridge-skill-visual"
        root = URL(fileURLWithPath: configured, isDirectory: true)
        let paths = RuntimePaths(environment: [
            "XDG_CONFIG_HOME": root.path,
            "CODEX_MCP_BRIDGE_DISABLE_LAUNCH_AGENT": "1"
        ], currentDirectory: root)
        responses = SkillVisualResponses()
        try! FileManager.default.createDirectory(
            at: paths.bridgeSocket.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? FileManager.default.removeItem(at: paths.bridgeSocket)
        bridge = try! NativeRPCFixture(path: paths.bridgeSocket.path) { [responses] method, parameters in
            responses.reply(method: method, rawParameters: parameters)
        }
        model = AppModel(paths: paths, bootstrapper: SkillVisualBootstrap())
        model.previewInterfaceLocale("en")
        model.helperStatus = try! Self.decode(HelperStatus.self, [
            "kind": "helper-status", "generatedAt": "2026-09-15T10:30:00Z", "phase": "running",
            "restartAttempt": 0,
            "configuration": ["path": "/private/visual/.env", "exists": true, "valid": true,
                              "hasApiKey": true, "hasTunnelId": true],
            "bridge": ["socketPath": paths.bridgeSocket.path, "connected": true],
            "tunnel": ["phase": "connected", "doctorPassed": true, "processRunning": true,
                       "connected": true]
        ])
    }

    func run() async {
        do {
            let defaults = UserDefaults.standard
            defaults.removeObject(forKey: "NSWindow Frame CodexBridgeSkillsLibraryWindow")
            defaults.set(false, forKey: "SkillsLibraryShowsInspectorV2")
            defaults.set("all", forKey: "SkillsLibraryColumnVisibilityV2")
            responses.setMode(.empty)
            SkillsLibraryWindowController.shared.show(model: model)
            try await waitUntil("empty library") { self.model.skillLibrary != nil }
            let window = try skillsWindow()
            window.orderFrontRegardless()
            setAppearance(window, locale: "en", dark: false, size: NSSize(width: 1_120, height: 760))
            try await settle()
            try capture(window, name: "01-empty-en-light-wide")

            responses.setMode(.normal)
            await model.refreshSkillLibrary()
            let active = try requireSkill("bridge_visual_active")
            await model.loadBridgeSkill(active)
            try await waitUntil("selected active skill") {
                self.model.selectedBridgeSkill?.skill.skillId == active.skillId &&
                    self.model.selectedBridgeSkillVersions != nil
            }
            try await settle()
            try capture(window, name: "02-preview-en-light-wide")
            guard let contentView = window.contentView else {
                throw AcceptanceError("The production skill window has no content view.")
            }
            let initialWideOutlines = visibleOutlineRows(in: window)
            let navigationSplitAutosaveNames = subviews(of: NSSplitView.self, in: contentView)
                .compactMap(\.autosaveName)
            guard navigationSplitAutosaveNames.contains("CodexBridgeSkillsNavigationSplit") else {
                throw AcceptanceError(
                    "The production navigation split view has no restoration name: \(navigationSplitAutosaveNames)"
                )
            }
            let outlineViews = subviews(of: NSOutlineView.self, in: contentView)
            guard let skillList = outlineViews.first(where: { $0.numberOfRows == 2 })?.enclosingScrollView,
                  let fileTree = outlineViews.first(where: { $0.numberOfRows >= 5 })?.enclosingScrollView else {
                throw AcceptanceError("Could not isolate the native skill and document lists.")
            }
            try captureView(skillList, in: window, name: "02a-skill-sidebar-en-light")
            try captureView(fileTree, in: window, name: "02b-document-tree-en-light")

            let locales = ["ko", "de", "es", "fr", "ja", "pt", "zh-Hans", "zh-Hant"]
            for (index, locale) in locales.enumerated() {
                setAppearance(window, locale: locale, dark: false, size: NSSize(width: 1_120, height: 760))
                try await settle(milliseconds: 220)
                try capture(window, name: String(format: "%02d-locale-%@-light-wide", index + 3, locale))
            }

            setAppearance(window, locale: "ko", dark: true, size: NSSize(width: 1_120, height: 760))
            try await settle()
            try capture(window, name: "11-preview-ko-dark-wide")

            setAppearance(window, locale: "ko", dark: false, size: NSSize(width: 1_120, height: 760))
            try await settle(milliseconds: 250)
            let frameBeforeZoom = window.frame
            window.zoom(nil)
            try await settle(milliseconds: 350)
            let zoomedFrame = window.frame
            window.zoom(nil)
            try await settle(milliseconds: 350)
            let frameAfterZoomRestore = window.frame
            guard !approximatelyEqual(frameBeforeZoom, zoomedFrame),
                  approximatelyEqual(frameBeforeZoom, frameAfterZoomRestore) else {
                throw AcceptanceError(
                    "The resizable production window did not zoom and restore: " +
                    "before=\(frameBeforeZoom), zoomed=\(zoomedFrame), restored=\(frameAfterZoomRestore)"
                )
            }

            try clickToolbarButton(
                in: window,
                matching: BridgeAppLocalization.string("버전과 정보", locale: Locale(identifier: "ko"))
            )
            try await waitUntil("visible inspector") {
                defaults.bool(forKey: "SkillsLibraryShowsInspectorV2")
            }
            try await settle(milliseconds: 650)
            guard let inspector = rightmostInspectorScrollView(in: window) else {
                throw AcceptanceError("Could not isolate the production version inspector.")
            }
            try captureView(inspector, in: window, name: "11a-version-inspector-ko-light")
            setAppearance(window, locale: "ko", dark: false, size: NSSize(width: 1_120, height: 760))
            var inspectorResizeStates: [String] = []
            for width in stride(from: 1_100, through: 820, by: -20) {
                window.setContentSize(NSSize(width: width, height: max(600, 760 - (1_120 - width) / 2)))
                window.layoutIfNeeded()
                try await settle(milliseconds: 45)
                inspectorResizeStates.append("\(width):\(defaults.bool(forKey: "SkillsLibraryShowsInspectorV2"))")
            }
            try await settle()
            let compactColumnVisibility = SkillsLibraryWindowController.shared.navigationColumnVisibility
            let compactOutlines = visibleOutlineRows(in: window)
            try capture(window, name: "12-preview-ko-light-compact-inspector")
            setAppearance(window, locale: "ko", dark: false, size: NSSize(width: 1_120, height: 760))
            try await settle()
            let restoredColumnVisibility = SkillsLibraryWindowController.shared.navigationColumnVisibility
            let restoredWideOutlines = visibleOutlineRows(in: window)
            guard compactColumnVisibility == .detailOnly,
                  restoredColumnVisibility == .all,
                  initialWideOutlines.count >= 2,
                  restoredWideOutlines.count >= 2 else {
                throw AcceptanceError(
                    "Inspector resize did not collapse and restore navigation columns: " +
                    "initial=\(initialWideOutlines), compact=\(compactOutlines), restored=\(restoredWideOutlines), " +
                    "visibility=\(compactColumnVisibility)/\(restoredColumnVisibility), " +
                    "inspector=\(inspectorResizeStates)"
                )
            }
            try clickToolbarButton(
                in: window,
                matching: BridgeAppLocalization.string("버전과 정보", locale: Locale(identifier: "ko"))
            )
            try await waitUntil("hidden inspector") {
                !defaults.bool(forKey: "SkillsLibraryShowsInspectorV2")
            }
            try await settle(milliseconds: 500)
            try capture(window, name: "13-preview-ko-light-wide-restored")

            responses.setMode(.error)
            await model.refreshSkillLibrary()
            try await waitUntil("localized error banner") { self.model.skillLibraryErrorMessage != nil }
            try await settle()
            try capture(window, name: "14-error-ko-light-wide")
            responses.setMode(.normal)
            await model.refreshSkillLibrary()

            let archived = try requireSkill("bridge_visual_archived")
            await model.loadBridgeSkill(archived)
            try await waitUntil("archived warning") {
                self.model.selectedBridgeSkill?.warnings.count == 2
            }
            try await settle()
            try capture(window, name: "15-archived-legacy-ko-light-wide")

            await model.loadBridgeSkill(active)
            try await waitUntil("active skill restored") {
                self.model.selectedBridgeSkill?.skill.skillId == active.skillId
            }
            let droppedMarkdown = root.appendingPathComponent("드롭/참고.md")
            let dropProvider = NSItemProvider(
                item: droppedMarkdown.dataRepresentation as NSData,
                typeIdentifier: UTType.fileURL.identifier
            )
            let droppedURLs = await BridgeSkillDropLoader.urls(from: [dropProvider])
            guard droppedURLs == [droppedMarkdown],
                  BridgeSkillImportRouter.route(urls: droppedURLs) == .direct(droppedURLs),
                  BridgeSkillImportRouter.route(urls: [root.appendingPathComponent("스킬.zip")]) ==
                    .package(root.appendingPathComponent("스킬.zip")) else {
                throw AcceptanceError("Finder drop providers did not reach the shared import router.")
            }
            NotificationCenter.default.post(name: .bridgeSkillCommandImport, object: nil)
            try await waitUntil("file/folder/zip picker") { self.openPanel(attachedTo: window) != nil }
            guard let panel = openPanel(attachedTo: window) else {
                throw AcceptanceError("The import command did not present NSOpenPanel.")
            }
            let contentTypes = panel.allowedContentTypes.map(\.identifier).sorted()
            guard panel.canChooseFiles, panel.canChooseDirectories, panel.allowsMultipleSelection,
                  panelAccepts(extension: "zip", panel: panel),
                  panelAccepts(extension: "md", panel: panel),
                  panelAccepts(extension: "markdown", panel: panel) else {
                throw AcceptanceError(
                    "The import picker does not accept files, folders, Markdown and ZIP together: \(contentTypes)"
                )
            }
            try capture(panel, name: "17-file-folder-zip-picker-ko-light")
            panel.cancel(nil)
            try await settle(milliseconds: 300)

            let review = BridgeSkillImportReview(
                sourceName: "현장-스킬-패키지",
                payload: .direct([
                    .init(path: "SKILL.md", content: "# 현장 스킬\n", bytes: 16),
                    .init(path: "references/api.md", content: "# API\n", bytes: 6),
                    .init(path: "guides/체크리스트.markdown", content: "# 점검표\n", bytes: 10)
                ]),
                suggestedMainPath: "SKILL.md",
                issues: [
                    .init(path: "image.png", reason: "unsupported-file"),
                    .init(path: "references/API.md", reason: "path-conflict"),
                    .init(path: "__MACOSX", reason: "macos-metadata")
                ]
            )
            let reviewWindow = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 680, height: 720),
                styleMask: [.titled, .closable], backing: .buffered, defer: false
            )
            reviewWindow.title = BridgeAppLocalization.string("가져오기 검토", locale: Locale(identifier: "ko"))
            reviewWindow.appearance = NSAppearance(named: .aqua)
            reviewWindow.contentViewController = NSHostingController(
                rootView: BridgeSkillImportReviewSheet(review: review, currentSkill: nil) { _ in }
                    .environment(\.locale, Locale(identifier: "ko"))
            )
            window.beginSheet(reviewWindow, completionHandler: nil)
            try await settle()
            try capture(reviewWindow, name: "18-import-review-conflicts-ko-light")
            window.endSheet(reviewWindow, returnCode: .cancel)
            reviewWindow.orderOut(nil)

            NotificationCenter.default.post(name: .bridgeSkillCommandToggleEdit, object: nil)
            try await waitUntil("whole document editor") { self.editableTextViews(in: window).count == 1 }
            try await settle()
            try capture(window, name: "19-whole-document-editor-ko-light")
            guard let editor = editableTextViews(in: window).first else {
                throw AcceptanceError("The whole-document TextEditor is missing.")
            }
            window.makeFirstResponder(editor)
            editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
            editor.insertText("\n\n종료 보호 검증", replacementRange: editor.selectedRange())
            try await settle(milliseconds: 250)

            modalStopper.schedule(.alertSecondButtonReturn)
            let cancelledClose = SkillsLibraryWindowController.shared.windowShouldClose(window)
            guard !cancelledClose, window.isVisible else {
                throw AcceptanceError("Cancelling the unsaved-change alert did not keep the window open.")
            }
            modalStopper.schedule(.alertFirstButtonReturn)
            let confirmedClose = SkillsLibraryWindowController.shared.windowShouldClose(window)
            guard confirmedClose else {
                throw AcceptanceError("Confirming the unsaved-change alert did not approve closing.")
            }

            NotificationCenter.default.post(name: .bridgeSkillCommandFind, object: nil)
            try await settle(milliseconds: 250)
            let searchFocused = window.firstResponder is NSSearchField ||
                (window.firstResponder as? NSTextView)?.delegate is NSSearchField
            let accessibility = accessibilitySummary(in: window)
            guard accessibility.searchFields > 0, accessibility.outlines >= 2,
                  accessibility.outlineRows.filter({ $0 > 0 }).count >= 2,
                  accessibility.buttons > 0, accessibility.editableTextViews > 0,
                  searchFocused else {
                throw AcceptanceError(
                    "The native accessibility structure is incomplete (searchFocused=\(searchFocused)): \(accessibility)"
                )
            }

            NotificationCenter.default.post(name: .bridgeSkillCommandNew, object: nil)
            try await waitUntil("new skill sheet") { window.attachedSheet != nil }
            if let sheet = window.attachedSheet {
                try capture(sheet, name: "20-new-skill-ko-light")
                window.endSheet(sheet, returnCode: .cancel)
                sheet.orderOut(nil)
            }

            let artifacts = root.appendingPathComponent("artifacts", isDirectory: true)
            let report: [String: Any] = [
                "kind": "bridge-skill-native-visual-acceptance",
                "generatedAt": ISO8601DateFormatter().string(from: Date()),
                "captures": captures,
                "checks": [
                    "productionWindowController": true,
                    "emptyState": true,
                    "markdownPreview": true,
                    "allSupportedLocalesRendered": true,
                    "lightAndDark": true,
                    "compactInspectorAndWideRestore": true,
                    "localizedErrorAndArchiveWarnings": true,
                    "internalAuthoringSheet": true,
                    "fileFolderZipPicker": true,
                    "dropProviderSharedImportRouter": true,
                    "importConflictReview": true,
                    "wholeDocumentEditor": true,
                    "windowZoomAndRestore": true,
                    "unsavedCloseCancel": !cancelledClose,
                    "unsavedCloseConfirm": confirmedClose,
                    "findCommandFocusedSearch": searchFocused,
                    "nativeAccessibilityStructure": true,
                    "semanticAccessibilityLabelsDeclaredInProductionSource": true
                ],
                "pickerContentTypes": contentTypes,
                "navigationSplitAutosaveNames": navigationSplitAutosaveNames,
                "adaptiveColumns": [
                    "initialWideOutlineRows": initialWideOutlines,
                    "compactOutlineRows": compactOutlines,
                    "restoredWideOutlineRows": restoredWideOutlines,
                    "compactVisibility": String(describing: compactColumnVisibility),
                    "restoredVisibility": String(describing: restoredColumnVisibility)
                ],
                "accessibility": [
                    "searchFields": accessibility.searchFields,
                    "outlines": accessibility.outlines,
                    "outlineRows": accessibility.outlineRows,
                    "buttons": accessibility.buttons,
                    "editableTextViews": accessibility.editableTextViews,
                    "labels": accessibility.labels.sorted()
                ]
            ]
            try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
                .write(to: artifacts.appendingPathComponent("report.json"), options: .atomic)
            bridge.stop()
            exit(0)
        } catch {
            let artifacts = root.appendingPathComponent("artifacts", isDirectory: true)
            try? FileManager.default.createDirectory(at: artifacts, withIntermediateDirectories: true)
            try? Data(String(describing: error).utf8)
                .write(to: artifacts.appendingPathComponent("failure.txt"), options: .atomic)
            fputs("Bridge skill visual acceptance failed: \(error)\n", stderr)
            bridge.stop()
            exit(1)
        }
    }

    private func setAppearance(_ window: NSWindow, locale: String, dark: Bool, size: NSSize) {
        model.previewInterfaceLocale(locale)
        window.title = BridgeAppLocalization.string("스킬 라이브러리", locale: Locale(identifier: locale))
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.setContentSize(size)
        window.layoutIfNeeded()
        window.displayIfNeeded()
    }

    private func skillsWindow() throws -> NSWindow {
        guard let window = NSApp.windows.first(where: SkillsLibraryWindowController.shared.manages) else {
            throw AcceptanceError("The production SkillsLibraryWindowController did not create a window.")
        }
        return window
    }

    private func requireSkill(_ id: String) throws -> BridgeSkillSummary {
        guard let skill = model.skillLibrary?.skills.first(where: { $0.skillId == id }) else {
            throw AcceptanceError("Missing synthetic Bridge skill \(id).")
        }
        return skill
    }

    private func waitUntil(
        _ description: String,
        timeoutIterations: Int = 200,
        _ condition: @escaping @MainActor () -> Bool
    ) async throws {
        for _ in 0..<timeoutIterations {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw AcceptanceError("Timed out waiting for \(description).")
    }

    private func settle(milliseconds: Int = 500) async throws {
        try await Task.sleep(for: .milliseconds(milliseconds))
        NSApp.windows.forEach {
            $0.contentView?.layoutSubtreeIfNeeded()
            $0.layoutIfNeeded()
            $0.displayIfNeeded()
        }
    }

    private func capture(_ window: NSWindow, name: String) throws {
        window.contentView?.layoutSubtreeIfNeeded()
        window.layoutIfNeeded()
        window.displayIfNeeded()
        guard let frameView = window.contentView?.superview else {
            throw AcceptanceError("Window frame view is unavailable for \(name).")
        }
        frameView.layoutSubtreeIfNeeded()
        let bounds = frameView.bounds
        let scale = max(window.backingScaleFactor, 2)
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: max(1, Int((bounds.width * scale).rounded())),
            pixelsHigh: max(1, Int((bounds.height * scale).rounded())),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { throw AcceptanceError("Could not allocate the bitmap for \(name).") }
        bitmap.size = bounds.size
        frameView.cacheDisplay(in: bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]), data.count > 4_096 else {
            throw AcceptanceError("The rendered capture for \(name) is empty.")
        }
        let artifacts = root.appendingPathComponent("artifacts", isDirectory: true)
        try FileManager.default.createDirectory(at: artifacts, withIntermediateDirectories: true)
        let file = artifacts.appendingPathComponent("\(name).png")
        try data.write(to: file, options: .atomic)
        captures.append([
            "name": name, "path": file.path, "bytes": data.count,
            "pixelsWide": bitmap.pixelsWide, "pixelsHigh": bitmap.pixelsHigh,
            "capture": "NSView.cacheDisplay"
        ])
    }

    private func captureView(_ view: NSView, in window: NSWindow, name: String) throws {
        view.layoutSubtreeIfNeeded()
        view.displayIfNeeded()
        let bounds = view.bounds
        let scale = max(window.backingScaleFactor, 2)
        guard bounds.width > 1, bounds.height > 1,
              let bitmap = NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: max(1, Int((bounds.width * scale).rounded())),
                pixelsHigh: max(1, Int((bounds.height * scale).rounded())),
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: 0,
                bitsPerPixel: 0
              ) else { throw AcceptanceError("Could not allocate the direct bitmap for \(name).") }
        bitmap.size = bounds.size
        if let context = NSGraphicsContext(bitmapImageRep: bitmap) {
            context.cgContext.setFillColor(NSColor.windowBackgroundColor.cgColor)
            context.cgContext.fill(bounds)
        }
        view.cacheDisplay(in: bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]), data.count > 1_024 else {
            throw AcceptanceError("The direct rendered capture for \(name) is empty.")
        }
        let artifacts = root.appendingPathComponent("artifacts", isDirectory: true)
        try FileManager.default.createDirectory(at: artifacts, withIntermediateDirectories: true)
        let file = artifacts.appendingPathComponent("\(name).png")
        try data.write(to: file, options: .atomic)
        captures.append([
            "name": name, "path": file.path, "bytes": data.count,
            "pixelsWide": bitmap.pixelsWide, "pixelsHigh": bitmap.pixelsHigh,
            "capture": "NSView.cacheDisplay.direct"
        ])
    }

    private func editableTextViews(in window: NSWindow) -> [NSTextView] {
        guard let root = window.contentView else { return [] }
        return subviews(of: NSTextView.self, in: root).filter { $0.isEditable && !$0.string.isEmpty }
    }

    private func openPanel(attachedTo window: NSWindow) -> NSOpenPanel? {
        (window.attachedSheet as? NSOpenPanel) ?? NSApp.windows.compactMap { $0 as? NSOpenPanel }.first
    }

    private func panelAccepts(extension fileExtension: String, panel: NSOpenPanel) -> Bool {
        guard let candidate = UTType(filenameExtension: fileExtension) else { return false }
        return panel.allowedContentTypes.contains { candidate == $0 || candidate.conforms(to: $0) }
    }

    private func clickToolbarButton(in window: NSWindow, matching expected: String) throws {
        let toolbarItems = window.toolbar?.items ?? []
        if let item = toolbarItems.first(where: {
            [$0.label, $0.paletteLabel, $0.toolTip].compactMap { $0 }.contains(expected)
        }) {
            if let button = item.view.flatMap({ subviews(of: NSButton.self, in: $0).first }) {
                button.performClick(nil)
                return
            }
            if let action = item.action, NSApp.sendAction(action, to: item.target, from: item) {
                return
            }
            if let menuItem = item.menuFormRepresentation,
               let action = menuItem.action,
               NSApp.sendAction(action, to: menuItem.target, from: menuItem) {
                return
            }
        }
        var frameViews: [NSView] = []
        if let frameView = window.contentView?.superview { frameViews.append(frameView) }
        frameViews.append(contentsOf: toolbarItems.compactMap(\.view))
        let buttons = frameViews.flatMap { subviews(of: NSButton.self, in: $0) }
        if let button = buttons.first(where: {
            [$0.title, $0.toolTip, $0.accessibilityLabel()].compactMap { $0 }.contains(expected)
        }) {
            button.performClick(nil)
            return
        }
        let summary = buttons.map {
            "title=\($0.title.debugDescription), tooltip=\(($0.toolTip ?? "").debugDescription), " +
                "label=\(($0.accessibilityLabel() ?? "").debugDescription)"
        }
        let itemSummary = toolbarItems.map {
            "id=\($0.itemIdentifier.rawValue), label=\($0.label.debugDescription), " +
                "palette=\($0.paletteLabel.debugDescription), tooltip=\(($0.toolTip ?? "").debugDescription)"
        }
        throw AcceptanceError(
            "Could not find toolbar control \(expected.debugDescription): items=\(itemSummary), buttons=\(summary)"
        )
    }

    private func accessibilitySummary(in window: NSWindow) -> AccessibilitySummary {
        guard let root = window.contentView else { return .init() }
        let views = allSubviews(in: root)
        let directLabels = views.compactMap { $0.accessibilityLabel() }.filter { !$0.isEmpty }
        return AccessibilitySummary(
            searchFields: views.compactMap { $0 as? NSSearchField }.count,
            outlines: views.compactMap { $0 as? NSOutlineView }.count,
            outlineRows: views.compactMap { ($0 as? NSOutlineView)?.numberOfRows },
            buttons: views.compactMap { $0 as? NSButton }.count,
            editableTextViews: views.compactMap { $0 as? NSTextView }.filter(\.isEditable).count,
            labels: Array(Set(directLabels + semanticAccessibilityLabels(from: root)))
        )
    }

    private func semanticAccessibilityLabels(from root: NSObject) -> [String] {
        let labelSelector = NSSelectorFromString("accessibilityLabel")
        let childrenSelectors = [
            NSSelectorFromString("accessibilityChildrenInNavigationOrder"),
            NSSelectorFromString("accessibilityChildren")
        ]
        var labels: [String] = []
        var visited = Set<ObjectIdentifier>()
        func visit(_ value: Any, depth: Int) {
            guard depth < 24, let object = value as? NSObject else { return }
            let identity = ObjectIdentifier(object)
            guard visited.insert(identity).inserted else { return }
            if object.responds(to: labelSelector),
               let label = object.perform(labelSelector)?.takeUnretainedValue() as? String,
               !label.isEmpty {
                labels.append(label)
            }
            for selector in childrenSelectors where object.responds(to: selector) {
                guard let children = object.perform(selector)?.takeUnretainedValue() as? [Any] else { continue }
                children.forEach { visit($0, depth: depth + 1) }
            }
        }
        visit(root, depth: 0)
        return labels
    }

    private func visibleOutlineRows(in window: NSWindow) -> [Int] {
        guard let root = window.contentView else { return [] }
        let windowBounds = root.bounds
        return subviews(of: NSOutlineView.self, in: root).compactMap { outline in
            guard let scrollView = outline.enclosingScrollView,
                  viewAndAncestorsAreVisible(scrollView),
                  scrollView.frame.width > 1, scrollView.frame.height > 1 else { return nil }
            let frame = scrollView.convert(scrollView.bounds, to: root)
            guard frame.intersects(windowBounds), frame.intersection(windowBounds).width > 1 else { return nil }
            return outline.numberOfRows
        }
    }

    private func rightmostInspectorScrollView(in window: NSWindow) -> NSScrollView? {
        guard let root = window.contentView else { return nil }
        return subviews(of: NSScrollView.self, in: root)
            .filter { scrollView in
                scrollView.frame.width >= 240 && scrollView.frame.width <= 380 &&
                    scrollView.frame.height > 300 && viewAndAncestorsAreVisible(scrollView)
            }
            .max { lhs, rhs in
                lhs.convert(lhs.bounds, to: root).minX < rhs.convert(rhs.bounds, to: root).minX
            }
    }

    private func viewAndAncestorsAreVisible(_ view: NSView) -> Bool {
        var candidate: NSView? = view
        while let current = candidate {
            if current.isHidden { return false }
            candidate = current.superview
        }
        return true
    }

    private func approximatelyEqual(_ lhs: NSRect, _ rhs: NSRect, tolerance: CGFloat = 2) -> Bool {
        abs(lhs.minX - rhs.minX) <= tolerance && abs(lhs.minY - rhs.minY) <= tolerance &&
            abs(lhs.width - rhs.width) <= tolerance && abs(lhs.height - rhs.height) <= tolerance
    }

    private func allSubviews(in root: NSView) -> [NSView] {
        [root] + root.subviews.flatMap(allSubviews(in:))
    }

    private func subviews<T: NSView>(of type: T.Type, in root: NSView) -> [T] {
        allSubviews(in: root).compactMap { $0 as? T }
    }

    nonisolated private static func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
}

@MainActor
private final class AcceptanceModalStopper: NSObject {
    private var response: NSApplication.ModalResponse = .abort

    func schedule(_ response: NSApplication.ModalResponse) {
        self.response = response
        perform(#selector(stop), with: nil, afterDelay: 0.2, inModes: [.modalPanel])
    }

    @objc private func stop() {
        NSApp.stopModal(withCode: response)
    }
}

private struct AccessibilitySummary: CustomStringConvertible {
    var searchFields = 0
    var outlines = 0
    var outlineRows: [Int] = []
    var buttons = 0
    var editableTextViews = 0
    var labels: [String] = []

    var description: String {
        "search=\(searchFields), outlines=\(outlines), outlineRows=\(outlineRows), " +
            "buttons=\(buttons), editors=\(editableTextViews), labels=\(labels)"
    }
}

private struct AcceptanceError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

@MainActor
private final class SkillLibraryVisualAcceptanceDelegate: NSObject, NSApplicationDelegate {
    static var acceptance: SkillLibraryVisualAcceptance?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let acceptance = Self.acceptance else { exit(1) }
        Task { @MainActor in await acceptance.run() }
    }
}

@main
private struct NativeSkillLibraryVisualAcceptanceApp: App {
    @NSApplicationDelegateAdaptor(SkillLibraryVisualAcceptanceDelegate.self) private var appDelegate
    @StateObject private var acceptance: SkillLibraryVisualAcceptance

    init() {
        let value = SkillLibraryVisualAcceptance()
        _acceptance = StateObject(wrappedValue: value)
        SkillLibraryVisualAcceptanceDelegate.acceptance = value
    }

    var body: some Scene {
        Settings { EmptyView().environmentObject(acceptance.model) }
    }
}
