# Codex MCP Bridge for ChatGPT

A policy-enforcing Streamable HTTP MCP bridge from ChatGPT to local Codex.

> [!WARNING]
> The `mcp-server` backend is the stable default. Codex App Server integration is
> experimental and is not officially supported for production workloads. If an
> operator enables it, use it only for personal or development work, monitor
> failures, and be ready to restore `CODEX_MCP_BRIDGE_DEFAULT_BACKEND=mcp-server`
> and restart the bridge. Existing App Server Agents remain pinned to that backend.

- Repository: `menaje/codex-mcp-bridge-for-chatgpt`
- npm package: `codex-mcp-bridge-for-chatgpt`
- Product name: **Codex MCP Bridge for ChatGPT**

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> Codex MCP Bridge for ChatGPT (loopback HTTP)
  -> sticky backend router
       -> codex mcp-server (stable default)
       -> codex app-server (richer thread and process controls)
  -> settings-managed named project folders
       -> exact project required for every new Activity/fresh context
```

The bridge presents local Codex as durable, conversation-scoped Agents and user-goal Activities:

```text
Conversation scope
├─ Agents
│  └─ current Codex thread + thread history
├─ Activities
└─ Activity ↔ Agent assignments
   └─ turn / job
```

An Activity is a goal and verification boundary. An Agent is a long-lived collaborator that can remain idle and be reused across Activities. A terminal turn does not automatically complete its Activity or archive its Agent.

## Tools

- `codex_task`: create or reuse a named Agent, create or attach an Activity, run one exact Codex turn, own automatic Activity-card presentation, and return a completed foreground Job's bounded structured `answer`.
- `codex_status`: inspect authoritative scope, Agent, Activity, thread, turn, and job state through one optional discriminated `query`; only an exact completed Job query returns its bounded `answer`.
- `codex_activity`: explicitly open or reopen the localized lightweight Agent/Activity card on user request.
- `codex_activity_update`: apply one exact-version, non-cancelling lifecycle, verification, or policy operation.
- `codex_activity_cancel`: idempotently force-stop every active job in one Activity and mark it cancelled.
- `codex_agent`: rename, archive, or restore an Agent. It never deletes an Agent.
- `codex_cancel`: idempotently force-stop one active scope-owned turn/job using a cancellation `requestId` and exact `expectedVersion`. Filesystem changes are not rolled back.
- `codex_models`: read the current picker-visible model catalog and exact supported efforts.
- `codex_settings`: render saved named projects, policy, and preferences.

Omit `query` for the scoped status overview. Otherwise choose exactly one detail,
wait, or cursor page:

```json
{ "query": { "kind": "job", "id": "...", "waitFor": "terminal", "waitMs": 55000 } }
```

```json
{ "query": { "kind": "page", "collection": "activities", "limit": 20, "cursor": "..." } }
```

The prior flat status envelope has expired and is rejected by strict parsing.
`scopeId` remains host-derived in ChatGPT and runtime-only for compatibility
hosts; `includeAllScopes` remains a separate runtime-only operator audit input.

Activity mutation is split by risk. First read the exact Activity version, then
use one discriminated non-cancelling operation:

```json
{
  "activityId": "...",
  "expectedVersion": 4,
  "operation": { "kind": "verification-passed", "evidence": { "summary": "..." } }
}
```

Whole-Activity force-stop instead uses `codex_activity_cancel` with a unique
`requestId`, the exact `activityId` and `expectedVersion`, and—when reported—the
complete `acknowledgeAffectedJobIds` set. The former flat Activity update fields,
including `action: "cancel"`, have expired and are rejected; callers must use the
current `operation` contract or `codex_activity_cancel` as appropriate.

Every job or Activity force-stop records a first-class cancellation operation
and intent before dispatching an App Server interrupt or worker termination.
The audit keeps the logical request UUID, source/tool/action, exact targets and
versions, caller/target presentation correlation, cascade links, bridge
instance, timestamps, and a bounded reason code. Raw host metadata, prompts,
authentication material, and widget instance IDs are not retained. An exact
`requestId` replay returns the recorded result; a different payload using that
UUID fails with `CANCELLATION_REQUEST_CONFLICT`.

Terminal state preserves cause rather than treating every interruption as a
cancel. A spontaneous App Server `interrupted` result is `job-interrupted` with
`terminalOrigin: app-server-interrupted` and no cancellation intent. Explicit
job or Activity-cascade force-stop is `job-cancelled` with
`terminalOrigin: explicit-cancellation` and an exact durable intent. Shared
worker containment is `job-interrupted` with `assignment-containment`; bridge
restart and unexpected worker loss remain separately identifiable as
`bridge-restart` and `worker-loss`.

`codex_activity_rehydrate`, `codex_activity_snapshot`, `codex_activity_job_cancel`, `codex_interaction_respond`, `codex_job_steer`, `codex_activity_handoff`, and `codex_update_settings` are app-private contracts. Historical rehydration is a read-only one-shot and grants no card lease or control authority. The Activity card never calls public `codex_cancel`: its destructive job control uses `codex_activity_job_cancel`, which requires an idempotency UUID, exact Job version, current card generation and presentation proof, a live widget lease, and any exact shared-worker acknowledgement. A stale or superseded card fails closed before an intent or side effect is created. Settings mutation uses independent `expectedSettingsRevision` and `expectedRegistryRevision` compare-and-swap tokens with one discriminated reset/patch `operation`; patch groups Activity-card preferences and explicit project add/rename/relocate/archive/restore deltas in one transaction. The other Activity controls require the same exact mounted-card proof and active widget-session lease; interaction and steering requests also require an exact Job version and idempotency UUID. `codex_background_process_terminate` is a destructive app-private control bound to that lease plus the Agent version, App Server thread, and process. `codex_agent_recovery_detach` is a private recovery action that is disabled unless the operator explicitly enables it.

Every bridge tool that returns MCP `structuredContent` declares an `outputSchema`. A delivered Task or exact Job status includes its model-authoritative final text as a 24-KiB JSON-encoded bounded `answer`; `content` keeps the original retained compatibility copy. UI-bearing Task, Activity, and snapshot tools additionally describe the bootstrap/presentation fields and Activity view shape that their components consume, so the host can validate and hydrate the tool result before mounting the card.

## Security defaults

- Binds to `127.0.0.1`.
- Uses `read-only` and `on-request` unless the operator enables broader capabilities.
- Uses one settings-managed registry with server-generated immutable UUID identities, normalized Unicode names, and canonical folders. UUIDs and folders stay private; a normal fresh install starts empty and has no implicit/default selection.
- Rejects per-call `cwd` in the strict Task schema instead of running in an unintended repository.
- Exposes per-call `sandbox` only while the saved strategy is `adaptive`; fixed `read-only` and `always-full` descriptors omit it and enforce the saved policy.
- Resolves every newly saved project to an existing canonical folder, rejects files and active normalized-name/canonical-path collisions, and checks common secret filenames before new execution.
- Limits prompt size, concurrent jobs, retained jobs, and retained result size.
- Stores settings, sessions, Agents, Agent/thread history, Activity assignments, jobs, bounded results, cancellation operations/intents, and bounded transport observations in a private SQLite database.

These are policy controls, not OS isolation. Use a staging copy, separate OS user, container, or VM when hard filesystem/network isolation is required. See [docs/security.md](docs/security.md).

## Requirements and install

- Node.js 22 or later.
- Codex CLI installed and authenticated. The experimental App Server backend
  is admitted only with the exact CLI version pinned in
  `release-manifest.json` (currently `0.145.0`).
- `tunnel-client` plus an OpenAI Secure MCP Tunnel for ChatGPT access.

```bash
npm ci
npm run check
npm run app-server:compat:check # when the pinned Codex CLI is installed
```

Official references:

- [Run Codex as an MCP server](https://developers.openai.com/codex/mcp/)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Build MCP Apps for ChatGPT](https://developers.openai.com/plugins/build/chatgpt-ui)

## Start locally or through Secure MCP Tunnel

Local mode creates no public endpoint:

```bash
npm run bridge:local
```

The launcher uses `http://127.0.0.1:8876/mcp`; health is at `/healthz`. Its
App Server diagnostics contain only aggregate late-response counters and the
latest method/outcome class, never thread/turn identifiers or response bodies.
The launcher does not choose a project folder. After first startup, open the
Settings card and register one or more existing absolute folders from anywhere
on this PC. If none is registered, `codex_task` directs GPT to open Settings
instead of guessing a local path.

