BEGIN TRANSACTION;
CREATE TABLE "activities" (
            activity_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
            title TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('discussion','investigation','review','implementation','other')),
            execution_mode TEXT NOT NULL CHECK(execution_mode IN ('auto','foreground','background')),
            handoff_policy TEXT NOT NULL CHECK(handoff_policy IN ('none','notify','verify')),
            completion_trigger TEXT NOT NULL CHECK(completion_trigger IN ('manual','sealed-jobs-terminal')),
            lifecycle TEXT NOT NULL CHECK(lifecycle IN ('open','sealed','terminating','completed','cancelled','abandoned')),
            waiting_on TEXT NOT NULL CHECK(waiting_on IN ('none','codex','orchestrator','user','verification')),
            verification TEXT NOT NULL CHECK(verification IN ('not-required','pending','verifying','verified','failed')),
            version INTEGER NOT NULL CHECK(version >= 1),
            completion_version INTEGER NOT NULL DEFAULT 0 CHECK(completion_version >= 0),
            legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            sealed_at INTEGER,
            completed_at INTEGER,
            total_jobs INTEGER NOT NULL DEFAULT 0 CHECK(total_jobs >= 0),
            running_jobs INTEGER NOT NULL DEFAULT 0 CHECK(running_jobs >= 0),
            completed_jobs INTEGER NOT NULL DEFAULT 0 CHECK(completed_jobs >= 0),
            failed_jobs INTEGER NOT NULL DEFAULT 0 CHECK(failed_jobs >= 0),
            interrupted_jobs INTEGER NOT NULL DEFAULT 0 CHECK(interrupted_jobs >= 0),
            cancelled_jobs INTEGER NOT NULL DEFAULT 0 CHECK(cancelled_jobs >= 0),
            terminal_jobs INTEGER NOT NULL DEFAULT 0 CHECK(terminal_jobs >= 0)
          , continuation_of_activity_id TEXT REFERENCES activities(activity_id), card_generation INTEGER NOT NULL DEFAULT 1 CHECK(card_generation >= 1), project_id TEXT, project_label TEXT, project_cwd TEXT, project_uuid TEXT REFERENCES projects(project_id), project_name_snapshot TEXT, project_cwd_snapshot TEXT) STRICT;
CREATE TABLE activity_agents (
            assignment_id TEXT PRIMARY KEY,
            activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
            role TEXT NOT NULL,
            context_mode TEXT NOT NULL CHECK(context_mode IN ('continue','fork','fresh')),
            assigned_at INTEGER NOT NULL,
            released_at INTEGER
          ) STRICT;
CREATE TABLE activity_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
          scope_version INTEGER NOT NULL CHECK(scope_version >= 1),
          event_type TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
CREATE TABLE agent_mutations (
            scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
            request_id TEXT NOT NULL,
            action_hash TEXT NOT NULL,
            result TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(scope_id, request_id)
          ) STRICT;
CREATE TABLE agent_threads (
            thread_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
            scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
            backend_kind TEXT NOT NULL,
            cwd TEXT NOT NULL,
            sandbox TEXT NOT NULL,
            context_mode TEXT NOT NULL CHECK(context_mode IN ('continue','fork','fresh')),
            is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),
            linked_at INTEGER NOT NULL,
            replaced_at INTEGER,
            forked_from_thread_id TEXT
          , project_id TEXT, project_label TEXT, session_id TEXT, project_uuid TEXT REFERENCES projects(project_id), project_name_snapshot TEXT, project_cwd_snapshot TEXT) STRICT;
CREATE TABLE agents (
            agent_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
            agent_name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            lifecycle TEXT NOT NULL CHECK(lifecycle IN ('idle','active','waiting-input','archived','orphaned')),
            current_thread_id TEXT,
            current_job_id TEXT,
            version INTEGER NOT NULL CHECK(version >= 1),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER,
            orphaned_reason TEXT,
            UNIQUE(scope_id, normalized_name)
          ) STRICT;
