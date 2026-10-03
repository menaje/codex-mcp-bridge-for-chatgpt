# Input schema contracts

All current bridge tools publish JSON Schema 2020-12 object-root input schemas.
Objects are closed unless the schema explicitly declares a keyed map. Unknown
fields, obsolete aliases, and mismatched union branches are rejected before an
operation reaches bridge state or Codex.

The runtime validates the same current contract that `tools/list` advertises.
There is no hidden parser for a previous tool generation.

## Task admission

`codex_task` uses input contract version 6. A new logical task needs:

```json
{
  "requestId": "a UUID for this logical task",
  "taskContractVersion": "6",
  "executionEnvelopeRef": "the exact 64-hex value from tools/list",
  "prompt": "the user's requested work",
  "project": {
    "name": "registered project name",
    "projectRef": "current opaque project ref",
    "projectRevision": 4
  }
}
```

The project selector is required for fresh work and is checked again at
admission. Continuations use the retained Agent context and its admission-time
project. `requestId` is durable idempotency state for the logical work; reuse it
only for an identical retry. It is distinct from the MCP request ID. If the
admission response is lost, recover the receipt with
`codex_status({"query":{"kind":"request","requestId":"..."}})` in the same
scope. Reusing the ID with different task input is a conflict.

For an ordinary already approved follow-up turn, retain its own `requestId` when the
parent Job result is read again or its admission response is lost. First query
that ID to recover an uncertain admission; do not create a replacement ID for
the same logical turn. A new branch, revision, or expressly requested rerun is
a new logical turn with its own ID. The bridge does not infer follow-up identity
from matching prompts or the Agent's thread. If the follow-up ID itself is lost,
the existing request contract cannot prove that two new IDs mean the same step.
Do not treat `HANDLE_UNAVAILABLE` as proof that an old request was never admitted.

For an exact step approved before its predecessor starts, the optional
`approvedFollowups: [{"prompt":"the exact approved B prompt"}]` declares that
authorization on predecessor admission. The bridge returns opaque `followupId`
and canonical `requestId` references in declaration order. Recover those same
values from the predecessor's exact Job/request read after lost responses or
restart; GPT must not name or recreate a stage ID. After reviewing its completed
exact result, use that requestId and same prompt with
`followup: {"followupId":"the bridge-issued reference","reviewedVersion":2}`
and omit project and selection. Use the actual version from the exact read.
Different caller UUIDs and resumed GPT runs using the same issued reference
converge to one admission. A different prompt, changed context/model, unavailable
result, unapproved step or occupied canonical ID is rejected. The exact result
offer and the caller's review assertion do not prove private GPT review.
See the [delivery transition](issue-221-delivery-transition.md) for legacy followup recovery.
Old caller `stepId` inputs are rejected. Retained v1 receipts keep their canonical
IDs and admitted Jobs, exposed through current system-issued references.

All new work uses one asynchronous admission path. The bridge persists the Job,
request receipt, versions, and requery handles before returning. It does not wait
for Codex completion in the task call, and losing the MCP or HTTP connection does
not cancel the admitted Job. Read progress and the terminal result with
`codex_status`; use `codex_cancel` only for explicit stop intent.

Each ordinary admission snapshots `completionDeliveryPolicy="direct-wait"`. New and existing installations use it without opt-in. The retired setting is compatibility input only and is normalized to true; it never alters new admission policy. Historical Job policies remain immutable. Inspect the exact input action after every non-terminal wait and stop at a current question or approval. No task result automatically opens Dashboard.

Events admission, tools, instructions, schemas, and controller startup require the explicit `CODEX_MCP_BRIDGE_EXPERIMENTAL_PROFILE=events` profile together with its enable flag and authentication configuration. Ordinary discovery has no Events inputs or output metadata. Historical Events policy remains readable, but gives no new ordinary execution permission. See the separate [experiment](mcp-events.md).

An exact Job/request `codex_status` wait is a bounded read. `waitFor="change"`
wakes on a Job version change; `waitFor="terminal"` uses a lifecycle-only signal
and does not wake for ordinary progress. The model-visible default is 20 seconds
and the maximum remains 60 seconds. Timeout or host abort returns or aborts only
the read request; neither path creates cancellation provenance, calls upstream
interrupt, or changes the Job lifecycle.

The bridge owns access policy, the permitted execution envelope, project
authorization, and any App Server capability checks. Callers cannot pass a
sandbox, approval policy, working directory, raw thread ID, presentation
identity, or other permission override.

### Bridge documents are independent

`bridge_skill` reads Bridge-owned reusable Markdown documents. A read does
not add data to `codex_task`, change the task descriptor, or deliver a document
to Codex. Apply a document only when it is relevant to the user's request;
start a local task independently through the ordinary `codex_task` contract.

## Model selection

Read `codex_models` first when a model choice is needed:

```json
{ "refresh": true }
```

The input has no contract-version switch. Its single response contains
`selectionMode` and the allowed model/reasoning pairs from one settings
snapshot. In fixed mode, omit `selection` from `codex_task`. In automatic mode,
send an exact `{ "model", "reasoningEffort" }` pair where the task contract
requires one. A later policy change is rechecked at admission.

## Read, mutation, and card inputs

`codex_status` has closed query variants for an exact request receipt, Job,
Activity, thread, project, or bounded input wait.

An exact Job or request query can return a compact terminal admission receipt
after the full result is pruned. It confirms that the request already ran and
gives its Job ID and terminal state, but cannot restore the expired result.
Such a receipt does not authorize a replacement or a dependent step whose
required result is absent. Missing and foreign handles remain indistinguishable.

Authenticated exact Job/request reads record a result offer. That evidence does not prove GPT received or reviewed the result and does not rewrite historical delivery receipts. The removed completion-receipt query and `codex_ui_completion` return `CARD_DELIVERY_RETIRED` without mutating a Job. Old automatic Dashboard arguments are likewise refused. Refresh discovery, close old cards, and read the retained exact Job instead.

`codex_cancel` and state-changing tools require their own idempotency UUID and
exact version. An out-of-date version, a different retry payload, or a
scope/ownership mismatch is a rejection, not a best-effort mutation.

App-private tools use card proofs, revisions, and scoped targets where
applicable. They are current card operations, not public fallback aliases.
`codex_ui_read` returns the current view selected by a closed `view` enum;
settings changes use `codex_update_settings` with the required revision checks;
`codex_dashboard` accepts only an explicit display scope and optional compatibility scope ID. It has no Job/presentation handoff inputs.

## Host metadata and scope

ChatGPT supplies conversation scope through current MCP request metadata. A
non-ChatGPT host without that metadata may provide one generated `scopeId` and
must reuse it only for that host context. Scope metadata identifies a caller
context; it never grants access to another project, Activity, Agent, Job, or
settings record.

## Removed inputs

Do not send:

- model-catalog `contractVersion`;
- Task contract versions 2 through 5, a legacy project selector,
  `projectLookup`, `executionMode`, or other retired execution/UI fields;
- `requiredSkills` or any Bridge-document reference in `codex_task`;
- legacy cancellation and Activity-update shapes;
- a compatibility tool name, card resource URI, or session identifier.

The bridge rejects these inputs without falling back to an earlier contract.
See [the migration guide](mcp-2026-07-28-migration.md) for connector refresh
steps and [Card tools](card-tools.md) for the current inventory.
