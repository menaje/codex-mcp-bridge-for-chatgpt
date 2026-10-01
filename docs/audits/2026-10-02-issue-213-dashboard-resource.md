# Issue #213 — Dashboard resource deployment and Events design decision

Date: 2026-10-02 KST. Integration target: `dev`. Baseline: `1727980`.

## Result

Dashboard now has a new immutable resource URI,
**`ui://codex-mcp-bridge/dashboard/v3.html`**. The actual running Bridge's tool
descriptor and `resources/read` response both use v3, and its HTML matches the
generated file and compiled card byte for byte. **ChatGPT iframe adoption is
still unverified**: the existing trial connection retained a temporary OAuth
authorization address that no longer resolves, and its tool refresh failed.

Events authorization is a separate, explicit design decision. The concrete
[restricted subscription-delegation proposal](../mcp-events-subscription-delegation.md)
was prepared for the user; no alternate authorization path is implemented or
enabled. The latest review requested a decision about the guarantee being
maintained. Approval for that specific delegation remains pending.

No new A, B, native subscription or polling automation was created in this
work. The isolated database still has **two original A Jobs and zero event
subscriptions**. The successful fresh A still has zero approved followups.

## Card correction

The [official UI guide](https://developers.openai.com/plugins/build/chatgpt-ui)
uses the resource URI as a cache key and requires a new URI for incompatible
HTML/JavaScript/CSS changes. Generation 37's originating-connection result
handoff changes the former card's routing behavior and adds `codex_status` as
a dependency; its unchanged v2 URI did not invalidate that cache.

The source of the version change is `ui-release-catalog.json`, followed by the
normal release/resource generator. Both `_meta.ui.resourceUri` and its
`openai/outputTemplate` alias are updated by the existing generated constants.
The actual HTTP test checks every Dashboard presenter, the current resource
and rejection of the superseded v2 URI. Settings retains its current v3 URI.
Generation 37 and the existing result-handoff behavior are preserved.

Dashboard startup also sets non-visible `data-card-resource-uri` and
`data-card-contract-generation` attributes. These allow a mounted iframe to
show that its script executed, without adding implementation details to the
user flow. A current file on disk alone is not that evidence.

Runtime comparison found an additional byte difference: the source renderer
spelled Unicode surrogate limits as decimal numbers, while the compiled helper
retained hexadecimal literals and a numeric separator. Their values and
security checks were equivalent. The shared browser helper now uses identical
numeric spellings in both compiler paths. A regression test compares its
actual source-runner serialization with TypeScript-emitted serialization.
Both generated Settings and Dashboard HTML now equal their compiled constants.
This formatting correction changes no permissions or text-validation behavior.

## Actual runtime evidence and host limit

Selected sanitized evidence is in
[the deployment summary](2026-10-02-issue-213-dashboard-resource.json).

| Comparison | Observation |
| --- | --- |
| Running `tools/list` | `codex_dashboard` uses v3 in both metadata fields. |
| Running `resources/read` | v3; 217,538 UTF-8 bytes; SHA-256 `72a5473b45a3df5203a56b59c3c02ddb478cc0eafe6dddfbba734bb3a3c8a98a`; generation 37; new result handoff; former hardcoded routing absent. |
| Generated and packaged HTML | Same SHA-256 and bytes as the compiled resource and running response. |
| Existing ChatGPT connection | Tool refresh reports “앱을 업데이트할 수 없습니다. 다시 시도하세요”; reconnect follows the previous unavailable authorization origin. |
| Existing ChatGPT conversation | Retained; no mounted Dashboard iframe at the observation. v3 startup markers have not been observed there. |

The runtime reads above used the real running HTTP handlers with a **task-only
locally signed token valid for 60 seconds**, kept only in memory. They called
only `tools/list` and `resources/read` on loopback. They are not a successful
OpenAI login, ChatGPT tool refresh or host iframe acceptance test. No login
grant, result read, Job, callback or subscription was manufactured to obtain
that evidence. An initial diagnostic resource request omitted `MCP-Name` and
was rejected with HTTP 400; the protocol-correct request then succeeded.

The previous task-owned trial services were no longer running. Only this
trial's authorization and product services were restored. A new temporary
HTTPS issuer was obtained because the former address was unavailable. The
same private Tunnel resource, enrolled operator, client registration, signing
and installation keys, fixture-only roots and isolated database were retained.
The new issuer nevertheless produces a **different OAuth principal**; old Job
ownership and approvals were not rewritten. The original trial app still
retains its previous authorization endpoint, so the restored service is not
claimed to be an authenticated continuation of that account connection.

Restoring an applicable host connection and observing the real v3 iframe
remains a deployment gate. It must not be described as a newly observed
Events failure, a resource-cache diagnosis already proven on the host, or an
excuse to make another A. No ordinary operational connection was changed.

## Validation

- Initial card/release/HTTP focus: **46 passed**.
- Final byte-parity/text-integrity/HTTP focus: **29 passed**.
- Final affected validation passed: **115 Node files / 1,213 tests** and
  **216 Swift tests, 2 skipped, zero failures**. TypeScript,
  release/localization and pinned CLI schema compatibility also passed.
- The first validation invocation used an incompatible globally installed
  CLI. Another attempt set a global CLI override that displaced four tests'
  intentional fixture selections. Using a task-only PATH shim for the pinned
  **0.153.3** schema check resolved that invocation error; fixture selections
  and global installations were not changed.

These are executed local checks, not independent GitHub CI. No actual Events
callback, event-triggered GPT result read or approved B was demonstrated.

## Remaining work and lifecycle

**#213 remains OPEN.** The proposed subscription reference would prove that the
original conversation delegated monitoring of an exact Job/event to the same
OAuth principal. It would not independently prove the callback's originating
conversation. Result reads and B admission retain their existing conversation
and review checks. The user's design choice is required before implementing
or enabling that alternate grant; an OpenAI inquiry remains prepared and
**unsent**.

Git integration is separate from live service use. The task branch/worktree
is retained while the private trial processes use its compiled modules and
the Events design decision is open. No Codex or ChatGPT conversation is
archived, renamed or deleted as cleanup.
