# codex-mcp-bridge

A small policy layer between ChatGPT and the official local Codex MCP server.

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> codex-mcp-bridge (loopback HTTP)
  -> codex mcp-server (stdio)
  -> one or more explicitly allowed working roots
```

The official Codex MCP server already provides `codex` and `codex-reply`. This bridge exposes a smaller lifecycle-oriented surface for safer daily use from ChatGPT:

- `codex_status`: inspect policy, scope-filtered durable sessions and jobs, or wait for one long-running job to change or finish.
- `codex_cancel`: cancel one running job in its owning conversation scope. Partial filesystem changes may remain.
- `codex_models`: read the current selectable models and supported reasoning efforts from Codex.
- `codex_settings`: render an interactive card for saved user preferences and current owner limits.
- `codex_task`: start or continue a policy-limited Codex session.

The settings card uses one additional app-only action, `codex_update_settings`,
which ChatGPT's model does not need to invoke directly.

## Security defaults

- Binds to `127.0.0.1`.
- Allows one current working directory unless roots are explicitly configured.
- Uses the `read-only` Codex sandbox.
- Uses the `on-request` approval policy.
- Does not expose `workspace-write` or `danger-full-access` unless the bridge
  owner explicitly enables those capabilities.
- Rejects paths outside the configured real-path roots.
- Refuses repositories containing common secret-file names unless the owner explicitly disables the preflight.
- Limits prompt size and concurrent Codex jobs.
- Suppresses upstream Codex stderr unless local debug logging is enabled.
- Stores settings, session metadata, jobs, and bounded results in one private
  transactional SQLite database and revalidates every saved value
  against owner-enforced capabilities and limits.

These controls are a policy layer, not OS-level isolation. Use a staging copy, container, VM, or separate OS user when hard isolation is required.

## Requirements

- Node.js 22 or later.
- Codex CLI installed, authenticated, and providing `codex mcp-server`.
- `tunnel-client` and an OpenAI Secure MCP Tunnel for ChatGPT access.

Official references:

- [Run Codex as an MCP server](https://developers.openai.com/codex/mcp/)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## Install

```bash
npm ci
npm run check
```

## Local smoke test

Local mode never creates a public endpoint:

```bash
npm run bridge:local -- --root /absolute/path/to/repository
```

The MCP endpoint is `http://127.0.0.1:8876/mcp` and the health endpoint is `http://127.0.0.1:8876/healthz`.

## Secure MCP Tunnel

Create a tunnel in OpenAI Platform, then provide its runtime credentials outside this repository:

```bash
export CONTROL_PLANE_API_KEY="<runtime-key>"
export CONTROL_PLANE_TUNNEL_ID="tunnel_..."

npm run bridge:secure -- --root /absolute/path/to/repository
```

The launcher builds the bridge, starts it on loopback, initializes the tunnel profile, runs `tunnel-client doctor`, and keeps the tunnel client running.

For a deliberate write session:

```bash
npm run bridge:secure -- --root /absolute/path/to/repository --write
```

Do not leave a write profile running when it is not needed.

For an approval-gated workflow that stays read-only by default but permits an
explicit `workspace-write` request:

```bash
npm run bridge:secure -- --root /absolute/path/to/repository --allow-write
```

To keep `read-only` as the default while making both mutation sandboxes
available to an authorized MCP caller:

```bash
npm run bridge:secure -- --root /absolute/path/to/projects --allow-full-access
```

`--allow-full-access` does not change the initial adaptive/read-only behavior. It adds
`workspace-write` and `danger-full-access` to `codex_task` so ChatGPT can select
one for a concrete user-authorized change or build request and makes the
`always-full` card strategy available.

### Interactive settings card

Ask ChatGPT to **open the MacBook Air Codex Bridge settings**. It calls
`codex_settings` and renders an inline card where the bridge user can set:

- access strategy: `read-only`, `adaptive`, or `always-full` when the owner has
  enabled full access;
- default Codex model and its supported reasoning effort from the live Codex
  catalog;
- default working directory inside the owner allowlist;
- default session behavior (`auto` or `new`) and automatic-resume window;
- default task inactivity timeout and active-job limit, within owner maxima.

Saved values are authoritative defaults for later calls. `read-only` forces all
new work to read-only even if a caller asks for more permission. `adaptive`
keeps the current GPT-selected behavior. `always-full` forces new work to
`danger-full-access`; an older session with a different sandbox must be replaced
with a new compatible session.

The card cannot change allowed roots, capability gates, approval policy, tunnel
credentials, secret scanning, or process-level hard limits. Settings are global
to this bridge instance—not per ChatGPT account—because the no-auth private
tunnel connection does not provide an end-user identity to the bridge. They are
stored in `~/.codex-mcp-bridge/state.sqlite` with mode `0600` by default.

