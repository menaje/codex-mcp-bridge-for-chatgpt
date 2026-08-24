# Codex MCP Bridge for ChatGPT

A policy-enforcing Streamable HTTP MCP bridge from ChatGPT to local Codex.

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
  -> settings-managed named projects inside operator-allowed roots
       -> one optional compatibility default for fresh work
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

- `codex_task`: create or reuse a named Agent, create or attach an Activity, run one exact Codex turn, and own automatic Activity-card presentation.
- `codex_status`: inspect authoritative scope, Agent, Activity, thread, turn, and job state or make a bounded watch.
- `codex_activity`: explicitly open or reopen the localized lightweight Agent/Activity card on user request.
- `codex_activity_update`: apply one validated Activity lifecycle or verification transition.
- `codex_agent`: rename, archive, or restore an Agent. It never deletes an Agent.
- `codex_cancel`: force-stop an active scope-owned turn/job. Filesystem changes are not rolled back.
- `codex_models`: read the current picker-visible model catalog and exact supported efforts.
- `codex_settings`: render saved named projects, policy, and preferences.

`codex_update_settings` and `codex_activity_handoff` are app-only actions used by the cards. `codex_background_process_terminate` is a destructive app-private control bound to an exact mounted-card lease, Agent version, App Server thread, and process. `codex_agent_recovery_detach` is a private recovery action that is disabled unless the operator explicitly enables it.

## Security defaults

- Binds to `127.0.0.1`.
- Uses `read-only` and `on-request` unless the operator enables broader capabilities.
- Uses a settings-managed registry of stable project IDs, Unicode labels, and canonical folders. A single-root bridge starts with one migrated compatibility project; multiple projects may have an optional default.
- Rejects per-call `cwd`. A stale caller receives `CWD_OVERRIDE_RETIRED` instead of being run in an unintended repository.
- Exposes per-call `sandbox` only while the saved strategy is `adaptive`; fixed `read-only` and `always-full` descriptors omit it and enforce the saved policy.
- Validates every newly saved project folder against real-path allowed roots, rejects duplicate IDs/paths, and checks common secret filenames before new execution.
- Limits prompt size, concurrent jobs, retained jobs, and retained result size.
- Stores settings, sessions, Agents, Agent/thread history, Activity assignments, jobs, and bounded results in a private SQLite database.

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
npm run bridge:local -- --root /absolute/path/to/repository
```

The launcher uses `http://127.0.0.1:8876/mcp`; health is at `/healthz`. Its
App Server diagnostics contain only aggregate late-response counters and the
latest method/outcome class, never thread/turn identifiers or response bodies.
Repeat `--root` to admit multiple disjoint operator roots in one bridge process:

```bash
npm run bridge:local -- \
  --root /absolute/path/to/repository-a \
  --root /absolute/path/to/repository-b
```

Each launcher root must already exist and resolve to a directory. The launcher
canonicalizes and de-duplicates them before startup. These roots are only the
immutable operator security ceiling; Settings still controls which named
projects inside that ceiling are selectable. A single `--root` and omission
(which uses the current directory) retain their previous behavior.

For a tunnel connection:

```bash
export CONTROL_PLANE_API_KEY="<runtime-key>"
export CONTROL_PLANE_TUNNEL_ID="tunnel_..."

npm run bridge:secure -- --root /absolute/path/to/repository
```

Capability profiles are operator ceilings:

```bash
# Fixed full-access starting policy
npm run bridge:secure -- --root /absolute/path/to/repository --write

# Adaptive policy may choose workspace-write
npm run bridge:secure -- --root /absolute/path/to/projects --allow-write

# Adaptive policy may choose workspace-write or danger-full-access;
# the Settings card may also select fixed always-full.
npm run bridge:secure -- --root /absolute/path/to/projects --allow-full-access
```

Do not leave a broader profile running when it is not needed.

## Settings and execution policy

Ask ChatGPT to open the Codex MCP Bridge for ChatGPT settings. The card controls:

