import CodexBridgeKit
import Foundation

enum BridgeAppLocalization {
    static let supportedLanguageCodes = [
        "en",
        "ko",
        "ja",
        "zh-Hans",
        "zh-Hant",
        "es",
        "fr",
        "de",
        "pt"
    ]

    static let supportedPreferences = ["auto"] + supportedLanguageCodes

    static func locale(for preference: String) -> Locale {
        switch preference {
        case "auto": return .autoupdatingCurrent
        case "ko": return Locale(identifier: "ko")
        case "en": return Locale(identifier: "en")
        case "ja": return Locale(identifier: "ja")
        case "zh-Hans": return Locale(identifier: "zh-Hans")
        case "zh-Hant": return Locale(identifier: "zh-Hant")
        case "es": return Locale(identifier: "es")
        case "fr": return Locale(identifier: "fr")
        case "de": return Locale(identifier: "de")
        case "pt": return Locale(identifier: "pt")
        default: return Locale(identifier: "en")
        }
    }

    static func languageCode(for preference: String) -> String {
        if preference == "auto" { return preferredSystemLanguageCode }
        return supportedLanguageCodes.contains(preference) ? preference : "en"
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

    static func reasoningEffortLabel(
        _ effort: String,
        fallback: String? = nil,
        locale: Locale
    ) -> String {
        let key: String
        switch effort.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "minimal": key = "최소"
        case "low": key = "낮음"
        case "medium": key = "중간"
        case "high": key = "높음"
        case "xhigh": key = "매우 높음"
        case "max": key = "최대"
        case "ultra": key = "Ultra"
        default: return fallback ?? effort
        }
        return string(key, locale: locale)
    }

    static func errorDescription(_ error: Error, locale: Locale) -> String {
        switch error {
        case let error as HelperBootstrapError:
            return helperBootstrapErrorDescription(error, locale: locale)
        case let error as LocalRPCError:
            return localRPCErrorDescription(error, locale: locale)
        default:
            return localizedErrorDetail(error.localizedDescription, locale: locale)
        }
    }

    static func languageCode(for locale: Locale) -> String {
        let identifier = locale.identifier.replacingOccurrences(of: "_", with: "-").lowercased()
        if identifier == "ko" || identifier.hasPrefix("ko-") { return "ko" }
        if identifier == "ja" || identifier.hasPrefix("ja-") { return "ja" }
        if identifier == "zh-hant" || identifier.hasPrefix("zh-hant-") ||
            identifier.range(of: #"^zh-(tw|hk|mo)(-|$)"#, options: .regularExpression) != nil {
            return "zh-Hant"
        }
        if identifier == "zh" || identifier == "zh-hans" ||
            identifier.hasPrefix("zh-hans-") || identifier.hasPrefix("zh-") {
            return "zh-Hans"
        }
        for language in ["es", "fr", "de", "pt"]
            where identifier == language || identifier.hasPrefix("\(language)-") {
            return language
        }
        return "en"
    }

    private static var preferredSystemLanguageCode: String {
        guard let language = Locale.preferredLanguages.first?.lowercased() else {
            return "en"
        }
        return languageCode(for: Locale(identifier: language))
    }

    private static func helperBootstrapErrorDescription(
        _ error: HelperBootstrapError,
        locale: Locale
    ) -> String {
        switch error {
        case .runtimeMissing:
            return string(
                "설치된 브리지 helper를 찾을 수 없습니다. 앱을 다시 설치해 주세요.",
                locale: locale
            )
        case .nodeMissing:
            return string(
                "Node.js 22 이상을 찾을 수 없습니다. Node.js를 설치한 뒤 다시 시도해 주세요.",
                locale: locale
            )
        case .launchFailed(let message):
            return format(
                "브리지 helper를 시작하지 못했습니다: %@",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .readinessTimeout:
            return string("브리지 helper가 제한 시간 안에 준비되지 않았습니다.", locale: locale)
        case .incompatibleHelper:
            return string(
                "실행 중인 브리지 helper가 현재 앱과 호환되지 않습니다. 앱을 다시 열어 갱신해 주세요.",
                locale: locale
            )
        case .replacementBlocked(let message):
            return format(
                "실행 중인 작업을 안전하게 마치지 못해 helper 갱신을 중단했습니다: %@",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .shutdownFailed(let message):
            return format(
                "브리지 helper를 종료하지 못했습니다: %@",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .shutdownTimeout:
            return string(
                "브리지 helper가 제한 시간 안에 종료되지 않았습니다. 관련 프로세스가 남아 있을 수 있습니다.",
                locale: locale
            )
        }
    }

    private static func localRPCErrorDescription(
        _ error: LocalRPCError,
        locale: Locale
    ) -> String {
        switch error {
        case .invalidSocketPath:
            return string("로컬 연결 경로가 올바르지 않습니다.", locale: locale)
        case .peerIdentityMismatch:
            return string(
                "현재 사용자가 소유한 로컬 서비스가 아니므로 연결을 거부했습니다.",
                locale: locale
            )
        case .connectionFailed(let message):
            return format(
                "로컬 서비스에 연결할 수 없습니다: %@",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .writeFailed(let message):
            return format(
                "로컬 서비스에 요청을 보낼 수 없습니다: %@",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .responseTooLarge:
            return string("로컬 서비스 응답이 허용 크기를 초과했습니다.", locale: locale)
        case .emptyResponse:
            return string("로컬 서비스가 응답 없이 연결을 닫았습니다.", locale: locale)
        case .malformedResponse(let message):
            return format(
                "로컬 서비스 응답을 읽을 수 없습니다: %@",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .remote(_, let message):
            return localizedErrorDetail(message, locale: locale)
        }
    }

    private static func localizedErrorDetail(_ message: String, locale: Locale) -> String {
        let recoveryMarker = " 이전 helper 복구에도 실패했습니다: "
        if let markerRange = message.range(of: recoveryMarker) {
            let initialFailure = String(message[..<markerRange.lowerBound])
            let recoveryFailure = String(message[markerRange.upperBound...])
            return [
                localizedErrorDetail(initialFailure, locale: locale),
                format(
                    "이전 helper 복구에도 실패했습니다: %@",
                    locale: locale,
                    localizedErrorDetail(recoveryFailure, locale: locale)
                )
            ].joined(separator: " ")
        }

        let direct = string(message, locale: locale)
        if direct != message { return direct }

        let dynamicKeys = [
            "기존 LaunchAgent plist가 일반 파일이 아닙니다: %@",
            "원격 서버 응답을 읽을 수 없습니다: %@",
            "브리지 helper를 시작하지 못했습니다: %@",
            "실행 중인 작업을 안전하게 마치지 못해 helper 갱신을 중단했습니다: %@",
            "브리지 helper를 종료하지 못했습니다: %@",
            "로컬 서비스에 연결할 수 없습니다: %@",
            "로컬 서비스에 요청을 보낼 수 없습니다: %@",
            "로컬 서비스 응답을 읽을 수 없습니다: %@"
        ]
        for key in dynamicKeys {
            let prefix = String(key.dropLast(2))
            guard message.hasPrefix(prefix) else { continue }
            return format(
                key,
                locale: locale,
                localizedErrorDetail(
                    String(message.dropFirst(prefix.count)),
                    locale: locale
                )
            )
        }
        return message
    }
}
