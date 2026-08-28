# Connect Codex MCP Bridge for ChatGPT

> [!WARNING]
> The stable default backend is `mcp-server`. App Server is experimental and is
> not officially supported for production workloads. Enable it only for personal
> or development use with monitoring and rollback ownership. Roll back by restoring
> `CODEX_MCP_BRIDGE_DEFAULT_BACKEND=mcp-server` and restarting the bridge; existing
> App Server Agents remain pinned to their original backend.

## 1. Prepare Codex and the bridge

Confirm that Codex is installed and authenticated:

```bash
codex --version
codex mcp-server --help
codex app-server --help
```

The App Server path fails closed unless `codex --version` matches the exact
`toolchain.codexCli` value in `release-manifest.json` (currently `0.145.0`).
The stable MCP backend does not perform this App Server admission check.

Install and verify the bridge:

```bash
npm ci
npm run check
```

## 2. Create the Secure MCP Tunnel

Create an MCP tunnel in OpenAI Platform and associate it with the ChatGPT workspace that will use it. The operator needs applicable Tunnel Read/Use permissions and ChatGPT Developer mode. Keep the runtime key and tunnel ID outside Git.

```bash
install -d -m 700 "$HOME/.config/codex-mcp-bridge"
install -m 600 .env.example "$HOME/.config/codex-mcp-bridge/.env"

# Replace the CONTROL_PLANE_API_KEY and CONTROL_PLANE_TUNNEL_ID examples.
${EDITOR:-vi} "$HOME/.config/codex-mcp-bridge/.env"

npm run bridge:secure
```

The launcher reads that dotenv file automatically. Use `--env-file <path>` or
`CODEX_MCP_BRIDGE_ENV_FILE` only for an explicit alternate location. It rejects
symlinks, files owned by another user, and group/world-readable permissions.
Do not place the runtime dotenv file inside a registered project: the bridge's
secret-filename preflight intentionally rejects project folders containing
`.env`.

The launcher deliberately does not choose a filesystem project. After the
connection is available, register one or more existing absolute folders in the
Settings card. They may be unrelated locations anywhere on this PC. GPT receives
only their names plus a registry freshness generation, never internal UUIDs or
paths.

The default capability profile is read-only. To allow adaptive mutation choices without changing the saved default:

```bash
npm run bridge:secure -- --allow-write
npm run bridge:secure -- --allow-full-access
```

Use `CODEX_MCP_BRIDGE_APPROVAL_POLICY=never` only when a trusted private ChatGPT plugin permission is deliberately the single approval boundary.

## 3. Add or refresh the ChatGPT plugin

1. Open ChatGPT Settings and enable Developer mode.
2. Open Plugins and create a developer-mode connection.
3. Choose Tunnel and select/paste the matching tunnel ID.
4. Use `No Auth`; the loopback bridge and OpenAI tunnel form the transport boundary.
5. Verify discovery of ten model-visible tools: `codex_status`, `codex_steer`, `codex_activity`, `codex_activity_cancel`, `codex_cancel`, `codex_activity_update`, `codex_agent`, `codex_models`, `codex_settings`, and `codex_task`.
6. The app-private `codex_activity_rehydrate`, `codex_activity_snapshot`, `codex_interaction_respond`, `codex_job_steer`, `codex_activity_handoff`, `codex_background_process_terminate`, and `codex_update_settings` tools should also be registered but are not normal model operations. Recovery detach is private and operator-disabled by default.

### Refresh after a bridge/UI change

MCP App resource URIs are cache keys. This repository derives immutable Settings and Activity URIs from final content plus host-affecting resource metadata. Before refreshing ChatGPT:

```bash
npm run release:sync
npm run release:check
npm run check
```

Then deploy/restart the bridge before selecting **Refresh** on the ChatGPT plugin detail screen. This order ensures that the server already serves the newly advertised current URI and every retained URI whose UI contract generation is still supported.

Do not Refresh merely because the bridge, tunnel, or computer restarted. An unchanged packaged build advertises the same immutable URIs. Refresh is needed after tool descriptors, authentication, UI content, or host-affecting UI metadata change.

After Refresh:

1. inspect `dist/ui-manifest.json`;
2. confirm the registered `codex_settings` `_meta.ui.resourceUri` and `openai/outputTemplate` exactly equal the manifest's current Settings URI;
3. confirm both `codex_task` (unless visibility is `never`) and `codex_activity` point to the current Activity URI;
4. open a new conversation and run the smoke checklist below;
5. test an existing conversation. Its supported cached URI must still render; ask it to rediscover tools or use a new conversation only to pick up the new descriptor. The bridge cannot inject refreshed metadata into an already cached conversation.

See OpenAI's [Plugin Refresh guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata) and [MCP App UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui).

