# Codex MCP Bridge for ChatGPT security model

## Trust boundary

The bridge is designed for a single trusted operator connecting ChatGPT to explicitly registered local project folders through OpenAI Secure MCP Tunnel. It binds to loopback and does not create a public ingress endpoint.

The tunnel transport, ChatGPT workspace policy, bridge policy, Codex sandbox, filesystem permissions, and operating-system isolation are separate layers. No one layer replaces the others.

## Exposed capabilities

- `codex_status` publishes one optional discriminated `query` for an exact
  job/Activity/thread detail, bounded job wait, or cursor page; omission returns
  the scoped overview. Only an exact completed Job item can expose the bounded
  model-authoritative `answer`; summary queries expose exact-Job retrieval actions
  and never answer bodies. The expired flat query envelope is rejected. Explicit
  compatibility scope and the all-scope operator audit remain runtime-only.
- `codex_dashboard` is an explicit read-only cross-scope view for the bridge's
  single trusted user; it needs no separate operator flag. Its model-visible
  result contains only a redacted aggregate summary, while bounded app-private
  metadata contains opaque hashed row, conversation, and project correlation keys,
  compatibility conversation aliases, user-defined project labels, display Agent names, optional Activity titles,
  Codex-runtime status, timestamps, and background-process counts. An App Server
  non-ephemeral App Server row may contain a `codex://threads/<uuid>` candidate
  used by **Open in Codex** only when the selected thread has an exact matching
  retained tracked session. That matching session's creation-time visibility
  bit is retained; only a legacy matching session without the bit falls back to
  the current preference. The exact thread UUID is preferred over the matching
  session-tree UUID because forks can share the latter. For a UUID-shaped ChatGPT
  session value only, the row may separately contain a best-effort
  `https://chatgpt.com/c/<uuid>` candidate used by **Open conversation**; this orchestration
  link is independent of Codex-app visibility, while the host
  contract does not guarantee that correlation value is navigable. Neither raw
  identifier is printed as text, but each route necessarily contains its UUID.
  Rows may additionally expose only
  the associated retained Job's effective model/reasoning-effort selection and
  an evidence-backed runtime model reroute; this presentation metadata does not
  affect status. Outside those narrowly validated route targets, raw project,
  Job, Activity, Agent, thread, worker, and process IDs; paths; prompts; results;
  events; errors; and diagnostics are not projected. User-defined project, Agent,
  and Activity display text can still
  disclose task context across conversations, so the Dashboard must remain on
  this single-user trust boundary. Status is derived only from Codex Job state,
  worker liveness, Agent lifecycle, Codex-originated input/approval interactions,
  and bounded read-only App Server runtime probes—not Activity verification,
  waiting, handoff, or GPT goal judgment. “All conversations” means scopes still
  known from retained bridge state, not the account's complete ChatGPT history.
  Ordinary Job pruning retains only a result-free Dashboard summary: terminal
  status/update time, optional start time, and exact effective selection/reroute
  when known. Prompt, result, error, command, and event bodies are omitted; older
  summaries without these additive fields remain explicitly unknown. The view
  reads at most 10,000 such summaries and sends at most 12 older turns per
  visible Agent.
  The public card-open call defers runtime probes; a mounted snapshot probes at
  most 100 recently updated App Server Agents, including Agents without a
  retained latest Job only when a non-loading thread probe is available, with
  a 1.5-second per-Agent timeout and nine-second total budget. It
  reports unknown and skipped counts and does not load a `notLoaded` historical
  thread merely for the overview. App-only
  `codex_dashboard_snapshot` requires a mounted widget correlation ID but grants
  no watcher, completion-handoff, or control lease and exposes no mutation.
  Web and desktop hosts can omit `openai/session` on an app-initiated remount;
  because this projection is already bridge-wide and limited to the single-user
  connection, missing scope metadata does not block mounted recovery. Any host
  or explicit compatibility scope that is supplied is still validated. That
  widget UUID is correlation evidence rather than authentication. A hydrated
  card keeps its last snapshot after refresh failure and stops automatic retry
  until an explicit refresh; a timed-out standard call that was already
  dispatched is never duplicated through the compatibility alias.
