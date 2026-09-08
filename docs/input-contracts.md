# Input schema contracts

Issue #69 current contract: [Card tools and migration](card-tools.md). The current contract has 12 model tools and 5 app-only tools, plus 12 app-only compatibility descriptors during migration (29 discovered in total). Activity presentation, watch, rehydration and handoff contracts below apply only to cached pre-consolidation cards during the migration window; they are not instructions to open Activity for new work.

ChatGPT is the normative model client for the bridge. A published
`inputSchema` tells ChatGPT which arguments it may construct; the runtime Zod
schema remains the fail-closed parser and the bridge state remains the
authorization source.

## Published boundary

All bridge tools publish an object root. A single-shape contract sets
`additionalProperties: false`; a union has closed object branches, each with
`additionalProperties: false`, and no free-form fallback. Nested objects with named properties are also
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

`codex_task` publishes execution fields only and has no Activity UI binding.
`codex_status` adds the closed `{kind: "input", jobId, afterCursor?, waitMs?}`
query. Its input cursor and wait remain separate from ordinary Job progress.
`codex_cancel` selects `{kind: "job" | "activity", id}` in `target`, with a
unique requestId, exact expectedVersion, reason and optional impact acknowledgment.
The old Job shape remains runtime-only compatibility.

`codex_models` accepts optional `contractVersion: "2"`. This explicitly requests
the closed v2 catalog result with `selectionMode: "fixed" | "automatic"` from
the same settings snapshot as the allowed model/effort list. Omission keeps the
exact legacy catalog-only result for cached clients. Fixed mode requires omitting
Task `selection`; automatic mode requires a permitted pair for fresh work.
One returned model does not identify the policy mode. This read does not open a
card or change policy; admission still rechecks current settings.

`codex_user_answer.responseRef` distinguishes two existing operations: omission
lists up to 20 unread references without bodies or consumption, while an exact
reference returns the body and marks that response seen. Neither sends an answer
to Codex. GPT owns that separate decision.

Contract v2 publishes one generic closed `project: { name, projectRef,
projectRevision }` shape. It does not embed registry values, private UUIDs or
paths. Resolve unknown selectors with read-only `codex_status` query
`{ kind: "project", name }`. This creates no Activity, Agent, Job, session,
filesystem mutation, or upstream turn. `projectRef` is opaque public identity and `projectRevision`
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

`codex_ui_read` (`view: "dashboard"`) accepts `terminalOffset` and `idleOffset` for the
current status-first card. `projectOffset` and `conversationOffset` remain
optional compatibility inputs only because immutable generation-4–6 cards
still send them; their presence asks the server to add the older grouped
projection, while generation 7 omits them and receives the smaller row-only
snapshot. Current cards explicitly send `enrich: false`, producing a structural
snapshot without App Server or usage calls, render it, and then make a second
read-only request with `enrich: true`; runtime work is limited to
active/attention/currently visible rows. Omission preserves the enriched
all-in-one behavior expected by immutable older Dashboard cards.

`codex_activity_snapshot` uses the same optional `enrich` split. The structural
call and long poll retain their exact card proof, widget lease, cursor, and
scope-version semantics. A separate `enrich: true` call may add bounded runtime
and usage evidence, but cannot broaden control authority or resume an unloaded
historical App Server thread. Omission remains enriched for retained Activity
cards; generation 20 sends `false` explicitly on structural reads and watches.

`codex_ui_read` (`view: "settings"`) is an app-private read-only call with one optional
`refreshModels` boolean. The current Settings card calls it unconditionally on
cold mount and after revision conflicts. Its default reads current persisted
settings and project-registry state while using the normal short-lived catalog
cache; the contextual catalog retry sets `refreshModels: true`.

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
  automatic mode GPT must choose a current exact model/effort pair. Omission
  fails with `MODEL_SELECTION_REQUIRED` and `codex_models` as its recovery action
  before execution state or side effects. Existing continue/fork calls may omit
  selection and inherit their admission-time thread choice unless they
  deliberately request a runtime-policy-supported model override. If an exact
  current project selector is unknown, `codex_status` query kind=project resolves
  it without model selection, execution, or permission input.
- The selected project's ref/revision/name, active/available state, canonical
  root, model catalog, and execution policy are checked again during serialized
  admission even if the client retained a cached descriptor. An unrelated
  project mutation does not invalidate an unchanged selector, while a changed
  selector returns read-only project lookup recovery rather than requiring rediscovery.
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
bridge-owned sandbox enforcement remain in the discovery suite.

The focused issue-40 discovery delta is checked in at
`docs/audits/issue-40-tool-schema-delta.json`; the executable full inventory
snapshot remains in `test/tools.test.ts` so descriptor drift fails the suite.

## GPT question orchestration (#68)

`codex_status` (`query.kind: "input"`) accepts an exact `jobId`, optional `afterCursor`, and `waitMs` bounded to 60 seconds. `codex_answer` accepts `requestId`, `jobId`, the current opaque `questionRef`, and an answer map keyed by the exact question IDs. Scope comes from host metadata; neither tool requires a mounted card or exposes upstream targeting overrides. The question reference binds the worker generation, thread, turn, and question revision independently of unrelated Job progress.

`codex_ask_user` accepts an idempotent `requestId`, title, 1–3 questions, and optional expiry of 1–1440 minutes. `codex_user_answer` accepts an optional `responseRef`; omission discovers unread references without consuming the bodies. App-only `codex_ui_read` (`view: "question"`) and `codex_question_action` require the scoped question ID, revision, and private presentation token. The action's closed `submit`, `claim`, and `ack` branches preserve separate storage and delivery states. The previous `codex_question_card`, `codex_question_submit`, and `codex_question_notify` names are retained compatibility calls. See [the complete lifecycle](gpt-questions.md).

### Bridge-owned permissions and project reads (#69 follow-up)

Current `codex_task` has no `sandbox` or approval-policy input. The bridge
uses saved access settings and operator limits; the retained adaptive value
means the configured bridge default for fresh work. Continue/fork preserve the
thread policy and recheck operator limits. The execution-envelope generation
was advanced so unadmitted cached calls cannot silently acquire new authority.
The runtime accepts the retired field only to identify old calls: exact admitted
replays remain available, while new admissions return
`TASK_PERMISSION_INPUT_RETIRED`. No requested-versus-saved conflict exists in
the current execution path.

Resolve a project using `codex_status` with
`query: {kind: "project", name: "<exact user-visible name>"}`. It returns the
opaque current selector without admitting work, loading a model, configuring
permissions, or opening a card. The previous `codex_task.projectLookup` stays
runtime-only for cached clients. Invalid or unavailable names do not select a
fallback. No new tool is registered.
