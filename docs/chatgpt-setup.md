# Connect Codex MCP Bridge for ChatGPT

Issue #69 current contract: [Card tools and migration](card-tools.md). The current contract has 12 model tools and 5 app-only tools, plus 12 app-only compatibility descriptors during migration (29 discovered in total). Activity presentation, watch, rehydration and handoff contracts below apply only to cached pre-consolidation cards during the migration window; they are not instructions to open Activity for new work.

The bridge uses the selected Codex CLI's App Server for execution. ChatGPT connects to the bridge through MCP.

## 1. Prepare Codex and the bridge

Confirm that Codex is installed and authenticated:

```bash
codex --version
codex app-server --help
```

App Server connections validate the required public protocol. CLI versions are recorded for diagnostics; there is no bridge-owned version allowlist. See [installation and compatibility policy](codex-runtimes.md).

Install and verify the bridge:

```bash
npm ci
npm run check
```

On macOS, the issue #44 developer-preview app can perform the same dotenv,
runtime, Dashboard, and Settings workflow through native SwiftUI controls:

```bash
npm run macos:bundle
open "macos/build/Codex MCP Bridge for ChatGPT.app"
```

If the existing private dotenv is valid, the app reuses it without showing the
key or asking for Keychain access. On a fresh install, enter the Tunnel runtime
key and Tunnel ID in the native connection sheet. The app then starts the same
persistent-stdio bridge and retains the Developer mode + Tunnel + `No Auth`
ChatGPT connection steps below. See [macos-app.md](macos-app.md) for current
packaging and release limitations.

## 2. Create the Secure MCP Tunnel

Create an MCP tunnel in OpenAI Platform and associate it with the ChatGPT workspace that will use it. The operator needs applicable Tunnel Read/Use permissions and ChatGPT Developer mode. Keep the runtime key and tunnel ID outside Git.

```bash
install -d -m 700 "$HOME/.config/codex-mcp-bridge"
install -m 600 .env.example "$HOME/.config/codex-mcp-bridge/.env"

# Replace the CONTROL_PLANE_API_KEY and CONTROL_PLANE_TUNNEL_ID examples.
${EDITOR:-vi} "$HOME/.config/codex-mcp-bridge/.env"

npm run bridge:secure
```

That command uses the default HTTP profile. To evaluate the persistent stdio
candidate through the same tunnel ID, stop the HTTP profile and run:

```bash
npm run bridge:secure:stdio
```

The launcher uses the separate `codex-mcp-bridge-stdio` profile and configures
the official `sample_mcp_stdio_local` path with `node dist/stdio.js`. The tunnel
owns that child process. It still opens the same bridge SQLite state, so no
separate application database or infrastructure service is introduced. Do not
run the HTTP and stdio profiles against the same tunnel simultaneously.

The launcher reads that dotenv file automatically. Use `--env-file <path>` or
`CODEX_MCP_BRIDGE_ENV_FILE` only for an explicit alternate location. It rejects
symlinks, files owned by another user, and group/world-readable permissions.
Do not place the runtime dotenv file inside a registered project: the bridge's
secret-filename preflight intentionally rejects project folders containing
`.env`.

The launcher deliberately does not choose a filesystem project. After the
connection is available, register one or more existing absolute folders in the
Settings card. They may be unrelated locations anywhere on this PC. GPT receives
only their names plus an opaque public ref and per-project freshness revision,
never internal UUIDs or paths.

The HTTP endpoint defaults to stateless mode. For an Issue #43 acceptance run,
the runtime dotenv may opt into bounded process-local sessions:

```dotenv
CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE=stateful
CODEX_MCP_BRIDGE_MCP_SESSION_IDLE_TTL_MS=1800000
CODEX_MCP_BRIDGE_MAX_MCP_SESSIONS=64
```

Restarting the bridge discards those HTTP sessions and requires MCP
initialization again; no external session store or separate service is required.
Persistent stdio instead has one tunnel-owned MCP process/connection and does
not use the HTTP session registry.

The default capability profile is read-only. To enable additional bridge-owned access strategies without changing the saved default:

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
5. Verify the twelve model tools listed in [Card tools](card-tools.md); retired Activity presenters and input/cancellation aliases must not appear in the model inventory.
6. Verify five app-only tools: `codex_ui_read`, `codex_update_settings`, `codex_question_action`, `codex_ui_stop`, and `codex_interaction_respond`. The 12 retained app-only descriptors are separately marked compatibility; total discovery is 29 during migration. Operator diagnostics and recovery are opt-in.

### Refresh after a bridge/UI change

MCP App resource URIs are cache keys. This repository derives immutable Settings, Activity, and Dashboard URIs from final content plus host-affecting resource metadata. Before refreshing ChatGPT:

```bash
npm run release:sync
npm run release:check
npm run check
```

Then deploy/restart the bridge before selecting **Refresh** on the ChatGPT plugin detail screen. This order ensures that the server already serves the newly advertised current URI and every retained URI whose UI contract generation is still supported.

Do not Refresh merely because the bridge, tunnel, or computer restarted. An unchanged packaged build advertises the same immutable URIs. Refresh is needed after tool descriptors, authentication, UI content, or host-affecting UI metadata change.

On first installation of the #68 or #69 tool contract, confirm `codex_ask_user` and `codex_user_answer` in ChatGPT connection metadata after Refresh. A server `tools/list` result proves publication only; it does not prove that ChatGPT has adopted the changed inventory.

After Refresh:

1. inspect `dist/ui-manifest.json`;
2. confirm the registered `codex_settings` `_meta.ui.resourceUri` and `openai/outputTemplate` exactly equal the manifest's current Settings URI;
3. confirm `codex_task` has no UI metadata and `codex_ask_user` points to the current question URI;
4. confirm `codex_dashboard` points to the current Dashboard URI;
5. open a new conversation and run the smoke checklist below;
6. test an existing conversation. Its supported cached URI must still render; ask it to rediscover tools or use a new conversation only to pick up the new descriptor. The bridge can signal a stateful tool-list change but cannot guarantee that an already cached conversation adopted and used the refreshed metadata.

The integrated #69/#70 actual-host check confirmed that this cache can preserve
already loaded tool definitions after both connection Refresh and a fresh page
load. One old conversation retained the long Settings description, missing model
catalog v2 and Task sandbox input, while a new conversation and newly discovered
tools in another existing conversation used the current definitions. Explicit
rediscovery did not replace the old bindings. Verify the actual schema; repeated
Refresh or adding fields to an unsupported cached schema is not a migration.
See the [unlocked-host evidence](audits/2026-09-08-issue-70-unlocked-host.md).

See OpenAI's [Plugin Refresh guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata) and [MCP App UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui).

## 4. Configure the Settings card

Ask ChatGPT to open the Codex MCP Bridge for ChatGPT settings. The card saves shared bridge-instance preferences:

- access strategy;
- fixed or automatic exact model policy;
- independent Fast mode for Codex calls;
- named projects with explicit per-task selection;
- UI language;
- concurrent-job limit;
- card visibility;
- optional completion handoff.

For an automatic policy with an explicit range, the card selects models first and then reasoning efforts per model. A model's **All** control expands the currently allowed efforts into exact saved model/effort choices; it does not add an `all` value to the tool schema and does not automatically include efforts discovered later. The separate catalog-visible range remains dynamic.

**Allow Ultra reasoning** controls the `ultra` effort, which includes automatic
task delegation. Turning it off retains explicit saved Ultra choices but removes
them from GPT's executable list. If no executable choice remains, Settings can
save the restriction and shows that work is paused until another valid choice
is available. A fixed Ultra choice must be replaced before saving OFF. This
switch does not control other agent features. See [model selection](model-selection.md)
for source attribution, inheritance, fallback and the precise policy scope.

In automatic mode, GPT chooses one exact allowed model/effort pair for every
new Activity, new Agent, or fresh context. The bridge publishes no preferred
pair, default, fallback, or task-to-model mapping. Omission for new work returns
`MODEL_SELECTION_REQUIRED` with `codex_models` as the next action before any
execution state or upstream call is created. Continue/fork omission keeps the
admission-time selection; supplying an exact pair deliberately requests an
override only when the current runtime policy, catalog, and backend support it.

Stable Task contract v2 exposes one generic closed `codex_task.selection`
object with `model` and `reasoningEffort` strings. Use `codex_models` and current
runtime errors to obtain allowed pairs. The bridge does not add a task mapping,
ranking, recommendation, or its own reasoning-effort glossary.

The **Fast mode** checkbox is separate from model and reasoning level. `codex_task` exposes only model and reasoning-effort choices to GPT. If the user enables Fast mode, the bridge injects the supported `priority`/`fast` service tier internally when it calls Codex; GPT cannot choose or override it. Native and card Settings share localized names, and execution badges reflect each run's captured mode rather than the latest global preference.

The public Settings call returns only a thin opening acknowledgment and performs no snapshot/catalog read. Generation 14 starts with its editor hidden and calls the app-private `codex_ui_read` (`view: "settings"`); only that fresh response is rendered, so reopening an old conversation cannot paint the original settings metadata. The model catalog uses the bridge's short TTL and last-known-good cache. The card does not poll and has no persistent refresh button. A retry action appears only when the catalog is stale or a lookup fails and uses the same snapshot path with `refreshModels: true`.

A saved model/access/presentation setting, catalog, project registry, or project
availability change takes effect for runtime admission immediately. None changes
the public v2 Task descriptor. The same existing ChatGPT conversation can keep
using its cached v2 contract; there is no `tools/list_changed` notification and
no Developer-mode Refresh for these ordinary changes.

`codex_task` v2 requires exact `taskContractVersion: "2"` and the descriptor's
64-hex `executionEnvelopeRef`. The opaque installation-keyed envelope binds the
stable contract generation and operator-owned maximum/static boundary: prompt
limit, command/backend, allowed roots, sandbox capabilities, approval policy,
model ceiling, and secret preflight. Saved user settings, projects, availability,
and live catalog are deliberately excluded. An operator/static mismatch returns
`EXECUTION_ENVELOPE_CHANGED` before work and requires Refresh.

For each new call the bridge privately captures the exact mutable execution
policy and resolved catalog fingerprint, then rechecks it before filesystem
preflight and inside serialized admission. A concurrent save returns retryable
`EXECUTION_POLICY_CHANGED` before any Activity, Agent, Job, filesystem, or
upstream side effect; retry the same v2 contract with a new `requestId` and no
connection Refresh. `MODEL_SELECTION_REQUIRED`, `MODEL_POLICY_CHANGED`,
`MODEL_UNAVAILABLE`, and `MODEL_SELECTION_FORBIDDEN` are runtime selection
errors recovered through `codex_models` or Settings. Exact admitted v7 replays
return their retained result first. A cached pre-v2 conversation remains bound to its public
`executionPolicyRef` and needs one Refresh to migrate to v2 after that ref is
stale.