## 4. Configure the Settings card

Ask ChatGPT to open the Codex MCP Bridge for ChatGPT settings. The card saves shared bridge-instance preferences:

- access strategy;
- fixed or automatic exact model policy;
- independent Priority/Fast processing for Codex calls;
- named projects with explicit per-task selection;
- UI language;
- concurrent-job limit;
- card visibility;
- optional completion handoff.

For an automatic policy with an explicit range, the card selects models first and then reasoning efforts per model. A model's **All** control expands the currently allowed efforts into exact saved model/effort choices; it does not add an `all` value to the tool schema and does not automatically include efforts discovered later. The separate catalog-visible range remains dynamic.

In automatic mode, GPT chooses one exact allowed model/effort pair based on the
task for every new Activity, new Agent, or fresh context. The card labels the
optional fallback as the default used when GPT does not choose. It is an
omission-only compatibility fallback, not a preferred or recommended model.
Continue/fork keeps the admission-time selection unless the current descriptor
explicitly permits an override.

The Priority checkbox is intentionally separate. `codex_task` exposes only model and reasoning-effort choices to GPT. If the user enables Priority, the bridge injects the supported `priority`/`fast` service tier internally when it calls Codex; GPT cannot choose or override it.

The model catalog is loaded when Settings opens, using the bridge's short TTL and last-known-good cache. The card does not poll and has no persistent refresh button. A retry action appears only when the catalog is stale or a lookup fails.

There is one conversation-scoped flat Activity feed. Retired saved layout
preferences are safely discarded and are not selectable in Settings.

The **Projects** section is the single source of Codex start folders. Users enter only a Unicode project name and an existing absolute folder. The server generates an immutable UUID and keeps it private and stable across rename, relocate, archive, and restore. New or edited folders are canonicalized with `realpath`; files and active normalized-name/canonical-path collisions are rejected. Projects have no default selection; every new Activity or fresh Agent context must select one exact current name and `registryRevision`. No name, label, slug, alias, or list position is an identity.

Settings also warns that changing the default backend affects only new threads.
Existing Agents stay pinned. To move one deliberately, use that Agent with
fresh context and an explicit handoff summary; only the summary reaches the new
backend thread, not the prior transcript or backend state.

Settings card generation 9 sends independent `expectedSettingsRevision` and
`expectedRegistryRevision` CAS values with exactly one `reset` or `patch`
operation. A patch groups ordinary settings and a bounded atomic list of project
`add`, `rename`, `relocate`, `archive`, and `restore` operations; it never replaces
the registry. Each effective project transaction advances `registryRevision`
exactly once, while ordinary changes advance `settingsRevision` independently.
Both are checked immediately before the single commit. Reset restores general
preferences only: project UUIDs, names, paths, order, archive state, and recovery
entries are preserved. Earlier Settings generations are retired because their
ID/default and single-revision mutation contracts are incompatible.

On a fresh install the project registry contains no entries. The public `codex_task`
descriptor then omits `project`, which leaves one intentional projectless
setup-probe path. Its Activity-card UI
binding is also absent, preventing a blank Activity card from mounting before
onboarding; project registration restores that binding through the dynamic tool
refresh. Do not open Settings merely because a conversation starts or the plugin
is attached. After the user explicitly requests new or fresh Codex work, call
`codex_task` once without `project`; it admits no Activity, Agent, Job, session, or
upstream work and returns `PROJECT_SETUP_REQUIRED` with `codex_settings` as the
next action. Only then should GPT show the card and explain what must be registered.

After registration, the discovery descriptor exposes bounded `project` and
`selection` choices but keeps them optional so existing Activity continue/fork
calls remain valid and the tool stays inside ChatGPT's reliably callable schema
subset. The serialized admission boundary is authoritative: new Activities, new
Agents, and fresh contexts still reject missing or stale project/selection values
with structured errors before any Activity, Agent, Job, session, or upstream work
is created.

A project whose folder disappears remains visible as **Needs recovery**, but it
cannot admit work until its folder is fixed or the project is archived. Archived
projects are excluded from new selection; restore keeps the same UUID. Existing
Activity/Agent threads keep their pinned admission-time folder. The card cannot
change tunnel credentials, operator capabilities, or the Codex approval policy.

Project selection and access strategy are independent:

- fixed `read-only` forces read-only and removes per-call `sandbox` from `codex_task`;
- fixed `always-full` forces `danger-full-access` and removes per-call `sandbox`;
- `adaptive` exposes only operator-enabled per-turn sandbox choices.

