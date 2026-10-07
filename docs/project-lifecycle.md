# Ending project use and registration

Schema 31 makes archive a restartable execution shutdown and delete the end of
Bridge management. Neither action changes the folder, files, Git repository,
Codex rollout files, or original Codex/ChatGPT conversations. There is no separate
conversation archive or permanent deleted-project history view.

`projects.archive_state` is the authority: `active` accepts work; `processing`
records accepted shutdown intent; `unresolved` records an incomplete attempt and
its concrete `archive_reasons`; `complete` records confirmed shutdown and sets
`archived_at`. `archive_revision` fences stale cleanup attempts. The Settings API,
card and macOS Settings expose these states and allow cleanup retries.
The Settings resource advances to `v6` because cached deletion guidance and
shutdown controls do not satisfy this contract. Close older Settings mounts,
refresh the connector and reopen Settings before deployment acceptance; a URI
change cannot revoke an already open mount.

Archive commits a short intent transaction before any external operation.
Admission, continue/fork, input responses, approved followups and automatic
recovery check that authority. Deferred execution checks it again immediately
before upstream dispatch. The Job payload records `executionDispatched` durably
before that call; absent legacy dispatch evidence is treated as unknown after
restart, rather than permission to cancel unseen execution as an undispatched Job. Accepted, undispatched Jobs are cancelled; dispatched
Jobs without assignment wait for ownership evidence. They are never called
completed merely to clear a project. Cancellation uses the exact assigned turn.
App Server worker fallback additionally requires all loaded/active contexts in
the retirement set and excludes in-flight calls without proven turn ownership.
Shared contexts outside that set block fallback. Background terminals are probed
without resuming a thread, stopped, and checked again. Termination failure or
missing/timeout evidence remains retryable and prevents archive completion.

The controller performs external work outside SQLite transactions, then commits
completion under an archive-revision CAS and a fresh active-Job/connection check.
Every startup and periodic sweep resumes pending intents. Timeout means unknown,
not success; a late original operation can settle and a later sweep confirms it.
If SQLite cannot list intents or write a cleanup checkpoint, the controller keeps
the existing intent, records its diagnostic `lastError`, and retries on the next
sweep. It cannot claim completion or persist an unresolved reason while the
database itself rejects that write. Normal database health reporting still applies.
Completion removes project-owned session/connection and Agent-thread mappings,
clears only matching current pointers, releases assignments and abandons unfinished
Activity goals. An idle/open historical record alone does not delay shutdown.
Persistent, ephemeral and unknown contexts all use this cleanup path. Other
project Jobs, Agent identity and replacement current threads remain intact.
Restore is allowed only after completion. It activates the registration without
resuming past executions or restoring current-thread selection; next use creates
new context.

Delete is a single SQLite transaction after confirmed archive. It physically
removes the project, its Activities, Jobs, sessions and result/history projections.
Repeating delete after removal succeeds even with the old registry revision.
Concurrent delete before confirmation fails without partially changing settings.
A new registration at the same cwd receives a new UUID/reference and session;
old idle contexts do not pin the folder. Actual active executions and another
active registration still protect their folder. No lookup infers ownership from
cwd or transfers late results to a new registration.

| Data | Archive / delete rule |
| --- | --- |
| `projects` | Intent/state authority until delete; physical removal after confirmation. |
| `sessions`, `agent_threads`, `thread_connections` | Release and remove owned context at archive completion; exact thread tombstones fence late reconnection. |
| `activities`, `activity_agents`, `jobs` | Honest cancellation/abandonment and assignment release at archive; remove project-owned records at delete. FK children remove events, interactions, history, result holds and completion projections. |
| `cancellation_operations`, `cancellation_intents`, `steering_deliveries` | Retain only independently scoped request/hash/observed outcome receipts; remove target relationships and payloads. |
| `automatic_recovery`, incidents | Remove Job-owned recovery and discarded current-thread recovery; preserve unrelated Agent recovery. |
| `codex_question_deliveries` | Schema 31 adds optional Job attribution. Remove attributable journals after retaining request receipts. Legacy unattributable journals stay independent: ownership is never guessed. |
| MCP Events / approved followups / `bridge_meta` | Remove journals referencing retired identities; late event saves/admission cannot revive removed Jobs. Installation/schema metadata and unrelated scope state remain. |
| `operational_command_receipts` | Preserve command/hash idempotency, replace removed-target results with management-ended projection. No delivery is fabricated. |
| `retired_requests` | Independent, indefinitely retained admission/control deduplication: namespace, scope/request ID, optional opaque Job ID, existing hash/version, observed outcome/time. No project/cwd/Activity/session FK or content. Unknown legacy hashes remain null and retries fail closed as accepted-but-uncomparable. |
| `retired_threads` | Independent opaque thread ID/time only; indefinitely fences stale writes and reconnection. No folder or registration ownership. |

Job status/result/continuation management after delete returns
`PROJECT_MANAGEMENT_ENDED`. Retrying the same accepted request never executes it
again; a known changed hash returns `REQUEST_ID_CONFLICT`. Memory caches, deferred
progress and settlement snapshots consult these durable receipts, including after
restart. Undelivered completion/event records are removed, not marked delivered.

The 30→31 migration preserves existing active identities. Legacy archived and
deleted/tombstoned rows become pending cleanup with `archived_at` cleared until
confirmation. Legacy deleted rows are then physically removed by the same
controller; no user DB editing is needed. A fresh database and every supported
upgrade use the same appended schema step. Rollback and pre-upgrade backups follow
[the existing schema recovery policy](state-upgrade-recovery.md). Cleanup requires
a runtime execution owner capable of establishing termination evidence; uncertain
ownership remains unresolved for operator retry.

The controller also resumes a legacy deleted row already at the confirmed archive
checkpoint, covering process loss between confirmation and physical deletion.
It retries deletion directly without releasing confirmed context again. A failed
legacy deletion returns to unresolved cleanup with its concrete failure reason;
if the database rejects that checkpoint too, the still-confirmed legacy row stays
in the durable pending selection and is retried after storage recovers. Each
external cleanup step checks that its intent is still current.
An old deleted identity cannot be restored during that checkpoint gap; it must
finish deletion before the folder is registered with a new identity.
