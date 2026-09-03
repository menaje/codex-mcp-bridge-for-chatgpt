# Output projection contracts

This document defines the output profile established by issue 36, corrected by
issue 38, extended with the issue-40 active-turn steering contract, refined
by issue 41's compact/explicit Activity projections, and extended by issue 42's
bridge-wide read-only Dashboard. ChatGPT is the normative
client. Public `structuredContent` is authoritative for
model/orchestrator decisions and carries a bounded final `answer`; `content`
remains a compatibility copy because some MCP clients consume only that channel.

## Projection boundary

Every result starts as a typed canonical bridge value and crosses the MCP boundary through one of four projections:

| Projection | Consumer | Transport | Authority and purpose |
| --- | --- | --- | --- |
| Model/Orchestrator Semantic | ChatGPT and follow-up tool selection | public `structuredContent` | Authoritative semantic state, IDs, versions, compact execution audit, result availability, bounded final answer, errors, warnings, and next actions |
| App Hydration | Activity, Dashboard, and Settings components | app-only structured content with validated private `_meta` compatibility copies where retained cards require them | Localized editor state, compact automatic or paginated explicit Activity views, read-only Dashboard pages, watcher leases, presentation correlation, and component hydration |
| Operator Diagnostic | Operator UI/runtime | app-only `codex_diagnostics` | Build, auth mode, storage, HMAC, pool, upstream inventory, and bounded forensics |
| Text/Protocol Compatibility | MCP clients that retain `content` and limited text-only clients | `content` | A compatibility copy of the primary Codex answer or a stable bounded summary at the documented support level |

`src/toolResultContracts.ts` types this boundary. Each projection declares its authoritative channel, strict Zod output schema, structured-content byte cap, compatibility format, compatibility byte cap, and completeness level. `projectToolResult()` validates the authoritative value and both byte limits before returning an MCP result. Canonical values are never exposed by spreading them into `structuredContent`.

The channels are independent consumer contracts. Private `_meta` is presentation/hydration data, never authorization or durable state authority. The MCP contract makes both public `structuredContent` and `content` model-visible, but the issue-38 ChatGPT host trace retained only `structuredContent` in the model tool message. A required answer therefore cannot exist only in `content`.

## Public field and channel inventory

| Tool | Model semantic projection | App-only/private projection |
| --- | --- | --- |
| `codex_task` | Contract kind/version, state, terminal/delivery/replay, semantic request/project/Activity/Agent/Job/thread IDs, distinct Job/Activity versions, execution mode/backend/sandbox, compact requested/actual selection audit, conditional reroute, result availability, bounded nullable `answer`, strict error, warnings, and next actions | None. Task execution has no UI binding or private Activity bootstrap; no public `bridgeSession`, `bridgeActivity`, `activityTracking`, or presentation-hydration leaf remains |
| `codex_settings` | Revisions, compact active policy summary, path-free project availability, catalog availability/count, warnings, and next actions | The public result contains locale metadata but no editor view. App-only `codex_settings_snapshot` is the current card's fresh full editor source; `codex_update_settings` returns the committed full editor view after a mutation. Both app-only results retain a validated `_meta["codex/settingsView"]` compatibility copy for older cards |
| `codex_status` | One compact closed envelope containing query kind, scope mode/source, counts, optional page data, strict typed items, wait outcome, result/error availability, warnings, and next actions. Only an exact completed Job item carries `answer`; summary queries expose an exact-Job retrieval action instead of bodies | Activity components refresh through `codex_activity_snapshot`; routine status is not a hydration or diagnostic API |
| `codex_dashboard` | Closed five-field aggregate summary: bridge-wide, read-only, Codex-runtime-only status source, and a redacted retained-state summary. No cross-scope rows enter model-visible structured content | The public result contains locale metadata but no Dashboard view. App-only `codex_dashboard_snapshot` is the sole current source of `_meta["codex/dashboardView@1"]` and active/recent/idle pages with hashed row/project/conversation keys and optional validated navigation candidates. Larger project/conversation pages are emitted only for older cards that send compatibility offsets. Project/Job/Activity/Agent/thread/worker/process IDs, paths, prompts, results, GPT judgments, controls, watchers, and handoff state remain absent |
| `codex_activity` | Presentation mode, optional Activity identity/version, and exact scoped aggregate counts only | `mode: compact-monitor` returns one automatic `_meta["codex/activityView@11"]` presentation after Task fan-out; the default `full-history` mode returns the explicit paginated view. Automatic snapshots use compact current rows plus exact history counts. `codex_activity_rehydrate` reconstructs either an older retained Task shell from exact Job/request hints or a cold full-history card from its public mode and optional Activity identity/version |
| `codex_models` | Neutral descriptors for only the current policy-allowed models, efforts, and service-tier support, including upstream descriptions and source/freshness; no policy summary, Priority state, recommendation, rank, default, or fallback | None |
| `codex_steer` | Closed mutation result with exact compact Job/version, `active-codex-turn-only` scope, prompt-persistence assertion, `delivered | not-delivered | uncertain` delivery state, structured error, warnings, and next actions | None; the existing card-only `codex_job_steer` retains its separate lease-bound contract |
| `codex_agent`, `codex_cancel`, `codex_activity_update`, `codex_activity_cancel` | Closed mutation envelope with action/outcome, strict typed target, bounded warnings/next actions, and affected IDs where relevant | Full lifecycle, cancellation provenance, process controls, and recovery data stay in bridge state or model-hidden app-only tools. Activity and Dashboard snapshots may separately project a bounded, initially collapsed model-tool cancellation explanation; a Job-target entry may include its Agent display name but no Agent ID |

