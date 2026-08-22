# Connect ChatGPT through Secure MCP Tunnel

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
6. Confirm that the five user-facing bridge tools are discovered:
   `codex_status`, `codex_cancel`, `codex_models`, `codex_settings`, and `codex_task`.
   `codex_update_settings` is an app-only action used by the settings card.

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

Ask ChatGPT to open the MacBook Air Codex Bridge settings. The
`codex_settings` result renders an inline card for access strategy, dynamic
model/effort defaults, working directory, session behavior, auto-resume window,
task timeout, and concurrency. The save button calls the app-only update action;
the server validates the complete request and stores it privately.

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

Then ask ChatGPT to call `codex_task` with a narrow repository-inspection
prompt. ChatGPT must generate one UUID `scopeId` for the current conversation,
reuse it for later calls in that conversation, and generate a fresh UUID
`requestId` for each logical task turn. The same `requestId` is reused only for
a retry with identical arguments. If the task returns a `jobId`, pass that exact
value and the same `scopeId` to `codex_status`. For a request that should be
managed through completion, call
`codex_status({ scopeId, jobId, waitFor: "terminal", waitMs: 55000 })`; repeat a bounded
wait only when it returns a still-running timeout. Use `waitFor: "change"` when
the next progress update itself is relevant. Do not treat `running` as a final
completion response unless the user explicitly requested start-only/background
behavior. After `completed`, inspect the returned result and verify the actual
artifacts and relevant tests before reporting completion. Omit session mode to
use the saved `auto` or `new` default, and use `continue` with an exact
`threadId` when selecting a specific persisted session. Do not decide in
advance whether the conversation will be single-threaded or parallel. When
parallel work becomes useful, start another thread at that moment with
`sessionMode: new` and keep its returned `threadId` under the same `scopeId`.

To choose a model or reasoning effort, ask ChatGPT to call `codex_models` first.
The returned list comes from the installed Codex CLI and includes only currently
selectable models with each model's supported effort values. ChatGPT can then
pass the selected `model` and `reasoningEffort` to a new `codex_task` session.
If both are omitted, the saved card defaults are used. Model or effort
changes require `sessionMode: new`.

`codex_status({ scopeId })` lists only that conversation's recent persisted
sessions and jobs, without submitted prompt bodies. Follow the returned
`pagination.sessions` and `pagination.jobs` metadata when `hasMore` is true;
the reported `scopeCounts` are totals for that scope, not page lengths. Omitting `scopeId`
returns policy only; `includeAllScopes: true` is reserved for an explicit
bridge-wide operator audit. Auto mode selects a compatible session only when it
is the sole compatible candidate for the same scope, cwd,
sandbox, model, and effort inside the saved auto-resume window. With several
compatible sessions it returns an ambiguity error so ChatGPT can inspect the
scope and retry with the intended exact `threadId`. A copied or branched
ChatGPT conversation must use a new scope UUID. Moving an existing thread
across scopes requires its exact `threadId` and `adoptThread: true` after
explicit user intent.

The status entry `resumeAvailability: "available"` means the thread is still
bound to its active Codex MCP worker. After the bridge or worker restarts,
persisted history is retained but the entry becomes
`"unavailable-after-worker-restart"`; auto mode starts a fresh thread and exact
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
On bridge startup, any
record that had remained `running` is reported as `interrupted`; it is not left
indefinitely running. Live upstream progress refreshes `lastProgressAt`, while
`health: "no-progress-observed"` and `processLiveness: "unknown"` mean only
that no progress notification was observed inside the configured interval.
Check the repository/worktree and Codex result evidence before deciding that
such a job actually stopped. Use `codex_cancel({ scopeId, jobId })` only when
cancellation is intended; it may leave partial filesystem changes.

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