The public `codex_task` descriptor never contains `cwd` or an internal UUID. Once
the first project entry is registered, the first-install setup-probe exception
disappears. The descriptor projects only selectable `{ name, registryRevision }`
objects and conditionally requires one for every new Activity or fresh Agent
context, even when only one project is available. If registered entries exist but
none are selectable because they are archived or unavailable, the descriptor
does not expose the first-install probe; after an explicit user work request,
Settings is the recovery path. Missing selection with an active registry fails
closed with `PROJECT_REQUIRED`; a truly empty registry returns
`PROJECT_SETUP_REQUIRED`. Runtime generation validation is authoritative even if
`tools/list_changed` is missed. Activity, Agent creation/assignment, replay, and
Job admission recheck it atomically and pin UUID/cwd; a backend-assigned resumable
thread receives the same pin before reuse. An exact admitted `requestId` replay
remains valid after registry changes. Continue/fork omits `project` and keeps the
admission-time snapshot after rename, relocate, archive, or restore; an unavailable
pinned folder returns `PROJECT_UNAVAILABLE` without fallback. A caller that sends
`cwd` fails strict schema parsing; a stale fixed-mode descriptor that still sends
`sandbox` receives `SANDBOX_OVERRIDE_UNAVAILABLE`.

The token prevents stale name mappings. A different exact active name from the same current revision is still a valid transport-level choice; the bridge cannot infer contrary natural-language intent. Multi-project write/full-access fresh confirmation remains a separate app-private follow-up rather than a model-visible `confirmed` field.

### Dynamic model/effort behavior

Opening Settings and its failure-only retry action use the same bridge catalog adapter. App Server `model/list` is authoritative for App Server, including picker visibility, supported/default efforts, upgrade metadata, and service tiers. A short TTL avoids redundant lookup; a failed lookup preserves and labels the last known good catalog instead of replacing it with an empty list.

Effort options display short localized names only. The selected description is a separate helper linked with `aria-describedby`. Changing model immediately rebuilds supported efforts and the helper. Unknown new effort IDs remain visible with their canonical label and deterministic localized fallback description.

If a saved effort is no longer supported, Settings warns instead of rewriting it. The suggested value is the model's current default. Task execution never forwards the unsupported value; diagnostics record the transient effective effort and warning until the user explicitly saves a supported value.

## 5. Verify the active contract

Call `codex_status` and confirm:

- the saved project registry, `accessStrategy`, card visibility, and language;
- the project availability and mutation capability flags;
- default backend and active build ID;
- settings schema/model policy and catalog source/fingerprint/LKG status;
- SQLite state is reachable.

Inspect `tools/list`:

- `codex_task` has no caller `scopeId`, `modelPolicyRevision`, `cwd`, arbitrary `threadId`, `sessionMode`, or `adoptThread`; when automatic Activity UI is enabled it requires one response-scoped `activityPresentationId`;
- `project` lists only exact selectable names paired with one current `registryRevision`;
- fixed access modes have no `sandbox`;
- `adaptive` exposes only permitted sandboxes;
- Activity and Agent routing use separate discriminated `activity` and `agent` objects;
- an existing Agent's optional `context` values are exactly `continue`, `fork`, and `fresh`.
- `codex_steer` exposes exactly `requestId`, `jobId`, `expectedJobVersion`, and `prompt`; it exposes no scope, Activity, Agent, thread/turn, card, policy, model, project, sandbox, cancellation, approval, or interaction field;
- `codex_task` publishes required nullable `answer`; a delivered foreground result has a non-null bounded answer;
- `codex_status` permits `answer` only on an exact completed Job item, while summary items expose exact-Job retrieval actions.

## 6. Agent and Activity routing

ChatGPT omits `scopeId`; the bridge derives it from anonymous conversation host metadata. A non-ChatGPT compatibility host must generate/reuse an explicit scope UUID. Every logical `codex_task` turn gets a fresh UUID `requestId`; reuse it only for an exact retry. When the descriptor exposes `activityPresentationId`, generate one separate UUID for the current assistant response and reuse it across every Codex call in that response.

Use these routes:

```json
{
  "requestId": "...",
  "activityPresentationId": "...",
  "project": { "name": "Bridge Workspace", "registryRevision": 4 },
  "activity": {
    "mode": "new",
    "title": "Implement the agreed design",
    "policy": { "kind": "implementation" }
  },
  "agent": { "mode": "new", "name": "Mina" },
  "prompt": "Implement the design and run the relevant checks"
}
```

The creation envelope is intentionally optional. Omitting `activity` creates one
with the neutral title `Codex activity`, kind `other`, handoff `none`, and manual
completion. Omitting `agent` for a new Activity creates a deterministically named
fresh Agent; `agent: { "mode": "new" }` does the same. The assignment role is
server-owned `primary` display metadata and has no routing, authorization,
context, lifecycle, or handoff meaning. Activity policy, Activity/Agent creation,
assignment, replay registration, and Job admission commit atomically.