- access strategy: `read-only`, `adaptive`, or operator-enabled `always-full`;
- fixed or automatic exact model policy;
- independent Priority/Fast processing for Codex calls;
- named projects with stable normalized IDs, Unicode labels, canonical folders inside allowed roots, and an optional default project;
- UI language;
- active-job limit;
- Activity-card visibility: `always` means one automatic card per GPT response,
  `background-only` means one per response that has eligible background work,
  and `never` disables automatic cards;
- completion handoff: `off` or `auto-handoff` while a card is mounted.

In automatic policy's explicit mode, models and reasoning efforts are selected separately. Per-model **All** snapshots every effort currently allowed for that model into ordinary model/effort entries; no synthetic `all` value is persisted or exposed to GPT. Catalog-visible mode stays dynamic and can include later catalog additions.

Priority is an independent user preference, not part of the model policy. GPT sees and selects only `model` and `reasoningEffort`. When Priority is enabled, the bridge validates that the chosen model supports the Priority/Fast tier and injects the catalog's `priority` (or `fast`) identifier only into the downstream Codex call. Existing MCP threads retain their admission-time tier when that backend cannot change tiers on continuation.

Opening Settings resolves the model catalog through the normal short-lived cache. There is no persistent refresh control or polling; when the lookup is stale or fails, the card keeps the last-known-good catalog and shows a contextual retry action.

The Activity card has one conversation-scoped flat-feed layout. Older saved
layout preferences are safely discarded; there is no layout selector or active
layout setting.

The Projects section clearly separates bridge-allowed roots from registered projects. Adding or editing a project resolves its folder with `realpath`, requires it to remain inside an allowed root, and rejects duplicate normalized IDs or canonical paths. Saved project IDs are stable; labels and folders remain editable. A legacy `defaultCwd` is deterministically migrated to the `default` project. If a saved folder later disappears or falls outside a narrowed root policy, its metadata remains visible for recovery but cannot be admitted until it is fixed or removed.

`codex_task` projects the currently selectable project IDs and labels, never their paths. A new Activity/fresh context may choose `projectId`; omission uses the configured default or sole project and otherwise returns `PROJECT_REQUIRED`. Existing Activities and continued/forked Agent threads retain their admission-time project, folder, and sandbox even after Settings changes. A conflicting project selection returns `PROJECT_CONTEXT_CONFLICT`. A project folder limits where Codex starts; it does not grant or reduce permissions, and Codex may explore child repositories within its saved access policy.

Access strategy and path policy are separate:

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
- `automatic`: current catalog-visible selections or an explicit exact allowlist, optionally with a preferred selection.

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
aggregate worker health, and orphaned-Agent count without publishing local
paths or raw protocol payloads.

The backend setting affects only newly created threads. Existing MCP and App
Server threads remain pinned to their original backend. Rollback therefore
means restoring `CODEX_MCP_BRIDGE_DEFAULT_BACKEND=mcp-server` and restarting;
it does not convert or discard already created App Server threads.

Before an App Server continuation, the bridge probes exact persisted state with
`thread/read`. `notLoaded` and `idle` are resumable, `active` returns retryable
`AGENT_THREAD_BUSY`, and a transient probe failure returns retryable
`THREAD_PROBE_UNAVAILABLE` without changing Agent state. Only a missing thread
or `systemError` marks the Agent `orphaned`. Approval/input requests retain a
bounded path-safe view of reason, working-folder label, network context,
permission scope, amendments, and available decisions. The bridge consumes
`serverRequest/resolved` and applies an `autoResolutionMs` expiry guard so stale
controls do not remain in Activity state; session approval appears only when it
is an available decision.

## Agent, Activity, and context routing

In ChatGPT, omit `scopeId`; the bridge derives an opaque UUID from anonymous host conversation metadata. Compatibility MCP hosts without that metadata must generate and reuse an explicit UUID. Scope IDs are routing labels, not authentication credentials.

Every `codex_task` call requires a fresh UUID `requestId`; reuse it only for an exact retry. The public contract intentionally has no `cwd`, arbitrary `threadId`, `sessionMode`, or `adoptThread` field.

