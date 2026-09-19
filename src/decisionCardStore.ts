import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalizeDecisionSubmission,
  prepareDecisionCardContent,
  type CanonicalDecisionSelection,
  type DecisionFieldDefinition,
  type DecisionIntent,
  type PreparedDecisionCardContent,
  type SubmittedDecisionField
} from "./decisionCardContent.js";
import { canonicalHumanText, parseJsonTextStrict } from "./textIntegrity.js";

export const DECISION_CARD_DEFAULT_EXPIRY_MINUTES = 24 * 60;
export const DECISION_CARD_MAX_EXPIRY_MINUTES = 7 * 24 * 60;
export const DECISION_CARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DECISION_CARD_MAX_PER_SCOPE = 200;
export const DECISION_CARD_MAX_TOTAL = 2_000;
export const DECISION_DELIVERY_MAX_ATTEMPTS = 3;
export const DECISION_DELIVERY_LEASE_MS = 20_000;

export const DECISION_DELIVERY_STATES = [
  "stored",
  "leased",
  "host-rejected",
  "host-accepted",
  "acceptance-unknown"
] as const;
export type DecisionDeliveryState = (typeof DECISION_DELIVERY_STATES)[number];

export type DecisionCardVersionRecord = {
  cardId: string;
  scopeId: string;
  version: number;
  title: string;
  html: string;
  contentDigest: string;
  fields: DecisionFieldDefinition[];
  policy: PreparedDecisionCardContent["policy"];
  presentationRef: string;
  createdAt: number;
  expiresAt: number;
};

