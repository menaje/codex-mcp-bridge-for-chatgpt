# Connect Codex MCP Bridge for ChatGPT

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
export CONTROL_PLANE_API_KEY="<runtime-key>"
export CONTROL_PLANE_TUNNEL_ID="tunnel_..."

npm run bridge:secure -- --root /absolute/path/to/repository
```

For multiple disjoint operator roots, repeat `--root`; do not combine local
paths into one broad parent merely to launch the bridge:

```bash
npm run bridge:secure -- \
  --root /absolute/path/to/repository-a \
  --root /absolute/path/to/repository-b
```

The launcher canonicalizes existing directories and passes the exact
de-duplicated allowlist to the bridge. Operator roots define only the security
ceiling. Register the named selectable projects inside those roots in Settings;
GPT receives project IDs, not these paths.

The default capability profile is read-only. To allow adaptive mutation choices without changing the saved default:

```bash
npm run bridge:secure -- --root /absolute/path/to/projects --allow-write
npm run bridge:secure -- --root /absolute/path/to/projects --allow-full-access
```

Use `CODEX_MCP_BRIDGE_APPROVAL_POLICY=never` only when a trusted private ChatGPT plugin permission is deliberately the single approval boundary.

## 3. Add or refresh the ChatGPT plugin

1. Open ChatGPT Settings and enable Developer mode.
2. Open Plugins and create a developer-mode connection.
3. Choose Tunnel and select/paste the matching tunnel ID.
4. Use `No Auth`; the loopback bridge and OpenAI tunnel form the transport boundary.
5. Verify discovery of eight model-visible tools: `codex_status`, `codex_activity`, `codex_cancel`, `codex_activity_update`, `codex_agent`, `codex_models`, `codex_settings`, and `codex_task`.
6. The card-only `codex_update_settings` and `codex_activity_handoff` actions should also be registered but are not normal model operations.

### Refresh after a bridge/UI change

MCP App resource URIs are cache keys. This repository derives immutable Settings and Activity URIs from final content plus host-affecting resource metadata. Before refreshing ChatGPT:

```bash
npm run release:sync
npm run release:check
npm run check
```

Then deploy/restart the bridge before selecting **Refresh** on the ChatGPT plugin detail screen. This order ensures that the server already serves both the newly advertised current URI and the retained previous URI.

After Refresh:

1. inspect `dist/ui-manifest.json`;
2. confirm the registered `codex_settings` `_meta.ui.resourceUri` and `openai/outputTemplate` exactly equal the manifest's current Settings URI;
3. confirm both `codex_task` (unless visibility is `never`) and `codex_activity` point to the current Activity URI;
4. open a new conversation and run the smoke checklist below;
5. test an existing conversation. If it still has an old tool descriptor, ask it to rediscover tools or use a new conversation. The bridge cannot inject refreshed metadata into an already cached conversation.

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

The **Projects** section lists bridge-allowed roots separately from registered projects. Each project has a stable normalized ID, a Unicode display label, and an absolute folder. New or edited folders are canonicalized with `realpath` and must remain inside an allowed root. The card reports normalized-ID and canonical-path collisions inline. Saved IDs are read-only in the card; edit the label or folder, or remove and add the entry only when a new identity is intended.

The bundled launcher accepts disjoint operator roots as repeated `--root <path>` options. Those roots are a security ceiling, not selectable project entries, and the card cannot widen them or change tunnel credentials, operator capabilities, or the Codex approval policy.

With one allowed root, existing single-folder settings migrate to a `default` project. With multiple projects, choose an optional default. A project whose folder disappears or is no longer inside a narrowed root remains visible as **Needs recovery**, but it cannot be saved or admitted until its folder is fixed or the entry is removed. The card cannot widen allowed roots/capabilities, change tunnel credentials, or change the Codex approval policy.

The compatibility default project and access strategy are independent:

- fixed `read-only` forces read-only and removes per-call `sandbox` from `codex_task`;
- fixed `always-full` forces `danger-full-access` and removes per-call `sandbox`;
- `adaptive` exposes only operator-enabled per-turn sandbox choices.

The public `codex_task` descriptor never contains `cwd`; it projects only the currently selectable project IDs and labels. A new Activity/fresh context uses an explicit `projectId`, the configured default, or the sole project. Existing Activities and continued/forked Agent threads keep their admission-time project and sandbox after Settings changes, and conflicting project IDs fail with `PROJECT_CONTEXT_CONFLICT`. A stale caller that sends `cwd` receives `CWD_OVERRIDE_RETIRED`; a fixed-mode stale caller that sends `sandbox` receives `SANDBOX_OVERRIDE_RETIRED`.

### Dynamic model/effort behavior

Opening Settings and its failure-only retry action use the same bridge catalog adapter. App Server `model/list` is authoritative for App Server, including picker visibility, supported/default efforts, upgrade metadata, and service tiers. A short TTL avoids redundant lookup; a failed lookup preserves and labels the last known good catalog instead of replacing it with an empty list.

Effort options display short localized names only. The selected description is a separate helper linked with `aria-describedby`. Changing model immediately rebuilds supported efforts and the helper. Unknown new effort IDs remain visible with their canonical label and deterministic localized fallback description.

If a saved effort is no longer supported, Settings warns instead of rewriting it. The suggested value is the model's current default. Task execution never forwards the unsupported value; diagnostics record the transient effective effort and warning until the user explicitly saves a supported value.

## 5. Verify the active contract

Call `codex_status` and confirm:

- the saved projects/default-project compatibility mirror, `accessStrategy`, card visibility, and language;
- the operator-root count and mutation capability flags;
- default backend and active build ID;
- settings schema/model policy and catalog source/fingerprint/LKG status;
- SQLite state is reachable.

Inspect `tools/list`:

- `codex_task` has no `cwd`, arbitrary `threadId`, `sessionMode`, or `adoptThread`;
- `projectId` lists only currently selectable registered IDs and their labels;
- fixed access modes have no `sandbox`;
- `adaptive` exposes only permitted sandboxes;
- Agent fields are `agentId`, `agentName`, `agentRole`, and `contextMode`;
- context modes are exactly `continue`, `fork`, and `fresh`.

## 6. Agent and Activity routing

ChatGPT omits `scopeId`; the bridge derives it from anonymous conversation host metadata. A non-ChatGPT compatibility host must generate/reuse an explicit scope UUID. Every logical `codex_task` turn gets a fresh UUID `requestId`; reuse it only for an exact retry.

Use these routes:

```json
{
  "activityTitle": "Implement the agreed design",
  "activityKind": "implementation",
  "projectId": "bridge",
  "agentName": "Mina",
  "agentRole": "implementation",
  "contextMode": "fresh",
  "prompt": "Implement the design and run the relevant checks"
}
```

GPT must submit a complete creation envelope. Every new Activity requires
`activityTitle`, `activityKind`, `agentRole`, and `contextMode`; every new Agent
also requires a unique, human-friendly `agentName`. The bridge returns all
missing fields together under `AGENT_NAME_REQUIRED`, `AGENT_METADATA_REQUIRED`,
or `ACTIVITY_METADATA_REQUIRED` instead of inventing them. Retry with a new
`requestId` and every listed field. Preserve the Agent name when continuing,
forking, or starting another Activity with that Agent, and keep role text in
`agentRole` rather than encoding it in the name.

The result returns immutable `activityId` and `agentId`. A same-goal follow-up uses both exact IDs and `continue`:

```json
{
  "activityId": "...",
  "agentId": "...",
  "contextMode": "continue",
  "prompt": "Address the remaining test failure"
}
```

A new but dependent goal creates a linked Activity without reopening the completed source:

```json
{
  "continuationOfActivityId": "...",
  "agentId": "...",
  "contextMode": "continue",
  "activityTitle": "Follow-up integration",
  "activityKind": "implementation",
  "agentRole": "integration",
  "prompt": "Integrate the completed work with the next component"
}
```

For independent verification, create another named Agent with `fork` or `fresh`. Different Agents run in parallel; the same Agent/thread serializes active turns. If several Agents are attached to an Activity, the bridge rejects a follow-up without exact `agentId`.

Agent lifecycle is separate from turn and Activity lifecycle. A terminal turn returns the Agent to `idle` and releases its active Activity assignment while preserving history. Model-visible `codex_agent` provides only idempotent `rename`, `archive`, and `restore`. Archive/restore changes only bridge-local logical state and never invokes upstream thread archive/unarchive, protecting other Agents that descend from the same fork tree. Active/waiting Agents and Agents with App Server background terminals cannot be archived. Exact process termination belongs to the mounted Activity card's destructive private control; exceptional assignment detach is an operator-enabled private recovery operation. There is no GPT-facing permanent delete.

Before continuing, App Server threads are checked with `thread/read`. A missing
or system-error thread makes the Agent `orphaned`; an active turn or temporary
probe failure is retryable and leaves the Agent intact. Use explicit `fresh`
only for a confirmed orphan; the original stays in thread history.

## 7. Activity card behavior

`codex_task` owns automatic card presentation. When saved visibility is `always` or `background-only`, its descriptor points directly to the same Activity UI resource as `codex_activity`. Call `codex_task` directly—not through programmatic tool calling or an exec wrapper—so ChatGPT preserves that native UI. Do not call `codex_activity` afterward.

For automatic UI, generate one UUID `activityPresentationId` at the first `codex_task` in the current assistant response and reuse it for every later `codex_task` in that same response, including calls for different Agents or Activities. Generate a new UUID for the next assistant response. `requestId` remains per logical Codex call; an exact retry reuses both IDs. If a stale descriptor omits the presentation ID while automatic UI is enabled, refresh tools and retry on `ACTIVITY_PRESENTATION_ID_REQUIRED`. The presentation ID groups cards only and cannot select or bypass the saved visibility setting.

The Task result carries `bridgeActivity`. The mounted widget reads it internally: a true `shouldRenderActivityCard` starts one scope-version `codex_status` long poll, while duplicate, disabled, or foreground-only-in-`background-only` results collapse without displaying another card. A foreground call does not consume a `background-only` presentation; a later background call in the same response may display it. With visibility `never`, the bridge removes the Task UI binding and ignores presentation IDs for display. `codex_activity` is reserved for an explicit user request to open or reopen the view.

The card is a single flat feed scoped to the current ChatGPT conversation. Current work and action-needed states are ordered first as Activity rows. Completed, idle, and ended Agents are collapsed into separate disclosure groups; the completed group reports both distinct Agent and completed Activity counts. When multiple projects are relevant, project labels remain visible across both current and collapsed history rows; full paths remain private. An Activity is not folded while verification, handoff, a job, an interaction, or an App Server background process is pending. Reusing a completed Agent for new work returns it to the current feed.

The feed shows only Activity title, GPT-chosen Agent name, separate role, localized state, kind, timing, final project-folder name when multiple projects are relevant, and necessary controls such as verification, retry, force-stop, background-process stop, approval, or input.

The card deliberately omits a KPI dashboard, card-grid Agent list, layout selector, Activity `<details>`, timelines, Agent/job/thread IDs, full working paths, backend/worker data, command output, and general steering. Detailed diagnostics remain available in `codex_status`.

Automatic duplicate suppression is keyed by `scopeId + activityPresentationId`; `activityId + cardGeneration` is retained only to validate a mounted Activity reference. The first eligible result for a presentation reserves it across all Agents, Activities, and exact retries. A new presentation can render even while an older card for the same Activity remains mounted.

Only the newest automatic presentation owns the scope live watch and completion handoff. When a newer presentation activates, the previous automatic card receives a normal `presentation-superseded` stop result, retains its last snapshot, and releases its watcher slot without a retry loop. Explicit `codex_activity` cards use separate admission (up to three concurrent explicit watchers per scope alongside the one automatic owner) and do not claim automatic completion handoff. `openai/widgetSessionId` identifies only the mounted widget instance. Reservations and ownership are in-memory; after bridge restart the first valid automatic card to reconnect safely re-establishes ownership.

`executionMode: foreground` waits for terminal result. `background` returns `jobId` immediately. Neither completes the Activity. A host without the card can use a bounded wait:

```json
{ "jobId": "...", "waitFor": "terminal", "waitMs": 55000 }
```

Wait timeout leaves Codex running. `codex_cancel` interrupts the exact App Server turn or tracked worker process and records cancellation only after exit evidence; it never rolls back changes.

App Server may leave a background terminal after the turn itself completes. The card keeps the Agent idle but separately shows the remaining-process count and **Stop background processes** action. This action calls the app-private, destructive `codex_background_process_terminate` tool. The bridge revalidates the mounted-card lease, exact Agent version, current App Server thread, fresh terminal inventory, and absence of an active turn before calling `thread/backgroundTerminals/terminate`; it is not Agent archive or job force-stop. The immediately previous content-hashed Activity resource remains available for one compatibility revision, and its legacy process call is accepted only from an active scoped widget lease.

## 8. Smoke checklist after Plugin Refresh

In a new ChatGPT conversation:

1. open Settings and confirm it renders without an old-resource error;
2. add two project folders, verify IDs normalize, duplicate IDs/paths are rejected inline, choose a default, and save;
3. edit one project label/folder, remove the unused project, and confirm allowed roots remain a separate read-only list;
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
16. restart between two App Server turns and confirm `thread/read` resumes the
    exact thread; separately exercise busy, missing, and transient probe paths
    and verify only missing/system-error becomes orphaned;
17. inspect `codex_status` for the experimental policy, exact CLI, catalog
    freshness, aggregate worker health, and orphaned count; verify no full path,
    raw reasoning, MCP payload, or collaboration prompt appears.

In an existing pre-refresh conversation:

1. inspect whether it still advertises old `cwd`/`threadId` fields or an old Settings URI;
2. trigger tool rediscovery if the surface supports it;
3. otherwise document that a new conversation is required;
4. confirm the retained previous UI resource resolves during the rollout window rather than returning resource-not-found.

Record Desktop/Web/iOS surface, plugin URI/template, old/new conversation behavior, and any host cache limitation in the release or issue report.

## 9. Troubleshooting

- Tunnel missing: verify workspace association and Tunnel Read/Use permissions.
- Tool discovery fails: keep the bridge running and rerun `tunnel-client doctor`.
- Old Settings card/tool schema: deploy current server first, use plugin **Refresh**, then start a new conversation if the old one stays cached.
- `DEFAULT_CWD_REQUIRED`: choose a default project (or keep exactly one available project) in Settings.
- `PROJECT_DUPLICATE_ID` / `PROJECT_DUPLICATE_PATH`: correct the highlighted duplicate project values.
- `PROJECT_UNAVAILABLE`: fix or remove the **Needs recovery** project before saving or admitting work.
- `CWD_OVERRIDE_RETIRED`: refresh the plugin/tool list; do not resend per-call cwd.
- `SANDBOX_OVERRIDE_RETIRED`: refresh tools; the fixed saved access strategy is authoritative.
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
