# Remaining issue review · 2026-09-07

Reviewed all seven open issues from `dev` baseline `6d735a6`: #9, #11, #15,
#44, #52, #53 and #54. Changes remain in development. No deployment, installed
application/runtime replacement, release branch, version bump, tag, or release
publication was performed.

## Defects reproduced and fixed

1. **Affected validation omitted deleted source and some renames.** Git's
   deletion-excluding filter allowed removed Node/Swift source to skip its
   checks. Rename destinations alone could classify moved source as docs;
   quoted/newline paths and a missing comparison base also lost evidence.
   NUL-delimited, non-rename-collapsing diffs now cover committed, indexed and
   working-tree changes plus untracked paths. A missing base fails explicitly.
   Six new real-Git reproduction cases failed before the fix and then passed.
2. **DMG payload comparison erased a native executable permission difference.**
   Removing code signatures temporarily enabled owner write access without
   restoring the original mode. Identical signed executable bytes with modes
   `0555` and `0755` incorrectly compared equal. Original permissions are now
   restored in `finally`. The regression builds a real signed executable and
   two real DMGs; self-comparison passes and the permission-only change fails.
3. **An empty full-history Activity card could not refresh.** The actual branch
   card showed refresh/enrichment failures with no Activity to mount. The
   server issued a live explicit presentation that required a nonexistent
   Activity proof. Empty history now starts as a scoped, read-only, non-owning
   full-history snapshot using the existing rehydration path. A regression
   demonstrates the old invalid presentation, refreshes the empty state, then
   discovers the first new Activity without creating extra work or ownership.
   Negative metadata checks reject a live watcher, a populated initial view,
   or an unrelated snapshot source using this narrow exception.

The empty-card fix changes the server's presentation choice, not the immutable
card HTML. In the in-app browser, the current production HTML with the old
empty presentation failed before dispatching a refresh; the corrected actual
MCP response refreshed successfully and advanced its displayed update time.
That local fixture used an in-memory server, temporary project root and an
execution-disabled upstream. It did not use the user's database or login.

## Validation and local packages

- Release-validation/payload targeted suite: **13 passed**, including the real
  Git repositories and real DMGs.
- Before the empty-card fix, affected validation passed **685 tests in 55
  files**, the build, 30-fragment release policy, and the installed CLI 0.153.3
  schema check (416 JSON / 827 TypeScript schema files).
- Final combined `npm run validate:affected`: **686 tests passed in 55 files**,
  including the empty-card regression and existing private-contract boundaries;
  build, 31-fragment release policy and installed-CLI schema checks also passed.
- Built a real arm64 development app/DMG, build 65, using the local packager.
  The packager checked native executable/module architecture, bundle structure
  and ad-hoc signatures. An x64 build request on this arm64 host failed early
  with the required native-host architecture mismatch.
- The complete development DMG passed mount/copy/signature-normalization/digest
  self-comparison: **4,145 files**, digest
  `bf86725beb3e8b0843f91ab37349ea27ba9fa4fa9b35f6649d5f323a3fea283c`.
  This is a pipeline smoke check, not an actual RC-to-stable promotion.
- The local npm archive contained 234 entries and no bundled skills. Installing
  that archive into a disposable directory, starting its installed CLI with an
  isolated Codex home/state and loopback port, reading `/healthz`, and sending
  SIGTERM all passed on Node 24.11.1. No model turn was started.

These package artifacts were built after the release-script fixes and before
the later empty-card fix. They establish packaging/runtime smoke evidence, not
a release candidate or physical clean-Mac acceptance of the final source.

## Real ChatGPT Web evidence

Used the existing ChatGPT login and connected bridge in the in-app browser,
including while native screen capture was unavailable. The running app remained
`0.3.0-build6`, embedded build `5435ff47d744:925a6c1dbec7`, managed CLI 0.153.4.
Its packaged `appServerUpstream.js`, `scopeResolver.js` and `tools.js` matched the
baseline code before this review's empty-card change.

