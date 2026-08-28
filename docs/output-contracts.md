# Output projection contracts

This document defines the output profile established by issue 36, corrected by
issue 38, and extended with the issue-40 active-turn steering contract. ChatGPT
is the normative client. Public `structuredContent` is authoritative for
model/orchestrator decisions and carries a bounded final `answer`; `content`
remains a compatibility copy because some MCP clients consume only that channel.

## Projection boundary

Every result starts as a typed canonical bridge value and crosses the MCP boundary through one of four projections:

| Projection | Consumer | Transport | Authority and purpose |
| --- | --- | --- | --- |
| Model/Orchestrator Semantic | ChatGPT and follow-up tool selection | public `structuredContent` | Authoritative semantic state, IDs, versions, compact execution audit, result availability, bounded final answer, errors, warnings, and next actions |
| App Hydration | Activity and Settings components | validated private `_meta` and app-only tools | Localized editor state, compact automatic or paginated explicit Activity views, watcher leases, presentation correlation, and component hydration |
| Operator Diagnostic | Operator UI/runtime | app-only `codex_diagnostics` | Build, auth mode, storage, HMAC, pool, upstream inventory, and bounded forensics |
| Text/Protocol Compatibility | MCP clients that retain `content` and limited text-only clients | `content` | A compatibility copy of the primary Codex answer or a stable bounded summary at the documented support level |

`src/toolResultContracts.ts` types this boundary. Each projection declares its authoritative channel, strict Zod output schema, structured-content byte cap, compatibility format, compatibility byte cap, and completeness level. `projectToolResult()` validates the authoritative value and both byte limits before returning an MCP result. Canonical values are never exposed by spreading them into `structuredContent`.

The channels are independent consumer contracts. Private `_meta` is presentation/hydration data, never authorization or durable state authority. The MCP contract makes both public `structuredContent` and `content` model-visible, but the issue-38 ChatGPT host trace retained only `structuredContent` in the model tool message. A required answer therefore cannot exist only in `content`.

## Public field and channel inventory

| Tool | Model semantic projection | App-only/private projection |
| --- | --- | --- |
| `codex_task` | Contract kind/version, state, terminal/delivery/replay, semantic request/project/Activity/Agent/Job/thread IDs, distinct Job/Activity versions, execution mode/backend/sandbox, compact requested/actual selection audit, conditional reroute, result availability, bounded nullable `answer`, strict error, warnings, and next actions | Generation 11 automatic mount data is only `_meta["codex/activityBootstrap@11"]`; no public `bridgeSession`, `bridgeActivity`, `activityTracking`, or presentation-hydration leaf remains |
| `codex_settings` | Revisions, compact active policy summary, path-free project availability, catalog availability/count, warnings, and next actions | Full localized editor view is validated at `_meta["codex/settingsView"]` |
| `codex_status` | One compact closed envelope containing query kind, scope mode/source, counts, optional page data, strict typed items, wait outcome, result/error availability, warnings, and next actions. Only an exact completed Job item carries `answer`; summary queries expose an exact-Job retrieval action instead of bodies | Activity components refresh through `codex_activity_snapshot`; routine status is not a hydration or diagnostic API |
| `codex_activity` | Activity identity/version and aggregate counts only | The full validated view is `_meta["codex/activityView@11"]`; `codex_activity_snapshot` owns live refresh, while `codex_activity_rehydrate` reconstructs only a one-shot historical view from an exact retained Task correlation |
| `codex_models` | Compact selectable model descriptors, active policy summary, and Priority state | None |
| `codex_steer` | Closed mutation result with exact compact Job/version, `active-codex-turn-only` scope, prompt-persistence assertion, `delivered | not-delivered | uncertain` delivery state, structured error, warnings, and next actions | None; the existing card-only `codex_job_steer` retains its separate lease-bound contract |
| `codex_agent`, `codex_cancel`, `codex_activity_update`, `codex_activity_cancel` | Closed mutation envelope with action/outcome, strict typed target, bounded warnings/next actions, and affected IDs where relevant | Full lifecycle, cancellation provenance, process controls, and recovery data stay in bridge state or model-hidden app-only tools |