export type DecisionSubmissionRecord = {
  submissionId: string;
  cardId: string;
  scopeId: string;
  cardVersion: number;
  sequence: number;
  supersedesSubmissionId?: string;
  receipt: string;
  intent: DecisionIntent;
  selections: CanonicalDecisionSelection[];
  comment?: string;
  summary: string;
  decisionDigest: string;
  deliveryState: DecisionDeliveryState;
  attemptCount: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  lastError?: string;
  hostAcceptedAt?: number;
  acceptanceUnknownAt?: number;
  resultOfferedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type DecisionCardSnapshot = {
  card: DecisionCardVersionRecord;
  latestSubmission?: DecisionSubmissionRecord;
};

export type DecisionCardMutationInput = {
  requestId: string;
  title: string;
  html: string;
  expiresInMinutes?: number;
};

export type DecisionCardRevisionInput = DecisionCardMutationInput & {
  cardId: string;
  expectedVersion: number;
};

export type DecisionCardProof = {
  cardId: string;
  cardVersion: number;
  presentationRef: string;
};

export type DecisionSubmissionInput = {
  submissionId: string;
  intent: DecisionIntent;
  fields: SubmittedDecisionField[];
  comment?: string;
};

type DecisionCardRow = {
  card_id: string;
  scope_id: string;
  current_version: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

type DecisionVersionRow = {
  card_id: string;
  scope_id: string;
  version: number;
  title: string;
  html: string;
  content_digest: string;
  fields: string;
  policy: string;
  presentation_ref: string;
  created_at: number;
  expires_at: number;
};

type DecisionSubmissionRow = {
  submission_id: string;
  card_id: string;
  scope_id: string;
  card_version: number;
  sequence: number;
  supersedes_submission_id: string | null;
  receipt: string;
  intent: string;
  selections: string;
  comment: string | null;
  summary: string;
  decision_digest: string;
  delivery_state: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  host_accepted_at: number | null;
  acceptance_unknown_at: number | null;
  result_offered_at: number | null;
  created_at: number;
  updated_at: number;
};

/** Upgrade-only schema introduced at v24. Current databases apply this after
 * the immutable v19 base and the prior append-only projections. */
export const V24_DECISION_CARD_MIGRATION_SCHEMA = `
  CREATE TABLE decision_cards (
    card_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    current_version INTEGER NOT NULL CHECK(current_version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX decision_cards_scope_recent
    ON decision_cards(scope_id, updated_at DESC, card_id);

  CREATE TABLE decision_card_versions (
    card_id TEXT NOT NULL REFERENCES decision_cards(card_id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    title TEXT NOT NULL,
    html TEXT NOT NULL,
    content_digest TEXT NOT NULL CHECK(length(content_digest) = 64),
    fields TEXT NOT NULL CHECK(json_valid(fields)),
    policy TEXT NOT NULL CHECK(json_valid(policy)),
    presentation_ref TEXT NOT NULL UNIQUE CHECK(length(presentation_ref) = 64),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY(card_id, version)
  ) STRICT;
  CREATE INDEX decision_card_versions_scope_recent
    ON decision_card_versions(scope_id, created_at DESC, card_id, version);

  CREATE TABLE decision_card_requests (
    scope_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    operation_hash TEXT NOT NULL CHECK(length(operation_hash) = 64),
    card_id TEXT NOT NULL REFERENCES decision_cards(card_id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK(version >= 1),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(scope_id, request_id),
    FOREIGN KEY(card_id, version) REFERENCES decision_card_versions(card_id, version) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE decision_submissions (
    submission_id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES decision_cards(card_id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL,
    card_version INTEGER NOT NULL CHECK(card_version >= 1),
    sequence INTEGER NOT NULL CHECK(sequence >= 1),
    supersedes_submission_id TEXT REFERENCES decision_submissions(submission_id) ON DELETE SET NULL,
    receipt TEXT NOT NULL UNIQUE CHECK(length(receipt) = 73),
    intent TEXT NOT NULL CHECK(intent IN ('confirm','request-explanation','defer')),
    selections TEXT NOT NULL CHECK(json_valid(selections)),
    comment TEXT,
    summary TEXT NOT NULL,
    decision_digest TEXT NOT NULL CHECK(length(decision_digest) = 64),
    delivery_state TEXT NOT NULL CHECK(delivery_state IN (
      'stored','leased','host-rejected','host-accepted','acceptance-unknown'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    lease_owner TEXT,
    lease_expires_at INTEGER,
    last_error TEXT,
    host_accepted_at INTEGER,
    acceptance_unknown_at INTEGER,
    result_offered_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(card_id, card_version, sequence),
    FOREIGN KEY(card_id, card_version) REFERENCES decision_card_versions(card_id, version) ON DELETE CASCADE,
    CHECK((delivery_state = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK(delivery_state = 'leased' OR (lease_owner IS NULL AND lease_expires_at IS NULL))
  ) STRICT;
  CREATE INDEX decision_submissions_scope_recent
    ON decision_submissions(scope_id, updated_at DESC, submission_id);
  CREATE INDEX decision_submissions_delivery
    ON decision_submissions(delivery_state, lease_expires_at, updated_at);
`;

/** Durable, Job-independent GPT-to-user decision records. Card identifiers,
 * presentation references, and delivery receipts are correlations only; every
 * read and mutation also verifies the current conversation scope. */
export class DecisionCardStore {
  readonly startupMaintenance: { expiredLeasesMarkedUnknown: number; expiredCardsRemoved: number };

  constructor(private readonly db: Database.Database) {
    const now = Date.now();
    const expiredLeasesMarkedUnknown = this.db.prepare(`
      UPDATE decision_submissions
         SET delivery_state='acceptance-unknown', lease_owner=NULL, lease_expires_at=NULL,
             acceptance_unknown_at=COALESCE(acceptance_unknown_at, ?), updated_at=?
       WHERE delivery_state='leased'
    `).run(now, now).changes;
    const expiredCardsRemoved = this.prune(now);
    this.startupMaintenance = { expiredLeasesMarkedUnknown, expiredCardsRemoved };
  }

  create(scopeId: string, input: DecisionCardMutationInput): DecisionCardVersionRecord {
    return this.mutate(scopeId, "create", input);
  }

  revise(scopeId: string, input: DecisionCardRevisionInput): DecisionCardVersionRecord {
    return this.mutate(scopeId, "revise", input);
  }

  get(scopeId: string, cardId: string, version?: number): DecisionCardVersionRecord {
    this.refreshExpiredLeases(Date.now());
    const card = this.cardRow(scopeId, cardId);
    if (!card) throw new Error("DECISION_CARD_UNAVAILABLE: This card is unavailable in the current conversation.");
    const selectedVersion = version ?? card.current_version;
    const row = this.db.prepare(`
      SELECT v.card_id,v.scope_id,v.version,v.title,v.html,v.content_digest,v.fields,v.policy,
             v.presentation_ref,v.created_at,v.expires_at
        FROM decision_card_versions v
       WHERE v.scope_id=? AND v.card_id=? AND v.version=?
    `).get(scopeId, cardId, selectedVersion) as DecisionVersionRow | undefined;
    if (!row) throw new Error("DECISION_CARD_UNAVAILABLE: This card version is unavailable in the current conversation.");
    return decisionVersionFromRow(row);
  }

  snapshot(scopeId: string, proof: DecisionCardProof): DecisionCardSnapshot {
    const card = this.requireCurrentCard(scopeId, proof);
    return { card, latestSubmission: this.latestSubmission(scopeId, card.cardId) };
  }

  submit(
    scopeId: string,
    proof: DecisionCardProof,
    input: DecisionSubmissionInput
  ): DecisionSubmissionRecord {
    return this.db.transaction(() => {
      const now = Date.now();
      this.refreshExpiredLeases(now);
      const card = this.requireCurrentCard(scopeId, proof);
      if (card.expiresAt <= now) throw new Error("DECISION_CARD_EXPIRED: Ask GPT to create a current card.");
      const existingId = this.submissionById(scopeId, input.submissionId);
      const canonical = canonicalizeDecisionSubmission(card.fields, input);
      if (existingId) {
        if (existingId.cardId !== card.cardId || existingId.cardVersion !== card.version ||
          existingId.decisionDigest !== canonical.digest) {
          throw new Error("DECISION_SUBMISSION_CONFLICT: Reuse submissionId only for an identical confirmation.");
        }
        return existingId;
      }
      const latest = this.latestSubmission(scopeId, card.cardId);
      if (latest?.cardVersion === card.version && latest.decisionDigest === canonical.digest) return latest;
      const sequence = (latest?.sequence || 0) + 1;
      const record: DecisionSubmissionRecord = {
        submissionId: input.submissionId,
        cardId: card.cardId,
        scopeId,
        cardVersion: card.version,
        sequence,
        ...(latest ? { supersedesSubmissionId: latest.submissionId } : {}),
        receipt: decisionReceipt(),
        intent: canonical.intent,
        selections: canonical.selections,
        ...(canonical.comment ? { comment: canonical.comment } : {}),
        summary: canonical.summary,
        decisionDigest: canonical.digest,
        deliveryState: "stored",
        attemptCount: 0,
        createdAt: now,
        updatedAt: now
      };
      this.db.prepare(`
        INSERT INTO decision_submissions(
          submission_id,card_id,scope_id,card_version,sequence,supersedes_submission_id,
          receipt,intent,selections,comment,summary,decision_digest,delivery_state,
          attempt_count,lease_owner,lease_expires_at,last_error,host_accepted_at,
          acceptance_unknown_at,result_offered_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,NULL,NULL,NULL,NULL,?,?)
      `).run(
        record.submissionId, record.cardId, record.scopeId, record.cardVersion,
        record.sequence, record.supersedesSubmissionId || null, record.receipt, record.intent,
        JSON.stringify(record.selections), record.comment || null, record.summary,
        record.decisionDigest, record.deliveryState, now, now
      );
      this.touchCard(card.cardId, now);
      return record;
    })();
  }

  claimDelivery(input: {
    scopeId: string;
    proof: DecisionCardProof;
    receipt: string;
    leaseOwner: string;
    retryRejected?: boolean;
  }): { send: boolean; submission: DecisionSubmissionRecord } {
    return this.db.transaction(() => {
      const now = Date.now();
      this.refreshExpiredLeases(now);
      this.requireCurrentCard(input.scopeId, input.proof);
      const current = this.requireSubmission(input.scopeId, input.receipt);
      if (current.cardId !== input.proof.cardId || current.cardVersion !== input.proof.cardVersion) {
        throw new Error("DECISION_PRESENTATION_MISMATCH: Reopen the exact card used for this decision.");
      }
      const claimable = current.deliveryState === "stored" ||
        current.deliveryState === "host-rejected" && input.retryRejected === true &&
        current.attemptCount < DECISION_DELIVERY_MAX_ATTEMPTS;
      if (!claimable) return { send: false, submission: current };
      const leaseExpiresAt = now + DECISION_DELIVERY_LEASE_MS;
      const changed = this.db.prepare(`
        UPDATE decision_submissions
           SET delivery_state='leased', attempt_count=attempt_count+1, lease_owner=?,
               lease_expires_at=?, last_error=NULL, updated_at=?
         WHERE scope_id=? AND receipt=? AND delivery_state=?
      `).run(
        input.leaseOwner, leaseExpiresAt, now, input.scopeId, input.receipt,
        current.deliveryState
      ).changes;
      const submission = this.requireSubmission(input.scopeId, input.receipt);
      return { send: changed === 1, submission };
    })();
  }

  recordDeliveryOutcome(input: {
    scopeId: string;
    proof: DecisionCardProof;
    receipt: string;
    leaseOwner: string;
    outcome: "accepted" | "rejected" | "uncertain" | "release";
    error?: string;
  }): DecisionSubmissionRecord {
    return this.db.transaction(() => {
      const now = Date.now();
      const card = this.requireCurrentCard(input.scopeId, input.proof);
      const current = this.requireSubmission(input.scopeId, input.receipt);
      if (current.cardId !== card.cardId || current.cardVersion !== card.version ||
        current.deliveryState !== "leased" || current.leaseOwner !== input.leaseOwner) {
        throw new Error("DECISION_DELIVERY_STALE: This delivery lease is no longer current.");
      }
      const state: DecisionDeliveryState = input.outcome === "accepted"
        ? "host-accepted"
        : input.outcome === "rejected"
          ? "host-rejected"
          : input.outcome === "release"
            ? "stored"
            : "acceptance-unknown";
      const lastError = input.outcome === "rejected" && input.error
        ? canonicalHumanText(input.error, { field: "Decision delivery error", maxCharacters: 500, trim: true, collapseWhitespace: true })
        : undefined;
      this.db.prepare(`
        UPDATE decision_submissions
           SET delivery_state=?,lease_owner=NULL,lease_expires_at=NULL,last_error=?,
               host_accepted_at=CASE WHEN ?='host-accepted' THEN ? ELSE host_accepted_at END,
               acceptance_unknown_at=CASE WHEN ?='acceptance-unknown' THEN ? ELSE acceptance_unknown_at END,
               updated_at=?
         WHERE scope_id=? AND receipt=?
      `).run(state, lastError || null, state, now, state, now, now, input.scopeId, input.receipt);
      this.touchCard(card.cardId, now);
      return this.requireSubmission(input.scopeId, input.receipt);
    })();
  }

  readResult(scopeId: string, receipt: string): {
    card: DecisionCardVersionRecord;
    submission: DecisionSubmissionRecord;
  } {
    return this.db.transaction(() => {
      const now = Date.now();
      this.refreshExpiredLeases(now);
      const submission = this.requireSubmission(scopeId, receipt);
      const card = this.get(scopeId, submission.cardId, submission.cardVersion);
      this.db.prepare(`
        UPDATE decision_submissions
           SET result_offered_at=COALESCE(result_offered_at,?),updated_at=?
         WHERE scope_id=? AND receipt=?
      `).run(now, now, scopeId, receipt);
      this.touchCard(card.cardId, now);
      return { card, submission: this.requireSubmission(scopeId, receipt) };
    })();
  }

  latestSubmission(scopeId: string, cardId: string): DecisionSubmissionRecord | undefined {
    this.refreshExpiredLeases(Date.now());
    const row = this.db.prepare(`
      SELECT * FROM decision_submissions
       WHERE scope_id=? AND card_id=?
       ORDER BY sequence DESC LIMIT 1
    `).get(scopeId, cardId) as DecisionSubmissionRow | undefined;
    return row ? decisionSubmissionFromRow(row) : undefined;
  }

  private mutate(
    scopeId: string,
    operation: "create" | "revise",
    input: DecisionCardMutationInput | DecisionCardRevisionInput
  ): DecisionCardVersionRecord {
    const prepared = prepareDecisionCardContent(input.html);
    const title = canonicalHumanText(input.title, {
      field: "Decision card title",
      maxCharacters: 200,
      trim: true,
      collapseWhitespace: true
    });
    const expiresInMinutes = input.expiresInMinutes ?? DECISION_CARD_DEFAULT_EXPIRY_MINUTES;
    if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 5 || expiresInMinutes > DECISION_CARD_MAX_EXPIRY_MINUTES) {
      throw new Error(`DECISION_EXPIRY_INVALID: expiresInMinutes must be 5 to ${DECISION_CARD_MAX_EXPIRY_MINUTES}.`);
    }
    const operationHash = stableHash({
      operation,
      title,
      contentDigest: prepared.contentDigest,
      expiresInMinutes,
      ...(operation === "revise" ? {
        cardId: (input as DecisionCardRevisionInput).cardId,
        expectedVersion: (input as DecisionCardRevisionInput).expectedVersion
      } : {})
    });

    return this.db.transaction(() => {
      const now = Date.now();
      this.prune(now);
      const replay = this.db.prepare(`
        SELECT operation_hash,card_id,version FROM decision_card_requests
         WHERE scope_id=? AND request_id=?
      `).get(scopeId, input.requestId) as {
        operation_hash: string; card_id: string; version: number;
      } | undefined;
      if (replay) {
        if (replay.operation_hash !== operationHash) {
          throw new Error("DECISION_REQUEST_CONFLICT: Reuse requestId only for an identical card mutation.");
        }
        return this.get(scopeId, replay.card_id, replay.version);
      }

      let cardId: string;
      let version: number;
      let createdAt: number;
      if (operation === "create") {
        this.assertCapacity(scopeId);
        cardId = randomUUID();
        version = 1;
        createdAt = now;
      } else {
        const revision = input as DecisionCardRevisionInput;
        const current = this.cardRow(scopeId, revision.cardId);
        if (!current) throw new Error("DECISION_CARD_UNAVAILABLE: This card is unavailable in the current conversation.");
        if (current.current_version !== revision.expectedVersion) {
          throw new Error("DECISION_VERSION_CONFLICT: Reopen the current card before revising it.");
        }
        cardId = current.card_id;
        version = current.current_version + 1;
        createdAt = current.created_at;
      }
      const expiresAt = now + expiresInMinutes * 60_000;
      if (operation === "create") {
        this.db.prepare(`
          INSERT INTO decision_cards(card_id,scope_id,current_version,created_at,updated_at,expires_at)
          VALUES(?,?,?,?,?,?)
        `).run(cardId, scopeId, version, createdAt, now, expiresAt);
      } else {
        this.db.prepare(`
          UPDATE decision_cards
             SET current_version=?,updated_at=?,expires_at=?
           WHERE scope_id=? AND card_id=?
        `).run(version, now, expiresAt, scopeId, cardId);
      }
      const presentationRef = randomBytes(32).toString("hex");
      this.db.prepare(`
        INSERT INTO decision_card_versions(
          card_id,scope_id,version,title,html,content_digest,fields,policy,
          presentation_ref,created_at,expires_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        cardId, scopeId, version, title, prepared.html, prepared.contentDigest,
        JSON.stringify(prepared.fields), JSON.stringify(prepared.policy),
        presentationRef, now, expiresAt
      );
      this.db.prepare(`
        INSERT INTO decision_card_requests(scope_id,request_id,operation_hash,card_id,version,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(scopeId, input.requestId, operationHash, cardId, version, now);
      return {
        cardId,
        scopeId,
        version,
        title,
        html: prepared.html,
        contentDigest: prepared.contentDigest,
        fields: prepared.fields,
        policy: prepared.policy,
        presentationRef,
        createdAt: now,
        expiresAt
      };
    })();
  }

  private requireCurrentCard(scopeId: string, proof: DecisionCardProof): DecisionCardVersionRecord {
    const row = this.cardRow(scopeId, proof.cardId);
    if (!row) throw new Error("DECISION_CARD_UNAVAILABLE: This card is unavailable in the current conversation.");
    if (row.current_version !== proof.cardVersion) {
      throw new Error("DECISION_CARD_STALE: This card was revised. Reopen the current version.");
    }
    const card = this.get(scopeId, proof.cardId, proof.cardVersion);
    if (card.presentationRef !== proof.presentationRef) {
      throw new Error("DECISION_PRESENTATION_MISMATCH: Reopen the exact decision card.");
    }
    return card;
  }

  private requireSubmission(scopeId: string, receipt: string): DecisionSubmissionRecord {
    const row = this.db.prepare(`
      SELECT * FROM decision_submissions WHERE scope_id=? AND receipt=?
    `).get(scopeId, receipt) as DecisionSubmissionRow | undefined;
    if (!row) throw new Error("DECISION_RESULT_UNAVAILABLE: This decision is unavailable in the current conversation.");
    return decisionSubmissionFromRow(row);
  }

  private submissionById(scopeId: string, submissionId: string): DecisionSubmissionRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM decision_submissions WHERE scope_id=? AND submission_id=?
    `).get(scopeId, submissionId) as DecisionSubmissionRow | undefined;
    return row ? decisionSubmissionFromRow(row) : undefined;
  }

  private cardRow(scopeId: string, cardId: string): DecisionCardRow | undefined {
    return this.db.prepare(`
      SELECT card_id,scope_id,current_version,created_at,updated_at,expires_at
        FROM decision_cards WHERE scope_id=? AND card_id=?
    `).get(scopeId, cardId) as DecisionCardRow | undefined;
  }

  private refreshExpiredLeases(now: number): void {
    this.db.prepare(`
      UPDATE decision_submissions
         SET delivery_state='acceptance-unknown',lease_owner=NULL,lease_expires_at=NULL,
             acceptance_unknown_at=COALESCE(acceptance_unknown_at,?),updated_at=?
       WHERE delivery_state='leased' AND lease_expires_at<=?
    `).run(now, now, now);
  }

  private touchCard(cardId: string, now: number): void {
    this.db.prepare("UPDATE decision_cards SET updated_at=? WHERE card_id=?").run(now, cardId);
  }

  private prune(now: number): number {
    return this.db.prepare(`
      DELETE FROM decision_cards
       WHERE expires_at<=? AND updated_at<?
    `).run(now, now - DECISION_CARD_RETENTION_MS).changes;
  }

  private assertCapacity(scopeId: string): void {
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN scope_id=? THEN 1 ELSE 0 END) AS scoped
        FROM decision_cards
    `).get(scopeId) as { total: number; scoped: number | null };
    if (counts.total >= DECISION_CARD_MAX_TOTAL || (counts.scoped || 0) >= DECISION_CARD_MAX_PER_SCOPE) {
      throw new Error("DECISION_CARD_LIMIT: Too many retained decision cards.");
    }
  }
}

function decisionVersionFromRow(row: DecisionVersionRow): DecisionCardVersionRecord {
  return {
    cardId: row.card_id,
    scopeId: row.scope_id,
    version: row.version,
    title: row.title,
    html: row.html,
    contentDigest: row.content_digest,
    fields: parseJsonTextStrict(row.fields, "Stored decision fields") as DecisionFieldDefinition[],
    policy: parseJsonTextStrict(row.policy, "Stored decision content policy") as PreparedDecisionCardContent["policy"],
    presentationRef: row.presentation_ref,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function decisionSubmissionFromRow(row: DecisionSubmissionRow): DecisionSubmissionRecord {
  if (!DECISION_DELIVERY_STATES.includes(row.delivery_state as DecisionDeliveryState)) {
    throw new Error("Stored decision submission has an invalid delivery state.");
  }
  return {
    submissionId: row.submission_id,
    cardId: row.card_id,
    scopeId: row.scope_id,
    cardVersion: row.card_version,
    sequence: row.sequence,
    ...(row.supersedes_submission_id ? { supersedesSubmissionId: row.supersedes_submission_id } : {}),
    receipt: row.receipt,
    intent: row.intent as DecisionIntent,
    selections: parseJsonTextStrict(row.selections, "Stored decision selections") as CanonicalDecisionSelection[],
    ...(row.comment ? { comment: row.comment } : {}),
    summary: row.summary,
    decisionDigest: row.decision_digest,
    deliveryState: row.delivery_state as DecisionDeliveryState,
    attemptCount: row.attempt_count,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.host_accepted_at === null ? {} : { hostAcceptedAt: row.host_accepted_at }),
    ...(row.acceptance_unknown_at === null ? {} : { acceptanceUnknownAt: row.acceptance_unknown_at }),
    ...(row.result_offered_at === null ? {} : { resultOfferedAt: row.result_offered_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function decisionReceipt(): string {
  return `decision_${randomBytes(32).toString("hex")}`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
      : entry)).digest("hex");
}
