# Security model

## Trust boundary

The bridge is designed for a single trusted operator connecting ChatGPT to a narrow local repository through OpenAI Secure MCP Tunnel. It binds to loopback and does not create a public ingress endpoint.

The tunnel transport, ChatGPT workspace policy, bridge policy, Codex sandbox, filesystem permissions, and operating-system isolation are separate layers. No one layer replaces the others.

## Exposed capabilities

- `codex_status` returns policy plus scope-filtered metadata-only session
  summaries and retained asynchronous results. An explicit operator-audit flag
  can return all scopes.
- `codex_activity` renders a scope-filtered localized Activity card. Its private
  metadata remains bounded and redacted; it is not a secret store.
- `codex_cancel` force-stops one scope-owned running job through exact App
  Server turn interruption or the tracked worker process group; partial
  filesystem changes are not rolled back.
- `codex_activity_update` performs server-validated Activity transitions,
  including whole-Activity force-stop and evidence-backed verification.
- `codex_models` returns the current selectable Codex model catalog.
- `codex_settings` returns owner limits and renders the settings card.
- `codex_update_settings` is app-only and persists validated preferences.
- `codex_task` starts or continues a tracked thread. It exposes
  `workspace-write` and `danger-full-access` only when the owner enables the
  corresponding capabilities.

The bridge does not expose a raw shell tool, process-control tool, arbitrary
Codex config, or a general Responses API proxy. An explicitly enabled
`danger-full-access` Codex session can nevertheless execute commands and access
the network as the current macOS user.

## Enforced defaults

- Loopback host binding.
- Real-path allowlist for working directories.
- Read-only sandbox.
- `on-request` approval policy.
- Thirty concurrent jobs at most.
- Concurrent sessions are allowed in one working directory, including mutating jobs.
- Overlapping mutations are coordinated by the caller or isolated with worktrees.
- One active job per Codex thread.
- Different Codex threads under the same conversation scope may run
  concurrently in the same working directory; parallelism is created on demand
  rather than configured on the scope in advance.
- HMAC-derived ChatGPT conversation scopes for automatic session routing,
  explicit UUID fallback for hosts without ChatGPT metadata, and required request
  UUIDs for retained-job retry deduplication.
- Exact-scope Activity creation/attachment and server-validated lifecycle
  transitions. Existing Activity policy cannot be changed through `codex_task`,
  and Codex output is never treated as transition authority.
- 50,000 characters per prompt.
- Six-hour automatic session-resume window and completed-job retention.
- Durable sessions, bridge preferences, jobs, bounded results, Activities,
  append-only Activity/job events, scope versions, bridge generations, and a
  completion outbox stored in one user-private transactional SQLite database
  with mode `0600`; job terminal state, Activity derived state, scope version,
  and outbox insertion commit atomically, and previously running entries become
  `interrupted` after restart.
- Saved preferences are safely reduced when owner capabilities, roots, or
  concurrency limits become narrower, with warnings exposed in status/card.
- Asynchronous, in-flight-deduplicated common secret-file filename preflight.
- Four lazy backend workers with generation-safe connection retirement,
  per-thread backend/worker affinity, and no task-execution deadline.
- Unlimited-only Codex turns: elapsed time and missing progress never create a
  terminal state. Fast return, Activity/status long-poll, model catalog, tunnel,
  and database waits remain bounded control-plane operations.
- One user-visible force-stop action with exact worker generation/process-group
  validation, TERM→KILL escalation, collateral confirmation, and terminal state
  only after exit evidence. `termination-failed` remains an active slot.
- Eight Activity watchers globally and four per conversation scope, admitted
  separately from the thirty job slots; duplicate mounted-widget leases are rejected.
- Ten-minute `no-progress-observed` threshold with process liveness explicitly
  unknown; it does not automatically cancel a job.
- At most 100 retained jobs and one MiB per retained job result by default.
- Upstream stderr disabled unless explicit local debug mode is enabled.

## Authentication

Secure Tunnel mode starts a loopback-only HTTP server with no application-level authentication. The OpenAI-managed tunnel and its organization/workspace permissions are the transport boundary. The bridge rejects no-auth mode on non-loopback host bindings.

When exposing the HTTP endpoint through another mechanism, configure a long bearer token or place an OAuth 2.1/PKCE-capable proxy in front of it. Bearer authentication is intended for controlled private deployments, not public plugin submission.

Conversation `scopeId` values are routing labels, not identities or secrets.
ChatGPT calls derive them from the anonymous organization/subject/session tuple;
raw identifiers are not stored, and a model-provided scope cannot override the
host-derived value. A compatibility/admin caller without ChatGPT session
metadata can still use explicit scopes or the bridge-wide audit view. Do not
treat scope filtering as authorization.

