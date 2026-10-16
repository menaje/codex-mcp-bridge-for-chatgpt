# Issue #246 installed startup acceptance

Status: **HOLD — actual reboot/login and initial network delay are pending.**

PR #250 integrated the startup recovery implementation into `dev` as
`704020b9aa7c9e728e225a14e9921357364dbd2e`. This follow-up repairs acceptance
fixtures and records current checks; it does not change production startup code.
The installed application is 0.4.1, build 17,
`0d26c7f14353:41d00390ea3a`. The startup source comparison is recorded separately
and does not assert whole-artifact identity with the current checkout.

## Current functional evidence

| Check | Result and scope |
| --- | --- |
| Loaded helper delayed by a real 90 seconds | PASS, 90.067 s. Production native bootstrap with fake launchctl/RPC; no extra service replacement. |
| Native application entry point, actual helper delayed by 90 seconds | PASS, final run 94.717 s to automatic readiness (earlier valid run 91.748 s). Real native application/helper, synthetic launcher/Tunnel/CLI; no menu input. Duplicate launch caused no second runtime; shutdown/relaunch and explicit stop passed. |
| Startup/lifecycle Node checks | 161 passing cases in seven files across separate invocations, including the final 24 supervisor and 10 lifecycle-recovery cases after all fixture corrections. The 55 helper cases also passed with the corrected launcher. Original 61-second reservation case was included without changing its duration. |
| Acceptance observer | Fourteen fixture tests passed after the PR #271 review corrections, including shortened budgets, runtime replacement with unchanged build metadata, and prior-boot terminal records. These are validator tests, not an OS reboot. |
| Fast gate | PASS with the existing CLI 0.153.3; 416 JSON and 827 TypeScript schema files. The user's selected CLI was not changed. |
| Installed login configuration | System Settings showed the application under Open at Login. Existing helper LaunchAgent has RunAtLoad and KeepAlive enabled. Settings were read, not changed. |
| Actual installed reboot/network acceptance | NOT RUN. The current OS boot predates the fix. Live Jobs and a background process were observed; the no-work preflight refused to arm the test. |

The first supervisor run inadvertently inspected a developer's default profile
(schema 27, current schema 32), which correctly selected the protected legacy
migration path. It was not an initial-start recovery test. The fixture now pins
its own state database; all 24 intended startup cases then passed.

Broader execution also exposed an inconsistent fixture: an injected HTTP
startup failure still advertised a connected Tunnel. The surviving socket could
therefore race the launcher's exit and satisfy readiness in the fixture. Failed
attempts now report an unconnected Tunnel, matching the production launcher's
HTTP-before-Tunnel ordering. No production deadline or retry policy was changed.
Plain readiness snapshots also arrived before launcher exit and could trigger
faults intended for cleanup. Those stimuli now target inspection/drain requests;
the existing targeted-drain assertion still rejects snapshot-only cleanup.

The default `npm run check` completed with 2,020 passing, 34 failing and one
skipped test, before the last fixture corrections. A serial replay of the seven
additional failing files passed 110 cases and failed six. The two startup cases
were resolved by the fixture boundary correction above; the final startup and
recovery invocation passed all 34 cases. Two unchanged delivery cases passed a
separate selected replay. The remaining experiment-retirement and bounded
retention cases also failed in a clean, unchanged `60f7d774` baseline worktree.
Eight other failures had already been independently reproduced on the earlier
baseline in the #242 audit. `regression-boundary.json` retains the case mapping.
These observations do not relabel the default full-suite gate as passing, and
no unrelated test, timeout, permission check, or production behavior was changed
to make it pass. The private baseline worktree was removed after preserving its
receipts and verifying clean state and no process users.

The old native acceptance fixture omitted `state-migrations.json`, so the copied
helper could not import its dependencies. It also observed readiness for only
30 seconds despite the production 150-second helper/300-second initial-start
budgets. Both errors are corrected. The opt-in cold scenario preserves an actual
90-second delay and asserts elapsed time and its delay marker. An intermediate
wrapper matched only the first argument and missed Node flags; its 2.447-second
run is explicitly excluded from cold-start evidence. The corrected run above
matched all arguments and actually waited 91.748 seconds. Original private
failure/intermediate records are retained.