- `codex_task` is execution-only, has no UI binding or presentation input, and
  exposes a delivered foreground result through a bounded structured `answer`.
  After any number of Task calls, one dedicated `codex_activity` compact-monitor
  call may mount a card according to the saved visibility policy; this structural
  boundary prevents per-Agent card shells. The widget obtains its feed through
  the app-private `codex_activity_snapshot` contract, which establishes or renews
  an exact Activity/generation/presentation lease correlated to the mounted widget
  session. Compact snapshots contain only current/action-needed Activity rows plus
  exact terminal/idle counts; default full-history `codex_activity` explicitly
  opens the scoped, cursor-paginated full view. Its
  private metadata remains bounded and redacted; rendered rows omit Agent/job/thread
  IDs, expose each Agent's current or latest effective model/effort selection, and
  show only final folder names when multiple projects must be distinguished, never
  full working paths.
- `codex_activity_rehydrate` is app-private and read-only. A cold-remounted
  retained pre-decoupling Task shell may submit its public `jobId + requestId`
  only as lookup hints; the bridge
  derives the host conversation scope and revalidates the retained logical call,
  linked Activity, visibility setting, mounted widget, and elected sibling. The
  result is one-shot historical state with no watcher, handoff ownership, card
  lease, controls, automatic-presentation mutation, or newly persisted bootstrap.
- `codex_cancel` requires a logical cancellation UUID and exact Job version,
  then records a durable scope-owned intent before exact App Server turn
  interruption or tracked worker-process termination. Exact retries replay the
  recorded result; reusing the UUID with another payload is a conflict. Partial
  filesystem changes are not rolled back.
- `codex_activity_update` publishes one exact-version discriminated operation
  for non-cancelling lifecycle, policy, and evidence-backed verification
  transitions. It is not annotated destructive. Expired flat lifecycle and
  cancellation fields are rejected.
- `codex_activity_cancel` is the separately annotated destructive whole-Activity
  force-stop. It requires a replay UUID, exact Activity version, scope ownership,
  and the complete affected-job acknowledgement when workers are shared. Its
  parent Activity intent is recorded before `activity-terminating`; every child
  Job intent is linked by parent/cascade correlation before child cancellation,
  and `activity-cancelled` is written only after all children are terminal.
- `codex_activity_job_cancel` is an app-private destructive surface used by the
  Activity card instead of public `codex_cancel`. It requires a widget-instance
  proof, current card generation and presentation, live lease, exact Job
  version, idempotency UUID, target ownership, and shared-worker acknowledgement.
  Stale and superseded cards fail closed before intent creation or interruption.
- `codex_steer` is the separate model-visible, destructive, replay-safe surface
  for adding bounded input to one exact active App Server root turn. Its public
  schema contains only `requestId`, `jobId`, `expectedJobVersion`, and `prompt`;
  conversation scope and the Job's Activity, Agent, current thread, and active
  turn are derived and revalidated by the server immediately before dispatch.
  It rejects MCP Server Jobs, stale versions, inactive or terminating Jobs,
  cross-scope roots, and missing positive active-turn evidence. It never queues
  input for an idle or terminal Agent, addresses an internal Codex subagent,
  resolves an interaction, records an approval, changes execution or Activity
  policy, or substitutes for cancellation.
- `codex_interaction_respond` and `codex_job_steer` remain app-private and require
  an active exact card lease plus exact scope, Job, Activity, Agent, and optimistic
  Job-version ownership. Their request UUIDs are idempotent; interaction resolution
  is additionally serialized by Job and interaction ID so concurrent requests
  cannot send two responses. Raw answers and steering prompts are reduced to hashes
  for replay identity and are not persisted in mutation results.
- `codex_activity_handoff` exposes batch operations only to the current card and
  requires the exact newest automatic presentation lease and nested card proof.
  Single-item and flat presentation inputs are rejected.
- `codex_agent` publishes one discriminated `operation` containing only
  idempotent scope-local Agent rename/archive/restore behavior. Expired flat
  fields are rejected; it never permanently deletes an Agent or rolls back files.
- `codex_background_process_terminate` is app-private and destructive. It
  requires a host-correlated mounted-card lease plus exact Activity generation,
  presentation, Agent version, current App Server thread, and freshly listed
  process ownership; it rejects an active/waiting Codex turn.
- `codex_agent_recovery_detach` is private, disabled by default, and requires an
  explicit operator capability plus exact Activity, Agent, request, and version
  preconditions. Busy-state validation and assignment release occur in the same
  SQLite transaction.
- `codex_models` returns the target backend's validated selectable catalog,
  source, timestamp, and fingerprint.
