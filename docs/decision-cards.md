# GPT–user decision cards

Decision cards help a user understand alternatives and return one explicit,
meaning-preserving decision to the same ChatGPT conversation. They are optional:
GPT should keep simple questions in ordinary conversation and use a card only when
comparison, editable conditions, or a visual explanation materially helps.

The feature is independent of Codex execution. Creating, rendering, submitting,
and reading a decision card requires no registered project, Activity, Agent, or
Job. A later GPT turn may choose to use the decision while planning or while
driving Codex, but the card itself never starts work and its confirmation is not
an execution or permission approval.

## Public flow

1. GPT calls `codex_decision` with `operation: "create"`, a unique `requestId`,
   a title, and free-form HTML.
2. The Bridge parses and sanitizes the HTML, derives the semantic input contract,
   stores immutable version 1, and opens the shared Decision resource.
3. The user reads the card, edits its native controls and optional comment, then
   explicitly chooses **Confirm decision**, **Need more explanation**, or
   **Decide later**.
4. The app-only runtime stores the canonical decision before trying delivery.
   It then sends a standard `ui/message` to the same conversation containing only
   a scoped receipt lookup instruction.
5. GPT calls `codex_decision_result` with that exact receipt. The result contains
   the visible field labels, selected option labels and values, units, comment,
   intent, card version, and delivery evidence. It explicitly reports
   `executionApproved: false`.

GPT revises an open card with `codex_decision` operation `revise`, the card ID,
and the exact current `expectedVersion`. Every revision has immutable sanitized
content, field definitions, digest, presentation proof, and expiry. A mounted old
version fails closed and tells the user to reopen the latest version.

## Free-form HTML boundary

The body is HTML, not a fixed questionnaire or block schema. It may contain
headings, paragraphs, lists, comparison tables, figures, static inline SVG, and
embedded raster `data:` images. Safe inline presentation CSS is supported through
a small property/value allowlist. The runtime also provides responsive layout,
keyboard focus indication, system light/dark colors, and localized trusted
controls in English, Korean, Japanese, Simplified or Traditional Chinese,
Spanish, French, German, and Portuguese.

Generated content is untrusted and inert:

- an HTML parser and allowlist sanitizer remove scripts, event handlers, forms'
  navigation targets, embedded frames/objects, external links, remote media,
  SVG links, unsafe CSS, and unknown attributes. Inline CSS declarations are
  parsed, comments are removed, CSS escapes are normalized, and only a small
  set of non-loading value functions is accepted. SVG `fill` and `stroke`
  receive the same treatment, except for exact local `url(#id)` references;
- the resource CSP has no network or resource domains;
- generated content cannot call MCP tools, post host messages, own delivery,
  read Bridge secrets, or supply JavaScript;
- static inline SVG and raster `data:` images are the supported visual asset
  paths; remote images, generated JavaScript charts, canvas hit regions, file
  inputs, and coordinate-only image selection are not supported in version 1;
- input HTML is limited to 96 KiB and the derived field/option/text sizes are
  bounded before anything is stored or rendered.

The Bridge never treats text inside generated HTML as an instruction, permission,
or trusted claim. GPT remains responsible for the accuracy of facts, units,
comparisons, and visual encodings it authors.

## Semantic input contract

The sanitizer accepts labeled native controls: text, number, range, `select`,
radio, checkbox, and `textarea`. Every stored field has a stable safe `name`, a
visible label, kind, required state, allowed choices, numeric bounds, and optional
unit. Choice results preserve both the submitted value and the visible option
label. Numeric values are parsed and checked against stored bounds and steps.
Required fields apply to **Confirm decision**; explanation requests and deferrals
may keep them unanswered. Empty, unknown, missing, duplicate, or newly injected
fields and options are rejected.

Use ordinary semantic HTML:

```html
<fieldset>
  <legend>Rollout strategy</legend>
  <label><input type="radio" name="plan" value="staged" required>
    Staged rollout — reversible checkpoints
  </label>
  <label><input type="radio" name="plan" value="direct">
    Direct migration — shortest transition
  </label>
</fieldset>
<label>Maximum transition
  <input type="number" name="weeks" min="1" max="12"
         data-decision-unit="weeks" required>
</label>
```

`data-decision-label` can supply a visible semantic field label when surrounding
markup cannot do so. `data-decision-unit` records the unit. A trusted
`data-decision-output-for="fieldName"` element may mirror a range value; it does
not execute generated code. Do not use opaque option values without descriptive
visible labels: GPT receives both, but the visible meaning is the decision.

## Storage and delivery states

Decision state is stored in schema 24 independently of Job state:

- `decision_cards` owns the current version and expiry;
- `decision_card_versions` owns immutable sanitized content and semantic fields;
- `decision_card_requests` makes create/revise requests idempotent;
- `decision_submissions` owns canonical user intent, revision chain, receipt, and
  delivery evidence.

An identical double-click coalesces to one semantic submission. A changed second
submission gets a new sequence and points to the submission it supersedes. Card
and receipt lookups verify the authenticated conversation scope on every path;
knowing an ID, presentation reference, or receipt never grants access.

The user-facing states deliberately remain distinct:

| State | What is known |
| --- | --- |
| `stored` | The exact semantic decision is durable; no send is claimed. |
| `leased` | One card instance owns a bounded send attempt. |
| `host-rejected` | The host definitely rejected delivery; the user may explicitly retry. |
| `host-accepted` | The host accepted `ui/message`; GPT use is not yet proven. |
| `acceptance-unknown` | The acknowledgement was lost or timed out; automatic resend is suppressed. |
| `resultOfferedAt` present | The Bridge returned the exact result to `codex_decision_result`; this still is not proof of what GPT said next. |

The runtime never calls an accepted send “GPT confirmed.” Restart converts an
unresolved lease to `acceptance-unknown`. Definite rejection permits a bounded
explicit retry; uncertain acceptance does not. Expired inactive cards are kept
for a 30-day recovery window before cleanup, subject to per-scope and installation
capacity limits.

## Verification and product claim

Parser, storage, migration, scope, version, duplicate, retry, teardown, and
browser-host simulations are covered by automated tests. See the issue-specific
[evaluation record](audits/2026-09-19-issue-127-decision-cards.md) for layouts,
scenarios, commands, and evidence boundaries.

The implementation establishes the interaction and measurement path. It does not
claim that cards already improve comprehension or decision time for real users.
That product hypothesis requires a participant study using the same facts and
task in prose and card conditions, measuring comprehension, omissions,
corrections, time, and authoring/rendering overhead together. The study is
tracked in [#129](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/129).
