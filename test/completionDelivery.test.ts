import { describe, expect, it } from "vitest";
import {
  completionDeliveryEventId,
  nativeCompletionNotification,
  selectCompletionDeliveryRoute
} from "../src/completionDelivery.js";

const SCOPE = "11111111-1111-4111-8111-111111111111";

describe("completion delivery routing", () => {
  it("uses the local native dispatcher or preserves a durable pending state", () => {
    expect(selectCompletionDeliveryRoute({ nativeNotificationDispatcher: true }))
      .toBe("native-notification");
    expect(selectCompletionDeliveryRoute({ nativeNotificationDispatcher: false }))
      .toBe("pending");
  });

  it("uses a stable opaque event ID for a future durable dispatcher", () => {
    const event = {
      outboxId: 42,
      scopeId: SCOPE,
      activityId: "33333333-3333-4333-8333-333333333333",
      completionVersion: 3,
      channel: "notify" as const
    };
    const eventId = completionDeliveryEventId(event);
    expect(completionDeliveryEventId({ ...event })).toBe(eventId);
    expect(completionDeliveryEventId({ ...event, completionVersion: 4 })).not.toBe(eventId);
  });

  it("projects a native receipt without task or conversation content", () => {
    const receipt = nativeCompletionNotification({
      outboxId: 42,
      scopeId: SCOPE,
      activityId: "33333333-3333-4333-8333-333333333333",
      completionVersion: 3,
      channel: "notify"
    });

    expect(receipt).toEqual({
      eventId: expect.stringMatching(/^completion-[0-9a-f]{64}$/),
      outboxId: 42
    });
    expect(Object.keys(receipt).sort()).toEqual(["eventId", "outboxId"]);
    expect(JSON.stringify(receipt)).not.toContain(SCOPE);
  });
});
