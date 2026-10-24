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
                let expected = try XCTUnwrap(vector.text, vector.name)
                XCTAssertEqual(Data(try BridgeTextIntegrity.decodeUTF8Strict(data).utf8), Data(expected.utf8), vector.name)
            } else {
                XCTAssertThrowsError(try BridgeTextIntegrity.decodeUTF8Strict(data), vector.name)
            }
        }
        for vector in vectors.canonicalHumanText {
            XCTAssertEqual(
                Data(try BridgeTextIntegrity.canonicalHumanText(
                    vector.input,
                    options: .init(
                        trim: vector.trim ?? false,
                        collapseWhitespace: vector.collapseWhitespace ?? false
                    )
                ).utf8),
                Data(vector.expected.utf8)
            )
        }
        for vector in vectors.verbatimText {
            XCTAssertEqual(Data(try BridgeTextIntegrity.verbatimText(vector.input).utf8), Data(vector.expected.utf8))
            let encoded = try JSONEncoder().encode(vector.input)
            try BridgeTextIntegrity.validateJSONUTF8(encoded)
            let decoded = try JSONDecoder().decode(String.self, from: encoded)
            XCTAssertEqual(Data(decoded.utf8), Data(vector.expected.utf8))
        }
        for vector in vectors.searchKey {
            XCTAssertEqual(Data(try BridgeTextIntegrity.searchKey(vector.input).utf8), Data(vector.expected.utf8))
        }
    }

    func testRejectsEscapedUnpairedJSONSurrogates() throws {
        let unpaired = Data(#"{"value":"\uD800"}"#.utf8)
        XCTAssertThrowsError(try BridgeTextIntegrity.validateJSONUTF8(unpaired))

        let paired = Data(#"{"value":"\uD83D\uDE00"}"#.utf8)
        XCTAssertNoThrow(try BridgeTextIntegrity.validateJSONUTF8(paired))
    }

    func testPreservesBOMForVerbatimTextButRejectsItForJSON() throws {
        let jsonWithBOM = try XCTUnwrap(Data(hex: "efbbbf7b7d"))
        XCTAssertEqual(try BridgeTextIntegrity.decodeUTF8Strict(jsonWithBOM), "\u{feff}{}")
        XCTAssertThrowsError(try BridgeTextIntegrity.validateJSONUTF8(jsonWithBOM))
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
