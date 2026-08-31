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
JSON Schema `type`. This includes the stable Task contract/envelope constants
and operation and query discriminators. The explicit type is redundant in
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

`codex_task` publishes execution fields only. It has no UI metadata and no
presentation input, so calling it multiple times cannot create multiple
Activity-card shells. Its stable description explains that saved visibility is
runtime authority; the result's `nextActions` projects whether the admitted Task
is currently eligible for one separate compact presentation. `codex_activity`
publishes two presentation modes:

- `compact-monitor` requires one UUID `presentationId` and may include one
  `activityId` as the initial focus; orchestration calls it at most once after
  all Task calls for an assistant response;
- `full-history` is the default explicit user-open mode and forbids
  `presentationId`.

Contract v2 publishes one generic closed `project: { name, projectRef,
projectRevision }` shape and one generic `projectLookup: { name }` shape. It
does not embed project names, refs, revisions, private UUIDs, paths, or registry
generations. `projectLookup` is a same-tool no-work operation: it returns the
exact current selector in `nextActions`, creates no Activity, Agent, Job,
session, filesystem mutation, or upstream turn, and is then retried with a new
`requestId`. `projectRef` is opaque public identity and `projectRevision`
changes on effective rename, relocate, archive, or restore transactions for
that project. External availability is rechecked separately. The global
`registryRevision` remains a Settings CAS generation, not a Task selector. The
legacy `{ name, registryRevision }` selector is bounded runtime compatibility
for cached pre-v2 calls only.

The Task root requires `taskContractVersion: "2"` and the descriptor's exact
64-hex `executionEnvelopeRef`. This opaque installation-keyed HMAC binds the
stable input generation and operator-owned maximum/static execution envelope:
prompt bound, command/backend, allowed roots, sandbox capabilities, approval
policy, model ceiling, and secret preflight. It deliberately excludes saved
user settings, projects, project availability, and the live model catalog.
Those values are runtime authority, so changing them does not change the public
descriptor or require connection Refresh. An operator/static mismatch returns
`EXECUTION_ENVELOPE_CHANGED` before side effects and requires Refresh.

For every new v2 call the bridge privately captures an exact mutable execution
policy reference over saved access/model/priority/thread-visibility/concurrency settings and
the resolved admission catalog. It rechecks that reference across asynchronous
and serialized admission boundaries. A concurrent settings race returns
retryable `EXECUTION_POLICY_CHANGED` without side effects; v2 retries the same
stable contract with a new `requestId` and no connection Refresh. Exact admitted
v7 replays return their retained result before current policy/project resolution.
Cached pre-v2 calls retain the public `executionPolicyRef` compatibility check
and must Refresh once to migrate to v2 when that ref is stale.

The stable input-plus-output Task contract is capped at 9,500 bytes and the
complete serialized descriptor remains capped at 128 KiB. Overflow fails
deterministically with `CODEX_TASK_DESCRIPTOR_TOO_LARGE`.

The current Task output schema is static. The MCP SDK validates output only
after an asynchronous handler returns, so the coordinator rejects a different
output schema while any descriptor binding is live with
`DYNAMIC_OUTPUT_SCHEMA_CHANGE_REQUIRES_VERSIONED_CONTRACT`. A future transition
must use an additive compatibility union with captured contract generation or a
versioned/reinitialized tool boundary; it cannot mutate the live validator.
Regression coverage holds a real tool handler in flight, attempts the transition,
and proves that the old result is still validated against the admitted output
contract before any reinitialized boundary may install the new schema.

The saved `always`, `background-only`, or `never` visibility policy remains a
runtime authority. Presentation identity cannot bypass it or alter Task replay.

`codex_dashboard_snapshot` accepts `terminalOffset` and `idleOffset` for the
current status-first card. `projectOffset` and `conversationOffset` remain
optional compatibility inputs only because immutable generation-4–6 cards
still send them; their presence asks the server to add the older grouped
projection, while generation 7 omits them and receives the smaller row-only
snapshot.

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
- New Activities and fresh Agent contexts require a current exact project. In
  automatic mode GPT is instructed to choose a current exact model/effort pair;
  omission is retained only as a defensive path and resolves to the exact saved
  fallback. Existing continue/fork calls omit both fields and inherit their
  admission-time project and selection unless they deliberately request a
  runtime-policy-supported model override. If an exact current project selector
  is unknown, `projectLookup` resolves it through the same stable Task contract.
- The selected project's ref/revision/name, active/available state, canonical
  root, model catalog, and execution policy are checked again during serialized
  admission even if the client retained a cached descriptor. An unrelated
  project mutation does not invalidate an unchanged selector, while a changed
  selector returns same-tool lookup recovery rather than requiring rediscovery.
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
- the generic project selector or lookup loses its exact closed types;
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
Stable descriptor equality across settings/catalog/project changes,
unavailable-project recovery, fixed and automatic runtime model policies, and
adaptive/fixed sandbox enforcement remain in the discovery suite.

The focused issue-40 discovery delta is checked in at
`docs/audits/issue-40-tool-schema-delta.json`; the executable full inventory
snapshot remains in `test/tools.test.ts` so descriptor drift fails the suite.
