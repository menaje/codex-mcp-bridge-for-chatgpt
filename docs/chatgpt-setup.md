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
only their project IDs, never their paths.

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
5. Verify discovery of nine model-visible tools: `codex_status`, `codex_activity`, `codex_activity_cancel`, `codex_cancel`, `codex_activity_update`, `codex_agent`, `codex_models`, `codex_settings`, and `codex_task`.
6. The app-private `codex_activity_snapshot`, `codex_interaction_respond`, `codex_job_steer`, `codex_activity_handoff`, `codex_background_process_terminate`, and `codex_update_settings` tools should also be registered but are not normal model operations. Recovery detach is private and operator-disabled by default.

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
- named projects and an optional compatibility default;
- UI language;
- concurrent-job limit;
- card visibility;
- optional completion handoff.

For an automatic policy with an explicit range, the card selects models first and then reasoning efforts per model. A model's **All** control expands the currently allowed efforts into exact saved model/effort choices; it does not add an `all` value to the tool schema and does not automatically include efforts discovered later. The separate catalog-visible range remains dynamic.

The Priority checkbox is intentionally separate. `codex_task` exposes only model and reasoning-effort choices to GPT. If the user enables Priority, the bridge injects the supported `priority`/`fast` service tier internally when it calls Codex; GPT cannot choose or override it.

The model catalog is loaded when Settings opens, using the bridge's short TTL and last-known-good cache. The card does not poll and has no persistent refresh button. A retry action appears only when the catalog is stale or a lookup fails.

There is one conversation-scoped flat Activity feed. Retired saved layout
preferences are safely discarded and are not selectable in Settings.

The **Projects** section is the single source of Codex start folders. Users enter only a Unicode project name and an existing absolute folder. The card automatically allocates a stable normalized routing ID, keeps it out of the form, and preserves it when the name or folder changes. New or edited folders are canonicalized with `realpath`; files, missing folders, and canonical-path collisions are rejected. The first project becomes the default automatically. Removing and adding an entry creates a new internal identity.

Settings also warns that changing the default backend affects only new threads.
Existing Agents stay pinned. To move one deliberately, use that Agent with
fresh context and an explicit handoff summary; only the summary reaches the new
backend thread, not the prior transcript or backend state.

Settings card generation 6 sends `expectedRevision` and exactly one `reset` or
`patch` operation. A patch groups the ordinary settings and a bounded atomic list
of project `add`, `rename`, `relocate`, and `remove` operations; it never replaces
the whole saved project array. The bridge checks the revision both before a fresh
model-catalog lookup and immediately before commit. Reset restores general
preferences only: project IDs, names, paths, order, recovery entries, and default
project are preserved. Every compatible generation 5 revision remains retained.

On a fresh install the list is empty. When `codex_task` needs new context it returns
`PROJECT_SETUP_REQUIRED` with `codex_settings` as the next action, so GPT can show
the card and explain what must be registered. A project whose folder disappears
remains visible as **Needs recovery**, but it cannot admit work until its folder is
fixed or the entry is removed. Existing Activity/Agent threads keep their pinned
admission-time folder. The card cannot change tunnel credentials, operator
capabilities, or the Codex approval policy.

The compatibility default project and access strategy are independent:

- fixed `read-only` forces read-only and removes per-call `sandbox` from `codex_task`;
- fixed `always-full` forces `danger-full-access` and removes per-call `sandbox`;
- `adaptive` exposes only operator-enabled per-turn sandbox choices.

The public `codex_task` descriptor never contains `cwd`; it projects only the currently selectable project IDs and labels. A new Activity/fresh context uses an explicit `projectId`, the configured default, or the sole project. Existing Activities and continued/forked Agent threads keep their admission-time project and sandbox after Settings changes, and conflicting project IDs fail with `PROJECT_CONTEXT_CONFLICT`. A caller that sends `cwd` fails strict schema parsing; a stale fixed-mode descriptor that still sends `sandbox` receives `SANDBOX_OVERRIDE_UNAVAILABLE`.

### Dynamic model/effort behavior

