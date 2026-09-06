import Foundation
import XCTest
@testable import CodexBridgeKit

final class RemoteConnectionTests: XCTestCase {
    func testLivePinnedPairingWhenRequested() async throws {
        guard let invitation = ProcessInfo.processInfo.environment[
            "CODEX_MCP_BRIDGE_LIVE_REMOTE_INVITATION"
        ] else {
            throw XCTSkip("Set CODEX_MCP_BRIDGE_LIVE_REMOTE_INVITATION for the opt-in HTTPS pairing smoke test.")
        }
        let result = try await RemoteCompanionClient.pair(
            invitation: invitation,
            deviceName: "Swift live test",
            profileName: "Live server"
        )
        let client = try RemoteCompanionClient(
            profile: result.profile,
            credential: result.credential
        )
        defer { client.close() }

        for _ in 0..<20 {
            let hello = try await client.hello()
            XCTAssertEqual(hello.server.id, result.profile.serverId)
            XCTAssertEqual(hello.protocol.name, remoteCompanionProtocolName)
            XCTAssertEqual(hello.protocol.version, remoteCompanionProtocolVersion)
        }
    }

    func testPairingInvitationCarriesPinnedServerIdentityAndExpires() throws {
        let valid = invitation(expiresAt: Date().addingTimeInterval(300))
        let decoded = try RemoteClientPairingInvitation.decode(valid)

        XCTAssertEqual(decoded.protocol, remoteCompanionProtocolName)
        XCTAssertEqual(decoded.serverId, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(decoded.endpoint, "https://studio.example:8766")
        XCTAssertEqual(decoded.certificateSha256, String(repeating: "a", count: 64))

        XCTAssertThrowsError(
            try RemoteClientPairingInvitation.decode(
                invitation(expiresAt: Date().addingTimeInterval(-1))
            )
        ) { error in
            guard case RemoteCompanionError.expiredInvitation = error else {
                return XCTFail("Expected expiredInvitation, got \(error)")
            }
        }
        XCTAssertThrowsError(try RemoteClientPairingInvitation.decode("not-an-invitation"))
    }

    @MainActor
    func testProfilePreferencesContainNoDeviceCredential() throws {
        let suiteName = "CodexBridgeRemoteConnectionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = UserDefaultsBridgeConnectionStore(defaults: defaults)
        let profile = RemoteServerProfile(
            serverId: "11111111-1111-4111-8111-111111111111",
            name: "작업실",
            endpoint: "https://studio.example:8766",
            certificateSha256: String(repeating: "a", count: 64),
            serverDisplayName: "Studio",
            bridgeVersion: "0.3.0",
            bridgeBuildId: "build-test",
            capabilities: ["dashboard.read", "settings.read", "settings.write"],
            lastConnectedAt: nil
        )
        try store.save(BridgeConnectionPreferences(
            mode: .remoteClient,
            activeServerId: profile.serverId,
            profiles: [profile]
        ))

        let loaded = store.load()
        XCTAssertEqual(loaded.activeProfile, profile)
        let persisted = try XCTUnwrap(defaults.data(forKey: "remoteConnectionPreferences.v1"))
        XCTAssertFalse(String(decoding: persisted, as: UTF8.self).contains("device_"))
        XCTAssertThrowsError(try store.save(BridgeConnectionPreferences(
            mode: .remoteClient,
            activeServerId: nil,
            profiles: [profile]
        )))
    }

    func testRemoteHelloRejectsServerAndCertificateReplacement() throws {
        let hello = RemoteCompanionHello(
            protocol: RemoteServerProtocolInfo(
                name: remoteCompanionProtocolName,
                version: remoteCompanionProtocolVersion
            ),
            server: RemoteServerIdentity(
                id: "11111111-1111-4111-8111-111111111111",
                displayName: "Studio",
                certificateSha256: String(repeating: "a", count: 64)
            ),
            bridge: CompanionBridgeInfo(
                name: "bridge",
                title: "Bridge",
                version: "0.3.0",
                buildId: "build-test"
            ),
            capabilities: ["dashboard.read"]
        )
        XCTAssertNoThrow(try hello.validate(
            serverId: hello.server.id,
            certificateSha256: hello.server.certificateSha256
        ))
        XCTAssertThrowsError(try hello.validate(
            serverId: "22222222-2222-4222-8222-222222222222",
            certificateSha256: hello.server.certificateSha256
        )) { error in
            guard case RemoteCompanionError.serverIdentityMismatch = error else {
                return XCTFail("Expected serverIdentityMismatch, got \(error)")
            }
        }
        XCTAssertThrowsError(try hello.validate(
            serverId: hello.server.id,
            certificateSha256: String(repeating: "b", count: 64)
        )) { error in
            guard case RemoteCompanionError.certificateMismatch = error else {
                return XCTFail("Expected certificateMismatch, got \(error)")
            }
        }
    }

    private func invitation(expiresAt: Date) -> String {
        let object: [String: Any] = [
            "version": 1,
            "protocol": remoteCompanionProtocolName,
            "endpoint": "https://studio.example:8766",
            "serverId": "11111111-1111-4111-8111-111111111111",
            "certificateSha256": String(repeating: "a", count: 64),
            "code": "pair_abcdefghijklmnopqrstuvwxyz1234567890ABCDE",
            "expiresAt": fractionalISO8601String(from: expiresAt)
        ]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func fractionalISO8601String(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
