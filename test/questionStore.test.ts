import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";

describe("durable question lifecycle", () => {
  it("recovers user answers and never redispatches a crash-boundary Codex answer", () => {
    const root = mkdtempSync(path.join(tmpdir(), "question-restart-")), file = path.join(root, "state.sqlite");
    let store = new BridgeStateStore({ file });
    try {
      const question = store.questions.create("scope-a", { requestId: randomUUID(), title: "Choose", questions: [{ id: "choice", header: "Choice", question: "Which option?" }] });
      const submitted = store.questions.submit(question, { choice: ["Saved user answer"] });
      const claim = store.questions.claimNotification(submitted);
      expect(claim.send).toBe(true);
      store.questions.beginDelivery("scope-a", "request-a", "question-ref", "answer-digest-only");
      store.close();
      store = new BridgeStateStore({ file });
      const recovered = store.questions.get("scope-a", question.questionId);
      expect(recovered.responseRef).toBe(submitted.responseRef);
      expect(store.questions.claimNotification(recovered).send).toBe(false);
      expect(store.questions.readResponses("scope-a", submitted.responseRef)[0].answers).toEqual({ choice: ["Saved user answer"] });
      expect(store.questions.delivery("scope-a", "request-a", "answer-digest-only")).toBe("uncertain");
      expect(() => store.questions.beginDelivery("scope-a", "new-request", "question-ref", "different-digest")).toThrow("QUESTION_ALREADY_DISPATCHED");
      const readOnly = new Database(file, { readonly: true });
      const journal = readOnly.prepare("SELECT * FROM codex_question_deliveries").all();
      readOnly.close();
      expect(JSON.stringify(journal)).not.toContain("Saved user answer");
      const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 8 * 86400_000);
      expect(() => store.questions.get("scope-a", question.questionId)).toThrow("QUESTION_UNAVAILABLE");
      expect(store.questions.delivery("scope-a", "request-a", "answer-digest-only")).toBe("uncertain");
    } finally { vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("records startup expiry and dispatch recovery with separate causes and counts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "question-maintenance-"));
    const file = path.join(root, "state.sqlite");
    const now = Date.parse("2026-09-12T00:00:00.000Z");
    let store = new BridgeStateStore({ file });
    store.close();
    const database = new Database(file);
    database.prepare(
      "INSERT INTO user_questions(question_id,scope_id,request_id,response_ref,expires_at,payload) " +
      "VALUES ('expired','scope','expired-request',NULL,?,'{}')"
    ).run(now - 1);
    const insertDelivery = database.prepare(
      "INSERT INTO codex_question_deliveries(scope_id,request_id,question_ref,action_hash,status,created_at) " +
      "VALUES ('scope',?,?,?,?,?)"
    );
    insertDelivery.run("dispatching-request", "dispatching-ref", "a".repeat(64), "dispatching", now);
    insertDelivery.run(
      "delivered-request",
      "delivered-ref",
      "b".repeat(64),
      "delivered",
      now - 8 * 24 * 60 * 60 * 1000
    );
    insertDelivery.run(
      "uncertain-request",
      "uncertain-ref",
      "c".repeat(64),
      "uncertain",
      now - 8 * 24 * 60 * 60 * 1000
    );
    database.close();

    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      store = new BridgeStateStore({ file });
      expect(store.questions.startupMaintenance).toEqual({
        dispatchesMarkedUncertain: 1,
        expiredQuestionsRemoved: 1,
        deliveredJournalsRemoved: 1
      });
      expect(JSON.parse(store.getMeta("state_startup_maintenance_last")!)).toMatchObject({
        reason: "question-expiry-and-dispatch-recovery",
        dispatchesMarkedUncertain: 1,
        expiredQuestionsRemoved: 1,
        deliveredJournalsRemoved: 1
      });
      const readOnly = new Database(file, { readonly: true, fileMustExist: true });
      expect(readOnly.prepare(
        "SELECT request_id,status FROM codex_question_deliveries ORDER BY request_id"
      ).all()).toEqual([
        { request_id: "dispatching-request", status: "uncertain" },
        { request_id: "uncertain-request", status: "uncertain" }
      ]);
      expect((readOnly.prepare("SELECT COUNT(*) AS count FROM user_questions").get() as {
        count: number;
      }).count).toBe(0);
      readOnly.close();
    } finally {
      vi.restoreAllMocks();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
