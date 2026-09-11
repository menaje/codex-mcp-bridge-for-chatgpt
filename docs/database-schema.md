# Bridge database schema and lifecycle

Schema 19 is the current SQLite schema. `src/stateSchema.ts` contains the complete
DDL used for a new installation. `src/stateStore.ts` contains upgrade code only
for schemas 3 through 18; schemas 1 and 2 are rejected. The published v0.2 and
v0.3 line used schema 3, and the pre-change development installation used schema
18. Every supported upgrade ends with the same tables, columns, constraints,
indexes, and triggers as direct schema-19 creation.

The database is the only bridge state authority. Settings, projects, retained
sessions, and Jobs no longer have parallel JSON files or JSON mirrors. SQLite
payloads remain where their contents are inherently variable, but fields used for
identity, joins, constraints, state transitions, or indexes are columns and are
removed from those payloads.

## Ownership rules

`projects` owns a project's UUID, opaque public reference, revision, current name,
current default folder, order, and archive/delete state. Other tables store a
`project_id` only when they need a relationship. Readers join `projects.name`, so
a rename appears consistently in Settings, current work, and history. There is no
project-name history table or snapshot fallback. Archiving keeps the relationship
and current name. Deleting a registration excludes it from Settings, selection,
new admission, and tracked-project counts, while its tombstone remains the naming
authority for already retained history. A row with no valid project relationship
is shown without a project and is never guessed from a name or folder.

A registered project's current default folder is different from an admitted
execution folder:

- `sessions.cwd` and `sessions.sandbox` own the execution context of a retained
  backend thread. Continue and fork validate this context even after the project
  is relocated.
- `activities.pinned_cwd` owns the folder admitted for the Activity. It exists
  exactly when `activities.project_id` exists.
- `jobs.cwd` and `jobs.sandbox` record the context of that concrete execution.
  They are first-class fields for recovery, retention, and path-reuse checks.
- `agent_threads` owns Agent membership and current/history linkage only. Its
  execution fields are read by joining `sessions`.

`jobs` owns the current Job state, result/error receipt payload, last progress,
terminal provenance, and one compact display summary. `job_events` owns bounded
diagnostic event history. `job_interactions` owns current blocking/nonblocking
input state. There is no `job_summaries` table, and progress events do not write a
full Job document. `scopes.version` is the one scope CAS/event sequence; there is
no `scope_versions` mirror.

## Complete schema-19 table matrix

The retention column describes bridge cleanup. SQLite free pages are reusable but
remain allocated until an offline compaction; physical erasure is therefore a
separate operation.

