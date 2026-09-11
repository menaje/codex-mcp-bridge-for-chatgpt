import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

export const V18_SCOPE_ID = "11111111-1111-4111-8111-111111111111";
export const V18_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const V18_ACTIVITY_ID = "33333333-3333-4333-8333-333333333333";
export const V18_LEGACY_ACTIVITY_ID = "44444444-4444-4444-8444-444444444444";
export const V18_AGENT_ID = "55555555-5555-4555-8555-555555555555";
export const V18_LEGACY_AGENT_ID = "66666666-6666-4666-8666-666666666666";
export const V18_THREAD_ID = "thread-schema-18";
export const V18_LEGACY_THREAD_ID = "thread-legacy-project";
export const V18_RUNNING_JOB_ID = "job-schema-18-running";
export const V18_FAILED_JOB_ID = "job-schema-18-failed";
export const V18_LEGACY_JOB_ID = "job-schema-18-legacy-project";

const schema18 = readFileSync(
  new URL("../fixtures/state-schema-v18.sql", import.meta.url),
  "utf8"
);
const seededSchema3 = readFileSync(
  new URL("../fixtures/state-v3-seeded.sql", import.meta.url),
  "utf8"
);

/** Exact schema emitted by dev b1104aa, populated with representative v18 state. */
export function createSchema18Fixture(
  file: string,
  options: { malformedJobPayload?: boolean; projectCwd?: string; legacyCwd?: string } = {}
): void {
  const projectCwd = options.projectCwd ?? "/tmp/schema-18-original";
  const legacyCwd = options.legacyCwd ?? "/tmp/schema-18-legacy";
  const db = new Database(file);
  db.exec(schema18);
  db.prepare("INSERT INTO bridge_meta(key,value) VALUES ('schema_version','18')").run();
  db.prepare("INSERT INTO bridge_meta(key,value) VALUES ('work_history_review_revision','7')").run();
  db.prepare("INSERT INTO bridge_meta(key,value) VALUES (?,?)")
    .run(`work_history_review_seq:${V18_FAILED_JOB_ID}`, "6");
  db.prepare("INSERT INTO bridge_meta(key,value) VALUES ('work_history_cursor',?)")
    .run(JSON.stringify({ at: 40, id: V18_FAILED_JOB_ID }));
  db.prepare("INSERT INTO bridge_meta(key,value) VALUES ('work_history_cleanup',?)")
    .run(JSON.stringify({ at: 60, count: 2, total: 9 }));
  db.prepare("INSERT INTO bridge_meta(key,value) VALUES ('event_retention_policy','2')").run();
  db.prepare("INSERT INTO bridge_meta(key,value) VALUES ('event_retention_cursor','1')").run();
  db.prepare("INSERT INTO bridge_meta(key,value) VALUES (?,?)")
    .run(`runtime_problem_resolved:${V18_AGENT_ID}`, JSON.stringify({ revision: "runtime-revision", at: 55 }));

  db.prepare("INSERT INTO project_registry(singleton,registry_revision,updated_at) VALUES (1,3,30)").run();
  db.prepare(`INSERT INTO projects(
    project_id,project_ref,project_revision,name,name_key,cwd,sort_order,
    created_at,updated_at,archived_at,deleted_at
  ) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL)`).run(
    V18_PROJECT_ID,
    "prj_AAAAAAAAAAAAAAAAAAAAAA",
    3,
    "Schema 18 Project",
    "schema 18 project",
    projectCwd,
    0,
    10,
    30
  );
  db.prepare("INSERT INTO scopes(scope_id,created_at,updated_at) VALUES (?,?,?)")
    .run(V18_SCOPE_ID, 10, 90);
  db.prepare("INSERT INTO scope_versions(scope_id,version,updated_at) VALUES (?,?,?)")
    .run(V18_SCOPE_ID, 12, 90);
  db.prepare(`INSERT INTO bridge_instances(
    instance_id,started_at,stopped_at,termination_reason,process_id,payload
  ) VALUES ('fixture-instance',1,2,'clean-shutdown',1,'{}')`).run();
  db.prepare("INSERT INTO user_settings(singleton,payload,settings_revision,updated_at) VALUES (1,?,?,30)")
    .run(JSON.stringify({
      schemaVersion: 4,
      settingsRevision: 2,
      updatedAt: new Date(30).toISOString(),
      accessStrategy: "adaptive",
      modelPolicy: {
        mode: "automatic",
        allowedSelections: { kind: "catalog-visible" },
        constraints: { allowDelegation: true }
      },
      modelDescriptionOverrides: {},
      usePriorityServiceTier: false,
      uiLocalePreference: "auto",
      maxConcurrentJobs: 30,
      showBridgeThreadsInCodexApp: true,
      activityCardVisibility: "always",
      completionHandoff: "off",
      historyRetentionDays: 30
    }), 2);

  insertActivity(db, {
    activityId: V18_ACTIVITY_ID,
    title: "Schema 18 activity",
    projectId: V18_PROJECT_ID,
    projectName: "Stale project snapshot",
    projectCwd: projectCwd,
    counts: { total: 2, running: 1, failed: 1, terminal: 1 }
  });
  insertActivity(db, {
    activityId: V18_LEGACY_ACTIVITY_ID,
    title: "Unlinked legacy activity",
    projectId: "legacy-project-slug",
    projectName: "Legacy Project",
    projectCwd: legacyCwd,
    counts: { total: 1, completed: 1, terminal: 1 }
  });

  db.prepare(`INSERT INTO sessions(
    thread_id,scope_id,cwd,last_used_at,payload,project_id,project_label,
    project_uuid,project_name_snapshot
  ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    V18_THREAD_ID,
    V18_SCOPE_ID,
    projectCwd,
    80,
    JSON.stringify({
      threadId: V18_THREAD_ID,
      scopeId: V18_SCOPE_ID,
      backendKind: "app-server",
      cwd: projectCwd,
      sandbox: "danger-full-access",
      sessionId: "session-v18",
      persistence: "persistent",
      visibleInCodexApp: true,
      selection: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      policyRevision: 4,
      projectId: V18_PROJECT_ID,
      projectLabel: "Stale project snapshot",
      createdAt: 20,
      updatedAt: 70,
      lastUsedAt: 80
    }),
    V18_PROJECT_ID,
    "Stale project snapshot",
    V18_PROJECT_ID,
    "Older project snapshot"
  );
  db.prepare(`INSERT INTO sessions(
    thread_id,scope_id,cwd,last_used_at,payload,project_id,project_label,
    project_uuid,project_name_snapshot
  ) VALUES (?,?,?,?,?,?,?,NULL,?)`).run(
    V18_LEGACY_THREAD_ID,
    V18_SCOPE_ID,
    legacyCwd,
    81,
    JSON.stringify({
      threadId: V18_LEGACY_THREAD_ID,
      scopeId: V18_SCOPE_ID,
      backendKind: "app-server",
      cwd: legacyCwd,
      sandbox: "workspace-write",
      projectId: "legacy-project-slug",
      projectLabel: "Legacy Project",
      createdAt: 21,
      updatedAt: 71,
      lastUsedAt: 81
    }),
    "legacy-project-slug",
    "Legacy Project",
    "Legacy Project"
  );

  db.prepare(`INSERT INTO agents(
    agent_id,scope_id,agent_name,normalized_name,lifecycle,current_thread_id,
    current_job_id,version,created_at,updated_at,archived_at,orphaned_reason
  ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`).run(
    V18_AGENT_ID,
    V18_SCOPE_ID,
    "Schema Agent",
    "schema agent",
    "waiting-input",
    V18_THREAD_ID,
    V18_RUNNING_JOB_ID,
    4,
    20,
    80
  );
  db.prepare(`INSERT INTO agents(
    agent_id,scope_id,agent_name,normalized_name,lifecycle,current_thread_id,
    current_job_id,version,created_at,updated_at,archived_at,orphaned_reason
  ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`).run(
    V18_LEGACY_AGENT_ID,
    V18_SCOPE_ID,
    "Legacy Context Agent",
    "legacy context agent",
    "active",
    V18_LEGACY_THREAD_ID,
    V18_LEGACY_JOB_ID,
    2,
    21,
    81
  );
  insertAgentThread(db, V18_THREAD_ID, V18_AGENT_ID, V18_PROJECT_ID, "Stale project snapshot", projectCwd);
  insertAgentThread(db, V18_LEGACY_THREAD_ID, V18_LEGACY_AGENT_ID, "legacy-project-slug", "Legacy Project", legacyCwd);
  db.prepare(`INSERT INTO activity_agents(
    assignment_id,activity_id,agent_id,role,context_mode,assigned_at,released_at
  ) VALUES (?,?,?,?,?,?,NULL)`).run(
    "assignment-v18",
    V18_ACTIVITY_ID,
    V18_AGENT_ID,
    "primary",
    "continue",
    25
  );

  insertJob(db, {
    jobId: V18_RUNNING_JOB_ID,
    requestId: "request-v18-running",
    activityId: V18_ACTIVITY_ID,
    threadId: V18_THREAD_ID,
    status: "running",
    agentId: V18_AGENT_ID,
    projectId: V18_PROJECT_ID,
    projectName: "Stale project snapshot",
    cwd: projectCwd,
    updatedAt: 80,
    payload: options.malformedJobPayload
      ? "not-json"
      : JSON.stringify({
          jobId: V18_RUNNING_JOB_ID,
          scopeId: V18_SCOPE_ID,
          requestId: "request-v18-running",
          activityId: V18_ACTIVITY_ID,
          threadId: V18_THREAD_ID,
          sourceThreadId: "source-thread-v18",
          status: "running",
          executionMode: "background",
          backendKind: "app-server",
          bridgeInstanceId: "fixture-instance",
          agentId: V18_AGENT_ID,
          contextMode: "continue",
          projectId: V18_PROJECT_ID,
          projectLabel: "Stale project snapshot",
          cwd: projectCwd,
          sandbox: "danger-full-access",
          createdAt: 40,
          updatedAt: 80,
          version: 4,
          lastProgressAt: 79,
          lastProgress: { phase: "waiting" },
          pendingInteractions: [{ interactionId: "question-v18", isBlocking: true, kind: "question" }],
          publicEvents: [{ type: "message", summary: "retained event" }]
        })
  });
  insertJob(db, {
    jobId: V18_FAILED_JOB_ID,
    requestId: "request-v18-failed",
    activityId: V18_ACTIVITY_ID,
    threadId: V18_THREAD_ID,
    status: "failed",
    agentId: V18_AGENT_ID,
    projectId: V18_PROJECT_ID,
    projectName: "Stale project snapshot",
    cwd: projectCwd,
    updatedAt: 70,
    archivedAt: 75,
    terminalVersion: 1,
    payload: JSON.stringify({
      jobId: V18_FAILED_JOB_ID,
      scopeId: V18_SCOPE_ID,
      requestId: "request-v18-failed",
      activityId: V18_ACTIVITY_ID,
      threadId: V18_THREAD_ID,
      status: "failed",
      executionMode: "background",
      backendKind: "app-server",
      projectId: V18_PROJECT_ID,
      projectLabel: "Stale project snapshot",
      cwd: projectCwd,
      sandbox: "danger-full-access",
      createdAt: 30,
      updatedAt: 70,
      version: 2,
      terminalOrigin: "upstream-failure",
      error: "FIXTURE_FAILURE: retained failure"
    })
  });
  insertJob(db, {
    jobId: V18_LEGACY_JOB_ID,
    requestId: "request-v18-legacy",
    activityId: V18_LEGACY_ACTIVITY_ID,
    threadId: V18_LEGACY_THREAD_ID,
    status: "completed",
    agentId: V18_LEGACY_AGENT_ID,
    projectId: "legacy-project-slug",
    projectName: "Legacy Project",
    cwd: legacyCwd,
    updatedAt: 65,
    archivedAt: 66,
    terminalVersion: 1,
    payload: JSON.stringify({
      jobId: V18_LEGACY_JOB_ID,
      scopeId: V18_SCOPE_ID,
      requestId: "request-v18-legacy",
      activityId: V18_LEGACY_ACTIVITY_ID,
      threadId: V18_LEGACY_THREAD_ID,
      status: "completed",
      executionMode: "background",
      backendKind: "app-server",
      projectId: "legacy-project-slug",
      projectLabel: "Legacy Project",
      createdAt: 50,
      updatedAt: 65,
      version: 2,
      result: { content: [{ type: "text", text: "legacy result receipt" }] }
    })
  });

  db.prepare("INSERT INTO job_summaries(job_id,payload) VALUES (?,?)")
    .run(V18_FAILED_JOB_ID, JSON.stringify({
      status: "failed",
      endedAt: 70,
      durationMs: 40,
      errorCode: "FIXTURE_FAILURE",
      obsoleteProjection: { removed: true },
      execution: { model: "fixture-model", reasoningEffort: "high" },
      usage: { basis: "cumulative-difference", tokens: { inputTokens: 10, outputTokens: 2 } },
      uncertainResponseReview: { count: 1, latestUpdateAt: 71, reviewedAt: 72 }
    }));
  db.prepare("INSERT INTO work_history_state(job_id,acknowledged_at,expired_at) VALUES (?,?,NULL)")
    .run(V18_FAILED_JOB_ID, 72);
  db.prepare("INSERT INTO result_holds(job_id,reason,expires_at) VALUES (?,?,?)")
    .run(V18_FAILED_JOB_ID, "review", 9_000_000_000_000);
  db.prepare(`INSERT INTO job_events(
    job_id,activity_id,scope_id,scope_version,event_type,status,created_at,payload
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    V18_RUNNING_JOB_ID,
    V18_ACTIVITY_ID,
    V18_SCOPE_ID,
    11,
    "app-message-completed",
    "running",
    78,
    JSON.stringify({ type: "message", summary: "retained event" })
  );
  db.prepare(`INSERT INTO activity_events(
    activity_id,scope_id,scope_version,event_type,created_at,payload
  ) VALUES (?,?,?,?,?,?)`).run(V18_ACTIVITY_ID, V18_SCOPE_ID, 10, "attention-required", 77, "{}");

  db.prepare(`INSERT INTO completion_outbox(
    activity_id,scope_id,completion_version,channel,payload,attempt_count,
    next_attempt_at,lease_owner,lease_expires_at,delivered_at,acknowledged_at,created_at
  ) VALUES (?,?,1,'notify','{}',0,NULL,NULL,NULL,NULL,NULL,?)`).run(V18_ACTIVITY_ID, V18_SCOPE_ID, 70);
  db.prepare("INSERT INTO agent_mutations(scope_id,request_id,action_hash,result,created_at) VALUES (?,?,?,?,?)")
    .run(V18_SCOPE_ID, "agent-mutation-request", "agent-action", "{}", 50);

  insertCancellationState(db);
  db.prepare(`INSERT INTO steering_deliveries(
    scope_id,request_id,action_hash,job_id,expected_job_version,prompt_sha256,
    status,bridge_instance_id,result,created_at,updated_at,dispatched_at,completed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    V18_SCOPE_ID,
    "99999999-9999-4999-8999-999999999999",
    "a".repeat(64),
    V18_RUNNING_JOB_ID,
    4,
    "b".repeat(64),
    "uncertain",
    "fixture-instance",
    JSON.stringify({ delivery: { status: "uncertain" } }),
    81,
    82,
    81,
    82
  );
  db.prepare(`INSERT INTO transport_observations(
    kind,scope_id,job_id,activity_id,tool_name,caller_request_digest,
    bridge_instance_id,reason_code,created_at
  ) VALUES ('status-wait-aborted',?,?,?,?,?,?,?,?)`).run(
    V18_SCOPE_ID,
    V18_RUNNING_JOB_ID,
    V18_ACTIVITY_ID,
    "codex_status",
    "digest",
    "fixture-instance",
    "caller-aborted",
    83
  );
  db.prepare("INSERT INTO user_questions(question_id,scope_id,request_id,response_ref,expires_at,payload) VALUES (?,?,?,?,?,?)")
    .run("question-v18", V18_SCOPE_ID, "question-request-v18", "question-ref-v18", 9_000_000_000_000, JSON.stringify({ state: "pending" }));
  db.prepare("INSERT INTO codex_question_deliveries(scope_id,request_id,question_ref,action_hash,status,created_at) VALUES (?,?,?,?,?,?)")
    .run(V18_SCOPE_ID, "question-delivery-v18", "question-ref-v18", "question-action", "prepared", 84);
  db.prepare(`INSERT INTO thread_connections(
    thread_id,agent_id,scope_id,persistence,phase,handoff_requested,last_finished_at,
    last_job_id,worker_pid,revision,updated_at,reason,evidence
  ) VALUES (?,?,?,'persistent','blocked',0,NULL,?,123,2,80,'pending-interaction',NULL)`).run(
    V18_THREAD_ID,
    V18_AGENT_ID,
    V18_SCOPE_ID,
    V18_RUNNING_JOB_ID
  );
  db.prepare(`INSERT INTO automatic_recovery(
    recovery_key,scope_id,agent_id,job_id,kind,state,attempts,created_at,
    updated_at,next_attempt_at,reason,evidence
  ) VALUES (?,?,?,?,?,'retrying',1,?,?,?,'unconfirmed',NULL)`).run(
    "recovery-v18",
    V18_SCOPE_ID,
    V18_AGENT_ID,
    V18_RUNNING_JOB_ID,
    "recheck",
    85,
    86,
    90
  );
  db.prepare("INSERT INTO automatic_recovery_incidents(identity_key,recovery_key,agent_id,active,updated_at) VALUES (?,?,?,?,?)")
    .run("incident-v18", "recovery-v18", V18_AGENT_ID, 1, 86);
  db.close();
}

/** Exact data/schema dump created by published tag v0.3.0 (schema 3). */
export function createSeededSchema3Fixture(file: string): void {
  const db = new Database(file);
  db.exec(seededSchema3);
  db.close();
}

function insertActivity(
  db: Database.Database,
  input: {
    activityId: string;
    title: string;
    projectId: string;
    projectName: string;
    projectCwd: string;
    counts: Partial<Record<"total" | "running" | "completed" | "failed" | "interrupted" | "cancelled" | "terminal", number>>;
  }
): void {
  const counts = { total: 0, running: 0, completed: 0, failed: 0, interrupted: 0, cancelled: 0, terminal: 0, ...input.counts };
  db.prepare(`INSERT INTO activities(
    activity_id,scope_id,title,kind,execution_mode,handoff_policy,completion_trigger,
    lifecycle,waiting_on,verification,version,completion_version,legacy,created_at,
    updated_at,sealed_at,completed_at,total_jobs,running_jobs,completed_jobs,failed_jobs,
    interrupted_jobs,cancelled_jobs,terminal_jobs,continuation_of_activity_id,
    card_generation,project_id,project_label,project_cwd,project_uuid,
    project_name_snapshot,project_cwd_snapshot
  ) VALUES (?,?,?,'implementation','background','notify','manual','open','user',
    'not-required',3,1,0,20,80,NULL,NULL,?,?,?,?,?,?,?,NULL,2,?,?,?,?,?,?)`).run(
    input.activityId,
    V18_SCOPE_ID,
    input.title,
    counts.total,
    counts.running,
    counts.completed,
    counts.failed,
    counts.interrupted,
    counts.cancelled,
    counts.terminal,
    input.projectId,
    input.projectName,
    input.projectCwd,
    input.projectId === V18_PROJECT_ID ? V18_PROJECT_ID : null,
    input.projectName,
    input.projectCwd
  );
}

function insertAgentThread(
  db: Database.Database,
  threadId: string,
  agentId: string,
  projectId: string,
  projectName: string,
  cwd: string
): void {
  db.prepare(`INSERT INTO agent_threads(
    thread_id,agent_id,scope_id,backend_kind,cwd,sandbox,context_mode,is_current,
    linked_at,replaced_at,forked_from_thread_id,project_id,project_label,session_id,
    project_uuid,project_name_snapshot,project_cwd_snapshot
  ) VALUES (?,?,?,'app-server',?,'danger-full-access','continue',1,30,NULL,NULL,?,?,?, ?,?,?)`).run(
    threadId,
    agentId,
    V18_SCOPE_ID,
    cwd,
    projectId,
    projectName,
    `session-${agentId.slice(0, 8)}`,
    projectId === V18_PROJECT_ID ? V18_PROJECT_ID : null,
    projectName,
    cwd
  );
}

function insertJob(
  db: Database.Database,
  input: {
    jobId: string;
    requestId: string;
    activityId: string;
    threadId: string;
    status: string;
    agentId: string;
    projectId: string;
    projectName: string;
    cwd: string;
    updatedAt: number;
    archivedAt?: number;
    terminalVersion?: number;
    payload: string;
  }
): void {
  db.prepare(`INSERT INTO jobs(
    job_id,scope_id,request_id,activity_id,thread_id,status,execution_mode,backend_kind,
    bridge_instance_id,worker_id,worker_generation,upstream_request_id,terminal_version,
    updated_at,archived_at,payload,agent_id,context_mode,project_id,project_label,
    project_uuid,project_name_snapshot,project_cwd_snapshot
  ) VALUES (?,?,?,?,?,?,'background','app-server','fixture-instance','worker-v18',2,
    'turn-v18',?,?,?,?,?,'continue',?,?,?,?,?)`).run(
    input.jobId,
    V18_SCOPE_ID,
    input.requestId,
    input.activityId,
    input.threadId,
    input.status,
    input.terminalVersion ?? null,
    input.updatedAt,
    input.archivedAt ?? null,
    input.payload,
    input.agentId,
    input.projectId,
    input.projectName,
    input.projectId === V18_PROJECT_ID ? V18_PROJECT_ID : null,
    input.projectName,
    input.cwd
  );
}

function insertCancellationState(db: Database.Database): void {
  const requestId = "77777777-7777-4777-8777-777777777777";
  const intentId = "88888888-8888-4888-8888-888888888888";
  db.prepare(`INSERT INTO cancellation_operations(
    scope_id,request_id,root_intent_id,action_hash,source,tool_name,action_name,
    target_kind,target_job_id,target_activity_id,target_agent_id,target_thread_id,
    target_turn_id,target_presentation_id,expected_version,caller_presentation_kind,
    caller_presentation_id,widget_instance_present,widget_instance_digest,card_generation,
    caller_request_digest,bridge_instance_id,reason_code,status,result,created_at,
    completed_at,reason_text
  ) VALUES (?,?,?,?, 'model-tool','codex_cancel','cancel','job',?,?,?,?,NULL,NULL,4,
    NULL,NULL,0,NULL,NULL,NULL,'fixture-instance','user-requested','recorded',NULL,81,NULL,?)`).run(
    V18_SCOPE_ID,
    requestId,
    intentId,
    "cancel-action",
    V18_RUNNING_JOB_ID,
    V18_ACTIVITY_ID,
    V18_AGENT_ID,
    V18_THREAD_ID,
    "Stop this fixture"
  );
  db.prepare(`INSERT INTO cancellation_intents(
    intent_id,scope_id,request_id,parent_intent_id,cascade_id,source,tool_name,
    action_name,target_kind,target_job_id,target_activity_id,target_agent_id,
    target_thread_id,target_turn_id,target_presentation_id,expected_version,
    caller_presentation_kind,caller_presentation_id,widget_instance_present,
    widget_instance_digest,card_generation,caller_request_digest,bridge_instance_id,
    reason_code,status,created_at,dispatched_at,completed_at
  ) VALUES (?,?,?,NULL,?,'model-tool','codex_cancel','cancel','job',?,?,?,?,NULL,NULL,4,
    NULL,NULL,0,NULL,NULL,NULL,'fixture-instance','user-requested','dispatched',81,82,NULL)`).run(
    intentId,
    V18_SCOPE_ID,
    requestId,
    intentId,
    V18_RUNNING_JOB_ID,
    V18_ACTIVITY_ID,
    V18_AGENT_ID,
    V18_THREAD_ID
  );
}
