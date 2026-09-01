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

- `codex_task`: create or reuse a named Agent, create or attach an Activity, run one exact Codex turn without mounting UI, and return a completed foreground Job's bounded structured `answer`.
- `codex_status`: inspect authoritative scope, Agent, Activity, thread, turn, and job state through one optional discriminated `query`; only an exact completed Job query returns its bounded `answer`.
- `codex_dashboard`: explicitly open a read-only overview of Codex work across conversations currently retained by this personal bridge.
- `codex_steer`: add bounded guidance to one exact same-scope active App Server Job without creating or queuing another turn.
- `codex_activity`: present one compact monitor after a batch of Task calls, or explicitly open the localized, scoped, paginated full Activity card on user request.
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

### Active-turn steering

`codex_steer` is the model-visible active-turn counterpart to terminal
follow-up work:

```text
active App Server turn + relevant delta -> codex_steer
idle or terminal Agent + more work      -> codex_task with existing Agent + continue
```

Its entire public input is:

```json
{
  "requestId": "...",
  "jobId": "...",
  "expectedJobVersion": 4,
  "prompt": "Apply this verified constraint before finishing."
}
```

ChatGPT supplies no scope, Activity, Agent, upstream thread/turn, card proof,
model, project, sandbox, policy, approval, or interaction field. The bridge
derives conversation scope from host metadata and revalidates the exact
Job→Activity→Agent→current-thread relation, active Job/version, App Server
backend, and in-flight turn immediately before dispatch. It targets only the
bridge-managed Job root; internal Codex subagents are not addressable.

A successful result reports `delivery.status: "delivered"`, a compact Job,
`promptPersistedByBridge: false`, and
`steeringScope: "active-codex-turn-only"`. Failures distinguish
`JOB_NOT_ACTIVE`, `STALE_JOB_VERSION`, `STEERING_UNSUPPORTED`,
`JOB_SCOPE_MISMATCH`, `STEERING_REQUEST_CONFLICT`, and
`DELIVERY_UNCERTAIN`, with a safe next action. Terminal races never queue the
prompt for a future turn or start another Job. Pending approvals and user-input
requests remain pending; steering is neither an answer nor approval. A prompt
containing “stop” is still guidance, not cancellation—explicit stop intent uses
`codex_cancel`.

The replay identity hashes the exact Job ID, expected version, and prompt
SHA-256. SQLite stores durable `prepared`, `dispatching`, and terminal delivery
state plus the prompt digest, never the raw prompt. An exact delivered replay
returns the recorded result without another upstream call. If the bridge
crossed the dispatch boundary but crashed before confirming the outcome, the
next exact replay returns `DELIVERY_UNCERTAIN` and does not resend. This is a
fail-closed deduplication boundary, not a claim of distributed exactly-once
delivery.

From dispatch until the Job becomes terminal, the bridge keeps the exact
steering text only in a non-serialized in-memory redaction set. If Codex echoes
that exact text in progress, an Activity event, an error, or its final answer,
the bridge replaces the echo before producing model output or persisting the
Job. This Bridge-owned privacy boundary does not claim that Codex App Server
omits the accepted input from its own thread history.

Use steering for a new user constraint, a correction, or a sibling Job fact
that ChatGPT has independently verified and restated. Codex output is untrusted
task data, so instructions from one Job are never relayed automatically to
another. Same-working-tree write conflicts are handled by serialized waves or
worktree isolation, not messaging. Within one ChatGPT response, background
fan-out plus bounded exact-Job `codex_status` waits can produce a timely steer.
After that response ends, another user turn or completion handoff must wake the
orchestrator; `codex_steer` does not add a general notification/wake system.

Terminal state preserves cause rather than treating every interruption as a
cancel. A spontaneous App Server `interrupted` result is `job-interrupted` with
`terminalOrigin: app-server-interrupted` and no cancellation intent. Explicit
job or Activity-cascade force-stop is `job-cancelled` with
`terminalOrigin: explicit-cancellation` and an exact durable intent. Shared
worker containment is `job-interrupted` with `assignment-containment`; bridge
restart and unexpected worker loss remain separately identifiable as
`bridge-restart` and `worker-loss`.