| Table | Current consumer and authoritative fields | Decision and retention |
| --- | --- | --- |
| `bridge_meta` | Schema version and migration facts; installation HMAC keys; bounded conversation-link and late-response journals whose formats are owned by their modules | Keep for distinct installation/schema metadata. Dynamic work-history, event-retention, and runtime-resolution keys moved to typed tables. Obsolete JSON-import markers and the transient upgrade-in-progress marker are deleted at v19; the original upgrade source version remains as provenance. |
| `scopes` | Scope resolver and all scoped mutations; `scope_id`, `version`, creation/update time | Keep as scope identity and the single atomic sequence. Retained while referenced. `scope_versions` was merged here. |
| `bridge_instances` | Restart ownership, cancellation/delivery provenance, diagnostics; process and stop facts | Keep as an append-only operational journal. Open older instances are marked superseded at startup; rows remain while provenance can reference them. |
| `project_registry` | Project registry CAS; singleton `registry_revision`, `updated_at` | Keep separately because registry-wide CAS has a different lifetime from each project revision. |
| `projects` | Settings, admission, current-name projection; UUID/ref/revision, current `name`, canonical key, current `cwd`, order, archive/delete times | Sole registered-project authority. Archived/deleted rows remain while execution relationships refer to them; a deleted tombstone can label retained history but cannot be selected or admitted. Active name and cwd are unique. |
| `user_settings` | `UserSettingsStore`; ordinary settings JSON plus independent settings CAS and update time | Keep one JSON object because presentation/policy settings evolve together and are not joined individually. Project arrays/default aliases are forbidden here. |
| `sessions` | Session registry, continue/fork, Agent thread projection, cwd reuse; thread/scope/project relationship and structured backend execution context | Canonical retained-thread execution context. Global session retention removes old unreferenced sessions; an Agent thread prevents deletion. No payload or project-name copy. |
| `activities` | Activity lifecycle/card compatibility, admission, counters, completion state; optional project relation and pinned cwd | Keep current workflow authority. Project name copies and duplicate project UUID/cwd columns were removed. Activity-only completion/card fields remain until #53 decides their supported client lifetime. |
| `agents` | Agent identity and live lifecycle; current thread/job pointers, version, orphan evidence | Keep current Agent authority. `archived_at` and the `archived` lifecycle are removed; schema 18 restored archived Agents once before schema 19. |
| `agent_threads` | Agent membership/history and current-thread selection; context mode and link/replacement times | Keep relationship data only. Thread execution details come from `sessions`; invalid legacy-project contexts are dropped and are never resumed or mapped to a new project. |
| `activity_agents` | Activity-to-Agent assignment history; role, context mode, assignment/release times | Keep because Activity membership has a different lifecycle from Agent thread membership. Active pairs are unique. |
| `jobs` | Admission replay receipt, execution/recovery state, Dashboard/current/history projection; formal identity, source/current thread, status, execution context, versions/progress, terminal provenance, bounded `summary`, variable result/error `payload` | Keep one row per admitted request. Full result bodies follow result retention; later history expiry reduces payload to the compact replay receipt but preserves `(scope_id, request_id)` and terminal outcome. Structured fields cannot also appear in payload. Summary may contain only `execution`, `usage`, and `uncertainResponseReview`; status, timestamps, duration, and error provenance stay in formal columns or the retained Job payload lifecycle. |
| `job_interactions` | Input/approval wait projection, retention protection, unfinished-work checks; authoritative `interaction_id`/`is_blocking` plus the remaining variable interaction payload | Keep only the current interaction set and replace it atomically with Job state. The two structured fields are reconstructed for public DTOs and do not remain in payload JSON. Delete with the Job. Replaces `pendingInteractions` JSON scans. |
| `activity_events` | Activity cursor/watch and compatibility diagnostics | Bounded diagnostic/control history: at most 50,000 recent rows and seven-day cleanup in batches. Delete with Activity/scope. |
| `job_events` | Progress projection, usage/reroute summary extraction, status cursors | Bounded diagnostics: 256 per Job, global 50,000 rows/64 MiB payload budget, 8 KiB per payload, seven-day metadata cleanup. Delete with Job. Does not contain a full Job copy. |
| `completion_outbox` | Legacy `codex_activity_handoff` and retained Activity card delivery | Keep undelivered/acknowledgement authority while those clients are supported. #53 is the explicit exit condition for deleting this table and its Activity-only writers/readers after pending delivery handling is resolved. |
| `agent_mutations` | Agent mutation request replay/idempotency; scoped request hash/result | Keep as the durable replay receipt for retained mutation requests. It is not a second Agent state store. |
| `cancellation_operations` | Root cancellation request idempotency, exact target/proof/result | Keep while request replay and audit provenance are needed. It is protected from generic event cleanup. |
| `cancellation_intents` | Per-target cancellation dispatch and result provenance | Keep recorded/dispatched intents through restart; terminal evidence remains with the retained request journal. Target indexes serve protection and recovery checks. |
| `steering_deliveries` | Steering idempotency and delivery certainty; prompt digest, expected Job version, status/result | Keep prepared/dispatching/uncertain records through restart and retain completed evidence with the request receipt. Prompt text is never stored here. |
| `transport_observations` | Bounded operational diagnostics for aborted/detached/presentation events | Keep as disposable diagnostics only; it grants no replay or execution authority. It is ordered by the recent index and can be pruned independently. |
| `user_questions` | Question request/answer state and response reference | Keep until its explicit expiry; startup removes expired rows. Payload is question state, not a Job mirror. |
| `codex_question_deliveries` | Codex-originated question delivery idempotency | Keep one scoped request/question-reference receipt so restart cannot redeliver the same question as new. |
| `thread_connections` | App Server connection ownership, handoff/release and recovery inspection | Keep current connection evidence independently of `sessions`: a saved execution context does not prove a live connection. Unfinished-work checks join indexed Job/interactions/cancellation fields. |
| `event_budget` | Trigger-maintained Job-event row and payload-byte counters | Derived singleton. Rebuilt during migration and updated by three triggers; it is not a DB/WAL or backup size limit. |
| `event_retention_state` | Event cleanup policy generation and restartable event cursor | Keep typed singleton because the cursor has transactional cleanup semantics. Replaces dynamic `bridge_meta` keys. |
| `result_holds` | Temporary operator/result-review protection; reason and expiry | Keep only until `expires_at`; maintenance deletes expired holds in batches. Delete with Job. |
| `work_history_state` | Per-Job optional acknowledgement, display expiry, and review sequence | Keep while the Job receipt exists. It changes review/display state without changing the Job outcome. Delete with Job. |
| `work_history_control` | Global review revision, restartable history cursor, cleanup totals | Keep typed singleton because global CAS/pagination invalidation and cleanup progress have distinct semantics. Replaces dynamic `bridge_meta` keys. |
| `runtime_problem_resolutions` | Current runtime-problem resolution evidence by Agent revision | Keep the latest matching resolution only; delete with Agent. Replaces one dynamic meta key per Agent. |
| `automatic_recovery` | Durable bounded recovery action/budget; kind/state/attempts/schedule/evidence | Keep unresolved work through restart and retained resolved evidence through history retention. It never authorizes arbitrary new execution. |
| `automatic_recovery_incidents` | Stable incident identity to active recovery relationship | Keep current and historical incident identity so a restart does not reset attempt limits; one recovery key per incident. |