Worker/process evidence, catalog fingerprints, bridge-instance data, project UUIDs/paths, HMAC state, and upstream inventory are absent from model-visible results. `structuredContent` is the implementation and test source of truth; tests do not parse `content[0].text` to reconstruct structured fields.

## Strict public envelopes

All eleven model-visible output roots publish JSON Schema with
`additionalProperties: false`. Every public success or returned structured-error
value is parsed through the corresponding strict runtime Zod schema before it
crosses MCP. Nested public objects are also closed; the final public schemas
contain no opaque/open object leaves. `codex_task` additionally publishes every
declared field in `required`; unavailable semantics are explicit `null` values.
This is the host-compatible strict structured-output form that restored the
complete ChatGPT tool inventory.

The published schemas omit redundant JSON Schema keywords where `const` or `enum` already closes the value and where the runtime validator owns numeric bounds. This reduces descriptor bytes without weakening object closure or runtime validation.

The exhaustive fixture harness covers:

- setup, replay, running, completed, failed, and cancelled `codex_task` forms;
- status overview, running, completed-answer, and failed forms;
- compact Settings, models, and Activity results;
- the compact Dashboard aggregate fallback plus bounded private cross-scope view;
- success and structured failure mutation envelopes;
- active-turn steering delivery and crash-boundary uncertainty envelopes;
- generation 11 private view validation, retained legacy-bootstrap validation, historical/full-history rehydrate schemas, and size limits;
- documented task/status/error/cancel text-compatibility content.

The `codex_task` envelope has these invariants:

- `state` and `terminal` identify bridge Job state explicitly.
- `delivery` distinguishes status, primary content, omitted content, and no content.
- `replay` distinguishes exact admitted replay from a new delivery.
- `jobVersion` and `activityVersion` remain distinct flat fields.
- `executionMode`, `backend`, and `sandbox` retain execution semantics.
- `requestedModel`, `requestedReasoningEffort`, `actualModel`, and `actualReasoningEffort` retain the compact selection audit; `rerouted` is always explicit and `rerouteReason` is nullable.
- `resultAvailability` and `resultOmitted` communicate pending/delivered/omitted/unavailable semantics independently from the answer text.
- `answer` is non-null exactly when `resultAvailability` is `delivered`. It is bounded to 24 KiB of JSON-encoded UTF-8 so escaping cannot violate the 32 KiB task envelope; truncation adds an explicit marker and warning.
- nullable IDs, execution fields, audit fields, and `error` make setup and terminal variants use the same all-required envelope without optional-property schema ambiguity.
- a completed retained answer appears in model-authoritative structured `answer`; the original primary `content` is intentionally retained as a compatibility copy for clients with the inverse channel behavior.