For a tunnel connection:

```bash
install -d -m 700 "$HOME/.config/codex-mcp-bridge"
install -m 600 .env.example "$HOME/.config/codex-mcp-bridge/.env"

# Edit the two CONTROL_PLANE_* values once, without committing the file.
${EDITOR:-vi} "$HOME/.config/codex-mcp-bridge/.env"

npm run bridge:secure
```

The bundled launcher automatically reads `~/.config/codex-mcp-bridge/.env`.
Use `--env-file <path>` or `CODEX_MCP_BRIDGE_ENV_FILE` for an explicit override.
Already-exported process variables take precedence. A repository-root `.env`
is a development fallback only: registered project folders reject common
secret filenames, so production credentials should stay in the private config
directory outside every project.

Capability profiles are operator ceilings:

```bash
# Fixed full-access starting policy
npm run bridge:secure -- --write

# Adaptive policy may choose workspace-write
npm run bridge:secure -- --allow-write

# Adaptive policy may choose workspace-write or danger-full-access;
# the Settings card may also select fixed always-full.
npm run bridge:secure -- --allow-full-access
```

Do not leave a broader profile running when it is not needed.

## Settings and execution policy

Ask ChatGPT to open the Codex MCP Bridge for ChatGPT settings. The card controls:

- access strategy: `read-only`, `adaptive`, or operator-enabled `always-full`;
- fixed or automatic exact model policy;
- independent Priority/Fast processing for Codex calls;
- named projects with unique normalized Unicode names and canonical folders anywhere on the PC;
- UI language;
- active-job limit;
- bridge-thread visibility in the Codex app;
- Activity-card visibility: `always` makes all Codex work eligible for automatic
  display, `background-only` limits automatic display to jobs using
  `executionMode: background`, and `never` disables automatic cards;