Worker/process evidence, catalog fingerprints, bridge-instance data, project UUIDs/paths, HMAC state, and upstream inventory are absent from model-visible results. `structuredContent` is the implementation and test source of truth; tests do not parse `content[0].text` to reconstruct structured fields.

## Strict public envelopes

All ten model-visible output roots publish JSON Schema with
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
- success and structured failure mutation envelopes;
- active-turn steering delivery and crash-boundary uncertainty envelopes;
- generation 11 private bootstrap/view validation, historical rehydrate schema, and size limits;
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

- `_meta["codex/activityBootstrap@11"]` carries exact request, presentation, Job, Activity, card-generation, render-reason, and render-timing correlation for automatic initial mount.
- `_meta["codex/activityView@11"]` carries an exact source discriminator, scope version, mounted Activity/presentation correlation, and the validated Activity view used by initial hydration, snapshot/watch refresh, or historical one-shot rehydration.

Both require `purpose: "presentation-hydration-only"`, exact discriminator/version 11, bounded identities, and runtime byte limits of 8 KiB and 768 KiB. Complete MCP private metadata is capped at 1 MiB. Generation 11 reads private metadata for initial model-tool hydration; live refreshes use validated app-only snapshot/watch results. When a cold-remounted historical Task shell lacks its original private bootstrap, `codex_activity_rehydrate` accepts only public `jobId + requestId` lookup hints, derives host scope, revalidates the retained call/Activity/current visibility, and returns a `historical` mounted-presentation correlation with `live: false`, `ownsCompletionHandoff: false`, empty controls, and no lease or presentation-registry mutation. The model-visible Activity view fallback remains retired.

The view's `feed.mode` is `compact` for automatic and historical presentations and `full` for explicit presentations. Compact projection includes current/action-needed Activity rows and `{ completedActivities, endedActivities, idleAgents }`; its legacy Activity/Agent arrays and completed/ended/idle row collections are empty. Full projection pages every scoped Activity representative row and the idle-Agent section with an opaque scope-version cursor, exact totals, previous/next cursors, and a reset marker. It never embeds Job answers, raw events, full paths, worker data, or diagnostics. The model-visible `codex_activity` result remains only identity/version and exact counts.

Private metadata never grants access. Historical rehydration also grants no mutation authority; only a user-triggered refresh may establish the existing explicit lease. Snapshot, handoff, cancellation, steering, interaction response, and background-process termination revalidate scope, mounted widget identity, Activity/card generation, presentation lease, ownership, and optimistic versions on the server. Rehydration persists no bootstrap payload and does not extend Job/Activity retention.

The minimum Activity generation for new descriptors is now 12. The current immutable resource is generation 12 at `ui://codex-mcp-bridge/activity/339d1ebfbd91.html`. All 15 retained immutable Activity URIs from generations 7–11 remain registered and refresh through app-only snapshot/watch paths; together with the current resource, 16 Activity resources are registered. Retained HTML assets are not rewritten or deleted when the minimum advances. UI generation 12 continues to validate the generation-11 private bootstrap/view envelopes above.

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
nodes. The task contract version is the single-value string enum `["1"]`. Task
audit source/evidence and result byte accounting remain canonical/operator data;
the model projection keeps flat requested/actual model and effort, an explicit
reroute flag, a nullable reason, and the bounded answer. The discovery regression
suite also requires every `codex_task` property, including `answer` and every
error property, to be published in `required`; caps its output at 2,500 bytes
and input plus output at 9,500 bytes; and avoids top-level conditional
composition. These caps are empirical ChatGPT compatibility guards, not
documented platform limits; the execution boundary still enforces every
context-sensitive project and model requirement.

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
