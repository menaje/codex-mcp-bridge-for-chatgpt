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

    static let supportedLanguageCodes = BridgeGeneratedLocalization.supportedLanguageCodes

    static let supportedPreferences = ["auto"] + supportedLanguageCodes

    static func locale(for preference: String) -> Locale {
        if preference == "auto" { return .autoupdatingCurrent }
        let language = supportedLanguageCodes.contains(preference)
            ? preference
            : BridgeGeneratedLocalization.defaultLanguageCode
        return Locale(identifier: language)
    }

    static func languageCode(for preference: String) -> String {
        if preference == "auto" { return preferredSystemLanguageCode }
        return supportedLanguageCodes.contains(preference) ? preference : "en"
    }

    static func string(_ key: String, locale: Locale) -> String {
        // Every call site and generated String Catalog entry uses a semantic
        // key. A missing bundle/key must never leak that identifier to users.
        let fallback = BridgeGeneratedLocalization.defaultStrings[key]
            ?? BridgeGeneratedLocalization.unavailableFallback
        let language = languageCode(for: locale)
        guard let path = Bundle.main.path(forResource: language, ofType: "lproj"),
              let bundle = Bundle(path: path) else {
            return fallback
        }
        let localized = bundle.localizedString(forKey: key, value: fallback, table: nil)
        return localized == key ? fallback : localized
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
        let canonical = effort.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !canonical.isEmpty { return canonical }
        return fallback?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? canonical
    }

    /// Lifecycle failures can contain both an initial failure and rollback
    /// outcome. Map their categories to copy without displaying raw diagnostics.
    static func lifecycleFailureDescription(_ diagnostic: String?, locale: Locale) -> String {
        let message = diagnostic ?? ""
        let causes: [(String, String)] = [
            ("LIFECYCLE_TARGET_CHANGED", "macos.settingsortheselectedclichangedwhilewaiting"),
            ("DRAIN_CANCEL_FAILED", "macos.couldnotresumeacceptingworkchecktheserver"),
            ("RUNTIME_READINESS_TIMEOUT", "macos.thebridgehelperwasnotreadybeforethe"),
            ("Timed out waiting for the bridge companion", "macos.thebridgehelperwasnotreadybeforethe"),
            ("RUNTIME_READINESS_EXITED", "macos.theserverexitedbeforetheconnectionwasready"),
            ("before the bridge and tunnel became ready", "macos.theserverexitedbeforetheconnectionwasready"),
            ("HELPER_SHUTDOWN_TIMEOUT", "macos.thebridgehelperdidnotstopbeforethe"),
            ("HELPER_SHUTDOWN_FAILED", "macos.couldnotstopthebridgehelpercheckthe"),
            ("RUNTIME_STOP_", "macos.thebridgehelperdidnotstopbeforethe"),
            ("RUNTIME_TREE_", "macos.couldnotfinishcheckingorstoppingtherelated"),
            ("LIFECYCLE_HANDOFF_CONNECTION_FAILED", "macos.couldnotfinishthefollowupactionbecause"),
            ("LIFECYCLE_SETTINGS_SAVE_FAILED", "macos.thefollowupactionstoppedbecausethesettings"),
            ("LIFECYCLE_MODE_SAVE_FAILED", "macos.couldnotsavetheconnectionmodecheckthe"),
            ("LIFECYCLE_RECEIPT_SAVE_FAILED", "macos.couldnotsavetheactionresultcheckthe"),
            ("LIFECYCLE_RUNTIME_NOT_STOPPED", "macos.thefollowupactiondidnotproceedbecause"),
            ("LIFECYCLE_RECOVERY_REQUIRED", "macos.therecoveredserverstatedoesnotmatchthe"),
            ("HELPER_REPLACEMENT_ROLLBACK_FAILED", "macos.bothhelperreplacementandrestoringtheprevioushelper"),
            ("HELPER_REPLACEMENT_FAILED", "macos.couldnotfinishreplacingthehelpercheckthe"),
            ("HELPER_LAUNCH_FAILED", "macos.couldnotstartthebridgehelpercheckthe"),
            ("HELPER_BUILD_MISMATCH", "macos.therunningbridgehelperisincompatiblewiththis"),
            ("BRIDGE_RUNTIME_MISSING", "macos.theinstalledbridgehelpercouldnotbefound"),
            ("SETUP_REQUIRED", "macos.runtimeconnectiondetailshavenotbeensavedyet")
        ]
        let configurationFailed = message.contains("CONFIG_APPLY_FAILED") || message.contains("CONFIG_ROLLBACK_")
        var details: [String] = configurationFailed ? [string("macos.couldnotapplythesettings", locale: locale)] : []
        if let cause = causes.first(where: { message.contains($0.0) }) {
            details.append(string(cause.1, locale: locale))
        }
        if message.contains("CONFIG_ROLLBACK_RESTART_FAILED") {
            details.append(string("macos.theprevioussettingswererestoredbuttheserver", locale: locale))
        } else if message.contains("CONFIG_ROLLBACK_FAILED") {
            details.append(string("macos.couldnotrestoretheprevioussettingscheckthe", locale: locale))
        } else if message.contains("Previous runtime configuration was restored.") {
            details.append(string("macos.theprevioussettingswererestored", locale: locale))
        }
        return details.isEmpty
            ? string("macos.thereservedoperationcouldnotfinishcheckthe", locale: locale)
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
                    "macos.therequestcouldnotbecompletedcheckthe",
                    locale: locale
                )
        }

        let key: String
        switch code {
        case "tunnel-connection-pending":
            return nil
        case "tunnel-process-exited", "tunnel-process-not-running":
            key = "macos.thesecuremcptunnelprocessisnotrunning"
        case "tunnel-readiness-probe-failed", "tunnel-health-probe-failed":
            key = "macos.unabletoverifythesecuremcptunnelconnection"
        case "tunnel-status-previous-launcher", "tunnel-status-different-build",
             "tunnel-status-different-profile", "tunnel-status-stale":
            key = "macos.thesecuremcptunnelstatusdoesnotmatch"
        case "runtime-env-not-configured":
            key = "macos.runtimeconnectiondetailshavenotbeensavedyet"
        case "runtime-env-permissions-too-broad":
            key = "macos.theconnectionfileorfolderpermissionsaretoo"
        case "runtime-env-not-regular":
            key = "macos.connectiondetailsmustbestoredinaregular"
        case "runtime-env-owner-mismatch":
            key = "macos.theconnectionfileorfolderisnotowned"
        case "runtime-api-key-invalid":
            key = "macos.thetunnelruntimeapikeyismissingor"
        case "tunnel-id-invalid":
            key = "macos.thetunnelidismissingorhasan"
        case "runtime-env-project-conflict":
            key = "macos.movetheconnectionfileoutsideallregisteredproject"
        case "runtime-env-invalid-content", "runtime-env-invalid":
            key = "macos.theconnectionfilecontentsareinvalid"
        case "codex-requested-state-invalid", "codex-requested-state-unavailable":
            key = "macos.settingscouldnotbeloaded"
        case "remote-endpoint-not-configured":
            key = "macos.theremotemanagementserveraddressisnotconfigured"
        case "remote-address-in-use":
            key = "macos.anotherapplicationisusingthespecifiedaddressor"
        case "remote-listener-permission-denied":
            key = "macos.theremotemanagementservercannotstartwiththe"
        case "remote-tls-identity-failed":
            key = "macos.thesecuritycertificateforremotemanagementcouldnot"
        case "remote-listener-failed", "remote-management-not-listening":
            key = "macos.theremotemanagementserverdidnotstartat"
        case "bridge-runtime-missing":
            key = "macos.theinstalledbridgehelpercouldnotbefound"
        case "runtime-readiness-timeout":
            key = "macos.thebridgehelperwasnotreadybeforethe"
        case "runtime-stop-failed", "runtime-stop-incomplete":
            key = "macos.thebridgehelperdidnotstopbeforethe"
        case "settings-revision-conflict", "project-registry-revision-conflict":
            key = "macos.settingschangedelsewherereviewthelatestvaluesand"
        case "pairing-expired":
            key = "macos.thepairinginvitationhasexpiredcreateanew"
        case "pairing-code-invalid":
            key = "macos.thepairinginvitationisinvalidcreateanew"
        case "drain-timeout":
            key = "macos.theappwasnotquitbecauseactivework"
        case "background-process-state-unknown":
            key = "macos.theappwasnotquitsafelybecausesome"
        case "background-processes-active":
            key = "macos.theappwasnotquitsafelybecausebackground"
        default:
            key = "macos.therequestcouldnotbecompletedcheckthe"
        }
        return string(key, locale: locale)
    }

    static func languageCode(for locale: Locale) -> String {
        let identifier = locale.identifier.replacingOccurrences(of: "_", with: "-").lowercased()
        if identifier == "ko" || identifier.hasPrefix("ko-") { return "ko" }
        if identifier == "ja" || identifier.hasPrefix("ja-") { return "ja" }
        if BridgeGeneratedLocalization.traditionalChineseTags.contains(where: {
            identifier == $0 || identifier.hasPrefix("\($0)-")
        }) || BridgeGeneratedLocalization.traditionalChineseRegions.contains(where: {
            identifier.range(of: "^zh-\($0)(-|$)", options: .regularExpression) != nil
        }) {
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
            return string("macos.thesavedserverprofilelistisinvalid", locale: locale)
        case .invalidServerIdentity:
            return string("macos.theserveridisinvalid", locale: locale)
        case .invalidCredential:
            return string("macos.theserverdevicecredentialisinvalid", locale: locale)
        case .keychain(let status):
            return format("macos.protectedcredentialstoreerror", locale: locale, Int(status))
        }
    }

    private static func remoteCompanionErrorDescription(
        _ error: RemoteCompanionError,
        locale: Locale
    ) -> String {
        switch error {
        case .invalidInvitation:
            return string("macos.thepairinginvitationisinvalidcreateanew", locale: locale)
        case .expiredInvitation:
            return string("macos.thepairinginvitationhasexpiredcreateanew", locale: locale)
        case .invalidEndpoint:
            return string("macos.theserveraddressmustbeanhttpsaddress", locale: locale)
        case .invalidCertificatePin:
            return string("macos.theservercertificatefingerprintisinvalid", locale: locale)
        case .certificateMismatch:
            return string(
                "macos.theservercertificatediffersfromtheoneverified",
                locale: locale
            )
        case .serverIdentityMismatch:
            return string(
                "macos.therespondingserveriddiffersfromthesaved",
                locale: locale
            )
        case .incompatibleProtocol:
            return string(
                "macos.theremotemanagementprotocolversionsofthisapp",
                locale: locale
            )
        case .credentialMissing:
            return string(
                "macos.thedevicecredentialforthisservercouldnot",
                locale: locale
            )
        case .unauthorized:
            return string(
                "macos.theserverrejectedthisdevicescredentialcheck",
                locale: locale
            )
        case .forbidden:
            return string(
                "macos.thisdeviceisnotauthorizedtousethe",
                locale: locale
            )
        case .responseTooLarge:
            return string("macos.theremoteserverresponseexceededtheallowedsize", locale: locale)
        case .invalidResponse(let message):
            return format(
                "macos.couldnotreadtheremoteserverresponse",
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
                "macos.theinstalledbridgehelpercouldnotbefound",
                locale: locale
            )
        case .nodeMissing:
            return string(
                "macos.nodejs22orlatercouldnotbe",
                locale: locale
            )
        case .launchFailed(let message):
            return format(
                "macos.couldnotstartthebridgehelper",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .readinessTimeout:
            return string("macos.thebridgehelperwasnotreadybeforethe", locale: locale)
        case .incompatibleHelper:
            return string(
                "macos.therunningbridgehelperisincompatiblewiththis",
                locale: locale
            )
        case .replacementBlocked(let message):
            return format(
                "macos.thehelperupdatewasstoppedbecauserunningwork",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .replacementPending:
            return string("macos.thehelperwillupdatewhenthecurrentwork", locale: locale)
        case .shutdownFailed(let message):
            return format(
                "macos.couldnotstopthebridgehelper",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .shutdownTimeout:
            return string(
                "macos.thebridgehelperdidnotstopbeforethe",
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
            return string("macos.thelocalconnectionpathisinvalid", locale: locale)
        case .peerIdentityMismatch:
            return string(
                "macos.theconnectionwasrefusedbecausethelocalservice",
                locale: locale
            )
        case .connectionFailed(let message):
            return format(
                "macos.couldnotconnecttothelocalservice",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .writeFailed(let message):
            return format(
                "macos.couldnotsendarequesttothelocal",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .responseTooLarge:
            return string("macos.thelocalserviceresponseexceededtheallowedsize", locale: locale)
        case .emptyResponse:
            return string("macos.thelocalserviceclosedtheconnectionwithouta", locale: locale)
        case .malformedResponse(let message):
            if message == "BRIDGE_RESPONSE_CONTRACT_MISMATCH" {
                return string(
                    "macos.therunningbridgehelperisincompatiblewiththis",
                    locale: locale
                )
            }
            return format(
                "macos.couldnotreadthelocalserviceresponse",
                locale: locale,
                localizedErrorDetail(message, locale: locale)
            )
        case .remote(_, let message):
            return localizedErrorDetail(message, locale: locale)
        }
    }

    private static func localizedErrorDetail(_ message: String, locale: Locale) -> String {
        if let skillError = skillErrorDescription(message, locale: locale) {
            return skillError
        }
        if message.contains("SETUP_CANDIDATE_UNAVAILABLE") {
            return string("macos.thediscoveredconnectionsettingsarenolongervalid", locale: locale)
        }
        if message.contains("SETUP_API_KEY_UNAVAILABLE") {
            return string("macos.theruntimeapikeyfortheselectedtunnel", locale: locale)
        }

        let recoveryMarker = " 이전 helper 복구에도 실패했습니다: "
        if message.contains("LIFECYCLE_BUSY") {
            return string("macos.anoperationisalreadyreservedcancelitbefore", locale: locale)
        }
        if let markerRange = message.range(of: recoveryMarker) {
            let initialFailure = String(message[..<markerRange.lowerBound])
            let recoveryFailure = String(message[markerRange.upperBound...])
            return [
                localizedErrorDetail(initialFailure, locale: locale),
                format(
                    "macos.restoringtheprevioushelperalsofailed",
                    locale: locale,
                    localizedErrorDetail(recoveryFailure, locale: locale)
                )
            ].joined(separator: " ")
        }

        let direct = string(message, locale: locale)
        if direct != message { return direct }

        let dynamicKeys = [
            "macos.theexistinglaunchagentplistisnotaregular",
            "macos.couldnotreadtheremoteserverresponse",
            "macos.couldnotstartthebridgehelper",
            "macos.thehelperupdatewasstoppedbecauserunningwork",
            "macos.couldnotstopthebridgehelper",
            "macos.couldnotconnecttothelocalservice",
            "macos.couldnotsendarequesttothelocal",
            "macos.couldnotreadthelocalserviceresponse"
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
            "macos.therequestcouldnotbecompletedcheckthe",
            locale: locale
        )
    }

    /// Bridge skill errors cross the companion boundary as stable machine
    /// codes. Never expose the helper's English diagnostic suffix in native UI.
    private static func skillErrorDescription(_ message: String, locale: Locale) -> String? {
        let mappings: [(codes: [String], localized: String)] = [
            (["SKILL_VERSION_CHANGED"],
             string("macos.skills.theSkillWasChangedElsewhereLoadTheLatestVersionAndTryAgain", locale: locale)),
            (["SKILL_FILE_NOT_FOUND", "SKILL_VERSION_NOT_FOUND", "SKILL_NOT_FOUND"],
             string("macos.skills.theRequestedSkillOrMarkdownFileVersionCouldNotBeFound", locale: locale)),
            (["SKILL_NAME_CONFLICT"],
             string("macos.skills.aBridgeSkillWithTheSameNameAlreadyExists", locale: locale)),
            (["SKILL_LIBRARY_BUSY"],
             string("macos.skills.anotherOperationIsChangingTheSkillLibraryTryAgainShortly", locale: locale)),
            (["SKILL_LIBRARY_CORRUPT"],
             string("macos.skills.theIntegrityOfTheSkillLibraryCouldNotBeVerifiedCheckTheDiagnosticLog", locale: locale)),
            (["SKILL_DELETE_CLEANUP_PENDING"],
             string("macos.skills.theSkillWasDeletedButSecureCleanupIsNotFinishedRetryWithTheSameRequest", locale: locale)),
            (["SKILL_MUTATION_REQUEST_REUSED", "SKILL_MUTATION_INVALIDATED"],
             string("macos.skills.thisChangeRequestWasUsedByAnotherOperationOrInvalidatedByDeletionTryAgainWithANewRequest", locale: locale)),
            (["SKILL_FILE_TYPE_UNSUPPORTED", "SKILL_PACKAGE_FILE_UNSUPPORTED"],
             string("macos.skills.onlyUtf8MdAndMarkdownFilesAreCurrentlySupported", locale: locale)),
            (["SKILL_FILE_PATH_INVALID", "SKILL_FILE_PATH_CONFLICT", "SKILL_PACKAGE_PATH_INVALID",
              "SKILL_PACKAGE_PATH_CONFLICT", "SKILL_PACKAGE_PATH_ENCODING_INVALID"],
             string("macos.skills.thePackageContainsAnUnsafeOrUnsupportedFilePath", locale: locale)),
            (["SKILL_FILES_INVALID", "SKILL_FILE_TOO_LARGE", "SKILL_FILES_TOO_LARGE"],
             string("macos.skills.theMarkdownFilesExceedTheAllowedFileCountOrSizeLimit", locale: locale)),
            (["SKILL_FILE_CHANGES_INVALID", "SKILL_FILE_INVALID", "SKILL_CONTENT_INVALID",
              "SKILL_DESCRIPTION_INVALID", "SKILL_NAME_INVALID", "SKILL_MUTATION_INVALID",
              "SKILL_MUTATION_REQUEST_ID_INVALID", "SKILL_ID_INVALID", "SKILL_ENABLED_INVALID",
              "SKILL_SEARCH_INVALID", "SKILL_SEARCH_LIMIT_INVALID", "SKILL_UPDATE_EMPTY", "SKILL_VERSION_INVALID"],
             string("macos.skills.theSkillChangesAreInvalidCheckTheInput", locale: locale)),
            (["SKILL_PACKAGE_TEXT_INVALID"],
             string("macos.skills.thePackageContainsAFileThatIsNotValidUtf8Markdown", locale: locale)),
            (["SKILL_PACKAGE_ENCRYPTED"],
             string("macos.skills.encryptedZipPackagesCannotBeImported", locale: locale)),
            (["SKILL_PACKAGE_ZIP64_UNSUPPORTED", "SKILL_PACKAGE_COMPRESSION_UNSUPPORTED"],
             string("macos.skills.thisZipCompressionFormatIsNotSupported", locale: locale)),
            (["SKILL_PACKAGE_BOMB", "SKILL_PACKAGE_EXPANDED_TOO_LARGE",
              "SKILL_PACKAGE_COMPRESSED_TOO_LARGE"],
             string("macos.skills.theZipPackageExceedsTheAllowedFileCountOrSizeLimit", locale: locale)),
            (["SKILL_PACKAGE_NESTED_ARCHIVE"],
             string("macos.skills.archivesNestedInsideAZipCannotBeImported", locale: locale)),
            (["SKILL_PACKAGE_SPECIAL_FILE"],
             string("macos.skills.symbolicLinksAndSpecialFilesInAZipCannotBeImported", locale: locale)),
            (["SKILL_PACKAGE_NO_MARKDOWN"],
             string("macos.skills.theZipContainsNoSupportedMarkdownFiles", locale: locale)),
            (["SKILL_PACKAGE_MAIN_REQUIRED", "SKILL_PACKAGE_MAIN_NOT_FOUND",
              "SKILL_PACKAGE_MAIN_CONFLICT", "SKILL_PACKAGE_SELECTION_INVALID"],
             string("macos.skills.checkTheMainMarkdownDocumentAndFileSelectionToImport", locale: locale)),
            (["SKILL_UPLOAD_NOT_FOUND"],
             string("macos.skills.theZipUploadExpiredOrWasAlreadyUsedSelectTheFileAgain", locale: locale)),
            (["SKILL_UPLOAD_ALREADY_INSPECTED", "SKILL_UPLOAD_CHUNK_INVALID",
              "SKILL_UPLOAD_CHUNK_OUT_OF_ORDER", "SKILL_PACKAGE_EMPTY"],
             string("macos.skills.theZipUploadCouldNotBeCompletedSelectTheFileAgain", locale: locale)),
            (["SKILL_PACKAGE_INVALID", "SKILL_PACKAGE_CORRUPT"],
             string("macos.skills.theZipPackageIsInvalidOrDamaged", locale: locale)),
            (["SKILL_SOURCE_UNSUPPORTED"],
             string("macos.skills.thisFeatureCanManageBridgeSkillsOnly", locale: locale)),
            (["SKILL_LIBRARY_DIRECTORY_INVALID"],
             string("macos.skills.theBridgeSkillStorageLocationIsInvalid", locale: locale))
        ]
        if let mapping = mappings.first(where: { item in
            item.codes.contains(where: message.contains)
        }) {
            return mapping.localized
        }
        if message.range(of: #"\bSKILL_[A-Z0-9_]+\b"#, options: .regularExpression) != nil {
            return string(
                "macos.skills.theSkillRequestCouldNotBeCompletedCheckTheInputAndConnectionThenTryAgain",
                locale: locale
            )
        }
        return nil
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