- completion handoff: `off` or `auto-handoff` while a card is mounted.

In automatic policy's explicit mode, models and reasoning efforts are selected separately. Per-model **All** snapshots every effort currently allowed for that model into ordinary model/effort entries; no synthetic `all` value is persisted or exposed to GPT. Catalog-visible mode stays dynamic and can include later catalog additions.

For automatic policy, GPT must choose one exact model/effort pair from the
current allowed range according to the task for every new Activity, new Agent,
or fresh context. The optional configured fallback is used only when a
compatible caller omits that selection; it is not a recommendation or a model
preference. Continue/fork keeps the admission-time selection unless the current
descriptor explicitly permits an override.

Priority is an independent user preference, not part of the model policy. GPT sees and selects only `model` and `reasoningEffort`. When Priority is enabled, the bridge validates that the chosen model supports the Priority/Fast tier and injects the catalog's `priority` (or `fast`) identifier only into the downstream Codex call. Existing MCP threads retain their admission-time tier when that backend cannot change tiers on continuation.

`Show bridge threads in the Codex app` defaults off. With the App Server backend, newly created and forked threads are therefore ephemeral and stay out of the Codex app list unless the user enables this preference; existing threads are unchanged. Ephemeral threads live only in their App Server worker and cannot be resumed after that worker or the bridge restarts. The current MCP Server tool contract has no ephemeral-thread option, so the card saves the preference but explains that hiding requires switching the bridge backend to App Server and restarting.

Opening Settings resolves the model catalog through the normal short-lived cache. There is no persistent refresh control or polling; when the lookup is stale or fails, the card keeps the last-known-good catalog and shows a contextual retry action.

The Activity card has one conversation-scoped flat-feed layout. Older saved
layout preferences are safely discarded; there is no layout selector or active
layout setting.

The Projects section is the single place where Codex start folders are configured. Users enter only a project name and an existing absolute folder; the server generates a private immutable UUID and keeps it stable across rename, relocate, archive, and restore. The folders may be unrelated and live anywhere on the PC. Saving resolves folders with `realpath`, rejects files and active normalized-name/canonical-path collisions, and never derives identity from a name or slug. No project is a default: every new Activity or fresh Agent context must select one exact registered name from the current descriptor. If a saved folder later disappears, its metadata remains visible for recovery but cannot admit new work until the folder is restored or the project is archived. Archived projects are not selectable; restore keeps the same UUID. Legacy project/default identifiers are intentionally not imported into this identity model.

The generation-9 Settings card saves one atomic `operation`. `reset` restores only general preferences and preserves project UUIDs, names, folders, order, archive state, and recovery metadata. `patch.settings` contains only changed policy/preferences and a bounded `projectOperations` list whose `add`, `rename`, `relocate`, `archive`, and `restore` variants expose only their relevant app-private fields. Ordinary settings use `settingsRevision`; the project registry uses an independent `registryRevision` that advances exactly once for each effective project transaction, regardless of the number of operations. Both generations are checked immediately before the single commit. Earlier Settings generations are retired because their ID/default and single-revision mutation contracts are incompatible with this boundary.

`codex_task` projects only currently selectable `{ name, registryRevision }` objects, never internal UUIDs or paths. Every new Activity or fresh Agent context requires one exact object, even when only one project is registered. Omission fails with `PROJECT_REQUIRED`; with no registered project it returns structured `PROJECT_SETUP_REQUIRED` with `codex_settings` as the next action. Runtime revision/name resolution is the safety boundary: a stale descriptor fails closed even if `tools/list_changed` was lost. The registry is rechecked in the same SQLite transaction as Activity, Agent creation/assignment, replay registration, and Job admission, which pins the immutable UUID plus canonical cwd snapshot. Once the backend assigns a resumable thread ID, its session/Agent-thread record receives that exact pin before it can be continued or forked. Continue/fork omits `project`, retains the snapshot across rename/relocate/archive/restore, and returns `PROJECT_UNAVAILABLE` without fallback if the pinned folder cannot be resolved exactly. An exact admitted `requestId` replay retains its original admission/result after later registry changes.

The generation guard prevents stale name mappings. It does not prove natural-language intent when a caller supplies a different, valid project name from the same current revision; both choices are valid under this transport contract. A stronger user-confirmation capability for multi-project write/full-access fresh work remains a separate app-private follow-up, not a model-visible `confirmed` flag.

