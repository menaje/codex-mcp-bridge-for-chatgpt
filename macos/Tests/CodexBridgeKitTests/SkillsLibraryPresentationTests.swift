import XCTest
@testable import CodexBridgeMenuBar

final class SkillsLibraryPresentationTests: XCTestCase {
    func testLivePreviewBlocksPreserveCRLFAndFencedBlankLines() {
        let source = "# 제목\r\n\r\n첫 문단입니다.\r\n\r\n```swift\r\nlet value = 1\r\n\r\nprint(value)\r\n```\r\n\r\n마지막 문단"
        let document = MarkdownLivePreviewDocument(markdown: source)

        XCTAssertEqual(document.blocks.count, 4)
        XCTAssertEqual(document.source(for: document.blocks[0]), "# 제목\r\n")
        XCTAssertEqual(document.source(for: document.blocks[1]), "첫 문단입니다.\r\n")
        XCTAssertEqual(
            document.source(for: document.blocks[2]),
            "```swift\r\nlet value = 1\r\n\r\nprint(value)\r\n```\r\n"
        )
        XCTAssertEqual(document.source(for: document.blocks[3]), "마지막 문단")
    }

    func testReplacingOneRenderedBlockLeavesSurroundingSourceUntouched() {
        let source = "before\r\n\r\nkeep this\r\n\r\nafter\r\n"
        let document = MarkdownLivePreviewDocument(markdown: source)
        let replacement = "updated\r\nwith exact CRLF\r\n"

        XCTAssertEqual(
            document.replacing(document.blocks[1], with: replacement),
            "before\r\n\r\nupdated\r\nwith exact CRLF\r\n\r\nafter\r\n"
        )
    }

    func testInvalidHistoricalBlockCannotRewriteSource() {
        let source = "# Current\n\nBody"
        let document = MarkdownLivePreviewDocument(markdown: source)
        let stale = MarkdownLivePreviewBlock(location: 100, length: 1)

        XCTAssertFalse(document.contains(stale))
        XCTAssertEqual(document.replacing(stale, with: "changed"), source)
    }
}