CREATE TABLE automatic_recovery (
    recovery_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    job_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('recheck','retry-stop','release')),
    state TEXT NOT NULL CHECK(state IN ('retrying','resolved','blocked')),
    attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL, reason TEXT NOT NULL, evidence TEXT
  ) STRICT;
CREATE TABLE bridge_instances (
          instance_id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          stopped_at INTEGER,
          termination_reason TEXT,
          process_id INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
INSERT INTO "bridge_instances" VALUES('ebf20f8b-212c-4bba-90e2-56055b1fec24',1789167899774,1789167899774,'clean-shutdown',75053,'{"schemaVersion":16}');
CREATE TABLE bridge_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
INSERT INTO "bridge_meta" VALUES('schema_version','16');
INSERT INTO "bridge_meta" VALUES('schema_v2_migrated_at','2026-09-11T23:04:59.759Z');
INSERT INTO "bridge_meta" VALUES('schema_v3_migrated_at','2026-09-11T23:04:59.762Z');
INSERT INTO "bridge_meta" VALUES('schema_v4_migrated_at','2026-09-11T23:04:59.763Z');
INSERT INTO "bridge_meta" VALUES('schema_v5_migrated_at','2026-09-11T23:04:59.765Z');
INSERT INTO "bridge_meta" VALUES('schema_v6_migrated_at','2026-09-11T23:04:59.765Z');
INSERT INTO "bridge_meta" VALUES('schema_v7_migrated_at','2026-09-11T23:04:59.766Z');
INSERT INTO "bridge_meta" VALUES('schema_v8_migrated_at','2026-09-11T23:04:59.769Z');
INSERT INTO "bridge_meta" VALUES('schema_v9_migrated_at','2026-09-11T23:04:59.770Z');
INSERT INTO "bridge_meta" VALUES('schema_v10_migrated_at','2026-09-11T23:04:59.771Z');
INSERT INTO "bridge_meta" VALUES('schema_v11_migrated_at','2026-09-11T23:04:59.771Z');
INSERT INTO "bridge_meta" VALUES('schema_v12_migrated_at','2026-09-11T23:04:59.772Z');
INSERT INTO "bridge_meta" VALUES('event_retention_cursor','0');
INSERT INTO "bridge_meta" VALUES('event_retention_policy','2');
INSERT INTO "bridge_meta" VALUES('legacy_auto_execution_mode_migrated_at','2026-09-11T23:04:59.774Z');
CREATE TABLE cancellation_intents (
          intent_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          parent_intent_id TEXT REFERENCES cancellation_intents(intent_id) ON DELETE RESTRICT,
          cascade_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN (
            'model-tool','widget-control','activity-cascade','operator',
            'assignment-containment'
          )),
          tool_name TEXT NOT NULL,
          action_name TEXT NOT NULL,
          target_kind TEXT NOT NULL CHECK(target_kind IN ('job','activity')),
          target_job_id TEXT,
          target_activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
          target_agent_id TEXT,
          target_thread_id TEXT,
          target_turn_id TEXT,
          target_presentation_id TEXT,
          expected_version INTEGER NOT NULL CHECK(expected_version >= 1),
          caller_presentation_kind TEXT CHECK(caller_presentation_kind IN ('automatic','explicit')),
          caller_presentation_id TEXT,
          widget_instance_present INTEGER NOT NULL CHECK(widget_instance_present IN (0,1)),
          widget_instance_digest TEXT,
          card_generation INTEGER CHECK(card_generation >= 1),
          caller_request_digest TEXT,
          bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
          reason_code TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('recorded','dispatched','succeeded','failed','no-op')),
          created_at INTEGER NOT NULL,
          dispatched_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY(scope_id, request_id)
            REFERENCES cancellation_operations(scope_id, request_id) ON DELETE RESTRICT,
          CHECK((target_kind = 'job') = (target_job_id IS NOT NULL)),
          CHECK((widget_instance_present = 1) = (widget_instance_digest IS NOT NULL)),
          CHECK((caller_presentation_kind = 'automatic') = (caller_presentation_id IS NOT NULL))
        ) STRICT;