Setup rejection uses the same task envelope with `state: "setup-required"`, unavailable result semantics, and a strict structured error. Failed and cancelled forms use the same closed error/result contracts.

The `codex_steer` envelope has these additional invariants:

- success requires `code: null`, a non-null exact compact Job, and
  `delivery.status: "delivered"`;
- failure requires a structured code and cannot claim delivered;
- `DELIVERY_UNCERTAIN` is equivalent to `delivery.status: "uncertain"`; every
  other failure is `not-delivered`;
- `promptPersistedByBridge` is always `false`, and
  `steeringScope` is always `active-codex-turn-only`;
- `content` is only a bounded stable outcome summary. The structured envelope is
  authoritative and never includes the prompt or its digest;
- if Codex reflects the exact steering input through progress, events, an error,
  or its final result, Bridge projections replace that echo before Job
  persistence and model-visible output.

## Issue 38 ChatGPT host trace and retrieval contract

The authenticated raw ChatGPT conversation response for the reported failure was inspected on 2026-08-28. GPT first called `codex_status` with an exact completed Job query. The bridge SQLite row retained the original multi-section `content[0].text`, reported `resultOmitted: false`, and returned `delivery: "primary-content"`. The persisted ChatGPT tool message nevertheless contained only the JSON serialization of `structuredContent`; neither the primary `content` text nor private `_meta` appeared in the model message.

GPT then created a new foreground `codex_task` solely to reconstruct the report. That Job also completed with a retained multi-section result, but its ChatGPT tool message again contained only the structured state envelope. This proves the failure was after bridge generation/retention and before the model-visible ChatGPT message, not an Activity UI handoff, Codex execution, or retention-limit failure. The sanitized trace record is in `docs/audits/issue-38-chatgpt-host-trace.md`.

The corrected contract subsequently passed an authenticated ChatGPT Work smoke
for both direct foreground delivery and one background exact-Job wait, without
creating a reconstruction Job. The same run verified the connector-discovered
input schemas and cold-reentered both the new smoke conversation and the
original reported conversation. The sanitized post-fix record is in
`docs/audits/issue-38-chatgpt-live-smoke.md`.

The corrected retrieval rules are:

- foreground completion: read `codex_task.structuredContent.answer`;
- background completion or recovery: call `codex_status` for each exact Job ID and read that Job item's `answer`;
- overview, Activity, thread, and page status: use them only for state/ID discovery and follow their exact-Job retrieval actions;
- `omitted` and `unavailable`: keep `answer` absent and report the corresponding state;
- `delivered` without `answer`: treat as an output-contract or host-delivery failure and never create a re-report Job merely to reconstruct retained output.

The runtime projection enforces the corresponding cross-field invariants even
though the shared compact status item schema keeps `answer` optional for summary
rows: an exact delivered Job must have one non-empty bounded `answer`; an exact
non-delivered Job cannot have one; and Activity, thread, page, or overview
summaries cannot embed answer bodies and must attach the exact-Job retrieval
action to every delivered Job. This prevents a future projection refactor from
recreating the issue-38 channel loss while still keeping summary payloads small.

## Generation 11 private Activity contracts

Generation 11 defines two versioned, closed component-private payloads:

- `_meta["codex/activityView@11"]` carries an exact source discriminator, scope version, mounted Activity/presentation correlation, and the validated Activity view used by compact-monitor initial hydration, explicit full-history hydration, snapshot/watch refresh, historical one-shot rehydration, or restored full-history one-shot rehydration.
- `_meta["codex/activityBootstrap@11"]` is retained only for immutable pre-decoupling Task resources. New `codex_task` descriptors and results never emit it.