Stateless Streamable HTTP remains the default. Experimental stateful HTTP and
persistent stdio keep bounded notification/re-list diagnostics for genuine
static descriptor or UI changes; ordinary v2 setting/catalog/project changes
do not create a descriptor epoch. Persistent stdio has byte-framed coverage
proving a saved settings change leaves the descriptor identical and emits no
false `tools/list_changed`. Neither transport introduces another service or
external session store.

There is one conversation-scoped flat Activity feed. Retired saved layout
preferences are safely discarded and are not selectable in Settings.

The **Projects** section is the single source of Codex start folders. Users enter only a Unicode project name and an existing absolute folder. The server generates an immutable private UUID plus an opaque public `projectRef`; both survive restart and remain stable across rename, relocate, archive, and restore, and a ref is never reused for another project. New or edited folders are canonicalized with `realpath`; files and active normalized-name/canonical-path collisions are rejected. Projects have no default selection; every new Activity or fresh Agent context must select one exact current `{ name, projectRef, projectRevision }`. A project's revision advances only for its own admission-relevant rename, relocate, archive, or restore. No name, label, slug, alias, list position, private UUID, or path is the public identity.

Settings also warns that changing the default backend affects only new threads.
Existing Agents stay pinned. To move one deliberately, use that Agent with
fresh context and an explicit handoff summary; only the summary reaches the new
backend thread, not the prior transcript or backend state.

Settings card generation 15 sends independent `expectedSettingsRevision` and
`expectedRegistryRevision` CAS values with exactly one `reset` or `patch`
operation. A patch groups ordinary settings and a bounded atomic list of project
`add`, `rename`, `relocate`, `archive`, `restore`, and archived-registration `delete` operations; it never replaces
the registry. Each effective project transaction advances `registryRevision`
exactly once, while ordinary changes advance `settingsRevision` independently.
Both are checked immediately before the single commit. Reset restores general
preferences only: project UUIDs, names, paths, order, archive state, and recovery
entries are preserved. Retained generation-9 and newer resources keep this
mutation boundary; earlier ID/default and single-revision contracts are incompatible.

On a fresh install the project registry contains no entries. The stable public
`codex_task` descriptor exposes a generic `project` selector; `codex_status` exposes project lookup
shapes. `codex_task` is always execution-only and never has an Activity-card UI
binding; project registration does not change its descriptor. Do not open Settings merely because a conversation
starts or the plugin is attached. After the user explicitly requests new or
fresh Codex work, call `codex_task` once without `project`; it admits no Activity,
Agent, Job, session, or upstream work and returns `PROJECT_SETUP_REQUIRED` with
`codex_settings` as the next action. Only then should GPT show the card and
explain what must be registered.

After registration, use `codex_status` with `query: { kind: "project", name }` when
the exact selector is unknown. That call returns the exact `{ name, projectRef,
projectRevision }` in `nextActions`, admits no work, and is retried with a new
`requestId`. The serialized admission boundary remains authoritative: new
Activities, new Agents, and fresh contexts reject missing or stale values before
any Activity, Agent, Job, session, filesystem mutation, or upstream work.

A project whose folder disappears remains visible as **Needs recovery**, but it
cannot admit work until its folder is fixed or the project is archived. Archived
projects are excluded from new selection; restore keeps the same UUID. Existing
Activity/Agent threads keep their pinned admission-time folder. The card cannot
change tunnel credentials, operator capabilities, or the Codex approval policy.

Project selection and access strategy are independent:

- `read-only` applies read-only access to new work;
- `always-full` applies full access within the operator ceiling;
- the retained `adaptive` value is shown as **Bridge default** and uses the
  operator-configured default for new work. GPT no longer chooses permissions.

`codex_task` has no permission fields. The bridge alone resolves sandbox and
approval policy; no GPT-request-versus-setting conflict is needed. Cached calls
containing the retired field cannot admit new work: refresh discovery. Exact
already-admitted retries still retrieve their original result. Continue/fork
recheck operator limits and preserve thread policy; incompatible saved settings
require fresh context. Host approval review remains an independent boundary.

The public `codex_task` descriptor never contains `cwd`, internal UUID, registry
inventory, or catalog inventory. Generic `project` remains optional so
continue/fork can omit it, while serialized admission requires one for every new
Activity or fresh Agent context, even with one project. The global
`registryRevision` is Settings CAS only and does not invalidate an unchanged
selector. Missing selection with an active registry fails `PROJECT_REQUIRED`; a
truly empty registry returns `PROJECT_SETUP_REQUIRED`. Stale or unavailable
selectors return read-only `codex_status` project lookup/recovery guidance with no connection Refresh.
Activity, Agent creation/assignment, replay, and Job admission recheck the
selected project atomically and pin its private UUID/cwd; a backend-assigned
resumable thread receives the same pin before reuse. Exact admitted v7 replay
remains valid after later registry or settings changes. Continue/fork omits
`project` and keeps the admission-time snapshot; an unavailable pinned folder
returns `PROJECT_UNAVAILABLE` without fallback. Legacy `{ name,
registryRevision }` remains cached pre-v2 runtime migration input. A caller that
sends `cwd` fails strict parsing. New task calls contain no permission intent;
the bridge applies its saved access strategy without a GPT-versus-setting
comparison. Cached permission-bearing calls cannot admit new work.

