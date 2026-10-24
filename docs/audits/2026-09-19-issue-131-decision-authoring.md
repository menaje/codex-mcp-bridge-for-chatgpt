# #131 Decision Card authoring contract and blind-host verification — 2026-09-19

> Historical audit: Decision Cards were retired in [#141](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/141). This document records the former implementation and tests; it does not describe current tools or resources.

## Conclusion

The detailed contract in `docs/decision-cards.md`, the contract visible through
MCP `tools/list`, and the sanitizer/validator now agree on the information GPT
needs to author a meaning-preserving card. A fresh ChatGPT Work conversation
created, rendered, submitted, read, and accurately reflected a nontrivial card
from a prompt with no HTML or control-schema hints. A separate actual-model run
received an intentional validation failure, used only the returned repair text,
and opened a corrected card on its next tool call.

Neither run created a Project, Activity, Agent, Job, or Codex execution. This
record establishes one reproducible authoring and recovery path; it is not a
claim that every model prompt will produce an ideal card or that the card
improves user comprehension. The latter remains #129.

## Contract review

The pre-change discovery contract said only that the body was free-form HTML
and that labeled native inputs should be used. The canonical document and
validator additionally depended on details that a model could not reliably
infer from that short description.

| Required authoring fact | Pre-change discovery | Current discovery and enforcement |
| --- | --- | --- |
| Operation selection | Present only as a union discriminator | The tool, union, and each branch say that `operation` is required and distinguish `create` from `revise`. |
| Collected controls | “labeled native inputs” | Names `input`, `select`, and `textarea`; schema guidance explains that their visible semantics become the result contract. |
| Stable name and visible label | Not defined | Requires a letter-leading safe `name` and a wrapping label, `label[for]`, `fieldset`/`legend`, or `data-decision-label`. An enabled unnamed control is now rejected rather than rendered with a value that disappears from the result. |
| Choice meaning | Not defined | Requires non-empty values and descriptive visible option labels, preserving both in the result. |
| Required, units, and range output | Not defined | Explains confirmation-only `required`, `data-decision-unit`, and `data-decision-output-for`. |
| Visual/resource boundary | Only said external resources are removed | States that static inline SVG and base64 raster data images are supported while scripts, event handlers, remote resources/navigation, and generated JavaScript are removed. |
| Authoring limits | Schema maximum only | States 96 KiB, 64 derived fields, and 100 options per field. |
| Minimal working shape | None | Includes one compact radio-group plus numeric-unit example. No guide tool or preliminary call was added. |
| Repair after rejection | Stable code but terse detail | Label, group-label, name, and option-value errors retain stable codes and add an exact valid repair. |

This follows OpenAI's tool-definition guidance: descriptions explain when and
how to use a tool, parameter descriptions make inputs explicit, and annotations
reflect actual behavior. It also preserves server-side validation because tool
metadata does not replace authorization or input checks. The referenced primary
guidance is [Tool definitions](https://developers.openai.com/ko-KR/plugins/plan/tools)
and [Optimize metadata](https://developers.openai.com/ko-KR/plugins/guides/optimize-metadata).

## Deterministic verification

`scripts/audit-tool-guidance.ts` now reads the actual current-protocol
`tools/list` contract, includes `src/decisionCard.ts` in source attribution, and
asserts the minimum authoring terms and a 12,000-byte discovery budget. It then
sends an unlabeled radio input, observes
`DECISION_FIELD_LABEL_REQUIRED`, and retries the same logical request ID with a
labeled `fieldset`/`legend` card. The corrected call succeeds with one semantic
field. Its isolated upstream call count is zero.

| Command | Result |
| --- | --- |
| `npx vitest run test/decisionCardContent.test.ts --maxWorkers=1` | 1 file / 7 tests PASS |
| focused discovery and correction tests in `test/tools.test.ts` | 2 tests PASS |
| `npx tsx scripts/audit-tool-guidance.ts` | 20 tools, 18 probes, upstream calls 0; invalid then corrected decision probes PASS |
| `npm test` | 88 files / 781 tests PASS |
| `npm run build` | TypeScript, localization, release manifest, and development-stage policy PASS |
| `npm run macos:bundle` | Signed bundle PASS; Swift 202 tests, 2 opt-in live tests skipped, 0 failures |

The production bundle was built from clean runtime commit
`4571ffd8734fe25b26bf526250c1362d0d73b264` with build ID
`4571ffd8734f:4edac8c5faba`. Before restart the helper reported zero active Jobs
and zero pending admissions. After the graceful replacement, the exact build ID
was reported and both Bridge and Tunnel were connected.

## Actual ChatGPT blind-authoring path

A fresh ChatGPT Work conversation selected only **Codex MCP Bridge for ChatGPT**.
The Korean user request supplied the two rollout alternatives and their facts,
then asked for a decision card with strategy, maximum transition period, and an
editable condition. It supplied no HTML, SVG, native-input, field-name, label,
unit-attribute, or sanitizer instructions.

GPT selected `codex_decision` and succeeded on its first authoring call. The
mounted card contained:

- a comparison table preserving the supplied schedule, risk, rollback, and
  speed tradeoffs;
- an accessible static rollout visualization;
- a required strategy radio group with descriptive visible choices;
- a required maximum-period select and an editable condition field; and
- the trusted review section and explicit non-execution notice.

The operator selected **단계적 배포**, **4주 이내**, entered **오류율 1% 초과
시 즉시 롤백하고 50% 단계에서 3일 관찰**, and added the separate audit note.
The mounted review showed those exact meanings before confirmation. Confirmation
was durably stored, accepted by the host in one delivery attempt, and read by
`codex_decision_result`. GPT then separately stated the staged 10% → 50% → 100%
schedule, four-week maximum, 1% rollback threshold, three-day observation at
50%, the note, and confirmed intent. It also repeated that this was not deployment
execution approval.

The stable database observation for that exact conversation scope recorded card
version 1 with three semantic fields, `host-accepted`, one attempt,
`resultOfferedAt`, and zero Activities, Agents, and Jobs.

## Actual GPT validation-error recovery

A second fresh Work conversation intentionally asked GPT to omit the human label
on its first decision input, then repair the card using only the tool error. This
is deliberately separate from the no-hint blind-authoring run.

The first `codex_decision` call was rejected with
`DECISION_FIELD_LABEL_REQUIRED: strategy` and concrete wrapping-label,
`label[for]`, and `data-decision-label` remedies. GPT identified that error,
added a visible `<label for="strategy">배포 전략</label>` and matching control
ID, and called the tool again. The second card rendered with a labeled strategy
select and normal trusted confirmation controls. GPT accurately described the
error code and repair. Only the successful mutation was stored; its conversation
scope again had zero Activities, Agents, and Jobs.

## Evidence boundary

- The blind run proves discovery-only authoring for one representative complex
  prompt. It is not a statistical reliability measurement across models,
  languages, or arbitrary prompts.
- The correction run intentionally requested a malformed first attempt, so it
  proves recovery from a real validator response, not spontaneous mistake
  frequency.
- The ChatGPT developer-mode CSP indicator was off during these authoring tests.
  No network-security claim depends on this run; sanitizer/CSP evidence remains
  in the separate #127 hardening record.
- Host acceptance and database `resultOfferedAt` were kept distinct from the
  observed natural-language acknowledgement. The latter was verified in the
  rendered conversation rather than inferred from storage.
- No private conversation identifier, scope identifier, receipt, tunnel URL, or
  credential is retained in this document.

