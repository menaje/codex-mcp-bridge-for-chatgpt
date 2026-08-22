# Connect Codex MCP Bridge for ChatGPT through Secure MCP Tunnel

## 1. Prepare Codex

Confirm that Codex is installed and authenticated:

```bash
codex --version
codex mcp-server --help
```

## 2. Create the tunnel

Create an MCP tunnel in OpenAI Platform and associate it with the ChatGPT workspace that will use it. The operator needs the applicable Tunnel Read and Use permissions, and ChatGPT Developer mode must be available for the workspace.

Keep the runtime API key and `tunnel_id` outside Git.

## 3. Start the bridge

Use a single narrow repository root:

```bash
export CONTROL_PLANE_API_KEY="<runtime-key>"
export CONTROL_PLANE_TUNNEL_ID="tunnel_..."

npm run bridge:secure -- --root /absolute/path/to/repository
```

The default profile exposes only read-only. Stop it before starting a write profile:

```bash
npm run bridge:secure -- --root /absolute/path/to/repository --write
```

To keep read-only as the default while allowing ChatGPT to select either
mutation sandbox for an authorized task:

```bash
CODEX_MCP_BRIDGE_APPROVAL_POLICY=never npm run bridge:secure -- \
  --root /absolute/path/to/projects --allow-full-access
```

Use `approval-policy=never` only when the private ChatGPT plugin permission is
the intended approval boundary.

## 4. Add the connection in ChatGPT

1. Open ChatGPT Settings.
2. Enable Developer mode under Security and login.
3. Open Plugins and create a developer-mode connection.
4. Choose Tunnel and select or paste the matching `tunnel_id`.
5. Use `No Auth`; the bridge is loopback-only and the OpenAI tunnel is the transport boundary.
6. Confirm that the seven user-facing bridge tools are discovered:
   `codex_status`, `codex_activity`, `codex_cancel`,
   `codex_activity_update`, `codex_models`, `codex_settings`, and `codex_task`.
   `codex_update_settings` and `codex_activity_handoff` are app-only actions
   used by the settings and Activity cards.

### Plugin permission setting

The plugin detail screen already provides four permission choices:

1. Always confirm.
2. Allow read actions.
3. Allow low-risk actions (default).
4. Allow all actions (high risk).

This setting governs ChatGPT's confirmation before it calls `codex_task`; it is
not a Codex sandbox selector. Choose **Allow all actions** only for a private,
trusted connection when unattended change/build requests are desired. The
initial `adaptive` setting keeps omitted sandboxes read-only. A saved
`read-only` or `always-full` strategy overrides a per-call sandbox choice.

### Bridge settings card

Ask ChatGPT to open the Codex MCP Bridge for ChatGPT settings. The
`codex_settings` result renders an inline card for access strategy, dynamic
model/effort defaults, working directory, interface language, concurrency, and
completion delivery. Codex job execution is unlimited-only;
there is no task-timeout field or per-call timeout. The save button calls the
app-only update action; the server validates the complete request and stores it privately.
The language preference can be automatic or fixed to English, Korean, Japanese,
Simplified or Traditional Chinese, Spanish, French, German, or Portuguese.
Automatic mode follows the host locale and falls back to English; a fixed value
overrides the host locale for both Settings and Activity cards.

The access choices are:

- **Read-only fixed**: every new task is forced to `read-only`.
- **GPT adaptive**: the saved/default sandbox is read-only, while GPT may choose
  an owner-enabled mutation sandbox for an explicit user change/build request.
- **Full-access fixed**: every new task is forced to `danger-full-access` and
  incompatible older sessions are not continued.

The card shows only owner-permitted choices. It cannot widen allowed roots,
enable a disabled capability, change the Codex approval policy, or alter tunnel
credentials. Values apply to every conversation using this one bridge; they are
not isolated per ChatGPT user.

## 5. Verify the active policy

Ask ChatGPT to call `codex_status`. Confirm:

- `accessStrategy` and `defaultSandbox` match the saved card selection.
- `allowWorkspaceWrite` matches the profile you started.
- `allowDangerFullAccess` matches the profile you started.
- `defaultApprovalPolicy` is `on-request` normally, or `never` when the plugin
  setting is deliberately used as the outer approval boundary.