The result returns immutable `activityId` and `agentId`. A same-goal follow-up uses both exact IDs and `continue`:

```json
{
  "requestId": "...",
  "activityPresentationId": "...",
  "activity": { "mode": "existing", "id": "..." },
  "agent": { "mode": "existing", "id": "...", "context": "continue" },
  "prompt": "Address the remaining test failure"
}
```

A new but dependent goal creates a linked Activity without reopening the completed source:

```json
{
  "requestId": "...",
  "activityPresentationId": "...",
  "activity": {
    "mode": "new",
    "continuationOf": "...",
    "title": "Follow-up integration",
    "policy": { "kind": "implementation" }
  },
  "agent": { "mode": "existing", "id": "...", "context": "continue" },
  "prompt": "Integrate the completed work with the next component"
}
```

For independent verification, create another fresh Agent or explicitly fork an existing Agent. Different Agents run in parallel; the same Agent/thread serializes active turns. If several Agents are attached to an Activity, the bridge rejects a follow-up without an exact nested Agent ID. The former flat routing fields have expired and are rejected.

Agent lifecycle is separate from turn and Activity lifecycle. A terminal turn returns the Agent to `idle` and releases its active Activity assignment while preserving history. Model-visible `codex_agent` provides only one discriminated `operation`: `rename` (with `name`), `archive`, or `restore`. Archive/restore changes only bridge-local logical state and never invokes upstream thread archive/unarchive, protecting other Agents that descend from the same fork tree. Active/waiting Agents and Agents with App Server background terminals cannot be archived. Exact process termination belongs to the mounted Activity card's destructive private control; exceptional assignment detach is an operator-enabled private recovery operation. There is no GPT-facing permanent delete.

Activity lifecycle changes require the exact version from authoritative status. `codex_activity_update` accepts one non-cancelling `operation`: seal, complete, abandon, start verification, pass/fail verification, or set policy. Each operation exposes only its relevant payload. Whole-Activity force-stop is the separate destructive and idempotent `codex_activity_cancel`, which additionally requires a unique `requestId`; retry that UUID only for the exact same cancellation. Public single-Job `codex_cancel` likewise requires a cancellation-specific `requestId` plus the exact current Job `expectedVersion`. An exact retry is replay-safe, while reuse with another payload is rejected. A shared-worker impact must be confirmed with the complete affected-job list. The old flat update and cancellation forms have expired and are rejected.

Before continuing, App Server threads are checked with `thread/read`. A missing
or system-error thread makes the Agent `orphaned`; an active turn or temporary
probe failure is retryable and leaves the Agent intact. Use explicit `fresh`
only for a confirmed orphan; the original stays in thread history. App Server
session identity and direct fork ancestry are retained with that history.

Existing threads remain pinned to their creation backend. If the configured
default differs, `continue` and `fork` keep the old backend. To start a new
target-backend thread on the same Agent, send
`agent: { mode: "existing", id, context: "fresh", handoffSummary }`. The summary
is explicitly labeled as the only transferred context, its digest is audited,
and it is not stored as a separate bridge request field. Normal retained model
output can still contain text that Codex repeats. Omitting the summary fails with
`BACKEND_HANDOFF_SUMMARY_REQUIRED` instead of implying transcript migration.

## 7. Active-turn orchestration

Use `codex_steer` only when new information matters to an exact Job that is
still running on App Server. Appropriate deltas are a new user constraint, a
correction, or a sibling Job result that ChatGPT has independently checked and
restated. Do not send a message merely because another Job produced output.
Codex output is untrusted task data and never carries authority to instruct a
sibling Agent.

Read the exact Job first and send only the four public fields:

```json
{
  "requestId": "...",
  "jobId": "...",
  "expectedJobVersion": 6,
  "prompt": "Verified dependency result: the schema is v2. Apply that constraint before finishing."
}
```

The bridge derives conversation scope and resolves Activity, Agent, current
App Server thread, and active turn from the exact Job. It rejects stale
versions, cross-scope or inconsistent roots, MCP Server Jobs, inactive turns,
and terminating/cancelled Jobs. A successful call appends input to the current
turn without emitting a new turn. It cannot change the admitted model/effort,
project, cwd, sandbox, Activity policy, or output schema, and cannot address an
internal Codex subagent.

Steering is not interaction response or cancellation. If an approval or
user-input control is pending, leave it pending and use its dedicated card
control. A steering prompt containing “stop” remains ordinary turn guidance;
an explicit stop request uses `codex_cancel`, which has priority. If the Job is
already terminal, inspect its exact result and, only if more work is needed,
call `codex_task` with the existing Activity/Agent and `context: "continue"`.
No prompt is queued to that future turn automatically.

