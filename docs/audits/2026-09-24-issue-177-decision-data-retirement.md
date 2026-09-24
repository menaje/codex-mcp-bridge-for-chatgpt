# Issue #177: retired Decision data disposal

## Decision and scope

The operator authorized complete removal of the retired user–GPT Decision Card
state. No export or additional user notice is required for the five historical
rows in each of the four tables in the stable database. No row content is
included in this audit or the issue. Schema 27 drops `decision_cards`,
`decision_card_versions`, `decision_card_requests`, and `decision_submissions`
and their indexes. The schema-24 SQL, catalog entry, fixture history, and
applied provenance remain intact so older databases retain an auditable upgrade
path. Codex-originated `user_questions`, `codex_question_deliveries`, and the
`codex_answer` tool are outside this deletion.

## Recovery policy

The v27 upgrade creates its ordinary protected source snapshot before dropping
tables. That snapshot is needed until the upgraded service, two restarts, and a
recovery rehearsal pass. After acceptance, retain a fresh schema-27 backup,
dispose of source snapshots that contain Decision tables and their matching
metadata sidecars, and vacuum the stopped live database. Older backups without
Decision tables remain eligible for their existing retention policy. The
[state upgrade runbook](../state-upgrade-recovery.md#retired-decision-data-and-backup-disposal)
owns the detailed procedure. The policy applies to the managed bridge state
directory; external filesystem snapshots require their own retention review.

## Verification record

- Fresh schema 27 has no Decision tables or indexes and retains both Codex
  question tables.
- Schema 23 follows the historical v24 step and then v27; schema 24 with
  historical rows upgrades through v27. Their integrity and foreign-key checks
  pass.
- The protected schema-24 source snapshot retains its original rows for
  recovery; restoring a copy through v27 removes them again.
- A consistent private copy of the operational schema-26 database upgraded to
  schema 27, reopened twice, and recovered from its pre-v27 source snapshot.
  Every resulting database had zero Decision tables, both Codex question tables,
  `integrity_check=ok`, and zero foreign-key violations. The source copy and
  migration snapshot retained the four historical tables as expected; the
  disposable audit files were removed afterward.
- The retired Decision MCP tools remain unregistered. Existing Job, Activity,
  question, result-delivery, and command-receipt paths are unchanged.

Operational deployment and backup-disposal results are recorded in the private
operator log and summarized on [issue #177](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/177)
without any submission content.