Routing fields are:

- pass one projected `projectId` for a new Activity/fresh context, or omit it only when a default/sole project is available;
- omit `activityId` to create a new Activity;
- pass the exact returned `activityId` for another turn in the same open Activity;
- pass `continuationOfActivityId` to create a linked Activity without reopening a terminal source Activity;
- pass exact `agentId` to reuse a bridge-managed Agent;
- for every new Activity, GPT must supply `activityTitle`, `activityKind`, `agentRole`, and an explicit `contextMode`;
- when creating a new Agent, GPT must also choose a unique human-friendly `agentName`; keep the assignment in the separate `agentRole` field;
- when adding a new Agent to an existing Activity, supply `agentName`, `agentRole`, and `contextMode`.

Recommended mappings:

- same goal: same Activity + same Agent + `continue`;
- new but dependent goal: new linked Activity + same Agent + `continue`;
- independent verification/alternative: another Agent with `fork` or `fresh`;
- unrelated goal: new Activity + new Agent + `fresh`.

One Agent/thread admits only one active turn. Different Agents/threads can run in parallel in the same scope and folder. If an Activity has multiple Agent candidates, the bridge requires an exact `agentId` instead of guessing. The bridge never invents public identity metadata: GPT supplies a person-like display name such as `Mina`, while `agentRole` can say `implementation` or `review`. Missing creation fields are reported together through `AGENT_NAME_REQUIRED`, `AGENT_METADATA_REQUIRED`, or `ACTIVITY_METADATA_REQUIRED`, so GPT can retry once with a complete envelope and a new `requestId`. Existing Agent/Activity follow-ups reuse stored metadata. Agent names are Unicode-normalized and case-insensitively unique within a scope.

`continue`, `fork`, and `fresh` map to backend resume, fork, and start. A fresh context on the same logical Agent adds a thread-history entry and makes the new thread current. If an exact backend probe proves that a persisted thread is missing or in a system-error state, the Agent becomes `orphaned`; replacement requires explicit `fresh` and the old history remains auditable. Busy and transient probe states remain retryable and do not destroy continuity evidence.

When a turn becomes terminal, its Agent returns to `idle`, releases the active Activity assignment, and remains reusable. `codex_agent` provides idempotent scope-local actions:

- `rename`: changes the alias only;
- `archive`: hides an idle Agent while preserving its current/history threads and assignments;
- `restore`: returns that exact archived Agent.

Active/waiting Agents and Agents with a remaining background process cannot be archived. A mounted Activity card stops one exact remaining App Server terminal through the separate destructive `codex_background_process_terminate` capability. Exceptional assignment repair uses `codex_agent_recovery_detach`, requires exact Activity/Agent/version preconditions, rechecks idle state transactionally, and is disabled by default. Force-stop, background-process termination, recovery detach, and archive are distinct operations; none rolls back filesystem changes. Permanent Agent/thread deletion is not exposed.

## Activity card lifecycle

`codex_task` is directly bound to the same Activity UI resource whenever the saved visibility is `always` or `background-only`. Its result tells the widget whether the current GPT-response presentation should display; the widget then attaches its own bounded `codex_status` watch. GPT must call `codex_task` directly and must not make a follow-up `codex_activity` call. With `never`, the Task UI binding is removed. In `background-only`, a foreground result is suppressed without consuming the response presentation, so a later background call in that same response can still display the one card. `codex_activity` remains available only for an explicit user-requested open or reopen.

`requestId` and `activityPresentationId` have deliberately different scopes. GPT creates one `requestId` for each logical Codex call. When automatic UI is enabled, GPT also creates one `activityPresentationId` UUID for the current assistant response, reuses it for every `codex_task` in that response even across Agents or Activities, and creates a new value for the next response. An exact retry reuses both IDs. A current automatic-UI descriptor requires the presentation ID; a stale descriptor that omits it receives retryable `ACTIVITY_PRESENTATION_ID_REQUIRED` instead of silently falling back to Activity-generation grouping. The saved visibility policy remains authoritative and cannot be overridden by the ID.