Reuse a steering `requestId` only for the exact same Job, expected version, and
prompt. The bridge stores a prompt SHA-256 and durable delivery phase, not the
raw prompt. Exact delivered replay does not call App Server again. A process
failure after dispatch can produce `DELIVERY_UNCERTAIN`; inspect exact Job
status and never automatically resend it. The bridge intentionally makes no
distributed exactly-once claim.

The accepted input remains part of the upstream Codex turn. Within the bridge,
its exact text is held only in non-serialized memory until terminal state so an
exact Codex echo can be removed from progress, Activity events, errors, retained
Job results, and model output. `promptPersistedByBridge: false` is a statement
about Bridge-owned storage, not Codex App Server thread-history retention.

Within one ChatGPT response, run independent Jobs in the background, use a
bounded exact-Job `codex_status` wait, verify the dependency fact, then steer an
affected still-running Job if necessary. Independent Jobs need no message.
Shared-working-tree write conflicts require serialized waves or worktree
isolation. When the ChatGPT response has already ended, a later user message or
completion handoff must wake orchestration; this feature adds no general
Job-result wake system.

## 8. Activity card behavior

`codex_task` owns automatic card presentation. When saved visibility is `always` or `background-only`, its descriptor points directly to the same Activity UI resource as `codex_activity`. Call `codex_task` directly—not through programmatic tool calling or an exec wrapper—so ChatGPT preserves that native UI. Do not call `codex_activity` afterward.

`requestId` remains per logical Codex call and must be reused only for the same execution retry. `activityPresentationId` is one UUID per assistant response: reuse it for every `codex_task` in that response, including calls to different Activities or Agents, and generate a new value for the next response. This explicit input is required because documented ChatGPT MCP metadata provides conversation correlation but not an assistant-response ID. A verified host may supply the same value as `codex/activityPresentationId` metadata. V4 replay excludes presentation state, and it cannot select or bypass the saved visibility setting.

The Task result carries strict private `_meta["codex/activityBootstrap@11"]` presentation data. The mounted widget reads it internally: an eligible render starts one scope-version `codex_activity_snapshot` long poll, while duplicate, disabled, or foreground-only-in-`background-only` results collapse without displaying another card. Public task `structuredContent` has no Activity hydration leaf. The snapshot tool is app-private and establishes or renews the exact Activity/generation/presentation lease for that widget session. A foreground call does not consume a `background-only` presentation; a later background call carrying the same assistant-response presentation ID may display it. With visibility `never`, the bridge removes the Task UI binding and public presentation input. `codex_activity` is reserved for an explicit user request to open or reopen the view.

On conversation re-entry, a host may cold-remount the historical Task iframe but omit the original private bootstrap. In that case the widget passes the public Task result's exact `jobId + requestId` to app-private `codex_activity_rehydrate`. The bridge derives scope from host metadata, validates the retained call and Activity, reapplies the current visibility setting, and elects at most one sibling from the original response presentation. The returned historical snapshot is read-only and one-shot: it owns no automatic presentation, watcher, completion handoff, or control lease. Clicking refresh is an explicit user action that opens the ordinary explicit snapshot/watcher path. No bootstrap blob is added to SQLite. If ChatGPT does not remount the historical iframe, or the retained Job correlation is no longer available, ask explicitly to reopen Activity with `codex_activity`; server code cannot execute inside a shell the host never mounted.

The automatically mounted card is a compact feed scoped to the current ChatGPT conversation. It returns only running/terminating work, user-blocked work, recovery states, and verification or completion-handoff waits as Activity rows. User block sorts before recovery, result review, and progress; rows in the same group sort by most-recent change with an Activity-ID tiebreaker. Completed/ended Activities and unused idle Agents are not sent as individual history rows: one localized row reports exact completed-Activity, ended-Activity, and idle-Agent counts. An Activity is not folded while verification, handoff, a Job, an interaction, an open assignment, or an App Server background process remains. The completed count is Activity-centric and survives Agent reuse.

An explicit user request for all work calls `codex_activity` and opens the full view. The full view uses the same scoped Activity row model, adds terminal/idle Activity history and idle Agents, and pages both with a bounded opaque cursor tied to the scope version. An exact requested Activity selects its containing page. Cursor invalidation resets safely after a live ordering change. Explicit cards retain their separate watcher admission and never own automatic completion handoff. Historical rehydration remains compact, one-shot, and read-only until its explicit refresh promotes it to this full view.

