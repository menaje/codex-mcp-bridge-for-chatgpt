import Foundation

/// Field-scoped text policy shared with the Node bridge. Swift `String` is
/// already Unicode-scalar valid; byte boundaries still use strict UTF-8 and
/// callers select canonical, verbatim, opaque, or derived-search behavior.
public enum BridgeTextIntegrityError: Error, Equatable, Sendable {
    case invalidUTF8
    case invalidUnicode
    case empty
    case tooLong
    case tooLarge
    case controlCharacter
    case nul
}

public struct BridgeTextIntegrityOptions: Sendable {
    public var allowEmpty: Bool
    public var maxCharacters: Int?
    public var maxUTF8Bytes: Int?
    public var rejectControlCharacters: Bool
    public var rejectNul: Bool
    public var trim: Bool
    public var collapseWhitespace: Bool

    public init(
        allowEmpty: Bool = false,
        maxCharacters: Int? = nil,
        maxUTF8Bytes: Int? = nil,
        rejectControlCharacters: Bool = true,
        rejectNul: Bool = true,
        trim: Bool = false,
        collapseWhitespace: Bool = false
    ) {
        self.allowEmpty = allowEmpty
        self.maxCharacters = maxCharacters
        self.maxUTF8Bytes = maxUTF8Bytes
        self.rejectControlCharacters = rejectControlCharacters
        self.rejectNul = rejectNul
        self.trim = trim
        self.collapseWhitespace = collapseWhitespace
    }
}

public enum BridgeTextIntegrity {
    /// Reject malformed sequences rather than accepting Foundation's lossy
    /// replacement behavior at network, file, or local-socket byte boundaries.
    public static func decodeUTF8Strict(_ data: Data) throws -> String {
        // Foundation removes a leading UTF-8 BOM. Count and reinsert every
        // leading BOM so verbatim byte boundaries match Node and never discard
        // authored content before persistence, hashing, or transport.
        let bom = Data([0xef, 0xbb, 0xbf])
        var prefixBytes = 0
        while data.dropFirst(prefixBytes).starts(with: bom) {
            prefixBytes += bom.count
        }
        guard let suffix = String(data: data.dropFirst(prefixBytes), encoding: .utf8) else {
            throw BridgeTextIntegrityError.invalidUTF8
        }
        return String(repeating: "\u{feff}", count: prefixBytes / bom.count) + suffix
    }

    public static func canonicalHumanText(
        _ value: String,
        options: BridgeTextIntegrityOptions = .init()
    ) throws -> String {
        var result = value.precomposedStringWithCanonicalMapping
        if options.collapseWhitespace {
            result = result.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        }
        if options.trim {
            result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        try validate(result, options: options)
        return result
    }

    /// Never applies NFC, trimming, or line-ending conversion. Use this for
    /// prompts, Markdown, paths, commands, identifiers, and secrets.
    public static func verbatimText(
        _ value: String,
        options: BridgeTextIntegrityOptions = .init(rejectControlCharacters: false)
    ) throws -> String {
        try validate(value, options: options)
        return value
    }

    public static func opaqueIdentifier(
        _ value: String,
        options: BridgeTextIntegrityOptions = .init(rejectControlCharacters: false)
    ) throws -> String {
        try verbatimText(value, options: options)
    }

    /// A derived comparison key only; this must never be stored in place of
    /// the presentation value. NFKC is intentionally not used.
    public static func searchKey(
        _ value: String,
        options: BridgeTextIntegrityOptions = .init(
            allowEmpty: true,
            trim: true,
            collapseWhitespace: true
        )
    ) throws -> String {
        let canonical = try canonicalHumanText(
            value,
            options: options
        )
        return canonical.lowercased(with: Locale(identifier: "en_US"))
            .precomposedStringWithCanonicalMapping
    }

    /// Validate byte encoding before Foundation JSON decoding. JSON is allowed
    /// to carry only valid UTF-8 and scalar-value strings on this transport.
    /// Foundation can otherwise accept an escaped unpaired UTF-16 surrogate
    /// that Node's JSON parser would expose as a lossy JavaScript string.
    public static func validateJSONUTF8(_ data: Data) throws {
        let text = try decodeUTF8Strict(data)
        // JSON.parse rejects a leading BOM. Foundation's JSONDecoder accepts
        // one, so reject it here to keep both bridge implementations aligned.
        if text.first == "\u{feff}" { throw BridgeTextIntegrityError.invalidUnicode }
        try validateJSONUnicodeEscapes(Array(data))
    }

    private static func validate(_ value: String, options: BridgeTextIntegrityOptions) throws {
        if !options.allowEmpty && value.isEmpty { throw BridgeTextIntegrityError.empty }
        // Match Node's Array.from(value).length: count Unicode scalar values,
        // not Swift grapheme clusters. A decomposed character therefore uses
        // the same field budget on both sides of the RPC boundary.
        if let maximum = options.maxCharacters, value.unicodeScalars.count > maximum {
            throw BridgeTextIntegrityError.tooLong
        }
        if let maximum = options.maxUTF8Bytes, value.lengthOfBytes(using: .utf8) > maximum {
            throw BridgeTextIntegrityError.tooLarge
        }
        if options.rejectNul && value.unicodeScalars.contains("\u{0000}") {
            throw BridgeTextIntegrityError.nul
        }
        if options.rejectControlCharacters && value.unicodeScalars.contains(where: {
            $0.properties.generalCategory == .control
        }) {
            throw BridgeTextIntegrityError.controlCharacter
        }
    }

    private static func validateJSONUnicodeEscapes(_ bytes: [UInt8]) throws {
        var index = 0
        var inString = false
        while index < bytes.count {
            let byte = bytes[index]
            if !inString {
                if byte == 0x22 { inString = true }
                index += 1
                continue
            }
            if byte == 0x22 {
                inString = false
                index += 1
                continue
            }
            guard byte == 0x5c else {
                index += 1
                continue
            }
            guard index + 1 < bytes.count else { throw BridgeTextIntegrityError.invalidUnicode }
            guard bytes[index + 1] == 0x75 else {
                index += 2
                continue
            }
            guard let first = unicodeEscapeCodeUnit(bytes, at: index + 2) else {
                throw BridgeTextIntegrityError.invalidUnicode
            }
            if (0xd800...0xdbff).contains(first) {
                guard index + 11 < bytes.count,
                      bytes[index + 6] == 0x5c,
                      bytes[index + 7] == 0x75,
                      let second = unicodeEscapeCodeUnit(bytes, at: index + 8),
                      (0xdc00...0xdfff).contains(second) else {
                    throw BridgeTextIntegrityError.invalidUnicode
                }
                index += 12
                continue
            }
            if (0xdc00...0xdfff).contains(first) {
                throw BridgeTextIntegrityError.invalidUnicode
            }
            index += 6
        }
    }

    private static func unicodeEscapeCodeUnit(_ bytes: [UInt8], at index: Int) -> UInt16? {
        guard index + 3 < bytes.count else { return nil }
        var value: UInt16 = 0
        for offset in 0..<4 {
            guard let digit = hexadecimalValue(bytes[index + offset]) else { return nil }
            value = (value << 4) | digit
        }
        return value
    }

    private static func hexadecimalValue(_ byte: UInt8) -> UInt16? {
        switch byte {
        case 0x30...0x39: return UInt16(byte - 0x30)
        case 0x41...0x46: return UInt16(byte - 0x41 + 10)
        case 0x61...0x66: return UInt16(byte - 0x61 + 10)
        default: return nil
        }
    }
}