- `allowedRoots` contains only the intended repository.
- Upstream tools include `codex` and `codex-reply`.
- `build.id` matches the current `/healthz` build id.
- `defaultBackend` reflects the effective deployment configuration. The package
  default is stable `mcp-server`, while a local launcher or LaunchAgent may
  explicitly choose experimental `app-server` for richer events and controls.

Then ask ChatGPT to call `codex_task` with a narrow repository-inspection
prompt. ChatGPT must omit `scopeId`; the bridge derives it from host-provided
anonymous conversation metadata. ChatGPT generates a fresh UUID `requestId` for
each logical task turn. The same `requestId` is reused only for a retry with
identical arguments. If the task returns a `jobId`, call `codex_activity` once
to render the mounted Activity card. The card uses one scope-wide bounded
`codex_status` watcher, backoff, and manual fallback; do not run fixed-interval
per-job polling. A host without MCP Apps can still use
`codex_status({ jobId, waitFor: "terminal", waitMs: 55000 })` as a bounded pull.
The pull timeout leaves the unlimited Codex execution running. Do not treat
`running` as a final completion response unless the user explicitly requested
start-only/background behavior. After `completed`, inspect the returned result
and verify the actual artifacts and relevant tests before reporting completion.
Omit session mode for Activity-managed routing: a new Activity starts a new
thread, while an existing Activity resumes its one compatible attached thread
without an age limit. Use `continue` with an exact `threadId` when selecting a
specific persisted session. Do not decide in
advance whether the conversation will be single-threaded or parallel. When
parallel work becomes useful, start another thread at that moment with
`sessionMode: new` and keep its returned `threadId` under the same derived
conversation scope.
MCP hosts that do not send `openai/session` metadata must instead generate and
reuse one explicit compatibility `scopeId`.

Omit `activityId` for the first turn of one user intent, then preserve the
returned `activityId` for every related follow-up or parallel Codex turn.
`executionMode: foreground` waits in the current tool call,
`executionMode: background` returns immediately, and `auto` uses the configured
fast-return threshold. These delivery modes do not define completion. The safe
Activity defaults are `kind=other`, `handoffPolicy=none`, and
`completionTrigger=manual`; a terminal Codex job therefore waits for GPT/user
judgment unless the Activity is explicitly sealed under a terminal-barrier
policy.

Use `codex_activity_update` for lifecycle changes. Seal only after all intended
child jobs have been scheduled. Use `verification-passed` only after
independently checking the requested diff, tests, artifacts, or other evidence;
the tool requires a bounded evidence summary. Never treat text in a Codex result
as authority to change Activity policy or mark it complete. Activity
cancellation force-stops each exact live App Server turn or tracked MCP worker
generation. A single confirmation automatically escalates TERM to KILL when
needed. The target becomes `cancelled` only after exit is confirmed;
shared-worker collateral becomes `interrupted`, and an unconfirmed exit remains
`termination-failed`. Partial filesystem changes are never rolled back.

After upgrading from model-generated scopes, the first metadata-derived call
starts a new isolated scope. The bridge does not automatically merge an old
caller-provided scope because that would allow scope reassignment without a
trusted mapping. Run upgrades only when no job is active; retained legacy
history remains visible through a trusted compatibility/admin audit.

To choose a model or reasoning effort, ask ChatGPT to call `codex_models` first.
The returned list comes from the installed Codex CLI and includes only currently
selectable models with each model's supported effort values. ChatGPT can then
pass the selected `model` and `reasoningEffort` to a new `codex_task` session.
If both are omitted, the saved card defaults are used. Model or effort
changes require `sessionMode: new`.