| Conversation | Actual observation |
| --- | --- |
| Original A | Retained the previous successful synthetic Job and Activity |
| Independent new B | A new synthetic background Job completed with its requested marker; its full-history card displayed only its own Activity |
| Branch C | Created with ChatGPT's actual “new Chat” branch action; raw `codex_status({})` returned host-metadata scope with zero Activities, Agents and Jobs before and after B completed |
| Copied history in C | Old A text and its cached card remained in the copied transcript; this is historical content, not evidence that C can access A's live work |

Read-only SQLite queries confirmed A's opaque scope
`7c344b29-6e61-8b8b-a64b-a6ec1dea1069` and B's distinct opaque scope
`935c532e-6049-801d-9e51-b58bfba98886`. B's Activity is
`07041ba2-943a-46dd-8ba4-2d837f58f4eb`, Agent
`f9dbff3f-0bfa-486f-925d-546ef680e27b`, Job
`af1dbe81-d9c6-4420-8735-13b0319876d0`. B's mounted refresh request also carried
its own opaque scope. C's raw opaque identifier was not captured; its successful
zero-count status is behavioral isolation evidence, not full A/B/C certification.
Private conversation URLs, project paths, raw host identities and credentials
are omitted.

The B card initially encountered the host's `Failed to fetch template`; one
host retry restored it. A 390×844 viewport displayed the real card without
horizontal clipping and wrapped its job/model rows. The viewport was restored.
This proves narrow Web layout only, not native iOS or background/suspend behavior.

Later widget refreshes failed. Browser network inspection captured a real
`codex_activity_snapshot` request to `/backend-api/ecosystem/call_mcp`, HTTP 500,
body `{"detail":"Internal Server Error"}`. The request's scope matched B and
its arguments matched the current snapshot contract. Redacted helper diagnostics
also recorded tunnel dispatcher `client_internal` 502 failures for `tools/call`
and `initialize`, with `upstream_response_received: false`. The helper, launcher
and bridge processes remained running. Those logs do not establish the deeper
cause or uniquely correlate every widget failure; the existing snapshot remained
visible, but successful ongoing refresh/reconnection is **not claimed**.

Branch C's separate project lookup/new-work attempt was blocked by ChatGPT's
automatic approval review before bridge admission. The displayed reason was
“OpenAI의 안전 검사에서 이 도구 요청을 차단했습니다. 전송하는 항목을 재차 확인하세요.”
No more specific reason was supplied. No further execution attempt or alternate
route was used after observing the block. Later read-only status succeeded.

## Remaining issue decisions

| Issue | Review result and still-required evidence |
| --- | --- |
| #9 | New Web execution and A/B identity comparison advanced; empty-card defect fixed. C identity, cross-surface metadata, native iOS/Desktop, PiP/suspend and reliable refresh/reconnection remain open. |
| #11 | Rechecked current setup/recovery and App Server/task contracts; npm archive startup/shutdown passed. A real candidate's end-to-end runbook, clean Mac and release notes remain open. |
| #15 | Rechecked notification routing/state logic and prior acceptance evidence. Actual system notification click routing and VoiceOver speech remain unverified. |
| #44 | Rechecked native runtime/notification recovery requirements and prior fixture evidence. Physical sleep/wake, network recovery, helper-crash recovery and complete accessibility acceptance remain open. |
| #52 | Real local arm64 DMG and isolated npm archive checks advanced. Physical clean-Mac Gatekeeper/install/upgrade/state preservation and actual five-asset RC/stable publication remain open. |
| #53 | Fixed affected-validation omissions and permission normalization in promotion comparison. Candidate preparation/publication, physical Mac and candidate runbook gates remain open. |
| #54 | Real arm64 package and wrong-host architecture rejection passed. Native Intel Node/module/full-host/install/recovery checks and both-architecture release artifacts remain open. |

No whole issue is closed merely from a partial matrix or development artifact.