The feed shows only Activity title, Agent display name, separate display-only role, localized state, kind, timing, final project-folder name when multiple projects are relevant, each Agent's current or latest effective model/reasoning-effort selection, and necessary controls such as verification, retry, force-stop, background-process stop, approval, or input. Model labels match the Settings catalog display names and fall back to internal IDs only when necessary. A reported App Server model reroute is rendered as `selected → rerouted`; the effort remains the Job's admission-time effective effort. Approval and input responses use `codex_interaction_respond` with an idempotency UUID, exact Job version, interaction ID, and current card proof; answers are transient and never written to bridge state.

Detailed Job status includes a selection-only `executionAudit`: requested,
policy-effective, and evidence-backed actual model/effort, plus reroute reason
when reported. It states when the protocol has not supplied independent runtime
effort-override evidence. Prompt and private reasoning text are excluded. A
context-window failure remains a tracked structured
`CONTEXT_WINDOW_EXCEEDED` result with explicit recovery choices; retrying that
same request ID returns the retained failure and does not start another turn.

The card deliberately omits a KPI dashboard, card-grid Agent list, layout selector, Activity `<details>`, timelines, Agent/job/thread IDs, full working paths, backend/worker data, command output, and general steering. Detailed diagnostics are available only through the private app-only `codex_diagnostics` tool.

Automatic duplicate suppression is keyed by `scopeId + activityPresentationId`; `activityId + cardGeneration` is retained only to validate a mounted Activity reference. Each later same-response result becomes the newest short unconfirmed candidate across Agents and Activities. Its iframe must match its own `toolInput.requestId` to the validated private bootstrap correlation `requestId`; this selects the last-call shell when ChatGPT hydrates sibling shells with one last result. Server admission also verifies the candidate job owner. An exact logical-call retry stays eligible, a candidate that never receives a snapshot lease expires after a bounded interval, and the previously confirmed card remains live until its replacement mounts. The first matching `codex_activity_snapshot` confirms ownership; a racing second iframe for the same candidate receives `presentation-duplicate` and collapses. A new presentation can render even while an older card for the same Activity remains mounted.

Only the newest confirmed mounted automatic candidate owns the scope live watch and completion handoff. When a newer response or same-response sibling candidate confirms its first snapshot lease, the previous automatic card receives a normal `presentation-superseded` stop result, retains its last snapshot, and releases its watcher slot without a retry loop. Explicit `codex_activity` cards use separate admission (up to three concurrent explicit watchers per scope alongside the one automatic owner) and do not claim automatic completion handoff. `openai/widgetSessionId` identifies only the mounted widget instance and is not authorization by itself; every control revalidates the exact card lease and target ownership. Handoff discovery exposes batch actions only and requires the newest automatic card proof. UI-bearing Activity tools use strict private/app-only bootstrap and view contracts. The current content-hashed Activity resource uses UI generation 12 and the closed generation-11 private metadata envelopes. Its Force Stop action calls `codex_activity_job_cancel`, which validates the live widget lease, current presentation/card proof, exact Job version, target ownership, and cancellation UUID. Generation 12 is the minimum for new descriptors; all immutable retained generation 7–11 resources remain registered for existing mounts and refresh through app-only tools. Reservations and ownership are in-memory; after bridge restart the first valid automatic card to reconnect safely re-establishes ownership.

`executionMode: foreground` waits for terminal result and returns its bounded structured `answer`. `background` returns `jobId` immediately. Neither completes the Activity. A host without the card can use a bounded exact-Job wait:

```json
{ "query": { "kind": "job", "id": "...", "waitFor": "terminal", "waitMs": 55000 } }
```

When the exact Job completes with `result.availability: "delivered"`, read that Job item's `answer`. Overview, Activity, thread, and page status never carry Job answer bodies. `omitted` and `unavailable` keep `answer` absent; `delivered` without `answer` is a contract/host delivery failure and must not trigger a new re-report Job.

Wait timeout leaves Codex running. `codex_cancel` interrupts one exact App Server turn or tracked worker process. The card's private `codex_activity_job_cancel` is a distinct destructive surface, and `codex_activity_cancel` force-stops every active job in one exact-version Activity. Every path durably records its cancellation operation and intent before interruption; terminal state is recorded only after exit evidence. Activity cancellation records a parent intent, enters `Activity-terminating`, records linked child intents, cancels the children, and only then writes `Activity-cancelled`. None rolls back filesystem changes. HTTP abort, SSE disconnect, MCP cancellation notifications, wait/snapshot abort, presentation supersession, and widget unmount are transport or presentation observations only and never cancel a Job.

### Cancellation provenance and escalation

Cancellation source, transport observation, and terminal origin are deliberately
different taxonomies. A cancellation source identifies authority for an
intentional destructive action: `model-tool`, `widget-control`,
`activity-cascade`, `operator`, or the fail-closed internal
`assignment-containment` path. The original issue acceptance criteria listed
`host-abort`, `restart`, and `unknown` as possible source categories so that no
incident would remain unattributed. The implemented boundary is stricter:

- a host/MCP/HTTP abort is a bounded transport observation and has no
  cancellation authority;
- a bridge restart is a Job terminal origin, not a cancellation request;
- `unknown` is not valid for new state. Only migrated pre-provenance cancelled
  rows use the explicit `legacy-unattributed-cancellation` terminal origin.

This separation prevents detach, timeout, restart, or missing historical data
from being mistaken for user cancellation. An explicit cancellation operation
must instead retain its caller/control provenance, including the public or
app-private tool, bounded action and reason, request correlation, caller and
target presentation where applicable, and sanitized widget-proof presence.

If no durable cancellation operation or intent exists and App Server
independently reports an interrupted/aborted turn, collect a minimal sanitized
reproduction and escalate it for upstream App Server investigation. Include the
bridge build and supported Codex CLI version, timestamps, terminal origin, and
bounded opaque Job/thread/turn and worker-generation correlation needed to
reproduce the sequence. Exclude prompts, answers, authorization data, raw host
metadata, local paths, and raw widget identifiers. If a durable explicit
cancellation operation does exist, attribute the interruption to the recorded
caller/host/control surface rather than to App Server; an adjacent transport
abort observation does not override that provenance.

App Server may leave a background terminal after the turn itself completes. The card keeps the Agent idle but separately shows the remaining-process count and **Stop background processes** action. This action calls the app-private, destructive `codex_background_process_terminate` tool. The bridge revalidates the mounted-card lease, exact Agent version, current App Server thread, fresh terminal inventory, and absence of an active turn before calling `thread/backgroundTerminals/terminate`; it is not Agent archive or job force-stop. Every supported Activity resource calls this dedicated tool; the former Agent-operation shortcut has expired.

## 9. Smoke checklist after Plugin Refresh

In a new ChatGPT conversation:

1. open Settings and confirm it renders without an old-resource error;
2. add two project folders, verify Unicode/whitespace/case-equivalent names and canonical duplicate paths are rejected inline, and save;
3. add projects from two unrelated absolute locations, rename/relocate one, archive/restore the other, and confirm identity and archive state persist;
4. change a harmless preference and save;
5. confirm there is no persistent model-refresh button; if a stale/failure warning is present, use its contextual retry and confirm the last-known-good options remain populated;
6. choose **Restore default settings**, confirm, and verify the card rerenders;
7. confirm `codex_task` has no `cwd`/UUID, projects only exact names plus `registryRevision`, and fixed access modes have no `sandbox`;
8. start narrow foreground read-only Activities in each project, then omit `project` for a new Activity and confirm `PROJECT_REQUIRED`; continue an existing Activity without it and confirm the pinned project is inherited;
9. retain an old descriptor, mutate the registry, and confirm its stale generation fails without an Activity, Agent, Job, or Codex call even if no `tools/list_changed` notification is consumed;
10. mount an automatic Activity card and verify it shows only current/action-needed rows plus one exact past-record summary, with no completed/ended/idle disclosure payload;
11. run a same-Agent `continue`, then a second-Agent parallel `fresh`/`fork`, and confirm one card is reused for the Activity;
12. explicitly ask for all Activities, confirm `codex_activity` opens bounded previous/next pages in the same conversation only, and verify an exact old Activity opens on its containing page while an unselected view starts at the priority-first page;
13. complete work, confirm the automatic summary's completed-Activity and actual idle-Agent counts remain exact after Agent reuse, and verify there is no KPI/card grid/layout selector or full path/backend/ID/timeline detail;
14. archive/restore an idle Agent and confirm the same immutable ID/thread history remains;
15. start a linked Activity with the existing Agent and confirm it gets a new card generation without reopening the terminal source; use `fresh` plus another project to verify an explicit linked-project switch;
16. in an App Server canary, verify command/file/permission/input prompts expose
    only their advertised decisions, including session approval when offered;
    confirm cancel/decline, automatic resolution, and expiry all remove the
    control without stopping the turn;
17. run two turns on the same App Server Agent with different allowed exact
    model/effort selections; confirm each `turn/start` admission and Job
    `executionAudit`, including reroute evidence if present;
18. restart between those App Server turns and confirm `thread/read` resumes the
    exact thread with the same session ID; fork once and verify direct ancestry;
    separately exercise busy, missing, and transient probe paths and verify only
    missing/system-error becomes orphaned;
19. change the configured default backend, confirm the existing Agent still
    continues on its pinned backend, then perform an explicit fresh handoff and
    confirm the UI/result says summary-only continuity;
20. trigger a context-window failure and confirm it remains a structured,
    replay-safe error with no silent model/effort downgrade;