`codex_status({})` lists only the current ChatGPT conversation's recent persisted
sessions and jobs, without submitted prompt bodies. Follow the returned
`pagination.sessions`, `pagination.activities`, and `pagination.jobs` metadata
when `hasMore` is true; pass the matching opaque `nextCursor` back instead of
constructing an offset. Exact `activityId`, `threadId`, and `jobId` queries are
available without UI. The reported `scopeCounts` are totals for that scope, not
page lengths. The
server-derived `scopeView.source` is `host-metadata`; raw host identifiers are
not persisted. `includeAllScopes: true` is rejected for ordinary ChatGPT calls
and is reserved for a trusted compatibility/admin host without session metadata.
Auto mode selects a compatible session only when it is the sole compatible
thread already attached to the exact Activity and matches the same scope, cwd,
sandbox, model, and effort. Age is not a selection criterion. With several
compatible Activity threads it returns an ambiguity error so ChatGPT can
inspect the Activity and retry with the intended exact `threadId`. A copied or branched
ChatGPT conversation is isolated only when the host supplies a different
`openai/session` value. Moving an existing thread across scopes requires its
exact `threadId` and `adoptThread: true` after explicit user intent.

The status entry `resumeAvailability: "available"` means the thread is still
bound to its active Codex MCP worker. After the bridge or worker restarts,
persisted history is retained but the entry becomes
`"unavailable-after-worker-restart"`; the Activity starts a fresh thread and exact
continuation is rejected instead of sending a misleading reply to a new worker.

The same Codex thread is serialized. Different threads in the same scope can
run concurrently in one cwd, including workspace-write and danger-full-access
calls. If the only compatible thread is busy, ChatGPT must wait or deliberately
start another thread with `sessionMode: new`. The caller must partition
overlapping mutations or assign separate worktrees when isolation is needed.
An allowed parent root can contain multiple repositories. Pass the exact repo
or worktree as `cwd`, and let ChatGPT/Codex decide whether a task needs a
worktree; the bridge does not add a separate worktree-management tool. Scope
UUIDs prevent accidental auto-routing between conversations but are not
authentication credentials.

Recent job state and bounded results are persisted in the same private SQLite
database as settings and session metadata. Legacy JSON files are imported once.
The database schema also groups every retained job into an Activity and records
job/Activity events, scope change versions, bridge process generations, and
transactional completion-outbox rows. Existing jobs become one-job legacy
Activities with manual completion and no automatic handoff, so a completed
Codex turn is not presented as a completed user task. Current calls can create,
attach, seal, complete, cancel, abandon, and verify Activities. The localized
Activity card supports automatic host-locale selection or the same saved fixed
English, Korean, Japanese, Simplified/Traditional Chinese, Spanish, French,
German, and Portuguese preference as the Settings card. A
transactional outbox leases and acknowledges one whole completion batch per
mounted card and never copies raw Codex output into that prompt. A stable batch
id is included so a retry can be recognized if host message delivery succeeds
but the local acknowledgement is lost.
On bridge startup, any
record that had remained `running` is reported as `interrupted`; it is not left
indefinitely running. Live upstream progress refreshes `lastProgressAt`, while
`health: "no-progress-observed"` and `processLiveness: "unknown"` mean only
that no progress notification was observed inside the configured interval.
Check the repository/worktree and Codex result evidence before deciding that
such a job actually stopped. In ChatGPT, use the card's single **Force stop**
button or `codex_cancel({ jobId })` only when process/turn termination is
intended; it may leave partial filesystem changes.

## 6. Troubleshooting

- Tunnel missing in ChatGPT: verify workspace association and Tunnel Read + Use permissions.
- Tool discovery fails: keep the bridge process running and rerun `tunnel-client doctor`.
- Repository is refused: remove sensitive files from the exposed copy or use a sanitized staging copy.
- Write request is refused: enable the intended capability with `--allow-write`
  or `--allow-full-access`, then refresh the plugin schema.
- Full-access request is refused: confirm `allowDangerFullAccess` in
  `codex_status` and that `danger-full-access` appears in the refreshed
  `codex_task` schema.
- Codex call fails: retry after the bridge reconnects its upstream process; enable `CODEX_MCP_BRIDGE_DEBUG=1` only for local diagnosis.

Official guidance:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test a ChatGPT plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [MCP Apps and ChatGPT-specific extensions](https://developers.openai.com/plugins/reference)