Both retained envelopes require `purpose: "presentation-hydration-only"`, exact discriminator/version 11, bounded identities, and runtime byte limits of 8 KiB and 768 KiB. Complete MCP private metadata is capped at 1 MiB. New compact and explicit cards normally hydrate directly from the dedicated `codex_activity` result and refresh through validated app-only snapshot/watch results. When a cold-remounted older Task shell lacks its original private bootstrap, `codex_activity_rehydrate` accepts public `jobId + requestId` lookup hints, derives host scope, revalidates the retained call/Activity/current visibility, and returns a `historical` mounted-presentation correlation. When a cold-remounted explicit Activity card retains only its strict public summary, the same endpoint accepts `mode: "full-history"` plus optional Activity identity/version hints, revalidates them against the host-derived scope, and returns a `restored-explicit` full projection. Both forms have `live: false`, `ownsCompletionHandoff: false`, empty controls, and no lease or presentation-registry mutation. The model-visible full Activity view fallback remains retired.

The view's `feed.mode` is `compact` for automatic and historical presentations and `full` for explicit and restored-explicit presentations. Compact projection includes current/action-needed Activity rows, at most three recent terminal/idle Activity rows, and at most three idle-Agent rows not already represented by those Activities, plus exact `{ completedActivities, endedActivities, idleAgents }` totals. Its legacy Activity/Agent arrays and completed/ended/idle row collections remain empty. Full projection pages every scoped Activity representative row and the idle-Agent section with an opaque scope-version cursor, exact totals, previous/next cursors, and a reset marker. It never embeds Job answers, raw events, full paths, worker data, or diagnostics. The model-visible `codex_activity` result remains only mode, optional identity/version, and exact counts.

Private metadata never grants access. Neither rehydration form grants mutation authority; only a user-triggered refresh from a rehydrated card may establish the existing explicit lease. Snapshot, handoff, cancellation, steering, interaction response, and background-process termination revalidate scope, mounted widget identity, Activity/card generation, presentation lease, ownership, and optimistic versions on the server. Rehydration persists no bootstrap payload and does not extend Job/Activity retention.

## Generation 1 private Dashboard envelope and generation 17 UI

`_meta["codex/dashboardView@1"]` is a closed, 512-KiB-bounded snapshot envelope with purpose `bridge-wide-read-only-hydration`. The current public `codex_dashboard` result does not emit this envelope; only the mounted app-private snapshot does. Its view declares `coverage: "bridge-known-retained"`, a closed `enrichment` state/counter object, aggregate retained-state counts, confirmed background-process totals, explicit unknown/skipped runtime-probe counts, active/recent/idle row pages, and the UI locale preference. Each representative row is limited to opaque hashed row/project/conversation keys, a compatibility conversation alias, optional validated Codex and best-effort ChatGPT route candidates, display context, one Codex-runtime status, a presentation bucket, timestamps, elapsed time, an integer background-process count, and an optional effective execution selection. The stable row key is derived privately from Agent identity—or from Job identity for an unassigned Job—and is never rendered. It lets the UI evict a stale in-mount copy when the representative changes bucket or display text. The project key is derived from the private immutable project identity when available, with a normalized label or one unassigned bucket only as a compatibility fallback; source identities and paths never leave server state.

Generation 3 added `latestTurn` plus older retained `history` entries without Agent, Job, Activity, thread, or execution identifiers. Generations 4 and 5 added conversation and project grouping pages. Generation 7 introduced the fixed `active → recent terminal → idle` order. Generation 12 makes active and recent presentation Activity-first: each row carries an opaque hashed `activityKey`, same-title Activities remain distinct, and matching Agent rows render below their Activity. Generation 13 removes initial tool-result hydration: a cold mount keeps the content hidden behind loading, ignores cached tool-result notifications/globals, and first renders only after a fresh `codex_dashboard_snapshot` succeeds. Generation 14 carries the opaque Activity key into retained turns and pages active/recent rows on whole-Activity boundaries. A page limit remains an Agent-row target and may be exceeded by one indivisible Activity. It also invalidates a mounted view before a page re-entry older than one second or a visibility return older than thirty seconds, so a failed fresh load cannot repaint the discarded stale rows. Generation 15 removes the Agent-derived Activity-heading status and renders every Codex turn state only on its owning Agent row. Generation 16 splits structural data from optional runtime/usage enrichment and embeds only card-specific translations. Generation 17 applies Activity-first rendering and whole-Activity paging to idle Agents as well, labels those groups as latest rather than current Activity, and groups Agents with no retained Activity by conversation/project fallback. Shared historical and next-run execution selections render once at Activity level only when every nested Agent matches exactly. An ordinary in-place refresh failure after one successful snapshot still retains only that mounted iframe's last successful view; an enrichment failure retains the newly rendered structural view. Normal current snapshots omit the larger legacy group pages. The server emits them only when an immutable generation-4–6 card sends `conversationOffset` or `projectOffset`, so older resources can still refresh without imposing their payload cost on new cards. Recent and idle pages initially target 20 representative Agents and append later pages through **Show more**. A response whose offset was clamped replaces that bucket instead of merging incompatible pages, and current active/terminal evidence evicts stale in-mount copies. The idle section starts collapsed on each fresh card and retains its disclosure state through ordinary mounted refreshes.

