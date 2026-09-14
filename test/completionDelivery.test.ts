import { describe, expect, it } from "vitest";
import {
  DashboardAutoPresentationProofs,
  completionDeliveryEventId,
  completionFollowUpPrompt,
  selectCompletionDeliveryRoute
} from "../src/completionDelivery.js";

const SCOPE = "11111111-1111-4111-8111-111111111111";

describe("completion delivery routing", () => {
  it("prefers a verified host event, then an automatic Dashboard, then a durable pending state", () => {
    expect(selectCompletionDeliveryRoute({ verifiedHostEvent: true, automaticDashboard: true }))
      .toBe("host-event");
    expect(selectCompletionDeliveryRoute({ verifiedHostEvent: false, automaticDashboard: true }))
      .toBe("dashboard");
    expect(selectCompletionDeliveryRoute({ verifiedHostEvent: false, automaticDashboard: false }))
      .toBe("pending");
  });

  it("binds an automatic Dashboard capability to one conversation and widget", () => {
    let now = 1_000;
    const proofs = new DashboardAutoPresentationProofs(() => now, 100);
    const presentation = proofs.issue({ scopeId: SCOPE, jobId: "background-job" });

    expect(proofs.require({
      token: presentation.token,
      scopeId: SCOPE,
      hostScopeId: SCOPE,
      widgetInstanceId: "dashboard-one"
    })).toMatchObject({ scopeId: SCOPE, jobId: "background-job" });
    expect(() => proofs.require({
      token: presentation.token,
      scopeId: SCOPE,
      hostScopeId: SCOPE,
      widgetInstanceId: "dashboard-two"
    })).toThrow(/AUTOMATIC_PRESENTATION_STALE/);
    expect(() => proofs.require({
      token: presentation.token,
      scopeId: SCOPE,
      hostScopeId: "22222222-2222-4222-8222-222222222222",
      widgetInstanceId: "dashboard-one"
    })).toThrow(/AUTOMATIC_PRESENTATION_STALE/);

    now += 100;
    expect(() => proofs.require({
      token: presentation.token,
      scopeId: SCOPE,
      hostScopeId: SCOPE,
      widgetInstanceId: "dashboard-one"
    })).toThrow(/AUTOMATIC_PRESENTATION_STALE/);
  });

  it("uses a stable opaque event ID in a bounded follow-up prompt", () => {
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
    const prompt = completionFollowUpPrompt([event]);
    expect(prompt).toContain(eventId);
    expect(prompt).not.toContain(event.activityId);
  });
});