- `codex_settings` returns bridge limits and a model-visible list containing only
  project names plus availability/archive state. Internal UUIDs and local paths
  are absent from its structured content and metadata. The mounted card obtains
  them from the app-private, read-only `codex_settings_snapshot`, which reads the
  current persisted settings and registry on every call.
- `codex_update_settings` is app-only and exposes one discriminated reset/patch
  operation. Ordinary preferences use `expectedSettingsRevision`; project
  add/rename/relocate/archive/restore operations use independent
  `expectedRegistryRevision`. Each effective project transaction increments the
  registry generation exactly once; a rejected or no-op transaction does not.
  Both CAS checks and the commit share one SQLite transaction, so concurrent
  cards cannot partially overwrite either generation. An unverified CLI fallback
  cannot activate model-policy changes. Project folders are resolved with
  `realpath`, must be existing directories, and are rejected on active normalized
  name or canonical-path collisions. UUID identities are generated by the server
  and never derived from names. Reset preserves the complete registry, including
  order, UUIDs, archive state, and recovery entries. The current Settings resource
  uses generation 13 and never paints cached initial editor metadata; retained
  generation-9 and newer resources keep the compatible mutation boundary.
- `codex_task` starts, resumes, or forks only through a scope-owned canonical
  Agent ID. It never exposes per-call cwd or arbitrary thread routing. Per-call
  sandbox has one stable operator-bounded shape; fixed access modes reject an
  explicit override and enforce the saved policy, while adaptive mode accepts
  only owner-enabled capabilities. Its exact model/effort decision is resolved
  again at runtime.
  The user's independent Priority preference is then applied privately by the
  bridge and the effective downstream selection is retained with the job. The
  v2 descriptor requires `taskContractVersion: "2"` and an exact 64-hex,
  installation-keyed `executionEnvelopeRef` over the stable contract generation
  and operator-owned maximum/static envelope: prompt bound, command/backend,
  roots, sandbox capabilities, approval policy, model ceiling, and secret
  preflight. The HMAC key remains private in bridge state. Saved settings,
  projects, availability, and model catalog are intentionally excluded so those
  runtime changes cannot invalidate an existing conversation's v2 descriptor.
  Every new call privately captures an exact mutable execution-policy HMAC,
  including the saved concurrency ceiling, and
  rechecks it before filesystem preflight and inside serialized admission using
  the same resolved catalog fingerprint. A race fails before side effects and
  retries without connection Refresh. New v2 admissions use canonical
  request-hash v7 over the stable contract/envelope plus the caller's exact
  project selector, internally resolved UUID/canonical folder, backend, sandbox,
  execution/context mode, immutable source thread, effective model selection,
  prompt, and creation metadata. Exact replay—v7, cached pre-v2 v6, and frozen v5
  migration—is checked before current project and execution-policy resolution,
  preserving the original admission/result after later settings, catalog,
  rename, relocate, archive, or restore changes without creating work.

The bridge does not expose a raw shell tool, arbitrary process control,
arbitrary Codex config, or a general Responses API proxy. Process termination is
limited to the exact scope-owned public cancellation surfaces and the mounted-card
private job/background-terminal controls described above. An explicitly enabled
`danger-full-access` Codex session can nevertheless execute commands and access
the network as the current macOS user.

## Enforced defaults

- Loopback host binding.
- A single settings-managed registry of server-generated immutable private UUIDs,
  opaque non-reused public refs, per-project admission revisions,
  normalized Unicode names, and canonical existing folders. A normal fresh
  install starts with no project; no first/sole/default/slug/alias fallback is
  created. `codex_task` advertises a generic closed `{ name, projectRef,
  projectRevision }` selector plus a same-tool no-work `projectLookup`, never a
  registry inventory. The global `registryRevision` remains a Settings CAS
  generation. Every new Activity or fresh Agent context requires the exact
  current object; only existing Activity continue/fork calls omit it and inherit
  their pinned UUID plus cwd snapshot. Per-call cwd is absent from and rejected
  by the strict Task contract. With an empty registry, the task returns
  structured `PROJECT_SETUP_REQUIRED` and directs GPT to `codex_settings`.
- Project names reject control, surrogate, bidi-control, and Unicode
  default-ignorable code points before and after NFC normalization; Unicode
  whitespace is collapsed and trimmed. Active uniqueness and exact lookup use a
  deterministic NFKC case-folded `name_key`. There is no fuzzy match, slug,
  legacy alias, or archived-name fallback. Active canonical cwd is unique too.
- Recovery-only project metadata is retained when a saved folder disappears. It
  is marked unavailable in Settings and cannot admit new work; restoring general
  defaults does not erase or rewrite it.
