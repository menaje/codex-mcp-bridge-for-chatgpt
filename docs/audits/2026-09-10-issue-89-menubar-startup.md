# Issue #89 · compact menu and application startup

Implementation: `917363a`. The product remains version 0.3.0 in the development
stage. The change adds a compatible minor change fragment; it does not publish
a release or alter the product version.

## Behavior

The initial popover shows connection/account usage, three summary counts and
the existing footer controls. Selecting Running, Response required, Problems
or Work & Run History opens only that panel. Selecting it again collapses it;
closing the view resets selection. History retains current work followed by
terminal history and its failure/interruption labels. Problem actions remain
in the Problems panel, and background-process history remains accessible.

The summary is retained across filter requests. Generation checks fence late
responses and enrichment. Content measurements determine the popover height;
the detail scroll area is bounded by the view's actual top edge and owning
screen, leaving summary and footer outside the scroll area.

Each native AppModel has one stable launch request ID and launch timestamp.
The helper reconciles an earlier shutdown receipt before submitting that
intent. The serialized lifecycle coordinator coalesces pending/newer commands
and recovery cancellation/failure instead of replacing them. Helper-only
respawns respect completed stop/shutdown and cancelled/failed recovery. The
singleton lock uses the bundle identifier, preserving the production lock
name while allowing an isolated acceptance bundle to coexist.

## Automated checks

| Check | Result |
| --- | --- |
| `npm run validate:affected -- --base origin/dev` | Passed: 944 Node tests in 77 files; 140 Swift tests with two opt-in live tests skipped and no failures. |
| App Server compatibility | CLI 0.153.3 matched 416 JSON and 827 TypeScript schema files. |
| Native localization | 720 strings validated and compiled in nine languages. |
| Strict standalone TypeScript check of both new acceptance scripts | Passed. |
| `git diff --check` | Passed. |

The first concurrent validation, while another native fixture was compiling,
had 19 timeout/timing failures in four existing Node test files. Those four
files subsequently passed all 301 tests with one worker. The final complete
run then passed all 944 tests with the unchanged four-worker configuration
in 108.07 seconds. No timeout assertions or test configuration were weakened.

New native socket tests cover panel switching/collapse/reset, retained summary,
late responses, height bounds, one launch request per app instance, coalesced
operation replies and stable retry identity. Lifecycle regression tests cover
previous-shutdown recovery, helper-only respawn, duplicate starts, newer manual
stop, pending reservations and recovery cancellation/failure. Existing remote,
setup, history, response and problem-action checks remain in the full suites.

## Native view acceptance

Run `node --import tsx scripts/native-menubar-acceptance.ts` with a fresh
temporary directory, then open the returned application using native UI
automation. The harness builds the production DashboardPopoverView and
AppModel with real local socket clients and synthetic workload responses.
It constructs a MenuBarExtra and also shows the same view in an inspectable
native window. The observations below were made in that window; menu-bar icon
attachment itself was not driven by the automation.

- Compact initial and reopened view: usage, counts and footer; no detail or
  empty-list section. Hiding/showing the view reset a selected panel.
- Running, response and problem selection replaced the displayed section;
  accessibility exposed the selected state. Repeated history selection
  collapsed the view and shrank the actual window.
- History showed current work before terminal history, including the failed
  status, without a separate problem section. Problem recheck returned its
  visible completion message through the existing action path.
- A refresh changing Running from 1 to 24 retained History selection. A long
  list scrolled through task 24 while usage/counts and footer remained visible.
- A zero Response required count remained clickable and showed its empty
  message only after selection. Dark appearance preserved selection contrast.
- An intentionally timed-out detail request kept the summary and selected
  panel, exposed retry, and recovered when the fixture delay was removed.

This is native view/action evidence with synthetic work, not a real task
execution or live Tunnel connectivity check.

## Native process acceptance

`node --import tsx scripts/native-startup-acceptance.ts` runs the unmodified
production application entry point and built helper in a separate bundle and
private configuration. The launcher/Tunnel/workload and CLI are synthetic.
It verifies first launch, duplicate application launch, graceful shutdown with
the native completion receipt, relaunch after that receipt, exactly one new
runtime, and manual stop remaining stopped while the same app continues
polling. Both native app processes exit normally through the production
lifecycle handoff. The script prints a structured report and cleans only its
own process groups and synthetic runtime processes.

The final isolated process run passed with runtime build
`917363a4a745:6f0b979b4158`. Its report is committed as
`issue-89-native-startup.json`.

## Installed application and real Tunnel

`npm run macos:bundle` passed, including strict native tests, the release-mode
arm64 build, localization compilation, packaged SQLite loading and ad-hoc
signature validation. The installed build was changed from
`535e264da4ca:38cb8ce3a4d3` to `917363a4a745:6f0b979b4158` using that artifact.
The previous bundle was retained locally for rollback. No product version,
tag or public release was created.

Before shutdown, the real runtime reported zero active jobs, pending
admissions/interactions, memory-only threads and background processes, with
background process state confirmed. The ordinary graceful lifecycle request
let the native app shut down the server, helper LaunchAgent and app, then
write its completed receipt. No force-stop path was used.

After installation, opening only the application started the actual local
server and Secure MCP Tunnel, without opening the menu or submitting a manual
start request. The previous shutdown record became completed; the latest
request contained the new application's launch timestamp. There was one
native app process and one managed runtime. Readiness was observed at
10:05:09 KST with Tunnel doctor passed and its connection established.

The private `.env` bytes matched the pre-update digest, and the retained
SQLite state passed `integrity_check`. The local evidence contains no API
key, Tunnel ID, account identity or conversation contents.

The updated installed app was then normally shut down at 10:06:10 KST and
opened again. The previous receipt was completed and the actual server/Tunnel
were automatically ready at 10:07:45 KST with a new runtime PID. The app was
left running in that healthy state. These two installed-app cycles are
recorded in `issue-89-installed-startup.json`.
