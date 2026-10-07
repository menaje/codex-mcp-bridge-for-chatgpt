# Conversation connections and retained data

Agent identity, the Codex conversation, an individual Job, a loaded App Server thread, its worker process, and OpenAI prompt caching have separate lifetimes. Releasing a connection preserves the conversation and the Agent's project, fork relationships and next-run settings. It does not archive or delete the upstream thread.

## Settings and clocks

| Setting or data | Default | Basis |
| --- | --- | --- |
| `CODEX_MCP_BRIDGE_JOB_TTL_MS` | 21,600,000 ms (6 hours) | Retained terminal Job update time |
| `CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS` | 100 | Unprotected retained Jobs |
| `CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES` | 1 MiB | Maximum individual result body |
| `CODEX_MCP_BRIDGE_THREAD_IDLE_MS` | 21,600,000 ms (6 hours) | First durably committed end of the latest actual turn |
| Diagnostic events | 7 days | Event time, with the size bounds below |

Set `THREAD_IDLE_MS=0` to disable automatic connection release, or use a positive integer to adjust it. Restart the bridge to apply environment changes. Explicit app handoff still operates when automatic release is disabled. Reads, dashboard refreshes, notification delivery and terminal Job rewrites cannot move the connection's work-end clock. A restart does not replace it with startup time. A synthetic interruption discovered at restart is not evidence of when actual work ended.

Maintenance runs once per shared runtime and rotates one bounded slice every five seconds (35 seconds for a complete seven-slice rotation). It does not run once per stateless MCP request. Storage work is deferred while foreground Jobs or admissions are active. Every active Job reserves one retained-Job slot; an unclassified terminal Job keeps that reservation until an idle maintenance pass removes it or confirms a durable protection. When those reservations fill the configured retained-Job capacity, new work fails with retryable `JOB_RETENTION_CAPACITY` backpressure instead of allowing retained state to grow without bound. The release gate is committed before asynchronous runtime inspection. New work on that Agent/thread must wait or cancel the requested handoff; active work is never cancelled by this gate. After a verified release, an explicit new bridge turn claims the connection again and reloads the persisted conversation.

## Release and handoff

**Continue in Codex** in the local macOS dashboard requests a handoff of the exact displayed Agent and current thread. A changed target requires refreshing the row. The app opens the conversation only after the bridge has evidence of thread unload or its owning worker's exit. The button displays waiting reasons and provides cancellation. Closing the bridge connection does not itself prove that every other application has released its own connection.

Active turns, questions/approvals, cancellation or failed termination, and remaining or unverified background terminals prevent release. An open Activity or an old Agent assignment alone does not. Ephemeral and unknown-persistence conversations stay loaded. Worker retirement additionally requires every loaded conversation on that worker to be eligible, with no active calls, unknown child thread or protected conversation. New calls wait for the maintenance operation and can start on a replacement worker.

`thread/unsubscribe` acknowledgements (`unsubscribed`, `notSubscribed`) are not unload evidence. The bridge retains that distinction, handles `thread/closed` and `thread/status/changed` without requiring an active turn, and clears runtime routing and verified access when a thread closes. An unsubscribe timeout leaves ownership unconfirmed. Late acknowledgements cannot invalidate a newer resume. The optional protocol capability must support both `thread/unsubscribe` and `thread/loaded/list`; an unsupported runtime is not marked released.

Codex documents a separate 30-minute inactivity grace period after the last subscriber leaves. A protected shared worker can therefore keep a requested handoff waiting. Read-only enrichment uses non-loading inspection; historical/released connections are protected from implicit resume, including after bridge restart. See [App Server unsubscribe](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread).

Returning from the Codex app requires the app to relinquish its writer. The bridge reads current thread state and attempts a fresh resume of the same durable thread; Codex's writer lock remains the authority across processes. If another application still owns it, `THREAD_EXTERNALLY_OWNED` tells the caller to release that connection there and retry. No bridge turn is started and no archive, delete, forced process termination or transcript copy is used to bypass ownership. Merely navigating away in the app is not treated as proof of release.

## Persistence and app visibility

`bridgeThreadPersistence` independently selects `persistent` (the default for
new conversations) or `ephemeral`. `showBridgeThreadsInCodexApp` controls the
app-opening preference. Turning app visibility off no longer implies
memory-only storage or rejects persistent creation. Explicit memory-only mode
requires app visibility off. Existing conversations retain their actual runtime
persistence, even if the preference changes for the next new/forked thread.

Saved visibility preferences, including older settings without that field,
remain intact. Older settings without a storage preference default new threads
to persistent. This changes future creation only: existing ephemeral context is
not silently converted, copied or recovered after worker loss. Legacy records
keep their original persistence evidence; missing evidence remains unknown.
Actual start/resume/fork replies retain the runtime's `ephemeral` value.