Schema 18 also had `scope_versions` and `job_summaries`; both are removed above.
Its other project label/UUID/name/cwd snapshot columns, session payload, Agent archive
column, and dynamic retention/history meta keys are represented in the matrix by
their schema-19 owners rather than by compatibility tables.

## Index and query contract

The schema defines 42 non-SQLite indexes and three event-budget triggers. The
indexes below are correctness or bounded-work contracts rather than incidental
optimizations:

| Query | Required access path |
| --- | --- |
| Active work for a connection | `jobs_thread_active`, `jobs_source_thread_active`, `jobs_agent_active`, `job_interactions_blocking`, and cancellation target indexes |
| Project rename/cwd conflicts and display order | `projects_active_name`, `projects_active_cwd`, `projects_ordered` |
| Scope/status/Activity Job views | `jobs_scope_recent`, `jobs_status_recent`, `jobs_activity_recent` |
| Event cursors and per-Job cleanup | `activity_events_*_cursor`, `job_events_*_cursor` |
| Pending completion delivery | `completion_outbox_pending` |
| History cleanup and review | `jobs_status_recent`, `work_history_state` primary key, `work_history_expired` |
| Question and hold expiry | `user_questions_expiry`; bounded `result_holds` scan of at most 500 rows |
| Connection/recovery maintenance | `thread_connections_idle`, `thread_connections_agent`, `automatic_recovery_scope`, `automatic_recovery_job` |

Run the read-only storage audit against an explicit database to record actual
plans and timings. It backs up the source through SQLite and performs migration,
query, and compaction experiments only on temporary copies:

```bash
npx tsx scripts/database-storage-audit.ts /absolute/path/to/state.sqlite report.json
npx tsx scripts/card-state-restart-audit.ts /absolute/path/to/state.sqlite restart-report.json
```

The first audit reports logical cell payload, allocated and reusable pages, main
DB/WAL/SHM sizes, migration-backup totals, serialization bytes, the old/current
progress write paths, query plans, representative unfinished-work latency, and a
verified offline `VACUUM INTO` copy. The restart audit compares entity keys; full
normalized scope, Activity, Agent, work-history, and session execution state;
Agent/thread relationships; Job receipts; and exact rows for 18 critical
settings, request, question, cancellation, delivery, and recovery tables. It
allows only the declared invalid legacy-project context removal. Its second
restart must be byte-semantically stable for every current table except the
append-only bridge-instance journal.