- Rename and relocate preserve the UUID; relocate changes only future fresh
  admissions. Archive removes a project from new selection while existing pins
  remain resumable, and restore reactivates the same UUID only after active
  name/cwd collision checks. A cwd snapshot still referenced by a resumable
  Activity, current Agent thread, or active Job cannot be reassigned to another
  UUID.
- Runtime ref/revision/name, active/available state, canonical root, and
  execution-policy checks plus the final project recheck occur in the same
  SQLite transaction as Activity, Agent creation/assignment, replay, and Job
  admission. The Activity and Job receive one UUID/cwd pin; a backend-assigned
  resumable thread receives the same pin before later continue/fork admission.
  Descriptor discovery is never an authorization boundary. Ordinary saved
  settings, catalog, registry, and availability changes leave the v2 descriptor
  byte-identical and therefore need no notification or Refresh. Stateless
  Streamable HTTP remains the default; experimental stateful mode still uses
  bounded in-memory sessions and per-session replay logs for genuine static
  descriptor or UI changes. A session that never sends
  `notifications/initialized` is reclaimed after a 10-second handshake grace;
  ready sessions retain the configured idle TTL. Notification attempts, replay,
  reconnect signals, and inbound relists do not prove host adoption. A one-time
  Developer-mode Refresh is required to migrate a cached pre-v2 conversation or
  adopt an operator/static envelope change; stale selectors and v2 policy races
  fail without upstream calls or partial rows and recover on the same contract.
  Notification sends observe the protocol transport Promise directly; an
  asynchronous failure is counted and retried once with a bounded delay rather
  than escaping as an unhandled rejection. A successful send still proves only
  transport acceptance, never host re-list or descriptor adoption.
  The separate persistent-stdio candidate uses one tunnel-owned process and no
  HTTP session registry. Its coordinator uses reversible presence projection
  instead of the SDK's irreversible registration removal and records successful
  `tools/list` responses independently from notification attempts; neither is
  authorization or proof of later descriptor use.
  Continue/fork revalidates the pinned canonical cwd and returns
  `PROJECT_UNAVAILABLE` without another-project or configured-root fallback.
- Read-only sandbox.
- `on-request` approval policy.
- Thirty concurrent jobs at most.
- Concurrent sessions are allowed in one working directory, including mutating jobs.
- Overlapping mutations are coordinated by the caller or isolated with worktrees.
- Scope-persistent named bridge Agents with immutable IDs, normalized unique
  aliases, separate assignment roles, current/history thread links, and Activity
  assignment history. Optional names and titles receive neutral deterministic
  display defaults. Assignment role defaults to `primary` and is consumed only by
  Activity/history presentation; routing, authorization, context, lifecycle, and
  handoff decisions never read it.
- One active job per Agent/Codex thread.
- Different Codex threads under the same conversation scope may run
  concurrently in the same working directory; parallelism is created on demand
  rather than configured on the scope in advance.
- HMAC-derived ChatGPT conversation scopes for automatic session routing,
  explicit UUID fallback for hosts without ChatGPT metadata, and required request
  UUIDs for retained-job retry deduplication.
- Exact-scope Activity creation/attachment and server-validated lifecycle
  transitions. Existing Activity policy cannot be changed through `codex_task`,
  and Codex output is never treated as transition authority. New-Activity policy,
  Activity/Agent creation, assignment, replay registration, and Job admission are
  one SQLite transaction, so failed admission leaves no partial identity or policy.
- Operator model ceiling ∩ versioned user policy ∩ backend catalog/capability ∩
  request intent is the only model execution authority. Fixed mode rejects
  stale overrides; automatic mode requires an exact nested selection for every
  new Activity, new Agent, or fresh context at the GPT orchestration layer. The
  schema exposes only current allowed pairs and only upstream catalog
  descriptions for their exact model and effort values; it adds no local task
  mapping, ranking, recommendation, or effort glossary. Every newly saved
  automatic policy also has one exact omission fallback; it applies only to
  compatible callers that omit selection and is neither a schema default nor a
  recommendation. Continue/fork omission inherits the retained thread while an
  explicit selection requests an allowed backend override. No bridge-maintained
  model aliases are interpreted.
- 50,000 characters per prompt.
- Discriminated nested Activity + Agent routing with exact existing IDs and optional
  `continue`, `fork`, or `fresh` intent; ambiguous candidates and arbitrary public
  thread IDs are rejected. The expired flat routing contract is rejected.