### ChatGPT plugin permissions and Codex permissions

ChatGPT's plugin settings provide the four host-level choices shown in the UI:
always confirm, allow read actions, allow low-risk actions, and allow all
actions. Those choices control whether ChatGPT asks before invoking the MCP
tool. They do not directly select a Codex sandbox.

In the default `adaptive` strategy, the `sandbox` passed to `codex_task`
controls the Codex process itself:

- Omitted or `read-only`: inspect without modifying files.
- `workspace-write`: mutate within Codex's workspace sandbox.
- `danger-full-access`: unrestricted local filesystem and network access under
  the current macOS user.

When ChatGPT plugin permissions are the intended outer approval boundary, the
bridge can use `CODEX_MCP_BRIDGE_APPROVAL_POLICY=never` to avoid a second Codex
approval prompt. Use this only with a trusted, private plugin connection. With
the plugin set to allow all actions, authorized mutation calls can then run
without another confirmation. With the plugin set to always confirm, ChatGPT
still asks before the MCP call.

Call `codex_models` before presenting model or reasoning-effort choices. It
loads the current catalog with `codex debug models`, filters it to selectable
entries, and caches the result briefly. Model ids and reasoning-effort values
are intentionally not hard-coded into the MCP schema, so a normal Codex model
catalog update does not require a bridge or plugin schema update. The last
successful catalog is also stored privately so a temporary CLI catalog failure
after a restart can fall back to a validated stale result.

`codex_task` accepts optional exact `model` and `reasoningEffort` values when
starting a new session. Set the saved defaults in `codex_settings`; the
`CODEX_MCP_BRIDGE_DEFAULT_MODEL` and
`CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT` variables seed those values before
the first save. The bridge validates the pair against the
current catalog and forwards the effort through Codex's
`model_reasoning_effort` config. Use `sessionMode: new` to change model or
effort because continued Codex threads keep their original configuration.

## Session lifecycle

`codex_task` consolidates new and follow-up calls:

- In ChatGPT, omit `scopeId`. The bridge derives a stable opaque UUID from the
  host-provided anonymous organization, subject, and conversation session tuple
  using a private HMAC key. A copied or branched conversation receives a new
  host session automatically. MCP hosts without ChatGPT session metadata must
  provide and reuse an explicit compatibility `scopeId` instead.
- `requestId` is required. ChatGPT generates one UUID for each logical task
  call and reuses that exact value only when retrying the same arguments. The
  bridge returns the existing job/result for a duplicate and rejects reuse with
  changed arguments.

- `sessionMode: auto` continues the only compatible session in the conversation
  scope, or starts a new one when no compatible recent session exists. If
  several compatible sessions exist, it requires an exact `threadId` instead of
  guessing.
- `sessionMode: new` always starts with fresh conversation context.
- `sessionMode: continue` requires an exact `threadId` returned by
  `codex_status` or an earlier task result.

When `sessionMode` is omitted, the saved `auto` or `new` preference is used.

Auto selection requires the same resolved conversation scope, working directory, sandbox, and
requested/default model and effort. There is no bridge-global
"most recent session" fallback, so one ChatGPT conversation cannot
accidentally auto-resume another conversation's thread. It never reuses a
workspace-write or danger-full-access session for a read-only call. The
auto-resume window defaults to six hours. Exact continuation can use an older
persisted thread only while `resumeAvailability` remains `available` in the
current worker generation.

An exact thread also remains owned by its scope. Moving it to another
conversation requires `threadId` plus `adoptThread: true`, and
should be done only after the user explicitly requests that handoff. When host
metadata is present, it is authoritative and any input `scopeId` is ignored.
Raw host identifiers are never stored; only the HMAC-derived UUID is persisted.
The version-1 HMAC key is generated once in the private state database. It is
not rotated automatically because changing it without a scope-alias migration
would disconnect existing session/job history; key rotation therefore requires
an explicit state migration or a deliberate state reset.
Pre-upgrade model-generated scopes are not automatically merged into a derived
scope, because trusting a caller-provided migration target would defeat the new
isolation boundary. Their retained history remains available to a trusted
compatibility/admin audit until normal retention removes it.
Scope UUIDs remain routing labels, not authentication credentials; every caller
that can reach this private bridge still shares the same operator trust boundary.