The card is one lightweight flat feed for the current ChatGPT conversation. Open work and anything needing user/GPT action stay visible as Activity rows, with the Activity title, named Agent participants, separate roles, kind, timing, and only the action needed now. It has no KPI dashboard, card-grid Agent list, or layout selector.

Truly completed work moves into a collapsed **Completed Codex** group that reports both distinct Agent count and completed Activity count. Idle and ended Agents have separate collapsed groups. When more than one project is relevant, its label remains visible in current and collapsed history rows without exposing the folder path. A completed Activity remains in the current feed while verification, a handoff, a tracked job, an interaction, or an App Server background process is still pending. Reusing the same Agent for a new Activity removes it from completed history and shows the new current Activity instead.

Agent archive/restore is bridge-local logical state. It never calls App Server `thread/archive` or `thread/unarchive`, so archiving one logical Agent cannot implicitly archive another Agent's descendant fork.

The card does not expose event timelines, Agent/job/thread IDs, full working paths, backend/worker details, command output, or general steering. When multiple projects are active, it may show their user-defined labels. Approval/user-input controls are sent only in a minimal UI-only metadata payload. GPT/operations can still retrieve detailed diagnostics with `codex_status`.

Automatic card duplication is suppressed per `scopeId + activityPresentationId`; the first eligible result reserves that presentation across Activities, Agents, and exact retries. `activityId + cardGeneration` remains only the mounted Activity validity check. A mounted widget renews an in-memory lease keyed by `openai/widgetSessionId`; abort/unmount/TTL releases it, and restart does not restore presentation ownership. After restart, the first valid mounted automatic card safely re-establishes ownership.

Only the newest automatic presentation in a conversation owns the bounded scope-version long poll and completion handoff. Activating a new presentation wakes the prior automatic card, which keeps its last snapshot and receives a normal `presentation-superseded` stop signal instead of retrying or retaining a watcher slot. Explicitly opened `codex_activity` cards are a separate class: at most three may watch per scope alongside the one automatic owner, and they never compete for automatic completion handoff. `openai/widgetSessionId` correlates a mounted widget instance only; it is not treated as an assistant-response ID. `executionMode: background` returns a tracked job immediately; `foreground` waits for its terminal result. Neither mode changes Activity completion. Use `codex_status({ jobId, waitFor: "terminal", waitMs: 55000 })` only as a bounded fallback; timeout does not stop Codex.

## UI cache-key and Plugin Refresh policy

`release-manifest.json` is canonical for release identity, personal/local plugin metadata, and UI resource policy. `npm run release:sync` generates `.codex-plugin/plugin.json` and `.app.json`, including the display name, developer, category, release SemVer, and existing ChatGPT developer-mode connection. Settings and Activity URIs are immutable content hashes of the final HTML/JS/CSS plus host-affecting metadata:

```text
ui://codex-mcp-bridge/settings/<sha256-prefix>.html
ui://codex-mcp-bridge/activity/<sha256-prefix>.html
```

`ui-manifest.lock.json` and `ui-resources/` contain source-side current/retained snapshots. `npm run release:sync` is the only command that updates them and the generated source manifest. Build reproduces `dist/ui-manifest.json` and packages current plus one previous URI. `release:check` rejects content/digest, metadata, resource/descriptor, `ui.resourceUri`, `openai/outputTemplate`, missing-resource, duplicate-URI, or snapshot drift.

SemVer and UI identity are independent: a release-only version change preserves unchanged UI URIs; a UI or relevant resource-metadata change creates a new URI even within the same development version.

Deployment order:

1. run `npm run release:sync`, `npm run release:check`, and `npm run check`;
2. deploy/restart the server that serves both current and previous resources;
3. in ChatGPT Developer mode, open the plugin detail and select **Refresh**;
4. confirm `codex_settings`'s output template equals the current Settings URI in `dist/ui-manifest.json`;
5. smoke-test Settings open/save/model refresh/default restore and Activity rendering in a new conversation;
6. check an existing conversation. If it retains the old tool list, request tool rediscovery or start a new conversation. The bridge cannot force cached conversation metadata to refresh.