Within every status section, the Activity title heads the group and Agent display names head its nested rows. Idle uses the latest retained Activity as historical context; it does not recreate a current assignment. Result-bearing Jobs retain full Dashboard turn data while ordinary retention pruning writes only a result-free summary: Job/scope/Activity correlation, Agent/backend columns already held by SQLite, terminal status/update time, optional start time, and exact effective model/effort plus reroute when known. It never retains prompt, result, error, command, or public-event bodies for this purpose. Each current and retained turn may carry the same opaque `activityKey` used for grouping, so same-title Activities remain distinct and the current Activity title is not repeated in its own expanded Agent history. The Dashboard reads at most 10,000 archived summaries, sends at most 12 older turns per visible Agent, and reports the full history count. Pre-generation-7 summaries can therefore have null start/duration and no execution; the UI shows work time unavailable and never substitutes the current session selection as historical fact. An idle or recovery row may separately expose its current tracked-session selection with `isCurrent: true`.

Retained history starts collapsed and expands below the same Agent without exposing an Agent ID or display alias; its in-memory disclosure state survives ordinary snapshot refreshes in the mounted iframe. Session, thread, and compatibility identifiers are never printed as text. **Open in Codex** requires the exact selected App Server thread to match a retained tracked session and yield a UUID-shaped route. That matching session's creation-time visibility bit controls the link; the current preference is a compatibility fallback only when the matching legacy session lacks the bit. Missing, mismatched, hidden, non-App-Server, or other value shapes are omitted. The exact thread UUID takes precedence over the matching session-tree UUID because forked threads can share the latter. OpenAI separately defines `openai/session` as an anonymized correlation value, not a navigable-route guarantee. When a UUID-shaped host value is captured, every Activity group renders one best-effort **Open conversation** link in its context. GPT navigation is independent of the Codex-app visibility preference. Neither route is probed, and previously retained ChatGPT scopes cannot be backfilled without the deliberately unretained raw host value. The Dashboard CSP permits `codex://threads` and `https://chatgpt.com` for `window.openai.openExternal`, while anchors remain the fallback. Active timing shows only start-to-now work time. A terminal or idle retained turn shows start-to-terminal work time when known plus time since that exact outcome; absolute start, status-update, and end timestamps are not rendered. Model selection renders as `model · effort`, or `selected → rerouted · effort` when Codex reports a reroute. The fresh-snapshot decoder accepts private metadata as a raw map or inside complete `mcp_tool_result` or `call_tool_result` wrappers, including JSON-encoded nested results.

The status mapper consults only retained Job state and tracking liveness, pending Codex interactions, Agent lifecycle, and bounded read-only App Server thread/background-terminal evidence. Model/effort presentation does not participate in status calculation. Activity lifecycle, waiting, verification, completion handoff, and GPT completion judgment are neither fields nor inputs to that mapper. `completed` means exactly a completed Job; failed, interrupted, and cancelled remain distinct. The attention count is deduplicated by Agent from the latest retained outcome, so an earlier failure is cleared by a later running or completed retry.