- Durable sessions, bridge preferences, jobs, bounded results, Activities,
  Agent/thread history, Activity-Agent assignments, idempotent Agent mutations,
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
  terminal state. Background calls return immediately; Activity/status
  long-poll, model catalog, tunnel, and database waits remain bounded
  control-plane operations.
- Separate model-visible and card-private force-stop surfaces with exact worker
  generation/process-group validation, TERM→KILL escalation, collateral
  confirmation, a durable intent before side effects, and terminal state only
  after exit evidence. `termination-failed` remains an active slot. A runtime
  invariant rejects App Server interruption or worker termination without a
  typed cancellation or assignment-containment correlation.
- Compact Activity render reservations are in-memory and keyed by the
  host-derived conversation scope plus the dedicated presenter's explicit
  `presentationId` (stored privately as `activityPresentationId`). Task calls
  cannot reserve or mount presentation state. An unconfirmed presenter mount is
  short-lived: an exact presentation retry stays eligible, the server confirms
  one widget, and racing mounts collapse. A previously confirmed card is retained
  until a replacement mounts, and the candidate expires if no snapshot lease
  confirms it. Activity id/generation remains a validity check, not the
  presentation boundary. Only the newest confirmed mounted compact
  presentation owns scope watch and completion handoff. A racing duplicate
  widget for that presentation is collapsed, while superseded cards stop
  normally and release admission; at most three explicit user-opened cards may
  watch beside the automatic owner, without claiming automatic handoff. Widget
  instance leases use app-generated per-iframe UUIDs with
  `openai/widgetSessionId` as a compatibility fallback and are released by
  abort/unmount/TTL or process restart.
- Historical cold rehydration is outside automatic presentation ownership. It
  deterministically admits at most one retained Job for a shared response
  presentation, honors the current `always | background-only | never` setting,
  and fails closed for an unknown, expired, mismatched, cross-scope, or
  non-selected Job. Only a user refresh can enter the existing explicit-card
  lease path. Public identifiers and historical private metadata never authorize
  a mutation by themselves.
- HTTP/SSE detach, MCP `notifications/cancelled`, read-only status/snapshot wait
  abort, presentation supersession, and widget unmount are observation
  lifecycle only. They can release bounded waits/leases and append a bounded
  transport diagnostic, but they never dispatch a domain cancellation. The
  diagnostic stores only allowlisted IDs, hashes, bridge instance, timestamp,
  tool, and reason code—not raw host metadata, prompts, answers, or auth data.
- App Server background terminals left after a turn are observed separately
  from Agent idle state and require exact process termination before archive.
- Ten-minute `no-progress-observed` threshold with process liveness explicitly
  unknown; it does not automatically cancel a job.
- At most 100 retained jobs and one MiB per retained job result by default.
- Upstream stderr disabled unless explicit local debug mode is enabled.

## Authentication

Secure Tunnel mode starts a loopback-only HTTP server with no application-level authentication. The OpenAI-managed tunnel and its organization/workspace permissions are the transport boundary. The bridge rejects no-auth mode on non-loopback host bindings.

The bundled launcher reads the tunnel runtime key and tunnel ID from the
operator-owned `~/.config/codex-mcp-bridge/.env` by default. It accepts only a
regular non-symlink file owned by the current user with no group/world access.
Keep that file outside every registered project so the secret-filename
preflight remains effective and Codex tasks cannot read the tunnel credential
through their project root. Exported process variables take precedence only as
an explicit operator override. Bundled launchers do not query an operating
system credential store.

### Native macOS control boundary

The native menu bar app introduced by issue #44 does not read SQLite and does
not invoke private MCP card tools. A per-user helper supervises the existing
launcher, while a separate bridge companion adapter calls the same Settings
and Dashboard application service used by the retained MCP handlers. The two
versioned control surfaces use Unix domain sockets inside the current user's
`0700` runtime directory; socket nodes are `0600`, active sockets are never
replaced, and stale cleanup verifies ownership and inode identity.

The helper is the only app-managed owner of the bridge and tunnel process tree.
A private runtime lock rejects a concurrent CLI or helper launcher against the
same default runtime. Drain stops new Job admission, waits for active Jobs and
pending admissions, and then verifies every current retained App Server Agent
thread for background processes. A positive or unknown background impact cancels the
drain. Force stop remains an explicit destructive UI action, refreshes the
impact before confirmation, and does not claim to roll back filesystem changes
or replay interrupted work. LaunchAgent definition replacement restores the
previous plist and service when `bootout`, `bootstrap`, `kickstart`, or
new-helper readiness validation fails.

