# Non-release issue completion review · 2026-09-10

The open non-release issues were #9, #15, #44, #68, #79 and #80. This review
integrates the available implementation, updates the current evaluation and
setup instructions, and adds reproducible lifecycle evidence. Release issues
#11, #52 and #53 are excluded. Incomplete device acceptance remains open.

## Source and integration scope

The starting `dev` was `69d4c01e6c0a22450a5fb4b6605c938d9de8df89`. The integration
includes the #80 branch through `c7f1874` and the subsequent dashboard/history
and recovery work through `fd418cb12fde`. It retains the earlier commits and
their change fragments:

- Six-hour idle connection release, explicit app handoff, protected ongoing
  work, bounded event retention and migration, and per-Job token accounting.
- Current work separated from retained history, display-history settings,
  optional problem review, and automatic recovery bounded to the original
  foreground request and a durable incident attempt limit.
- Native notification SDK compatibility, dependency-lock completeness and
  narrowly scoped graphics-test handling from the #80 branch.

The initial changes in this review were documentation and
`scripts/check-launchd-lifecycle.ts` with its package command. Actual host
language testing then exposed a question-draft reload defect, which is fixed
in the standalone renderer and covered by a document-reload regression.
The evaluation now describes the 12 model-visible
tools, current cards, saved execution policy, history scope and separate
original approvals/user questions. Setup guidance uses the current dashboard
and settings. The old outstanding #69 input gate is replaced with its dated
user acceptance; historical failed attempts remain intact.

The installed app reported version 0.3.0 and build
`fd418cb12fde:78f6830b6cd7`. It was already installed when this review began.
The host was macOS 26.6.2 (25G83), with Node 24.11.1 and npm 11.6.2. The Web
tests used the actual signed-in ChatGPT site in the Codex in-app browser;
the browser build number was not exposed in the inspected UI. No app was
replaced and no tag, release or deployment was produced. Version 0.3.0 remains
in the development stage. A pull request to `dev` does not run the repository's
release workflow.

## Automated and launchd verification

| Check | Observed result |
| --- | --- |
| `npm run check` and final `npm test` | Build passed. The final complete Node run passed all 935 tests in 77 files in 111.97 seconds. |
| `npm run macos:check` | Strict Swift build passed; 134 total tests, 132 passed, two opt-in live tests skipped, zero failures. Localization validated 718 strings in nine languages. |
| `npm run app-server:compat:check` | CLI 0.153.3 matched 416 JSON and 827 TypeScript schema files. |
| `npx tsx scripts/output-contract-audit.ts --check` | Matched the committed output-contract baseline. |
| `npm run test:card-resilience-browser -- --built` | All 29 browser scenarios passed, including retained cards and recovery/error paths. |
| `npx tsx scripts/automatic-recovery-browser-regression.ts` | All 14 checks passed, including scope isolation, optional review, narrow widths, dark appearance and nine locales. |
| `npx tsx scripts/question-card-browser-regression.ts` | All eight current-card modes passed for source and `--built`; all six `--legacy` modes passed. Full reload, free text, re-entry, question isolation, invalid scope/revision/expiry and denied browser storage are covered. No Codex operation was invoked. |
| `npm run test:launchd-lifecycle` | All nine checks passed against the built production helper through real launchd. |
| Harness strict TypeScript and changed-file review | Strict standalone TypeScript check, local documentation links and `git diff --check` passed. |

The two native skips require an explicit live companion socket and a live
HTTPS pairing invitation. Browser checks use a simulated host and are not
actual ChatGPT delivery-fault or native accessibility evidence.

The initial integrated-source Node run passed all 935 tests in 104.81 seconds.
After updating setup documentation, a subsequent run passed 934 and failed
one assertion that still required the old Activity screenshot. That existing
assertion was updated to require the current dashboard asset. The final
complete 935-test run above passed; no Node test was skipped.

The launchd harness creates a unique temporary service and private state,
uses the production KeepAlive/throttle/exit-grace settings, and verifies:

1. A restart reservation and the same running process survive a real 61-second wait.
2. Cancelling the reservation preserves the running work.
3. SIGKILL triggers a launchd respawn that adopts the same process and intent,
   with no second launcher.
4. A completion event applies one restart and reaches bridge/tunnel readiness.
5. Bootout/bootstrap retains ongoing work and the helper-replacement intent.
6. A helper with a different build identity completes replacement only after readiness.
7. A shutdown completion receipt survives re-entry without starting a runtime.
8. A mode-switch completion receipt has the same non-autostart behavior.
9. The test service, processes, sockets and ownership lock are removed.

Only the helper and launchd are real in this test. Work admission, tunnel
responses, build identities and the native completion receipts are synthetic.
It does not exercise the installed app's controls, real model continuity,
actual connection-mode preferences, sleep/wake or physical networking.

Initial harness attempts exposed fixture defects: a one-shot status timestamp
became stale during the long wait and correctly triggered an ownership
refusal; indistinguishable build identities completed replacement earlier
than the assertion expected; and a copied helper bundle lacked its release
manifest. The fixture now refreshes its status, uses distinct identities and
copies that dependency. These were harness corrections, not product fixes.
The final nine-check run started at `2026-09-09T22:41:03.114Z` (September 10 KST)
and passed on the committed harness content.

## Actual ChatGPT Web observations

The test used an owned empty project and a single synthetic Codex Job without
file changes, shell commands or additional agents. Private identifiers were
compared locally; only relationships and outcomes are recorded here and in
the [sanitized result](2026-09-10-non-release-issue-completion.json).

| Case | Observation and evidence limit |
| --- | --- |
| Original conversation A | Project lookup and one Job completed with the expected synthetic output. No new Activity card appeared. |
| Re-entry A2 | Reopening the canonical conversation retained its result and question card. The new A2 question had the same stored scope as A. |
| Independent conversation B | A separate conversation had a different scope and zero Jobs while A had one. Both status calls reported `host-metadata` as the source. |
| Cross-scope answer request | B made one `codex_user_answer` call with A2's exact synthetic response reference; its input was inspected in the visible tool trace. GPT reported `ANSWER_UNAVAILABLE`, and no answer body appeared. The displayed error is model-reported, not a captured raw response body. |
| Answer in the original scope | A2 stored `Blue` and initiated a GPT follow-up. GPT interpreted the earlier open-only instruction narrowly and did not automatically read it. After an explicit follow-up, the visible answer-read call returned `Blue`. This is not counted as automatic answer-read success. |
| Cancellation and expiry | B's question reached `cancelled`; the older A question displayed its expired/unavailable state with no response controls. Cancellation initiated a follow-up, but a successful automatic read of the cancellation was not observed. |
| Branch C | Two attempts through the actual branch menu remained loading without a new branch tab. Re-entry succeeded, but no C identifier was obtained. E9-3 remains incomplete. |
| Network fault attempt | The tab's CDP capability rejected `Network.enable` while a browser document response was paused. No offline override was applied. No network failure/recovery pass is claimed. |
| Host language and fallback | ChatGPT changed from automatic Korean to English and then Czech. With the Bridge temporarily in automatic mode, the card displayed English and used English fallback under Czech. Both original language settings were restored. |
| Draft-loss reproduction | In both host language transitions the page reloaded and the pending selection returned to its empty option. The new local document-reload regression failed on the same selection loss before the fix. E9-6 is not marked complete. |
| Explicitly delegated cancellation read | The separate language-test question authorized the follow-up read in advance. Cancellation resumed GPT, which visibly called the answer-read tool and reported `cancelled` with no selection, without an additional user message. This is separate from the earlier A2/B observations. |

The observed follow-ups are ChatGPT conversation activity, not macOS system
notification delivery. A stored `notification: requested` value is not
treated as proof that GPT read the answer.

## Question-draft reload fix

