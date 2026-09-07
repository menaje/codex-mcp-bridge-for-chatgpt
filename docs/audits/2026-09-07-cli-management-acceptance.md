# CLI management acceptance · 2026-09-07

This follow-up starts from development commit `956896c` and completes the CLI
management acceptance work in [#58](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/58).
It also supplies additional authenticated execution evidence for
[#60](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/60).
The product remains in development at `0.3.0`. No release, tag, DMG publication,
installed application replacement, or running user service update was performed.

## Defects reproduced and corrected

- A managed installation activated through a symlinked directory had a different
  selection ID from the same installation returned by discovery. Activation and
  inspection now use the physical executable identity while retaining the saved
  command and source. Existing saved identities are normalized on inspection.
- Discovery could offer a modified managed executable as selectable when its
  version output still matched. Discovery now shares the integrity checks used
  by execution. External installation ownership remains unchanged.
- An already downloaded update waiting for an active process could be downloaded
  again. Both the action snapshot and the state lock reject duplicate staging.
  The native pane disables update/skip during installation and hides the
  duplicate update row when that version is already staged.
- A missing or damaged recovery executable still caused a rollback button to be
  offered. The action snapshot now verifies the recovery installation, using
  cached integrity checks, before offering rollback.

Four regression cases failed before these changes and passed after them. A fifth
case covers an update request whose snapshot predates another request's staging.

## Native UI method and boundaries

`scripts/native-runtime-acceptance.ts` copies the production Swift sources into
a temporary package, replaces only the application entry point, and builds a
separately identified, ad-hoc signed test app. The actual
`CodexRuntimeSettingsPane`, `CodexRuntimeUpdateControls`, `AppModel`, Swift socket
client, Node helper request dispatcher, and `CodexRuntimeManager` are exercised.
Controls were clicked through macOS UI automation and their resulting native
accessibility trees were inspected. Light and dark screenshots of the pane were
also inspected. A successful build or a model-only snapshot was not counted as
UI acceptance.

The fixture supplies deterministic downloads, update-service failures, and
runtime usage leases in a private temporary directory. Its restart handler
releases its simulated usage lease and applies the pending selection. It never
launches a user Bridge, Tunnel, helper LaunchAgent, or Codex process. Account
queries are suppressed in this UI fixture. Real CLI installation and
authenticated execution were checked separately below.

“App restart” in the matrix means quitting and relaunching this native test app
while the separate fixture helper continues running. “Re-entry” means destroying
and recreating the production settings pane. This establishes the native CLI
management UI and saved-state contract, not clean-Mac installation, physical
sleep/wake, live job draining, Notification Center delivery, or VoiceOver speech.
Those broader acceptance gates remain in their own issues.

## Native state matrix

| State | Observed native behavior and action | Re-entry | App restart |
| --- | --- | --- | --- |
| Normal | Selected source/version and latest-version notice; same-version repair hidden; current installation marked selected | Passed | Passed |
| Missing | Selection/install guidance and Install button; explicit install starts progress | Passed | Passed |
| Damaged | Unavailable-installation guidance and same-version reinstall; reinstall restores availability; invalid recovery button absent | Passed | Passed |
| Update available | Exact installed→latest version; Update/Skip controls; update applies the new version | Passed | Passed |
| In progress | Download indicator and progress value persist; duplicate Update/Skip disabled; completed progress disappears | Passed | Passed |
| Pending application | Old version remains selected; pending guidance and Apply action; duplicate update row absent; Apply activates staged version | Passed | Passed |
| Failed | Previous installation remains selected; failure notice and Retry persist; successful retry removes the failure notice | Passed | Passed |
| Recovery available | Retained valid version and rollback control; clicking rollback changes the selected version | Passed | Passed |
| Cleanup available | Retained versions and reclaimable bytes; cleanup removes only the unprotected installation and then hides its button | Passed | Passed |

Additional native actions checked:

- Pinning the current version hides the update controls. Pin and notification
  preferences persist through pane re-entry and app restart.
- Skipping a version hides its update controls; clearing the skip restores them.
- A failed update lookup shows its own error and last-success time. It does not
  show an installation-failure Retry section. Checking again successfully clears
  the lookup error without replacing the installation.
- Selecting the terminal fixture hides managed update controls and explains
  external ownership. Explicit selection switches to the managed installation
  and back. Installation details disclose the selected path.
- Delete opens the confirmation explaining retained user data. Cancel preserves
  the installation. Confirming deletion of the generated fixture installation
  restores the missing/selection-required UI without automatic reinstallation.
- The native disclosure rows respond to clicks; the selected-installation
  checkmark, warning and progress controls appear in the accessibility tree.
  The dark CLI settings pane remains readable. VoiceOver speech and full-app
  keyboard navigation were not certified by this exercise.

## Real installation and authenticated App Server checks

The npm registry reported `0.153.4` as the latest stable CLI on this date. The
production `CodexRuntimeManager` and downloader installed that version into an
isolated directory and completed integrity, version and App Server connection
validation. It reported `source: bridge`, `available: true`, and
`operation.phase: complete`.

`scripts/check-live-app-server.ts --run-authenticated` then checked the following
executables with an existing ChatGPT login in a temporary Codex home:

| Executable source | Version | Verified stages |
| --- | --- | --- |
| Installed terminal CLI | 0.153.3 | Authentication, model catalog, new turn, process restart and exact durable continuation, steering, confirmed turn interruption, archive |
| Codex desktop app's embedded CLI | 0.153.4 | All the same stages |
| Newly downloaded bridge-managed stable CLI | 0.153.4 | All the same stages |

The durable continuation recalled a synthetic word from the first turn after the
App Server process was closed and recreated. Steering acknowledged the exact
active turn. Cancellation completed through `turn/interrupt` with an interrupted
terminal status, without requiring worker termination. Each check used only
synthetic prompts and an empty project folder; no project content, API key, or
account profile was logged. Temporary credential copies and test histories were
removed. The original login was not changed, and there was no API-key fallback.

These checks use the public [App Server lifecycle and control contract](https://learn.chatgpt.com/docs/app-server).
They do not claim live approval/input or every optional App Server capability.
The deterministic approval, input, permission, protocol-error and migration
regressions remain part of the existing full suite.

## Automated validation

- Final full Node suite: 55 files, 674 tests passed, including all 33
  runtime-manager tests and the stale-snapshot concurrency case.
- App Server schema baseline: 416 JSON and 827 TypeScript files match CLI 0.153.3.
- Full macOS suite: 96 discovered tests, 94 passed, two opt-in external companion
  checks skipped, no failures. Native localization checks passed.
- Continuity smoke: all 13 tests across the three transport/task/restart stages
  passed.
- npm payload inspection: neither native acceptance tooling nor the opt-in live
  checker is included in the 232-file package payload.

## Reproduction

After installing repository development dependencies, start the native fixture:

```sh
npx tsx scripts/native-runtime-acceptance.ts
```

Open the temporary app path printed by the script. Change its printed
`scenario.json` to select `missing`, `update`, `damaged`, `pending`, `failed`,
`recovery`, `cleanup`, or `external`, then click **상태 다시 읽기**. A new
`generation` integer creates a fresh instance of that scenario. `gate: "wait"`
pauses the fixture installer, `gate: "fail"` fails it, and
`gate: "check-fail"` fails update lookup. Remove the gate to let the next action
succeed. The fixture writes its actual action requests and most recent snapshot
beside the app. Stop the fixture process after closing the test app.

Authenticated checks are opt-in, use account quota, require an existing ChatGPT
file login, and accept one or more absolute CLI paths:

```sh
npx tsx scripts/check-live-app-server.ts --run-authenticated /absolute/path/to/codex
```

## Remaining open issues

| Issue | Remaining gate |
| --- | --- |
| #60 | Actual ChatGPT host smoke after the execution transition; authenticated approval/input behavior beyond the stages listed above is not certified here |
| #9 | Desktop/iOS/Web scope and card lifecycle matrix on the actual ChatGPT surfaces |
| #15 | Actual Notification Center click-through and VoiceOver speech |
| #44 | Physical sleep/wake, network interruption/recovery, and full-app accessibility acceptance |
| #54 | Actual Intel installation, Node/native-module host execution, upgrade and recovery evidence |
| #11, #52, #53 | Candidate artifacts, clean physical-Mac installation/upgrade/state preservation, candidate runbook checks and authorized publication |

Issue #58 can be completed independently of these release and broader host
certifications. None of the remaining gates is treated as passed by this report.