The setup surface may update only `CONTROL_PLANE_API_KEY` and
`CONTROL_PLANE_TUNNEL_ID`. It validates the complete candidate, writes a
same-directory `0600` temporary file, syncs it, and atomically replaces the
dotenv while preserving comments, ordering, unknown entries, line endings,
and the prior file on failure. It drains before commit; failed new-runtime
readiness rolls the dotenv and prior runtime back, while a concurrent dotenv
edit aborts without overwrite and restarts that unchanged runtime. Runtime
dotenv paths inside registered projects are rejected both during helper startup
and during project add/relocate/restore operations. A blank field retains the
saved value. The API
key is never returned by helper status, persisted in Swift preferences, placed
in a plist or command argument, copied to the pasteboard, or included in the
bounded helper log. The non-secret Tunnel ID may be copied for ChatGPT setup.

Codex login remains a separate boundary: the helper runs only `codex login
status` and an explicit user-requested `codex login` browser flow. It does not
copy, overwrite, delete, log out, or change the storage choice of shared Codex
credentials. A missing ChatGPT/Codex login never falls back to an API key.
The app itself never calls an operating-system credential store for Tunnel
credentials; the external Codex CLI may still use the store already selected
by the user.
In app-managed mode, API-key environment variables from a legacy dotenv or the
parent process are removed before Codex child startup; explicit API-key mode
remains deferred to issue #29.

When exposing the HTTP endpoint through another mechanism, configure a long bearer token or place an OAuth 2.1/PKCE-capable proxy in front of it. Bearer authentication is intended for controlled private deployments, not public plugin submission.

Conversation `scopeId` values are routing labels, not identities or secrets.
ChatGPT calls derive them from the anonymous organization/subject/session tuple;
raw organization and subject identifiers and arbitrary session values are not
stored, and a model-provided scope cannot override the host-derived value. The
one deliberate exception is a UUID-shaped ChatGPT session correlation value:
the personal Dashboard retains at most 1,000 private scope-to-value mappings so it
can construct a best-effort **Open conversation** route candidate. It cannot
backfill scopes observed before capture because their raw values were not stored. A compatibility/admin caller without ChatGPT session
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
With the default `adaptive` strategy, omission uses the operator-configured
default (read-only by default), while ChatGPT may send only an owner-enabled
mutation sandbox for an authorized task. Fixed `read-only` and `always-full`
descriptors omit the per-call field and enforce the saved strategy. A bridge
user can select only owner-enabled strategies. Preferences are shared by the
bridge instance because the private no-auth tunnel does not supply per-user
identity.

## Remaining risks

- The project ref/revision tuple guarantees freshness of the selected
  name-to-UUID/cwd mapping. It cannot distinguish an intended project from a
  different complete selector that is also currently valid. That is a
  semantic-intent problem, not a stale-mapping bypass. A future fresh-user
  confirmation boundary for multi-project write/full-access admission must be
  app-private and non-replayable; this release intentionally does not accept a
  model-visible `confirmed` boolean as evidence.
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
- `codex_activity_update` is a non-idempotent state transition guarded by an
  exact Activity version. `codex_activity_cancel` is destructive and replay-safe
  by request UUID; it validates scope/lifecycle, Activity version, worker
  generations, and collateral acknowledgement, but cannot undo commands or file
  edits already performed. Verification evidence is bounded metadata supplied by
  the caller; it is an audit reference, not cryptographic proof that a test or
  artifact belongs only to that Activity.
- Cancellation operations and intents are first-class SQLite records. They
  retain the logical request UUID, source/tool/action, exact Job/Activity/thread/
  turn and presentation targets where known, expected version, parent/cascade
  correlation, hashed caller/widget correlation, bridge instance, timestamps,
  status, and bounded reason code. They deliberately exclude raw host metadata,
  prompt/answer content, and authentication material.
- Public steering has a separate prompt-free SQLite delivery record keyed by
  host-derived scope and request UUID. It retains the exact Job, expected Job
  version, action hash, prompt SHA-256, bridge instance, bounded structured
  result, and `prepared | dispatching | delivered | not-delivered | uncertain`
  phase. The raw prompt is transient and is not copied into mutation results,
  Activity events, transport diagnostics, or the delivery record. Exact replay
  returns the retained result; another payload under the same request UUID is a
  conflict. A replay that finds an abandoned pre-dispatch record becomes
  `not-delivered`; one that finds a dispatch boundary becomes `uncertain` and is
  never silently resent.
