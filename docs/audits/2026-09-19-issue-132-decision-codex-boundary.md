# #132 Decision Card–Codex permission-boundary verification — 2026-09-19

## Conclusion

A production Decision Card was exercised in an actual ChatGPT Work
conversation while one read-only Codex Job had a current ordinary question.
Creating, submitting, and reading the card did not answer that question,
continue the Job, create another Activity/Agent/Job, or change the Job's
execution policy. GPT read the stored decision, refreshed the current input,
reported **답변 전송 대기**, and stopped. Only a later explicit user message
caused one `codex_answer` delivery; the original Job then completed with the
selected answer.

The deterministic regression covers the same boundary without relying on GPT
behavior. It keeps the pending interaction, sandbox, execution decision, access
strategy, Activity/Agent/Job counts, and upstream call count unchanged across
the complete card flow, then proves that only `codex_answer` dispatches the
answer.

This establishes one optional orchestration path for #127. It does not turn a
card into an approval surface, and it does not establish the user-effect
hypothesis tracked in #129.

## Implementation and contract changes

The model-visible server instructions, `codex_answer` descriptor,
`docs/gpt-questions.md`, and `docs/decision-cards.md` now state the same sequence:

1. read the current ordinary Codex question;
2. run the independent Decision Card flow only when it materially helps;
3. after card deliberation, refresh `codex_status` with `kind: "input"`;
4. use `codex_answer` only when the exact question remains current and the user
   separately wants the answer sent.

The contract explicitly says that card creation, submission, and result
retrieval cannot answer or continue a Job, change its sandbox or access
strategy, grant an approval, or start another turn.

Building the regression exposed a separate output-contract defect in this
required path. `codexInputSnapshot()` returned `nextActions` as strings while
the public `codex_status` output schema requires structured
`ModelNextAction` objects. The pending question itself was intact, but the
schema projection rejected the entire input read, preventing GPT from
rechecking it. The snapshot now projects every entry through `guidance(...)`;
the integration test reaches the real public output validator and would fail
if this regressed.

## Deterministic boundary regression

The integration test starts one held `codex_task`, assigns a live worker/turn,
and emits a current `rollout` question with two allowed labels. Before opening
the card it records the current question reference, Job sandbox and execution
decision, saved access strategy, exact Activity/Agent/Job counts, upstream call
count, and interaction-response count.

It then creates, submits, claims, accepts, and reads a production Decision Card
that selects staged rollout and records the condition **Documentation only; do
not change files.** The result must report `executionApproved: false`. A second
`codex_status` input read with the prior cursor must report `changed: false`,
remain active, and return the same question reference.

Before `codex_answer`, the test requires all of the following:

- the original pending interaction is byte-for-byte unchanged;
- sandbox remains `read-only`, approval policy sent upstream remains
  `on-request`, and the execution decision and saved access strategy are
  unchanged;
- Activity, Agent, and Job counts remain unchanged;
- no additional upstream Codex call was made; and
- no interaction response was dispatched.

Only the later explicit `codex_answer` may deliver the exact allowed label and
clear the pending interaction. Releasing the held upstream turn then completes
the same Job.

| Command | Result |
| --- | --- |
| `npx vitest run test/tools.test.ts test/questionOrchestration.test.ts --maxWorkers=1` | 2 files / 24 tests PASS |
| `npm test` | 88 files / 782 tests PASS |
| `npm run build` | TypeScript, localization, release manifest, and development-stage policy PASS |
| `npm run macos:bundle` | Signed bundle PASS; Swift 202 tests, 2 opt-in live tests skipped, 0 failures |

The signed production bundle was built from clean runtime commit
`2e5c357f79615a0cb683c435d15631eeda70dba9`, build ID
`2e5c357f7961:29815c9f3847`. Before replacement the helper reported zero active
Jobs and zero pending admissions. After replacement and after the final test
cleanup, the helper reported that exact build, zero active Jobs, zero pending
admissions, and connected Bridge and Tunnel states.

## Actual ChatGPT host setup

The test used a fresh ChatGPT Work conversation with only **Codex MCP Bridge
for ChatGPT** selected. The registered project was **아이디어**. GPT first read
the current project selector and model catalog, then admitted exactly one Job
using `gpt-5.6-luna` with medium reasoning.

