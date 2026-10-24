import CodexBridgeKit
import Foundation

/// Notices invalidate a read; only the durable outbox decides what can be claimed.
struct CompletionNotificationWakeState {
    private var epoch: String?
    private var retiredEpochs: [String] = []
    private var version = -1
    private var readyVersion = -1
    private var eventConnected = false
    private var reconnectPending = true
    private var lastCheck: Date?
    private var nextAvailable: Date?

    mutating func observe(_ notice: ChangeNotice) -> Bool {
        let parts = notice.revision.split(separator: ":")
        guard parts.count == 2, let nextVersion = Int(parts[1]), nextVersion >= 0 else { return false }
        let nextEpoch = String(parts[0])
        guard !retiredEpochs.contains(nextEpoch) else { return false }
        let changedEpoch = epoch != nextEpoch
        if changedEpoch {
            if let epoch { retiredEpochs.append(epoch); retiredEpochs = Array(retiredEpochs.suffix(8)) }
            epoch = nextEpoch
            version = -1
            readyVersion = -1
        }
        guard nextVersion >= version else { return false }
        version = nextVersion
        eventConnected = notice.supportedTopics?.contains("completion-outbox-ready") == true
        let recover = changedEpoch || reconnectPending
        reconnectPending = false
        guard eventConnected, notice.topics.contains("completion-outbox-ready"),
              let revision = notice.topicRevisions?["completion-outbox-ready"] else { return recover }
        let ready = revision.split(separator: ":")
        guard ready.count == 2, String(ready[0]) == nextEpoch, let value = Int(ready[1]),
              value > readyVersion, value <= nextVersion else { return recover }
        readyVersion = value
        return true
    }

    mutating func disconnected() {
        eventConnected = false
        reconnectPending = true
    }

    func recoveryDue(at now: Date) -> Bool {
        guard let lastCheck else { return true }
        if let nextAvailable, nextAvailable <= now { return true }
        return now.timeIntervalSince(lastCheck) >= (eventConnected ? 60 : 10)
    }

    mutating func checked(at now: Date, nextAvailableAt: Date?) {
        lastCheck = now
        nextAvailable = nextAvailableAt
    }
}
