PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE bridge_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
INSERT INTO bridge_meta VALUES('schema_version','3');
INSERT INTO bridge_meta VALUES('schema_v2_migrated_at','2026-09-11T09:39:18.684Z');
INSERT INTO bridge_meta VALUES('schema_v3_migrated_at','2026-09-11T09:39:18.686Z');
CREATE TABLE sessions (
        thread_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
INSERT INTO sessions VALUES('v3-thread','11111111-1111-4111-8111-111111111111','/tmp/issue95-v3-project',100,'{"threadId":"v3-thread","scopeId":"11111111-1111-4111-8111-111111111111","cwd":"/tmp/issue95-v3-project","lastUsedAt":100}');
CREATE TABLE user_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        payload TEXT NOT NULL
      ) STRICT;
CREATE TABLE scopes (
          scope_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
INSERT INTO scopes VALUES('11111111-1111-4111-8111-111111111111',100,110);
CREATE TABLE scope_versions (
          scope_id TEXT PRIMARY KEY REFERENCES scopes(scope_id) ON DELETE CASCADE,
          version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
          updated_at INTEGER NOT NULL
        ) STRICT;
INSERT INTO scope_versions VALUES('11111111-1111-4111-8111-111111111111',2,110);
CREATE TABLE bridge_instances (
          instance_id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          stopped_at INTEGER,
          termination_reason TEXT,
          process_id INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
INSERT INTO bridge_instances VALUES('a2ec76d7-90f0-4a31-9e86-d4154d70d1c6',1789119558686,1789119558688,'clean-shutdown',16484,'{"schemaVersion":3}');
CREATE TABLE activity_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
          scope_version INTEGER NOT NULL CHECK(scope_version >= 1),
          event_type TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
INSERT INTO activity_events VALUES(1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',1,'activity-created',90,'{"kind":"implementation","executionMode":"auto","handoffPolicy":"none","completionTrigger":"manual"}');
INSERT INTO activity_events VALUES(2,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',2,'attention-required',110,'{"counts":{"total":1,"running":0,"completed":0,"failed":1,"interrupted":0,"cancelled":0,"terminal":1},"waitingOn":"orchestrator"}');
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
INSERT INTO job_events VALUES(1,'v3-job','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',2,'job-started','failed',110,'{"threadLinked":true,"terminalVersion":1,"backendKind":"app-server"}');
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
CREATE TABLE IF NOT EXISTS "activities" (
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
          ) STRICT;
INSERT INTO activities VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Published schema 3 activity','implementation','auto','none','manual','open','orchestrator','not-required',2,0,0,90,110,NULL,NULL,1,0,0,1,0,0,1);
CREATE TABLE IF NOT EXISTS "jobs" (
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
            payload TEXT NOT NULL,
            UNIQUE(scope_id, request_id)
          ) STRICT;
INSERT INTO jobs VALUES('v3-job','11111111-1111-4111-8111-111111111111','v3-request','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','v3-thread','failed','auto','app-server','a2ec76d7-90f0-4a31-9e86-d4154d70d1c6',NULL,NULL,NULL,1,110,NULL,'{"jobId":"v3-job","scopeId":"11111111-1111-4111-8111-111111111111","requestId":"v3-request","activityId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","threadId":"v3-thread","status":"failed","executionMode":"auto","backendKind":"app-server","createdAt":91,"updatedAt":110,"error":"V3_FAILURE: retained failure","result":{"content":[{"type":"text","text":"retained v3 result"}]},"bridgeInstanceId":"a2ec76d7-90f0-4a31-9e86-d4154d70d1c6","terminalVersion":1}');
INSERT INTO sqlite_sequence VALUES('activity_events',2);
INSERT INTO sqlite_sequence VALUES('job_events',1);
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
COMMIT;
