# Conversation-aware status card (issue #76)

Issue: https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/76.
The user requested closure based on implementation and local verification;
operational rollout and actual ChatGPT use are outside this issue's completion
criteria.

## Behavior

The user-facing card is **Codex status / Codex 현황**. Its first read requests
`scope: auto`: retained Activity or Job records in the opening GPT conversation,
including completed and archived history, select **This conversation / 이 대화**.
Otherwise it starts with **All conversations / 전체 현황**. Both the thin opener
and automatic initial read accept absent conversation identity; malformed
metadata still fails validation.

The scope selector supports both directions. After the initial selection,
structural reads, enrichment, refresh, pagination and temporary page restoration
send the selected scope explicitly. A new cold mount chooses automatically.
Losing host identity during an explicit conversation read produces an error
instead of silently broadening the view. Changing scope clears old rows, counts,
page caches, disclosures and selected work details; late responses cannot repaint
the new scope or replay a mutation.

Both scopes share the existing Codex execution states, ordering, history and
validated work controls. The explanatory text distinguishes completion of one
execution from completion of the overall goal. The server filters Jobs, archived
summaries, Agents, sessions, cancellation displays, runtime probes and counts
before pagination. Project counts use relevant active registrations in the
conversation view. Account usage remains account-wide. Ordinary model access
continues to use its original conversation boundary.

All nine UI languages have scope labels and explanations. Omitting the new
scope argument preserves the all-work view for native clients and older saved
cards. New work still does not open the retired Activity presenter; its retained
compatibility handlers and resources remain available.


## Dev integration

The integration starts from `a9669f3` on `dev`, preserving the committed Ultra
policy and connection-observation recovery changes. It applies the issue-only
difference from the earlier isolated implementation and its count correction.
Unrelated local execution-policy, inline-control and status-summary work remains
local instead of entering this commit through preservation snapshots.

The scope switch uses dev's existing work-detail panel. It clears the selected
row, form, private control proof and pending-read generation on a scope change,
including while a detail read is outstanding. The browser regression exercises
this existing panel as well as scope selection, counts and pagination.

Release tooling generated Dashboard contract generation **23** at
`ui://codex-mcp-bridge/dashboard/be25ddc74c44.html`. The HTML is **141,249 bytes**,
within the **144 KiB** budget. All **158** pre-existing card revisions from dev
retain their URI, metadata and HTML bytes.

## Validation

- Full suite: **812 tests in 64 files passed** with one worker and unchanged
  timeouts. An initial overlapping run hit the existing five-second limit in
  three pre-existing tests; the complete rerun passed after browser checks
  finished, without skipping tests or changing timeout limits.
- Build, release policy, UI manifest and whitespace checks passed.
  Validated product-source hash: `be0b7589882fa60ed02e9a6d0eeb0efa3efc52365232a67d015fe86952936135`.
- App Server compatibility passed against CLI **0.153.3**, with **416 JSON**
  and **827 TypeScript** schema files.
- The scope browser regression passed **7 scenario groups** covering defaults,
  completed-only history, missing identity, two-way switching, pagination,
  late responses, form reset, page restoration and refresh recovery.
  The mobile screenshot was visually checked.
- Existing Dashboard input controls passed **4 scenarios**; stop controls
  passed **6 sandboxed scenarios**.

Browser checks use local fixtures and a simulated host. No operating bridge
restart or ChatGPT connection refresh was performed for this merge.

## Count correction

The user's follow-up review reproduced one missed case: a conversation with
only an Activity and no execution had a conversation count of **1** in the
conversation view but **0** in the all-work view. Existing tests covered initial
selection for this case but had not compared those two counts.

Commit `c14f42dc2e4728a067a8139c3b431e4559ba6c8d` includes distinct retained Activity
scopes in the all-work conversation count. The query reads routing keys only,
without loading Activity payloads. Multiple Activities in the same conversation
count once; two conversations count twice. Both views correctly retain zero
execution rows and Jobs when work has not executed. The native all-work view
uses the same corrected count. A regression test first failed on the original
implementation, then passed after the correction.
