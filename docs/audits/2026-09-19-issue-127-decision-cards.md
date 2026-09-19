# #127 GPT–user decision card implementation and evaluation — 2026-09-19

Related issue: [#127](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/127)

Post-merge security remediation:
[CSS and CSP hardening record](2026-09-19-issue-127-css-hardening.md)

## Conclusion

The Bridge now has one project- and Job-independent GPT–user Decision resource.
`codex_decision` accepts free-form HTML, the server sanitizes and versions it,
and the trusted runtime collects only a derived semantic native-input contract.
An explicit user action stores the canonical decision before attempting a
same-conversation `ui/message`; the resumed GPT reads the exact record through
`codex_decision_result`. Card confirmation is explicitly not execution approval.

This audit establishes the implementation, security boundary, deterministic
browser behavior, and a repeatable evaluation protocol. It does **not** establish
that decision cards improve real-user comprehension or decision time. No
independent human participant study was run, so the product hypothesis remains
unconfirmed and must not be presented as a measured benefit.

## Implemented contract

- No registered project, Activity, Agent, Job, or Codex process is needed to
  create, render, submit, persist, deliver, or read a decision.
- The generated body is HTML rather than a block or questionnaire schema. The
  tested layouts are natural-language-only, comparison table plus inputs, and
  SVG/raster visual explanation plus inputs.
- Generated content is inert. Parser-based allowlists remove scripts, event
  handlers, navigation, frames, external media, SVG links, generated JavaScript,
  and resource-loading CSS. Inline declarations and SVG paint are parsed after
  comments and CSS escapes are normalized; exact local SVG `url(#id)` paint is
  the only retained URL form. The resource CSP declares no connect or resource
  domains. Static inline SVG and bounded raster `data:` images remain available.
- Every submitted control has a stable name and semantic label. Choices retain
  both stored values and the labels shown to the user. Numeric bounds and steps,
  text bounds, required confirmation fields, unknown fields, and injected
  options are checked again on the server.
- The trusted preview shows exactly what will be sent. Required fields constrain
  final confirmation but do not force a user to choose an option before asking
  for more explanation or deferring.
- Schema 24 stores immutable card versions, idempotent mutation requests,
  canonical submissions, revision chains, and distinct delivery evidence.
  Identical current double-clicks coalesce; `A → B → A` is three decisions, with
  the last two recording what they supersede.
- `stored`, `leased`, `host-rejected`, `host-accepted`, and
  `acceptance-unknown` are distinct. A definite rejection permits bounded
  explicit retry; uncertain acceptance never triggers automatic replay. A
  result offer records only that the server returned the decision, not what GPT
  later said.
- Every path verifies the authoritative conversation scope and exact card
  version. IDs, presentation references, and receipts are correlations, not
  bearer authority.

## Layout and visual inspection

The production Decision HTML was rendered in real Chromium at a 390 px mobile
viewport. The generated body and trusted controls had no horizontal body
overflow, clipped labels, broken images, or script errors in the three retained
inspection screenshots.

| Layout | Content exercised | Result |
| --- | --- | --- |
| Natural language | headings, explanation, explicit uncertainty, no generated inputs | explanation request stored and delivered; no invented questionnaire or empty preview |
| Comparison | table, select, range with `weeks`, checkbox, editable condition, comment | visible labels, selected option meaning, unit, condition, and comment matched the canonical result |
| Visual | labeled inline SVG bars, embedded raster confidence marker, required radio group | SVG and image rendered; defer succeeded with the required choice intentionally unanswered |

The screenshots and machine-readable run output are generated under the ignored
`output/playwright/issue-127-decision-card/` directory. They are local QA
artifacts, not packaged product files.

## Deterministic Chromium regression

[`scripts/issue-127-decision-card-regression.ts`](../../scripts/issue-127-decision-card-regression.ts)
uses the production sanitizer and production Decision resource in Chromium. Its
host fixture implements the standard MCP Apps JSON-RPC boundary rather than
calling runtime functions directly.

| Scenario | Boundary | Result |
| --- | --- | --- |
| prose explanation | no fields; explicit explanation intent | PASS |
| comparison confirmation | labels, value, unit, edit, comment, result offer | PASS |
| visual defer | SVG/raster and unanswered required choice | PASS |
| required confirmation | invalid final choice cannot submit | PASS |
| double click | one submission and one message | PASS |
| two mounted cards | semantic dedupe and one accepted delivery | PASS |
| modified resubmit | new sequence and supersedes link | PASS |
| explicit reject/retry | bounded second attempt | PASS |
| timeout | acceptance unknown; no automatic retry | PASS |
| teardown before send | lease released; decision remains stored | PASS |
| teardown during send | uncertain; no replay | PASS |
| stale version | no submit or message | PASS |

The malicious comparison fixture also includes a script, iframe, remote image,
event handler, external link, CSS-escaped resource-loading background, and an
escaped external SVG paint. The sanitized DOM contained none of them. The
initial endpoint counter was later found to use a different port from the two
escaped payload URLs, so that counter alone did not prove absence of browser
request attempts. The corrected regression starts the endpoint first, embeds
its assigned port in the payloads, attaches browser request and failed-request
observers before navigation, proves both observer and endpoint with one known
stylesheet request, and then records zero sanitized-card browser attempts,
failed requests, and server arrivals. See the linked post-merge hardening
record for the correction and evidence boundary.
Receipts and presentation proofs never appeared in visible card text.

Observed command:

```text
npm run test:issue-127-decision-card
Issue #127 decision card: 12/12 Chromium scenarios passed; detector control 1/1, sanitized leak attempts 0.
```

## Same-evidence evaluation

### Task and conditions

Both conditions use the same migration facts and the same decision task:

- staged transition: low downtime and checkpoint rollback;
- direct migration: medium downtime and full-restore rollback;
- the operator must choose a plan, set a maximum transition in weeks, decide
  whether to preserve the existing API, add a rollout condition, and optionally
  add a separate note.

The prose baseline presents those facts as ordinary paragraphs and asks the user
to compose a reply. The card condition presents the same facts in a comparison
table and exposes the five semantic response parts through labeled native
controls and the trusted confirmation preview.

### Sample and measurements

The evaluation sample is **zero independent human participants**. It consists of
an automated Chromium task run plus implementation-time visual inspection by the
operator. Automation can verify fact presence, semantic preservation, correction
paths, rendering, and system overhead; it cannot measure human understanding,
misunderstanding, confidence, or deliberation time.

| Measure requested by #127 | Observation | Interpretation |
| --- | --- | --- |
| Fact and condition preservation | Card submission retained plan label/value, `6 weeks`, API preservation, rollout condition, and separate note (5/5) | Technical transport evidence only |
| Omission or misunderstanding | Not measurable without a human participant | No improvement claim |
| Decision time | Not measured; browser harness duration is not human decision time | No speed claim |
| Additional questions | Explanation intent completed as a separate semantic submission | Capability evidence, not frequency evidence |
| Corrections | Modified resubmit and `A → B → A` revision history passed | Recovery capability, not usability evidence |
| Generation burden | GPT authoring latency/tokens were not measured | Open product cost |
| Preparation/render burden | See technical measurements below | Small fixture cost; not an end-to-end user metric |

One observed Chromium run produced these non-gating technical measurements:

| Layout | Raw bytes | Sanitized bytes | Fields | Server preparation |
| --- | ---: | ---: | ---: | ---: |
| prose | 215 | 210 | 0 | 3,055 µs |
| comparison | 1,302 | 1,041 | 4 | 10,725 µs |
| visual | 1,004 | 1,002 | 1 | 1,169 µs |

The corresponding harness paths took 1,121 ms, 1,853 ms, and 1,590 ms. These
numbers include Playwright CLI process overhead, fixture RPC, artificial polling,
and automated clicks; they are deliberately not reported as render latency or
decision time. The values are observations from one run, not performance gates.

### Evaluation outcome

The card condition structurally preserved all five response parts and made the
outgoing meaning inspectable. The prose baseline remains simpler and has no card
generation/render cost. With no independent user sample, neither better
comprehension nor faster decisions were demonstrated. A later participant study
must randomize or counterbalance condition order, reuse the same facts, and
measure comprehension questions, critical-condition omissions, corrections,
decision time, follow-up count, confidence, generation latency/tokens, and
rendering cost together. That study is tracked separately in
[#129](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/129).

## Automated repository verification

| Check | Result |
| --- | --- |
| Decision content/store/UI/integration targeted suite | 9 files / 93 tests PASS |
| Schema/store/tool targeted suite after revision fix | 5 files / 66 tests PASS |
| macOS helper future-schema integration | 44/44 PASS |
| Chromium production resource regression | 12/12 PASS |
| npm dependency advisory audit | 0 reported vulnerabilities |

The final full repository, App Server schema, native Swift, conformance, package,
and release checks are recorded in the pull request validation summary.

## Actual ChatGPT host

On 2026-09-19, the clean signed candidate built from runtime commit
`4d5c004c24c8fb938ffcd374b4cb40dabadb078b` was launched from the macOS app
bundle. The launcher reported build
`4d5c004c24c8:34c67a171e66`; the stable state database migrated to schema 24,
passed SQLite integrity checking, and the Bridge and Secure MCP Tunnel both
reported connected with no active or pending Job.

The existing development-mode ChatGPT plugin connection was refreshed. Its
actual action and template inventory then included `codex_decision`,
`codex_decision_result`, and
`ui://codex-mcp-bridge/decision/v1.html`. A new ordinary ChatGPT Work
conversation used only that plugin. GPT called `codex_decision` without creating
a project, Activity, Agent, Job, or Codex process. The mounted host card showed
the comparison table, text-labeled SVG risk graphic, required plan radios,
bounded `weeks` input, API checkbox, editable condition and note, and the trusted
outgoing preview.

Two submission boundaries were observed:

1. **After the GPT response ended:** the user path selected staged transition,
   changed the maximum to `5 weeks`, preserved the API, changed the stop
   condition, and added separate note and comment text. Confirmation first
   created sequence 1, then the card reported host acceptance. ChatGPT displayed
   the standard follow-up message, called `codex_decision_result` exactly once,
   and acknowledged every stored meaning and edit in the same conversation. The
   database recorded one delivery attempt, `host-accepted`, and a result offer.
2. **While a later GPT response was actively streaming:** the same mounted card
   changed the maximum from 5 to `4 weeks` and changed both note and comment.
   Sequence 2 was stored with a supersedes link and accepted in one attempt while
   the response was still active. The in-flight response finished with the prior
   5-week context; the host then placed the decision message after that response
   and started a follow-up turn. That turn read sequence 2 exactly once and
   acknowledged the 4-week revision and new text. This establishes the supported
   order: an active response does not gain the late decision mid-inference; the
   accepted message is queued for the next turn.

Both submissions ended `host-accepted` with `resultOfferedAt` present. A
scope-local database check found zero Activities, Agents, and Jobs. No receipt,
conversation identifier, or private host URL is retained in this audit.

The installed connector was in development mode and ChatGPT's account-wide
"enforce CSP in developer mode" switch was off; that unrelated global setting
was not changed. The refreshed registration did expose this resource's empty
connect/resource domain declarations. Consequently, the live observation proves
host rendering and message ordering, while sanitizer, CSP metadata, and leak
prevention remain established by the deterministic security regression rather
than by this development-mode host session.

The linked post-merge hardening record supersedes that limitation for the fixed
runtime: it documents the CSS-escape reproduction and fix, a clean candidate,
the same malicious input through the actual host with CSP enforcement enabled,
the installed host policy, zero forbidden request URLs, successful card
submission/result acknowledgement, and restoration of the original global
setting.

## Supported boundary

- Dynamic generated JavaScript, remote assets, canvas hit regions, and
  coordinate-only image decisions are unsupported in Decision v1.
- GPT remains responsible for factual accuracy, visual scales, units, evidence,
  and uncertainty in the HTML it authors. Sanitization cannot make a misleading
  comparison true.
- A torn-down card cannot promise to wake the original conversation. The stored
  decision remains recoverable, but recovery is not automatic delivery success.
- Host acceptance and result offer are not proof that GPT correctly reflected the
  decision in its next natural-language response; actual-host observation is
  required for that claim.
- Card confirmation never grants Codex or external execution authority.

## Tracked follow-ups

- [#131](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/131):
  align the GPT authoring contract with MCP discovery and verify blind authoring
  plus validator-driven self-correction.
- [#132](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/132):
  verify that an optional Codex continuation preserves question validity and
  execution/approval boundaries.
- [#129](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/129):
  run the independent-participant comprehension and decision-time study.

These are distinct unverified scopes. Their open status does not undo the
independent Decision Card v1 implementation, and this audit does not claim they
have been completed.
