import CodexBridgeKit
import Foundation

enum BridgeAppLocalization {
    enum StatusProblemContext {
        case helper
        case tunnel
        case runtimeConfiguration
        case remoteManagement
        case operation
    }

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

    /// Lifecycle failures can contain both an initial failure and rollback
    /// outcome. Map their categories to copy without displaying raw diagnostics.
    static func lifecycleFailureDescription(_ diagnostic: String?, locale: Locale) -> String {
        let message = diagnostic ?? ""
        let causes: [(String, String)] = [
            ("LIFECYCLE_TARGET_CHANGED", "대기 중 설정이나 CLI 선택이 바뀌었습니다. 현재 선택으로 다시 요청해 주세요."),
            ("DRAIN_CANCEL_FAILED", "작업 접수를 다시 열지 못했습니다. 서버 상태를 확인해 주세요."),
            ("RUNTIME_READINESS_TIMEOUT", "브리지 helper가 제한 시간 안에 준비되지 않았습니다."),
            ("Timed out waiting for the bridge companion", "브리지 helper가 제한 시간 안에 준비되지 않았습니다."),
            ("RUNTIME_READINESS_EXITED", "서버가 연결 준비를 마치기 전에 종료되었습니다. 설치와 연결 설정을 확인해 주세요."),
            ("before the bridge and tunnel became ready", "서버가 연결 준비를 마치기 전에 종료되었습니다. 설치와 연결 설정을 확인해 주세요."),
            ("HELPER_SHUTDOWN_TIMEOUT", "브리지 helper가 제한 시간 안에 종료되지 않았습니다. 관련 프로세스가 남아 있을 수 있습니다."),
            ("HELPER_SHUTDOWN_FAILED", "브리지 helper를 종료하지 못했습니다. 관련 프로세스 상태를 확인해 주세요."),
            ("RUNTIME_STOP_", "브리지 helper가 제한 시간 안에 종료되지 않았습니다. 관련 프로세스가 남아 있을 수 있습니다."),
            ("RUNTIME_TREE_", "관련 프로세스의 확인 또는 종료를 마치지 못했습니다. 서버 상태를 확인해 주세요."),
            ("LIFECYCLE_HANDOFF_CONNECTION_FAILED", "로컬 서비스의 응답을 확인하지 못해 후속 처리를 마치지 못했습니다. 다시 요청해 주세요."),
            ("LIFECYCLE_SETTINGS_SAVE_FAILED", "설정 변경사항을 저장하지 못해 후속 처리를 중단했습니다."),
            ("LIFECYCLE_MODE_SAVE_FAILED", "연결 모드 설정을 저장하지 못했습니다. 저장 위치와 권한을 확인해 주세요."),
            ("LIFECYCLE_RECEIPT_SAVE_FAILED", "처리 결과를 저장하지 못했습니다. 저장 위치와 권한을 확인해 주세요."),
            ("LIFECYCLE_RUNTIME_NOT_STOPPED", "서버가 아직 실행 중이어서 후속 처리를 진행하지 않았습니다."),
            ("LIFECYCLE_RECOVERY_REQUIRED", "복구된 서버 상태가 예약과 일치하지 않습니다. 서버 상태를 확인한 뒤 다시 요청해 주세요."),
            ("HELPER_REPLACEMENT_ROLLBACK_FAILED", "helper 교체와 이전 helper 복구에 실패했습니다. 설치 상태를 확인해 주세요."),
            ("HELPER_REPLACEMENT_FAILED", "helper 교체를 마치지 못했습니다. 설치 상태를 확인한 뒤 다시 요청해 주세요."),
            ("HELPER_LAUNCH_FAILED", "브리지 helper를 시작하지 못했습니다. 설치 상태를 확인해 주세요."),
            ("HELPER_BUILD_MISMATCH", "실행 중인 브리지 helper가 현재 앱과 호환되지 않습니다. 앱을 다시 열어 갱신해 주세요."),
            ("BRIDGE_RUNTIME_MISSING", "설치된 브리지 helper를 찾을 수 없습니다. 앱을 다시 설치해 주세요."),
            ("SETUP_REQUIRED", "런타임 연결 정보가 아직 저장되지 않았습니다.")
        ]
        let configurationFailed = message.contains("CONFIG_APPLY_FAILED") || message.contains("CONFIG_ROLLBACK_")
        var details: [String] = configurationFailed ? [string("설정 적용에 실패했습니다.", locale: locale)] : []
        if let cause = causes.first(where: { message.contains($0.0) }) {
            details.append(string(cause.1, locale: locale))
        }
        if message.contains("CONFIG_ROLLBACK_RESTART_FAILED") {
            details.append(string("이전 설정을 복원했지만 서버를 다시 시작하지 못했습니다.", locale: locale))
        } else if message.contains("CONFIG_ROLLBACK_FAILED") {
            details.append(string("이전 설정을 복원하지 못했습니다. 연결 설정을 확인해 주세요.", locale: locale))
        } else if message.contains("Previous runtime configuration was restored.") {
            details.append(string("이전 설정을 복원했습니다.", locale: locale))
        }
        return details.isEmpty
            ? string("예약한 작업을 완료하지 못했습니다. 현재 상태를 확인한 뒤 다시 요청해 주세요.", locale: locale)
            : details.joined(separator: " ")
    }