Access strategy and project selection are separate:

- `read-only`: every new context is read-only and `codex_task` has no `sandbox` input.
- `always-full`: every new context is `danger-full-access` and `codex_task` has no `sandbox` input.
- `adaptive`: `codex_task` may choose an operator-enabled sandbox for the concrete request. Omission uses the configured default.

ChatGPT plugin permissions decide whether the host confirms an MCP call; they do not choose a Codex sandbox. `CODEX_MCP_BRIDGE_APPROVAL_POLICY=never` removes Codex's second approval boundary and should be used only for a trusted private connection where ChatGPT permission is deliberately the outer boundary.

Settings are shared by the bridge instance, not isolated per ChatGPT account. The private tunnel/no-auth connection supplies no end-user identity.

## Dynamic model and reasoning-effort catalog

App Server `model/list` is authoritative for an App Server target. The installed CLI catalog is the MCP source and bounded fallback. The bridge records catalog source, fetch/validation time, fingerprint, cache/LKG status, picker visibility, default model/effort, supported efforts, upgrade metadata, and service tiers.

The Settings card builds model and effort options from that catalog; new upstream values do not require a card release. Each effort option contains only a short localized label. The selected effort's description appears in a separate `aria-describedby` helper below the selector.

Known effort IDs use deterministic locale dictionaries. An unknown upstream effort remains selectable with its canonical label and a localized generic description. Missing translation coverage is diagnostic and does not block catalog refresh.

If a saved effort disappears, the bridge does not silently rewrite it. The card shows a localized warning and suggests the model's current default. Until the user saves a supported choice, task admission uses a transient supported effective effort and records both the warning and `effectiveReasoningEffort` in diagnostics.

The saved `modelPolicy` is either:

- `fixed`: one exact model/effort selection; or
- `automatic`: current catalog-visible selections or an explicit exact allowlist,
  optionally with an omission-only configured fallback.

Runtime admission always rechecks the operator ceiling, saved policy, current backend catalog, and backend capability. Model aliases are not accepted.

## Experimental App Server rollout

The default backend remains `mcp-server`. OpenAI currently documents local
`codex app-server` as experimental and unsupported for production workloads,
so `CODEX_MCP_BRIDGE_DEFAULT_BACKEND=app-server` is an explicit operator
canary choice, not a production-readiness claim. A default switch requires
recorded risk acceptance outside this repository.

Before an App Server canary, drain active turns, approval/user-input prompts,
and background terminals; install the exact manifest-pinned CLI; run
`npm run app-server:compat:check`; and verify a restart continuation plus two
turns with different allowed model/effort selections. `codex_status` exposes
the experimental policy, pinned CLI version, cached catalog freshness,
aggregate worker RSS/FD, startup latency/failures, crash rate, protocol/config/MCP
initialization health, and orphaned-Agent count without publishing worker IDs,
local paths, or raw protocol payloads. Job detail records requested, effective,
and evidence-backed actual selection plus any model reroute reason. The audit
explicitly identifies when App Server has not reported a runtime effort
override and never includes prompt or private reasoning text.

The backend setting affects only newly created threads. Existing MCP and App
Server threads remain pinned to their original backend. Rollback therefore
means restoring `CODEX_MCP_BRIDGE_DEFAULT_BACKEND=mcp-server` and restarting;
it does not convert or discard already created App Server threads.

Continuing or forking an existing Agent preserves that pinned backend. A
deliberate cross-backend replacement uses the same Agent with `context: "fresh"`
and a required `handoffSummary`. The bridge starts a new target-backend thread,
sends only that explicit summary before the new request, and records its digest
and source/target audit—not a separate copy of the summary input. As with any
prompt, retained Codex output can still contain text that Codex repeats. No
transcript, hidden context, approval, or backend state is represented as
migrated.

Before an App Server continuation, the bridge probes exact persisted state with
`thread/read`. `notLoaded` and `idle` are resumable, `active` returns retryable
`AGENT_THREAD_BUSY`, and a transient probe failure returns retryable
`THREAD_PROBE_UNAVAILABLE` without changing Agent state. Only a missing thread
or `systemError` marks the Agent `orphaned`. Approval/input requests retain a
bounded path-safe view of reason, working-folder label, network context,
permission scope, amendments, and available decisions. The bridge consumes
`serverRequest/resolved` and applies an `autoResolutionMs` expiry guard so stale
controls do not remain in Activity state; session approval appears only when it
is an available decision. App Server `sessionId` and direct fork ancestry are
persisted with thread history and refreshed from exact `thread/read` evidence.
`CONTEXT_WINDOW_EXCEEDED` is retained as a retryable structured failure with
smaller-task, explicit fresh-summary, and larger-context-model recovery choices;
the bridge never silently downgrades the selection.

## Agent, Activity, and context routing