The coverage set is the union of conversation scopes still known from live Jobs, bounded archived summaries, non-archived Agents, or tracked threads; it is not the ChatGPT account's complete history. `counts.trackedProjects` is independent of that row coverage: it counts active, non-deleted project registrations, includes an active registration whose folder is temporarily unavailable, and excludes archived/deleted registrations plus the unassigned compatibility bucket. Retained rows keep their admitted project snapshot after archive or registration deletion. The public `codex_dashboard` tool needs no capability flag, returns a redacted aggregate summary with locale-only app metadata, does not read weekly usage, and defers App Server probing. App-only `codex_dashboard_snapshot` verifies mounted-widget correlation, validates any supplied host or compatibility scope, and permits mounted recovery without scope metadata because web and desktop hosts can omit it during remount. Generation 16 explicitly sends `enrich: false` to read only structural bridge state, uses an immediately available ChatGPT compatibility call for cold structure while standard MCP Apps initialization proceeds, then requests `enrich: true`. Omission preserves the enriched response expected by immutable older cards. After the first fresh snapshot, an ordinary in-place refresh failure retains that last snapshot and disables automatic retry until explicit refresh; a stale page/visibility re-entry invalidates it before loading.

Enrichment considers as many as 200 non-archived App Server Agents, independently of the currently displayed page. Visible/active candidates receive liveness inspection, while the remaining candidates use the loaded-thread-only terminal inventory needed to discover an off-page background process without resuming historical threads. The two candidate classes use independent worker pools so slow liveness reads cannot starve background-process discovery. It uses at most eight workers, a 1.5-second per-probe timeout, a six-second overall runtime budget, and a separate 1.5-second weekly-usage timeout. A worker whose uncancellable request times out launches no further request. Confirmed observations are fresh-cached for five seconds and retained as last-known evidence for 15 minutes using a backend/thread plus Agent/Job-generation stamp; a successful background-process mutation invalidates its thread entry. Weekly usage is fresh-cached for one minute and retained for 30 minutes. Structural snapshots reuse matching retained evidence without making upstream calls, so periodic refresh does not transiently remove usage, process counts, or their resulting row order. A new definitive orphaned observation replaces retained evidence; timeout or transient unknown evidence leaves the last successful value in place and remains visible through the enrichment counters. Runtime inspection never follows `notLoaded` with `thread/resume`. Neither structural nor enriched snapshots create a Dashboard lease, long poll, control authority, or persistence.

Project labels, Agent names, and Activity titles are user-defined display context and may reveal task meaning across conversations even though identifiers and payload bodies are redacted. This projection is therefore for the bridge's single trusted user. The widget-instance UUID proves only mounted-card correlation and is not authentication or authorization.

The current Dashboard descriptor requires generation 17 at the content-hashed URI recorded in `ui-manifest.lock.json`. Retained immutable Dashboard resources remain registered according to the lock-file compatibility policy; generation-4–6 offset calls receive their conditional grouping projections.

The minimum Activity generation for new descriptors is 12. The current immutable resource is generation 24 at the content-hashed URI recorded in `ui-manifest.lock.json`. Every retained immutable Activity URI from generations 7–24 remains registered and refreshes through its compatible app-only path. Retained HTML assets are not rewritten or deleted when the minimum advances. UI generation 19 normalizes supported host-result wrappers and exposes retryable hydration failures. Generation 20 retains the generation-11 private bootstrap/view envelopes and paints structural data first. Generation 21 also requests bounded enrichment for a historical one-shot view through its exact Job/request correlation. Generation 22 retains per-Agent work duration, hoists exact execution details shared by all nested Agents, and groups full-history idle Agents by latest Activity while suppressing copies already nested under a visible Activity. Generation 23 adds bounded recent and distinct idle detail to compact cards, with recent Activities expanded and idle Agents collapsed by default. Generation 24 reconstructs a cold full-history result from its strict public mode and optional Activity identity/version, keeps that reconstruction paginatable but one-shot and non-owning, bounds both host transports, dispatches enrichment before the long watch, rejects stale async responses, coalesces rapid refresh clicks, and retains the last successful structural view when refresh or enrichment fails. Rehydrated views remain read-only and non-owning: enrichment grants no watcher, handoff, control lease, or mutation authority.

