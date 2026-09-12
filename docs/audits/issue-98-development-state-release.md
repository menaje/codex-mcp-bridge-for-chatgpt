# Issue 98 development artifact evidence

This evidence belongs to implementation commit
`68cd7171816c585e1c6d38899dc5ea9b839e9b09`. Both artifacts were built from a
clean checkout on macOS 15.6 (`25.6.0`, arm64) on 2026-09-12. The manifest stage
is `development`, so these results establish implementation and local packaging
readiness. They are not the final release-candidate evidence required by the
[state upgrade and recovery runbook](../state-upgrade-recovery.md).

| Artifact | SHA-256 | Audited runtime |
| --- | --- | --- |
| `codex-mcp-bridge-for-chatgpt-0.3.0.tgz` | `a024fcaa7fa4d01be336b35090e5dff695a762d4dca6af71405efedc8ecfb97f` | Node 24.11.1, ABI 137, `better-sqlite3` 13.0.3, SQLite 3.53.4, arm64 |
| `Codex-MCP-Bridge-for-ChatGPT-0.3.0-macOS-arm64-unnotarized.dmg` | `b5166d2beb0e27580b632410989082b98d0928ce6c3a1acb22b7d86865edb332` | Mounted app runtime; Node 24.11.1, ABI 137, `better-sqlite3` 13.0.3, SQLite 3.53.4, arm64 |

Both packaged runtimes matched migration-catalog digest
`810399dee06f768ee70896c69998b3d22c659db0f4dc9beb8baabb62ecad2909`.
Each opened all supported source schemas 3 through 18 directly. Schema 3 came
from the published v0.3.0 fixture, schemas 16 and 18 came from the recorded
development builds, and the remaining starts came from the catalogued committed
checkpoints rather than a lowered version marker.

The two semantic cases covered the full schema-3 path and the schema-18 rebuild.
They preserved Job receipts and all seeded question, outbox, cancellation,
steering, recovery, and hold authority rows. The one invalid schema-18 session
and Agent-thread relationship were removed with matching declared counts. The
Settings payload reached schema 4, retired automatic-model selection was
removed, saved full-access intent remained clamped by the operator sandbox, and
legacy project JSON did not become a project identity.

Both artifacts completed two current-runtime restarts, verified the mode-0600
backup checksum, integrity, foreign keys, database identity, and migration path,
then restored the actual snapshot while quarantining the replaced DB. The
schema-3 restore was opened and read by the published v0.3.0 package; its HTTP
health endpoint opened and the process stopped cleanly. A deterministic hook
also interrupted schema 18 after the schema-19 commit and before provenance
finalization, observed the pending record, and verified a successful resume.

The source gate for the same implementation passed 972 Node tests, the App
Server lock against Codex CLI 0.153.3 (416 JSON and 827 TypeScript schema files),
711 localized strings in nine languages, and 147 Swift tests. The two Swift
skips require opt-in live companion or remote-pairing endpoints and are unrelated
to database migration.

The raw sanitized reports are
[npm](issue-98-development-npm-state-release.json) and
[arm64 DMG](issue-98-development-macos-arm64-state-release.json). They contain
counts, hashes, versions, and generated fixture identities, with no user payload
or local filesystem paths.

The final candidate still needs one workflow run that binds the generic npm
tarball, arm64 DMG, and x64 DMG to the same RC commit. This local run does not
claim x64 execution, process-termination survival, physical power-loss behavior,
notarization, or stable promotion. Node is selected by the operator or macOS
runtime discovery and is recorded by the audit; it is not bundled in either
artifact.