Sessions may run concurrently in the same working directory up to the saved
active-job limit, which cannot exceed `CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS`.
This includes `workspace-write` and `danger-full-access` jobs. The same
Codex thread remains serialized, while different threads under one scope can
run concurrently. There is no up-front single/parallel mode: begin with the
ordinary session and use `sessionMode: new` whenever parallel work becomes
useful. If the only compatible thread is busy, auto mode asks the caller to wait
or deliberately start another thread. The caller is responsible for
partitioning overlapping mutations or assigning separate worktrees when
isolation is needed.
Each new thread is pinned to the Codex MCP worker that created it, so a later
reply is routed back to that same worker even when other pool workers are idle.
The owner maximum is a bridge-side admission limit, not a guarantee that the
ChatGPT host, tunnel, local Codex process, or machine can sustain that many
simultaneous calls. The secure launcher sets the tunnel's active MCP request and
control-plane buffer limits to the same value.

An allowed root may contain multiple repositories. Pass the exact repository or
worktree path as `cwd`. Git worktree creation and task partitioning remain
ordinary instructions for ChatGPT/Codex to decide for each job rather than a
separate MCP management tool.

Session metadata is stored in `~/.codex-mcp-bridge/state.sqlite` by default so
the bridge can restore routing history after a restart. A `codex mcp-server`
thread itself belongs to the worker process that created it and cannot be
continued after that worker or the bridge restarts. Restored rows are therefore
shown with `resumeAvailability: "unavailable-after-worker-restart"`, excluded
from automatic selection, and rejected for exact continuation; `auto` starts a
fresh thread instead. Durable turn resumption across worker generations requires
the planned Codex App Server backend. Session rows contain only thread id,
`scopeId`, cwd, sandbox, model/effort, and timestamps; prompts and results are
not written to them. Existing `sessions.json` records are imported once;
pre-scope records are migrated to a quarantined
legacy scope that is never auto-selected; older task-lane records are collapsed
into ordinary sessions under their existing scope. Legacy sessions require an
exact thread handoff. Long-running tasks return a `jobId`; retrieve the result with
`codex_status({ jobId })` in ChatGPT, or use
`codex_status({ jobId, waitFor: "terminal", waitMs: 55000 })` to hold one
bounded status call until completion, failure, interruption, or the wait
expires. `waitFor: "change"` returns on the next upstream progress or terminal
transition. A wait timeout leaves the job running and can be repeated; it is
not a Codex task timeout. Call `codex_cancel({ jobId })` to request
cancellation. The bridge forwards an abort signal and records `cancelled`
idempotently, but callers must inspect the working tree because edits made
before cancellation are not rolled back.

ChatGPT tool calls automatically receive their current host-derived scope even
when `scopeId` is omitted. A non-ChatGPT host with neither metadata nor an
explicit compatibility scope receives policy-only status. `includeAllScopes`
is rejected for ChatGPT conversation calls and remains a compatibility/admin
operation for trusted hosts without ChatGPT session metadata.

Job metadata and bounded results are stored transactionally in
`~/.codex-mcp-bridge/state.sqlite` with mode `0600` by default. Schema v2 also
stores conversation scopes, Activity lifecycle rows, Activity/job events,
scope-wide change versions, bridge process generations, and an idempotent
completion outbox. Existing schema-v1 jobs are migrated atomically into one-job
legacy Activities without changing their scope, request-deduplication key, or
thread relation. New job-only calls use the same compatibility Activity with
safe defaults: `kind=other`, `executionMode=auto`, `handoffPolicy=none`, and
`completionTrigger=manual`. Consequently, a terminal Codex turn does not by
itself mark a user Activity completed or enqueue an automatic handoff.

Completed and failed results remain retrievable across bridge restarts. A job
that was still running when the bridge stopped is changed to `interrupted` at
startup because the new process cannot safely claim the former upstream
request; its Activity records the interruption and waits for orchestrator
judgment instead of reporting success. While a job is live, upstream MCP
progress updates refresh `lastProgressAt`. No observed progress for ten minutes
produces `health: "no-progress-observed"` together with
`processLiveness: "unknown"`; absence of an MCP progress event is not proof that
Codex stopped, so callers should inspect actual work evidence before waiting
longer or cancelling.

The in-memory/status view retains at most 100 jobs for six hours and one MiB per
result by default. When that result-retention window expires, the result body is
removed from the active registry while a minimal archived job summary,
Activity counts, events, scope version, and any unread completion-outbox record
remain durable. This preserves completion facts and request UUID deduplication
without retaining repository result content indefinitely. Oversized results are
replaced earlier by a bounded completion notice while their session id remains
tracked. Activity create/attach/update tools and the Activity card are delivered
in later #14 phases; schema v2 is their transactional foundation.

For a user request that asks for a finished outcome, a running `jobId` is only
an intermediate response. The plugin instructions tell ChatGPT to wait for a
terminal state, inspect the result, verify the requested artifacts and relevant
tests, and only then give its final completion answer. An immediate final answer
with a running `jobId` is reserved for explicit start-only or background-work
requests.

### macOS Keychain