No real Job, authentication change, product restart, network interruption, or
OS reboot was performed by these isolated checks. The observed installed warm
restart is not counted as reboot acceptance. Historical incident evidence does
not establish a particular CPU, disk, database, or module-loading root cause.

## PR #271 review corrections

Four review findings arrived after PR #271 was merged. The inherited current
and legacy state-database environment variables could override the private
`.env` entry. The native fixture now overrides both variables in its spawned
environment; the in-process supervisor fixture uses temporary environment
overrides and restores them after teardown. Two regression cases reproduced
external database access before the fix and now pass with untouched canary files.

The observer now requires `deadlineAt - startedAt == 300000`, so a 30-second
budget cannot pass by becoming ready in 20 seconds. It hashes the complete
installed `Contents/Resources/Runtime` file tree, including JavaScript, scripts,
dependencies and metadata, before and after observation. Paths, entry types,
file bytes and internal file-symlink targets contribute to the digest; external
or directory symlinks are rejected. Build metadata alone cannot establish runtime
identity. A failed/cancelled lifecycle ends observation only when its startup
timestamp belongs to the current OS boot; older or unidentifiable records leave
time for the login application's fresh automatic intent.

The review follow-up passed 14 observer tests and 36 supervisor/recovery tests,
including both environment-variable regressions. `npm run build` also passed.
The native application/helper scenario passed again with both inherited database
paths set to external canaries: the real 90-second helper delay reached readiness
in 94.330 seconds, both canaries stayed unchanged with no sidecar files, and the
existing duplicate-launch, shutdown/relaunch and stop checks passed. Its launcher,
Tunnel, workload and CLI remain synthetic. `review-followup.json` records the
review mapping and verification receipts.
The previously recorded full-suite failure remains a failure; these targeted
checks do not relabel that gate. The actual installed reboot/network check is
still deferred at the user's request, and #246 remains open.

## Final installed check

The one-shot `observe-next-boot.py` is a read-only test observer. It never
requests start, stop, repair, configuration, login registration, or network
changes. Its inputs and output directory remain private outside the repository.
It reads fixed health fields and local default-route presence, never environment
contents, credentials, prompts, Job text, raw error strings, or network addresses.

Before the human's reboot, obtain a fresh protection snapshot with no active
Jobs, admissions, interactions, protected memory-only threads, background
processes, or unknown protection state. Run `prepare PRIVATE_DIRECTORY`, then
install the staged one-shot observer as a separate test LaunchAgent. Its
RunAtLoad action must be `observe PRIVATE_DIRECTORY`, with no KeepAlive or
StartInterval. Preserve the product LaunchAgent unchanged. A preflight more than
ten minutes before the new OS boot cannot establish acceptance.

After the human has saved unrelated work, perform the actual installed test:

1. Make the network unavailable, reboot, and log in. Do not open the Bridge menu
   or request a manual start.
2. Restore the network after the initial offline startup has been observed.
   Let the original stage/attempt/absolute budgets run unchanged.
3. Collect the observer result and obtain the human's confirmation of the
   deliberate initial network delay and absence of a manual start.

Success requires a changed OS boot session, the same installed artifact, a fresh
no-work preflight, a completed automatic initial-start receipt within its
original, exactly 300-second budget and three-attempt limit, connected Bridge/Tunnel and
ready read service, and an observed absent-then-restored default route. Default
route presence alone is not Internet reachability; actual Tunnel connection is
also required. The observer stops at readiness/failure or after the existing
150+300-second observation envelope. It cannot convert a warm restart or a
network-ready-only run into this acceptance.

Remove only the test LaunchAgent after evidence collection, retaining the
private receipts. If startup fails, preserve fixed failure stage/category and
ownership evidence and investigate; do not close #246 or substitute a shortened
wait or arbitrary endurance run.
