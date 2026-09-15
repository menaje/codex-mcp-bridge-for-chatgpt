import CodexBridgeKit
import Foundation
import XCTest

final class TextIntegrityTests: XCTestCase {
    private struct Vectors: Decodable {
        struct UTF8Vector: Decodable {
            let name: String
            let hex: String
            let valid: Bool
            let text: String?
        }
        struct TextVector: Decodable {
            let input: String
            let expected: String
            let collapseWhitespace: Bool?
            let trim: Bool?
        }

        let utf8: [UTF8Vector]
        let canonicalHumanText: [TextVector]
        let verbatimText: [TextVector]
        let searchKey: [TextVector]
    }

    func testSharedTextIntegrityVectors() throws {
        let vectors = try loadVectors()
        for vector in vectors.utf8 {
            let data = try XCTUnwrap(Data(hex: vector.hex), vector.name)
            if vector.valid {
                XCTAssertEqual(try BridgeTextIntegrity.decodeUTF8Strict(data), vector.text, vector.name)
            } else {
                XCTAssertThrowsError(try BridgeTextIntegrity.decodeUTF8Strict(data), vector.name)
            }
        }
        for vector in vectors.canonicalHumanText {
            XCTAssertEqual(
                try BridgeTextIntegrity.canonicalHumanText(
                    vector.input,
                    options: .init(
                        trim: vector.trim ?? false,
                        collapseWhitespace: vector.collapseWhitespace ?? false
                    )
                ),
                vector.expected
            )
        }
        for vector in vectors.verbatimText {
            XCTAssertEqual(try BridgeTextIntegrity.verbatimText(vector.input), vector.expected)
        }
        for vector in vectors.searchKey {
            XCTAssertEqual(try BridgeTextIntegrity.searchKey(vector.input), vector.expected)
        }
    }

    func testRejectsEscapedUnpairedJSONSurrogates() throws {
        let unpaired = Data(#"{"value":"\uD800"}"#.utf8)
        XCTAssertThrowsError(try BridgeTextIntegrity.validateJSONUTF8(unpaired))

        let paired = Data(#"{"value":"\uD83D\uDE00"}"#.utf8)
        XCTAssertNoThrow(try BridgeTextIntegrity.validateJSONUTF8(paired))
    }

    func testCharacterLimitCountsUnicodeScalarsLikeNode() {
        XCTAssertThrowsError(
            try BridgeTextIntegrity.canonicalHumanText(
                "\u{1F44D}\u{1F3FD}",
                options: .init(maxCharacters: 1)
            )
        )
        XCTAssertNoThrow(
            try BridgeTextIntegrity.canonicalHumanText(
                "\u{1F44D}\u{1F3FD}",
                options: .init(maxCharacters: 2)
            )
        )
    }

    private func loadVectors() throws -> Vectors {
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { repository.deleteLastPathComponent() }
        let data = try Data(contentsOf: repository.appendingPathComponent("locales/text-integrity-vectors.json"))
        return try JSONDecoder().decode(Vectors.self, from: data)
    }
}

private extension Data {
    init?(hex: String) {
        guard hex.count.isMultiple(of: 2) else { return nil }
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        self = data
    }
}
