import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";

const SCOPE = "11111111-1111-4111-8111-111111111111";
const FOREIGN_SCOPE = "22222222-2222-4222-8222-222222222222";

describe("durable free-form decision cards", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates and revises cards without a project, Activity, Agent, or Job", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const requestId = randomUUID();
      const first = store.decisionCards.create(SCOPE, {
        requestId,
        title: "Choose a rollout",
        html: '<label>Plan <select name="plan"><option value="staged">Staged</option></select></label>'
      });
      expect(store.listActivities(SCOPE)).toEqual([]);
      expect(store.listJobs()).toEqual([]);
      expect(store.decisionCards.create(SCOPE, {
        requestId,
        title: "Choose a rollout",
        html: '<label>Plan <select name="plan"><option value="staged">Staged</option></select></label>'
      })).toEqual(first);
      expect(() => store.decisionCards.create(SCOPE, {
        requestId,
        title: "Changed under the same request",
        html: "<p>Changed</p>"
      })).toThrow(/DECISION_REQUEST_CONFLICT/);

      const second = store.decisionCards.revise(SCOPE, {
        requestId: randomUUID(),
        cardId: first.cardId,
        expectedVersion: 1,
        title: "Choose a rollout",
        html: '<label>Plan <select name="plan"><option value="staged">Staged</option><option value="pause">Pause</option></select></label>'
      });
      expect(second.version).toBe(2);
      expect(store.decisionCards.get(SCOPE, first.cardId, 1).contentDigest).toBe(first.contentDigest);
      expect(() => store.decisionCards.snapshot(SCOPE, {
        cardId: first.cardId,
        cardVersion: 1,
        presentationRef: first.presentationRef
      })).toThrow(/DECISION_CARD_STALE/);
    } finally {
      store.close();
    }
  });

  it("stores the exact semantic decision before delivery and preserves retries separately", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const card = store.decisionCards.create(SCOPE, {
        requestId: randomUUID(),
        title: "Migration",
        html: `
          <label>Plan <select name="plan" required><option value="a">Staged transition</option><option value="b">Rewrite</option></select></label>
          <label>Duration <input name="duration" type="number" min="1" max="12" data-decision-unit="weeks" /></label>
        `
      });
      const proof = { cardId: card.cardId, cardVersion: card.version, presentationRef: card.presentationRef };
      const submissionId = randomUUID();
      const stored = store.decisionCards.submit(SCOPE, proof, {
        submissionId,
        intent: "confirm",
        fields: [
          { name: "plan", values: ["a"] },
          { name: "duration", values: ["4"] }
        ],
        comment: "Preserve the existing API."
      });
      expect(stored).toMatchObject({
        deliveryState: "stored",
        attemptCount: 0,
        summary: "Intent: Confirmed\nPlan: Staged transition\nDuration: 4 weeks\nUser note: Preserve the existing API."
      });
      expect(stored.summary).not.toContain("Plan: a");

      const duplicate = store.decisionCards.submit(SCOPE, proof, {
        submissionId: randomUUID(),
        intent: "confirm",
        fields: [
          { name: "plan", values: ["a"] },
          { name: "duration", values: ["4"] }
        ],
        comment: "Preserve the existing API."
      });
      expect(duplicate.submissionId).toBe(submissionId);

      const owner = randomUUID();
      const claimed = store.decisionCards.claimDelivery({
        scopeId: SCOPE, proof, receipt: stored.receipt, leaseOwner: owner
      });
      expect(claimed).toMatchObject({ send: true, submission: { deliveryState: "leased", attemptCount: 1 } });
      expect(store.decisionCards.claimDelivery({
        scopeId: SCOPE, proof, receipt: stored.receipt, leaseOwner: owner
      }).send).toBe(false);
      expect(store.decisionCards.recordDeliveryOutcome({
        scopeId: SCOPE,
        proof,
        receipt: stored.receipt,
        leaseOwner: owner,
        outcome: "rejected",
        error: "Host declined the message"
      })).toMatchObject({ deliveryState: "host-rejected", attemptCount: 1 });

      const retryOwner = randomUUID();
      expect(store.decisionCards.claimDelivery({
        scopeId: SCOPE,
        proof,
        receipt: stored.receipt,
        leaseOwner: retryOwner,
        retryRejected: true
      })).toMatchObject({ send: true, submission: { deliveryState: "leased", attemptCount: 2 } });
      expect(store.decisionCards.recordDeliveryOutcome({
        scopeId: SCOPE,
        proof,
        receipt: stored.receipt,
        leaseOwner: retryOwner,
        outcome: "accepted"
      })).toMatchObject({ deliveryState: "host-accepted", hostAcceptedAt: expect.any(Number) });
    } finally {
      store.close();
    }
  });

  it("separates modified resubmissions and enforces conversation scope on every path", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const card = store.decisionCards.create(SCOPE, {
        requestId: randomUUID(),
        title: "Select",
        html: '<label>Choice <select name="choice"><option value="a">A — gradual</option><option value="b">B — immediate</option></select></label>'
      });
      const proof = { cardId: card.cardId, cardVersion: 1, presentationRef: card.presentationRef };
      const first = store.decisionCards.submit(SCOPE, proof, {
        submissionId: randomUUID(), intent: "confirm", fields: [{ name: "choice", values: ["a"] }]
      });
      const revised = store.decisionCards.submit(SCOPE, proof, {
        submissionId: randomUUID(), intent: "confirm", fields: [{ name: "choice", values: ["b"] }], comment: "Only after backup."
      });
      expect(revised).toMatchObject({ sequence: 2, supersedesSubmissionId: first.submissionId });
      const returned = store.decisionCards.submit(SCOPE, proof, {
        submissionId: randomUUID(), intent: "confirm", fields: [{ name: "choice", values: ["a"] }]
      });
      expect(returned).toMatchObject({ sequence: 3, supersedesSubmissionId: revised.submissionId });
      expect(store.decisionCards.submit(SCOPE, proof, {
        submissionId: randomUUID(), intent: "confirm", fields: [{ name: "choice", values: ["a"] }]
      }).submissionId).toBe(returned.submissionId);
      expect(() => store.decisionCards.get(FOREIGN_SCOPE, card.cardId)).toThrow(/UNAVAILABLE/);
      expect(() => store.decisionCards.readResult(FOREIGN_SCOPE, revised.receipt)).toThrow(/UNAVAILABLE/);
      const result = store.decisionCards.readResult(SCOPE, revised.receipt);
      expect(result.submission).toMatchObject({
        resultOfferedAt: expect.any(Number),
        summary: "Intent: Confirmed\nChoice: B — immediate\nUser note: Only after backup."
      });
    } finally {
      store.close();
    }
  });

  it("recovers an unresolved send as uncertain without losing the stored decision", () => {
    const root = mkdtempSync(path.join(tmpdir(), "decision-restart-"));
    const file = path.join(root, "state.sqlite");
    let store = new BridgeStateStore({ file });
    try {
      const card = store.decisionCards.create(SCOPE, {
        requestId: randomUUID(), title: "Confirm", html: "<p>Retain the existing behavior.</p>"
      });
      const proof = { cardId: card.cardId, cardVersion: 1, presentationRef: card.presentationRef };
      const submission = store.decisionCards.submit(SCOPE, proof, {
        submissionId: randomUUID(), intent: "confirm", fields: [], comment: "Proceed."
      });
      store.decisionCards.claimDelivery({
        scopeId: SCOPE, proof, receipt: submission.receipt, leaseOwner: randomUUID()
      });
      store.close();
      store = new BridgeStateStore({ file });
      const recovered = store.decisionCards.readResult(SCOPE, submission.receipt);
      expect(recovered.submission).toMatchObject({
        deliveryState: "acceptance-unknown",
        acceptanceUnknownAt: expect.any(Number),
        summary: "Intent: Confirmed\nUser note: Proceed."
      });
      expect(store.decisionCards.startupMaintenance.expiredLeasesMarkedUnknown).toBe(1);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