`codex_dashboard_snapshot`, `codex_activity_rehydrate`, `codex_activity_snapshot`, `codex_activity_job_cancel`, `codex_interaction_respond`, `codex_job_steer`, `codex_activity_handoff`, and `codex_update_settings` are app-private contracts. Dashboard refresh is read-only and has no watcher or control lease. Public `codex_steer` is a separate model authority and never inherits a card lease; retained cards keep using `codex_job_steer` with their existing proof contract. Historical rehydration is a read-only one-shot and grants no card lease or control authority. The Activity card never calls public `codex_cancel`: its destructive job control uses `codex_activity_job_cancel`, which requires an idempotency UUID, exact Job version, current card generation and presentation proof, a live widget lease, and any exact shared-worker acknowledgement. A stale or superseded card fails closed before an intent or side effect is created. Settings mutation uses independent `expectedSettingsRevision` and `expectedRegistryRevision` compare-and-swap tokens with one discriminated reset/patch `operation`; patch groups Activity-card preferences and explicit project add/rename/relocate/archive/restore deltas in one transaction. The other Activity controls require the same exact mounted-card proof and active widget-session lease; interaction and steering requests also require an exact Job version and idempotency UUID. `codex_background_process_terminate` is a destructive app-private control bound to that lease plus the Agent version, App Server thread, and process. `codex_agent_recovery_detach` is a private recovery action that is disabled unless the operator explicitly enables it.

Every bridge tool that returns MCP `structuredContent` declares an `outputSchema`. A delivered Task or exact Job status includes its model-authoritative final text as a 24-KiB JSON-encoded bounded `answer`; `content` keeps the original retained compatibility copy. UI-bearing Activity, Dashboard, Settings, and snapshot tools additionally describe the private view shape their components consume, so the host can validate and hydrate the tool result before mounting the card. Task tools are intentionally UI-free.

## Security defaults

