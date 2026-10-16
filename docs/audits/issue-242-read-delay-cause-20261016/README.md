# #242 installed list delay: cause and correction

The installed list failure has two demonstrated contributors: rebuilding unused
Job event bodies on every Dashboard projection, and launchd's inherited
`Background` resource policy. This investigation follows the failed installed
[acceptance sample](../issue-242-installed-acceptance-20261016/README.md).
It does not establish the cause of the historical five 502s tracked in #262.

## Actual failed request

The operational reader was profiled without restarting the app, helper, state
owner, executor or Jobs. A native-equivalent summary request failed after
2,516.893 ms with `STATE_READ_STALE`. In the 2,921.709 ms V8 sampling window,
`CodexJobRegistry.load -> BridgeStateStore.listJobs` accounted for 2,441.209 ms
of inclusive sampled elapsed time; `executeProjection` accounted for 2,512.625 ms.
Most of that stack was inside the native SQLite call, followed by event JSON
hydration and text validation. These are sampled elapsed attributions, including
possible descheduling and profiler overhead, not measured SQL lock wait, physical
I/O or exclusive CPU time. [Profile summary](live-reader-profile.json).

The installed build was version 0.4.1, bundle build 16, source
`0129ae123694ac53b876240968269b7a29f9f003`, runtime source hash
`d4a2a1d2ac951336b8414ad17925a5873534842d85a0ecc1d52f22ea6a9c8086`.
The correction starts at `dev` commit
`009d0bde81e3fbedf8454c34562f57ae26f7aae0`. Product source was unchanged between
that installed source and this base. The live reader and its helper/launcher/
ingress/state-owner parents had priority 4; ordinary terminal children had 31.

The inspector was opened only on loopback for the bounded profile and then
closed; the original process identity survived. An attempted state-owner heap
lookup timed out before attaching its observer and supplied no phase evidence.
A later attempt to clear Darwin background policy on the live reader left its
priority at 4 and all three observations failed; its original policy was restored.
That failed intervention is retained, not represented as a live improvement.
[Live policy control](live-policy-control.json).

## Why the list read was expensive

A query-only backup of the actual population contained 1,439 Jobs, 810 Agents,
834 Sessions and 22,187 events. There were 44 unarchived Jobs with 16,739 public
events totalling 17,968,428 bytes. The existing per-Job 200-event limit still
assembled **8,275,748 bytes** of event JSON for a list read. Current Job payloads
were 322,184 bytes, and pending inputs 88 bytes. [Population](population.json).

Three interleaved SQL-only controls on this same frozen data took
41.971 / 38.565 / 40.019 ms with event bodies, versus
1.887 / 3.188 / 1.758 ms with just that output column replaced by `[]`.
All other returned columns were equal. Full hydration additionally parses and
validates those bodies; a normal-priority full hydration took 323.942 ms.
The query plan shows the per-Job correlated event scan, temporary ordering and
JSON aggregation. This isolates avoidable work; it does not claim these
terminal SQL timings reproduce the operational scheduling context.
[SQL controls and plan](sql-control.json).

`listJobsForDashboard` now omits event bodies only for query-only projection
registries. It preserves all current Job fields, pending interactions, scope
filters, retention, ordering and history SQL. Full execution/recovery registries
and exact event/detail reads retain their existing paths and strict parsing.
The query-only guard prevents writing a truncated projection back as full state.

## The installed scheduling difference

`HelperBootstrap.launchAgentPropertyList` specified `ProcessType=Background`.
Local `launchd.plist(5)` documents CPU/I/O resource limits for that policy and
app-equivalent resources for `Interactive`. `taskpolicy(8)` documents child
inheritance. The helper serves UI/MCP requests over Unix sockets, which do not
provide Adaptive's XPC activity boosts. Its generated policy is now Interactive.
This changes scheduling, not any request deadline, queue capacity or retention.

A short functional control used the actual compiled CodexBridgeKit plist
generator, unique disposable launchd labels, the same frozen DB, Node 24.11.1,
the native query, an unchanged 2,500 ms caller deadline and the existing physical
request bound. Each sequence made five summary requests followed by five history
requests; the cold first request is included. Code and policy were varied
separately, in the following order. No other validation suite ran during it.

| Reader code | Actual launchd policy / child priority | Successful requests | All observed durations |
| --- | --- | --- | --- |
| Installed | Background / 4 | 3 / 10 | 1,117.102–2,554.200 ms |
| Installed | Interactive / 31 | 10 / 10 | 161.144–358.990 ms |
| Corrected | Background / 4 | 10 / 10 | 382.789–1,257.937 ms |
| Corrected | Interactive / 31 | 10 / 10 | 44.939–172.794 ms |

This identifies both contributors under the observed distribution and OS load.
It is a frozen-data functional comparison, not an installed post-upgrade or
long-duration guarantee. All four labels were booted out and verified absent;
no fixture reader survived. [All observations and phases](launchd-controls.json),
[actual-generator probe](LaunchAgentPolicyProbe.swift),
[query-only reader probe](reader-control.mjs).

Earlier taskpolicy controls are also retained, including an incomplete baseline
sequence: five summaries and three history calls completed, three timed out, and
the reader failed to drain within its unchanged 10-second control bound. Its
eight observations are not replaced by a shorter passing sample. Event removal
alone therefore does not establish sufficient responsiveness under Background.
Response digests were excluded because time-dependent projection fields made
them vary even within one unchanged baseline. Functional equality comes from
SQL column comparison and the regression test, not those digests.
[Exploratory observations](exploratory-controls.json).

## Regression and remaining acceptance

The regression fixture adds 600 substantial events to active and terminal Jobs,
including both input and approval waits. It compares the child projection to
the original full-event inline projection for counts, terminal rows, active
identity/status and revisions, verifies zero changed rows and unchanged exact
events, and then proves an unused malformed event cannot break the list while
exact event reads still reject it. No timing threshold was relaxed.

Validation commands and results are recorded in [the validation receipt](validation.json).
Fast/schema checks and the Node build passed. Strict native validation executed
343 tests, with three existing skips and zero failures. The full Node attempt
passed 2,037 tests and failed 17; its affected gate is **not green**. Four failures
depended on the harness's global CODEX_HOME override and five did not repeat in
either nine-file comparison. With that override removed, all 17 originally
failing cases were selected again on both the exact base and the correction:
nine passed and the same eight failed on each. Existing tool-discovery/selector,
SQL-count and private-env fixture assertions remain unresolved; they were not
changed to pass this correction. All seven #242 read tests passed in the full run.
Raw DBs, full profiles, user identifiers, process arguments, authentication
material and user event contents stay in the private local evidence directory.
Only aggregate measurements and fixture sources are committed here.

The operational runtime has not been replaced during this investigation while
Jobs are active. Installing the correction and observing the actual app's list,
retention/recovery and completion delivery remain necessary before #242 closes.
The [five historical 502 records](historical-502-recheck.json) were rechecked
against the retained October 7 diagnosis. They still lack an end-to-end
request/termination join. A separate `diagnostic-connection-reset` log is an
isolated control, not another operational incident. The discovered list cause
must not be relabelled as the proven cause of those 502s.
