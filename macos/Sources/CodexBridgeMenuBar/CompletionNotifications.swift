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

    init(delivery: any CompletionNotificationDelivering) {
        self.delivery = delivery
    }

    func refresh(client: BridgeCompanionClient, locale: Locale) async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }

        // Do not claim an event until macOS can actually present it. The
        // bridge retains it while permission is undecided or disabled.
        guard await delivery.isAuthorized() else { return }

        let events: [NativeCompletionNotification]
        do {
            events = try await client.claimCompletionNotifications(
                leaseOwner: leaseOwner,
                limit: 10
            )
        } catch {
            return
        }
        guard !events.isEmpty else { return }

        var deliveredIDs: [Int] = []
        var releaseIDs: [Int] = []
        for event in events {
            do {
                // eventId is stable across retries, allowing macOS to coalesce
                // the small crash window between presentation and outbox ack.
                try await delivery.deliverCompletion(identifier: event.eventId, locale: locale)
                deliveredIDs.append(event.outboxId)
            } catch {
                releaseIDs.append(event.outboxId)
            }
        }

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

        if !releaseIDs.isEmpty {
            try? await client.releaseCompletionNotifications(
                outboxIDs: Array(Set(releaseIDs)).sorted(),
                leaseOwner: leaseOwner
            )
        }
    }
}