- Once dispatch begins, the bridge retains the exact steering text only in a
  per-Job, non-serialized in-memory redaction set until terminal state. Exact
  reflections in progress, public events, errors, and final Codex results are
  replaced before model projection or Job persistence. Semantic paraphrases are
  ordinary Codex output and cannot be identified as the raw input. App Server
  still receives the text as active-turn input and may retain it in its own
  thread history; `promptPersistedByBridge: false` describes Bridge-owned state.
- Job admission has a hard maximum of 100. The environment ceiling, saved user
  limit, Job Registry, job cancellation acknowledgement, and Activity
  cancellation acknowledgement all share that invariant, so a valid affected
  set cannot be rejected by a smaller confirmation schema.
- Jobs are spread across a small local Codex MCP pool. A worker-process failure
  can still affect the subset of calls assigned to that worker.
- Completion outbox claim/delivery state is transactional inside SQLite, but a
  ChatGPT `ui/message` side effect and the later local acknowledgement cannot be
  committed atomically across systems. A lost acknowledgement can therefore
  produce an at-least-once retry; the fixed prompt carries a stable bounded
  `handoffBatchId` and never embeds raw Codex output.
- App Server `turn/steer` and the later local delivery acknowledgement cannot be
  committed atomically across processes. The durable pre-dispatch boundary
  prevents a crash replay from quietly issuing the same prompt twice, but it
  cannot prove whether an interrupted upstream request was consumed. The public
  contract therefore reports `DELIVERY_UNCERTAIN` and makes no distributed
  exactly-once claim. The caller must inspect the exact Job and must not
  automatically resend that request.
- Codex MCP thread context is worker-process local. Persisted session metadata
  remains visible after restart, but the owning Agent becomes orphaned rather
  than silently receiving another thread; replacement requires explicit fresh
  context and preserves history. New App Server threads use a
  separate sticky backend with rich public events, approval/input handling,
  steering, and exact turn interruption. OpenAI currently documents the App
  Server interface as experimental, so it is not represented as a production
  stability guarantee.
- App Server model/effort and independent Priority changes are sent on the next
  `turn/start` of the same thread. MCP Server continuation cannot override its
  admission-time selection: model/effort changes return
  `THREAD_OVERRIDE_UNSUPPORTED`, while a changed Priority preference applies to
  newly started threads and the existing thread retains its pinned tier.
- Each retained Job exposes a selection-only execution audit that separates the
  requested, policy-effective, and evidence-backed actual model/effort. A
  `model/rerouted` event supplies actual-model and reason evidence; when App
  Server supplies no independent runtime effort-override field, the audit says
  so instead of claiming stronger evidence. Prompt and private reasoning text
  are excluded.
- A deliberate MCP/App Server boundary crossing creates a new thread and
  requires an explicit summary. The summary is sent transiently to the target
  backend but only its SHA-256 digest, source/target backend, and source thread
  are persisted as dedicated handoff fields. Like any prompt, the summary may
  still be repeated in Codex output and therefore enter ordinary bounded result
  retention. The bridge never labels transcript, approvals, hidden context, or
  backend state as migrated.
- `CONTEXT_WINDOW_EXCEEDED` and other structured turn failures are sanitized,
  retained, and replayed for the exact request ID without issuing a duplicate
  upstream call. Recovery advice is explicit; no model or effort downgrade is
  automatic.
- App Server control responses can arrive after the bridge has already returned
  a timeout. A bounded journal in the private SQLite metadata records only
  method/outcome, timing, worker generation, numeric error code, and validated
  thread/turn identifiers; raw result/error payloads, messages, prompts, paths,
  and command output are never copied into that journal. `/healthz` is
  intentionally minimal and exposes only `ok`, `name`, and `title`; aggregate
  and operator counters belong to the private app-only `codex_diagnostics`
  surface. Late archive/unarchive success never changes logical Agent state; the
  journal records it as a conflict for explicit upstream recovery.
- Steering is usable only while both the ChatGPT model turn and the target Codex
  turn are active. A bounded same-response `codex_status` wait can expose a
  verified sibling result in time to steer another active Job. Once the ChatGPT
  response has ended, a user message or the existing completion handoff must
  trigger a new model turn; the bridge does not create a general Job-result wake
  service. Shared-working-tree races remain a wave/worktree isolation concern,
  not a messaging or steering concern.