Codex 0.153.3 exposes no verified durable-hidden flag for a shared app home.
Consequently, disabling the preference is not a promise that an independently
launched app cannot discover a conversation in shared storage. The Bridge's
independent store saves conversations across restarts without automatically
sharing that store with the desktop app. Direct app visibility is reported only
for persistent conversations using the default app home; other app discovery,
opening and handoff routes remain unverified and are checked separately from
storage and native resumption. Opening a private-store thread in the app is not
claimed as supported. See [new profile storage](codex-auth-connections.md#independent-conversation-storage-for-new-profiles).

## Database retention and recovery

Schema 20 is created directly for new installations and takes one consistent
private SQLite backup before upgrading a supported schema 3–19 database. It
separates the retained thread execution context in `sessions` from live connection
evidence in `thread_connections`; project names always come from `projects`.
Event cleanup commits resumable batches of at most 500 source events. It does not
read or delete Codex rollout files. Ordinary live maintenance does not run
`VACUUM`. The full table, migration, backup, and offline compaction contract is in
[database schema and lifecycle](database-schema.md).

The schema-17-to-18 checkpoint restores every legacy archived Agent in one
transaction under the single pre-schema-23 recovery backup described above. IDs,
names, timestamps, projects, Activity
assignments, thread links, next-run settings, Jobs, results, history and review
state remain unchanged. An archived Agent with a retained active Job becomes
active or waiting for input from that Job's current state; an archived orphan
remains orphaned; other archived Agents become idle. The migration clears only
the legacy archive marker and advances the Agent/scope versions. It is safe with
zero archived Agents and is idempotent after restart. It does not start work,
resume threads, or load Codex conversations. Agent archive/restore and the
30-day automatic Agent archive policy are no longer available.

Repeated diagnostic snapshots are coalesced by Job, event kind and item. Event cursor IDs continue increasing; authoritative current state is read from Job/Activity/question/delivery records rather than reconstructed from the event stream. The limits are 256 diagnostic events per Job, 8 KiB per payload, 50,000 Job events and 64 MiB of their payloads. Legacy excess is reduced in bounded batches. Related Activity metadata is also limited to 50,000 events and a seven-day window. These payload limits are not claims about the physical DB/WAL file size or long-lived identity tables.

The corrected schema-14 cleanup applies the per-Job bound to every Job encountered in a batch. On upgrade from the initial schema-14 test build, it resets only the diagnostic migration cursor once and resumes the same batches, so already-scanned Jobs also receive the corrected bound. Usage summaries are retained before old diagnostic rows are pruned; control records and result delivery state are unchanged.

When a Job result expires, its raw diagnostic events are removed in the same transaction. Existing archived Jobs are scrubbed in migration batches. Small outcome, error-code, execution-selection and usage summaries survive. Old thread-wide counters are labelled unknown for per-Job accounting; they are not retroactively presented as exact per-Job totals.

General result pruning protects:

- Active work and blocking questions/approvals, until resolved and durably saved.
- An undelivered/unacknowledged completion outbox entry, until delivery or acknowledgement.
- A prepared or dispatching response, until dispatch is resolved. An uncertain response protects the result until explicit operator review is acknowledged; its delivery journal remains uncertain and cannot be replayed. Store-level `acknowledgeUncertainResultReview` requires a retained terminal Job, does not clear other protection reasons, and protects again if another uncertain delivery is recorded.
- Recorded/dispatched cancellation intents, until terminal resolution.
- An explicit result hold, until release or expiry. Store-level `holdResult` requires a reason and a renewable expiry no more than 30 days away; it cannot restore an already expired result. No end-user hold/review control is added by this change.
- A historical unresolved live-card completion that crossed the retired send boundary, no later
  than the selected run-history expiry. A merely pending cardless event follows
  ordinary result retention. The `ui/message` body is not stored. Once the completion receipt has
  been offered an exact result, one ordinary result-retention window remains for
  a lost-return retry; successful results are not extended to the full history
  period. The small delivery row expires with run history.

Protected results can exceed the ordinary count/time retention policy, but do not remove diagnostic size limits or the individual result limit. Operators should resolve outstanding delivery/response states rather than clear provenance or replay an uncertain response. Reserved request IDs, cancellation/steering journals, question delivery records, Agent identities, project pins and fork identities are not diagnostic garbage.

After cleanup, free pages are reusable even when the DB file size stays unchanged. Inspect DB/WAL size and freelist pages separately. For disk compaction, stop the bridge safely, retain its backup, checkpoint and run SQLite `VACUUM` offline, then restart. Do not compact or restore over an active bridge, or restore only the main database file while discarding an associated live WAL. A backup contains private repository/result data and needs the same access controls as the live database.

## Cache observations

The six-hour connection grace is a conservative operating default, not a cache guarantee. No background model calls keep caches warm. API caching policies must not be expanded into a Codex subscription guarantee; changing the prompt prefix, tools, instructions or app environment can change reuse. See [prompt cache lifetime](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime) and [Codex plan usage](https://learn.chatgpt.com/docs/pricing#what-are-the-usage-limits-for-my-plan).

The bridge subtracts a known start counter from cumulative usage across all requests in one turn. Duplicate samples do not double-charge a Job. Missing baselines, incomplete counters and counter resets remain unknown. `last` is an individual request sample and is not substituted for a whole multi-request Job. Verified usage remains available after result expiry.

`npx tsx scripts/measure-thread-lifecycle.ts --run --codex /absolute/path/to/codex --out /private/output/directory` explicitly opts into live model requests. It compares a loaded continuation, unsubscribe/resume and worker restart, then prints the exact test thread for an app continuation. After the app has released it, rerun with `--resume-only` to check the latest external turn. Do not archive the conversation or stop a shared app worker to make this test pass. See the [acceptance record](audits/2026-09-09-issue-80-lifecycle.md) for measured results and remaining limitations.

## Project archive and delete

Project archive uses the separate [project lifecycle](project-lifecycle.md) contract.
It closes admission before shutdown, releases persistent/ephemeral/unknown context,
and removes current-thread selection only after termination/release confirmation.
Restore activates registration only. Delete removes Bridge management and result
projections; the original upstream conversation is preserved.