The ref/revision tuple prevents stale project mappings. A different complete, currently valid selector is still a valid transport-level choice; the bridge cannot infer contrary natural-language intent. Multi-project write/full-access fresh confirmation remains a separate app-private follow-up rather than a model-visible `confirmed` field.

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

- `codex_task` has no UI metadata, caller `scopeId`, presentation field, `modelPolicyRevision`, `cwd`, arbitrary `threadId`, `sessionMode`, or `adoptThread`;
- `codex_activity` is retained as app-only compatibility discovery for old cards and is absent from GPT's public tools;
- `project` is one generic closed `{ name, projectRef, projectRevision }` object; read-only `codex_status` project lookup supplies its current values;
- `taskContractVersion` is exact `"2"` and `executionEnvelopeRef` is one required exact 64-hex const;
- `selection` is one generic closed model/effort object; there is no `sandbox`, approval-policy, or other permission input;
- the bridge applies saved access settings within operator limits; fixed model mode rejects explicit model overrides;
- Activity and Agent routing use separate discriminated `activity` and `agent` objects;
- an existing Agent's optional `context` values are exactly `continue`, `fork`, and `fresh`.
- `codex_steer` exposes exactly `requestId`, `jobId`, `expectedJobVersion`, and `prompt`; it exposes no scope, Activity, Agent, thread/turn, card, policy, model, project, sandbox, cancellation, approval, or interaction field;
- `codex_task` publishes required nullable `answer`; a delivered foreground result has a non-null bounded answer;
- `codex_status` permits `answer` only on an exact completed Job item, while summary items expose exact-Job retrieval actions.

## 6. Agent and Activity routing

ChatGPT omits `scopeId`; the bridge derives it from anonymous conversation host metadata. A non-ChatGPT compatibility host must generate/reuse an explicit scope UUID. Every logical `codex_task` turn gets a fresh UUID `requestId`; reuse it only for an exact retry. Task execution has no presentation identity. New work creates no Activity card; keep bounded input waits active and retrieve each exact terminal Job result.

