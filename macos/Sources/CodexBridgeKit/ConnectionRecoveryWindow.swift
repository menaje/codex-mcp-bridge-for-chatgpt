import Foundation

/// Presentation grace for a failed observation, never an execution or shutdown gate.
public struct ConnectionRecoveryWindow: Sendable {
    public private(set) var isChecking = false
    private var failedSince: Date?
    private var lastObservation: Date?

    public init() {}

    public mutating func expire() {
        isChecking = false
    }

    public mutating func observe(
        available: Bool,
        retryable: Bool,
        at now: Date = Date()
    ) {
        // Give a fresh probe a chance after wake or a clock adjustment.
        if let previous = lastObservation,
           now.timeIntervalSince(previous) < 0 || now.timeIntervalSince(previous) > 20 {
            failedSince = nil
        }
        lastObservation = now
        guard !available, retryable else {
            failedSince = nil
            isChecking = false
            return
        }
        if failedSince == nil { failedSince = now }
        isChecking = now.timeIntervalSince(failedSince ?? now) < 8
    }
}
