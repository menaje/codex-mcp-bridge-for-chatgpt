# Conversation connections and retained data

Agent identity, the Codex conversation, an individual Job, a loaded App Server thread, its worker process, and OpenAI prompt caching have separate lifetimes. Releasing a connection preserves the conversation and the Agent's project, fork relationships and next-run settings. It does not archive or delete the upstream thread.

## Settings and clocks

| Setting or data | Default | Basis |
| --- | --- | --- |
| `CODEX_MCP_BRIDGE_JOB_TTL_MS` | 21,600,000 ms (6 hours) | In-memory terminal Job eviction; durable originals follow the saved history policy |
| `CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS` | 100 | In-memory registry and execution-slot capacity |
| `CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES` | 1 MiB | In-memory result preview bound; durable sanitized originals follow the saved history policy |
| `CODEX_MCP_BRIDGE_THREAD_IDLE_MS` | 21,600,000 ms (6 hours) | First durably committed end of the latest actual turn |
| Durable results, history and related diagnostics | 30 days | Saved 7/30/90-day or unlimited policy; fixed Job end or first incident occurrence |

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

The saved 7/30/90/unlimited history policy governs durable sanitized results and
related diagnostics. Six-hour/count limits evict registry/cache entries without
removing retained disk originals. Response-size limits affect the response preview;
complete sanitized originals remain queryable under the same saved policy after
archive and restart. Job end and first incident occurrence are fixed. Invalid saved
policy blocks destructive cleanup; numeric zero remains unlimited.

Current execution, valid input/approval and exact cancellation/replay identity are
preserved. Terminal delivery/uncertainty/hold cannot extend the history period.
Minimal request/hash/outcome, exact dispatch and current retry-budget authorities
remain without expired historical bodies or diagnostics. Expiry does not imply
success, delivery, approval, cancellation or recovery. Scope retirement stops
obsolete recovery control without prematurely removing its retained history.

Schema 32 labels missing old originals as legacy-partial and absent timing evidence
as a fixed legacy estimate. It does not restore previously removed content or read
Codex rollout files. Migrations retain the existing single private recovery backup;
live maintenance does not compact or restore operating databases. See [work history](work-history.md)
and [database schema](database-schema.md) for ownership, query and cleanup details.

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
