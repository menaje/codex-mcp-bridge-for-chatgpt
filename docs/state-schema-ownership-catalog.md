# State schema ownership catalog

This catalog is the schema-24 inventory required by issues #142 and #143. It
records the current owner and consumers before the asynchronous state-service
cutover. The target column is a data-classification decision, not evidence that
the move has happened. Until cutover, `BridgeStateStore` remains the only
authorized SQLite owner.

Indexes and triggers inherit the writer, durability, migration, backup and
destination contract of their parent table. No caller may address an index or
trigger through the future IPC protocol; callers use semantic commands and
queries only.

## Tables and paths

| Table | Current writer / command path | Principal readers and maintenance | Recovery or durability dependency | Target |
| --- | --- | --- | --- | --- |
| `bridge_meta` | `BridgeStateStore` startup, migration and service-open commands | startup verification, HMAC, migration and rollback checks | database identity, schema provenance, service-open rollback boundary | state |
| `bridge_instances` | `BridgeStateStore` runtime registration and shutdown | startup recovery and forensics | live/old owner detection and termination evidence | state |
| `scopes` | Activity/Agent/Job Units of Work | exact status, Dashboard and scope event cursors | scope version is authorization and ordering evidence | state |
| `project_registry` | project/settings mutations | task admission and project projection refresh | monotonic registry revision | state |
| `projects` | project/settings mutations | admission, Settings and Dashboard projections | project identity, archived/deleted state and pinned path | state |
| `user_settings` | `UserSettingsStore` mutation | Settings and task admission | execution policy and settings revision | state |
| `sessions` | `SessionRegistry` and Activity admission UoW | resume, Agent thread and backend routing queries | retained backend context and persistence classification | state |
| `activities` | `CodexJobRegistry` Activity commands and Job UoW | exact status, Dashboard, completion and recovery | goal lifecycle, version and terminal counters | state |
| `agents` | Agent commands and Job assignment UoW | admission, Dashboard and recovery | execution owner, lifecycle and current Job/thread | state |
| `agent_threads` | Agent link/replace commands | resume, handoff and Dashboard | current thread uniqueness and history | state |
| `activity_agents` | assign/release commands | activity and scope projections | assignment provenance and active-pair uniqueness | state |
| `jobs` | admission, progress, interaction and terminal UoW | exact status, Dashboard, history, completion and recovery | request idempotency, terminal state and bounded result | state |
| `job_interactions` | Job progress/input UoW | exact input/status and Dashboard | unresolved user input authority | state |
| `activity_events` | Activity/Job UoW | activity cursors, status summary and Dashboard | scope ordering and authoritative lifecycle projection | state (mixed; review later) |
| `job_events` | Job UoW | exact status cursor, usage/summary extraction and recovery | current Job event ordering and summary evidence | state (mixed; review later) |
| `event_budget` | `job_events` triggers only | event retention budget checks | bounded authoritative event storage | state |
| `event_retention_state` | `EventRetention` maintenance | restartable event cleanup | retention cursor and budget progress | state |
| `result_holds` | completion/read commands and retention | result access and event retention | prevents premature result deletion | state |
| `completion_outbox` | Activity completion UoW and native delivery commands | native completion delivery | durable pending/leased/delivered evidence | state |
| `job_completion_deliveries` | terminal Job UoW and host receipt commands | exact completion result paths | acceptance uncertainty, leases and offer evidence | state |
| `agent_mutations` | Agent mutation UoW | duplicate-request lookup | mutation idempotency receipt | state |
| `cancellation_operations` | cancellation UoW | duplicate lookup and recovery | logical cancellation idempotency and aggregate result | state |
| `cancellation_intents` | cancellation UoW | impact review, status and recovery | cancellation provenance and dispatch certainty | state |
| `steering_deliveries` | steering UoW | duplicate lookup and recovery | prepared/dispatching/delivered uncertainty journal | state |
| `user_questions` | `QuestionStore` commands | question/result tools and expiry maintenance | user-response authority and expiry | state |
| `codex_question_deliveries` | `QuestionStore` delivery commands | question notification recovery | delivery claim and uncertainty evidence | state |
| `decision_cards` | `DecisionCardStore` commands | decision card read and retention | current card identity and lifecycle | state |
| `decision_card_versions` | `DecisionCardStore` version UoW | exact rendered decision read | submitted presentation proof | state |
| `decision_card_requests` | `DecisionCardStore` create command | duplicate request lookup | create idempotency receipt | state |
| `decision_submissions` | `DecisionCardStore` submission/delivery UoW | decision result and recovery | user intent, receipt and acceptance uncertainty | state |
| `thread_connections` | `ThreadConnectionStore` commands | admission and connection controller | unfinished-work and handoff/release state | state |
| `work_history_state` | `WorkHistoryStore` commands and history maintenance | Dashboard/history projections | acknowledgement and expiry state | state |
| `work_history_control` | `WorkHistoryStore` policy commands | retention policy | cleanup policy revision | state |
| `runtime_problem_resolutions` | problem review commands | Dashboard problem projection | acknowledged runtime problem revision | state |
| `automatic_recovery` | `AutomaticRecoveryStore` commands | recovery controller | retry budget, lease and terminal recovery state | state |
| `automatic_recovery_incidents` | `AutomaticRecoveryStore` commands/maintenance | recovery diagnostics and review | bounded incident evidence used by recovery policy | state |
| `transport_observations` | transport observation append/retention | private diagnostics and wait-abort counts | no mutation authority; bounded loss is allowed | telemetry after verified cutover |