- App Server continuation admission uses `thread/read`, not an optimistic local
  boolean. Missing and `systemError` are permanent orphan evidence; `active`
  and transport/timeout failures are retryable and do not mutate Agent
  continuity state. Restoring an archived orphaned Agent clears that state only
  after a new exact probe proves the thread is resumable.
- Server-initiated approval and input requests are correlated by exact worker
  generation and JSON-RPC request ID. `serverRequest/resolved` dismisses a
  request without sending a duplicate response; `autoResolutionMs` has a local
  expiry guard. Only protocol-advertised decisions are accepted, including
  `acceptForSession` when available. A response is one-shot even under concurrent
  retries, and answer keys must match the exact pending question IDs. Persisted/UI context uses bounded labels,
  counts, hosts, and protocols; raw permission paths remain only in the
  transient upstream request needed to form the response.
- Public App Server telemetry classifies errors, warnings/config notices, model
  reroutes/verifications/safety buffering, context compaction, MCP calls,
  collaboration, and token usage. It excludes raw reasoning, MCP arguments and
  results, collaboration prompts, and full local paths.
- Worker health publishes only pool aggregates: observed RSS/FD samples,
  startup latency/failures, crash count/rate, and protocol/config/MCP
  initialization state. Worker PID, thread assignment, config contents, and MCP
  payloads remain private.
- Logical Agent archive/restore never invokes App Server thread archive/unarchive.
  This keeps bridge lifecycle management from cascading through an upstream fork
  graph and affecting another logical Agent.
- Tool results and retained jobs can contain repository content. They are
  stripped of result `_meta`, token/password/key patterns, and configured-root
  absolute prefixes, then bounded in memory and persisted to the private state
  database until their retention window expires. Redaction is defense in depth,
  not a proof that arbitrary source text contains no secret; local backup and
  filesystem-access policies should treat that database and its SQLite sidecars
  as source-sensitive.
- The 30-job setting is a bridge admission limit. The MCP host, tunnel, Codex,
  account, and machine can impose lower practical limits.
- Persisted Agent/session rows contain scope routing labels, Agent aliases and
  immutable IDs, current/history thread ids, App Server session ID/direct fork
  ancestry, Activity assignment history, backend,
  local working-directory paths, and current exact execution selection/revision,
  but not prompts or results. Historical decisions remain on job rows. Pre-scope records are
  migrated into deterministic Legacy Agents or a quarantined legacy scope that
  automatic routing ignores; obsolete v2 task-lane labels are not authorization.
- Bridge metadata contains the conversation-scope HMAC key and may contain the
  bounded UUID-shaped ChatGPT session mapping used by best-effort Dashboard links.
  Persisted App Server Agent/session rows also contain the current thread and
  session-tree UUIDs used to derive local Codex links. Protect database files and
  backups; raw organization, subject, and arbitrary host session values are not
  stored, but retained ChatGPT conversation and Codex thread UUIDs are sensitive
  navigation metadata.
- Persisted job rows contain local paths, lifecycle metadata, progress
  messages, errors, and bounded Codex results. Results can include repository
  content even though the job record does not separately store the submitted
  task prompt. An exact public/app steering-input echo is removed first.
- Persisted steering-delivery rows contain opaque scope/request/Job identifiers,
  expected version, hashes, delivery phase, bridge instance, timestamps, and a
  bounded structured result. They contain no raw steering prompt. Protecting the
  database remains necessary because identifiers and other retained Job results
  are still operator-sensitive.
- Activity and event rows contain sanitized titles, opaque scope/job/thread
  relations, state transitions, aggregate counts, and bounded handoff metadata.
  Raw prompts and private reasoning are not Activity event or outbox fields.
  Archived job rows retain deduplication and terminal facts but replace their
  original payload/result with a minimal summary.
- Persisted state contains private server-generated project UUIDs, normalized
  names/name keys, canonical paths, archive/recovery metadata, independent
  registry/settings generations, and user defaults. Availability is derived at
  load time. Public tool output removes UUIDs and paths. The database contains no
  tunnel credential, prompt, or result in its settings rows, but every user of
  the same private bridge connection shares them.
- No-auth loopback mode trusts other processes and users on the same Mac.
- A compromised local user account can access the same files and processes.

For sensitive code, expose a sanitized staging copy and run the bridge under a separate OS user, container, or VM with explicit filesystem and network policy.