The HMAC key is versioned and stored in the private SQLite metadata table. The
bridge does not rotate it automatically: safe rotation requires a scope-alias
migration so existing history remains reachable. Deleting or replacing the key
without migration is a deliberate scope reset.

## Plugin approval boundary

ChatGPT's four plugin-permission choices control host-side confirmation before
an MCP tool call. They do not change the Codex sandbox. A private deployment may
set Codex approval policy to `never` so the plugin permission is the single
approval boundary, but doing so removes Codex's independent command prompt.
With the default `adaptive` strategy, the omitted/default sandbox remains
`read-only` and ChatGPT must still send an explicit mutation sandbox. A bridge
user can choose `read-only` or `always-full` in the settings card only within
owner-enabled capabilities. These preferences are shared by the bridge instance
because the private no-auth tunnel does not supply per-user identity.

## Remaining risks

- The allowed-root check constrains the starting directory, not every path Codex
  may attempt to access. In `danger-full-access`, Codex can access paths outside
  that root and use the network under the current macOS user's permissions.
- Filename scanning detects common secret files, not secret values embedded in ordinary source files.
- Mutation modes allow Codex to change files and may execute commands. Danger
  mode is not limited to the configured workspace.
- Concurrent mutation jobs in the same working directory can overwrite each
  other's changes or interfere through shared build artifacts unless the caller
  partitions the work or assigns separate worktrees.
- Result-body retention and request deduplication are separate. After the active
  job/result window expires, a redacted archived job summary keeps the scope and
  request UUID reserved; replay protection is lost only after operator removal
  or replacement of the state database.
- Host-provided `openai/session`, `openai/subject`, and `openai/organization`
  metadata is suitable for correlation, not authorization. Missing metadata
  falls back to an explicit caller-managed UUID; changes in the host identity
  tuple or loss/rotation of the locally persisted HMAC key produce a new scope.
- Enabling mutation support exposes the corresponding sandbox to the MCP caller; the bridge
  cannot independently prove that a particular call received fresh user approval.
- `codex_activity_update` is stateful and includes a destructive `cancel` action.
  The server validates scope/lifecycle, exact job versions, worker generations,
  and collateral acknowledgement, but cannot undo commands or file edits already performed. Verification
  evidence is bounded metadata supplied by the caller; it is an audit reference,
  not cryptographic proof that a test or artifact belongs only to that Activity.
- Jobs are spread across a small local Codex MCP pool. A worker-process failure
  can still affect the subset of calls assigned to that worker.
- Completion outbox claim/delivery state is transactional inside SQLite, but a
  ChatGPT `ui/message` side effect and the later local acknowledgement cannot be
  committed atomically across systems. A lost acknowledgement can therefore
  produce an at-least-once retry; the fixed prompt carries a stable bounded
  `handoffBatchId` and never embeds raw Codex output.
- Codex MCP thread context is worker-process local. Persisted session metadata
  remains visible after restart, but those rows are marked unavailable and are
  not resumed; auto mode starts a fresh thread. New App Server threads use a
  separate sticky backend with rich public events, approval/input handling,
  steering, and exact turn interruption. OpenAI currently documents the App
  Server interface as experimental, so it is not represented as a production
  stability guarantee.
- Tool results and retained jobs can contain repository content. They are
  stripped of result `_meta`, token/password/key patterns, and configured-root
  absolute prefixes, then bounded in memory and persisted to the private state
  database until their retention window expires. Redaction is defense in depth,
  not a proof that arbitrary source text contains no secret; local backup and
  filesystem-access policies should treat that database and its SQLite sidecars
  as source-sensitive.
- The 30-job setting is a bridge admission limit. The MCP host, tunnel, Codex,
  account, and machine can impose lower practical limits.
- Persisted session rows contain scope routing labels, thread ids, and local
  working-directory paths, but not prompts or results. Pre-scope records are
  migrated into a legacy scope that automatic selection ignores; obsolete v2
  task-lane labels are discarded during migration.
- Bridge metadata contains the conversation-scope HMAC key. Protect database
  files and backups even though the raw host identifiers are not stored.
- Persisted job rows contain local paths, lifecycle metadata, progress
  messages, errors, and bounded Codex results. Results can include repository
  content even though the job record does not separately store the submitted
  prompt.
- Activity and event rows contain sanitized titles, opaque scope/job/thread
  relations, state transitions, aggregate counts, and bounded handoff metadata.
  Raw prompts and private reasoning are not Activity event or outbox fields.
  Archived job rows retain deduplication and terminal facts but replace their
  original payload/result with a minimal summary.
- Persisted settings contain local paths and user defaults. They contain no
  tunnel credential, prompt, or result, but every user of the same private
  bridge connection shares them.
- No-auth loopback mode trusts other processes and users on the same Mac.
- A compromised local user account can access the same files and processes.

For sensitive code, expose a sanitized staging copy and run the bridge under a separate OS user, container, or VM with explicit filesystem and network policy.