In ChatGPT, omit `scopeId`; the bridge derives an opaque UUID from anonymous host conversation metadata. Compatibility MCP hosts without that metadata must generate and reuse an explicit UUID. Scope IDs are routing labels, not authentication credentials.

Every `codex_task` call requires a fresh UUID `requestId`; reuse it only for an exact retry. When automatic Activity UI is enabled, it also requires one UUID `activityPresentationId` for the current assistant response. Reuse the presentation ID across every Codex call in that response, then generate a new one for the next response. The public contract intentionally has no caller scope, local path, arbitrary thread, model-policy revision, or legacy flat routing fields.

Routing fields are:

- pass one projected `project: { name, registryRevision }` for every new Activity/fresh context; omit it only for an existing Activity/thread continue or fork that inherits its pinned project;
- use `activity: { mode: "existing", id }` for another turn in one exact open Activity;
- use `activity: { mode: "new", continuationOf?, title?, policy? }` to create a new or linked Activity; `policy` may contain `kind`, `handoff`, and `completion`;
- use `agent: { mode: "existing", id, context?, handoffSummary? }` to continue, fork, or deliberately replace one exact Agent context; `handoffSummary` is required only for an explicit fresh cross-backend replacement;
- use `agent: { mode: "new", name? }` to create a fresh Agent;
- omit `activity` and `agent` for a new Activity and Agent with neutral server defaults.

For example:

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

Recommended mappings:

- same goal: same Activity + same Agent + `continue`;
- new but dependent goal: new linked Activity + same Agent + `continue`;
- independent verification/alternative: another fresh Agent, or an explicit fork of an existing Agent;
- unrelated goal: new Activity + new Agent + `fresh`.

One Agent/thread admits only one active turn. Different Agents/threads can run in parallel in the same scope and folder. If an existing Activity has multiple Agent candidates, the bridge requires an exact nested Agent ID instead of guessing. Activity title, kind, handoff, completion, Agent name, fresh context, and assignment role have neutral defaults; generated Agent names are deterministic from `requestId` and remain unique within a scope. The assignment role defaults to `primary` and is display-only metadata: it is read only for Activity/history presentation and never participates in routing, authorization, context selection, lifecycle transitions, or handoff eligibility. New-Activity policy, Activity/Agent creation, assignment, v5 replay registration, and Job admission commit in one transaction. The expired flat routing envelope is rejected by the strict current contract.

`continue`, `fork`, and `fresh` map to backend resume, fork, and start. A fresh context on the same logical Agent adds a thread-history entry and makes the new thread current. If an exact backend probe proves that a persisted thread is missing or in a system-error state, the Agent becomes `orphaned`; replacement requires explicit `fresh` and the old history remains auditable. Busy and transient probe states remain retryable and do not destroy continuity evidence.

For a configured-backend change, an existing Agent's `continue` and `fork`
still use the original backend. A cross-backend `fresh` request fails with
`BACKEND_HANDOFF_SUMMARY_REQUIRED` until it contains an explicit summary. The
result labels continuity as `explicit-summary-only`; changing that summary on
an exact retry is a request-identity conflict, so it cannot create an
untracked duplicate execution.

When a turn becomes terminal, its Agent returns to `idle`, releases the active Activity assignment, and remains reusable. `codex_agent` accepts one idempotent scope-local `operation`:

- `rename`: changes the alias only;
- `archive`: hides an idle Agent while preserving its current/history threads and assignments;
- `restore`: returns that exact archived Agent.

For example, rename with `{ "operation": { "kind": "rename", "name": "Reviewer" } }`
or archive with `{ "operation": { "kind": "archive" } }`, together with the
required `requestId` and `agentId`. The former flat action/name fields have
expired and are rejected.

Active/waiting Agents and Agents with a remaining background process cannot be archived. A mounted Activity card stops one exact remaining App Server terminal through the separate destructive `codex_background_process_terminate` capability. Exceptional assignment repair uses `codex_agent_recovery_detach`, requires exact Activity/Agent/version preconditions, rechecks idle state transactionally, and is disabled by default. Force-stop, background-process termination, recovery detach, and archive are distinct operations; none rolls back filesystem changes. Permanent Agent/thread deletion is not exposed.

## Activity card lifecycle

`codex_task` is directly bound to the same Activity UI resource whenever the saved visibility is `always` or `background-only`. Strict private generation-11 `_meta` tells the widget whether the current automatic presentation should display; the widget then attaches its own bounded app-private `codex_activity_snapshot` watch. Public task and Activity `structuredContent` no longer carries presentation/hydration fallbacks. GPT must call `codex_task` directly and must not make a follow-up `codex_activity` call. With `never`, the Task UI binding and public presentation input are removed. In `background-only`, a foreground result is suppressed without consuming the presentation, so a later background call carrying the same assistant-response presentation ID may display the card. `codex_activity` remains available only for an explicit user-requested open or reopen.