Opening Settings and its failure-only retry action use the same bridge catalog adapter. App Server `model/list` is authoritative for App Server, including picker visibility, supported/default efforts, upgrade metadata, and service tiers. A short TTL avoids redundant lookup; a failed lookup preserves and labels the last known good catalog instead of replacing it with an empty list.

Effort options display short localized names only. The selected description is a separate helper linked with `aria-describedby`. Changing model immediately rebuilds supported efforts and the helper. Unknown new effort IDs remain visible with their canonical label and deterministic localized fallback description.

If a saved effort is no longer supported, Settings warns instead of rewriting it. The suggested value is the model's current default. Task execution never forwards the unsupported value; diagnostics record the transient effective effort and warning until the user explicitly saves a supported value.

## 5. Verify the active contract

Call `codex_status` and confirm:

- the saved projects/default-project compatibility mirror, `accessStrategy`, card visibility, and language;
- the saved project/default-project registry and mutation capability flags;
- default backend and active build ID;
- settings schema/model policy and catalog source/fingerprint/LKG status;
- SQLite state is reachable.

Inspect `tools/list`:

- `codex_task` has no caller `scopeId`, `modelPolicyRevision`, `cwd`, arbitrary `threadId`, `sessionMode`, or `adoptThread`; when automatic Activity UI is enabled it requires one response-scoped `activityPresentationId`;
- `projectId` lists only currently selectable registered IDs and their labels;
- fixed access modes have no `sandbox`;
- `adaptive` exposes only permitted sandboxes;
- Activity and Agent routing use separate discriminated `activity` and `agent` objects;
- an existing Agent's optional `context` values are exactly `continue`, `fork`, and `fresh`.

## 6. Agent and Activity routing

ChatGPT omits `scopeId`; the bridge derives it from anonymous conversation host metadata. A non-ChatGPT compatibility host must generate/reuse an explicit scope UUID. Every logical `codex_task` turn gets a fresh UUID `requestId`; reuse it only for an exact retry. When the descriptor exposes `activityPresentationId`, generate one separate UUID for the current assistant response and reuse it across every Codex call in that response.

Use these routes:

```json
{
  "requestId": "...",
  "activityPresentationId": "...",
  "projectId": "bridge",
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

## 7. Activity card behavior

`codex_task` owns automatic card presentation. When saved visibility is `always` or `background-only`, its descriptor points directly to the same Activity UI resource as `codex_activity`. Call `codex_task` directly—not through programmatic tool calling or an exec wrapper—so ChatGPT preserves that native UI. Do not call `codex_activity` afterward.

`requestId` remains per logical Codex call and must be reused only for the same execution retry. `activityPresentationId` is one UUID per assistant response: reuse it for every `codex_task` in that response, including calls to different Activities or Agents, and generate a new value for the next response. This explicit input is required because documented ChatGPT MCP metadata provides conversation correlation but not an assistant-response ID. A verified host may supply the same value as `codex/activityPresentationId` metadata. V4 replay excludes presentation state, and it cannot select or bypass the saved visibility setting.

The Task result carries `bridgeActivity`. The mounted widget reads it internally: a true `shouldRenderActivityCard` starts one scope-version `codex_activity_snapshot` long poll, while duplicate, disabled, or foreground-only-in-`background-only` results collapse without displaying another card. The snapshot tool is app-private and establishes or renews the exact Activity/generation/presentation lease for that widget session. A foreground call does not consume a `background-only` presentation; a later background call carrying the same assistant-response presentation ID may display it. With visibility `never`, the bridge removes the Task UI binding and public presentation input. `codex_activity` is reserved for an explicit user request to open or reopen the view.

The card is a single flat feed scoped to the current ChatGPT conversation. Current work and action-needed states are ordered first as Activity rows. Completed, idle, and ended Agents are collapsed into separate disclosure groups; the completed group reports both distinct Agent and completed Activity counts. When multiple projects are relevant, project labels remain visible across both current and collapsed history rows; full paths remain private. An Activity is not folded while verification, handoff, a job, an interaction, or an App Server background process is pending. Reusing a completed Agent for new work returns it to the current feed.

The feed shows only Activity title, Agent display name, separate display-only role, localized state, kind, timing, final project-folder name when multiple projects are relevant, each Agent's current or latest effective model/reasoning-effort selection, and necessary controls such as verification, retry, force-stop, background-process stop, approval, or input. Model labels match the Settings catalog display names and fall back to internal IDs only when necessary. A reported App Server model reroute is rendered as `selected → rerouted`; the effort remains the Job's admission-time effective effort. Approval and input responses use `codex_interaction_respond` with an idempotency UUID, exact Job version, interaction ID, and current card proof; answers are transient and never written to bridge state.

Detailed Job status includes a selection-only `executionAudit`: requested,
policy-effective, and evidence-backed actual model/effort, plus reroute reason
when reported. It states when the protocol has not supplied independent runtime
effort-override evidence. Prompt and private reasoning text are excluded. A
context-window failure remains a tracked structured
`CONTEXT_WINDOW_EXCEEDED` result with explicit recovery choices; retrying that
same request ID returns the retained failure and does not start another turn.

The card deliberately omits a KPI dashboard, card-grid Agent list, layout selector, Activity `<details>`, timelines, Agent/job/thread IDs, full working paths, backend/worker data, command output, and general steering. Detailed diagnostics remain available in `codex_status`.

Automatic duplicate suppression is keyed by `scopeId + activityPresentationId`; `activityId + cardGeneration` is retained only to validate a mounted Activity reference. The first eligible result for a presentation reserves it across all Agents, Activities, and exact retries. A new presentation can render even while an older card for the same Activity remains mounted.

Only the newest automatic presentation owns the scope live watch and completion handoff. When a newer presentation activates, the previous automatic card receives a normal `presentation-superseded` stop result, retains its last snapshot, and releases its watcher slot without a retry loop. Explicit `codex_activity` cards use separate admission (up to three concurrent explicit watchers per scope alongside the one automatic owner) and do not claim automatic completion handoff. `openai/widgetSessionId` identifies only the mounted widget instance and is not authorization by itself; every control revalidates the exact card lease and target ownership. Handoff discovery exposes batch actions only and requires the newest automatic card proof. The current content-hashed Activity resource uses generation 7 and the exact app-private snapshot, proof, destructive Job-cancel, control, and batch-handoff contracts. Its Force Stop action calls `codex_activity_job_cancel`, which validates the live widget lease, current presentation/card proof, exact Job version, target ownership, and cancellation UUID. Earlier generations and their legacy calls have expired. Reservations and ownership are in-memory; after bridge restart the first valid automatic card to reconnect safely re-establishes ownership.

`executionMode: foreground` waits for terminal result. `background` returns `jobId` immediately. Neither completes the Activity. A host without the card can use a bounded wait:

```json
{ "query": { "kind": "job", "id": "...", "waitFor": "terminal", "waitMs": 55000 } }
```

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

## 8. Smoke checklist after Plugin Refresh

In a new ChatGPT conversation:

1. open Settings and confirm it renders without an old-resource error;
2. add two project folders, verify IDs normalize, duplicate IDs/paths are rejected inline, choose a default, and save;
3. add projects from two unrelated absolute locations, edit one label/folder, remove the unused project, and confirm no separate allowed-root list is shown;
4. change a harmless preference and save;
5. confirm there is no persistent model-refresh button; if a stale/failure warning is present, use its contextual retry and confirm the last-known-good options remain populated;
6. choose **Restore default settings**, confirm, and verify the card rerenders;
7. confirm `codex_task` has no `cwd`, projects only the registered selectable `projectId` values/labels, and fixed access modes have no `sandbox`;
8. start narrow foreground read-only Activities in each project, then omit `projectId` and confirm the configured default/sole-project rule;
9. try a conflicting project on an existing Activity/thread and confirm `PROJECT_CONTEXT_CONFLICT` without another Codex call;
10. open the flat Activity feed and verify project labels appear only when useful and there is no KPI/card grid/layout selector or full path/backend/ID/timeline detail;
11. run a same-Agent `continue`, then a second-Agent parallel `fresh`/`fork`, and confirm one card is reused for the Activity;
12. complete work and confirm **Completed Codex** is collapsed with distinct Agent and Activity counts, then reuse that Agent and confirm it returns to the current feed;
13. archive/restore an idle Agent and confirm the same immutable ID/thread history remains;
14. start a linked Activity with the existing Agent and confirm it gets a new card generation without reopening the terminal source; use `fresh` plus another project to verify an explicit linked-project switch.
15. in an App Server canary, verify command/file/permission/input prompts expose
    only their advertised decisions, including session approval when offered;
    confirm cancel/decline, automatic resolution, and expiry all remove the
    control without stopping the turn;
16. run two turns on the same App Server Agent with different allowed exact
    model/effort selections; confirm each `turn/start` admission and Job
    `executionAudit`, including reroute evidence if present;
17. restart between those App Server turns and confirm `thread/read` resumes the
    exact thread with the same session ID; fork once and verify direct ancestry;
    separately exercise busy, missing, and transient probe paths and verify only
    missing/system-error becomes orphaned;
18. change the configured default backend, confirm the existing Agent still
    continues on its pinned backend, then perform an explicit fresh handoff and
    confirm the UI/result says summary-only continuity;
19. trigger a context-window failure and confirm it remains a structured,
    replay-safe error with no silent model/effort downgrade;
20. inspect `codex_status` for the experimental policy, exact CLI, catalog
    freshness, aggregate RSS/FD, startup/crash/config/MCP health, and orphaned
    count; verify no worker identifier, full path, raw reasoning, MCP payload,
    or collaboration prompt appears.

In an existing pre-refresh conversation:

1. inspect whether it still advertises old `cwd`/`threadId` fields or an old Settings URI;
2. trigger tool rediscovery if the surface supports it;
3. otherwise document that a new conversation is required;
4. confirm every cached UI resource within the supported contract-generation range resolves rather than returning resource-not-found.

Record Desktop/Web/iOS surface, plugin URI/template, old/new conversation behavior, and any host cache limitation in the release or issue report.

## 9. Troubleshooting

- Tunnel missing: verify workspace association and Tunnel Read/Use permissions.
- Runtime dotenv missing: create `~/.config/codex-mcp-bridge/.env` from `.env.example`, replace both `CONTROL_PLANE_*` values, and run `chmod 600` on it.
- Runtime dotenv rejected: use a regular non-symlink file owned by the current user with mode `0600`; do not put it in a registered project.
- Tool discovery fails: keep the bridge running and rerun `tunnel-client doctor`.
- Old Settings card/tool schema: first confirm its URI is present in `dist/ui-manifest.json`. Supported cached URIs must render; deploy current server, use plugin **Refresh**, then start a new conversation only when new metadata is required.
- `DEFAULT_CWD_REQUIRED`: choose a default project (or keep exactly one available project) in Settings.
- `PROJECT_DUPLICATE_PATH`: choose a different folder for one of the highlighted projects.
- `PROJECT_DUPLICATE_ID`: refresh Settings; project IDs are internal and generated automatically.
- `PROJECT_UNAVAILABLE`: fix or remove the **Needs recovery** project before saving or admitting work.
- Unrecognized Task `cwd`: refresh the plugin/tool list; select a registered `projectId` instead.
- `SANDBOX_OVERRIDE_UNAVAILABLE`: refresh tools; the fixed saved access strategy is authoritative.
- Repository refused: remove common secret files from the exposed copy or use a sanitized staging copy.
- Write/full access refused: start the bridge with the needed operator capability, then Refresh the plugin.
- `AGENT_ID_REQUIRED`: inspect current Activity Agents and retry with the exact intended ID.
- `AGENT_ORPHANED`: use explicit `fresh` only if replacing the lost backend context is intended.
- Archive conflict: finish/force-stop the active turn or terminate remaining background processes first.
- Codex connection failure: retry after bridge reconnection; enable `CODEX_MCP_BRIDGE_DEBUG=1` only for local diagnosis.

Official guidance:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test a ChatGPT plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [MCP Apps and ChatGPT extensions](https://developers.openai.com/plugins/reference)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
