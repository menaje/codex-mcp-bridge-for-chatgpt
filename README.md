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
       -> codex app-server (feature-selectable rich events/controls)
  -> one or more explicitly allowed working roots
```

The official Codex MCP server already provides `codex` and `codex-reply`. This bridge exposes a smaller lifecycle-oriented surface for safer daily use from ChatGPT:

- `codex_status`: inspect exact scope/Activity/thread/turn/job state, follow opaque cursors, retrieve results, or perform a bounded job/scope watch.
- `codex_activity`: render the localized Activity card; the mounted card refreshes through `codex_status` instead of per-job polling.
- `codex_cancel`: force-stop one scope-owned job and record a terminal state only after exact turn or worker-process exit is confirmed. Partial filesystem changes may remain.
- `codex_activity_update`: apply one validated Activity lifecycle or policy transition.
- `codex_models`: read the current selectable models and supported reasoning efforts from Codex.
- `codex_settings`: render an interactive card for saved user preferences and current owner limits.
- `codex_task`: create or attach an Activity and start or continue a policy-limited Codex turn.

The cards use two additional app-only actions: `codex_update_settings` for
preferences and `codex_activity_handoff` for transactional completion delivery.
ChatGPT's model does not need to invoke either directly.

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
- [Build MCP Apps for ChatGPT](https://developers.openai.com/plugins/reference)

## Install

```bash
npm ci
npm run check
```

## Development and releases

Use `dev` as the working branch. Pushes to `dev` and pull-request updates do
not start GitHub Actions. Never merge, fast-forward, cherry-pick, or push
development work to `main` without an explicit user instruction to do so. The
single workflow runs only after an explicitly approved change reaches `main`,
where it performs the full build, test, and production dependency audit.

[`release-manifest.json`](release-manifest.json) is the canonical source for the
product name, npm package and binary names, Node/npm toolchain, GitHub
repository, SemVer version, tag prefix, release channel, generated-notes
policy, and release assets.
`package.json`, `package-lock.json`, runtime build metadata, npm archive names,
and the GitHub Release workflow consume or validate that manifest instead of
maintaining independent release values.

Before merging a release into `main`, update the manifest and synchronized npm
metadata together on `dev`:

```bash
npm run release:version -- patch
npm run release:check
npm run check
```

Use `minor`, `major`, or an exact SemVer value such as `0.4.0-beta.1` when
appropriate. Use `npm run release:sync` only to repair derived npm metadata
after an intentional manifest edit. After the `main` checks pass, the workflow
validates that the manifest names the active GitHub repository and creates the
manifest-derived tag, title, npm package tarball, and SHA-256 checksum. An
existing release is never replaced or duplicated. See
[docs/releasing.md](docs/releasing.md) for the complete contract.

### Current name and legacy runtime namespace

The current product, repository, and npm package names always include
**for ChatGPT**. A bare `codex-mcp-bridge` string in a command or path does not
refer to the current product or repository name. It is the legacy local runtime
namespace retained for existing installations only.

That compatibility namespace currently covers the `codex-mcp-bridge`
executable alias, `CODEX_MCP_BRIDGE_*` environment variables,
`~/.codex-mcp-bridge` state directory, Keychain service keys, tunnel profile,
and MCP App resource URIs. Changing it requires a separate migration of local
services, credentials, state, and cached UI resources; a repository rename
alone must not silently perform that migration.

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

Ask ChatGPT to **open the Codex MCP Bridge for ChatGPT settings**. It calls
`codex_settings` and renders an inline card where the bridge user can set:

- access strategy: `read-only`, `adaptive`, or `always-full` when the owner has
  enabled full access;
- execution model policy: one fixed exact model/effort/service-tier selection,
  or automatic selection over the live catalog or an explicit exact allowlist;
- optional preferred automatic selection and a separate Ultra/delegation gate;
- default working directory inside the owner allowlist;
- interface language: automatic host-language detection or a fixed supported
  language;
- active-job limit;
- Activity-card visibility (`always`, `background-only`, or `never`), independent
  of Codex execution mode; and
- completion handoff (`off` or opt-in automatic GPT handoff while a card remains
  mounted). Automatic handoff is unavailable when automatic card display is
  disabled.

Session routing is not a global preference. A new Activity starts a new Codex
thread; a later turn with the exact same `activityId` resumes its one compatible
attached thread with no age limit. Explicit `new`, exact `continue`, and thread
adoption remain available per call.

Codex execution is unlimited-only: no task timeout exists in the card, saved
settings, environment contract, or `codex_task`. Background calls return a
tracked job immediately; only status/card waits remain bounded control-plane
operations. Use the Activity card's single **Force stop** action when a tracked
turn or worker must be ended. The settings revision remains an internal
optimistic-concurrency token and is not displayed in the card.

Saved values are authoritative policy for turns admitted after the save. A
running turn keeps the immutable execution decision captured at admission. A
fixed interface language overrides the host locale for both Settings and Activity cards;
`auto` follows the host locale and falls back to English. `read-only` forces all
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

### Model execution policy

Call `codex_models` before presenting model or reasoning-effort choices. For an
App Server target, its `model/list` result is authoritative; the selectable
`codex debug models` catalog is the MCP Server source and App Server fallback.
Each validated snapshot records its source, timestamp, and fingerprint. A
temporary refresh failure may use the last known good snapshot and reports
`temporarily-unverified-with-last-known-good`; a fresh catalog that confirms a
selection has disappeared fails closed instead of silently choosing another
model. A CLI fallback for an unavailable App Server catalog is marked unverified:
it may keep existing execution usable, but it cannot activate a changed policy.

The saved, versioned `modelPolicy` has two modes:

- `fixed` forces one exact `selection` for every newly admitted turn. The
  GPT-visible `codex_task` schema contains no model-selection input.
- `automatic` permits an optional exact `selection` inside either an explicit
  allowlist or the current `catalog-visible` set. When omitted, the resolver
  uses the saved preferred selection and then a validated, fully materialized
  backend default.

An exact selection is one atomic nested object. Model ids, efforts, and optional
service tiers are stored and transmitted verbatim; bridge aliases such as
`sol-max` are never generated or accepted:

```json
{
  "selection": {
    "model": "gpt-5.6-sol",
    "reasoningEffort": "max"
  }
}
```

In automatic mode the current `codex_task` descriptor projects the intersection
of operator ceiling, user policy, and backend catalog as strict catalog-derived
`oneOf` choices. Runtime resolution repeats exact-pair validation, so an old
descriptor cannot bypass a newer policy. Stale revisions and invalid choices
return structured `MODEL_POLICY_CHANGED`, `MODEL_SELECTION_FORBIDDEN`, or
`MODEL_UNAVAILABLE` errors with the active revision and recovery guidance.
Catalog drift may remove individual preferred or explicit entries without
invalidating the policy while at least one exact intersection remains.

`CODEX_MCP_BRIDGE_DEFAULT_MODEL` and
`CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT` may seed one exact automatic-mode
preferred pair before the first save; both must be set together.
`CODEX_MCP_BRIDGE_MODEL_SELECTION_CEILING` is an immutable JSON array of exact
operator-permitted selections. The settings card can narrow it but cannot widen
it. Legacy JSON and SQLite default-model settings migrate to automatic,
`catalog-visible` policy instead of being silently strengthened to fixed mode.
A legacy model-only default is retained as a compatibility preference and its
exact default effort and service tier are materialized from the live catalog.

App Server applies the resolved model, effort, and optional service tier on
`turn/start`, including the next turn of the same thread, and then updates that
thread's current execution state. MCP Server can apply them only at
`thread/start`; a continuation that would change them returns
`THREAD_OVERRIDE_UNSUPPORTED` rather than ignoring the change or secretly
starting another thread. Start a deliberate `sessionMode: new` turn in that
case. Thread identity is independent of mutable execution state, while every
job, result, and status retains its complete `executionDecision` for audit.

After policy or catalog changes, the current SDK adapter requests
`notifications/tools/list_changed`, and the next `tools/list` returns the new
descriptor. An in-memory SDK smoke confirms notification delivery, while a
stateless Streamable HTTP integration smoke confirms the next request receives
the new descriptor. The ChatGPT HTTP surface has no durable subscription on which the
bridge can guarantee immediate host rediscovery, so settings report
`schemaRefreshGuaranteed: false`; reconnecting or the next host tool-list fetch
is the documented fallback. Runtime enforcement never depends on notification
delivery. The notification boundary is isolated so a future
`subscriptions/listen` adapter does not change policy logic.

## Session lifecycle

`codex_task` consolidates new and follow-up calls:

- In ChatGPT, omit `scopeId`. The bridge derives a stable opaque UUID from the
  host-provided anonymous organization, subject, and conversation session tuple
  using a private HMAC key. OpenAI defines `openai/session` as an anonymized
  conversation id for correlating calls within the same ChatGPT session. Equal
  host tuples resolve to one scope and a different session value resolves to a
  different scope; the bridge does not infer device, copy, or branch identity
  beyond those host values. MCP hosts without ChatGPT session metadata must
  provide and reuse an explicit compatibility `scopeId` instead.
- `requestId` is required. ChatGPT generates one UUID for each logical task
  call and reuses that exact value only when retrying the same arguments. The
  bridge returns the existing job/result for a duplicate and rejects reuse with
  changed arguments.
- Omit `activityId` to create one Activity for the current user intent. Reuse the
  returned exact `activityId` to group later turns or parallel threads into that
  same intent. An existing Activity accepts new jobs only while `open`; creation
  policy fields cannot be smuggled into an attachment call.
- A new Activity accepts an optional sanitized `activityTitle` (120 characters),
  `activityKind`, `executionMode`, `handoffPolicy`, and `completionTrigger`.
  Defaults are `other`, `background`, `none`, and `manual`, so a Codex response cannot
  automatically complete the user's work or change its policy.

- Omitted or `sessionMode: auto` uses Activity-managed selection. A new Activity
  starts a new thread. An existing Activity resumes only its one compatible
  attached thread, regardless of age; no compatible thread starts a new one,
  while several candidates require an exact `threadId` instead of guessing.
- `sessionMode: new` always starts with fresh conversation context.
- `sessionMode: continue` requires an exact `threadId` returned by
  `codex_status` or an earlier task result.

Execution delivery is independent of Activity completion:

- `executionMode: foreground` keeps the current tool call open until the Codex
  turn reaches a terminal state or the host/bridge connection ends.
- `executionMode: background` returns the `activityId` and `jobId` immediately.
- Omitting `executionMode` defaults to `background`. The retired `auto` mode and
  25-second fast-return threshold are no longer part of the tool contract.

Card presentation is configured separately. `always` asks ChatGPT to render the
Activity card for foreground and background turns, `background-only` only for
background turns, and `never` suppresses automatic rendering. An explicit user
request may still open `codex_activity` in every mode. A previously mounted card
can observe foreground work live; on hosts that cannot mount the first widget
during a blocking call, the first foreground card appears after the result.

In every mode, a terminal Codex job is only a child outcome. It does not by
itself mean the Activity, user request, or verification is complete.

Activity selection requires the same resolved conversation scope, working
directory, and sandbox. Model selection is mutable thread execution state, not
part of thread identity. There is no bridge-global
"most recent session" fallback, so one ChatGPT conversation cannot
accidentally auto-resume another conversation's thread. It never reuses a
workspace-write or danger-full-access session for a read-only call. The
exact Activity association, rather than recency, is authoritative. An older
attached thread can continue without an age limit only while
`resumeAvailability` remains `available` in the current worker generation.

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
Codex thread remains serialized, while different threads under one Activity or scope can
run concurrently. There is no up-front single/parallel mode: begin with the
ordinary Activity-managed thread and use `sessionMode: new` whenever parallel work becomes
useful. If the Activity's only compatible thread is busy, auto mode asks the caller to wait
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
from Activity selection, and rejected for exact continuation; the Activity
starts a fresh thread instead. New App Server threads support rich public turn events,
approval/input responses, steering, and exact turn interruption. Existing MCP
threads remain pinned to their original backend and are never silently
migrated. OpenAI currently documents App Server as experimental, so
`mcp-server` remains the conservative package default. Session rows contain only thread id,
`scopeId`, backend, cwd, sandbox, current exact selection/policy revision, and timestamps; prompts and results are
not written to them. Existing `sessions.json` records are imported once;
pre-scope records are migrated to a quarantined
legacy scope that is never auto-selected; older task-lane records are collapsed
into ordinary sessions under their existing scope. Legacy sessions require an
exact thread handoff. Background tasks return a `jobId` immediately; retrieve the result with
`codex_status({ jobId })` in ChatGPT, or use
`codex_status({ jobId, waitFor: "terminal", waitMs: 55000 })` to hold one
bounded status call until completion, failure, interruption, or the wait
expires. `waitFor: "change"` returns on the next upstream progress or terminal
transition. A wait timeout leaves the job running and can be repeated; it is
not a Codex task timeout. `codex_cancel({ jobId })` is a single force-stop
operation: exact App Server `turn/interrupt` is attempted first, otherwise the
tracked worker generation's detached process group receives TERM and then KILL
automatically if needed. The bridge records `cancelled` only after exit is
confirmed; shared-worker collateral becomes `interrupted`, and an unconfirmed
exit stays active as `termination-failed`. Callers must inspect the working
tree because edits made before interruption are not rolled back.

ChatGPT tool calls automatically receive their current host-derived scope even
when `scopeId` is omitted. A non-ChatGPT host with neither metadata nor an
explicit compatibility scope receives policy-only status. `includeAllScopes`
is rejected for ChatGPT conversation calls and remains a compatibility/admin
operation for trusted hosts without ChatGPT session metadata.

Job metadata and bounded results are stored transactionally in
`~/.codex-mcp-bridge/state.sqlite` with mode `0600` by default. Schema v3 also
stores conversation scopes, Activity lifecycle rows, Activity/job events,
scope-wide change versions, bridge process generations, and an idempotent
completion outbox. Existing schema-v1 jobs are migrated atomically into one-job
legacy Activities without changing their scope, request-deduplication key, or
thread relation. Current `codex_task` calls create an Activity or attach to an
exact open Activity with safe defaults: `kind=other`, `executionMode=background`,
`handoffPolicy=none`, and `completionTrigger=manual`. Consequently, a terminal
Codex turn does not by itself mark a user Activity completed or enqueue an
automatic handoff.

`codex_activity_update` is the single Activity mutation surface. It supports
`seal`, `complete`, `abandon`, `cancel`, `start-verification`,
`verification-passed`, `verification-failed`, and `set-policy`. The server
rejects illegal transitions, cross-scope IDs, empty seals, completion with live
children, stale optional `expectedVersion` values, and verification success
without bounded evidence. `cancel` force-stops every exact active child
turn/worker set, but never rolls back filesystem changes. A failed verification reopens the Activity for rework;
a successful evidence-backed verification is what completes a `verify`
Activity. Policy and completion mutations come only from explicit tool input—
never from fields or instructions contained in a Codex result.

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
tracked. The localized Activity card is available now. It shows prioritized
Activity state, public progress, approvals/input, unread completion,
verification, and per-job/whole-Activity force-stop controls. One scope-wide
version watcher per mounted widget is admitted independently from the 30 job
slots, with bounded wait, host cancellation, backoff, jitter, and a
manual-refresh fallback. The transactional outbox leases one completion batch
to one mounted card, atomically acknowledges or releases the whole batch, and
sends only a fixed template with Activity/job IDs—not raw Codex output—to the
GPT handoff. The stable `handoffBatchId` lets the conversation recognize a
retry if the host accepted the message but the delivery acknowledgement was
lost; an external UI message and a local SQLite commit cannot be made one
distributed exactly-once transaction.

The default card preference is `always`, while completion handoff defaults to
`off`. Card rendering never changes execution mode, Activity/thread continuity,
or whether a Codex turn is considered complete. Legacy `auto` execution rows
are normalized to `background`; legacy completion delivery maps to the two new
independent settings during startup.

For a user request that asks for a finished outcome, a running `jobId` is only
an intermediate response. The plugin instructions tell ChatGPT to wait for a
terminal state, inspect the result, verify the requested artifacts and relevant
tests, and only then give its final completion answer. An immediate final answer
with a running `jobId` is reserved for explicit start-only or background-work
requests.

### macOS Keychain

The service strings below are legacy runtime keys used by existing
installations; they are not the repository or product name.

```bash
security add-generic-password -a "$USER" -s "codex-mcp-bridge:control-plane-api-key" -w "<runtime-key>" -U
security add-generic-password -a "$USER" -s "codex-mcp-bridge:control-plane-tunnel-id" -w "tunnel_..." -U

