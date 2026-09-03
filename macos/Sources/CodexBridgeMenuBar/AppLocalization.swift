import Foundation

enum BridgeAppLocalization {
    static func locale(for preference: String) -> Locale {
        switch preference {
        case "ko": return Locale(identifier: "ko")
        case "en": return Locale(identifier: "en")
        default: return .autoupdatingCurrent
        }
    }

    static func languageCode(for preference: String) -> String {
        switch preference {
        case "ko", "en": return preference
        default: return preferredSystemLanguageCode
        }
    }

    static func string(_ key: String, locale: Locale) -> String {
        let language = languageCode(for: locale)
        guard let path = Bundle.main.path(forResource: language, ofType: "lproj"),
              let bundle = Bundle(path: path) else {
            return key
        }
        return bundle.localizedString(forKey: key, value: key, table: nil)
    }

    static func format(_ key: String, locale: Locale, _ arguments: CVarArg...) -> String {
        String(
            format: string(key, locale: locale),
            locale: locale,
            arguments: arguments
        )
    }

    static func languageCode(for locale: Locale) -> String {
        let identifier = locale.identifier.lowercased()
        return identifier.hasPrefix("ko") ? "ko" : "en"
    }

    private static var preferredSystemLanguageCode: String {
        guard let language = Locale.preferredLanguages.first?.lowercased() else {
            return "en"
        }
        return language.hasPrefix("ko") ? "ko" : "en"
    }
}
