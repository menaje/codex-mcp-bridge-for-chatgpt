import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const fixtures = sqliteTable('issue_222_fixtures', {
  fixtureKey: text('fixture_key').primaryKey(),
  payloadJson: text('payload_json').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  createdAt: text('created_at').notNull(),
});

// A single fixed, explicitly claimed test command; no general job dispatcher.
export const roundtrips = sqliteTable('issue_222_roundtrips', {
  trialKey: text('trial_key').primaryKey(),
  state: text('state').notNull(),
  commandJson: text('command_json').notNull(),
  commandSha256: text('command_sha256').notNull(),
  createdAt: text('created_at').notNull(),
  claimedAt: text('claimed_at'),
  ackedAt: text('acked_at'),
  responseJson: text('response_json'),
  responseSha256: text('response_sha256'),
});