21. inspect `codex_status` for the experimental policy, exact CLI, catalog
    freshness, aggregate RSS/FD, startup/crash/config/MCP health, and orphaned
    count; verify no worker identifier, full path, raw reasoning, MCP payload,
    or collaboration prompt appears;
22. start a long App Server Job, read its exact version, call `codex_steer`, and
    confirm the same active turn consumes the delta without another
    `turn/started` event or a resolved pending interaction;
23. retry that exact steering request and confirm one upstream `turn/steer`, then
    change the prompt under the same request UUID and confirm
    `STEERING_REQUEST_CONFLICT` with no second dispatch;
24. exercise stale version, inactive/terminal turn, active MCP Server Job, and
    explicit cancellation races; confirm `STALE_JOB_VERSION`,
    `JOB_NOT_ACTIVE`, and `STEERING_UNSUPPORTED` remain distinct and no future
    turn is queued;
25. interrupt the bridge after durable steering dispatch but before result
    recording, restart, and confirm the exact replay returns
    `DELIVERY_UNCERTAIN` without resending and that SQLite contains only the
    prompt digest, not the raw prompt;
26. invoke public `codex_steer` with only its four fields plus ChatGPT host
    metadata, confirm the same host scope succeeds and another session fails;
27. make Codex repeat the exact steering text in progress and its final answer,
    then confirm the exact Job result, public status output, Activity events, and
    a byte scan of Bridge SQLite contain only the redaction marker.

In an existing pre-refresh conversation:

1. inspect whether it still advertises old `cwd`/`threadId` fields or an old Settings URI;
2. trigger tool rediscovery if the surface supports it;
3. otherwise document that a new conversation is required;
4. confirm every cached UI resource within the supported contract-generation range resolves rather than returning resource-not-found.

Record Desktop/Web/iOS surface, plugin URI/template, old/new conversation behavior, and any host cache limitation in the release or issue report.

## 10. Troubleshooting

- Tunnel missing: verify workspace association and Tunnel Read/Use permissions.
- Runtime dotenv missing: create `~/.config/codex-mcp-bridge/.env` from `.env.example`, replace both `CONTROL_PLANE_*` values, and run `chmod 600` on it.
- Runtime dotenv rejected: use a regular non-symlink file owned by the current user with mode `0600`; do not put it in a registered project.
- Tool discovery fails: keep the bridge running and rerun `tunnel-client doctor`.
- Old Settings card/tool schema: first confirm its URI is present in `dist/ui-manifest.json`. Supported cached URIs must render; deploy current server, use plugin **Refresh**, then start a new conversation only when new metadata is required.
- `PROJECT_REQUIRED`: refresh the tool list and send one exact projected `{ name, registryRevision }` object for the new Activity or fresh Agent context.
- `PROJECT_REGISTRY_CHANGED`: the descriptor is stale; refresh tools and choose again. No work was admitted.
- `PROJECT_NAME_CONFLICT` / `PROJECT_CWD_CONFLICT`: choose a unique active normalized name/canonical folder.
- `PROJECT_UNAVAILABLE`: restore the exact pinned folder, or fix/archive the **Needs recovery** project. The bridge does not fall back elsewhere.
- Unrecognized Task `cwd`: refresh the plugin/tool list; select a registered project name/revision instead.
- `SANDBOX_OVERRIDE_UNAVAILABLE`: refresh tools; the fixed saved access strategy is authoritative.
- Repository refused: remove common secret files from the exposed copy or use a sanitized staging copy.
- Write/full access refused: start the bridge with the needed operator capability, then Refresh the plugin.
- `AGENT_ID_REQUIRED`: inspect current Activity Agents and retry with the exact intended ID.
- `AGENT_ORPHANED`: use explicit `fresh` only if replacing the lost backend context is intended.
- Archive conflict: finish/force-stop the active turn or terminate remaining background processes first.
- `STALE_JOB_VERSION`: refresh the exact Job and use a fresh steering request UUID only if the active turn still needs the delta.
- `JOB_NOT_ACTIVE`: inspect the exact Job result; use `codex_task` with the existing Agent and `continue` only for intentional later work.
- `STEERING_UNSUPPORTED`: the Job is not a bridge-verified active App Server turn; do not emulate steering with a queued message.
- `DELIVERY_UNCERTAIN`: inspect exact Job state and do not automatically resend the steering request.
- Codex connection failure: retry after bridge reconnection; enable `CODEX_MCP_BRIDGE_DEBUG=1` only for local diagnosis.

Official guidance:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test a ChatGPT plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [MCP Apps and ChatGPT extensions](https://developers.openai.com/plugins/reference)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Multi-agent orchestration](https://developers.openai.com/api/docs/guides/responses-multi-agent)