- Binds to `127.0.0.1`.
- Uses `read-only` and `on-request` unless the operator enables broader capabilities.
- Uses one settings-managed registry with server-generated immutable UUID identities, normalized Unicode names, and canonical folders. UUIDs and folders stay private; a normal fresh install starts empty and has no implicit/default selection.
- Rejects per-call `cwd` in the strict Task schema instead of running in an unintended repository.
- Publishes one operator-bounded `sandbox` shape in stable Task contract v2; fixed `read-only` and `always-full` settings reject an explicit override and enforce the saved policy at runtime.
- Resolves every newly saved project to an existing canonical folder, rejects files and active normalized-name/canonical-path collisions, and checks common secret filenames before new execution.
- Limits prompt size, concurrent jobs, retained jobs, and retained result size.
- Stores settings, sessions, Agents, Agent/thread history, Activity assignments, jobs, bounded results, cancellation operations/intents, prompt-free steering delivery records, and bounded transport observations in a private SQLite database.

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
- [Multi-agent orchestration](https://developers.openai.com/api/docs/guides/responses-multi-agent)
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

The default command uses the supported stateless HTTP path. A separate
persistent-stdio profile remains available for experimental transport
diagnostics through the same tunnel ID; stable Task contract v2 does not depend
on it for ordinary Settings changes:

```bash
npm run bridge:secure:stdio
```

The stdio launcher configures `sample_mcp_stdio_local` with
`node dist/stdio.js` and defaults to the separate
`codex-mcp-bridge-stdio` tunnel-client profile, so evaluating it does not
overwrite the normal HTTP profile. Run only one profile against the tunnel at a
time. The tunnel owns the stdio child lifecycle; all Settings, project, Job,
Activity, Agent, and replay state still uses the same bridge SQLite database.

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
current allowed range for every new Activity, new Agent, or fresh context. The
bridge publishes no preferred pair or task-to-model mapping. Settings also
persists one required exact fallback pair for defensive omission handling; it is
not exposed to GPT as a recommendation or schema default. Continue/fork
omission inherits the admission-time selection; an explicit pair requests an
override only when the descriptor and backend permit it. Legacy policies saved
without an exact fallback continue to use the validated backend catalog default
until the Settings card saves its preselected pair.

Priority is an independent user preference, not part of the model policy. GPT sees and selects only `model` and `reasoningEffort`. When Priority is enabled, the bridge validates that the chosen model supports the Priority/Fast tier and injects the catalog's `priority` (or `fast`) identifier only into the downstream Codex call. Existing MCP threads retain their admission-time tier when that backend cannot change tiers on continuation.

`Show bridge threads in the Codex app` defaults off. With the App Server backend, newly created and forked threads are therefore ephemeral and stay out of the Codex app list unless the user enables this preference; existing threads are unchanged. Ephemeral threads live only in their App Server worker and cannot be resumed after that worker or the bridge restarts. The current MCP Server tool contract has no ephemeral-thread option, so the card saves the preference but explains that hiding requires switching the bridge backend to App Server and restarting.

Opening Settings resolves the model catalog through the normal short-lived cache. There is no persistent refresh control or polling; when the lookup is stale or fails, the card keeps the last-known-good catalog and shows a contextual retry action.

The Activity card has one conversation-scoped flat-feed layout. Older saved
layout preferences are safely discarded; there is no layout selector or active
layout setting.

The Projects section is the single place where Codex start folders are configured. Users enter only a project name and an existing absolute folder; the server generates a private immutable UUID and keeps it stable across rename, relocate, archive, and restore. The folders may be unrelated and live anywhere on the PC. Saving resolves folders with `realpath`, rejects files and active normalized-name/canonical-path collisions, and never derives identity from a name or slug. No project is a default: every new Activity or fresh Agent context must use one exact current selector resolved by `codex_task.projectLookup` in the same conversation. If a saved folder later disappears, its metadata remains visible for recovery but cannot admit new work until the folder is restored or the project is archived. Archived projects are not selectable; restore keeps the same UUID. Legacy project/default identifiers are intentionally not imported into this identity model.

The generation-9 Settings card saves one atomic `operation`. `reset` restores only general preferences and preserves project UUIDs, names, folders, order, archive state, and recovery metadata. `patch.settings` contains only changed policy/preferences and a bounded `projectOperations` list whose `add`, `rename`, `relocate`, `archive`, and `restore` variants expose only their relevant app-private fields. Ordinary settings use `settingsRevision`; the project registry uses an independent `registryRevision` that advances exactly once for each effective project transaction, regardless of the number of operations. Both generations are checked immediately before the single commit. Earlier Settings generations are retired because their ID/default and single-revision mutation contracts are incompatible with this boundary.

`codex_task` contract v2 publishes a generic closed `{ name, projectRef, projectRevision }` shape and a same-tool no-work `projectLookup: { name }`; it never embeds the registry inventory, internal UUIDs, or paths in its descriptor. Lookup returns the exact current selector in `nextActions` and creates no Activity, Agent, Job, session, filesystem mutation, or upstream turn. `projectRef` is opaque, restart-stable, and never reused; `projectRevision` advances once for an effective rename, relocate, archive, or restore transaction affecting that project. External folder deletion, mount loss, and restoration do not rewrite the revision. The global `registryRevision` remains only the Settings compare-and-swap generation. Every new Activity or fresh Agent context requires one exact current object, even when only one project is registered. Omission fails with `PROJECT_REQUIRED`; with no registered project it returns structured `PROJECT_SETUP_REQUIRED` with `codex_settings` as the next action. Runtime ref/revision/name, active/available state, and canonical-root resolution are the safety boundary. A stale selector fails closed and returns same-tool lookup recovery without a connection Refresh; an unrelated project mutation leaves an unchanged selector valid. The project is rechecked in the same SQLite transaction as Activity, Agent creation/assignment, replay registration, and Job admission, pinning the immutable private UUID plus canonical cwd snapshot. Continue/fork omits `project`, retains that snapshot across registry changes, and returns `PROJECT_UNAVAILABLE` without fallback if the pinned folder cannot be resolved exactly. An exact admitted v7 `requestId` replay retains its original admission/result after later settings, catalog, or registry changes. Legacy `{ name, registryRevision }` and public `executionPolicyRef` inputs remain bounded cached pre-v2 migration paths only.

The ref/revision guard prevents stale project mappings. It does not prove natural-language intent when a caller supplies a different complete, currently valid project selector; both choices are valid under this transport contract. A stronger user-confirmation capability for multi-project write/full-access fresh work remains a separate app-private follow-up, not a model-visible `confirmed` flag.

Access strategy and project selection are separate:

- `read-only`: every new context is read-only; an explicit `sandbox` override is rejected.
- `always-full`: every new context is `danger-full-access`; an explicit override is rejected.
- `adaptive`: `codex_task` may choose an operator-enabled sandbox for the concrete request. Omission uses the configured default.

ChatGPT plugin permissions decide whether the host confirms an MCP call; they do not choose a Codex sandbox. `CODEX_MCP_BRIDGE_APPROVAL_POLICY=never` removes Codex's second approval boundary and should be used only for a trusted private connection where ChatGPT permission is deliberately the outer boundary.

Settings are shared by the bridge instance, not isolated per ChatGPT account. The private tunnel/no-auth connection supplies no end-user identity.

## Dynamic model and reasoning-effort catalog

App Server `model/list` is authoritative for an App Server target. The installed CLI catalog is the MCP source and bounded fallback. The bridge records catalog source, fetch/validation time, fingerprint, cache/LKG status, picker visibility, default model/effort, supported efforts, upgrade metadata, and service tiers.

The Settings card builds model and effort options from that catalog; new upstream values do not require a card release. Each effort option contains only a short localized label. The selected effort's description appears in a separate `aria-describedby` helper below the selector. The GPT-facing stable `codex_task.selection` is one generic closed `{ model, reasoningEffort }` shape; `codex_models` and runtime admission expose and enforce the current allowed values. The bridge adds no task mapping, ranking, recommendation, or locally authored effort glossary. The saved omission fallback is not encoded as a schema default, marker, ordering hint, or public model-result summary, and catalog default flags remain app-private.

Contract v2 requires exact `taskContractVersion: "2"` and a 64-hex `executionEnvelopeRef`. The opaque installation-keyed envelope binds the stable input generation and operator-owned maximum/static authority: prompt bound, command/backend, allowed roots, sandbox capabilities, approval policy, model ceiling, and secret preflight. Saved access/model/presentation settings, projects, availability, and the live catalog are deliberately excluded. Their changes take effect immediately at runtime while the complete public Task descriptor stays byte-identical, so existing v2 conversations need neither `tools/list_changed` nor Developer-mode Refresh.

Every new v2 call privately captures an exact mutable execution-policy HMAC over saved model/access/priority/thread-visibility/concurrency settings plus the resolved admission catalog, then rechecks it at asynchronous and serialized admission boundaries. A concurrent change returns `EXECUTION_POLICY_CHANGED` before Activity, Agent, Job, filesystem preflight, or upstream work; retry the same stable contract with a new `requestId` and no connection Refresh. `MODEL_POLICY_CHANGED`, `MODEL_UNAVAILABLE`, and `MODEL_SELECTION_FORBIDDEN` are runtime selection errors recovered through `codex_models`, current Settings, and a new logical call—not schema rediscovery. Exact admitted v7 replays return their retained result first. A cached pre-v2 descriptor remains bound to its public `executionPolicyRef` and needs one Refresh to migrate to v2 after it becomes stale. `EXECUTION_ENVELOPE_CHANGED` is reserved for an operator/static contract change and does require Refresh.

Stateless Streamable HTTP remains the default. Experimental stateful HTTP and persistent stdio retain bounded notification/re-list diagnostics for genuine static descriptor or UI changes, but ordinary settings/catalog/project changes do not publish a new descriptor epoch. Transport notification or re-list evidence never proves host adoption. The byte-framed stdio integration test verifies that a saved settings change leaves the same descriptor and emits no false `tools/list_changed` notification. No separate service or external session store is introduced by either transport.

Known effort IDs use deterministic locale dictionaries. An unknown upstream effort remains selectable with its canonical label and a localized generic description. Missing translation coverage is diagnostic and does not block catalog refresh.

If a saved effort disappears, the bridge does not silently rewrite it. Settings
shows a localized warning and runtime may use the policy's validated transient
compatible fallback while recording both the warning and effective effort. An
invalid explicit selection fails before admission and is retried from the same
stable contract after reading `codex_models`; no connection Refresh is needed.

The saved `modelPolicy` is either:

- `fixed`: one exact model/effort selection; or
- `automatic`: current catalog-visible selections or an explicit exact allowlist,
  with one exact omission-only configured fallback for every newly saved policy.

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

Every `codex_task` call requires a fresh UUID `requestId`; reuse it only for an exact retry. Task execution has no presentation field and never mounts UI. After all Task calls for one assistant response have been admitted, make at most one `codex_activity` call with `mode: "compact-monitor"` and one fresh UUID `presentationId` when the saved visibility policy allows it. Reuse that ID only for an exact presentation retry. The public Task contract intentionally has no caller scope, presentation correlation, local path, arbitrary thread, model-policy revision, or legacy flat routing fields.

Routing fields are:

- pass the descriptor's exact `taskContractVersion` and `executionEnvelopeRef`; for new/fresh work resolve an unknown selector through same-tool `projectLookup`, then pass exact `project: { name, projectRef, projectRevision }`; omit `project` only for an existing Activity/thread continue or fork that inherits its pin;
- use `activity: { mode: "existing", id }` for another turn in one exact open Activity;
- use `activity: { mode: "new", continuationOf?, title?, policy? }` to create a new or linked Activity; `policy` may contain `kind`, `handoff`, and `completion`;
- use `agent: { mode: "existing", id, context?, handoffSummary? }` to continue, fork, or deliberately replace one exact Agent context; `handoffSummary` is required only for an explicit fresh cross-backend replacement;
- use `agent: { mode: "new", name? }` to create a fresh Agent;
- omit `activity` and `agent` for a new Activity and Agent with neutral server defaults.

For example:

```json
{
  "requestId": "...",
  "taskContractVersion": "2",
  "executionEnvelopeRef": "<exact 64-hex value from tools/list>",
  "project": { "name": "Bridge Workspace", "projectRef": "prj_...", "projectRevision": 4 },
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

One Agent/thread admits only one active turn. Different Agents/threads can run in parallel in the same scope and folder. If an existing Activity has multiple Agent candidates, the bridge requires an exact nested Agent ID instead of guessing. Activity title, kind, handoff, completion, Agent name, fresh context, and assignment role have neutral defaults; generated Agent names are deterministic from `requestId` and remain unique within a scope. The assignment role defaults to `primary` and is display-only metadata: it is read only for Activity/history presentation and never participates in routing, authorization, context selection, lifecycle transitions, or handoff eligibility. New-Activity policy, Activity/Agent creation, assignment, v6 replay registration, and Job admission commit in one transaction. Exact v6 replay and the frozen v5 migration-replay path return the retained Job before current project/policy validation and never create new work. The expired flat routing envelope is rejected by the strict current contract.

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

Active/waiting Agents and Agents with a remaining background process cannot be archived. For an active Job, the mounted Activity card shows **Force-stop Agent work** and cancels that exact Job. Only after the Agent is idle does it expose **Stop background processes** for exact remaining App Server terminals through the separate destructive `codex_background_process_terminate` capability. Exceptional assignment repair uses `codex_agent_recovery_detach`, requires exact Activity/Agent/version preconditions, rechecks idle state transactionally, and is disabled by default. Force-stop, background-process termination, recovery detach, and archive are distinct operations; none rolls back filesystem changes. Permanent Agent/thread deletion is not exposed.

## Activity card lifecycle

`codex_task` is execution-only: its descriptor has no Activity UI binding, it accepts no presentation input, and its result carries no Activity-card bootstrap metadata. This prevents one host card shell from being created for every Agent or Task call. After all `codex_task` calls intended for one assistant response, GPT applies the saved visibility policy once: `always` permits one compact presenter call, `background-only` permits one only if at least one admitted call used `executionMode: background`, and `never` permits none. The presenter is `codex_activity({ "mode": "compact-monitor", "presentationId": "...", "activityId": "..." })`; `activityId` is an optional focus, not a grouping key. Calling the presenter once per Task or Agent is invalid orchestration.

`codex_activity` defaults to `mode: "full-history"` for an explicit user-requested open or reopen. Compact-monitor calls create the automatic presentation class and own the bounded live watch and completion-handoff path; full-history calls create the explicit class, use separate bounded watcher admission, and never claim automatic handoff. Retained pre-decoupling Task resources may still use `codex_activity_rehydrate` for historical mounts, but new Task descriptors cannot create those shells.

`requestId` and `presentationId` have deliberately different scopes. GPT creates one `requestId` for each logical Task call and reuses it only for the same execution retry. It creates one `presentationId` for the single compact-monitor call made after that response's Task fan-out and reuses it only for an exact presentation retry. Presentation state is absent from Task replay identity, so it cannot start or alter Codex execution, and the saved visibility policy remains authoritative.

The automatically mounted card is a compact operational feed for the current ChatGPT conversation. Only work that is running, terminating, blocked on the user, awaiting verification/handoff, or needs recovery remains as an Activity row. Rows are ordered by user block, recovery, result review, and progress; ties use most-recent change time and then Activity identity for stability. Each row shows the Activity title, named Agent participants, separate roles, kind, timing, each participant's current or latest effective model/reasoning-effort selection, and only the action needed now. The primary state follows current work, so an active retry remains **Running** instead of being overwritten by an earlier failed Job. A localized previous-failure count appears as secondary context only when that count is positive and the primary state is not already **Failed**. Models use the same catalog display names as Settings and fall back to their internal IDs only when no display name is available. If App Server reports a model reroute, the card shows the admitted model and rerouted model as `selected → rerouted`; the effort remains the admission-time effective effort. It has no KPI dashboard, card-grid Agent list, or layout selector.

Completed and ended Activities plus otherwise-unused idle Agents are omitted from the automatic payload as individual history rows. One localized summary reports exact distinct Activity and Agent counts, for example **Past records · Completed activities 12 · Ended activities 3 · Idle agents 2**. An Activity is folded only after its lifecycle is actually completed and it has no active/terminating Job, pending interaction, verification, completion handoff, open assignment, or App Server background process. Counts are Activity-centric, so reusing an Agent does not erase an earlier completed Activity.

When the user explicitly asks for all work, `codex_activity` opens the full scoped view. It reuses the same row calculation and explicit watcher class, but returns current and historical Activity rows plus idle Agents through a bounded opaque cursor. The cursor is tied to the conversation scope version and safely resets when live ordering changes. An exact requested Activity opens on the page that contains it. This explicit view never acquires automatic completion-handoff ownership, and detailed Job answers, events, paths, and diagnostics remain on their existing exact-status or private surfaces.

### Bridge-wide Codex overview

`codex_dashboard` is a separate explicit card for the personal bridge. Ask for the “Codex overview across all conversations” in any connected ChatGPT conversation, then keep that conversation as the overview location. This personal, single-user view is registered unconditionally: there is no Dashboard operator flag or extra per-user configuration. Reopening the conversation, returning to the page, or pressing refresh calls the app-private read-only `codex_dashboard_snapshot`; the card intentionally does not hold a long poll, Activity watcher slot, completion-handoff owner, or control lease. A dormant card cannot receive server-pushed UI updates while the host has not mounted it, so re-entry and manual refresh are the reliable update points. Generation 11 preserves the status-first presentation introduced in generation 7, in the fixed order **Active Codex work → Recent Codex turn outcomes → Idle Codex agents**. Project and GPT conversation are row context rather than alternative grouping modes.

“All conversations” means every conversation scope that this bridge can still identify from live Jobs, result-free archived Job summaries, non-archived Agents, or tracked threads—not the user's complete ChatGPT history. By default, result-bearing Jobs expire after six hours and at most 100 are retained; the Dashboard reads at most 10,000 archived summaries and the tracked-thread registry retains at most 1,000 entries. Archived summaries contain no prompt, result, error, command, or event body. The public call returns an aggregate text/structured summary immediately so the card can mount without waiting for runtime probes. The mounted snapshot performs bounded read-only checks for at most 100 recently updated App Server Agents, with a 1.5-second per-Agent bound and a nine-second overall budget. Agents outside the bounded set, timed-out probes, and probes deferred by the deadline are counted as skipped; unavailable checks are counted as unknown, and unloaded historical threads are not awakened merely to populate this overview. Refresh is therefore a current retained-state snapshot, not a live health check of every historical Codex thread.

Primary status is calculated only from Codex-owned runtime facts: exact Job running/terminal/termination state, tracking liveness, Agent lifecycle, pending input or approval interactions emitted by Codex, and confirmed App Server background-terminal counts. It never reads Activity `lifecycle`, `waitingOn`, `verification`, completion handoff, or GPT's judgment that a user goal is done. Consequently **Codex turn completed** means only that the retained Job status is exactly `completed`; `failed`, `interrupted`, and `cancelled` remain separate outcomes. The **Attention states** summary is deduplicated per Agent from its latest retained outcome, so an older failed attempt no longer keeps the count elevated after a later running or completed retry. It is a neutral count of Codex states that warrant notice, not an instruction that the user or GPT must verify them. A remaining App Server terminal is shown separately as **Background process running** and is not treated as a running Codex turn.

Generation 7 renders representative Agent rows directly in their Codex status buckets and omits project/conversation group pages from normal snapshots. The server computes those larger projections only when an immutable older card sends its compatibility offsets. Active rows are returned in one bounded set. Recent and idle rows initially load 20 representatives; **Show more** appends the next rows in place instead of replacing the visible list with previous/next pages. An opaque stable row key prevents a renamed Agent or moved status from leaving a duplicate cached row, and a clamped offset rebases the affected page. The idle section starts collapsed on every fresh card and preserves its disclosure state during ordinary refreshes in the mounted iframe. Each Agent appears once in its current bucket, while up to 12 older calls are sent inside that Agent's collapsed history with the full retained-history count shown.

Rows expose only stable hashed conversation, project, and internal row correlation keys, a compatibility conversation alias in the private contract, the user-defined project label, display Agent name, optional Activity title, Codex status, timing, a background-process count, effective model/reasoning-effort selection, and narrowly validated private navigation targets. Project UUIDs and paths are never projected. The Agent name is the heading. Its current turn—or latest retained turn when inactive—is the default content, while older retained calls are grouped newest-first inside an initially collapsed history. A historical model/effort is shown only when that exact turn retained it; the current tracked session selection is labeled separately on an idle Agent and is never presented as an unknown historical turn's execution. Archived rows created before duration retention show the outcome time with duration unavailable instead of a fabricated zero. The card never prints a session ID, thread ID, or alias as text. For an App Server row with UUID-shaped lineage, it renders **Open in Codex** using `codex://threads/<uuid>`. The exact current thread UUID is preferred because forked threads can retain a shared session-tree ID; the session UUID is only a fallback, and non-App-Server or non-UUID values are omitted. The route is not probed. Separately, OpenAI defines `openai/session` as an anonymized correlation value rather than a navigable-route guarantee. When the host supplies a UUID-shaped value, the bridge retains a bounded private scope-to-value mapping and renders a best-effort **Open conversation** link to `https://chatgpt.com/c/<uuid>`; arbitrary host session values are neither persisted nor linked, and scopes retained before this capture cannot be backfilled because their raw values were intentionally not stored. The Dashboard CSP allows both validated navigation targets for `openExternal`, and the ordinary anchor remains the fallback. Active timing shows only start-to-now elapsed duration; it omits last-status-update age. Completed, failed, interrupted, and cancelled turns show start-to-terminal duration when known and time since that exact outcome. Model catalog display names are preferred, the model ID is the fallback, and a reported runtime model reroute is shown as `selected → rerouted` while effort remains the admission-time effective effort. If a refresh transport fails after hydration, the card keeps the last loaded snapshot, reports the stale state non-destructively, suppresses repeated automatic retries, and lets the refresh button retry explicitly. A standard call that was already dispatched is not duplicated through the compatibility alias after its timeout. Outside those private navigation targets, raw Job, Activity, Agent, thread, worker, and process IDs; filesystem paths; prompts; results; errors; commands; and diagnostics are absent. Display labels, Activity titles, and the navigation links can still reveal or navigate to cross-conversation task context, which is why this card belongs only on the bridge's single trusted user's connection. The widget-instance UUID is mount correlation, not authentication. The card has no cancel, steer, approval, handoff, archive, or process controls.

Agent archive/restore is bridge-local logical state. It never calls App Server `thread/archive` or `thread/unarchive`, so archiving one logical Agent cannot implicitly archive another Agent's descendant fork.

The card does not expose event timelines, Agent/job/thread IDs, full working paths, backend/worker details, command output, Job answer bodies, or general steering. When multiple projects are active, it may show their user-defined labels. Approval/user-input controls are sent only in a minimal UI-only metadata payload and answered through the one-shot app-private interaction contract; raw answers are not persisted. GPT can retrieve compact semantic state with `codex_status`; a completed result requires one exact Job query and its `answer`. Build/auth/storage/HMAC/pool/upstream forensics stay in the model-hidden `codex_diagnostics` surface.

The primary duplicate-prevention boundary is structural: any number of `codex_task` calls produces zero Activity shells, followed by at most one compact-monitor `codex_activity` shell. Mount races and exact presentation retries are additionally suppressed per `scopeId + presentationId` (projected privately as `activityPresentationId`). The first valid `codex_activity_snapshot` confirms ownership; a second iframe racing for the same presentation receives `presentation-duplicate` and collapses. `activityId + cardGeneration` remains only the mounted Activity validity check. A mounted widget renews its lease by widget instance; abort/unmount/TTL releases it, and restart does not restore presentation ownership. After restart, the first valid mounted compact card safely re-establishes ownership.

Only the newest **confirmed mounted** compact-monitor presentation in a conversation owns the bounded scope-version long poll and completion handoff. Confirming a newer presentation wakes the prior compact card, which keeps its last snapshot and receives a normal `presentation-superseded` stop signal instead of retrying or retaining a watcher slot. Explicit full-history cards are a separate class: at most three may watch per scope alongside the one compact owner, and they never compete for automatic completion handoff. `openai/widgetSessionId` is correlation evidence, not authorization by itself; control tools also revalidate the exact Activity/generation/presentation lease and resource ownership. UI-bearing Activity tools declare strict private/app-only output contracts. The current content-hashed Activity resource uses UI contract generation 15 while retaining the closed generation-11 private metadata envelopes and exact app-private snapshot, proof, destructive Job-cancel, control, and batch-handoff contracts for immutable older mounts. Generation 12 is the minimum for new descriptors, while every retained generation 7–15 URI remains registered for already-mounted conversations. HTTP request abort, SSE disconnect, MCP `notifications/cancelled`, status/snapshot wait abort, presentation supersession, and widget unmount are transport or presentation observations only: they may release a bounded wait/lease and write a bounded diagnostic event, but never cancel a job. `executionMode: background` returns a tracked job immediately; `foreground` waits for its terminal result and structured `answer`, and detaching that foreground response leaves the admitted job running to its normal terminal state. Neither mode changes Activity completion. For background completion or recovery, use `codex_status({ query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 55000 } })` once per exact Job and read its `answer`; Activity and overview queries never contain Job answers. Timeout or wait abort does not stop Codex. See [docs/input-contracts.md](docs/input-contracts.md) for the ChatGPT-facing argument boundary and [docs/output-contracts.md](docs/output-contracts.md) for the final model/app/operator/text projections and byte budgets.

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

SQLite schema v11 stores conversation scopes, the private immutable project registry, opaque persisted public project refs and per-project revisions, project-pinned Agents and thread history, Activity-Agent assignments, Activities, jobs, bounded events/results and execution audits, split settings/registry generations, scope versions, idempotent Agent mutations, completion outbox rows, first-class cancellation operations/intents with bounded user-facing model cancellation reasons, prompt-free steering delivery phases, and bounded transport observations. A bounded sanitized App Server late-response journal and aggregate counters support timeout reconciliation without retaining raw response bodies, prompts, commands, paths, raw host metadata, or authentication material.

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
| `CODEX_MCP_BRIDGE_TUNNEL_TRANSPORT` | `http` | Secure launcher transport candidate: `http` or `stdio` |
| `CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE` | `stateless` | Streamable HTTP mode: `stateless` or experimental `stateful` |
| `CODEX_MCP_BRIDGE_MCP_SESSION_IDLE_TTL_MS` | `1800000` | Idle lifetime for an experimental stateful MCP session |
| `CODEX_MCP_BRIDGE_MAX_MCP_SESSIONS` | `64` | In-memory stateful MCP session ceiling |
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
