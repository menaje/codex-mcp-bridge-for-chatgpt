# Issue #70 actual-host verification after unlock

The integrated candidate's Settings description, model catalog v2 and independent
question flow passed on authenticated ChatGPT Web through the in-app browser.
This is actual host evidence, not the earlier local renderer fixtures. Final
rollout is still pending: a separate execution probe was rejected by ChatGPT
before admission, and already loaded old conversation schemas remain cached.

## Candidate and preserved state

After the user unlocked the Mac, normal computer use succeeded. The issue #69
task was idle; this task was the sole operator. The previously validated bundle
`f5027b367309:21c885d97b57` was temporarily activated with the existing saved
configuration and database. Before switching, the runtime confirmed zero active
Jobs, pending admissions/interactions, memory-only threads and background
processes. A consistent database backup and the original bundle were retained.
Both replacement and restoration used graceful shutdown, without force or
database replacement.

The candidate was running with its tunnel connected. Its imported ChatGPT
inventory contained 29 names, including app-only compatibility descriptors.
The existing Settings card reopened with the saved project/model choices, and
the retained Activity resource `activity/f251773f7789.html` rendered fresh data
with an observed update at 13:01:13 KST. The host's plugin details warned about
the hidden legacy Activity presenter; the observed retained Activity nevertheless
rendered. This does not establish every old card or global overview control.

## Actual descriptions and catalog responses

The ChatGPT plugin detail screen showed this complete Settings description:

> Open an interactive card for configuring this ChatGPT-to-Codex bridge.

One existing schema-verification conversation and one new conversation both
retrieved that description and executed `codex_models({"contractVersion":"2"})`.
The expanded tool-call UI confirmed the exact input and response in both:
`selectionMode: automatic`, `source: app-server`, `stale: false`, `warning: null`,
and four allowed models. Luna had low/medium/high/xhigh/max; Sol, Terra and Astra
also had ultra. No Settings or Activity card was opened for either read-only
check, and no Codex work was admitted.

The older Settings conversation gave a different result even after plugin
Refresh, a fresh page load and an explicit request to rediscover current tools:
it still exposed the long Settings description, catalog input with only
`refresh`, no `project` status query, and Task `sandbox` input. That conversation
had already loaded the older definitions. A successful new lookup in a different
existing conversation therefore does not prove that all previously loaded
definitions were replaced. Do not repeatedly Refresh or send unsupported new
fields to such a cached contract; use a conversation that actually obtains the
current definitions. Retained card compatibility and model schema adoption are
separate checks.

## Independent question round trip

In the new conversation, GPT opened one ten-minute synthetic color question
using the standalone `question/04852baeb268.html` resource. The GPT response then
ended. The operator selected the test value in the card and submitted it there,
without sending that value in a chat prompt. The host started a follow-up, GPT
read the stored response through `codex_user_answer`, and its exact final answer
matched the submitted value. Persisted state was `answered`, notification
`requested`, with `consumedAt` present. No Settings card or Codex execution was
involved. This verifies question-answer follow-up after an ended GPT response;
it does not verify a Codex Job completion notification or wake mechanism.

## Execution rejection and operating boundary

A subsequent synthetic no-file Job was intended to exercise graceful restart
while work was active. Read-only project lookup succeeded, but ChatGPT rejected
the single `codex_task` request with:

> OpenAI의 안전 검사에서 이 도구 요청을 차단했습니다. 전송하는 항목을 재차 확인하세요.

The request supplied no permission overrides. It was not retried, altered to
evade review, or submitted through another route. Database comparison confirmed
zero new Jobs, Activities or Agents. The conditional restart observer found no
admitted probe and exited without requesting a restart. Active-work restart,
native/ChatGPT Job notifications, ended-response Job handoff and original live
approval/input/stop/process controls remain unverified for this candidate.

The original runtime `54296e0f0010-dirty:9af435da30f3` was restored and confirmed
running with a connected tunnel. A transient LaunchAgent bootstrap error was
handled by the repository's documented bounded retry behavior. Existing 476 Jobs,
204 Activities, 235 Agents, saved settings and project tables matched the backup.
Only the synthetic answered question was added by the UI test; it retains its
normal ten-minute expiration. ChatGPT discovery was also restored: the plugin
detail screen again showed the original 30 tools and original Settings
description. No final dev merge or operating rollout is claimed.

See [machine-readable evidence](issue-70-unlocked-host.json). The validated
product source and its 780-test/macOS results are unchanged by this documentation.
