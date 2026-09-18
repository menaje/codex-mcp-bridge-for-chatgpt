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

All new work uses one asynchronous admission path. The bridge persists the Job,
request receipt, versions, and requery handles before returning. It does not wait
for Codex completion in the task call, and losing the MCP or HTTP connection does
not cancel the admitted Job. Read progress and the terminal result with
`codex_status`; use `codex_cancel` only for explicit stop intent.

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
completion receipt, Activity, thread, project, or bounded input wait. Completion
receipt reads require current ChatGPT conversation metadata; an explicit
compatibility `scopeId` is not authority. When an authenticated exact Job or
request query actually returns a retained terminal result before a Dashboard has
claimed its send lease, that direct read atomically settles the still-pending
automatic follow-up. A running, omitted, unavailable, explicitly scoped, or
already leased/accepted/uncertain result does not make that transition.
`codex_cancel` and state-changing tools require their own idempotency UUID and
exact version. An out-of-date version, a different retry payload, or a
scope/ownership mismatch is a rejection, not a best-effort mutation.

App-private tools use card proofs, revisions, and scoped targets where
applicable. They are current card operations, not public fallback aliases.
`codex_ui_read` returns the current view selected by a closed `view` enum;
settings changes use `codex_update_settings` with the required revision checks;
`codex_ui_completion` owns the bounded exact-Job live-card delivery lease.

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
