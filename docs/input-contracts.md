# Input schema contracts

ChatGPT is the normative model client for the bridge. A published
`inputSchema` tells ChatGPT which arguments it may construct; the runtime Zod
schema remains the fail-closed parser and the bridge state remains the
authorization source.

## Published boundary

All bridge tools publish a closed object root with
`additionalProperties: false`. Nested objects with named properties are also
closed. This applies to both model-visible and app-only tools: an obsolete,
misspelled, or invented top-level field must fail input parsing instead of
being silently discarded.

Every `const` or `enum` leaf in a model-visible input declares its primitive
JSON Schema `type`. This includes dynamic `codex_task.project` names and model,
effort, operation, and query discriminators. The explicit type is redundant in
general JSON Schema semantics but is retained as a ChatGPT discovery
compatibility guard, matching the model-visible output policy.

Static collection limits are published and enforced at runtime. In particular,
the App Server normalizes at most three user-input questions, and
`codex_interaction_respond.response.answers` publishes and enforces that same
three-property maximum.

`codex_status` publishes two exact-Job query variants:

- immediate lookup accepts only `kind` and `id`;
- bounded waiting additionally requires `waitFor`, with optional `waitMs`.

The runtime retains the explicit `waitMs`/`waitFor` check as defense against a
stale or non-validating MCP caller.

`codex_steer` publishes exactly four required properties: `requestId`, `jobId`,
`expectedJobVersion`, and `prompt`. It does not publish conversation scope,
Activity/Agent/thread/turn/card identifiers, execution settings, lifecycle or
policy controls, or interaction/approval responses. Those omitted fields are
not compatibility aliases: attempts to inject them fail strict input parsing.

## Runtime-only authority

Some conditions cannot safely be frozen into discovery because they depend on
current bridge state or host evidence. The runtime therefore remains broader
where it must return an authoritative, recoverable error:

- ChatGPT conversation scope comes from host metadata; explicit `scopeId` is a
  compatibility-only input for other MCP hosts.
- New Activities and fresh Agent contexts require a current exact project and,
  in automatic mode, a current exact model/effort selection. Existing
  continue/fork calls inherit their admission-time project and selection.
- Project registry, model catalog, and settings generations are checked again
  during serialized admission even if a `tools/list_changed` notification was
  delayed or lost.
- A cross-backend fresh Agent requires an explicit bounded `handoffSummary`;
  same-backend fresh context forbids it.
- Cancellation impact sets, optimistic versions, mounted-card leases, and exact
  interaction question IDs are authoritative runtime state.
- Public steering derives scope from the host and resolves the exact Job's
  Activity, Agent, current App Server thread, and active root turn at dispatch
  time. Job ownership, current assignment, optimistic version, cancellation and
  terminal state, backend capability, and positive active-turn evidence are all
  runtime checks. No inactive or future turn queue is admitted.

These are intentional semantic admission checks, not open schema leaves. They
must fail before Activity, Agent, Job, session, cancellation, or upstream side
effects are committed.

## Regression audit

The discovery regression in `test/tools.test.ts` walks every published input
schema and fails when:

- any tool root or named nested object is open;
- any model-visible literal lacks its primitive type;
- the dynamic project choices lose their string type;
- the exact-Job wait variants become ambiguous; or
- the interaction answer map loses its shared question bound; or
- `codex_steer` exposes anything other than its four bounded public fields or
  loses its destructive/idempotent annotations.

Runtime probes also send unknown fields to the four formerly open roots and an
oversized interaction-answer map, and inject upstream/card/policy identifiers
into `codex_steer`, requiring an input error rather than a successful no-op.
An end-to-end public steering probe starts and steers the same Job with only
host metadata plus the four published fields, then proves that another host
session cannot address that Job.
Dynamic task profiles, unavailable-project recovery, fixed and automatic model
policies, and adaptive/fixed sandbox profiles remain in the existing discovery
suite.

The focused issue-40 discovery delta is checked in at
`docs/audits/issue-40-tool-schema-delta.json`; the executable full inventory
snapshot remains in `test/tools.test.ts` so descriptor drift fails the suite.
