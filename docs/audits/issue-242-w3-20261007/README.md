# Issue 242 W3: native completion events and durable outbox

W3 starts from exact integrated W1/W2 HEAD
`f710974b33fc40432653c815d175058cba1adaee` on
`codex/issue-242-p0-w0`. The isolated branch is
`codex/issue-242-w3-completion` in
`/Volumes/Data/Dev/codex-mcp-bridge-issue-242-w3-completion`.
Implementation and initial measurements are committed as
`fa0cc254596621da00370d8e1459bbf2f539e362`. Commit
`bff15a07b4838b3d5b5cb05a34f8c3c471da2af6` changes only the native test's
startup synchronization, replacing an assumed 250 ms startup with an observed
availability request before counting subsequent progress. Product source and
the measured Node code are identical across those two commits.

Integration target metadata is `codex/issue-242-p0-w0`. Integration and branch/
worktree cleanup remain pending; the review branch and worktree are preserved.
No merge into the parent or `dev`, reset, rebase, force push, remote write,
GitHub Actions invocation, or conversation operation occurred. Installed app,
helper, operational database and user data were not changed. All new database
measurements and execution tests use synthetic temporary state.
[local-preservation.json](local-preservation.json) verifies original local dev
`ea8f93e2acbb9f4b6deca113165d27e8c9c23857` and the exact W1/W2 baseline remain
clean and unchanged.

## Implemented behavior

`completion-outbox-ready` uses the existing application change subscription,
runtime generation-checked IPC and companion `changes.wait` channel. The store
collects newly inserted notify IDs inside the outer write transaction, discards
them on rollback, and checks their processability after COMMIT. An inserted
item already leased or delivered before that commit does not emit readiness.
Ordinary progress, verify-channel items, Settings, ack and retry release do not
emit this topic. Store observers cannot turn a committed write into a failed
command. If invalidation is lost, recovery reads still find the durable item.

Change notices add optional-compatible `supportedTopics` and per-topic epoch/
revision fields. Native compares the notice and readiness revisions, ignores
duplicates and older revisions, and retains recently retired epochs. Existing
runtime generation checks and native connection generation/cancellation checks
reject responses from an obsolete connection. Notices carry invalidation only;
the outbox remains authoritative for availability, identity, lease and delivery.

Local-only `completion.availability` returns a read-only availability flag and
the earliest effective retry/lease deadline in Unix milliseconds. The deadline
is the later of an item's retry and lease expiry, minimized across undelivered
notify items. It is classified as a query with the existing native control
reserve. It does not create a command receipt or enter a write transaction.
`completion.claim` also performs an internal SELECT preflight, protecting old
native callers. A true empty preflight returns before BEGIN IMMEDIATE. A
positive preflight still acquires the writer lock, reselects candidates and uses
the existing atomic conditional lease update. Internal counters separately
record empty preflights, actual claim transactions and lost races.

Native checks notification authorization before availability and again before
claim. Delivery remains singleflight with a 100 ms debounce per batch and a
maximum of ten items. Successful full batches request the next debounced batch.
Ordinary dashboard/progress and Settings refreshes no longer request delivery.

Failed presentation or lost acknowledgement releases only the matching owner's
undelivered notify row. It persists `next_attempt_at` as
`now + min(300000, 5000 * 2^(attempt_count - 1))` (bounded exponent). Claim remains
the operation that increments `attempt_count`. A committed ack followed by a
lost response is already delivered, so release is a no-op. Lost release or
process death leaves the existing 60-second lease recoverable. Stable event IDs
and the existing macOS notification identifier behavior remain unchanged.
Notification retry never executes or retries a Codex Job.

Start/resume, reconnected change observation, epoch change and connection change
trigger recovery. On the existing ten-second status cadence, native checks
completion recovery every 60 seconds when the dedicated event channel is
supported and connected, and every ten seconds for legacy/unsupported/disconnected
events. Retry and lease deadlines can make that next status tick due earlier;
they are observed within the existing tick cadence. Periodic recovery also
covers lost events and permission changes. No production timeout, capacity,
status/heartbeat interval, database schema or execution authority was raised.

