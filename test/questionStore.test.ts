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
});
