import { createHash } from "node:crypto";

/**
 * Completion delivery is deliberately independent from a card renderer.
 * The local macOS companion consumes the durable outbox; it never relies on
 * a mounted ChatGPT card or attempts to resume a ChatGPT conversation.
 */
export type CompletionDeliveryRoute = "native-notification" | "pending";

export type CompletionDeliveryRouteInput = {
  /** True when the local native companion is the configured delivery path. */
  nativeNotificationDispatcher: boolean;
};

export function selectCompletionDeliveryRoute(
  input: CompletionDeliveryRouteInput
): CompletionDeliveryRoute {
  if (input.nativeNotificationDispatcher) return "native-notification";
  return "pending";
}

export type CompletionDeliveryEvent = {
  outboxId: number;
  scopeId: string;
  activityId: string;
  completionVersion: number;
  channel: "notify" | "verify";
};

/**
 * This is intentionally the entire native IPC payload. Task prompts, result
 * bodies, project paths, and conversation identifiers stay in the bridge's
 * durable state and are read only after the user opens Dashboard.
 */
export type NativeCompletionNotification = {
  eventId: string;
  outboxId: number;
};

/** Fixed across attempts so host-side consumers can deduplicate a completion. */
export function completionDeliveryEventId(event: CompletionDeliveryEvent): string {
  return `completion-${createHash("sha256")
    .update("codex-completion-delivery/v1")
    .update("\0")
    .update(event.scopeId)
    .update("\0")
    .update(String(event.outboxId))
    .update("\0")
    .update(event.activityId)
    .update("\0")
    .update(String(event.completionVersion))
    .update("\0")
    .update(event.channel)
    .digest("hex")}`;
}

export function nativeCompletionNotification(
  event: CompletionDeliveryEvent & { channel: "notify" }
): NativeCompletionNotification {
  return {
    eventId: completionDeliveryEventId(event),
    outboxId: event.outboxId
  };
}