## Counts

Before was rerun against the untouched exact W1/W2 worktree; its empty Git
status is embedded in [before.json](before.json). After ran on committed W3
source with an empty source diff in [after.json](after.json). Node v24.11.1,
darwin/arm64 and SQLite 3.53.4; temporary database, four progress Jobs, 400
progress events and a 25-item completion backlog. The direct empty/retry samples
are bounded to 20/10 attempts. Counts exclude fixture setup unless explicitly
measuring enqueue. No actual Job is launched by the count harness.

| Workload | Methods before → after | SELECT before → after | Write SQL before → after | BEGIN/COMMIT pairs before → after | Changed rows before → after |
| --- | --- | --- | --- | --- | --- |
| 20 empty claims | claim 20 → 20 | 20 → 20 | 0 → 0 | 20 → 0 | 0 → 0 |
| 10 attempted immediate delivery retry cycles | release 10, claim 10 → release 1, claim 10 | 30 → 11 | 20 → 1 | 20 → 1 | 20 → 1 |

The retry harness releases only a batch it actually claimed. The old path can
reclaim in all ten cycles; W3 records one deferred release and all subsequent
checks before the deadline remain read-only. This distinguishes reduced
dispatches from per-method database cost.

Additional after counts:

- 400 progress events: 400 dashboard notices, zero readiness notices, zero
  completion claims, zero SQL/transactions/changed rows in that measured
  progress handler fixture. Its existing in-memory/immediate persistence budget
  is unchanged; this does not assert that all production progress is write-free.
- 20 explicit availability calls: 20 SELECTs, zero transactions and changed rows.
- 25 completed Activities: 25 readiness notices. Enqueue retained 100 required
  transactions and 775 changed rows across Activity/Job/event/outbox recording.
- Backlog drain: `10, 10, 5`, three nonempty claim transactions and three ack
  transactions; 82 SELECTs, 50 UPDATEs and 50 changed rows. The direct harness
  additionally calls claim once to establish empty, without a transaction.
  The native model test uses three claims and three acknowledgements.
- Due retry: three SELECTs, one transaction/update and one changed row.
- Concurrent consumers after preflight: B's winning claim and A's revalidation
  produce two transactions and one changed lease in the combined test trace;
  A records one lost race, separately from 20 true empty preflights.

[comparison.json](comparison.json) contains the count comparison.
WAL **file length** deltas are included separately in raw measurements, not
interpreted as frames, fsync, physical IO or lock wait. Wall times are descriptive;
filesystem cache and concurrent builds/tests were uncontrolled. These results
are not installed-app performance or tunnel acceptance evidence.

## Validation and failure evidence

The committed build, release/localization checks and strict harness typecheck
passed. [w3-correctness.txt](w3-correctness.txt) reports all ten focused Node
tests passing. [runtime-compiled.json](runtime-compiled.json) reports seven
assertions passing through the compiled server/state-owner IPC boundary: one
readiness notice, one claim, one deferred release, zero Job executions.
[runtime-probe.mjs](runtime-probe.mjs) is the reproducible temporary-state probe.

Validation status and artifact hashes are finalized in
[validation.json](validation.json). Logs preserve failed attempts as well as
rechecks. The broad default Node run passed 64/103 and hit Vitest's five-second
test allowance in 39 cases; the unchanged baseline reproduced one such timeout
in [baseline-tool-control.txt](baseline-tool-control.txt). The large skill socket
test retains its own explicit 20-second limit and also timed out on both W3 and
the unchanged baseline ([baseline-large-skill-control.txt](baseline-large-skill-control.txt));
its result is separate from completion behavior. A broader rerun allowing
30 seconds per Vitest test passed all 21 issue-221 delivery tests but still
failed 13/55 tool tests with HTTP ECONNRESET and a ten-second setup-hook timeout.
These are preserved in [node-regressions-budget.txt](node-regressions-budget.txt);
the runner allowance did not alter production deadlines or explicit test limits.
Source-TS runtime startup hit the existing
20-second production startup bound on its first attempt; the compiled-product
probe passed without increasing that bound. Earlier Swift builds compiled files
before their fixes or while edits were ongoing; they are retained as failure
evidence rather than acceptance results.

