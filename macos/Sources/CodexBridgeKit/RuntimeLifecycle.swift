import Darwin
import Foundation

public struct RuntimeLifecycleOperation: Codable, Equatable, Sendable, Identifiable {
    public struct Reason: Codable, Equatable, Sendable {
        public let code: String
        public let count: Int?
    }
    public let requestId: String
    public let kind: String
    public let force: Bool
    public let phase: String
    public let createdAt: String
    public let updatedAt: String
    public let reasons: [Reason]
    public let error: String?
    public let targetBuildId: String?
    public let targetDescription: String?
    public let cancellable: Bool
    public var id: String { requestId }
    public var isPending: Bool { !["completed", "cancelled", "failed"].contains(phase) }
    public var isExecuting: Bool { ["executing", "reconnecting", "handoff-ready", "handing-off"].contains(phase) }
    public var needsHandoff: Bool { ["handoff-ready", "handing-off"].contains(phase) }
}

public struct RuntimeLifecycleRequest: Codable, Sendable {
    public struct Configuration: Codable, Sendable {
        public let apiKey: String?
        public let tunnelId: String?
        public let defaultBackend: String?
        public let maximumAccess: String?
        public init(apiKey: String? = nil, tunnelId: String? = nil, defaultBackend: String? = nil, maximumAccess: String? = nil) {
            self.apiKey = apiKey; self.tunnelId = tunnelId
            self.defaultBackend = defaultBackend; self.maximumAccess = maximumAccess
        }
    }
    public let requestId: String
    public let kind: String
    public let force: Bool
    public let configuration: Configuration?
    public let candidateId: String?
    public let targetBuildId: String?
    public let replacesRequestId: String?
    public init(requestId: String = UUID().uuidString, kind: String, force: Bool = false,
                configuration: Configuration? = nil, candidateId: String? = nil,
                targetBuildId: String? = nil, replacesRequestId: String? = nil) {
        self.requestId = requestId; self.kind = kind; self.force = force
        self.configuration = configuration; self.candidateId = candidateId
        self.targetBuildId = targetBuildId; self.replacesRequestId = replacesRequestId
    }
}

struct RuntimeLifecycleReference: Codable, Sendable { let requestId: String? }
struct RuntimeLifecycleStatus: Codable, Sendable { let operation: RuntimeLifecycleOperation? }

/// The helper journal remains helper-owned. Only the verified external handoff
/// result is written here, after launchd/development helper shutdown is checked.
public enum RuntimeLifecycleHandoffStore {
    public struct Receipt: Codable, Sendable {
        public let requestId: String
        public let kind: String?
        public let outcome: String
        public let failureCode: String?
    }

    public static func read(runtimeLockDirectory: URL) throws -> Receipt? {
        let file = runtimeLockDirectory.deletingLastPathComponent().appendingPathComponent("lifecycle-handoff.json")
        let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW)
        if descriptor < 0 && errno == ENOENT { return nil }
        guard descriptor >= 0 else { throw CocoaError(.fileReadNoPermission) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == getuid(), metadata.st_mode & 0o077 == 0, metadata.st_size <= 65536 else {
            throw CocoaError(.fileReadNoPermission)
        }
        return try JSONDecoder().decode(Receipt.self, from: handle.readToEnd() ?? Data())
    }

    public static func write(requestId: String, completed: Bool, runtimeLockDirectory: URL, failureCode: String? = nil) throws {
        try write(requestId: requestId, kind: nil, outcome: completed ? "completed" : "failed", runtimeLockDirectory: runtimeLockDirectory, failureCode: failureCode)
    }

    /// Persist a stable category, never raw credential-bearing error text.
    public static func failureCode(for error: Error, fallback: String) -> String {
        switch error {
        case HelperBootstrapError.shutdownTimeout: return "HELPER_SHUTDOWN_TIMEOUT"
        case HelperBootstrapError.shutdownFailed: return "HELPER_SHUTDOWN_FAILED"
        case HelperBootstrapError.readinessTimeout: return "RUNTIME_READINESS_TIMEOUT"
        case HelperBootstrapError.incompatibleHelper: return "HELPER_BUILD_MISMATCH"
        case HelperBootstrapError.runtimeMissing, HelperBootstrapError.nodeMissing: return "BRIDGE_RUNTIME_MISSING"
        case HelperBootstrapError.launchFailed(let message):
            return message.contains("이전 helper 복구에도 실패했습니다")
                ? "HELPER_REPLACEMENT_ROLLBACK_FAILED" : "HELPER_LAUNCH_FAILED"
        case is LocalRPCError: return "LIFECYCLE_HANDOFF_CONNECTION_FAILED"
        default: return fallback
        }
    }

    public static func write(requestId: String, kind: String?, outcome: String, runtimeLockDirectory: URL, failureCode: String? = nil) throws {
        let directory = runtimeLockDirectory.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        var metadata = stat()
        guard lstat(directory.path, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == getuid(), metadata.st_mode & 0o077 == 0 else {
            throw CocoaError(.fileWriteNoPermission)
        }
        let temporary = directory.appendingPathComponent(".handoff-\(UUID().uuidString)")
        let destination = directory.appendingPathComponent("lifecycle-handoff.json")
        let safeCode = failureCode.flatMap {
            $0.range(of: #"^[A-Z][A-Z0-9_]{2,79}$"#, options: .regularExpression) != nil ? $0 : nil
        }
        let data = try JSONEncoder().encode(Receipt(requestId: requestId, kind: kind, outcome: outcome, failureCode: safeCode))
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(descriptor); unlink(temporary.path) }
        try data.withUnsafeBytes { buffer in
            var written = 0
            while written < buffer.count {
                let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: written), buffer.count - written)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw CocoaError(.fileWriteUnknown) }
                written += count
            }
        }
        guard fsync(descriptor) == 0, rename(temporary.path, destination.path) == 0 else {
            throw CocoaError(.fileWriteUnknown)
        }
        let directoryDescriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        if directoryDescriptor >= 0 { _ = fsync(directoryDescriptor); Darwin.close(directoryDescriptor) }
    }
}