CODEX_MCP_BRIDGE_ROOT=/absolute/path/to/repository npm run bridge:secure:keychain
```

Use `bridge:secure:write:keychain` only for an intentional write session.

## Configuration

`CODEX_MCP_BRIDGE_*` is the stable legacy configuration namespace. The current
product and package name remains **Codex MCP Bridge for ChatGPT**.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_MCP_BRIDGE_HOST` | `127.0.0.1` | HTTP bind host; no-auth mode rejects non-loopback values |
| `CODEX_MCP_BRIDGE_PORT` | `8765` | Direct-server port; the bundled local/secure launcher defaults to `8876` |
| `CODEX_MCP_BRIDGE_TOKEN` | unset | Optional bearer token; required unless loopback-only no-auth mode is enabled |
| `CODEX_MCP_BRIDGE_NO_AUTH` | unset | Set to `1` only for a loopback endpoint or Secure MCP Tunnel transport boundary |
| `CODEX_MCP_BRIDGE_ALLOWED_HOSTS` | unset | Optional comma-separated HTTP Host allowlist; the launcher sets loopback hosts |
| `CODEX_MCP_BRIDGE_CODEX` | `codex` | Codex CLI executable path or command |
| `CODEX_MCP_BRIDGE_ROOTS` | current directory | Comma-separated absolute allowed roots |
| `CODEX_MCP_BRIDGE_DEFAULT_SANDBOX` | `read-only` | `read-only`, `workspace-write`, or `danger-full-access`; the matching capability must be enabled |
| `CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY` | `adaptive` | Initial card strategy: `read-only`, `adaptive`, or `always-full`; the last value requires full-access capability |
| `CODEX_MCP_BRIDGE_ALLOW_WRITE` | unset | Must be `1` before write mode is accepted |
| `CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS` | unset | Must be `1` before danger-full-access is accepted |
| `CODEX_MCP_BRIDGE_APPROVAL_POLICY` | `on-request` | `untrusted`, `on-request`, or `never` |
| `CODEX_MCP_BRIDGE_DEFAULT_MODEL` | unset | Optional exact automatic-policy preferred model seed; requires the effort seed below |
| `CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT` | unset | Optional exact automatic-policy preferred effort seed; requires the model seed above |
| `CODEX_MCP_BRIDGE_MODEL_SELECTION_CEILING` | unset | Immutable JSON array of owner-permitted exact model/effort/optional-service-tier selections |
| `CODEX_MCP_BRIDGE_MODEL_CATALOG_CACHE_TTL_MS` | `600000` | Time to cache a successful dynamic Codex model catalog |
| `CODEX_MCP_BRIDGE_MODEL_CATALOG_TIMEOUT_MS` | `30000` | Timeout for refreshing the Codex model catalog |
| `CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE` | `~/.codex-mcp-bridge/models.json` | Private last-successful model catalog fallback |
| `CODEX_MCP_BRIDGE_STATE_DATABASE_FILE` | `~/.codex-mcp-bridge/state.sqlite` | Primary private transactional settings/session/job store |
| `CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE` | `~/.codex-mcp-bridge/settings.json` | Legacy settings JSON imported once when present |
| `CODEX_MCP_BRIDGE_SESSION_STATE_FILE` | `~/.codex-mcp-bridge/sessions.json` | Legacy session JSON imported once when present |
| `CODEX_MCP_BRIDGE_JOB_STATE_FILE` | `~/.codex-mcp-bridge/jobs.json` | Legacy job JSON imported once when present |
| `CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS` | `30` | Owner maximum and initial saved active Codex-call limit |
| `CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE` | `4` | Lazy Codex MCP worker pool; cannot exceed the active-job limit |
| `CODEX_MCP_BRIDGE_DEFAULT_BACKEND` | `mcp-server` | Backend for new threads: stable `mcp-server` or experimental `app-server`; each thread remains sticky |
| `CODEX_MCP_BRIDGE_MAX_PROMPT_CHARS` | `50000` | Maximum prompt length per tool call |
| `CODEX_MCP_BRIDGE_JOB_TTL_MS` | `21600000` | Completed job retention |
| `CODEX_MCP_BRIDGE_JOB_STALE_AFTER_MS` | `600000` | No-progress interval before a running job is labeled no-progress-observed; this does not establish process liveness |
| `CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS` | `100` | Maximum running/terminal job records retained in memory and durable state |
| `CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES` | `1048576` | Maximum retained serialized result size per job |
| `CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN` | unset | Explicitly bypass filename preflight |
| `CODEX_MCP_BRIDGE_DEBUG` | unset | Emit local diagnostic errors and Codex stderr |