## Index inventory

The current schema contains these explicit indexes. Every name is tied to its
parent table and is covered by the same owner above.

- `activities`: `activities_continuation`, `activities_project_pin`,
  `activities_scope_attention`, `activities_scope_recent`
- `activity_agents`: `activity_agents_active_pair`,
  `activity_agents_activity_history`, `activity_agents_agent_history`
- `activity_events`: `activity_events_activity_cursor`,
  `activity_events_scope_cursor`
- `agent_threads`: `agent_threads_agent_history`, `agent_threads_one_current`
- `agents`: `agents_scope_state_recent`
- `automatic_recovery`: `automatic_recovery_job`, `automatic_recovery_scope`
- `cancellation_intents`: `cancellation_intents_cascade`,
  `cancellation_intents_operation`, `cancellation_intents_target_activity`,
  `cancellation_intents_target_job`
- `cancellation_operations`: `cancellation_operations_target_activity`,
  `cancellation_operations_target_job`
- `completion_outbox`: `completion_outbox_pending`
- `decision_card_versions`: `decision_card_versions_scope_recent`
- `decision_cards`: `decision_cards_scope_recent`
- `decision_submissions`: `decision_submissions_delivery`,
  `decision_submissions_scope_recent`
- `job_completion_deliveries`: `job_completion_deliveries_claimable`
- `job_events`: `job_events_job_cursor`, `job_events_scope_cursor`
- `job_interactions`: `job_interactions_blocking`
- `jobs`: `jobs_activity_recent`, `jobs_agent_active`, `jobs_scope_recent`,
  `jobs_source_thread_active`, `jobs_status_recent`, `jobs_thread_active`
- `projects`: `projects_active_cwd`, `projects_active_name`, `projects_ordered`
- `sessions`: `sessions_project_recent`, `sessions_scope_recent`
- `steering_deliveries`: `steering_deliveries_job_recent`,
  `steering_deliveries_status_recent`
- `thread_connections`: `thread_connections_agent`, `thread_connections_idle`
- `transport_observations`: `transport_observations_recent`
- `user_questions`: `user_questions_expiry`
- `work_history_state`: `work_history_expired`

SQLite automatically created indexes are implementation details of declared
primary-key and unique constraints and inherit the table contract. They are
intentionally excluded by the `sqlite_%` rule in the inventory test.

## Trigger inventory

`event_budget_insert`, `event_budget_delete` and `event_budget_update` are the
only current explicit triggers. They are owned by the `job_events` write UoW and
update `event_budget` in the same transaction. Neither object can move to
telemetry while Job events remain operational.

## Future telemetry objects

`telemetry_meta`, `runtime_measurements`, `diagnostic_events`,
`telemetry_drop_counters` and `telemetry_retention_state` do not exist yet.
Their planned writers and failure policies are defined in
[State execution isolation architecture](state-execution-isolation.md). Their
absence is intentional until the telemetry cutover migration is implemented and
verified.

## File, IPC and backup security contract

- The state and telemetry directories are mode `0700`; database, WAL, SHM,
  backup, migration journal and digest files are mode `0600`. Startup refuses a
  non-regular canonical database target or an ownership/alias conflict rather
  than following an unsafe replacement.
- State and telemetry children inherit only the local IPC channel and the
  minimum configuration needed for their database. They open no listener and
  receive no bearer token, raw user prompt or Codex result unless that payload
  is itself authoritative state for a closed semantic command.
- `state.sqlite` backups are sensitive operational artifacts and receive the
  same permissions and retention handling as the live database. A backup must
  include committed WAL content through the verified SQLite backup path; copying
  the main file alone is invalid.
- `telemetry.sqlite` and its backups remain private even though raw prompts,
  results, secrets, absolute project paths and unsanitized subprocess output are
  forbidden. Sanitization happens before queue admission, not after persistence.
- Backup manifests record database identity, schema, source generation, byte
  size and digest. Restore validation uses those fields and SQLite integrity and
  foreign-key checks before any service-open marker is written.
- Telemetry loss never authorizes restoring older operational state. Once the
  new operational generation accepts a command, an older state backup cannot be
  automatically selected; rollback must preserve the new authoritative writes.

## Coverage rule

`test/stateSchemaOwnership.test.ts` opens a fresh schema-24 fixture and requires
every non-SQLite-internal table, explicit index and trigger in `sqlite_master` to
appear in this catalog. Adding or renaming a schema object without updating its
owner and destination therefore fails the test.
