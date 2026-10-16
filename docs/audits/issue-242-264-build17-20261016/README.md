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

## Remaining acceptance boundaries

The updated accessory app could not be selected by the automation interface
(timeout). Finder accessibility worked; the screenshot interface separately
reported a capture failure. Installed menu interaction, retained-screen recovery
through an actual observation failure, and operating completion-notification
delivery remain unverified. The independently clicked fixture app and local/
remote recovery tests remain documented in the [#264 audit](../issue-264-recovery-20261016/README.md).

Installed timer/topic request rates, SQL lock waiting and physical I/O costs were
not measured by this RPC sample. The earlier complete Node gate still has its
eight independently reproduced baseline failures; its receipt is preserved in
#266. This audit changes documentation only and does not reclassify that gate.

Keep #242 and #264 open for their remaining acceptance evidence. Historical
operating HTTP 502 causation remains unconfirmed in #262. The test-fixture SIGPIPE
finding is scoped to the native test harness.