    static func errorDescription(_ error: Error, locale: Locale) -> String {
        switch error {
        case let error as RemoteConnectionStorageError:
            return remoteConnectionStorageErrorDescription(error, locale: locale)
        case let error as RemoteCompanionError:
            return remoteCompanionErrorDescription(error, locale: locale)
        case let error as HelperBootstrapError:
            return helperBootstrapErrorDescription(error, locale: locale)
        case let error as LocalRPCError:
            return localRPCErrorDescription(error, locale: locale)
        default:
            return localizedErrorDetail(error.localizedDescription, locale: locale)
        }
    }

    static func isTunnelConnectionPending(
        problem: BridgeStatusProblem?,
        diagnosticMessage: String?
    ) -> Bool {
        statusProblemCode(
            problem: problem,
            diagnosticMessage: diagnosticMessage,
            context: .tunnel
        ) == "tunnel-connection-pending"
    }

    /// Converts machine-readable helper state into user-facing copy. The raw
    /// diagnostic message is used only to recognize older helper versions; it
    /// is never returned to the general UI.
    static func statusProblemDescription(
        problem: BridgeStatusProblem?,
        diagnosticMessage: String?,
        context: StatusProblemContext,
        locale: Locale
    ) -> String? {
        guard let code = statusProblemCode(
            problem: problem,
            diagnosticMessage: diagnosticMessage,
            context: context
        ) else {
            return diagnosticMessage == nil
                ? nil
                : string(
                    "요청을 처리하지 못했습니다. 진단 로그에서 자세한 내용을 확인해 주세요.",
                    locale: locale
                )
        }

        let key: String
        switch code {
        case "tunnel-connection-pending":
            return nil
        case "tunnel-process-exited", "tunnel-process-not-running":
            key = "Secure MCP Tunnel 프로세스가 실행 중이지 않습니다."
        case "tunnel-readiness-probe-failed", "tunnel-health-probe-failed":
            key = "Secure MCP Tunnel 연결을 확인할 수 없습니다. 다시 연결하는 중일 수 있습니다."
        case "tunnel-status-previous-launcher", "tunnel-status-different-build",
             "tunnel-status-different-profile", "tunnel-status-stale":
            key = "Secure MCP Tunnel 상태가 현재 서버 실행과 일치하지 않습니다. 서버를 다시 시작해 주세요."
        case "runtime-env-not-configured":
            key = "런타임 연결 정보가 아직 저장되지 않았습니다."
        case "runtime-env-permissions-too-broad":
            key = "연결 정보 파일 또는 폴더의 접근 권한이 너무 넓습니다. 앱 전용 권한으로 제한해 주세요."
        case "runtime-env-not-regular":
            key = "연결 정보는 심볼릭 링크가 아닌 일반 파일이어야 합니다."
        case "runtime-env-owner-mismatch":
            key = "연결 정보 파일 또는 폴더를 현재 사용자가 소유하지 않습니다."
        case "runtime-api-key-invalid":
            key = "Tunnel runtime API key가 없거나 형식이 올바르지 않습니다."
        case "tunnel-id-invalid":
            key = "Tunnel ID가 없거나 형식이 올바르지 않습니다."
        case "runtime-env-project-conflict":
            key = "연결 정보 파일을 등록된 프로젝트 폴더 밖으로 이동해 주세요."
        case "runtime-env-invalid-content", "runtime-env-invalid":
            key = "연결 정보 파일의 내용이 올바르지 않습니다."
        case "remote-endpoint-not-configured":
            key = "원격 관리 서버 주소가 설정되지 않았습니다."
        case "remote-address-in-use":
            key = "지정한 주소 또는 포트를 다른 프로그램이 사용 중입니다."
        case "remote-listener-permission-denied":
            key = "원격 관리 서버를 시작할 권한이 없습니다. 주소와 포트를 확인해 주세요."
        case "remote-tls-identity-failed":
            key = "원격 관리용 보안 인증서를 준비하지 못했습니다."
        case "remote-listener-failed", "remote-management-not-listening":
            key = "원격 관리 서버가 지정한 주소에서 시작되지 않았습니다."
        case "bridge-runtime-missing":
            key = "설치된 브리지 helper를 찾을 수 없습니다. 앱을 다시 설치해 주세요."
        case "runtime-readiness-timeout":
            key = "브리지 helper가 제한 시간 안에 준비되지 않았습니다."
        case "runtime-stop-failed", "runtime-stop-incomplete":
            key = "브리지 helper가 제한 시간 안에 종료되지 않았습니다. 관련 프로세스가 남아 있을 수 있습니다."
        case "settings-revision-conflict", "project-registry-revision-conflict":
            key = "다른 화면에서 설정이 변경되었습니다. 최신 값을 확인한 뒤 다시 시도해 주세요."
        case "pairing-expired":
            key = "페어링 초대가 만료되었습니다. 서버에서 새 초대를 만들어 주세요."
        case "pairing-code-invalid":
            key = "페어링 초대가 올바르지 않습니다. 서버에서 새 초대를 만들어 주세요."
        case "drain-timeout":
            key = "진행 중인 작업이 제한 시간 안에 끝나지 않아 종료하지 않았습니다. 강제 종료 여부를 확인해 주세요."
        case "background-process-state-unknown":
            key = "일부 Agent의 백그라운드 프로세스 상태를 확인할 수 없어 안전 종료하지 않았습니다. 강제 종료 여부를 확인해 주세요."
        case "background-processes-active":
            key = "백그라운드 프로세스가 실행 중이어서 안전 종료하지 않았습니다. 강제 종료하면 해당 프로세스도 중단됩니다."
        default:
            key = "요청을 처리하지 못했습니다. 진단 로그에서 자세한 내용을 확인해 주세요."
        }
        return string(key, locale: locale)
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

    private static func remoteConnectionStorageErrorDescription(
        _ error: RemoteConnectionStorageError,
        locale: Locale
    ) -> String {
        switch error {
        case .invalidProfiles:
            return string("저장된 서버 프로필 목록이 올바르지 않습니다.", locale: locale)
        case .invalidServerIdentity:
            return string("서버 고유 ID가 올바르지 않습니다.", locale: locale)
        case .invalidCredential:
            return string("서버 기기 자격 증명이 올바르지 않습니다.", locale: locale)
        case .keychain(let status):
            return format("보호된 자격 증명 저장소 오류(%d)", locale: locale, Int(status))
        }
    }

    private static func remoteCompanionErrorDescription(
        _ error: RemoteCompanionError,
        locale: Locale
    ) -> String {
        switch error {
        case .invalidInvitation:
            return string("페어링 초대가 올바르지 않습니다. 서버에서 새 초대를 만들어 주세요.", locale: locale)
        case .expiredInvitation:
            return string("페어링 초대가 만료되었습니다. 서버에서 새 초대를 만들어 주세요.", locale: locale)
        case .invalidEndpoint:
            return string("서버 주소는 경로가 없는 HTTPS 주소여야 합니다.", locale: locale)
        case .invalidCertificatePin:
            return string("서버 인증서 확인 값이 올바르지 않습니다.", locale: locale)
        case .certificateMismatch:
            return string(
                "서버 인증서가 페어링할 때 확인한 인증서와 다릅니다. 연결을 거부했습니다.",
                locale: locale
            )
        case .serverIdentityMismatch:
            return string(
                "응답한 서버의 고유 ID가 저장된 서버와 다릅니다. 연결을 거부했습니다.",
                locale: locale
            )
        case .incompatibleProtocol:
            return string(
                "이 앱과 서버의 원격 관리 프로토콜 버전이 호환되지 않습니다.",
                locale: locale
            )
        case .credentialMissing:
            return string(
                "이 서버의 기기 자격 증명을 찾을 수 없어 다시 페어링해야 합니다.",
                locale: locale
            )
        case .unauthorized:
            return string(
                "서버가 이 기기의 자격 증명을 거부했습니다. 서버에서 기기 등록을 확인해 주세요.",
                locale: locale
            )
        case .forbidden:
            return string(
                "이 기기에는 요청한 서버 기능을 사용할 권한이 없습니다.",
                locale: locale
            )
        case .responseTooLarge:
            return string("원격 서버 응답이 허용 크기를 초과했습니다.", locale: locale)
        case .invalidResponse(let message):
            return format(
                "원격 서버 응답을 읽을 수 없습니다: %@",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .server(_, let message):
            return localizedErrorDetail(message, locale: locale)
        }
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
        case .replacementPending:
            return string("작업이 끝나면 helper를 갱신하도록 예약했습니다.", locale: locale)
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
        if message.contains("SETUP_CANDIDATE_UNAVAILABLE") {
            return string("찾은 연결 설정이 더 이상 유효하지 않습니다. 다시 찾아 주세요.", locale: locale)
        }
        if message.contains("SETUP_API_KEY_UNAVAILABLE") {
            return string("선택한 Tunnel ID의 Runtime API 키를 읽을 수 없습니다.", locale: locale)
        }

        let recoveryMarker = " 이전 helper 복구에도 실패했습니다: "
        if message.contains("LIFECYCLE_BUSY") {
            return string("이미 예약된 작업이 있습니다. 예약을 취소한 뒤 다시 요청해 주세요.", locale: locale)
        }
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
        if languageCode(for: locale) == "ko",
           message.range(of: #"[가-힣]"#, options: .regularExpression) != nil {
            return message
        }
        return statusProblemDescription(
            problem: nil,
            diagnosticMessage: message,
            context: .operation,
            locale: locale
        ) ?? string(
            "요청을 처리하지 못했습니다. 진단 로그에서 자세한 내용을 확인해 주세요.",
            locale: locale
        )
    }

    private static func statusProblemCode(
        problem: BridgeStatusProblem?,
        diagnosticMessage: String?,
        context: StatusProblemContext
    ) -> String? {
        if let code = problem?.code, !code.isEmpty {
            return normalizedProblemCode(code)
        }
        guard let message = diagnosticMessage, !message.isEmpty else { return nil }

        if let prefix = message.range(
            of: #"^[A-Z][A-Z0-9_]{2,79}(?=:|$)"#,
            options: .regularExpression
        ) {
            return normalizedProblemCode(String(message[prefix]))
        }

        switch context {
        case .tunnel:
            if message == "Waiting for a successful control-plane poll." {
                return "tunnel-connection-pending"
            }
            if message.contains("tunnel-client process exited") {
                return "tunnel-process-exited"
            }
            if message.contains("tunnel-client process is not running") {
                return "tunnel-process-not-running"
            }
            if message.contains("tunnel readiness probe") {
                return "tunnel-readiness-probe-failed"
            }
            if message.contains("previous launcher process") {
                return "tunnel-status-previous-launcher"
            }
            if message.contains("different runtime build") {
                return "tunnel-status-different-build"
            }
            if message.contains("different managed profile or transport") {
                return "tunnel-status-different-profile"
            }
            if message.contains("Tunnel status is stale") {
                return "tunnel-status-stale"
            }
            return "tunnel-health-probe-failed"
        case .runtimeConfiguration:
            if message.contains("not configured") { return "runtime-env-not-configured" }
            if message.contains("permissions are too broad") {
                return "runtime-env-permissions-too-broad"
            }
            if message.contains("regular, non-symlink") || message.contains("regular directory") {
                return "runtime-env-not-regular"
            }
            if message.contains("owned by the current user") {
                return "runtime-env-owner-mismatch"
            }
            if message.contains("CONTROL_PLANE_API_KEY") { return "runtime-api-key-invalid" }
            if message.contains("CONTROL_PLANE_TUNNEL_ID") { return "tunnel-id-invalid" }
            return "runtime-env-invalid"
        case .remoteManagement:
            if message == "Remote endpoint is not configured." {
                return "remote-endpoint-not-configured"
            }
            if message.contains("EADDRINUSE") { return "remote-address-in-use" }
            if message.contains("EACCES") || message.contains("EPERM") {
                return "remote-listener-permission-denied"
            }
            if message.localizedCaseInsensitiveContains("certificate") ||
                message.localizedCaseInsensitiveContains("private key") ||
                message.localizedCaseInsensitiveContains("TLS identity") ||
                message.localizedCaseInsensitiveContains("openssl") {
                return "remote-tls-identity-failed"
            }
            return "remote-listener-failed"
        case .helper:
            if message.contains("Managed runtime") && message.contains("exited unexpectedly") {
                return "managed-runtime-exited"
            }
            if message.contains("before the bridge and tunnel became ready") {
                return "runtime-readiness-exited"
            }
            if message.contains("Timed out waiting for the bridge companion") {
                return "runtime-readiness-timeout"
            }
            return "helper-operation-failed"
        case .operation:
            return nil
        }
    }

    private static func normalizedProblemCode(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
    }
}