Use these routes:

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
  "activity": { "mode": "existing", "id": "..." },
  "agent": { "mode": "existing", "id": "...", "context": "continue" },
  "prompt": "Address the remaining test failure"
}
```

A new but dependent goal creates a linked Activity without reopening the completed source:

```json
{
  "requestId": "...",
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

Agent lifecycle is separate from turn and Activity lifecycle. A terminal turn returns the Agent to `idle` and releases its active Activity assignment while preserving history. Model-visible `codex_agent` provides only one discriminated `operation`: `rename` (with `name`), `archive`, or `restore`. Archive/restore changes only bridge-local logical state and never invokes upstream thread archive/unarchive, protecting other Agents that descend from the same fork tree. Active/waiting Agents and Agents with App Server background terminals cannot be archived. Exact process termination belongs to the global work details' destructive app-only control; retained Activity cards keep their compatibility control. Exceptional assignment detach is an operator-enabled private recovery operation. There is no GPT-facing permanent delete.

Activity lifecycle changes require the exact version from authoritative status. `codex_activity_update` accepts one non-cancelling `operation`: seal, complete, abandon, start verification, pass/fail verification, or set policy. Each operation exposes only its relevant payload. Whole-Activity force-stop is the separate destructive and idempotent `codex_cancel` (`target.kind: "activity"`), which additionally requires a unique `requestId`; retry that UUID only for the exact same cancellation. Public single-Job `codex_cancel` likewise requires a cancellation-specific `requestId` plus the exact current Job `expectedVersion`. An exact retry is replay-safe, while reuse with another payload is rejected. A shared-worker impact must be confirmed with the complete affected-job list. The old flat update and cancellation forms have expired and are rejected.

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
versions, cross-scope or inconsistent roots, retired-backend Jobs, inactive turns,
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

## 8. Status card and retained Activity cards

`codex_task` is execution-only. Its descriptor has no Activity UI resource, it accepts no presentation field, and its result carries no Activity bootstrap. Therefore multiple Task or Agent calls in one response create no card shells by themselves.

New work does not open Activity cards. Keep the current GPT response active using bounded input waits and retrieve each terminal Job result with an exact query. Native Codex alerts remain independent. Existing mounted old cards retain their original completion handoff only during the migration window. The replacement path for a previously ended GPT response is not proven by local tests; see the rollout gate in [Card tools](card-tools.md).

When the user asks for the Codex status card, call `codex_dashboard`. The current generation-24 card keeps the generation-23 scope choice: it starts with this GPT conversation if it has retained Activity or Job records, including completed history; otherwise it starts with all conversations. The **This conversation / All conversations** buttons switch the scope. The chosen scope survives refresh, enrichment, pagination, and restoration of the mounted card. A new cold mount makes the initial choice again. Scope filtering happens on the server before counts and pagination; see [Card tools](card-tools.md). Opening and refreshing the overview is read-only; deliberately opened work details offer validated user controls in this personal, single-user bridge; there is no Dashboard operator flag to enable. “All” means scopes currently known from retained Activities, live Jobs, result-free archived Job summaries, non-archived Agents, or tracked threads—not the account's complete ChatGPT history. The default result-bearing Job window is six hours/100 Jobs, the Dashboard reads at most 10,000 archived summaries, and the tracked-thread registry defaults to 1,000 entries. The public result is a redacted aggregate fallback so a non-UI host still receives useful status, but it carries only locale app metadata and no full Dashboard view. The generation-17 UI starts cold in loading state, renders a fresh structural app-only `codex_ui_read` (`view: "dashboard"`) without waiting for runtime or usage probes, and then applies a bounded enriched snapshot; it does not consume the conversation's cached initial tool result or later host replays of that result. The current snapshot supplies current-work and run-history pages, with no separate idle section; omitting the optional status filter preserves active/recent/idle pages for immutable older cards. Larger project/conversation compatibility pages are computed only when an older card supplies those offsets. A mounted recovery call may omit conversation metadata, while any supplied host or compatibility scope is still validated.

The Dashboard refreshes on initial mount, page re-entry, stale visibility return, and the refresh button. Until the first fresh structural snapshot succeeds it shows loading rather than cached or empty counts; an initial failure asks the user to retry with the same card’s Refresh button and never falls back to the original tool response. Generation 19 preserves the last successfully loaded mounted view and its timestamp on page re-entry older than one second or visibility return older than thirty seconds. A failed refresh leaves that view visible with a localized warning; Refresh or the next visibility/online return can retry the same card. Obsolete in-flight responses still cannot replace a newer view. Cold mounts continue to require a fresh snapshot and do not render a cached conversation tool result. During cold startup, generation 18 uses `window.openai.callTool` immediately when the ChatGPT compatibility bridge exists instead of waiting for the standard MCP Apps initialization timeout. Structural data is requested with `enrich: false`; a second `enrich: true` request is optional and cannot hide or invalidate the structural result when it fails. Enrichment is limited to active/attention/currently visible Agent rows, at most eight in-flight workers, 400 ms per probe, a 1.2-second runtime budget, and an independent 800-ms usage budget. It reads only already loaded background-terminal state and never calls `thread/resume` to populate a card. Retained generations 18–23 use the fixed `active → recent terminal → idle` order and groups every section by opaque Activity identity with Agents nested below. The idle heading is explicitly **Recent Activity**, because an idle Agent has released its current assignment; Agents with no retained Activity are grouped under **No recent Activity**. All three pages preserve whole Activity groups, so the nominal Agent-row limit may be exceeded when one Activity contains more Agents. Project and GPT conversation context appear once on the Activity; every Agent keeps the actual model/reasoning effort for its latest turn, and a different current selection remains separately labelled as next-run settings. Up to 12 older turns suppress the enclosing Activity title, retain distinct Activity-ID boundaries even when visible titles match, and always show their own execution evidence or an unavailable label. Recent and idle sections append later pages in place through **Show more**, with no previous/next replacement navigation. A stable opaque row key and requested-offset check evict moved rows and rebase a clamped page. The legacy idle section starts collapsed on each fresh card. Generation 24 merges its recorded turns into run history and hides idle Agents with no recorded turn. Older retained turns start collapsed under each Agent, and ordinary refreshes preserve those history disclosures without `localStorage`.

The mounted snapshot performs bounded read-only App Server checks for at most 100 recently updated Agents, with a 1.5-second per-Agent timeout and a nine-second overall budget. Agents without a retained latest Job are included only when the upstream provides a non-loading thread probe; otherwise they are reported as skipped. Timed-out and deadline-deferred probes are also skipped/unknown, and the snapshot does not load a `notLoaded` historical thread merely for the overview. **Tracked projects** counts active, non-deleted project registrations rather than distinct project keys on the visible rows. An active but temporarily unavailable registration remains counted; archived/deleted registrations and the unassigned bucket do not. Historical rows admitted under an archived or deleted registration remain visible. The snapshot does not long-poll, consume Activity watcher admission, own completion handoff, or acquire a control lease. ChatGPT cannot update a dormant historical card while the host has not mounted it, so reopening that overview conversation is the expected refresh path. Refresh is a retained-state snapshot rather than a live health check of every historical thread.

Dashboard state must remain Codex-runtime-only: exact Job running/terminal/termination state, tracking liveness, Agent lifecycle, pending Codex input/approval interactions, and confirmed App Server background-terminal counts. Do not map Activity lifecycle, waiting, verification, completion handoff, or GPT's goal-completion judgment into these labels. **Codex turn completed** means exactly Job status `completed`; failed, interrupted, and cancelled remain separate terminal outcomes. **Running / Response needed / Issues** are the current card and native menu-bar summary. Input and approval waits count once per Agent under response needed and do not mark menu-bar health as broken. Issues use unresolved latest failures/interruption or recovery problems, excluding normal waits and archived Agents. A later running/completed retry clears an earlier failure from that count while preserving the history. Counts cover the full selected conversation scope, and selecting one filters its rows before pagination. Remaining background terminals appear separately from running Codex turns. Current work and run history group by Activity context with their saved Agent names nested below. Background processes have a separate conditional filter, terminating work retains its badge, and unknown/deferred runtime information remains explicit. The current/latest turn retains the exact effective model/reasoning-effort selection when known, and older calls for that same Agent appear only inside its expandable history. An idle Agent may additionally show its labeled current tracked-session selection; that value is never substituted for an unknown historical turn. Old archived summaries without a retained start time report **Work time unavailable** rather than zero. Active timing is Job start-to-now work time. Terminal and idle retained timing is Job start-to-terminal work time when known plus time since the exact outcome; absolute start, update, and end timestamps are not displayed. A reported runtime model reroute is shown as `selected → rerouted`, with the admission-time effective effort retained. The card never prints the session identifier, thread identifier, or compatibility alias as text. The bridge can retain a validated `codex://threads/<uuid>` candidate for the native macOS **Open Codex conversation** action, but the ChatGPT Dashboard does not render it because card-host navigation does not reliably open custom app schemes. Native availability still requires an exact retained tracked App Server session whose creation-time visibility bit permits it; the exact current thread wins over its matching session-tree UUID so forks open the correct descendant. Separately, OpenAI defines `openai/session` as an anonymized correlation value rather than a navigable-route guarantee. For a UUID-shaped host value, the bridge keeps a bounded private mapping and exposes one best-effort **Open conversation** link in each Activity context. GPT navigation is independent of the Codex-app visibility setting. Arbitrary values are not persisted, and scopes retained before capture cannot be backfilled. The ChatGPT route is not probed. The Dashboard CSP allows only `https://chatgpt.com` for `window.openai.openExternal`, and the anchor remains the fallback. Apart from those validated private route targets, the view contains hashed conversation, project, Activity, and row keys plus display context only—never raw Job, Activity, Agent, thread, worker, or process IDs; paths; prompts; results; errors; commands; or controls. User-defined project/Agent/Activity display labels and the navigation links can reveal cross-conversation task context, so keep this overview on the single trusted user's connection. A widget-instance UUID is correlation rather than authentication.

### Retained Activity cards during migration

The following presentation and handoff behavior describes existing saved cards
only. It is not an instruction to create a new Activity card. Current work
details and controls use the global card and app-only `codex_ui_read`,
`codex_ui_stop`, and `codex_interaction_respond` contracts; see
[Card tools](card-tools.md) for compatibility and removal conditions.

The retained feed shows only Activity title, Agent display name, separate display-only role, localized state, kind, timing, final project-folder name when multiple projects are relevant, each Agent's current or latest effective model/reasoning-effort selection, and necessary controls such as verification, retry, Agent-work force-stop, background-process stop, approval, or input. Current operational state has priority over prior attempt history: an active retry renders as **Running**, with a localized previous-failure count only when that count is positive. A primary **Failed** state does not repeat the same failure as secondary history. Model labels match the Settings catalog display names and fall back to internal IDs only when necessary. A reported App Server model reroute is rendered as `selected → rerouted`; the effort remains the Job's admission-time effective effort. Approval and input responses use `codex_interaction_respond` with an idempotency UUID, exact Job version, interaction ID, and current card proof; answers are transient and never written to bridge state.

Detailed Job status includes a selection-only `executionAudit`: requested,
policy-effective, and evidence-backed actual model/effort, plus reroute reason
when reported. It states when the protocol has not supplied independent runtime
effort-override evidence. Prompt and private reasoning text are excluded. A
context-window failure remains a tracked structured
`CONTEXT_WINDOW_EXCEEDED` result with explicit recovery choices; retrying that
same request ID returns the retained failure and does not start another turn.

The card deliberately omits a KPI dashboard, card-grid Agent list, layout selector, Activity `<details>`, timelines, Agent/job/thread IDs, full working paths, backend/worker data, command output, and general steering. Detailed diagnostics are available only through the private app-only `codex_diagnostics` tool.

Duplicate prevention is structural: any number of Task calls creates zero Activity shells, followed by at most one compact-monitor presenter shell. Exact presenter retries and mount races are additionally keyed by `scopeId + presentationId` (projected privately as `activityPresentationId`); `activityId + cardGeneration` only validates a mounted Activity reference. The first matching `codex_activity_snapshot` confirms ownership, and a racing second iframe receives `presentation-duplicate` and collapses. A new presentation can render while an older card for the same Activity remains mounted.

Only the newest confirmed mounted compact-monitor presentation owns the scope live watch and completion handoff. When a newer presentation confirms its first snapshot lease, the previous compact card receives a normal `presentation-superseded` stop result, retains its last snapshot, and releases its watcher slot without a retry loop. Explicit full-history cards use separate admission (up to three concurrent explicit watchers per scope alongside the one compact owner) and do not claim automatic completion handoff. `openai/widgetSessionId` identifies only the mounted widget instance and is not authorization by itself; every control revalidates the exact card lease and target ownership. Handoff discovery exposes batch actions only and requires the newest compact card proof. UI-bearing Activity tools use strict private/app-only view contracts; bootstrap remains only for immutable older resources. The current content-hashed Activity resource uses UI generation 26 and the closed generation-11 private metadata envelopes. It paints structural data immediately, then requests bounded enrichment before dispatching the independent long watch. One-shot historical and restored-explicit cards may also request bounded enrichment without acquiring a watcher, handoff owner, control lease, or mutation authority. Generation 24 bounds compatibility and standard calls, retries cold rehydration, ignores stale async responses, coalesces rapid refresh clicks, and leaves the last structural data visible with a localized warning when refresh or enrichment fails. Generation 25 leaves Activity lifecycle on its heading and keeps each nested Agent's latest actual model/reasoning effort with its turn state, work time, pending interactions, and Job-target GPT cancellation explanation; matching sibling execution values are not hoisted or suppressed, and unavailable legacy evidence is explicit. Full history pages idle Agents by latest Activity without repeating an Agent already visible on the page; the same de-duplication applies to the bounded compact recent/idle sections. Its Force Stop action calls `codex_activity_job_cancel`, which validates the live widget lease, current presentation/card proof, exact Job version, target ownership, and cancellation UUID. Generation 12 is the minimum for new descriptors; all immutable retained generation 7–26 resources remain registered for existing mounts and refresh through their compatible app-only paths. Reservations and ownership are in-memory; after bridge restart the first valid compact card to reconnect safely re-establishes ownership.

`executionMode: foreground` waits for terminal result and returns its bounded structured `answer`. `background` returns `jobId` immediately. Neither completes the Activity. A host without the card can use a bounded exact-Job wait:

```json
{ "query": { "kind": "job", "id": "...", "waitFor": "terminal", "waitMs": 55000 } }
```

When the exact Job completes with `result.availability: "delivered"`, read that Job item's `answer`. Overview, Activity, thread, and page status never carry Job answer bodies. `omitted` and `unavailable` keep `answer` absent; `delivered` without `answer` is a contract/host delivery failure and must not trigger a new re-report Job.

Wait timeout leaves Codex running. `codex_cancel` interrupts one exact App Server turn or tracked worker process. The card's private `codex_activity_job_cancel` is a distinct destructive surface, and `codex_cancel` (`target.kind: "activity"`) force-stops every active job in one exact-version Activity. Every path durably records its cancellation operation and intent before interruption; terminal state is recorded only after exit evidence. Activity cancellation records a parent intent, enters `Activity-terminating`, records linked child intents, cancels the children, and only then writes `Activity-cancelled`. None rolls back filesystem changes. HTTP abort, SSE disconnect, MCP cancellation notifications, wait/snapshot abort, presentation supersession, and widget unmount are transport or presentation observations only and never cancel a Job.

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

App Server may leave a background terminal after the turn itself completes. While a Job is active, the card exposes **Force-stop Agent work** for that Job and withholds background-process termination. After the Agent becomes idle, it separately shows the remaining-process count and **Stop background processes** action. This action calls the app-private, destructive `codex_background_process_terminate` tool. The bridge revalidates the mounted-card lease, exact Agent version, current App Server thread, fresh terminal inventory, and absence of an active turn before calling `thread/backgroundTerminals/terminate`; it is not Agent archive or job force-stop. Every supported Activity resource calls this dedicated tool; the former Agent-operation shortcut has expired.

## 9. Smoke checklist after Plugin Refresh

In a new ChatGPT conversation:

1. open Settings and confirm it renders without an old-resource error;
2. add two project folders, verify Unicode/whitespace/case-equivalent names and canonical duplicate paths are rejected inline, and save;
3. add projects from two unrelated absolute locations, rename/relocate one, archive/restore the other, and confirm identity and archive state persist;
4. change a harmless preference and save;
5. confirm there is no persistent model-refresh button; if a stale/failure warning is present, use its contextual retry and confirm the last-known-good options remain populated;
6. choose **Restore default settings**, confirm, and verify the card rerenders;
7. confirm `codex_task` has no `cwd`/UUID/registry/catalog inventory or permission inputs, requires exact contract v2 plus `executionEnvelopeRef`, and publishes generic closed project/selection shapes; project lookup belongs to read-only `codex_status`;
8. keep the same conversation and cached v2 descriptor, add project B, resolve it through `codex_status` project lookup, and run there with a new `requestId`; then rename/relocate/archive/restore it and confirm the stale selector fails before Activity, Agent, Job, filesystem, or Codex work and recovers through read-only project lookup without Refresh;
9. in that same conversation, change read-only to another operator-enabled access strategy, change model policy, Priority, thread visibility, card visibility, and locale; confirm no `tools/list_changed`, the descriptor remains byte-identical, a new call uses current settings, and an exact prior v7 retry returns its retained original admission;
10. make several Task/Agent calls in one response and confirm no new Activity shell or compact-monitor presenter appears;
11. run a same-Agent `continue`, then a second-Agent parallel `fresh`/`fork`, and confirm the separate global overview shows both with their exact Activity/Agent context;
12. query scoped Activities through `codex_status` pagination, open the requested global overview through `codex_dashboard`, and separately verify that an existing saved Activity card can reopen and refresh during migration;
13. complete work, retrieve each exact Job result, and confirm the global card's terminal and idle states remain correct after Agent reuse; verify Codex completion, GPT result handling, and user notifications independently;
14. archive/restore an idle Agent and confirm the same immutable ID/thread history remains;
15. start a linked Activity with the existing Agent and confirm its lineage is retained without reopening the terminal source or creating an Activity card; use `fresh` plus another project to verify an explicit linked-project switch;
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
21. inspect `codex_status` for the selected CLI, catalog
    freshness, aggregate RSS/FD, startup/crash/config/MCP health, and orphaned
    count; verify no worker identifier, full path, raw reasoning, MCP payload,
    or collaboration prompt appears;
22. start a long App Server Job, read its exact version, call `codex_steer`, and
    confirm the same active turn consumes the delta without another
    `turn/started` event or a resolved pending interaction;
23. retry that exact steering request and confirm one upstream `turn/steer`, then
    change the prompt under the same request UUID and confirm
    `STEERING_REQUEST_CONFLICT` with no second dispatch;
24. exercise stale version, inactive/terminal turn, retired-backend Job, and
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
28. from a dedicated overview conversation, explicitly open `codex_dashboard`,
    create running and terminal Codex turns across at least two projects and two
    other conversations, return to or refresh the overview, and confirm the
    fixed active/recent/idle order, flat representative-Agent rows with project
    context, initially collapsed idle section, append-only **Show more**, Agent
    names, model/effort badges, and valid **Open conversation** links without a
    printed session ID. Include one conversation spanning both projects and
    confirm each Agent row retains its actual project without duplication. Change an
    Activity verification/waiting state and confirm the underlying Codex turn
    label does not change; verify no printed session ID, Job/Activity/Agent/thread
    ID, path, prompt/result, control, watcher lease, or handoff data is present.

In an existing cached pre-v2 conversation:

1. inspect whether `codex_task` still exposes `executionPolicyRef`, `sandbox`, `projectLookup`, or dynamic project/model branches, and whether `codex_status` includes the project query;
2. perform Developer-mode **Refresh** to import current discovery. On the tested ChatGPT host, existing conversations retained already loaded tool schemas after Refresh, while a new conversation obtained the current schema. Verify the actual schema before execution; do not reinterpret or retry a denied cached request;
3. confirm every supported cached UI resource still resolves;
4. from then on, keep that same conversation while changing ordinary Settings and projects, and prove new calls use current state without another Refresh.

For acceptance, initialize at least two existing v2 conversations, change saved
settings and the project registry without **Refresh**, and record: zero
descriptor epoch change/notification, byte-identical `codex_task` descriptors,
same-tool project lookup, and later Task calls using current policy and selector.
Exercise an exact old v7 replay and confirm it returns its retained admission
without another upstream call. Run the case in default stateless HTTP and, when
evaluating transport candidates, stateful HTTP and persistent stdio. Transport
mode does not affect this invariant and introduces no external service.

Do not claim that UI resources, authentication, initialize-time server
identity/instructions/capabilities, transport mode, published plugin metadata,
or a future input/output contract generation changes without Refresh or
reinitialization. Those are static contract/deployment changes. An
`EXECUTION_ENVELOPE_CHANGED` result is the explicit fail-closed signal for the
operator/static Task boundary.

Record Desktop/Web/iOS surface, plugin URI/template, old/new conversation behavior, and any host cache limitation in the release or issue report.

## 10. Troubleshooting

- Tunnel missing: verify workspace association and Tunnel Read/Use permissions.
- Runtime dotenv missing: create `~/.config/codex-mcp-bridge/.env` from `.env.example`, replace both `CONTROL_PLANE_*` values, and run `chmod 600` on it.
- Runtime dotenv rejected: use a regular non-symlink file owned by the current user with mode `0600`; do not put it in a registered project.
- Tool discovery fails: keep the bridge running and rerun `tunnel-client doctor`.
- Old Settings card/tool schema: first confirm its URI is present in `dist/ui-manifest.json`. Supported cached URIs must render; deploy current server, use plugin **Refresh**, then start a new conversation only when new metadata is required.
- `PROJECT_REQUIRED`: call `codex_status` with `query: { kind: "project", name: "<exact name>" }`, then retry with its exact returned selector and a new `requestId`.
- `PROJECT_REGISTRY_CHANGED`: the selected project is stale; use the same-tool lookup recovery and a new `requestId`. No work was admitted and no connection Refresh is required. A cached pre-v2 legacy selector must migrate once.
- `PROJECT_NAME_CONFLICT` / `PROJECT_CWD_CONFLICT`: choose a unique active normalized name/canonical folder.
- `PROJECT_UNAVAILABLE`: restore the exact pinned folder, or fix/archive the **Needs recovery** project. The bridge does not fall back elsewhere.
- `MODEL_SELECTION_REQUIRED`: call `codex_models`, choose one exact returned
  model/reasoning-effort pair, and retry with a new `requestId`. No Activity,
  Agent, Job, session, filesystem, or upstream work was created.
- `MODEL_POLICY_CHANGED`: call `codex_models` for the current policy-allowed
  values and retry the same stable contract with a new `requestId`. No stale
  selection is admitted and no connection Refresh is required.
- `EXECUTION_POLICY_CHANGED`: on v2, a Settings/catalog race was detected before
  admission; retry the same contract with a new `requestId` after the save
  settles. If the call came from cached pre-v2 `executionPolicyRef`, Refresh once
  to migrate to v2.
- `EXECUTION_ENVELOPE_CHANGED`: the operator/static maximum or Task contract
  generation changed; Refresh the developer-mode connection and retry with the
  new exact contract/envelope constants.
- Unrecognized Task `cwd`: refresh the plugin/tool list; select an exact registered `{ name, projectRef, projectRevision }` object instead.
- `TASK_PERMISSION_INPUT_RETIRED`: a cached task request still contains a retired permission field. Refresh discovery. Current GPT calls contain no permission settings; the bridge applies saved policy. Do not silently reinterpret a previously denied restricted request.
- `SANDBOX_CONTEXT_CONFLICT`: continue/fork cannot change the existing sandbox. Use fresh context with the intended permissions.
- `EXECUTION_ACCESS_MISMATCH`: the CLI returned a different policy or omitted required evidence. No model turn was started; inspect the selected CLI/configuration.
- `CODEX_PROTOCOL_UNSUPPORTED` / `CODEX_PROTOCOL_UNVERIFIED`: the selected installation cannot confirm the required App Server contract. Repair it or explicitly select a compatible CLI.
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

## GPT가 질문을 처리하는 방식

일반 Codex 질문은 GPT가 먼저 읽고 답합니다. 사용자 의견이 필요할 때 GPT가 질문 카드를 호출하며, 카드의 답변은 GPT가 회수해 다음 행동을 판단합니다. 질문과 승인 요청은 구분합니다. 새 도구 메타데이터를 반영한 뒤 실제 ChatGPT에서 후속 처리가 재개되는지 확인해야 합니다. 자세한 내용은 [질문 처리 흐름](gpt-questions.md)을 참고하세요.
