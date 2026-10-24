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