The renderer previously preserved values only while re-rendering an existing
DOM. ChatGPT's actual language setting reloads the document, so its
host-context-change test did not cover that path. The revised browser check
failed before the fix with `Document reload lost the selected answer`.

The current standalone question card now writes unsubmitted form values to
the same tab's browser session storage on input/change. Restoration occurs
only after the authorized question read and requires matching scope,
revision, expiry and field shape. Other questions cannot inherit the draft;
submitted, cancelled and expired drafts are cleared. Expired entries are
pruned when reading stored drafts. Storage access/quota failures are caught
and leave the existing in-memory form functional. Values are not sent in
tool calls, tool output or model context until the user submits them.

The regression exercises an actual document reload, selected and free-text
answers, re-entry after visiting a different question, stale scope/revision/
expiry rejection, terminal cleanup and blocked storage. It continues to
exercise both host transports, missing host metadata, delivery denial,
uncertain delivery and a transient read failure. Retained immutable question
resources are preserved; a new current resource contains the fix. This is
local browser evidence. Deploying the updated renderer and repeating the
actual-host reload are outside this non-deployment run, so that part of E9-6
remains open.

All 172 pre-existing UI resource revisions retain their URI, digest, metadata
and HTML bytes. The new question URI is
`ui://codex-mcp-bridge/question/afdc0d76ab49.html`; other current card URIs are
unchanged. Package/UI metadata validation still reports version 0.3.0 in
development, with 63 active change fragments.

## Remaining issue acceptance

| Issue | Completed or newly strengthened | Still required |
| --- | --- | --- |
| #9 | E9-1 current evaluation rewrite; fresh Web A/B scope and A re-entry; actual language/fallback observations and a tested draft-reload fix. | Desktop/iOS comparison, branch C identity, full card display/lifecycle, physical connection recovery and actual-host confirmation of the new renderer. |
| #15 | Full native notification policy/regression suite rerun. | Actual notification arrival/click destination and actual VoiceOver operation. |
| #44 | Full native suite plus real launchd SIGKILL/adoption and cleanup evidence. | Physical sleep/network recovery, installed native recovery presentation, keyboard traversal, VoiceOver and remaining app appearance checks. |
| #68 | Actual current-card expiry, cancellation, submission, original-scope read and cross-scope boundary; the language-test cancellation was automatically read. Draft-reload defect fixed locally. | Actual delivery-denied, unsupported and uncertain-handoff states and their recovery controls; updated-renderer host regression. |
| #79 | Real launchd 61-second wait, cancellation, respawn, replacement and receipt recovery. | The complete operating-app path, native reservation display and actual final quit/mode actions. |
| #80 | Tested implementation included in the integration; earlier same-context round-trip evidence retained. | Actual native handoff interaction and Codex's external-use warning clearing. |

Computer Use denied access to Codex, ChatGPT Desktop and Notification Center
for safety reasons. Selecting the Bridge app timed out. These limits were
not bypassed with another UI channel. An iOS device was not available;
physical sleep/network transitions were not performed. Browser and
fixture evidence does not complete these acceptance conditions, so none of
the six issues is closed by this review.

## Cleanup and preservation

The owned test project was archived and then removed through the companion
settings API using the current registry revision. Its empty directory was
removed. The original four project registrations and ordinary Bridge
settings were compared before and after and were unchanged; registry
revision/timestamps naturally advanced. The completed synthetic Job remains
as ordinary history. Runtime inspection found no active Jobs, admissions,
interactions, background processes or unknown background ownership.

After the additional language test, ChatGPT's original automatic detection
and the Bridge's original Korean preference were restored. Ordinary Bridge
settings and project registrations matched the initial values again,
excluding revision/timestamp counters. The language question was cancelled
and read by GPT. No unanswered test question remains.

Every temporary launchd service was removed, and the passing harness also
removed its fixture directory. The installed helper was not restarted or
replaced. Raw scope IDs, response references, project paths, authentication
material and private conversation URLs are excluded from the committed
evidence.
