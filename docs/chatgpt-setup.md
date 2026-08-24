# Connect Codex MCP Bridge for ChatGPT

## 1. Prepare Codex and the bridge

Confirm that Codex is installed and authenticated:

```bash
codex --version
codex mcp-server --help
codex app-server --help
```

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
- default working folder;
- UI language;
- concurrent-job limit;
- card visibility;
- optional completion handoff.

For an automatic policy with an explicit range, the card selects models first and then reasoning efforts per model. A model's **All** control expands the currently allowed efforts into exact saved model/effort choices; it does not add an `all` value to the tool schema and does not automatically include efforts discovered later. The separate catalog-visible range remains dynamic.

The Priority checkbox is intentionally separate. `codex_task` exposes only model and reasoning-effort choices to GPT. If the user enables Priority, the bridge injects the supported `priority`/`fast` service tier internally when it calls Codex; GPT cannot choose or override it.

The model catalog is loaded when Settings opens, using the bridge's short TTL and last-known-good cache. The card does not poll and has no persistent refresh button. A retry action appears only when the catalog is stale or a lookup fails.

There is one conversation-scoped flat Activity feed. Retired saved layout
preferences are safely discarded and are not selectable in Settings.

With one allowed root the default folder starts as that root. With multiple allowed roots, save one folder before starting a new Activity. The card cannot widen operator roots/capabilities, change tunnel credentials, or change the Codex approval policy.

The default folder and access strategy are independent:

- fixed `read-only` forces read-only and removes per-call `sandbox` from `codex_task`;
- fixed `always-full` forces `danger-full-access` and removes per-call `sandbox`;
- `adaptive` exposes only operator-enabled per-turn sandbox choices.

The public `codex_task` descriptor must never contain `cwd`. New Activities and `fresh` context use the saved default folder. Existing Agent threads keep their pinned admission-time folder and sandbox after Settings changes. A stale caller that sends `cwd` receives `CWD_OVERRIDE_RETIRED`; a fixed-mode stale caller that sends `sandbox` receives `SANDBOX_OVERRIDE_RETIRED`.

### Dynamic model/effort behavior

Opening Settings and its failure-only retry action use the same bridge catalog adapter. App Server `model/list` is authoritative for App Server, including picker visibility, supported/default efforts, upgrade metadata, and service tiers. A short TTL avoids redundant lookup; a failed lookup preserves and labels the last known good catalog instead of replacing it with an empty list.

Effort options display short localized names only. The selected description is a separate helper linked with `aria-describedby`. Changing model immediately rebuilds supported efforts and the helper. Unknown new effort IDs remain visible with their canonical label and deterministic localized fallback description.

If a saved effort is no longer supported, Settings warns instead of rewriting it. The suggested value is the model's current default. Task execution never forwards the unsupported value; diagnostics record the transient effective effort and warning until the user explicitly saves a supported value.

## 5. Verify the active contract

Call `codex_status` and confirm:

- the saved `defaultCwd`, `accessStrategy`, card visibility, and language;
- operator roots and mutation capability flags;
- default backend and active build ID;
- settings schema/model policy and catalog source/fingerprint/LKG status;
- SQLite state is reachable.

Inspect `tools/list`:

- `codex_task` has no `cwd`, arbitrary `threadId`, `sessionMode`, or `adoptThread`;
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

Agent lifecycle is separate from turn and Activity lifecycle. A terminal turn returns the Agent to `idle` and releases its active Activity assignment while preserving history. `codex_agent` provides idempotent `rename`, `detach`, `archive`, `restore`, and exact `terminate-background-process` actions. Active/waiting Agents and Agents with App Server background terminals cannot be archived. There is no GPT-facing permanent delete.

If the backend cannot resume the current thread, the Agent becomes `orphaned`. Use explicit `fresh` to replace its current thread; the original stays in thread history.

## 7. Activity card behavior

`codex_task` owns automatic card presentation. When saved visibility is `always` or `background-only`, its descriptor points directly to the same Activity UI resource as `codex_activity`. Call `codex_task` directly—not through programmatic tool calling or an exec wrapper—so ChatGPT preserves that native UI. Do not call `codex_activity` afterward.

The Task result carries `bridgeActivity`. The mounted widget reads it internally: a true `shouldRenderActivityCard` starts one scope-version `codex_status` long poll, while duplicate, disabled, or foreground-only-in-`background-only` results collapse without displaying another card. With visibility `never`, the bridge removes the Task UI binding. `codex_activity` is reserved for an explicit user request to open or reopen the view.

The card is a single flat feed scoped to the current ChatGPT conversation. Current work and action-needed states are ordered first as Activity rows. Completed, idle, and ended Agents are collapsed into separate disclosure groups; the completed group reports both distinct Agent and completed Activity counts. An Activity is not folded while verification, handoff, a job, an interaction, or an App Server background process is pending. Reusing a completed Agent for new work returns it to the current feed.

The feed shows only Activity title, GPT-chosen Agent name, separate role, localized state, kind, timing, final project-folder name when multiple projects are relevant, and necessary controls such as verification, retry, force-stop, background-process stop, approval, or input.

The card deliberately omits a KPI dashboard, card-grid Agent list, layout selector, Activity `<details>`, timelines, Agent/job/thread IDs, full working paths, backend/worker data, command output, and general steering. Detailed diagnostics remain available in `codex_status`.

Automatic duplicate suppression is scoped to the current Activity presentation generation. The server uses a short render reservation followed by an in-memory lease keyed by `openai/widgetSessionId`. The card renews that lease on reload/watch; abort/unmount/TTL releases it. A new or linked Activity can render a new generation even while continuing the same Agent/thread. An explicit user request may set `forceNewCard` to bypass suppression.

`executionMode: foreground` waits for terminal result. `background` returns `jobId` immediately. Neither completes the Activity. A host without the card can use a bounded wait:

```json
{ "jobId": "...", "waitFor": "terminal", "waitMs": 55000 }
```

Wait timeout leaves Codex running. `codex_cancel` interrupts the exact App Server turn or tracked worker process and records cancellation only after exit evidence; it never rolls back changes.

App Server may leave a background terminal after the turn itself completes. The card keeps the Agent idle but separately shows the remaining-process count and **Stop background processes** action. This action uses `thread/backgroundTerminals/terminate`; it is not Agent archive or job force-stop.

## 8. Smoke checklist after Plugin Refresh

In a new ChatGPT conversation:

1. open Settings and confirm it renders without an old-resource error;
2. change a harmless preference and save;
3. confirm there is no persistent model-refresh button; if a stale/failure warning is present, use its contextual retry and confirm the last-known-good options remain populated;
4. choose **Restore default settings**, confirm, and verify the card rerenders;
5. confirm `codex_task` has no `cwd` and fixed access modes have no `sandbox`;
6. start a narrow foreground read-only Activity and confirm it uses the saved folder;
7. open the flat Activity feed and verify there is no KPI/card grid/layout selector or path/backend/ID/timeline detail;
8. run a same-Agent `continue`, then a second-Agent parallel `fresh`/`fork`, and confirm one card is reused for the Activity;
9. complete work and confirm **Completed Codex** is collapsed with distinct Agent and Activity counts, then reuse that Agent and confirm it returns to the current feed;
10. archive/restore an idle Agent and confirm the same immutable ID/thread history remains;
11. start a linked Activity with the existing Agent and confirm it gets a new card generation without reopening the terminal source.

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
- `DEFAULT_CWD_REQUIRED`: save a default folder in Settings.
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
