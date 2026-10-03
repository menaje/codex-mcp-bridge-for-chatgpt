import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const fixtures = sqliteTable('issue_222_fixtures', {
  fixtureKey: text('fixture_key').primaryKey(),
  payloadJson: text('payload_json').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  createdAt: text('created_at').notNull(),
});