## Card performance and byte budgets

Every Dashboard and Activity view carries `enrichment: { state, runtimeRequests, cacheHits, timeouts, durationMs, usageTimedOut }`. `codex_diagnostics.performance` reports bounded recent samples for structural projection, enrichment, and serialization with count, p50, p95, max, requests, timeouts, and cache hits. It also reports measured self-contained HTML bytes against fixed caps: Dashboard 112 KiB, Activity 152 KiB, and Settings 192 KiB. The existing hydration limits remain runtime-enforced and regression-tested: Dashboard private view 512 KiB, Activity private view 768 KiB, and app-only structured hydration 1 MiB. Sizes are UTF-8 bytes of `JSON.stringify(value)` for data and raw UTF-8 bytes for HTML.

## Opaque-leaf policy

Model-visible schemas have no opaque/open object leaves. A public object must have a named, closed schema with `additionalProperties: false`; arbitrary upstream, component, protocol, or forensic objects cannot be copied into it.

Opaque leaves are permitted only on private/app-only/operator projections whose consumer owns the nested shape. Examples are full Activity rows in validated private hydration, tool-specific arguments in app-only next actions, and backend-specific diagnostic leaves. They remain bounded by their parent contract, sanitized before projection, and are never authorization inputs.

Adding a private opaque leaf requires naming its consumer, documenting sanitization and its parent byte cap, and adding a fixture. It is never a reason to loosen a public envelope.

## Text compatibility profile

Generic pretty-JSON duplication is prohibited. The one deliberate duplicate is a retained primary answer: ChatGPT requires its bounded structured `answer`, while compatibility clients may require the original `content`. Other semantic envelopes are not copied into text.

| Public tool/result | `content` format | Maximum UTF-8 bytes | Text-only support |
| --- | --- | ---: | --- |
| `codex_task` completed with retained result | Original primary upstream content | Configured retained-result limit | Compatibility copy; ChatGPT uses bounded `structuredContent.answer` |
| `codex_task` running/replay/setup | Stable plain-text state/error summary | 1,024 for state; 1,536 for error | State/error and immediate next step only |
| `codex_status` routine/exact non-result | Stable plain-text query summary | 1,024 | State/count/error summary only |
| `codex_status` exact completed retained result | Original primary upstream content | Configured retained-result limit | Compatibility copy; ChatGPT uses the exact Job item's bounded `answer` |
| `codex_dashboard` | Stable retained-state aggregate/card-open summary | 512 | Aggregate fallback only; no cross-scope rows, labels, or identifiers. The mounted app waits for a fresh private snapshot |
| `codex_settings` | Stable revision/project/warning summary | 768 | No full editor, catalog, or registry |
| `codex_activity` | Stable Activity-count/open summary | 1,024 | No full feed or watcher/presentation data |
| `codex_models` | Stable catalog count/source/freshness summary | 512 | No complete model descriptors |
| `codex_agent`, `codex_activity_update` | Stable mutation outcome | 512 | Action/outcome only |
| `codex_activity_cancel`, `codex_cancel` | Stable cancellation outcome/error | 768 | Action/outcome/error only |
| `codex_steer` | Stable delivery outcome/error | 768 | Delivery state and error only; no prompt or full Job state |

The default profile does not promise generic text-only completeness for Settings, Activity feeds, status pages, model descriptors, audit details, or full mutation details. A future complete text-only profile requires an explicit versioned compatibility contract and must not reintroduce public JSON duplication.

## Settings, status, diagnostics, and health

The public Settings result is path-free and UUID-free. Its full localized view is parsed through the private validator before entering `_meta`; app-only saves refresh that private editor metadata.

Routine `codex_status` is independent from upstream tool inventory and operator-diagnostic failures. `codex_diagnostics` is model-hidden/app-only and owns build/auth/backend, storage, HMAC, pool/retention, upstream inventory/error, and bounded forensic warnings. `/healthz` is intentionally limited to `ok`, runtime name, and title.

## Budget methodology and final evidence

All sizes use:

