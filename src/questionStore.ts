import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type UserQuestionField = {
  id: string; header: string; question: string; isOther?: boolean;
  options?: Array<{ label: string; description: string }>;
};
export type UserQuestionRecord = {
  questionId: string; scopeId: string; requestId: string; requestHash: string;
  revision: number; presentationToken: string; title: string; questions: UserQuestionField[];
  createdAt: number; expiresAt: number; status: "pending" | "answered" | "cancelled";
  responseRef?: string; answers?: Record<string, string[]>; submissionHash?: string;
  notification: "stored" | "dispatching" | "requested" | "failed" | "uncertain";
  notificationAttempt?: string; notificationStartedAt?: number; consumedAt?: number;
};

/** Upgrade-only schema introduced at v13. Current databases use stateSchema.ts. */
export const V13_QUESTION_STORE_MIGRATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_questions (
    question_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, request_id TEXT NOT NULL,
    response_ref TEXT UNIQUE, expires_at INTEGER NOT NULL, payload TEXT NOT NULL,
    UNIQUE(scope_id, request_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS user_questions_expiry ON user_questions(expires_at);
  CREATE TABLE IF NOT EXISTS codex_question_deliveries (
    scope_id TEXT NOT NULL, request_id TEXT NOT NULL, question_ref TEXT NOT NULL,
    action_hash TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(scope_id, request_id), UNIQUE(scope_id, question_ref)
  ) STRICT;
`;

/** Same SQLite transaction boundary as Jobs. Raw card answers have a bounded,
 * explicit retention policy; Codex response journals contain hashes only. */
export class QuestionStore {
  readonly startupMaintenance: {
    dispatchesMarkedUncertain: number;
    expiredQuestionsRemoved: number;
    deliveredJournalsRemoved: number;
  };

  constructor(private readonly db: Database.Database) {
    const dispatchesMarkedUncertain = this.db
      .prepare("UPDATE codex_question_deliveries SET status='uncertain' WHERE status='dispatching'")
      .run().changes;
    this.startupMaintenance = { dispatchesMarkedUncertain, ...this.prune() };
  }

  private prune(): { expiredQuestionsRemoved: number; deliveredJournalsRemoved: number } {
    const now = Date.now();
    const expiredQuestionsRemoved = this.db
      .prepare("DELETE FROM user_questions WHERE expires_at <= ?").run(now).changes;
    const deliveredJournalsRemoved = this.db
      .prepare("DELETE FROM codex_question_deliveries WHERE status='delivered' AND created_at < ?")
      .run(now - 7 * 24 * 60 * 60 * 1000).changes;
    return { expiredQuestionsRemoved, deliveredJournalsRemoved };
  }

  create(scopeId: string, input: { requestId: string; title: string; questions: UserQuestionField[]; expiresInMinutes?: number }): UserQuestionRecord {
    this.prune();
    const requestHash = questionHash(input);
    const existing = this.fromRow(this.db.prepare("SELECT payload FROM user_questions WHERE scope_id=? AND request_id=?").get(scopeId, input.requestId));
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("QUESTION_REQUEST_CONFLICT: Reuse requestId only for the identical question.");
      return existing;
    }
    const count = this.db.prepare("SELECT count(*) AS total, sum(scope_id=?) AS scoped FROM user_questions").get(scopeId) as { total: number; scoped: number };
    if (count.total >= 1000 || count.scoped >= 100) throw new Error("QUESTION_LIMIT: Too many retained questions.");
    const now = Date.now();
    const record: UserQuestionRecord = {
      questionId: randomUUID(), scopeId, requestId: input.requestId, requestHash,
      revision: 1, presentationToken: randomUUID(), title: input.title, questions: input.questions,
      createdAt: now, expiresAt: now + (input.expiresInMinutes || 1440) * 60_000,
      status: "pending", notification: "stored"
    };
    this.db.prepare("INSERT INTO user_questions(question_id,scope_id,request_id,response_ref,expires_at,payload) VALUES(?,?,?,NULL,?,?)")
      .run(record.questionId, scopeId, input.requestId, record.expiresAt, JSON.stringify(record));
    return record;
  }

  get(scopeId: string, questionId: string): UserQuestionRecord {
    this.prune();
    const record = this.fromRow(this.db.prepare("SELECT payload FROM user_questions WHERE scope_id=? AND question_id=?").get(scopeId, questionId));
    if (!record) throw new Error("QUESTION_UNAVAILABLE: The question expired or is unavailable in this conversation.");
    if (record.notification === "dispatching" && Date.now() - (record.notificationStartedAt || 0) > 20_000) {
      record.notification = "uncertain";
      this.save(record);
    }
    return record;
  }

  requireCard(scopeId: string, proof: { questionId: string; revision: number; presentationToken: string }): UserQuestionRecord {
    const record = this.get(scopeId, proof.questionId);
    if (record.revision !== proof.revision || record.presentationToken !== proof.presentationToken) {
      throw new Error("QUESTION_STALE: This question card is no longer valid.");
    }
    return record;
  }

  submit(record: UserQuestionRecord, answers: Record<string, string[]>): UserQuestionRecord {
    const submissionHash = questionHash(answers);
    if (record.status === "answered") {
      if (record.submissionHash !== submissionHash) throw new Error("QUESTION_ALREADY_ANSWERED: A different answer was already submitted.");
      return record;
    }
    if (record.status !== "pending") throw new Error("QUESTION_CLOSED: This question is closed.");
    record.status = "answered";
    record.answers = answers;
    record.submissionHash = submissionHash;
    record.responseRef = randomUUID();
    this.save(record);
    return record;
  }

  cancel(record: UserQuestionRecord): UserQuestionRecord {
    if (record.status !== "pending") throw new Error("QUESTION_CLOSED: This question is no longer pending.");
    record.status = "cancelled";
    record.responseRef = randomUUID();
    this.save(record);
    return record;
  }

  readResponses(scopeId: string, responseRef?: string): UserQuestionRecord[] {
    this.prune();
    const rows = responseRef
      ? this.db.prepare("SELECT payload FROM user_questions WHERE scope_id=? AND response_ref=?").all(scopeId, responseRef)
      : this.db.prepare("SELECT payload FROM user_questions WHERE scope_id=? AND response_ref IS NOT NULL ORDER BY rowid DESC LIMIT 100").all(scopeId);
    const records = rows.map(row => this.fromRow(row)!).filter(record => responseRef || !record.consumedAt).slice(0, 20);
    if (responseRef && !records.length) throw new Error("ANSWER_UNAVAILABLE: The answer expired or is unavailable in this conversation.");
    for (const record of responseRef ? records : []) {
      record.consumedAt ||= Date.now();
      this.save(record);
    }
    return records;
  }

  claimNotification(record: UserQuestionRecord): { send: boolean; attempt?: string } {
    if (!record.responseRef) throw new Error("ANSWER_REQUIRED: Submit the answer first.");
    if (record.consumedAt || !["stored", "failed"].includes(record.notification)) return { send: false };
    record.notification = "dispatching";
    record.notificationAttempt = randomUUID();
    record.notificationStartedAt = Date.now();
    this.save(record);
    return { send: true, attempt: record.notificationAttempt };
  }

  acknowledgeNotification(record: UserQuestionRecord, attempt: string, state: "requested" | "failed" | "uncertain"): void {
    if (record.notificationAttempt !== attempt || !["dispatching", state].includes(record.notification)) {
      throw new Error("NOTIFICATION_STALE: This notification attempt is no longer current.");
    }
    record.notification = state;
    this.save(record);
  }

  delivery(scopeId: string, requestId: string, hash: string): string | undefined {
    const row = this.db.prepare("SELECT action_hash,status FROM codex_question_deliveries WHERE scope_id=? AND request_id=?")
      .get(scopeId, requestId) as { action_hash: string; status: string } | undefined;
    if (row && row.action_hash !== hash) throw new Error("ANSWER_REQUEST_CONFLICT: Reuse requestId only for the identical answer.");
    return row?.status;
  }

  beginDelivery(scopeId: string, requestId: string, questionRef: string, hash: string): void {
    const existing = this.db.prepare("SELECT status FROM codex_question_deliveries WHERE scope_id=? AND question_ref=?").get(scopeId, questionRef);
    if (existing) throw new Error("QUESTION_ALREADY_DISPATCHED: Inspect the previous delivery; do not resend under a new request ID.");
    this.db.prepare("INSERT INTO codex_question_deliveries VALUES(?,?,?,?,?,?)")
      .run(scopeId, requestId, questionRef, hash, "dispatching", Date.now());
  }

  finishDelivery(scopeId: string, requestId: string, status: "delivered" | "uncertain"): void {
    this.db.prepare("UPDATE codex_question_deliveries SET status=? WHERE scope_id=? AND request_id=?").run(status, scopeId, requestId);
  }

  private save(record: UserQuestionRecord): void {
    this.db.prepare("UPDATE user_questions SET payload=?,response_ref=? WHERE scope_id=? AND question_id=?")
      .run(JSON.stringify(record), record.responseRef || null, record.scopeId, record.questionId);
  }

  private fromRow(row: unknown): UserQuestionRecord | undefined {
    return row ? JSON.parse((row as { payload: string }).payload) as UserQuestionRecord : undefined;
  }
}

export function questionHash(value: unknown): string {
  // Stable object ordering makes identical answer maps idempotent across clients.
  return createHash("sha256").update(JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)).digest("hex");
}
