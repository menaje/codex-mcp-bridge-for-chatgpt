import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UiControlProofs } from "../src/uiControlProofs.js";

describe("overview user-control proof", () => {
  it("binds the exact widget and calling conversation, expires and rejects tampering or restart", () => {
    let now = 1_000;
    const proofs = new UiControlProofs(() => now);
    const input = { widgetInstanceId: randomUUID(), hostScopeId: randomUUID(), scopeId: randomUUID(),
      activityId: randomUUID(), generation: 1, agentId: randomUUID(), agentVersion: 2,
      jobId: randomUUID(), jobVersion: 3, processIds: ["process-1"] };
    const token = proofs.issue(input);
    expect(proofs.require(token, input.widgetInstanceId, input.hostScopeId)).toMatchObject(input);
    // Metadata-less app calls can remount only with the same exact private proof.
    expect(proofs.require(token, input.widgetInstanceId).jobId).toBe(input.jobId);
    expect(() => proofs.require(token, randomUUID(), input.hostScopeId)).toThrow("UI_CONTROL_STALE");
    expect(() => proofs.require(token, input.widgetInstanceId, randomUUID())).toThrow("UI_CONTROL_STALE");
    const [payload, signature] = token.split(".");
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), jobId: randomUUID() })).toString("base64url");
    expect(() => proofs.require(`${altered}.${signature}`, input.widgetInstanceId)).toThrow("UI_CONTROL_STALE");
    expect(() => new UiControlProofs(() => now).require(token, input.widgetInstanceId)).toThrow("UI_CONTROL_STALE");
    now += 5 * 60_000;
    expect(() => proofs.require(token, input.widgetInstanceId)).toThrow("UI_CONTROL_STALE");
  });
});