The full strict Swift run exercised 245 tests, skipping two. Its only failure
was the new model fixture assuming initial preflight completed within 250 ms;
the follow-up test commit awaits that request before counting progress. All
other native cases passed in that run. Final rechecks:

- Strict native W3: 11/11 pass. Full native recheck of that same strictly built
  binary: 245 tests, two skips, zero failures.
- Source-TS runtime W3 IPC case: passes with the original 20-second startup bound
  on the quieter recheck. Compiled runtime probe also passes.
- Broad default Node recheck: 74/76 pass; two five-second fixture timeouts.
  Both speed-policy variants subsequently pass at the default allowance.
  The historical events-B replay still exceeds five seconds in isolation, while
  all 21 delivery cases passed with the 30-second runner allowance above.
- Large skill socket recheck still hits its existing 20-second limit, as it did
  on the untouched baseline. No payload/read/tunnel/proxy fix is included in W3.

Consequently the completion cases and native suite are green; there is no claim
that the entire default Node suite is green on this machine. Broader failures,
controls and rechecks are all preserved and indexed in validation.json.

Coverage includes post-commit terminal/manual Activity readiness and rollback;
progress/Settings isolation; read-only emptiness versus consumer race; 25-item
batches; bounded retry and owner checks; delivered/ack lost and ack replay;
stable IDs, lease expiry and actual database close/reopen; duplicate/out-of-order/
lost readiness; reconnect/epoch/new app state; unsupported/legacy server;
singleflight, cancelled/obsolete generation and denied/revoked permission.

## Integration review and file ownership

W1/W2 are ancestors of the W3 branch, so no W1/W2 integration conflict is
introduced. The only overlap with the observed W4 working copy is
`AppModel.swift` and `AppPresentationTests.swift`. Read-only three-way
`git merge-file -p` checks against W4 HEAD
`8474165e523b47d881f688bd09caf2e4c78ac7af` found zero conflicts in either file.
[integration-review.json](integration-review.json) binds the checked file hashes.
W4 was still uncommitted work in progress; final W4 integration and combined
validation remain pending. No W4 working copy, index or branch was changed.

Changed code, tests, harness and release fragment:

```text
.changes/issue-242-w3-completion.json
src/changeSignal.ts
src/companionServer.ts
src/completionDelivery.ts
src/runtimeProcess.ts
src/stateStore.ts
src/tools.ts
macos/Sources/CodexBridgeKit/BridgeClients.swift
macos/Sources/CodexBridgeKit/BridgeModels.swift
macos/Sources/CodexBridgeKit/ChangeNotice.swift
macos/Sources/CodexBridgeMenuBar/AppModel.swift
macos/Sources/CodexBridgeMenuBar/CompletionNotificationWakeState.swift
macos/Sources/CodexBridgeMenuBar/CompletionNotifications.swift
macos/Tests/CodexBridgeKitTests/AppPresentationTests.swift
macos/Tests/CodexBridgeKitTests/CompletionNotificationWakeTests.swift
macos/Tests/CodexBridgeKitTests/OperationalNotificationsTests.swift
macos/Tests/CodexBridgeKitTests/W3NativeOutboxFixture.swift
scripts/issue-242-completion.ts
test/companionServer.test.ts
test/issue242Characterization.test.ts
test/issue242Completion.test.ts
test/runtimeProcess.test.ts
```

The audit directory contains the measurement, validation and preservation
artifacts. Read projection, tunnel/proxy and W4 product code are unchanged.