```text
Buffer.byteLength(JSON.stringify(value), "utf8")
```

Schema bytes are measured separately for model-visible and app-only tools. Result bytes are measured separately for `structuredContent`, `content`, and `_meta`; schema bytes are not added to result bytes. Deterministic fixtures report min/max structured bytes, each text fixture's bytes/cap, and generation 11 private bootstrap/view bytes.

Run the audit with:

```bash
npx tsx scripts/output-contract-audit.ts
npx tsx scripts/output-contract-audit.ts --check
```

The checked artifact is `docs/audits/issue-36-output-contract-baseline.json`,
now audit version 3 with issue-38 regression and issue-40 steering evidence. The
pre-issue-40 model-visible set remains 12,009 bytes: 8,119 bytes smaller than
the 20,128-byte issue-36 baseline, a 40.337% reduction, and 68 bytes below its
12,077-byte W3 ceiling. The additive `codex_steer` schema is 1,360 bytes, making
the ten-tool total 13,369 bytes against a correspondingly additive 13,437-byte
ceiling, again with 68 bytes of headroom. Every model-visible output
`const`/`enum` leaf retains an explicit primitive type, including nullable enum
nodes. The Task output contract remains the single-value string enum `["1"]`;
the independent stable Task input contract is generation 2. Task
audit source/evidence and result byte accounting remain canonical/operator data;
the model projection keeps flat requested/actual model and effort, an explicit
reroute flag, a nullable reason, and the bounded answer. The discovery regression
suite also requires every `codex_task` property, including `answer` and every
error property, to be published in `required`; caps its output at 2,500 bytes
and stable generic input plus output at 9,500 bytes; and avoids top-level
conditional composition. Issue #43 separately caps the complete serialized
descriptor at 128 KiB and proves it stays byte-identical across settings,
project-registry/availability, and catalog changes. These caps are empirical ChatGPT compatibility
guards, not documented platform limits; the execution boundary still enforces
every context-sensitive project and model requirement.

M1 passed in a real ChatGPT Work conversation: generation 11 mounted at the current URI, rendered completed work, refreshed its snapshot, and a retained generation 10 resource resolved. Exact raw host metadata bytes were not supplied, so the audit records functional evidence and deterministic private-metadata bytes without inventing a host capture.

M2 also passed after a local build/restart and ChatGPT Developer-mode plugin refresh. A new Work conversation returned `ISSUE36_M2_OK` through a foreground `codex_task`; generation 11 hydrated and refreshed; Settings hydrated; a background task completed; two same-response sibling tasks shared one presentation and elected the newest mounted card; a later response superseded that card; and an existing generation 10 conversation at `ui://codex-mcp-bridge/activity/b4725cb7de0b.html` hydrated and refreshed. The real-host foreground/background/sibling/next-response Jobs all reached `completed` with their expected retained results.

Issue 38 adds deterministic foreground and exact-Job structured-only consumer probes with `ISSUE38_FOREGROUND_SENTINEL` and `ISSUE38_BACKGROUND_SENTINEL`, an escaping-heavy truncation probe, omitted/unavailable separation, and summary-to-exact retrieval checks. The authenticated pre-fix host trace is recorded separately because it demonstrates why a bridge-level object test that sees both MCP channels was insufficient.

Issue 40 adds strict delivered/uncertain steering fixtures, discovery inventory
checks for the exact four-field public input, cross-field output validation,
same-scope active App Server, stale/terminal/MCP/cancel/interaction regressions,
a persistent dispatch-boundary restart probe, a host-derived scope composition
probe, and an adversarial exact-prompt echo probe across progress, event, final
result, public status, and SQLite bytes. The authenticated App Server 0.145.0 run
passed active delivery, stale rejection, exact replay, terminal rejection,
single-turn behavior, and raw-prompt absence; its sanitized record is
`docs/audits/issue-40-app-server-canary.md`. The focused public discovery delta
is `docs/audits/issue-40-tool-schema-delta.json`. Deterministic crash-boundary
fixtures remain distinct from the live-host evidence, and neither is represented
as a distributed exactly-once guarantee.
