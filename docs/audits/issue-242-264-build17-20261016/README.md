# #242 / #264: local dev build 17 installation and reads

The corrected local `dev` build is installed and running. The app and helper
report `0d26c7f14353:41d00390ea3a`, with bridge/tunnel connected and the reader
ready. [Identity](identity.json) records the local integration commit and source
fingerprint; the public `dev` ancestor includes PRs #265, #266 and #267.

## Rollout and build checks

Build 17 passed the normal bundle script: strict native concurrency and warnings
as errors, **352 tests executed / 3 skipped / zero failures**, production
compilation, localization, packaged helper imports, native dependency checks and
ad-hoc signature verification. Temporary diagnostic symbols/library dependencies
were checked absent. The preceding SIGPIPE failure was diagnosed and corrected
in the [test-fixture order audit](../issue-264-recovery-20261016/README.md#integration-sigpipe-investigation).

Before replacement, Jobs and pending admissions were both zero. A normal
non-force shutdown reservation completed its native handoff; all 57 captured
owned processes, both helper/bridge sockets and the helper launch service were
verified stopped before the bundle swap. Two recoverable copies of the prior
app are retained privately. Finder launched the replacement, which completed
its ordinary startup and connected the tunnel. The installed LaunchAgent now
uses `Interactive`; sampled helper/launcher priorities were 37/31. These are
instantaneous priorities. [Rollout receipt](rollout.json), [validation](validation.json).

## Installed read sample

The existing [native read protocol](../issue-242-installed-acceptance-20261016/InstalledReadProbe.swift.txt)
was compiled against the current `CodexBridgeKit` and run against the operational
sockets after startup completed. Existing native/server deadlines were preserved.
The probe used read RPCs and emitted aggregate counts and timing only.

| RPC group | Successful samples | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Dashboard summary | 10 / 10 | 56.698 ms | 64.104 ms | 259.055 ms |
| Dashboard history page | 10 / 10 | 63.190 ms | 71.076 ms | 85.441 ms |
| Exact execution detail | 10 / 10 | 1.178 ms | 1.553 ms | 3.185 ms |
| Helper health | 10 / 10 | 0.527 ms | 0.599 ms | 7.717 ms |

Detail checks matched the selected execution identity and revision without
publishing those identifiers. The Dashboard returned **733 retained executions**.
Earlier frozen controls counted **1,439 SQLite Job rows**, including archived
rows; those populations differ. Operating load and process lifetime also changed
across the update. These results establish the installed functional sample;
the controlled causal comparison remains the [four-variant frozen-data matrix](../issue-242-read-delay-cause-20261016/README.md).

[Aggregate summary](read-summary.json), [all aggregate samples](reads.jsonl).
The sample took 2.144 seconds overall. It is a finite functional read protocol,
with no duration-based soak or shortened replacement for a long test.

## Installed menu acceptance

At 14:08–14:11 KST, after the user opened the installed app's menu, native
accessibility and screenshot capture worked. The menu showed a healthy local bridge
and 733 retained executions.
A normal refresh advanced the last-confirmed minute from 14:08 to 14:09 while
preserving the selected History panel. Loading one more page expanded the displayed
execution cards from 12 to 24.

To isolate a list-read failure, the installed read-only projection child was paused
with `SIGSTOP`, guarded by zero active Jobs and zero pending admissions. Its runtime
ownership and process identity were checked first. A separate watchdog would resume
it within 30 seconds; explicit release resumed the same reader after 16.832 seconds.
This was one functional fault injection using the existing read deadlines, not a
duration-based stability test. No app/helper/runtime restart, Job cancellation or
re-execution, authentication/configuration edit, or test-data mutation was used to
create or recover from the fault.

A menu refresh during that pause showed the generic list-read notice and **Reload
list** (`다시 불러오기`), with no helper-reconnect button. All 24 displayed execution
cards, the selected panel and last-confirmed minute (14:09) survived. The menu
correctly needed attention while the projection was stale. After resuming the
reader, the service indicator became healthy while the list failure notice remained.
Clicking **Reload list** cleared that notice and advanced the minute to 14:11,
preserving the same 24 cards and selected panel. Before/after health checks confirmed
the same runtime and reader, bridge/tunnel connected, reader ready and no Jobs or
pending admissions. [Sanitized observation receipt](installed-ui.json).

This installed check covers local retained-screen recovery. First-load failure,
remote failure/recovery, exact-detail retention, bounded requests and late responses
remain separately evidenced by the production-model fixtures in the
[#264 audit](../issue-264-recovery-20261016/README.md). It does not claim an installed
remote-mode fault test or establish the cause of the user's uncaptured earlier
screen. Together these records complete #264's scoped UI acceptance.

## Remaining #242 acceptance boundaries

Operating completion-notification delivery remains unverified. Installed timer/topic
request rates, SQL lock waiting and physical I/O costs were not measured by these
RPC/UI checks. The earlier complete Node gate still has its eight independently
reproduced baseline failures; its receipt is preserved in #266. This audit changes
documentation only and does not reclassify that gate.

Keep #242 open for its remaining acceptance evidence. Historical operating HTTP
502 causation remains unconfirmed in #262. The test-fixture SIGPIPE finding is
scoped to the native test harness.