See [docs/chatgpt-setup.md](docs/chatgpt-setup.md) for the operator checklist and [docs/releasing.md](docs/releasing.md) for release details.

## Persistence and recovery

SQLite schema v5 stores conversation scopes, first-class project admission identity, Agents, current/history threads, Activity-Agent assignments, Activities, jobs, bounded events/results, settings, bridge generations, scope versions, idempotent Agent mutations, and completion outbox rows. A bounded sanitized App Server late-response journal and aggregate counters support timeout reconciliation without retaining raw response bodies, prompts, commands, or paths.

Older session/job/Activity rows migrate to deterministic scope-local Legacy Agents. Their names, assignments, thread history, and terminal assignment releases remain explicit. Existing JSON settings/session/job files are imported once. An in-flight job found after restart becomes `interrupted`; the bridge does not claim that the former process is still running.

App Server threads are checked by exact ID with `thread/read` before resume. MCP Server thread context is worker-generation-local and can become unavailable after restart. The bridge never silently substitutes a new thread.

## Development and releases

Work on `dev`. The GitHub workflow runs only on `main`; do not promote or push to `main` without explicit instruction.

`release-manifest.json` controls product/package identity, personal/local plugin metadata, the exact supported App Server CLI, toolchain, repository, SemVer/release assets, and UI resource policy. Normal version change:

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

The current product/repository/package names include **for ChatGPT**. Bare `codex-mcp-bridge` values are a retained runtime namespace covering the executable, environment prefix, local state directory, Keychain services, tunnel profile, and MCP App URI namespace.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_MCP_BRIDGE_HOST` | `127.0.0.1` | HTTP bind host |
| `CODEX_MCP_BRIDGE_PORT` | `8765` | Direct-server port; launcher defaults to `8876` |
| `CODEX_MCP_BRIDGE_TOKEN` | unset | Bearer token unless loopback no-auth is used |
| `CODEX_MCP_BRIDGE_NO_AUTH` | unset | Allowed only on loopback |
| `CODEX_MCP_BRIDGE_CODEX` | `codex` | Codex CLI command; App Server requires the manifest-pinned exact version |
| `CODEX_MCP_BRIDGE_ROOTS` | current directory | Direct-server comma-separated absolute starting-root allowlist; the bundled launcher uses repeatable `--root` |
| `CODEX_MCP_BRIDGE_DEFAULT_SANDBOX` | `read-only` | Adaptive omission/default sandbox |
| `CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY` | `adaptive` | Initial saved access strategy |
| `CODEX_MCP_BRIDGE_ALLOW_WRITE` | unset | Enables workspace-write capability |
| `CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS` | unset | Enables danger-full-access capability |
| `CODEX_MCP_BRIDGE_APPROVAL_POLICY` | `on-request` | `untrusted`, `on-request`, or `never` |
| `CODEX_MCP_BRIDGE_DEFAULT_BACKEND` | `mcp-server` | New-thread backend: `mcp-server` or `app-server` |
| `CODEX_MCP_BRIDGE_DEFAULT_MODEL` | unset | Optional preferred model seed; requires effort seed |
| `CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT` | unset | Optional preferred effort seed; requires model seed |
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

## macOS Keychain

The service strings are retained runtime compatibility keys:

```bash
security add-generic-password -a "$USER" -s "codex-mcp-bridge:control-plane-api-key" -w "<runtime-key>" -U
security add-generic-password -a "$USER" -s "codex-mcp-bridge:control-plane-tunnel-id" -w "tunnel_..." -U

CODEX_MCP_BRIDGE_ROOT=/absolute/path/to/repository npm run bridge:secure:keychain

# Explicit --root arguments replace the compatibility root above and may repeat.
npm run bridge:secure:keychain -- \
  --root /absolute/path/to/repository-a \
  --root /absolute/path/to/repository-b
```

Historical attribution is in [UPSTREAM.md](UPSTREAM.md).
