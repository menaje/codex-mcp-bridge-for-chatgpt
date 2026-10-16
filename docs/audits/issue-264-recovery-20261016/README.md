# Issue #264: task-list reload versus service recovery

The implemented recovery action depends on the failed operation and typed RPC/
HTTP failure metadata. A list failure with a recent successful service check
shows **Reload list** (`다시 불러오기`) and reads `dashboard.snapshot` with enrichment
disabled. It does not call helper bootstrap, lifecycle actions, authentication,
settings, or Job execution. Generic errors elsewhere retain their existing
attention behavior.

## Scope and causal relationship

#242's list-read delay can trigger #264's incorrect guidance. The read delay
contributors and fix are documented in [the #242 cause audit](../issue-242-read-delay-cause-20261016/README.md)
and PR #265. This change fixes the resulting UI/action mismatch. It does not
establish the cause of the historical HTTP 502 incidents tracked in #262.
The user's original transient screen was not captured; these fixtures establish
the code path, not the exact cause of that uncaptured episode.

## Recovery and request bounds

- A fresh healthy observation allows a list-only reload. If the last check is
  older than 20 seconds, or a list transport/permission failure needs confirmation,
  the model makes one status-only check using the existing RPC deadline.
- Failed reads schedule **zero automatic list retries**. Existing change-driven
  refreshes keep their 250 ms debounce. Structural reads have one in-flight task
  and at most one trailing replacement; continuous refresh clicks join through
  the busy guard rather than growing a queue. Existing status/readiness polling
  retains its existing bounded recovery window and request deadlines.
- Remote health now retains its last confirmed time/content, with the existing
  eight-second observation grace for transient errors. Credential/identity
  rejection leaves that checking state immediately. Target changes, closing the
  popover and shutdown cancel/fence pending list reads.
- A retained snapshot, exact execution detail, selected panel and last successful
  read time survive a list failure. Successful reload clears the delay notice.
  Menu service health does not become a helper failure solely from a typed list
  failure; stale positive observations are not presented as indefinitely current.
- The optional diagnostic disclosure exposes only operation/failure kind/phase.
  Repeated failures offer the existing connection settings/diagnostic route.
  Raw server messages and user payloads are not copied into this new notice.

## Evidence

The [native UI probe](native-ui-probe.py) builds a separate localized `.app` from
production `AppModel`/`DashboardPopoverView`, with real Unix fixture sockets and
synthetic data. Run `python3 docs/audits/issue-264-recovery-20261016/native-ui-probe.py /tmp/new-probe-directory`,
then run its printed executable and click the reload button within its bounded
interaction window. The fixture never installs/replaces the operational app.

The checked [first-load image](first-load-failure.png) shows the bridge as healthy,
a list-read error, and `다시 불러오기`. An actual native UI click recovered the
[empty fixture list](recovered.png). [The report](ui-interaction.json) records
exactly two snapshot calls (initial failure + successful reload), **zero** helper
health/auth/settings/bootstrap calls, the cleared error and a successful read
timestamp. The locale changes to the fixture server's English preference after
its first successful snapshot; error classification never depends on that text.

`DashboardReadRecoveryTests` covers local and remote first-load failures, reload,
retained content/date, rapid clicks (100 local/20 remote), stale-health confirmation,
transient versus confirmed remote failure, and late local/remote replies after
closing. The added Dashboard popover test preserves a cached exact execution
detail and the selected panel. Existing target/replacement/late-response and
connection-recovery tests run with the full native suite. Validation results are
recorded in `validation.json`.

## Installed operational app remains a separate acceptance step

At 2026-10-16 12:39 KST the existing installed app was still version 0.4.1 build
16: helper/bridge/tunnel running and connected, **one active Job**, and the read
projection reported `read-stale`. This is an observation of the older installed
build, during development work, not a benchmark of the correction. No operational
restart, Job cancellation/re-execution or app replacement was performed.

The isolated app interaction is functional native UI evidence. It does not prove
acceptance of an upgraded operational installation, the complete #242 criteria,
or the cause of #262. Keep installed acceptance pending until a safe ordinary
update can verify the current dev build without interrupting active work.

## Integration SIGPIPE investigation

An integrated native run exposed a test-fixture shutdown race. An accepted socket
was added to the fixture's client set, `stop()` shut it down, and its serving
thread then attempted to set `SO_NOSIGPIPE`. On macOS 26.6.2 that late option
change fails with `EINVAL`; the ignored failure left SIGPIPE enabled when a
buffered request produced a late reply. Descriptor event tracing captured stop
before serving started. This was not evidence of descriptor reuse or the cause
of a historical operational HTTP 502.

The fixture now sets and checks that option under its acceptance lock, before
publishing the client to `stop()`. A deterministic test pauses the serving
thread across stop and checks the option before and after shutdown. With the
original ordering it fails with `[0, 0]`; the corrected ordering must retain
`[1, 1]`. Its empty response avoids terminating the regression test process on
the defective ordering. No product signal handler, global SIGPIPE suppression,
timeout increase, or acceptance-expectation change is used.

[The standalone socket-order reproducer](fixture-socket-order.c) also isolates
the OS behavior without Swift, fixtures or operational data. Its signal handler
counts the expected signal in that diagnostic executable only. Exact validation
is recorded in [the fixture receipt](fixture-validation.json).
