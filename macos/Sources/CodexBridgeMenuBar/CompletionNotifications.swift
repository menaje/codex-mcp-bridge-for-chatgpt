import CodexBridgeKit
import Foundation

/// Delivers durable, opaque bridge completion events through macOS. This does
/// not own a card, create a ChatGPT message, or expose task content in the
/// notification surface.
@MainActor
final class CompletionNotifications {
    private let delivery: any CompletionNotificationDelivering
    private let leaseOwner = UUID().uuidString.lowercased()
    private var refreshing = false
    private(set) var nextAvailableAt: Date?

    init(delivery: any CompletionNotificationDelivering) {
        self.delivery = delivery
    }

    @discardableResult
    func refresh(client: BridgeCompanionClient, locale: Locale,
                 isCurrent: @MainActor () -> Bool = { true }) async -> Bool {
        guard !refreshing, !Task.isCancelled, isCurrent() else { return false }
        refreshing = true
        defer { refreshing = false }
        nextAvailableAt = nil

        // Do not claim an event until macOS can actually present it. The
        // bridge retains it while permission is undecided or disabled.
        guard await delivery.isAuthorized(), !Task.isCancelled, isCurrent() else { return false }

        do {
            let availability = try await client.completionAvailability()
            guard !Task.isCancelled, isCurrent() else { return false }
            nextAvailableAt = availability.nextAvailableAt.map { Date(timeIntervalSince1970: $0 / 1_000) }
            guard availability.available else { return false }
        } catch {
            // Older companions have no preflight method. Their durable claim is
            // still the authority, checked on the bounded recovery cadence.
            guard let rpcError = error as? LocalRPCError, rpcError.isUnsupportedMethod,
                  !Task.isCancelled, isCurrent() else { return false }
        }

        guard await delivery.isAuthorized(), !Task.isCancelled, isCurrent() else { return false }
        let events: [NativeCompletionNotification]
        do {
            events = try await client.claimCompletionNotifications(
                leaseOwner: leaseOwner,
                limit: 10
            )
        } catch {
            return false
        }
        guard !events.isEmpty, !Task.isCancelled, isCurrent() else { return false }

        var deliveredIDs: [Int] = []
        var releaseIDs: [Int] = []
        for event in events {
            guard !Task.isCancelled, isCurrent() else { return false }
            do {
                // eventId is stable across retries, allowing macOS to coalesce
                // the small crash window between presentation and outbox ack.
                try await delivery.deliverCompletion(identifier: event.eventId, locale: locale)
                deliveredIDs.append(event.outboxId)
            } catch {
                releaseIDs.append(event.outboxId)
            }
        }

        guard !Task.isCancelled, isCurrent() else { return false }
        if !deliveredIDs.isEmpty {
            do {
                try await client.markCompletionNotificationsDelivered(
                    outboxIDs: deliveredIDs,
                    leaseOwner: leaseOwner
                )
            } catch {
                releaseIDs.append(contentsOf: deliveredIDs)
            }
        }

        guard !Task.isCancelled, isCurrent() else { return false }
        if !releaseIDs.isEmpty {
            try? await client.releaseCompletionNotifications(
                outboxIDs: Array(Set(releaseIDs)).sorted(),
                leaseOwner: leaseOwner
            )
        }
        if let availability = try? await client.completionAvailability() {
            nextAvailableAt = availability.nextAvailableAt.map { Date(timeIntervalSince1970: $0 / 1_000) }
        }
        // Continue only full, successful batches. Failures wait for persisted
        // retry deadlines (or lease expiry if release/ack was lost).
        return releaseIDs.isEmpty && events.count == 10 && !Task.isCancelled && isCurrent()
    }
}