If ChatGPT cold-remounts a historical Task shell without replaying its private bootstrap, the current widget uses only that public result's `jobId + requestId` as lookup hints for the app-private `codex_activity_rehydrate` tool. The server derives the conversation scope, validates the retained logical call, linked Activity, current visibility policy, and one elected sibling for the original response presentation, then returns a one-shot read-only historical snapshot. It creates no automatic reservation, live watcher, completion-handoff owner, control lease, or durable bootstrap row. The historical card suppresses controls; an explicit user refresh promotes it through the ordinary explicit-card snapshot path. If the host does not remount the iframe at all, or the exact retained Job correlation has expired, the safe fallback remains a user-requested `codex_activity` reopen.

`requestId` and `activityPresentationId` have deliberately different scopes. GPT creates one `requestId` for each logical Codex call and reuses it only for the same execution retry. Because ChatGPT's documented MCP metadata includes a conversation ID but no assistant-response ID, GPT also creates one `activityPresentationId` for the current assistant response and reuses it across every `codex_task` call in that response. A verified host may supply the same value through `codex/activityPresentationId` metadata. V4 replay identity excludes presentation state, so presentation changes cannot start another Codex execution, and the saved visibility policy remains authoritative.

The card is one lightweight flat feed for the current ChatGPT conversation. Open work and anything needing user/GPT action stay visible as Activity rows, with the Activity title, named Agent participants, separate roles, kind, timing, each participant's current or latest effective model/reasoning-effort selection, and only the action needed now. Models use the same catalog display names as Settings and fall back to their internal IDs only when no display name is available. If App Server reports a model reroute, the card shows the admitted model and rerouted model as `selected → rerouted`; the effort remains the admission-time effective effort. It has no KPI dashboard, card-grid Agent list, or layout selector.

Truly completed work moves into a collapsed **Completed Codex** group that reports both distinct Agent count and completed Activity count. Idle and ended Agents have separate collapsed groups. When more than one project is relevant, its label remains visible in current and collapsed history rows without exposing the folder path. A completed Activity remains in the current feed while verification, a handoff, a tracked job, an interaction, or an App Server background process is still pending. Reusing the same Agent for a new Activity removes it from completed history and shows the new current Activity instead.

Agent archive/restore is bridge-local logical state. It never calls App Server `thread/archive` or `thread/unarchive`, so archiving one logical Agent cannot implicitly archive another Agent's descendant fork.

The card does not expose event timelines, Agent/job/thread IDs, full working paths, backend/worker details, command output, Job answer bodies, or general steering. When multiple projects are active, it may show their user-defined labels. Approval/user-input controls are sent only in a minimal UI-only metadata payload and answered through the one-shot app-private interaction contract; raw answers are not persisted. GPT can retrieve compact semantic state with `codex_status`; a completed result requires one exact Job query and its `answer`. Build/auth/storage/HMAC/pool/upstream forensics stay in the model-hidden `codex_diagnostics` surface.

Automatic card duplication is suppressed per `scopeId + activityPresentationId`. Each later eligible sibling result replaces the short unconfirmed mount candidate for that assistant response. The iframe compares its own `toolInput.requestId` with the validated private bootstrap correlation `requestId`, so when ChatGPT hydrates multiple same-response shells with the last tool result only the matching last-call shell bootstraps. The server then verifies the candidate job owner, admits one widget, and collapses races. A previously mounted card remains live until the newer candidate confirms, so a failed or expired last-card mount does not blank the feed. An exact logical-call retry remains eligible, and an unconfirmed candidate expires after a bounded interval instead of consuming the presentation for hours. The first valid `codex_activity_snapshot` confirms ownership. A second iframe racing for that same confirmed candidate receives `presentation-duplicate` and collapses. `activityId + cardGeneration` remains only the mounted Activity validity check. A mounted widget renews its lease by widget instance; abort/unmount/TTL releases it, and restart does not restore presentation ownership. After restart, the first valid mounted automatic card safely re-establishes ownership.

Only the newest **confirmed mounted** automatic candidate in a conversation owns the bounded scope-version long poll and completion handoff. Confirming a newer response or same-response sibling candidate wakes the prior automatic card, which keeps its last snapshot and receives a normal `presentation-superseded` stop signal instead of retrying or retaining a watcher slot. Explicitly opened `codex_activity` cards are a separate class: at most three may watch per scope alongside the one automatic owner, and they never compete for automatic completion handoff. `openai/widgetSessionId` is correlation evidence, not authorization by itself; control tools also revalidate the exact Activity/generation/presentation/candidate lease and resource ownership. UI-bearing Activity tools declare strict private/app-only output contracts. The current content-hashed Activity resource uses contract generation 11 and the exact app-private snapshot, proof, destructive Job-cancel, control, and batch-handoff contracts. Generation 11 is the minimum for new descriptors, while every immutable retained generation 7–10 URI remains registered for already-mounted conversations and refreshes through app-only tools. HTTP request abort, SSE disconnect, MCP `notifications/cancelled`, status/snapshot wait abort, presentation supersession, and widget unmount are transport or presentation observations only: they may release a bounded wait/lease and write a bounded diagnostic event, but never cancel a job. `executionMode: background` returns a tracked job immediately; `foreground` waits for its terminal result and structured `answer`, and detaching that foreground response leaves the admitted job running to its normal terminal state. Neither mode changes Activity completion. For background completion or recovery, use `codex_status({ query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 55000 } })` once per exact Job and read its `answer`; Activity and overview queries never contain Job answers. Timeout or wait abort does not stop Codex. See [docs/input-contracts.md](docs/input-contracts.md) for the ChatGPT-facing argument boundary and [docs/output-contracts.md](docs/output-contracts.md) for the final model/app/operator/text projections and byte budgets.