```bash
security add-generic-password -a "$USER" -s "codex-mcp-bridge:control-plane-api-key" -w "<runtime-key>" -U
security add-generic-password -a "$USER" -s "codex-mcp-bridge:control-plane-tunnel-id" -w "tunnel_..." -U

CODEX_MCP_BRIDGE_ROOT=/absolute/path/to/repository npm run bridge:secure:keychain
```

Use `bridge:secure:write:keychain` only for an intentional write session.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_MCP_BRIDGE_ROOTS` | current directory | Comma-separated absolute allowed roots |
| `CODEX_MCP_BRIDGE_DEFAULT_SANDBOX` | `read-only` | `read-only`, `workspace-write`, or `danger-full-access`; the matching capability must be enabled |
| `CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY` | `adaptive` | Initial card strategy: `read-only`, `adaptive`, or `always-full`; the last value requires full-access capability |
| `CODEX_MCP_BRIDGE_ALLOW_WRITE` | unset | Must be `1` before write mode is accepted |
| `CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS` | unset | Must be `1` before danger-full-access is accepted |
| `CODEX_MCP_BRIDGE_APPROVAL_POLICY` | `on-request` | `untrusted`, `on-request`, or `never` |
| `CODEX_MCP_BRIDGE_DEFAULT_MODEL` | unset | Optional default Codex model id; individual initial calls may override it |
| `CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT` | unset | Optional default effort; must be supported by the selected model |
| `CODEX_MCP_BRIDGE_MODEL_CATALOG_CACHE_TTL_MS` | `600000` | Time to cache a successful dynamic Codex model catalog |
| `CODEX_MCP_BRIDGE_MODEL_CATALOG_TIMEOUT_MS` | `30000` | Timeout for refreshing the Codex model catalog |
| `CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE` | `~/.codex-mcp-bridge/models.json` | Private last-successful model catalog fallback |
| `CODEX_MCP_BRIDGE_STATE_DATABASE_FILE` | `~/.codex-mcp-bridge/state.sqlite` | Primary private transactional settings/session/job store |
| `CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE` | `~/.codex-mcp-bridge/settings.json` | Legacy settings JSON imported once when present |
| `CODEX_MCP_BRIDGE_SESSION_STATE_FILE` | `~/.codex-mcp-bridge/sessions.json` | Legacy session JSON imported once when present |
| `CODEX_MCP_BRIDGE_JOB_STATE_FILE` | `~/.codex-mcp-bridge/jobs.json` | Legacy job JSON imported once when present |
| `CODEX_MCP_BRIDGE_DEFAULT_SESSION_MODE` | `auto` | Initial card default for omitted session mode: `auto` or `new` |
| `CODEX_MCP_BRIDGE_AUTO_RESUME_TTL_MS` | `21600000` | Initial saved idle window for automatic recent-session reuse; explicit continuation is still allowed |
| `CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS` | `30` | Owner maximum and initial saved active Codex-call limit |
| `CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE` | `4` | Lazy Codex MCP worker pool; cannot exceed the active-job limit |
| `CODEX_MCP_BRIDGE_MAX_PROMPT_CHARS` | `50000` | Maximum prompt length per tool call |
| `CODEX_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS` | `10800000` | Owner maximum and initial saved Codex MCP inactivity timeout, capped at three hours; progress notifications reset it |
| `CODEX_MCP_BRIDGE_FAST_RETURN_MS` | `25000` | Delay before returning a job ID |
| `CODEX_MCP_BRIDGE_JOB_TTL_MS` | `21600000` | Completed job retention |
| `CODEX_MCP_BRIDGE_JOB_STALE_AFTER_MS` | `600000` | No-progress interval before a running job is labeled no-progress-observed; this does not establish process liveness |
| `CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS` | `100` | Maximum running/terminal job records retained in memory and durable state |
| `CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES` | `1048576` | Maximum retained serialized result size per job |
| `CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN` | unset | Explicitly bypass filename preflight |
| `CODEX_MCP_BRIDGE_DEBUG` | unset | Emit local diagnostic errors and Codex stderr |

The old `CODEX_GPT_BRIDGE_*` variable prefix is accepted temporarily for upstream compatibility.

`npm run build` writes a source fingerprint and version record to
`dist/build-info.json`. The launcher verifies that fingerprint even with
`--no-build` and rebuilds stale output instead of silently running old code.
Both `/healthz` and `codex_status` expose the active build record so the source
and running service can be compared directly.

## ChatGPT setup

See [docs/chatgpt-setup.md](docs/chatgpt-setup.md).

## Upstream

This repository is derived from [DeepCogNeural/codex-gpt-bridge](https://github.com/DeepCogNeural/codex-gpt-bridge) under the MIT License. See [UPSTREAM.md](UPSTREAM.md) for the scope of this fork.
