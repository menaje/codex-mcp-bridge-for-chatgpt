# Issue 38 ChatGPT live acceptance smoke

Captured: 2026-08-28

Client: authenticated ChatGPT Work conversation

Bridge build under test: `2624e934ac286c7921e2019a4f801ef60ceec77a`

Scope: post-fix host acceptance for issues 38 and 37. Conversation, Activity,
Agent, Job, request, widget, and local-path identifiers are intentionally
omitted.

## Environment

The committed bridge was rebuilt after the input-contract fix, restarted in
secure mode, and verified healthy before ChatGPT testing. The build reported a
clean source tree and build identity `2624e934ac28:32d7b91e39ee`. ChatGPT's
Developer-mode plugin was then refreshed. The current generation-11 Activity
resource mounted at:

`ui://codex-mcp-bridge/activity/e381833d1c75.html`

## Discovery and input-contract acceptance

ChatGPT's actual plugin-management discovery view exposed 19 tools, including
9 model-visible tools. The discovered input schemas had these properties:

- every root object was closed;
- no named nested object remained open;
- every model-visible `const` or `enum` literal had an explicit primitive type;
- the dynamic project alternatives were typed string constants;
- the exact-Job status variants required `kind + id`, and the waiting variant
  additionally required `waitFor` while keeping `waitMs` optional;
- interaction answers retained the three-property upper bound.

This confirms the corrected input contracts survived the ChatGPT connector's
real discovery projection, not only local JSON Schema and TypeScript checks.

## Foreground answer delivery

ChatGPT called one new foreground `codex_task`. The completed structured answer
was read directly by GPT and reproduced exactly in its final response:

```text
ISSUE38_FG_2624E93_OK
SECTION_A: structured answer delivered
SECTION_B: multi-section body preserved
SECTION_C: no files changed
```

No status-recovery call or reconstruction Job was used.

## Background exact-Job delivery

ChatGPT reused the same Activity and Agent, called one background `codex_task`,
then called `codex_status` once for that exact Job with `waitFor: terminal` and
`waitMs: 55000`. GPT read and reproduced the exact Job item's structured answer:

```text
ISSUE38_BG_2624E93_OK
SECTION_D: exact job status answer delivered
SECTION_E: background body preserved
SECTION_F: no files changed
```

No additional recovery Job was created.

## Conversation re-entry and retained resources

The new smoke conversation was left and re-entered in the same tab, then opened
cold in a second tab. The Activity iframes remounted and recovered through
app-private `codex_activity_snapshot` calls. The older mounted card became a
readable superseded snapshot while the newest card retained live ownership.

The original conversation that exposed issue 38 was also opened cold. Its
retained Settings resource and nine retained Activity resources resolved with
no missing-template failure. All nine Activity cards recovered through
`codex_activity_snapshot`; the visible retained card rendered the Activity feed
and completed work instead of a blank or error state.

In both real-host checks, ChatGPT replayed the original private bootstrap. The
missing-private-bootstrap condition therefore did not occur, so
`codex_activity_rehydrate` and the historical-read-only-to-explicit-live
promotion path were not selected. This is a host-branch limitation of the live
probe, not a claimed pass for an unobserved branch. The missing-bootstrap branch
remains covered by the deterministic issue-37 acceptance evidence.

## Result

- Issue 38 foreground structured answer: **PASS**
- Issue 38 background exact-Job structured answer: **PASS**
- ChatGPT-discovered input schemas: **PASS**
- Current-host conversation re-entry with private bootstrap replay: **PASS**
- Retained pre-fix resource resolution and Activity rendering: **PASS**
- Missing-private-bootstrap historical branch in this real host run: **NOT
  APPLICABLE / NOT OBSERVED**

No issue-37 regression was found. The real-host behavior observed here is the
automatic private-bootstrap/snapshot path documented for hosts that preserve
that metadata.
