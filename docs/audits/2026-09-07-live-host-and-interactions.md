# Live host and interaction acceptance · 2026-09-07

This follow-up to [CLI management acceptance](2026-09-07-cli-management-acceptance.md)
executes the live paths previously left open in #60. Work started from `578fa62`
on `dev`. No application, helper or tunnel was replaced, no release was published,
and no deployment was performed.

## Authenticated App Server interactions

Run `npx tsx scripts/check-live-app-server-interactions.ts --run-authenticated /absolute/path/to/codex`.
It uses the existing ChatGPT login in a disposable private Codex home and an empty
working folder, with no API-key fallback. All temporary authentication copies and
synthetic thread history are removed in `finally`.

| Installed executable | Approval accepted | Approval cancelled | Input answered |
| --- | --- | --- | --- |
| App-bundled CLI 0.153.4 | pass | pass | pass |
| Terminal CLI 0.153.3 | pass | pass | pass |
| Fresh managed CLI 0.153.4, isolated installation | pass | pass | pass |

The actual subprocess requested approval for a synthetic `printf` command. The
accepted request completed; the cancelled request did not create its marker file.
The actual `request_user_input` question was answered by exact interaction/question
ID, and the completed turn reflected the selected answer. Each synthetic thread
was archived. The final app-CLI run also verified the harness's exact-command and
working-directory allowlist before it responded to an approval.

`default_mode_request_user_input` is an installed-CLI feature flag, disabled by
default in these executables. The harness enables it only in its temporary home.
This does not enable the feature in the user's settings or promise availability
in every CLI mode. These CLI command approvals advertise cancellation, not the
adapter's optional `decline` choice; attempting the unadvertised decision was
correctly rejected. File-change and additional-permission variants retain their
deterministic contract tests; they were not independently elicited in this run.

## Defect found by running the checks

Closing the pool while an approval response was pending caused an unhandled
`process stdin is unavailable` rejection. The handler attempted a response after
the child exited, then attempted an error response through the same closed stream.
Node terminated the entire acceptance process. This was a transport defect, not
a failed model assertion that should bring down the host.

The transport now ignores inbound requests and late handler settlements when its
connection is closing, exited or unwritable. Existing pending requests still fail
through normal process supervision. Two new reproduction cases demonstrated the
unhandled failures before the fix; four final cases cover handler resolution and
rejection after both explicit shutdown and child-process exit.

- Targeted transport/App Server suite: **43 passed**.
- Full `npm run check`: **678 passed in 55 files**, including build and release checks.
- `npm run test:continuity`: **13 passed** across transport, retired-backend handoff,
  and process/thread restart stages.

## Real ChatGPT host

The user's existing in-app browser session and connected bridge plugin were used.
The already-running local test app was `0.3.0-build6` (embedded build
`5435ff47d744:925a6c1dbec7`), using managed CLI 0.153.4
through `codex app-server --listen stdio://`. Its packaged `appServerUpstream.js`,
`scopeResolver.js` and `config.js` were byte-identical to the current build. The
new transport fix was exercised locally, not installed into that running app.

| Host operation | Observed result |
| --- | --- |
| Plugin discovery and tool call | pass after switching from Instant to a reasoning mode; Instant made no tool call |
| New work without a project selector | expected `PROJECT_REQUIRED` rejection; no work admitted |
| Exact registered-project lookup and new synthetic task | pass; completed with the requested marker, no requested file/tool work |
| Automatic compact card for foreground work | expected visibility-policy rejection; saved background-only policy preserved |
| Explicit full-history Activity card | pass; retained synthetic task and account usage rendered |
| Page reload | initial host `Failed to fetch template`; one host retry restored the same Activity |
| Mounted card refresh after recovery | pass; the same completed task remained visible |
| New independent ChatGPT conversation | pass for isolation behavior; `codex_status({})` returned host-metadata scope and zero Activity/Agent/Job counts |
| Follow-up execution from ChatGPT | **blocked by ChatGPT's automatic approval review before bridge admission** |
| Desktop native ChatGPT application | **blocked by computer-use tool access restrictions** |

The safe synthetic Job is `d31b09c2-9b1d-4870-81c6-540db9edbf14`, Activity
`10727f01-20c4-489b-ab65-523ea11a0b09`, opaque scope
`7c344b29-6e61-8b8b-a64b-a6ec1dea1069`. A read-only SQLite query confirmed this
association. Raw host session/subject/organization values, private conversation
URLs and project paths are deliberately omitted from this public report.
The read-only overview intentionally exposes scope source rather than its opaque
identifier, so a second scope UUID and optional subject/organization presence were
not captured. This is behavioral isolation evidence, not the entire #9 identity
matrix. Card refresh advanced its displayed update time from 17:20 to 17:24 KST
while preserving the same completed synthetic task.

The blocked follow-up displayed “OpenAI의 안전 검사에서 이 도구 요청을 차단했습니다.
전송하는 항목을 재차 확인하세요.” No more specific reason was supplied. It was not
retried through another route. Authenticated continuation remains independently
proven by the previous live CLI checks; the complete ChatGPT surface/continuation
matrix remains in #9 and is not declared passed here.

Together with the prior migration, durable-continuation, steering, interruption
and archive evidence, these results cover #60's remaining live connection and
approval/input acceptance. They do not close the broader host UI or release issues.

## Native operational UI

`npx tsx scripts/native-operational-acceptance.ts /tmp/bridge-operations-0907`
builds a separate test application under ignored `macos/build/acceptance` output.
Production `AppModel`, Dashboard, Settings and notification delivery are compiled
unchanged with strict concurrency and warnings-as-errors. Only the entry point
and socket data are fixtures. The notification grace period can be advanced
using synthetic observation timestamps; this is not a physical sleep/wake test.

Observed on macOS 26.6.2 / arm64:

- Real native Dashboard: healthy, transient checking and aged action-required
  states displayed distinctly. The accessibility tree exposed “Codex 브리지 정상”,
  “Codex 브리지 상태 확인 중” and “Codex 브리지 확인 필요”, plus the recovery button.
- Light and dark appearance rendered without overlapping labels or controls.
- The bundle initially placed under `/tmp` received `UNErrorDomain Code=1` for
  notification authorization. The build location was moved into the repository's
  ignored output while private socket/state files stayed under `/tmp`.
- Actual system notification approval requires a user click: computer use refuses
  access to `com.apple.UserNotificationCenter`. That final action was handed to
  the user; delivery and notification-click routing are **not marked passed**.
- VoiceOver was enabled in System Settings and its first-run dialog was completed.
  The control tool could not capture or verify the spoken result. Accessibility
  labels are verified, actual VoiceOver reading remains **not passed**. VoiceOver
  was returned to its original off state, and its utility and temporary text probe
  were closed. [Apple's reading/clipboard commands](https://support.apple.com/en-gb/guide/voiceover/vo2725/mac)
  were consulted for the attempted verification.

#15 and #44 retain their unverified system interaction and recovery requirements.
The Intel host's read-only SSH probe failed host-key verification; trust checks
were not disabled. Intel physical acceptance and the no-deployment release gates
remain open under #54, #52, #53 and #11.