The user's saved access strategy was temporarily narrowed from `always-full` to
`read-only` before this scenario. The admitted Job recorded sandbox
`read-only`. Its terminal execution evidence later confirmed approval policy
`on-request`, network access false, and zero writable roots. The task prompt
forbade file reads/writes, shell, network, browser, MCP, and permission requests;
none was requested.

The installed Codex CLI does not expose synchronous `request_user_input` in
default mode unless its `default_mode_request_user_input` feature is enabled.
An initial separate host run observed that unavailable result and created no
question. For the positive controlled scenario, the flag was temporarily
enabled, the runtime was restarted only after active Jobs and pending admissions
were both zero, and the same production bridge was used. After the scenario,
the flag was removed, the saved access strategy was restored to its original
`always-full` value, and the runtime was restarted again. The restored values,
exact build ID, and healthy connections were re-read; this test did not leave a
different permission or CLI-feature configuration behind.

## Actual-host sequence and state evidence

Codex asked the ordinary question **문서에는 어떤 배포 방식을 사용할까요?**
with staged and direct rollout choices. GPT read it through
`codex_status({query:{kind:"input"}})`, showed the exact meanings, stated that
it had not called `codex_answer`, and stopped. At this point the exact
conversation scope contained one Activity, one Agent, one running Job, one
pending `codex-question` interaction, and zero answer deliveries.

The next user turn requested a comparison card but explicitly withheld answer
dispatch. GPT opened a card containing a trade-off table, one rollout radio
group, and one editable documentation-condition field. The operator selected
**단계적 배포** and entered:

> 각 단계의 검증 결과와 롤백 기준을 문서화하되, 카드 제출만으로 파일을 변경하지 않는다.

The following timestamps are server records in Korea Standard Time:

| Event | Time |
| --- | --- |
| one Codex Job admitted | 20:49:40 |
| card decision stored | 20:51:30 |
| host accepted the same-conversation message | 20:51:33 |
| exact decision result offered to GPT | 20:51:42 |
| separate ordinary-question answer delivered | 20:53:35 |
| original Job completed | 20:53:39 |

Immediately after card result retrieval and before any answer dispatch, a
read-only database comparison showed:

| Boundary | Before card | After card result and input recheck |
| --- | --- | --- |
| Activity / Agent / Job | 1 / 1 / 1 | 1 / 1 / 1 |
| Job state | running | running |
| sandbox | read-only | read-only |
| execution-policy revision | 165 | 165 |
| pending ordinary interactions | 1 | 1 |
| ordinary-question deliveries | 0 | 0 |
| Job version | 5 | 5 |

The card row separately recorded `confirm`, `host-accepted`, one staged-rollout
selection, the exact documentation condition, and `resultOfferedAt`. The Job
still had the original `rollout` interaction. ChatGPT's next visible response
was exactly **답변 전송 대기**, providing host-level evidence that result reading
and question revalidation did not implicitly answer or continue the task.

Only after the user sent a separate **전송해** message did GPT refresh the
question, preserve the currently allowed label **단계적 배포 (Recommended)**,
and call `codex_answer`. The durable delivery table then contained one delivered
64-character question reference. The same Job completed with
`BOUNDARY_ANSWER_단계적 배포`; its final scope still contained exactly one
Activity, one Agent, and one Job, with zero pending interactions and one answer
delivery.

## Evidence boundary

- This is one controlled actual-host scenario, not a statistical claim about
  every model or prompt. Deterministic tests carry the invariant; the host run
  demonstrates that GPT followed it in one real conversation.
- The default-mode input feature was temporarily enabled solely to make the
  installed CLI emit the ordinary structured question. Its normal off state was
  restored. Availability without that flag is not claimed.
- The successful scenario had an ordinary user-input question and no approval
  request. Approval isolation is enforced by the public contract and automated
  test, but this host run did not intentionally create and reject a command or
  file approval.
- `resultOfferedAt` proves result delivery by the Bridge, while the visible
  **답변 전송 대기** and later completion marker are separate observations of
  GPT behavior. Neither is inferred from host acceptance alone.
- No private conversation/scope identifier, question reference, receipt,
  tunnel URL, project path, or credential is retained in this document.