CREATE TABLE cancellation_operations (
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
          request_id TEXT NOT NULL,
          root_intent_id TEXT NOT NULL UNIQUE,
          action_hash TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN (
            'model-tool','widget-control','activity-cascade','operator',
            'assignment-containment'
          )),
          tool_name TEXT NOT NULL,
          action_name TEXT NOT NULL,
          target_kind TEXT NOT NULL CHECK(target_kind IN ('job','activity')),
          target_job_id TEXT,
          target_activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
          target_agent_id TEXT,
          target_thread_id TEXT,
          target_turn_id TEXT,
          target_presentation_id TEXT,
          expected_version INTEGER NOT NULL CHECK(expected_version >= 1),
          caller_presentation_kind TEXT CHECK(caller_presentation_kind IN ('automatic','explicit')),
          caller_presentation_id TEXT,
          widget_instance_present INTEGER NOT NULL CHECK(widget_instance_present IN (0,1)),
          widget_instance_digest TEXT,
          card_generation INTEGER CHECK(card_generation >= 1),
          caller_request_digest TEXT,
          bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
          reason_code TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('recorded','completed','failed')),
          result TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER, reason_text TEXT
            CHECK(
              reason_text IS NULL OR
              (length(reason_text) BETWEEN 1 AND 500)
            ),
          PRIMARY KEY(scope_id, request_id),
          CHECK((target_kind = 'job') = (target_job_id IS NOT NULL)),
          CHECK((widget_instance_present = 1) = (widget_instance_digest IS NOT NULL)),
          CHECK((caller_presentation_kind = 'automatic') = (caller_presentation_id IS NOT NULL))
        ) STRICT;
CREATE TABLE codex_question_deliveries (
    scope_id TEXT NOT NULL, request_id TEXT NOT NULL, question_ref TEXT NOT NULL,
    action_hash TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(scope_id, request_id), UNIQUE(scope_id, question_ref)
  ) STRICT;
CREATE TABLE completion_outbox (
          outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
          completion_version INTEGER NOT NULL CHECK(completion_version >= 1),
          channel TEXT NOT NULL CHECK(channel IN ('notify','verify')),
          payload TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
          next_attempt_at INTEGER,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          delivered_at INTEGER,
          acknowledged_at INTEGER,
          created_at INTEGER NOT NULL,
          UNIQUE(activity_id, completion_version, channel)
        ) STRICT;