The checked-in [schema-18 restart audit](audits/issue-95-state-restart.json)
preserved all 672 Job receipts, all 351 valid session execution contexts, and all
313 valid Agent/thread relationships; removed exactly the 43 invalid
legacy-project sessions and 43 corresponding Agent-thread relationships, exposed
31 tools on both reads, and found no business
table change on the second restart. The point-in-time
[storage audit](audits/issue-95-database-storage.json) measured a 196,378,624-byte
main DB, 4,124,152-byte WAL, 160,403,456 reusable bytes, and five older backups
totalling 239,480,832 bytes. On its disposable migrated copy, structured Job and
interaction payload duplicates and redundant summary fields were zero. The public-event
progress path changed from nine to seven SQL write statements, and a throttled
state-only progress tick uses two, excluding trigger updates. Full Job
serialization/upsert and unconditional summary/connection writes each changed from
one to zero. The sampled progress-state serialization
estimate was 93.281% smaller, 201 unfinished-work probes changed
from 80.106 ms total to 0.679 ms total with answers unchanged and keyed searches
on all three current identity indexes, and the verified compact copy was
10,252,288 bytes. These are measurements of that local
copy, not end-to-end service latency or evidence of a live replacement.

## Upgrade and legacy-data rules

A fresh database creates schema 19 directly. A persistent supported older database
gets one private, mode-0600 backup named
`state.sqlite.pre-v<SOURCE>-to-v19.sqlite`. Retrying the same upgrade reuses that
name instead of accumulating another copy. The original source version is recorded
before the first intermediate checkpoint, so a later retry cannot create a second
backup from a partially upgraded schema. Before that in-progress marker exists, a
same-named file from an older database at the path is replaced with a fresh source
backup; after the marker exists, the exact recovery file is required and never
overwritten. A missing or wrong-version recovery copy fails closed. Each
intermediate migration records its literal destination version; no step writes
the current-version constant. The schema-19 rebuild and its
foreign-key check run in one transaction. An interrupted or invalid conversion
rolls that rebuild back and can be retried after the source problem is corrected.

Schema-18 project values are accepted only when their UUID matches `projects`.
A session or Agent-thread context with project metadata but no registered-project
match is removed. An Agent-thread row can supply a fallback session only when no
legacy session exists for that thread; it cannot replace a rejected session. The
Agent-thread relationship is also validated independently, so a bad relationship
beside a valid session is removed without removing the session. Its Agent becomes
orphaned if it would otherwise claim a removed current context. Historical Job
request/terminal receipts remain, with project metadata removed and no guessed
relationship. Migration never creates a project from a slug, name, cwd, or old
snapshot.

The supported schema-3 fixture is taken from the published v0.3.0 implementation
and passes every fixed checkpoint through schema 19. Schemas 1 and 2 are outside
the supported release floor and are rejected before a backup or mutation. Removed
JSON import markers/backends cannot reintroduce retired fields on later restarts.

## Capacity, backups, and offline compaction

Treat four measurements separately:

1. Logical data is table row counts and SQLite cell-payload bytes.
2. Allocation is `page_size * page_count`; reusable allocation is
   `page_size * freelist_count`.
3. Runtime files are the main database, `-wal`, and `-shm` sidecars.
4. Migration backups are separate private files and are not limited by
   `event_budget`.

The bridge uses WAL, `synchronous=FULL`, foreign keys, a five-second busy timeout,
and mode 0600 for persistent database/backup files. Live retention keeps
transactions bounded and leaves free pages for reuse. It never runs `VACUUM` on a
live bridge.

Keep the most recent verified pre-upgrade backup through the release's physical
upgrade validation and the operator's chosen rollback window. Once that window
ends and the upgraded database has survived normal restarts, remove older backups
as a deliberate operator action. Backups contain the same private material as the
source database and require the same access controls. The bridge does not silently
delete them because release and rollback policy belong to the operator.

For disk compaction:

1. Stop the bridge cleanly and confirm no bridge process holds the database.
2. Retain a consistent SQLite backup that includes committed WAL content; do not
   copy only the main file from a running WAL database.
3. Open the stopped database, run `PRAGMA integrity_check` and
   `PRAGMA foreign_key_check`, then checkpoint the WAL.
4. Run `VACUUM INTO` a new mode-0600 file on the same protected filesystem.
5. Open the new file and repeat integrity, foreign-key, schema-version, and table
   count checks before an atomic replacement.
6. Keep the pre-compaction backup until the restarted bridge passes its state and
   UI reads. On any failure, stop the bridge and restore the verified complete
   backup rather than combining an old main file with a newer WAL.

The storage audit executes and verifies steps 2–5 on disposable copies and leaves
the live database untouched. A report with `liveDatabaseReplacementPerformed:
false` is implementation evidence, not evidence that an operator has compacted or
released a production installation.
