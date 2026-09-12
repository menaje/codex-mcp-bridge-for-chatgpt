import Foundation
import Security

public enum BridgeAppMode: String, Codable, Sendable, CaseIterable {
    case localHost = "local-host"
    case remoteClient = "remote-client"
}

public struct BridgeConnectionPreferences: Codable, Sendable, Equatable {
    public var mode: BridgeAppMode
    public var activeServerId: String?
    public var profiles: [RemoteServerProfile]

    public init(
        mode: BridgeAppMode = .localHost,
        activeServerId: String? = nil,
        profiles: [RemoteServerProfile] = []
    ) {
        self.mode = mode
        self.activeServerId = activeServerId
        self.profiles = profiles
    }

    public var activeProfile: RemoteServerProfile? {
        guard let activeServerId else { return nil }
        return profiles.first { $0.serverId == activeServerId }
    }
}

@MainActor
public protocol BridgeConnectionPreferencesStoring: AnyObject {
    func load() -> BridgeConnectionPreferences
    func save(_ preferences: BridgeConnectionPreferences) throws
}

@MainActor
public final class UserDefaultsBridgeConnectionStore: BridgeConnectionPreferencesStoring {
    private let defaults: UserDefaults
    private let key: String

    public init(
        defaults: UserDefaults = .standard,
        key: String = "remoteConnectionPreferences.v1"
    ) {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> BridgeConnectionPreferences {
        guard let data = defaults.data(forKey: key),
              let decoded = try? JSONDecoder().decode(
                BridgeConnectionPreferences.self,
                from: data
              ) else {
            return BridgeConnectionPreferences()
        }
        let uniqueProfiles = decoded.profiles.reduce(into: [RemoteServerProfile]()) {
            profiles, candidate in
            guard profiles.count < 32,
                  !profiles.contains(where: { $0.serverId == candidate.serverId }) else {
                return
            }
            profiles.append(candidate)
        }
        let activeServerId = uniqueProfiles.contains {
            $0.serverId == decoded.activeServerId
        } ? decoded.activeServerId : uniqueProfiles.first?.serverId
        return BridgeConnectionPreferences(
            mode: decoded.mode,
            activeServerId: activeServerId,
            profiles: uniqueProfiles
        )
    }

    public func save(_ preferences: BridgeConnectionPreferences) throws {
        let serverIds = Set(preferences.profiles.map(\.serverId))
        let activeServerIsValid = preferences.profiles.isEmpty
            ? preferences.activeServerId == nil
            : preferences.activeServerId.map(serverIds.contains) == true
        guard preferences.profiles.count <= 32,
              serverIds.count == preferences.profiles.count,
              activeServerIsValid else {
            throw RemoteConnectionStorageError.invalidProfiles
        }
        let data = try JSONEncoder().encode(preferences)
        defaults.set(data, forKey: key)
    }
}

public protocol RemoteCredentialStoring: Sendable {
    func credential(for serverId: String) throws -> String?
    func saveCredential(_ credential: String, for serverId: String) throws
    func deleteCredential(for serverId: String) throws
}

public enum RemoteConnectionStorageError: LocalizedError, Sendable {
    case invalidProfiles
    case invalidServerIdentity
    case invalidCredential
    case keychain(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .invalidProfiles:
            return "저장된 서버 프로필 목록이 올바르지 않습니다."
        case .invalidServerIdentity:
            return "서버 고유 ID가 올바르지 않습니다."
        case .invalidCredential:
            return "서버 기기 자격 증명이 올바르지 않습니다."
        case .keychain(let status):
            return SecCopyErrorMessageString(status, nil) as String? ??
                "보호된 자격 증명 저장소 오류(\(status))"
        }
    }
}

public struct KeychainRemoteCredentialStore: RemoteCredentialStoring, Sendable {
    private let service: String

    public init(service: String = "com.menaje.codex-mcp-bridge.remote-device") {
        self.service = service
    }

    public func credential(for serverId: String) throws -> String? {
        try validateServerId(serverId)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: serverId,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw RemoteConnectionStorageError.keychain(status)
        }
        guard let data = item as? Data,
              let credential = String(data: data, encoding: .utf8),
              credential.hasPrefix("device_"),
              credential.count >= 40 else {
            throw RemoteConnectionStorageError.invalidCredential
        }
        return credential
    }

    public func saveCredential(_ credential: String, for serverId: String) throws {
        try validateServerId(serverId)
        guard credential.hasPrefix("device_"), credential.count >= 40,
              let data = credential.data(using: .utf8) else {
            throw RemoteConnectionStorageError.invalidCredential
        }
        let identity: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: serverId
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(identity as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        if updateStatus != errSecItemNotFound {
            throw RemoteConnectionStorageError.keychain(updateStatus)
        }
        var insertion = identity
        for (key, value) in attributes { insertion[key] = value }
        let addStatus = SecItemAdd(insertion as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw RemoteConnectionStorageError.keychain(addStatus)
        }
    }

    public func deleteCredential(for serverId: String) throws {
        try validateServerId(serverId)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: serverId
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw RemoteConnectionStorageError.keychain(status)
        }
    }

    private func validateServerId(_ serverId: String) throws {
        guard UUID(uuidString: serverId) != nil else {
            throw RemoteConnectionStorageError.invalidServerIdentity
        }
    }
}