CREATE TABLE event_budget(id INTEGER PRIMARY KEY CHECK(id=1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT;
INSERT INTO "event_budget" VALUES(1,0,0);
CREATE TABLE job_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
          scope_version INTEGER NOT NULL CHECK(scope_version >= 1),
          event_type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
CREATE TABLE job_summaries(job_id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE "jobs" (
            job_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
            request_id TEXT NOT NULL,
            activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
            thread_id TEXT,
            status TEXT NOT NULL CHECK(status IN (
              'running','terminating','termination-failed','completed','failed','interrupted','cancelled'
            )),
            execution_mode TEXT NOT NULL CHECK(execution_mode IN ('auto','foreground','background')),
            backend_kind TEXT NOT NULL,
            bridge_instance_id TEXT,
            worker_id TEXT,
            worker_generation INTEGER,
            upstream_request_id TEXT,
            terminal_version INTEGER,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER,
            payload TEXT NOT NULL, agent_id TEXT REFERENCES agents(agent_id), context_mode TEXT CHECK(context_mode IN ('continue','fork','fresh')), project_id TEXT, project_label TEXT, project_uuid TEXT REFERENCES projects(project_id), project_name_snapshot TEXT, project_cwd_snapshot TEXT,
            UNIQUE(scope_id, request_id)
          ) STRICT;
CREATE TABLE project_registry (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          registry_revision INTEGER NOT NULL CHECK(registry_revision >= 0),
          updated_at INTEGER NOT NULL
        ) STRICT;
INSERT INTO "project_registry" VALUES(1,0,0);
CREATE TABLE "projects" (
            project_id TEXT PRIMARY KEY,
            project_ref TEXT NOT NULL UNIQUE,
            project_revision INTEGER NOT NULL CHECK(project_revision >= 1),
            name TEXT NOT NULL,
            name_key TEXT NOT NULL,
            cwd TEXT NOT NULL,
            sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER
          , deleted_at INTEGER) STRICT;
CREATE TABLE result_holds(job_id TEXT PRIMARY KEY, reason TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE scope_versions (
          scope_id TEXT PRIMARY KEY REFERENCES scopes(scope_id) ON DELETE CASCADE,
          version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
          updated_at INTEGER NOT NULL
        ) STRICT;
CREATE TABLE scopes (
          scope_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
CREATE TABLE sessions (
        thread_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      , project_id TEXT, project_label TEXT, project_uuid TEXT REFERENCES projects(project_id), project_name_snapshot TEXT) STRICT;
DELETE FROM "sqlite_sequence";
CREATE TABLE steering_deliveries (
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
          request_id TEXT NOT NULL,
          action_hash TEXT NOT NULL,
          job_id TEXT NOT NULL,
          expected_job_version INTEGER NOT NULL CHECK(expected_job_version >= 1),
          prompt_sha256 TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'prepared','dispatching','delivered','not-delivered','uncertain'
          )),
          bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
          result TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          dispatched_at INTEGER,
          completed_at INTEGER,
          PRIMARY KEY(scope_id, request_id),
          CHECK(length(action_hash) = 64),
          CHECK(length(prompt_sha256) = 64),
          CHECK((status IN ('prepared','dispatching')) = (completed_at IS NULL))
        ) STRICT;
CREATE TABLE thread_connections (
    thread_id TEXT PRIMARY KEY, agent_id TEXT, scope_id TEXT NOT NULL,
    persistence TEXT NOT NULL CHECK(persistence IN ('persistent','ephemeral','unknown')),
    phase TEXT NOT NULL, handoff_requested INTEGER NOT NULL DEFAULT 0,
    last_finished_at INTEGER, last_job_id TEXT, worker_pid INTEGER,
    revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
    reason TEXT, evidence TEXT
  ) STRICT;
CREATE TABLE transport_observations (
          observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK(kind IN (
            'http-request-aborted','http-response-detached','mcp-handler-aborted',
            'status-wait-aborted','activity-watch-aborted','presentation-superseded'
          )),
          scope_id TEXT,
          job_id TEXT,
          activity_id TEXT,
          tool_name TEXT,
          caller_request_digest TEXT,
          bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
          reason_code TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
CREATE TABLE user_questions (
    question_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, request_id TEXT NOT NULL,
    response_ref TEXT UNIQUE, expires_at INTEGER NOT NULL, payload TEXT NOT NULL,
    UNIQUE(scope_id, request_id)
  ) STRICT;
CREATE TABLE user_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        payload TEXT NOT NULL
      , settings_revision INTEGER NOT NULL DEFAULT 0
          CHECK(settings_revision >= 0), updated_at INTEGER) STRICT;
CREATE TABLE work_history_state (
    job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
    acknowledged_at INTEGER,
    expired_at INTEGER
  ) STRICT;
CREATE INDEX sessions_scope_recent
        ON sessions(scope_id, last_used_at DESC);
CREATE INDEX activity_events_activity_cursor ON activity_events(activity_id, event_id);
CREATE INDEX activity_events_scope_cursor ON activity_events(scope_id, scope_version, event_id);
CREATE INDEX job_events_job_cursor ON job_events(job_id, event_id);
CREATE INDEX job_events_scope_cursor ON job_events(scope_id, scope_version, event_id);
CREATE INDEX completion_outbox_pending
          ON completion_outbox(delivered_at, next_attempt_at, created_at);
CREATE INDEX activities_scope_recent ON activities(scope_id, updated_at DESC);
CREATE INDEX activities_scope_attention
            ON activities(scope_id, waiting_on, verification, updated_at DESC);
CREATE INDEX jobs_scope_recent ON jobs(scope_id, updated_at DESC);
CREATE INDEX jobs_status_recent ON jobs(status, updated_at DESC);
CREATE INDEX jobs_activity_recent ON jobs(activity_id, updated_at DESC);
CREATE INDEX jobs_thread_recent ON jobs(thread_id, updated_at DESC);
CREATE INDEX agents_scope_state_recent
            ON agents(scope_id, lifecycle, updated_at DESC);
CREATE INDEX agent_threads_agent_history
            ON agent_threads(agent_id, linked_at ASC);
CREATE UNIQUE INDEX agent_threads_one_current
            ON agent_threads(agent_id) WHERE is_current = 1;
CREATE INDEX activity_agents_activity_history
            ON activity_agents(activity_id, assigned_at ASC);
CREATE INDEX activity_agents_agent_history
            ON activity_agents(agent_id, assigned_at ASC);
CREATE UNIQUE INDEX activity_agents_active_pair
            ON activity_agents(activity_id, agent_id) WHERE released_at IS NULL;
CREATE INDEX activities_continuation
            ON activities(continuation_of_activity_id, created_at ASC);
CREATE INDEX jobs_agent_recent ON jobs(agent_id, updated_at DESC);
CREATE INDEX activities_scope_project_recent
          ON activities(scope_id, project_id, updated_at DESC);
CREATE INDEX jobs_project_recent ON jobs(project_id, updated_at DESC);
CREATE INDEX cancellation_operations_target_job
          ON cancellation_operations(target_job_id, created_at ASC);
CREATE INDEX cancellation_operations_target_activity
          ON cancellation_operations(target_activity_id, created_at ASC);
CREATE INDEX cancellation_intents_operation
          ON cancellation_intents(scope_id, request_id, created_at ASC);
CREATE INDEX cancellation_intents_target_job
          ON cancellation_intents(target_job_id, created_at ASC);
CREATE INDEX cancellation_intents_target_activity
          ON cancellation_intents(target_activity_id, created_at ASC);
CREATE INDEX cancellation_intents_cascade
          ON cancellation_intents(cascade_id, created_at ASC);
CREATE INDEX transport_observations_recent
          ON transport_observations(created_at DESC, observation_id DESC);
CREATE INDEX activities_project_pin
          ON activities(project_uuid, project_cwd_snapshot, lifecycle);
CREATE INDEX jobs_project_pin
          ON jobs(project_uuid, project_cwd_snapshot, status);
CREATE INDEX agent_threads_project_pin
          ON agent_threads(project_uuid, project_cwd_snapshot, is_current);
CREATE INDEX steering_deliveries_job_recent
          ON steering_deliveries(job_id, created_at DESC);
CREATE INDEX steering_deliveries_status_recent
          ON steering_deliveries(status, updated_at DESC);
CREATE UNIQUE INDEX projects_active_name
            ON projects(name_key)
            WHERE archived_at IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX projects_active_cwd
            ON projects(cwd)
            WHERE archived_at IS NULL AND deleted_at IS NULL;
CREATE INDEX projects_ordered
            ON projects(deleted_at, archived_at, sort_order, created_at);
CREATE INDEX user_questions_expiry ON user_questions(expires_at);
CREATE INDEX thread_connections_idle ON thread_connections(phase, last_finished_at);
CREATE INDEX thread_connections_agent ON thread_connections(agent_id);
CREATE TRIGGER event_budget_insert AFTER INSERT ON job_events BEGIN
    UPDATE event_budget SET rows=rows+1,bytes=bytes+length(CAST(NEW.payload AS BLOB)) WHERE id=1; END;
CREATE TRIGGER event_budget_delete AFTER DELETE ON job_events BEGIN
    UPDATE event_budget SET rows=rows-1,bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE id=1; END;
CREATE TRIGGER event_budget_update AFTER UPDATE OF payload ON job_events BEGIN
    UPDATE event_budget SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE id=1; END;
CREATE INDEX work_history_expired ON work_history_state(expired_at);
CREATE INDEX automatic_recovery_scope ON automatic_recovery(scope_id,updated_at);
CREATE INDEX automatic_recovery_job ON automatic_recovery(job_id);
COMMIT;