## UI cache-key and Plugin Refresh policy

`package.json` is canonical for the bridge/runtime and release SemVer. `release-manifest.json` is canonical for the remaining release identity and policy, personal/local plugin metadata, and UI resource policy; its `release.version` is a synchronized mirror of the package version. `npm run release:sync` updates that mirror and generates `.codex-plugin/plugin.json` and `.app.json`, including the display name, developer, category, release SemVer, and existing ChatGPT developer-mode connection. Settings and Activity URIs are immutable content hashes of the final HTML/JS/CSS plus host-affecting metadata:

```text
ui://codex-mcp-bridge/settings/<sha256-prefix>.html
ui://codex-mcp-bridge/activity/<sha256-prefix>.html
```

`ui-manifest.lock.json` and `ui-resources/` contain source-side current/retained snapshots. `npm run release:sync` is the only command that updates them and the generated source manifest. Build reproduces `dist/ui-manifest.json` and packages each current URI. Non-Activity history follows its configured minimum; immutable Activity history remains registered so cached mounted conversations can refresh even after the Activity minimum advances. Raising the Activity minimum controls new descriptors, not deletion of retained Activity assets. `release:check` rejects content/digest, metadata, resource/descriptor, `ui.resourceUri`, `openai/outputTemplate`, missing-resource, duplicate-URI, or snapshot drift.

SemVer and UI identity are independent: a release-only version change preserves unchanged UI URIs; a UI or relevant resource-metadata change creates a new URI even within the same development version.

A routine bridge, tunnel, or machine restart with the same packaged build does not change these URIs and does not require a ChatGPT plugin Refresh. Refresh is required only after tool or UI metadata changes. Supported cached descriptors continue resolving through the retained compatibility resources while the new descriptor is adopted.

Deployment order:

1. run `npm run release:sync`, `npm run release:check`, and `npm run check`;
2. deploy/restart the server that serves the current and all supported compatibility resources;
3. in ChatGPT Developer mode, open the plugin detail and select **Refresh**;
4. confirm `codex_settings`'s output template equals the current Settings URI in `dist/ui-manifest.json`;
5. smoke-test Settings open/save/model refresh/default restore and Activity rendering in a new conversation;
6. check an existing conversation. Its supported cached UI URI must still resolve; request tool rediscovery or start a new conversation only to adopt the new tool metadata. The bridge cannot force cached conversation metadata to refresh.

See [docs/chatgpt-setup.md](docs/chatgpt-setup.md) for the operator checklist and [docs/releasing.md](docs/releasing.md) for release details.

## Persistence and recovery

SQLite schema v8 stores conversation scopes, the private immutable project registry, project-pinned Agents and thread history, Activity-Agent assignments, Activities, jobs, bounded events/results and execution audits, split settings/registry generations, scope versions, idempotent Agent mutations, completion outbox rows, first-class cancellation operations/intents, and bounded transport observations. A bounded sanitized App Server late-response journal and aggregate counters support timeout reconciliation without retaining raw response bodies, prompts, commands, paths, raw host metadata, or authentication material.

Older session/job/Activity rows migrate to deterministic scope-local Legacy Agents. Their names, assignments, thread history, and terminal assignment releases remain explicit. Existing JSON settings/session/job files are imported once. An in-flight job found after restart becomes `interrupted`; the bridge does not claim that the former process is still running.

App Server threads are checked by exact ID with `thread/read` before resume. MCP Server thread context is worker-generation-local and can become unavailable after restart. The bridge never silently substitutes a new thread.

## Development and releases

Work on `dev`. The GitHub workflow runs only on `main`; do not promote or push to `main` without explicit instruction.

`package.json` is the bridge/runtime and release SemVer source of truth. `release-manifest.json` carries its synchronized version mirror plus the remaining release policy, product/package identity, personal/local plugin metadata, exact supported App Server CLI, toolchain, repository, core v1 release assets, and UI resource policy. Normal version change:

```bash
npm run release:version -- patch
npm run release:check
npm run check
```

After an intentional UI, metadata, or manifest edit:

```bash
npm run release:sync
npm run release:check
npm run check
```

Do not hand-edit `.codex-plugin/plugin.json`, `.app.json`, generated UI manifests/snapshots, or use `npm version` directly.

Repository `skills/` is the source of truth. GitHub Release publishes the
install/deployment archive `codex-mcp-bridge-skills-<bridgeVersion>.zip`; the
npm package is runtime-only and excludes `skills/`. To make an archive locally:

```bash
npm run skills:package -- --output /tmp/codex-mcp-bridge-skills-0.3.0.zip
```

`npm run skills:check` verifies the manifest/frontmatter and ZIP contents in a
temporary directory, and proves with `npm pack --dry-run` that `skills/` is not
in the npm tarball. It is deliberately separate from `release:check` and the
runtime `build`, so a skills-only release concern cannot block bridge startup.
See [docs/releasing.md](docs/releasing.md#skills-distribution).

The current product/repository/package names include **for ChatGPT**. Bare `codex-mcp-bridge` values are a retained runtime namespace covering the executable, environment prefix, private dotenv directory, local state directory, tunnel profile, and MCP App URI namespace.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_MCP_BRIDGE_HOST` | `127.0.0.1` | HTTP bind host |
| `CODEX_MCP_BRIDGE_PORT` | `8765` | Direct-server port; launcher defaults to `8876` |
| `CODEX_MCP_BRIDGE_ENV_FILE` | `~/.config/codex-mcp-bridge/.env` | Explicit private dotenv path for bundled launchers |
| `CODEX_MCP_BRIDGE_TOKEN` | unset | Bearer token unless loopback no-auth is used |
| `CODEX_MCP_BRIDGE_NO_AUTH` | unset | Allowed only on loopback |
| `CODEX_MCP_BRIDGE_CODEX` | `codex` | Codex CLI command; App Server requires the manifest-pinned exact version |
| `CODEX_MCP_BRIDGE_DEFAULT_SANDBOX` | `read-only` | Adaptive omission/default sandbox |
| `CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY` | `adaptive` | Initial saved access strategy |
| `CODEX_MCP_BRIDGE_ALLOW_WRITE` | unset | Enables workspace-write capability |
| `CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS` | unset | Enables danger-full-access capability |
| `CODEX_MCP_BRIDGE_APPROVAL_POLICY` | `on-request` | `untrusted`, `on-request`, or `never` |
| `CODEX_MCP_BRIDGE_DEFAULT_BACKEND` | `mcp-server` | New-thread backend: `mcp-server` or `app-server` |
| `CODEX_MCP_BRIDGE_DEFAULT_MODEL` | unset | Optional automatic fallback model seed; requires effort seed |
| `CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT` | unset | Optional automatic fallback effort seed; requires model seed |
| `CODEX_MCP_BRIDGE_MODEL_SELECTION_CEILING` | unset | Immutable JSON model/effort ceiling |
| `CODEX_MCP_BRIDGE_MODEL_CATALOG_CACHE_TTL_MS` | `600000` | Successful catalog TTL |
| `CODEX_MCP_BRIDGE_MODEL_CATALOG_TIMEOUT_MS` | `30000` | Catalog refresh timeout |
| `CODEX_MCP_BRIDGE_STATE_DATABASE_FILE` | `~/.codex-mcp-bridge/state.sqlite` | Primary private state |
| `CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS` | `30` | Operator/job admission ceiling; hard maximum `100` |
| `CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE` | `4` | Lazy upstream worker pool |
| `CODEX_MCP_BRIDGE_MAX_PROMPT_CHARS` | `50000` | Prompt limit |
| `CODEX_MCP_BRIDGE_JOB_TTL_MS` | `21600000` | Active result-retention window |
| `CODEX_MCP_BRIDGE_JOB_STALE_AFTER_MS` | `600000` | No-progress observation threshold |
| `CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS` | `100` | Retained-job maximum |
| `CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES` | `1048576` | Result-size maximum |
| `CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN` | unset | Explicit filename-preflight bypass |
| `CODEX_MCP_BRIDGE_ENABLE_RECOVERY_TOOLS` | unset | Explicitly enables private transaction-guarded Agent assignment recovery |
| `CODEX_MCP_BRIDGE_DEBUG` | unset | Local diagnostics/upstream stderr |

Legacy `DEFAULT_SESSION_MODE`, `AUTO_RESUME_TTL_MS`, `FAST_RETURN_MS`, and `UPSTREAM_TIMEOUT_MS` variables are ignored with migration warnings. The pre-fork `CODEX_GPT_BRIDGE_*` prefix is a temporary compatibility fallback.

`CODEX_MCP_BRIDGE_ROOTS` remains accepted only as a backwards-compatible
restriction for older direct-server deployments. The bundled launchers never
set it; remove it to use the Settings project registry as the sole folder list.

Historical attribution is in [UPSTREAM.md](UPSTREAM.md).