`CODEX_MCP_BRIDGE_DEFAULT_SESSION_MODE` and
`CODEX_MCP_BRIDGE_AUTO_RESUME_TTL_MS` are retired and ignored. During migration,
their presence produces a startup warning but cannot change Activity-managed
session routing.

`CODEX_MCP_BRIDGE_FAST_RETURN_MS` is also retired and ignored for one migration
release. Its presence produces a startup warning; use explicit `foreground` or
`background` execution instead.

These are package defaults. A local launcher or LaunchAgent may deliberately
override them—for example, an installation may select `app-server` while the
portable package keeps the conservative `mcp-server` default. Inspect
`codex_status` to confirm the effective policy and backend of a running bridge.

The retired `CODEX_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS` variable is ignored for one
compatibility release and emits an operator warning. Remove it from service
definitions; it cannot re-enable a finite Codex task deadline.

The deprecated pre-fork `CODEX_GPT_BRIDGE_*` variable prefix is accepted only
as a temporary compatibility fallback.

`npm run build` validates the release manifest, then writes a source fingerprint and version record to
`dist/build-info.json`. The launcher verifies that fingerprint even with
`--no-build` and rebuilds stale output instead of silently running old code.
Both `/healthz` and `codex_status` expose the active build record so the source
and running service can be compared directly.

## ChatGPT setup

See [docs/chatgpt-setup.md](docs/chatgpt-setup.md).

## Upstream

Historical upstream attribution and the original third-party repository name
are isolated in [UPSTREAM.md](UPSTREAM.md); they are not names for this project.
