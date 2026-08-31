import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  ACTIVITY_COMPLETION_TRIGGERS,
  ACTIVITY_EXECUTION_MODES,
  ACTIVITY_HANDOFF_POLICIES,
  ACTIVITY_JOB_STATUSES,
  ACTIVITY_KINDS,
  ACTIVITY_LIFECYCLES,
  ACTIVITY_VERIFICATION_STATES,
  ACTIVITY_WAITING_ON,
  deriveActivityBarrier,
  isActiveActivityJobStatus,
  isTerminalActivityJobStatus,
  valueIsOneOf,
  type ActivityCompletionTrigger,
  type ActivityExecutionMode,
  type ActivityHandoffPolicy,
  type ActivityJobCounts,
  type ActivityKind,
  type ActivityVerificationEvidence,
  type ActivityVerificationState,
  type BridgeActivity
} from "./activity.js";
import {
  AGENT_CONTEXT_MODES,
  AGENT_LIFECYCLES,
  isAgentContextMode,
  isAgentLifecycle,
  normalizeAgentName,
  type ActivityAgentAssignment,
  type AgentContextMode,
  type BridgeAgent,
  type BridgeAgentLifecycle,
  type BridgeAgentThread
} from "./agent.js";
import {
  MAX_REGISTERED_PROJECTS,
  PROJECT_ARCHIVED,
  PROJECT_CWD_CONFLICT,
  PROJECT_CWD_STILL_PINNED,
  PROJECT_LIMIT_EXCEEDED,
  PROJECT_NAME_CONFLICT,
  PROJECT_NOT_FOUND,
  PROJECT_OPERATION_CONFLICT,
  PROJECT_REGISTRY_CHANGED,
  PROJECT_REGISTRY_REVISION_CONFLICT,
  PROJECT_SETUP_REQUIRED,
  PROJECT_UNAVAILABLE,
  canonicalProjectCwd,
  createProjectRef,
  PROJECT_CONTEXT_CONFLICT,
  normalizeProjectId,
  normalizeProjectLabel,
  normalizeProjectName,
  normalizeProjectRef,
  projectNameKey,
  type ProjectRegistryOperation,
  type ProjectRegistrySnapshot,
  type RuntimeProjectSelection,
  type ProjectTarget
} from "./projectRegistry.js";
import {
  CANCELLATION_SOURCES,
  JOB_TERMINAL_ORIGINS,
  type BeginCancellationOperationInput,
  type CancellationIntentRecord,
  type CancellationIntentStatus,
  type CancellationOperationRecord,
  type CancellationOperationStatus,
  type CancellationPresentation,
  type CancellationSource,
  type CancellationTarget,
  type CreateCancellationIntentInput,
  type JobTerminalOrigin
} from "./cancellation.js";

const CURRENT_SCHEMA_VERSION = "10";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANCELLATION_REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TRANSPORT_OBSERVATION_LIMIT = 1_000;

type SessionRowInput = {
  threadId: string;
  scopeId: string;
  cwd: string;
  projectId?: string;
  projectLabel?: string;
  lastUsedAt: number;
};

type JobRowInput = {
  jobId: string;
  scopeId: string;
  requestId: string;
  status: string;
  updatedAt: number;
  sourceThreadId?: string;
  activityId?: string;
  threadId?: string;
  executionMode?: ActivityExecutionMode;
  backendKind?: string;
  bridgeInstanceId?: string;
  workerId?: string;
  workerGeneration?: number;
  upstreamRequestId?: string;
  terminalVersion?: number;
  agentId?: string;
  contextMode?: AgentContextMode;
  projectId?: string;
  projectLabel?: string;
  cwd?: string;
  sessionDecision?: { threadId?: string };
  terminalOrigin?: JobTerminalOrigin;
  cancellationIntentId?: string;
};

export type DashboardRetainedJobSummary = {
  jobId: string;
  scopeId: string;
  activityId: string;
  agentId?: string;
  backendKind?: string;
  status: string;
  createdAt?: number;
  updatedAt: number;
  execution?: {
    model: string;
    reasoningEffort: string;
    reroutedModel?: string;
  };
};

type JsonRow = { payload: string };
type CountRow = { count: number };
type ProjectStorageRow = {
  project_id: string;
  project_ref: string;
  project_revision: number;
  name: string;
  name_key: string;
  cwd: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};
type LegacyProjectStorageRow = Omit<ProjectStorageRow, "project_ref" | "project_revision">;
type ProjectRegistryStorageRow = {
  registry_revision: number;
  updated_at: number;
};
export type SettingsStorageRecord = {
  settingsRevision: number;
  updatedAt: number | null;
  payload: unknown;
};
type JobStorageRow = JsonRow & {
  activity_id: string;
  thread_id: string | null;
  execution_mode: string;
  backend_kind: string;
  bridge_instance_id: string | null;
  worker_id: string | null;
  worker_generation: number | null;
  upstream_request_id: string | null;
  terminal_version: number | null;
  agent_id: string | null;
  context_mode: string | null;
  project_id: string | null;
  project_label: string | null;
  project_uuid: string | null;
  project_name_snapshot: string | null;
  project_cwd_snapshot: string | null;
};
type PreviousJobRow = {
  scope_id: string;
  activity_id: string;
  thread_id: string | null;
  status: string;
  backend_kind: string;
  bridge_instance_id: string | null;
  terminal_version: number | null;
  agent_id: string | null;
  context_mode: string | null;
  project_id: string | null;
  project_label: string | null;
  project_uuid: string | null;
  project_name_snapshot: string | null;
  project_cwd_snapshot: string | null;
  archived_at: number | null;
};
type ActivityStorageRow = {
  activity_id: string;
  scope_id: string;
  project_id: string | null;
  project_label: string | null;
  project_cwd: string | null;
  project_uuid: string | null;
  project_name_snapshot: string | null;
  project_cwd_snapshot: string | null;
  continuation_of_activity_id: string | null;
  card_generation: number;
  title: string;
  kind: string;
  execution_mode: string;
  handoff_policy: string;
  completion_trigger: string;
  lifecycle: string;
  waiting_on: string;
  verification: string;
  version: number;
  completion_version: number;
  legacy: number;
  created_at: number;
  updated_at: number;
  sealed_at: number | null;
  completed_at: number | null;
  total_jobs: number;
  running_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  interrupted_jobs: number;
  cancelled_jobs: number;
  terminal_jobs: number;
};

export type CreateActivityInput = {
  activityId?: string;
  scopeId: string;
  projectId?: string;
  projectLabel?: string;
  /** Internal canonical path; never include this in ordinary model-facing output. */
  projectCwd?: string;
  continuationOfActivityId?: string;
  title?: string;
  kind?: ActivityKind;
  executionMode?: ActivityExecutionMode;
  handoffPolicy?: ActivityHandoffPolicy;
  completionTrigger?: ActivityCompletionTrigger;
  legacy?: boolean;
  now?: number;
};

type AgentStorageRow = {
  agent_id: string;
  scope_id: string;
  agent_name: string;
  normalized_name: string;
  lifecycle: string;
  current_thread_id: string | null;
  current_job_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  orphaned_reason: string | null;
};

type AgentThreadStorageRow = {
  thread_id: string;
  session_id: string | null;
  agent_id: string;
  scope_id: string;
  project_id: string | null;
  project_label: string | null;
  project_uuid: string | null;
  project_name_snapshot: string | null;
  project_cwd_snapshot: string | null;
  backend_kind: string;
  cwd: string;
  sandbox: string;
  context_mode: string;
  is_current: number;
  linked_at: number;
  replaced_at: number | null;
  forked_from_thread_id: string | null;
};

export type ActivityProjectAdmission = {
  projectId: string;
  projectLabel: string;
  projectCwd: string;
};

type ActivityAgentStorageRow = {
  assignment_id: string;
  activity_id: string;
  agent_id: string;
  role: string;
  context_mode: string;
  assigned_at: number;
  released_at: number | null;
};

export type ActivityEventRecord = {
  eventId: number;
  activityId: string;
  scopeId: string;
  scopeVersion: number;
  eventType: string;
  createdAt: number;
  payload: unknown;
};

export type JobEventRecord = {
  eventId: number;
  jobId: string;
  activityId: string;
  scopeId: string;
  scopeVersion: number;
  eventType: string;
  status: string;
  createdAt: number;
  payload: unknown;
};

export type CompletionOutboxRecord = {
  outboxId: number;
  activityId: string;
  scopeId: string;
  completionVersion: number;
  channel: "notify" | "verify";
  payload: unknown;
  attemptCount: number;
  nextAttemptAt?: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  createdAt: number;
};

export type BridgeInstanceRecord = {
  instanceId: string;
  startedAt: number;
  stoppedAt?: number;
  terminationReason?: string;
  processId: number;
};

export const TRANSPORT_OBSERVATION_KINDS = [
  "http-request-aborted",
  "http-response-detached",
  "mcp-handler-aborted",
  "status-wait-aborted",
  "activity-watch-aborted",
  "presentation-superseded"
] as const;

export type TransportObservationKind = (typeof TRANSPORT_OBSERVATION_KINDS)[number];

export type TransportObservationRecord = {
  observationId: number;
  kind: TransportObservationKind;
  scopeId?: string;
  jobId?: string;
  activityId?: string;
  toolName?: string;
  callerRequestDigest?: string;
  bridgeInstanceId: string;
  reasonCode: string;
  createdAt: number;
};

export const STEERING_DELIVERY_STATUSES = [
  "prepared",
  "dispatching",
  "delivered",
  "not-delivered",
  "uncertain"
] as const;

export type SteeringDeliveryStatus = (typeof STEERING_DELIVERY_STATUSES)[number];

export type SteeringDeliveryRecord = {
  scopeId: string;
  requestId: string;
  actionHash: string;
  jobId: string;
  expectedJobVersion: number;
  promptSha256: string;
  status: SteeringDeliveryStatus;
  bridgeInstanceId: string;
  result?: unknown;
  createdAt: number;
  updatedAt: number;
  dispatchedAt?: number;
  completedAt?: number;
};

export type BeginSteeringDeliveryInput = {
  scopeId: string;
  requestId: string;
  actionHash: string;
  jobId: string;
  expectedJobVersion: number;
  promptSha256: string;
  now?: number;
};

export type BridgeStateStoreOptions = {
  file: string;
};

/**
 * Durable bridge state backed by one SQLite database. Registry snapshots are
 * retained for compatibility, while Activity/job state changes share one
 * transaction, one scope version, and an idempotent completion outbox.
 */
export class BridgeStateStore {
  private readonly database: Database.Database;
  private readonly currentInstanceId = randomUUID();
  private transactionDepth = 0;
  private closed = false;

  constructor(private readonly options: BridgeStateStoreOptions) {
    if (options.file !== ":memory:") {
      mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
    }
    this.database = new Database(options.file);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS bridge_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);

    const existingVersion = this.getMeta("schema_version");
    if (
      existingVersion !== undefined &&
      existingVersion !== "1" &&
      existingVersion !== "2" &&
      existingVersion !== "3" &&
      existingVersion !== "4" &&
      existingVersion !== "5" &&
      existingVersion !== "6" &&
      existingVersion !== "7" &&
      existingVersion !== "8" &&
      existingVersion !== "9" &&
      existingVersion !== CURRENT_SCHEMA_VERSION
    ) {
      this.database.close();
      throw new Error(`Unsupported bridge state database schema version: ${existingVersion}.`);
    }

    try {
      this.createV1Schema();
      if (existingVersion === undefined) this.setMeta("schema_version", "1");
      if ((existingVersion || "1") === "1") this.migrateV1ToV2();
      if (this.getMeta("schema_version") === "2") this.migrateV2ToV3();
      if (this.getMeta("schema_version") === "3") this.migrateV3ToV4();
      if (this.getMeta("schema_version") === "4") this.migrateV4ToV5();
      if (this.getMeta("schema_version") === "5") this.migrateV5ToV6();
      if (this.getMeta("schema_version") === "6") this.migrateV6ToV7();
      if (this.getMeta("schema_version") === "7") this.migrateV7ToV8();
      if (this.getMeta("schema_version") === "8") this.migrateV8ToV9();
      if (this.getMeta("schema_version") === "9") this.migrateV9ToV10();
      this.normalizeLegacyExecutionModes();
      this.registerBridgeInstance();
      this.enforcePrivateFileModes();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  get persistent(): boolean {
    return this.options.file !== ":memory:";
  }

  get persistencePath(): string | null {
    return this.persistent ? this.options.file : null;
  }

  get schemaVersion(): number {
    return Number(this.getMeta("schema_version"));
  }

  get bridgeInstanceId(): string {
    return this.currentInstanceId;
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.database.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  listSessions(): unknown[] {
    return this.database
      .prepare("SELECT payload FROM sessions ORDER BY last_used_at ASC")
      .all()
      .map((row) => parsePayload(row as JsonRow, "session"));
  }

  upsertSession(session: SessionRowInput): void {
    this.transaction(() => {
      this.ensureScope(session.scopeId, session.lastUsedAt);
      const project = normalizeProjectIdentity(session.projectId, session.projectLabel);
      const persistedSession = {
        ...session,
        ...(project || {})
      };
      this.database
        .prepare(`
          INSERT INTO sessions(
            thread_id, scope_id, cwd, project_id, project_label,
            project_uuid, project_name_snapshot, last_used_at, payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET
            scope_id = excluded.scope_id,
            cwd = excluded.cwd,
            project_id = excluded.project_id,
            project_label = excluded.project_label,
            project_uuid = excluded.project_uuid,
            project_name_snapshot = excluded.project_name_snapshot,
            last_used_at = excluded.last_used_at,
            payload = excluded.payload
        `)
        .run(
          session.threadId,
          session.scopeId,
          session.cwd,
          project?.projectId || null,
          project?.projectLabel || null,
          project?.projectId || null,
          project?.projectLabel || null,
          session.lastUsedAt,
          JSON.stringify(persistedSession)
        );
    });
  }

  deleteSession(threadId: string): void {
    this.database.prepare("DELETE FROM sessions WHERE thread_id = ?").run(threadId);
  }

  replaceSessions(sessions: SessionRowInput[]): void {
    this.transaction(() => {
      this.database.exec("DELETE FROM sessions");
      for (const session of sessions) this.upsertSession(session);
    });
  }

  countSessions(scopeId?: string): number {
    const row = scopeId
      ? this.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE scope_id = ?").get(scopeId)
      : this.database.prepare("SELECT COUNT(*) AS count FROM sessions").get();
    return Number((row as CountRow).count);
  }

  listJobs(): unknown[] {
    return this.database
      .prepare(`
        SELECT payload, activity_id, thread_id, execution_mode, backend_kind,
               bridge_instance_id, worker_id, worker_generation, upstream_request_id,
               terminal_version, agent_id, context_mode, project_id, project_label,
               project_uuid, project_name_snapshot, project_cwd_snapshot
          FROM jobs
         WHERE archived_at IS NULL
         ORDER BY updated_at ASC
      `)
      .all()
      .map((row) => hydrateJobPayload(row as JobStorageRow));
  }

  /**
   * Returns only the bounded, result-free fields needed by the global
   * dashboard after ordinary retained jobs have been pruned. Older archived
   * rows may not have a start time or execution selection; callers must not
   * infer those values from the agent's current session.
   */
  listDashboardRetainedJobs(limit = 10_000): DashboardRetainedJobSummary[] {
    const boundedLimit = Math.max(0, Math.min(100_000, Math.floor(limit)));
    if (boundedLimit === 0) return [];
    const rows = this.database
      .prepare(`
        SELECT job_id, scope_id, activity_id, agent_id, backend_kind,
               status, updated_at, payload
          FROM jobs
         WHERE archived_at IS NOT NULL
         ORDER BY updated_at DESC, job_id DESC
         LIMIT ?
      `)
      .all(boundedLimit) as Array<{
        job_id: string;
        scope_id: string;
        activity_id: string;
        agent_id: string | null;
        backend_kind: string | null;
        status: string;
        updated_at: number;
        payload: string;
      }>;
    return rows.map((row) => {
      const payload = parsePayload({ payload: row.payload }, "archived dashboard job");
      const summary = isRecord(payload) ? payload : {};
      const createdAt = finiteNumber(summary.createdAt);
      const execution = readDashboardRetainedExecution(summary);
      return {
        jobId: row.job_id,
        scopeId: row.scope_id,
        activityId: row.activity_id,
        ...(row.agent_id ? { agentId: row.agent_id } : {}),
        ...(row.backend_kind ? { backendKind: row.backend_kind } : {}),
        status: row.status,
        ...(createdAt !== undefined ? { createdAt } : {}),
        updatedAt: Number(row.updated_at),
        ...(execution ? { execution } : {})
      };
    });
  }

  upsertJob(job: JobRowInput): void {
    this.transaction(() => this.upsertJobInternal(job));
  }

  deleteJob(jobId: string): void {
    this.transaction(() => {
      const row = this.database
        .prepare(`
          SELECT job_id, scope_id, request_id, status, updated_at, activity_id,
                 terminal_version, payload
            FROM jobs
           WHERE job_id = ? AND archived_at IS NULL
        `)
        .get(jobId) as
        | {
            job_id: string;
            scope_id: string;
            request_id: string;
            status: string;
            updated_at: number;
            activity_id: string;
            terminal_version: number | null;
            payload: string;
          }
        | undefined;
      if (!row) return;
      const now = Date.now();
      const scopeVersion = this.nextScopeVersion(row.scope_id, now);
      const payload = parsePayload({ payload: row.payload }, "job");
      const dashboardFields = isRecord(payload)
        ? retainedDashboardJobFields(payload)
        : {};
      const retainedSummary = {
        jobId: row.job_id,
        scopeId: row.scope_id,
        requestId: row.request_id,
        activityId: row.activity_id,
        status: row.status,
        updatedAt: row.updated_at,
        terminalVersion: row.terminal_version || undefined,
        ...dashboardFields,
        archivedAt: now,
        resultOmitted: true
      };
      this.database
        .prepare("UPDATE jobs SET archived_at = ?, payload = ? WHERE job_id = ?")
        .run(now, JSON.stringify(retainedSummary), row.job_id);
      this.insertJobEvent({
        jobId: row.job_id,
        activityId: row.activity_id,
        scopeId: row.scope_id,
        scopeVersion,
        eventType: "retention-pruned",
        status: row.status,
        createdAt: now,
        payload: { resultBodyRetained: false }
      });
      this.touchActivity(row.activity_id, scopeVersion, now, "job-retention-pruned", {
        jobId: row.job_id
      });
    });
  }

  replaceJobs(jobs: JobRowInput[]): void {
    this.replaceJobsInternal(jobs, false);
  }

  /** Migration-only import for terminal rows created before durable cancellation intents existed. */
  importLegacyJobs(jobs: JobRowInput[]): void {
    this.replaceJobsInternal(jobs, true);
  }

  private replaceJobsInternal(
    jobs: JobRowInput[],
    allowLegacyUnattributedCancellation: boolean
  ): void {
    this.transaction(() => {
      const retainedIds = new Set(jobs.map((job) => job.jobId));
      const existing = this.database
        .prepare("SELECT job_id FROM jobs WHERE archived_at IS NULL")
        .all() as Array<{ job_id: string }>;
      for (const job of jobs) {
        this.upsertJobInternal(job, allowLegacyUnattributedCancellation);
      }
      for (const row of existing) {
        if (!retainedIds.has(row.job_id)) this.deleteJob(row.job_id);
      }
    });
  }

  countJobs(scopeId?: string, status?: string): number {
    let sql = "SELECT COUNT(*) AS count FROM jobs WHERE archived_at IS NULL";
    const parameters: string[] = [];
    if (scopeId) {
      sql += " AND scope_id = ?";
      parameters.push(scopeId);
    }
    if (status) {
      sql += " AND status = ?";
      parameters.push(status);
    }
    const row = this.database.prepare(sql).get(...parameters) as CountRow;
    return Number(row.count);
  }

  createActivity(input: CreateActivityInput): BridgeActivity {
    const activityId = normalizeUuid(input.activityId || randomUUID(), "activityId");
    const scopeId = normalizeUuid(input.scopeId, "scopeId");
    const kind = input.kind || "other";
    const executionMode = input.executionMode || "background";
    const handoffPolicy = input.handoffPolicy || "none";
    const completionTrigger = input.completionTrigger || "manual";
    assertActivityPolicy(kind, executionMode, handoffPolicy, completionTrigger);
    let project = normalizeActivityProjectAdmission(
      input.projectId,
      input.projectLabel,
      input.projectCwd
    );
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      if (this.getActivityRow(activityId)) throw new Error("Activity id already exists.");
      this.ensureScope(scopeId, now);
      let continuationOfActivityId: string | undefined;
      if (input.continuationOfActivityId) {
        continuationOfActivityId = normalizeUuid(
          input.continuationOfActivityId,
          "continuationOfActivityId"
        );
        const source = this.requireActivity(continuationOfActivityId);
        if (source.scopeId !== scopeId) {
          throw new Error("The continuation Activity belongs to another conversation scope.");
        }
        const sourceProject = this.getActivityProjectAdmission(source.activityId);
        // A continuation link preserves lineage, not necessarily filesystem
        // identity: a fresh context may deliberately start the new Activity in
        // another registered project. When no new admission is supplied, keep
        // the source project for continue/fork and compatibility callers.
        project ||= sourceProject;
      }
      const scopeVersion = this.nextScopeVersion(scopeId, now);
      this.insertActivity({
        activityId,
        scopeId,
        ...project,
        continuationOfActivityId,
        title: normalizeActivityTitle(input.title || "Codex activity"),
        kind,
        executionMode,
        handoffPolicy,
        completionTrigger,
        legacy: input.legacy || false,
        now
      });
      this.insertActivityEvent({
        activityId,
        scopeId,
        scopeVersion,
        eventType: "activity-created",
        createdAt: now,
        payload: {
          kind,
          executionMode,
          handoffPolicy,
          completionTrigger,
          projectId: project?.projectId || null,
          projectLabel: project?.projectLabel || null,
          continuationOfActivityId: continuationOfActivityId || null,
          cardGeneration: 1
        }
      });
      return this.requireActivity(activityId);
    });
  }

  getActivity(activityId: string): BridgeActivity | undefined {
    const row = this.getActivityRow(activityId);
    return row ? readActivityRow(row) : undefined;
  }

  getActivityProjectAdmission(activityId: string): ActivityProjectAdmission | undefined {
    const row = this.getActivityRow(activityId);
    if (!row) return undefined;
    return readActivityProjectAdmission(row);
  }

  listActivities(scopeId?: string, limit = 100, offset = 0): BridgeActivity[] {
    const boundedLimit = Math.max(0, Math.min(1_000, limit));
    const boundedOffset = Math.max(0, offset);
    const rows = scopeId
      ? this.database
          .prepare("SELECT * FROM activities WHERE scope_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
          .all(scopeId, boundedLimit, boundedOffset)
      : this.database
          .prepare("SELECT * FROM activities ORDER BY updated_at DESC LIMIT ? OFFSET ?")
          .all(boundedLimit, boundedOffset);
    return (rows as ActivityStorageRow[]).map(readActivityRow);
  }

  countActivities(scopeId?: string): number {
    const row = scopeId
      ? this.database.prepare("SELECT COUNT(*) AS count FROM activities WHERE scope_id = ?").get(scopeId)
      : this.database.prepare("SELECT COUNT(*) AS count FROM activities").get();
    return Number((row as { count?: number } | undefined)?.count || 0);
  }

  createAgent(input: {
    scopeId: string;
    agentId?: string;
    agentName: string;
    lifecycle?: BridgeAgentLifecycle;
    now?: number;
  }): BridgeAgent {
    const scopeId = normalizeUuid(input.scopeId, "agent scopeId");
    const agentId = normalizeUuid(input.agentId || randomUUID(), "agentId");
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      this.ensureScope(scopeId, now);
      if (this.getAgent(agentId)) throw new Error("Agent id already exists.");
      const { agentName, normalizedName } = normalizeAgentName(input.agentName);
      const lifecycle = input.lifecycle || "idle";
      if (!isAgentLifecycle(lifecycle)) throw new Error("Invalid Agent lifecycle.");
      try {
        this.database
          .prepare(`
            INSERT INTO agents(
              agent_id, scope_id, agent_name, normalized_name, lifecycle,
              current_thread_id, current_job_id, version, created_at, updated_at,
              archived_at, orphaned_reason
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, NULL, NULL)
          `)
          .run(agentId, scopeId, agentName, normalizedName, lifecycle, now, now);
      } catch (error) {
        if (String(error).includes("agents.scope_id, agents.normalized_name")) {
          throw new Error("AGENT_NAME_CONFLICT: Agent names must be unique in this conversation.");
        }
        throw error;
      }
      this.nextScopeVersion(scopeId, now);
      return this.requireAgent(agentId);
    });
  }

  getAgent(agentId: string): BridgeAgent | undefined {
    const row = this.database
      .prepare("SELECT * FROM agents WHERE agent_id = ?")
      .get(agentId) as AgentStorageRow | undefined;
    return row ? readAgentRow(row) : undefined;
  }

  getAgentForThread(threadId: string): BridgeAgent | undefined {
    const row = this.database
      .prepare(`
        SELECT a.* FROM agents a
        JOIN agent_threads t ON t.agent_id = a.agent_id
        WHERE t.thread_id = ?
      `)
      .get(threadId) as AgentStorageRow | undefined;
    return row ? readAgentRow(row) : undefined;
  }

  listAgents(scopeId?: string, includeArchived = false, limit = 100, offset = 0): BridgeAgent[] {
    const boundedLimit = Math.max(0, Math.min(1_000, limit));
    const boundedOffset = Math.max(0, offset);
    let sql = "SELECT * FROM agents";
    const parameters: Array<string | number> = [];
    const predicates: string[] = [];
    if (scopeId) {
      predicates.push("scope_id = ?");
      parameters.push(normalizeUuid(scopeId, "agent scopeId"));
    }
    if (!includeArchived) predicates.push("lifecycle <> 'archived'");
    if (predicates.length > 0) sql += ` WHERE ${predicates.join(" AND ")}`;
    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
    parameters.push(boundedLimit, boundedOffset);
    return (this.database.prepare(sql).all(...parameters) as AgentStorageRow[]).map(readAgentRow);
  }

  countAgents(scopeId?: string, includeArchived = false): number {
    let sql = "SELECT COUNT(*) AS count FROM agents";
    const parameters: string[] = [];
    const predicates: string[] = [];
    if (scopeId) {
      predicates.push("scope_id = ?");
      parameters.push(normalizeUuid(scopeId, "agent scopeId"));
    }
    if (!includeArchived) predicates.push("lifecycle <> 'archived'");
    if (predicates.length > 0) sql += ` WHERE ${predicates.join(" AND ")}`;
    return Number((this.database.prepare(sql).get(...parameters) as CountRow).count);
  }

  countAgentsByLifecycle(lifecycle: BridgeAgentLifecycle, scopeId?: string): number {
    if (!isAgentLifecycle(lifecycle)) throw new Error("Invalid Agent lifecycle.");
    let sql = "SELECT COUNT(*) AS count FROM agents WHERE lifecycle = ?";
    const parameters: string[] = [lifecycle];
    if (scopeId) {
      sql += " AND scope_id = ?";
      parameters.push(normalizeUuid(scopeId, "agent scopeId"));
    }
    return Number((this.database.prepare(sql).get(...parameters) as CountRow).count);
  }

  listAgentThreads(agentId: string): BridgeAgentThread[] {
    return (this.database
      .prepare("SELECT * FROM agent_threads WHERE agent_id = ? ORDER BY linked_at ASC")
      .all(agentId) as AgentThreadStorageRow[]).map(readAgentThreadRow);
  }

  linkAgentThread(input: {
    agentId: string;
    threadId: string;
    sessionId?: string;
    projectId?: string;
    projectLabel?: string;
    backendKind: string;
    cwd: string;
    sandbox: string;
    contextMode: AgentContextMode;
    forkedFromThreadId?: string;
    now?: number;
  }): BridgeAgentThread {
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      const agent = this.requireAgent(input.agentId);
      if (!isAgentContextMode(input.contextMode)) throw new Error("Invalid Agent context mode.");
      const threadId = normalizeRequiredString(input.threadId, "threadId", 200);
      const cwd = normalizeRequiredString(input.cwd, "working directory", 4_000);
      let project = normalizeProjectIdentity(input.projectId, input.projectLabel);
      const owner = this.getAgentForThread(threadId);
      if (owner && owner.agentId !== agent.agentId) {
        throw new Error("The Codex thread is already owned by another bridge Agent.");
      }
      const existingThread = this.database
        .prepare("SELECT * FROM agent_threads WHERE thread_id = ?")
        .get(threadId) as AgentThreadStorageRow | undefined;
      if (existingThread) {
        if (existingThread.cwd !== cwd) {
          throw new Error(
            `${PROJECT_CONTEXT_CONFLICT}: An admitted Agent thread cannot change working folders.`
          );
        }
        const existingProject = readThreadProjectIdentity(existingThread);
        if (
          existingProject &&
          project &&
          existingProject.projectId !== project.projectId
        ) {
          throw new Error(
            `${PROJECT_CONTEXT_CONFLICT}: An admitted Agent thread cannot change projects.`
          );
        }
        project ||= existingProject;
      }
      const forkedFromThreadId = input.forkedFromThreadId
        ? normalizeRequiredString(input.forkedFromThreadId, "forkedFromThreadId", 200)
        : undefined;
      const sessionId = input.sessionId
        ? normalizeRequiredString(input.sessionId, "sessionId", 200)
        : undefined;
      this.database
        .prepare(`
          UPDATE agent_threads
             SET is_current = 0, replaced_at = COALESCE(replaced_at, ?)
           WHERE agent_id = ? AND is_current = 1 AND thread_id <> ?
        `)
        .run(now, agent.agentId, threadId);
      this.database
        .prepare(`
          INSERT INTO agent_threads(
            thread_id, session_id, agent_id, scope_id, project_id, project_label,
            project_uuid, project_name_snapshot, project_cwd_snapshot,
            backend_kind, cwd, sandbox, context_mode,
            is_current, linked_at, replaced_at, forked_from_thread_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)
          ON CONFLICT(thread_id) DO UPDATE SET
            session_id = COALESCE(excluded.session_id, agent_threads.session_id),
            project_id = COALESCE(agent_threads.project_id, excluded.project_id),
            project_label = COALESCE(agent_threads.project_label, excluded.project_label),
            project_uuid = COALESCE(agent_threads.project_uuid, excluded.project_uuid),
            project_name_snapshot = COALESCE(
              agent_threads.project_name_snapshot,
              excluded.project_name_snapshot
            ),
            project_cwd_snapshot = COALESCE(
              agent_threads.project_cwd_snapshot,
              excluded.project_cwd_snapshot
            ),
            backend_kind = excluded.backend_kind,
            sandbox = excluded.sandbox,
            context_mode = excluded.context_mode,
            is_current = 1,
            replaced_at = NULL,
            forked_from_thread_id = COALESCE(excluded.forked_from_thread_id, agent_threads.forked_from_thread_id)
        `)
        .run(
          threadId,
          sessionId || null,
          agent.agentId,
          agent.scopeId,
          project?.projectId || null,
          project?.projectLabel || null,
          project?.projectId || null,
          project?.projectLabel || null,
          project ? cwd : null,
          normalizeRequiredString(input.backendKind, "backend kind", 100),
          cwd,
          normalizeRequiredString(input.sandbox, "sandbox", 100),
          input.contextMode,
          now,
          forkedFromThreadId || null
        );
      this.database
        .prepare(`
          UPDATE agents
             SET current_thread_id = ?, lifecycle = CASE WHEN lifecycle = 'orphaned' THEN 'idle' ELSE lifecycle END,
                 orphaned_reason = NULL, version = version + 1, updated_at = ?
           WHERE agent_id = ?
        `)
        .run(threadId, now, agent.agentId);
      this.nextScopeVersion(agent.scopeId, now);
      const row = this.database
        .prepare("SELECT * FROM agent_threads WHERE thread_id = ?")
        .get(threadId) as AgentThreadStorageRow;
      return readAgentThreadRow(row);
    });
  }

  assignAgent(input: {
    activityId: string;
    agentId: string;
    contextMode: AgentContextMode;
    role?: string;
    now?: number;
  }): ActivityAgentAssignment {
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      const activity = this.requireActivity(input.activityId);
      const agent = this.requireAgent(input.agentId);
      if (activity.scopeId !== agent.scopeId) {
        throw new Error("The Activity and Agent belong to different conversation scopes.");
      }
      if (agent.lifecycle === "archived") {
        throw new Error("The selected Agent is archived. Restore it before assigning work.");
      }
      if (!isAgentContextMode(input.contextMode)) throw new Error("Invalid Agent context mode.");
      const existing = this.database
        .prepare(`
          SELECT * FROM activity_agents
           WHERE activity_id = ? AND agent_id = ? AND released_at IS NULL
        `)
        .get(activity.activityId, agent.agentId) as ActivityAgentStorageRow | undefined;
      if (existing) return readActivityAgentRow(existing);
      const assignmentId = randomUUID();
      this.database
        .prepare(`
          INSERT INTO activity_agents(
            assignment_id, activity_id, agent_id, role, context_mode, assigned_at, released_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        `)
        .run(
          assignmentId,
          activity.activityId,
          agent.agentId,
          normalizeOptionalBoundedText(input.role, 80) || "primary",
          input.contextMode,
          now
        );
      this.nextScopeVersion(activity.scopeId, now);
      return readActivityAgentRow(
        this.database
          .prepare("SELECT * FROM activity_agents WHERE assignment_id = ?")
          .get(assignmentId) as ActivityAgentStorageRow
      );
    });
  }

  listActivityAgentAssignments(activityId?: string, agentId?: string): ActivityAgentAssignment[] {
    let sql = "SELECT * FROM activity_agents";
    const parameters: string[] = [];
    const predicates: string[] = [];
    if (activityId) {
      predicates.push("activity_id = ?");
      parameters.push(activityId);
    }
    if (agentId) {
      predicates.push("agent_id = ?");
      parameters.push(agentId);
    }
    if (predicates.length > 0) sql += ` WHERE ${predicates.join(" AND ")}`;
    sql += " ORDER BY assigned_at ASC";
    return (this.database.prepare(sql).all(...parameters) as ActivityAgentStorageRow[])
      .map(readActivityAgentRow);
  }

  listScopeActivityAgentAssignments(scopeId: string): ActivityAgentAssignment[] {
    const normalizedScopeId = normalizeUuid(scopeId, "assignment scopeId");
    return (this.database.prepare(`
      SELECT aa.*
        FROM activity_agents aa
        JOIN activities a ON a.activity_id = aa.activity_id
       WHERE a.scope_id = ?
       ORDER BY aa.assigned_at ASC, aa.assignment_id ASC
    `).all(normalizedScopeId) as ActivityAgentStorageRow[]).map(readActivityAgentRow);
  }

  releaseAgentAssignment(activityId: string, agentId: string, now = Date.now()): ActivityAgentAssignment | undefined {
    return this.transaction(() => {
      const activity = this.requireActivity(activityId);
      const agent = this.requireAgent(agentId);
      if (activity.scopeId !== agent.scopeId) {
        throw new Error("The Activity and Agent belong to different conversation scopes.");
      }
      const row = this.database
        .prepare(`
          SELECT * FROM activity_agents
           WHERE activity_id = ? AND agent_id = ? AND released_at IS NULL
        `)
        .get(activityId, agentId) as ActivityAgentStorageRow | undefined;
      if (!row) return undefined;
      this.database
        .prepare("UPDATE activity_agents SET released_at = ? WHERE assignment_id = ?")
        .run(now, row.assignment_id);
      this.nextScopeVersion(activity.scopeId, now);
      return { ...readActivityAgentRow(row), releasedAt: now };
    });
  }

  detachIdleAgentAssignment(input: {
    activityId: string;
    agentId: string;
    expectedAgentVersion: number;
    now?: number;
  }): {
    agent: BridgeAgent;
    assignment: ActivityAgentAssignment;
    alreadyReleased: boolean;
  } {
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      const activity = this.requireActivity(input.activityId);
      const agent = this.requireAgent(input.agentId);
      if (activity.scopeId !== agent.scopeId) {
        throw new Error("The Activity and Agent belong to different conversation scopes.");
      }
      if (agent.version !== input.expectedAgentVersion) {
        throw new Error(
          `AGENT_VERSION_CHANGED: Agent version changed from ${input.expectedAgentVersion} to ${agent.version}. Refresh authoritative state before retrying recovery detach.`
        );
      }
      if (agent.lifecycle === "active" || agent.lifecycle === "waiting-input" || agent.currentJobId) {
        throw new Error(
          `AGENT_BUSY: Agent has active job ${agent.currentJobId || "unknown"}. Force-stop that job and wait for terminal settlement before recovery detach.`
        );
      }

      const active = this.database
        .prepare(`
          SELECT * FROM activity_agents
           WHERE activity_id = ? AND agent_id = ? AND released_at IS NULL
        `)
        .get(activity.activityId, agent.agentId) as ActivityAgentStorageRow | undefined;
      if (!active) {
        const historical = this.database
          .prepare(`
            SELECT * FROM activity_agents
             WHERE activity_id = ? AND agent_id = ? AND released_at IS NOT NULL
             ORDER BY assigned_at DESC LIMIT 1
          `)
          .get(activity.activityId, agent.agentId) as ActivityAgentStorageRow | undefined;
        if (!historical) {
          throw new Error("The exact Activity assignment does not exist for this Agent.");
        }
        return {
          agent,
          assignment: readActivityAgentRow(historical),
          alreadyReleased: true
        };
      }

      this.database
        .prepare("UPDATE activity_agents SET released_at = ? WHERE assignment_id = ?")
        .run(now, active.assignment_id);
      this.database
        .prepare("UPDATE agents SET version = version + 1, updated_at = ? WHERE agent_id = ?")
        .run(now, agent.agentId);
      this.nextScopeVersion(activity.scopeId, now);
      return {
        agent: this.requireAgent(agent.agentId),
        assignment: { ...readActivityAgentRow(active), releasedAt: now },
        alreadyReleased: false
      };
    });
  }

  setAgentExecutionState(
    agentId: string,
    lifecycle: Extract<BridgeAgentLifecycle, "idle" | "active" | "waiting-input" | "orphaned">,
    options: { currentJobId?: string; orphanedReason?: string; now?: number } = {}
  ): BridgeAgent {
    const now = options.now ?? Date.now();
    return this.transaction(() => {
      const agent = this.requireAgent(agentId);
      if (agent.lifecycle === "archived") {
        throw new Error("An archived Agent must be restored before its execution state can change.");
      }
      const currentJobId = lifecycle === "active" || lifecycle === "waiting-input"
        ? normalizeRequiredString(options.currentJobId, "current job id", 200)
        : undefined;
      const orphanedReason = lifecycle === "orphaned"
        ? normalizeRequiredString(options.orphanedReason, "orphaned reason", 1_000)
        : undefined;
      this.database
        .prepare(`
          UPDATE agents SET lifecycle = ?, current_job_id = ?, orphaned_reason = ?,
                            version = version + 1, updated_at = ?
           WHERE agent_id = ?
        `)
        .run(lifecycle, currentJobId || null, orphanedReason || null, now, agent.agentId);
      this.nextScopeVersion(agent.scopeId, now);
      return this.requireAgent(agent.agentId);
    });
  }

  renameAgent(agentId: string, name: string, now = Date.now()): BridgeAgent {
    return this.transaction(() => {
      const agent = this.requireAgent(agentId);
      const { agentName, normalizedName } = normalizeAgentName(name);
      try {
        this.database
          .prepare(`
            UPDATE agents SET agent_name = ?, normalized_name = ?, version = version + 1, updated_at = ?
             WHERE agent_id = ?
          `)
          .run(agentName, normalizedName, now, agent.agentId);
      } catch (error) {
        if (String(error).includes("agents.scope_id, agents.normalized_name")) {
          throw new Error("AGENT_NAME_CONFLICT: Agent names must be unique in this conversation.");
        }
        throw error;
      }
      this.nextScopeVersion(agent.scopeId, now);
      return this.requireAgent(agent.agentId);
    });
  }

  archiveAgent(agentId: string, now = Date.now()): BridgeAgent {
    return this.transaction(() => {
      const agent = this.requireAgent(agentId);
      if (agent.lifecycle === "archived") return agent;
      if (agent.lifecycle === "active" || agent.lifecycle === "waiting-input" || agent.currentJobId) {
        throw new Error(
          `AGENT_BUSY: Agent has active job ${agent.currentJobId || "unknown"}. Force-stop that job before archiving; filesystem changes are not rolled back.`
        );
      }
      this.database
        .prepare(`
          UPDATE agents SET lifecycle = 'archived', archived_at = ?, version = version + 1,
                            updated_at = ? WHERE agent_id = ?
        `)
        .run(now, now, agent.agentId);
      this.nextScopeVersion(agent.scopeId, now);
      return this.requireAgent(agent.agentId);
    });
  }

  restoreAgent(agentId: string, now = Date.now()): BridgeAgent {
    return this.transaction(() => {
      const agent = this.requireAgent(agentId);
      if (agent.lifecycle !== "archived") return agent;
      this.database
        .prepare(`
          UPDATE agents SET lifecycle = CASE WHEN orphaned_reason IS NULL THEN 'idle' ELSE 'orphaned' END,
                            archived_at = NULL, version = version + 1, updated_at = ?
           WHERE agent_id = ?
        `)
        .run(now, agent.agentId);
      this.nextScopeVersion(agent.scopeId, now);
      return this.requireAgent(agent.agentId);
    });
  }

  getAgentMutation(scopeId: string, requestId: string): { actionHash: string; result: unknown } | undefined {
    const row = this.database
      .prepare("SELECT action_hash, result FROM agent_mutations WHERE scope_id = ? AND request_id = ?")
      .get(scopeId, requestId) as { action_hash: string; result: string } | undefined;
    return row
      ? {
          actionHash: row.action_hash,
          result: parsePayload({ payload: row.result }, "Agent mutation result")
        }
      : undefined;
  }

  recordAgentMutation(scopeId: string, requestId: string, actionHash: string, result: unknown, now = Date.now()): void {
    this.database
      .prepare(`
        INSERT INTO agent_mutations(scope_id, request_id, action_hash, result, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(scopeId, requestId, actionHash, JSON.stringify(result), now);
  }

  getSteeringDelivery(
    scopeId: string,
    requestId: string
  ): SteeringDeliveryRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM steering_deliveries WHERE scope_id = ? AND request_id = ?"
      )
      .get(scopeId, requestId) as Record<string, unknown> | undefined;
    return row ? readSteeringDeliveryRow(row) : undefined;
  }

  listSteeringDeliveries(scopeId?: string): SteeringDeliveryRecord[] {
    const rows = scopeId
      ? this.database
          .prepare(
            "SELECT * FROM steering_deliveries WHERE scope_id = ? ORDER BY created_at ASC"
          )
          .all(scopeId)
      : this.database
          .prepare("SELECT * FROM steering_deliveries ORDER BY created_at ASC")
          .all();
    return (rows as Array<Record<string, unknown>>).map(readSteeringDeliveryRow);
  }

  beginSteeringDelivery(input: BeginSteeringDeliveryInput): SteeringDeliveryRecord {
    const scopeId = normalizeUuid(input.scopeId, "steering scopeId");
    const requestId = normalizeUuid(input.requestId, "steering requestId");
    const actionHash = normalizeDigest(input.actionHash, "steering actionHash");
    const jobId = normalizeRequiredString(input.jobId, "steering jobId", 200);
    const expectedJobVersion = normalizeExpectedVersion(input.expectedJobVersion);
    const promptSha256 = normalizeDigest(input.promptSha256, "steering prompt digest");
    const now = normalizeEventTimestamp(input.now ?? Date.now());
    return this.transaction(() => {
      const existing = this.getSteeringDelivery(scopeId, requestId);
      if (existing) {
        if (existing.actionHash !== actionHash) {
          throw new Error(
            "STEERING_REQUEST_CONFLICT: requestId was already used for a different steering payload in this scope."
          );
        }
        return existing;
      }
      this.ensureScope(scopeId, now);
      this.database
        .prepare(`
          INSERT INTO steering_deliveries(
            scope_id, request_id, action_hash, job_id, expected_job_version,
            prompt_sha256, status, bridge_instance_id, result,
            created_at, updated_at, dispatched_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, NULL, ?, ?, NULL, NULL)
        `)
        .run(
          scopeId,
          requestId,
          actionHash,
          jobId,
          expectedJobVersion,
          promptSha256,
          this.currentInstanceId,
          now,
          now
        );
      return this.getSteeringDelivery(scopeId, requestId) as SteeringDeliveryRecord;
    });
  }

  markSteeringDeliveryDispatching(
    scopeId: string,
    requestId: string,
    actionHash: string,
    now = Date.now()
  ): SteeringDeliveryRecord {
    return this.transaction(() => {
      const delivery = this.requireSteeringDelivery(scopeId, requestId, actionHash);
      if (delivery.status === "dispatching" || delivery.status === "delivered") return delivery;
      if (delivery.status !== "prepared") {
        throw new Error(
          `Invalid steering delivery status transition: ${delivery.status} -> dispatching.`
        );
      }
      if (delivery.bridgeInstanceId !== this.currentInstanceId) {
        throw new Error(
          "DELIVERY_UNCERTAIN: A previous bridge instance owns this steering delivery boundary."
        );
      }
      this.database
        .prepare(`
          UPDATE steering_deliveries
             SET status = 'dispatching', updated_at = ?, dispatched_at = ?
           WHERE scope_id = ? AND request_id = ?
        `)
        .run(now, now, delivery.scopeId, delivery.requestId);
      return this.getSteeringDelivery(delivery.scopeId, delivery.requestId) as SteeringDeliveryRecord;
    });
  }

  completeSteeringDelivery(
    scopeId: string,
    requestId: string,
    actionHash: string,
    status: Extract<SteeringDeliveryStatus, "delivered" | "not-delivered" | "uncertain">,
    result: unknown,
    now = Date.now()
  ): SteeringDeliveryRecord {
    return this.transaction(() => {
      const delivery = this.requireSteeringDelivery(scopeId, requestId, actionHash);
      if (
        delivery.status === "delivered" ||
        delivery.status === "not-delivered" ||
        delivery.status === "uncertain"
      ) {
        if (delivery.status !== status) {
          throw new Error(
            `Invalid steering delivery status transition: ${delivery.status} -> ${status}.`
          );
        }
        return delivery;
      }
      if (status === "delivered" && delivery.status !== "dispatching") {
        throw new Error("A steering delivery cannot be marked delivered before dispatch begins.");
      }
      this.database
        .prepare(`
          UPDATE steering_deliveries
             SET status = ?, result = ?, updated_at = ?, completed_at = ?
           WHERE scope_id = ? AND request_id = ?
        `)
        .run(
          status,
          JSON.stringify(result),
          now,
          now,
          delivery.scopeId,
          delivery.requestId
        );
      return this.getSteeringDelivery(delivery.scopeId, delivery.requestId) as SteeringDeliveryRecord;
    });
  }

  getCancellationOperation(
    scopeId: string,
    requestId: string
  ): CancellationOperationRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM cancellation_operations WHERE scope_id = ? AND request_id = ?"
      )
      .get(scopeId, requestId) as Record<string, unknown> | undefined;
    return row ? readCancellationOperationRow(row) : undefined;
  }

  listCancellationOperations(scopeId?: string): CancellationOperationRecord[] {
    const rows = scopeId
      ? this.database
          .prepare(
            "SELECT * FROM cancellation_operations WHERE scope_id = ? ORDER BY created_at ASC"
          )
          .all(scopeId)
      : this.database
          .prepare("SELECT * FROM cancellation_operations ORDER BY created_at ASC")
          .all();
    return (rows as Array<Record<string, unknown>>).map(readCancellationOperationRow);
  }

  beginCancellationOperation(input: BeginCancellationOperationInput): {
    operation: CancellationOperationRecord;
    intent: CancellationIntentRecord;
  } {
    const normalized = normalizeCancellationOperationInput(input);
    return this.transaction(() => {
      const existing = this.getCancellationOperation(normalized.scopeId, normalized.requestId);
      if (existing) {
        if (existing.actionHash !== normalized.actionHash) {
          throw new Error(
            "CANCELLATION_REQUEST_CONFLICT: requestId was already used for a different cancellation payload in this scope."
          );
        }
        throw new Error(
          "CANCELLATION_REQUEST_EXISTS: The cancellation operation was already durably recorded."
        );
      }
      this.ensureScope(normalized.scopeId, normalized.now);
      this.assertCancellationTarget(normalized.scopeId, normalized.target);
      const intentId = randomUUID();
      this.database
        .prepare(`
          INSERT INTO cancellation_operations(
            scope_id, request_id, root_intent_id, action_hash, source, tool_name,
            action_name, target_kind, target_job_id, target_activity_id,
            target_agent_id, target_thread_id, target_turn_id, target_presentation_id,
            expected_version, caller_presentation_kind, caller_presentation_id,
            widget_instance_present, widget_instance_digest, card_generation,
            caller_request_digest, bridge_instance_id, reason_code, status,
            result, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', NULL, ?, NULL)
        `)
        .run(
          normalized.scopeId,
          normalized.requestId,
          intentId,
          normalized.actionHash,
          normalized.source,
          normalized.toolName,
          normalized.actionName,
          normalized.target.kind,
          normalized.target.jobId || null,
          normalized.target.activityId,
          normalized.target.agentId || null,
          normalized.target.threadId || null,
          normalized.target.turnId || null,
          normalized.target.presentationId || null,
          normalized.expectedVersion,
          normalized.callerPresentation?.kind || null,
          normalized.callerPresentation?.activityPresentationId || null,
          normalized.widgetProof ? 1 : 0,
          normalized.widgetProof?.instanceDigest || null,
          normalized.widgetProof?.cardGeneration || null,
          normalized.callerRequestDigest || null,
          this.currentInstanceId,
          normalized.reasonCode,
          normalized.now
        );
      this.insertCancellationIntent({
        intentId,
        scopeId: normalized.scopeId,
        requestId: normalized.requestId,
        cascadeId: intentId,
        source: normalized.source,
        toolName: normalized.toolName,
        actionName: normalized.actionName,
        target: normalized.target,
        expectedVersion: normalized.expectedVersion,
        callerPresentation: normalized.callerPresentation,
        widgetProof: normalized.widgetProof,
        callerRequestDigest: normalized.callerRequestDigest,
        reasonCode: normalized.reasonCode,
        now: normalized.now
      });
      const intent = this.requireCancellationIntent(intentId);
      this.recordCancellationIntentEvent(intent, "cancellation-intent-recorded", normalized.now);
      return {
        operation: this.getCancellationOperation(
          normalized.scopeId,
          normalized.requestId
        ) as CancellationOperationRecord,
        intent
      };
    });
  }

  createCancellationIntent(input: CreateCancellationIntentInput): CancellationIntentRecord {
    const normalized = normalizeCancellationIntentInput(input);
    return this.transaction(() => {
      const operation = this.getCancellationOperation(normalized.scopeId, normalized.requestId);
      if (!operation) {
        throw new Error(
          "CANCELLATION_PROVENANCE_REQUIRED: Child cancellation intent requires a durable parent operation."
        );
      }
      if (operation.status !== "recorded") {
        throw new Error("A completed cancellation operation cannot accept another child intent.");
      }
      const parent = this.requireCancellationIntent(normalized.parentIntentId);
      if (
        parent.scopeId !== normalized.scopeId ||
        parent.requestId !== normalized.requestId ||
        parent.cascadeId !== normalized.cascadeId
      ) {
        throw new Error("Cancellation parent/cascade correlation does not match the durable operation.");
      }
      this.assertCancellationTarget(normalized.scopeId, normalized.target);
      const intentId = randomUUID();
      this.insertCancellationIntent({ ...normalized, intentId });
      const intent = this.requireCancellationIntent(intentId);
      this.recordCancellationIntentEvent(intent, "cancellation-intent-recorded", normalized.now);
      return intent;
    });
  }

  getCancellationIntent(intentId: string): CancellationIntentRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM cancellation_intents WHERE intent_id = ?")
      .get(intentId) as Record<string, unknown> | undefined;
    return row ? readCancellationIntentRow(row) : undefined;
  }

  listCancellationIntents(options: {
    scopeId?: string;
    requestId?: string;
    jobId?: string;
    activityId?: string;
  } = {}): CancellationIntentRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (options.scopeId) {
      clauses.push("scope_id = ?");
      values.push(options.scopeId);
    }
    if (options.requestId) {
      clauses.push("request_id = ?");
      values.push(options.requestId);
    }
    if (options.jobId) {
      clauses.push("target_job_id = ?");
      values.push(options.jobId);
    }
    if (options.activityId) {
      clauses.push("target_activity_id = ?");
      values.push(options.activityId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT * FROM cancellation_intents${where} ORDER BY created_at ASC, rowid ASC`)
      .all(...values) as Array<Record<string, unknown>>;
    return rows.map(readCancellationIntentRow);
  }

  setCancellationIntentStatus(
    intentId: string,
    status: Exclude<CancellationIntentStatus, "recorded">,
    now = Date.now()
  ): CancellationIntentRecord {
    return this.transaction(() => {
      const current = this.requireCancellationIntent(intentId);
      if (current.status === status) return current;
      const terminal = current.status === "succeeded" ||
        current.status === "failed" ||
        current.status === "no-op";
      if (
        terminal ||
        (current.status === "recorded" && status === "succeeded")
      ) {
        throw new Error(
          `Invalid cancellation intent status transition: ${current.status} -> ${status}.`
        );
      }
      this.database
        .prepare(`
          UPDATE cancellation_intents
             SET status = ?,
                 dispatched_at = CASE WHEN ? = 'dispatched' THEN COALESCE(dispatched_at, ?) ELSE dispatched_at END,
                 completed_at = CASE WHEN ? IN ('succeeded','failed','no-op') THEN COALESCE(completed_at, ?) ELSE completed_at END
           WHERE intent_id = ?
        `)
        .run(status, status, now, status, now, intentId);
      const updated = this.requireCancellationIntent(intentId);
      this.recordCancellationIntentEvent(updated, `cancellation-intent-${status}`, now);
      return updated;
    });
  }

  completeCancellationOperation(
    scopeId: string,
    requestId: string,
    result: unknown,
    status: Exclude<CancellationOperationStatus, "recorded"> = "completed",
    now = Date.now()
  ): CancellationOperationRecord {
    return this.transaction(() => {
      const operation = this.getCancellationOperation(scopeId, requestId);
      if (!operation) throw new Error("Unknown durable cancellation operation.");
      if (operation.status !== "recorded") {
        if (operation.status === status) return operation;
        throw new Error("A cancellation operation already has a terminal outcome.");
      }
      this.database
        .prepare(`
          UPDATE cancellation_operations
             SET status = ?, result = ?, completed_at = ?
           WHERE scope_id = ? AND request_id = ? AND status = 'recorded'
        `)
        .run(status, JSON.stringify(result), now, scopeId, requestId);
      return this.getCancellationOperation(scopeId, requestId) as CancellationOperationRecord;
    });
  }

  recordTransportObservation(input: {
    kind: TransportObservationKind;
    scopeId?: string;
    jobId?: string;
    activityId?: string;
    toolName?: string;
    callerRequestDigest?: string;
    reasonCode: string;
    now?: number;
  }): TransportObservationRecord {
    if (!TRANSPORT_OBSERVATION_KINDS.includes(input.kind)) {
      throw new Error("Unsupported transport observation kind.");
    }
    const now = input.now ?? Date.now();
    const reasonCode = normalizeReasonCode(input.reasonCode);
    const toolName = input.toolName
      ? normalizeRequiredString(input.toolName, "transport observation tool", 100)
      : undefined;
    const callerRequestDigest = normalizeOptionalDigest(input.callerRequestDigest);
    const scopeId = input.scopeId ? normalizeUuid(input.scopeId, "observation scopeId") : undefined;
    return this.transaction(() => {
      const result = this.database
        .prepare(`
          INSERT INTO transport_observations(
            kind, scope_id, job_id, activity_id, tool_name, caller_request_digest,
            bridge_instance_id, reason_code, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.kind,
          scopeId || null,
          normalizeOptionalString(input.jobId) || null,
          normalizeOptionalString(input.activityId) || null,
          toolName || null,
          callerRequestDigest || null,
          this.currentInstanceId,
          reasonCode,
          now
        );
      this.database
        .prepare(`
          DELETE FROM transport_observations
           WHERE observation_id NOT IN (
             SELECT observation_id FROM transport_observations
              ORDER BY observation_id DESC LIMIT ?
           )
        `)
        .run(TRANSPORT_OBSERVATION_LIMIT);
      const row = this.database
        .prepare("SELECT * FROM transport_observations WHERE observation_id = ?")
        .get(Number(result.lastInsertRowid)) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Transport observation was not durably recorded.");
      return readTransportObservationRow(row);
    });
  }

  listTransportObservations(kind?: TransportObservationKind): TransportObservationRecord[] {
    const rows = kind
      ? this.database
          .prepare("SELECT * FROM transport_observations WHERE kind = ? ORDER BY observation_id ASC")
          .all(kind)
      : this.database
          .prepare("SELECT * FROM transport_observations ORDER BY observation_id ASC")
          .all();
    return (rows as Array<Record<string, unknown>>).map(readTransportObservationRow);
  }

  setActivityPolicy(
    activityId: string,
    policy: {
      handoffPolicy?: ActivityHandoffPolicy;
      completionTrigger?: ActivityCompletionTrigger;
      executionMode?: ActivityExecutionMode;
      kind?: ActivityKind;
    },
    now = Date.now()
  ): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireActivity(activityId);
      if (activity.lifecycle !== "open") {
        throw new Error("Activity policy can only change while the Activity is open.");
      }
      const kind = policy.kind || activity.kind;
      const executionMode = policy.executionMode || activity.executionMode;
      const handoffPolicy = policy.handoffPolicy || activity.handoffPolicy;
      const completionTrigger = policy.completionTrigger || activity.completionTrigger;
      assertActivityPolicy(kind, executionMode, handoffPolicy, completionTrigger);
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET kind = ?, execution_mode = ?, handoff_policy = ?, completion_trigger = ?,
                 verification = CASE WHEN ? = 'verify' THEN verification ELSE 'not-required' END,
                 version = version + 1, updated_at = ?
           WHERE activity_id = ?
        `)
        .run(kind, executionMode, handoffPolicy, completionTrigger, handoffPolicy, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "policy-updated",
        createdAt: now,
        payload: { kind, executionMode, handoffPolicy, completionTrigger }
      });
      return this.requireActivity(activityId);
    });
  }

  sealActivity(activityId: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireActivity(activityId);
      if (activity.lifecycle !== "open") {
        throw new Error("Only an open Activity can be sealed.");
      }
      if (activity.counts.total === 0) {
        throw new Error("An Activity must contain at least one Codex job before it can be sealed.");
      }
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'sealed', sealed_at = ?, updated_at = ?, version = version + 1
           WHERE activity_id = ?
        `)
        .run(now, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "activity-sealed",
        createdAt: now,
        payload: {}
      });
      this.reconcileActivity(activityId, scopeVersion, now);
      return this.requireActivity(activityId);
    });
  }

  completeActivity(activityId: string, reason?: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "completed");
      this.assertNoRunningJobs(activity, "complete");
      if (activity.verification === "pending" || activity.verification === "verifying") {
        throw new Error("Finish Activity verification before completing the Activity.");
      }
      if (activity.handoffPolicy === "verify" && activity.verification !== "verified") {
        throw new Error(
          "A verify Activity cannot be completed before verification passes. Start verification first."
        );
      }
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      const completionVersion = activity.completionVersion + 1;
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'completed', waiting_on = 'none', verification = 'not-required',
                 version = version + 1,
                 completion_version = ?, updated_at = ?, completed_at = ?
           WHERE activity_id = ?
        `)
        .run(completionVersion, now, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "activity-completed",
        createdAt: now,
        payload: { source: "explicit-update", reason: normalizeOptionalBoundedText(reason, 2_000) || null }
      });
      if (activity.handoffPolicy === "notify") {
        this.insertCompletionOutbox({
          activityId,
          scopeId: activity.scopeId,
          completionVersion,
          channel: "notify",
          createdAt: now,
          payload: {
            activityId,
            completionVersion,
            channel: "notify",
            counts: activity.counts,
            requiresResultVerification: false,
            source: "explicit-update"
          }
        });
      }
      return this.requireActivity(activityId);
    });
  }

  abandonActivity(activityId: string, reason?: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "abandoned");
      this.assertNoRunningJobs(activity, "abandon");
      return this.transitionActivityTerminal(
        activity,
        "abandoned",
        "activity-abandoned",
        { reason: normalizeOptionalBoundedText(reason, 2_000) || null },
        now
      );
    });
  }

  beginActivityTermination(activityId: string, reason?: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "terminating");
      if (activity.lifecycle === "terminating") return activity;
      if (activity.counts.running === 0) {
        throw new Error("Cannot terminate an Activity that has no active child jobs.");
      }
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'terminating', waiting_on = 'codex',
                 version = version + 1, updated_at = ?
           WHERE activity_id = ?
        `)
        .run(now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "activity-terminating",
        createdAt: now,
        payload: {
          reason: normalizeOptionalBoundedText(reason, 2_000) || null,
          partialFilesystemChangesMayRemain: true
        }
      });
      return this.requireActivity(activityId);
    });
  }

  cancelActivity(activityId: string, reason?: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "cancelled");
      this.assertNoRunningJobs(activity, "cancel");
      return this.transitionActivityTerminal(
        activity,
        "cancelled",
        "activity-cancelled",
        {
          reason: normalizeOptionalBoundedText(reason, 2_000) || null,
          partialFilesystemChangesMayRemain: true
        },
        now
      );
    });
  }

  startActivityVerification(activityId: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "verified");
      if (activity.handoffPolicy !== "verify") {
        throw new Error("Only an Activity with handoffPolicy='verify' can start verification.");
      }
      this.assertNoRunningJobs(activity, "start verification for");
      if (activity.counts.total === 0) {
        throw new Error("An Activity must contain at least one Codex job before verification starts.");
      }
      if (activity.counts.completed === 0) {
        throw new Error("Verification requires at least one completed child job with an outcome to inspect.");
      }
      if (
        activity.verification !== "not-required" &&
        activity.verification !== "pending" &&
        activity.verification !== "failed"
      ) {
        throw new Error(`Activity verification cannot start from '${activity.verification}'.`);
      }
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'sealed', sealed_at = COALESCE(sealed_at, ?),
                 waiting_on = 'verification', verification = 'verifying',
                 version = version + 1, updated_at = ?
           WHERE activity_id = ?
        `)
        .run(now, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "verification-started",
        createdAt: now,
        payload: { previousVerification: activity.verification }
      });
      this.acknowledgeCompletionOutbox(activityId, "verify", now);
      return this.requireActivity(activityId);
    });
  }

  passActivityVerification(
    activityId: string,
    evidence: ActivityVerificationEvidence,
    now = Date.now()
  ): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "verified");
      if (activity.lifecycle !== "sealed" || activity.verification !== "verifying") {
        throw new Error("Activity verification can pass only after verification has started.");
      }
      this.assertNoRunningJobs(activity, "verify");
      const normalizedEvidence = normalizeVerificationEvidence(evidence);
      this.assertEvidenceJobsBelongToActivity(activityId, normalizedEvidence.jobIds || []);
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      const completionVersion = activity.completionVersion + 1;
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'completed', waiting_on = 'none', verification = 'verified',
                 version = version + 1, completion_version = ?, updated_at = ?, completed_at = ?
           WHERE activity_id = ?
        `)
        .run(completionVersion, now, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "verification-passed",
        createdAt: now,
        payload: { evidence: normalizedEvidence }
      });
      return this.requireActivity(activityId);
    });
  }

  failActivityVerification(activityId: string, reason: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "verification failed");
      if (activity.verification !== "pending" && activity.verification !== "verifying") {
        throw new Error("Activity verification can fail only while pending or verifying.");
      }
      const normalizedReason = normalizeRequiredBoundedText(reason, "Verification failure reason", 2_000);
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'open', sealed_at = NULL, waiting_on = 'orchestrator',
                 verification = 'failed', version = version + 1, updated_at = ?, completed_at = NULL
           WHERE activity_id = ?
        `)
        .run(now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "verification-failed",
        createdAt: now,
        payload: { reason: normalizedReason }
      });
      this.acknowledgeCompletionOutbox(activityId, "verify", now);
      return this.requireActivity(activityId);
    });
  }

  getScopeVersion(scopeId: string): number {
    const row = this.database
      .prepare("SELECT version FROM scope_versions WHERE scope_id = ?")
      .get(scopeId) as { version: number } | undefined;
    return row?.version || 0;
  }

  listActivityEvents(activityId?: string): ActivityEventRecord[] {
    const rows = activityId
      ? this.database
          .prepare("SELECT * FROM activity_events WHERE activity_id = ? ORDER BY event_id ASC")
          .all(activityId)
      : this.database.prepare("SELECT * FROM activity_events ORDER BY event_id ASC").all();
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      eventId: Number(row.event_id),
      activityId: String(row.activity_id),
      scopeId: String(row.scope_id),
      scopeVersion: Number(row.scope_version),
      eventType: String(row.event_type),
      createdAt: Number(row.created_at),
      payload: parsePayload({ payload: String(row.payload) }, "activity event")
    }));
  }

  listJobEvents(jobId?: string): JobEventRecord[] {
    const rows = jobId
      ? this.database.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY event_id ASC").all(jobId)
      : this.database.prepare("SELECT * FROM job_events ORDER BY event_id ASC").all();
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      eventId: Number(row.event_id),
      jobId: String(row.job_id),
      activityId: String(row.activity_id),
      scopeId: String(row.scope_id),
      scopeVersion: Number(row.scope_version),
      eventType: String(row.event_type),
      status: String(row.status),
      createdAt: Number(row.created_at),
      payload: parsePayload({ payload: String(row.payload) }, "job event")
    }));
  }

  recordJobTelemetryEvent(
    jobId: string,
    eventType: string,
    payload: unknown,
    createdAt = Date.now(),
    waitingOn?: "codex" | "user"
  ): number {
    return this.transaction(() => {
      const row = this.database
        .prepare(`
          SELECT job_id, activity_id, scope_id, status
            FROM jobs
           WHERE job_id = ? AND archived_at IS NULL
        `)
        .get(jobId) as
        | { job_id: string; activity_id: string; scope_id: string; status: string }
        | undefined;
      if (!row) throw new Error("Cannot attach telemetry to an unknown Codex job.");
      const scopeVersion = this.nextScopeVersion(row.scope_id, createdAt);
      this.insertJobEvent({
        jobId: row.job_id,
        activityId: row.activity_id,
        scopeId: row.scope_id,
        scopeVersion,
        eventType: normalizeEventType(eventType),
        status: row.status,
        createdAt,
        payload
      });
      if (waitingOn) {
        this.database
          .prepare(`
            UPDATE activities
               SET waiting_on = ?, updated_at = ?, version = version + 1
             WHERE activity_id = ? AND lifecycle IN ('open','sealed','terminating')
          `)
          .run(waitingOn, createdAt, row.activity_id);
        this.insertActivityEvent({
          activityId: row.activity_id,
          scopeId: row.scope_id,
          scopeVersion,
          eventType: waitingOn === "user" ? "activity-waiting-user" : "activity-waiting-codex",
          createdAt,
          payload: { jobId: row.job_id }
        });
      }
      return scopeVersion;
    });
  }

  listCompletionOutbox(activityId?: string): CompletionOutboxRecord[] {
    const rows = activityId
      ? this.database
          .prepare("SELECT * FROM completion_outbox WHERE activity_id = ? ORDER BY outbox_id ASC")
          .all(activityId)
      : this.database.prepare("SELECT * FROM completion_outbox ORDER BY outbox_id ASC").all();
    return (rows as Array<Record<string, unknown>>).map(readCompletionOutboxRow);
  }

  listPendingCompletionOutbox(scopeId: string, limit = 20): CompletionOutboxRecord[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM completion_outbox
         WHERE scope_id = ? AND delivered_at IS NULL AND acknowledged_at IS NULL
         ORDER BY created_at ASC LIMIT ?
      `)
      .all(scopeId, Math.max(0, Math.min(100, limit)));
    return (rows as Array<Record<string, unknown>>).map(readCompletionOutboxRow);
  }

  listPendingCompletionActivityIds(scopeId: string): string[] {
    const rows = this.database
      .prepare(`
        SELECT DISTINCT activity_id
          FROM completion_outbox
         WHERE scope_id = ? AND delivered_at IS NULL AND acknowledged_at IS NULL
         ORDER BY activity_id ASC
      `)
      .all(normalizeUuid(scopeId, "completion outbox scopeId")) as Array<{ activity_id: string }>;
    return rows.map((row) => row.activity_id);
  }

  claimCompletionOutbox(
    outboxId: number,
    scopeId: string,
    leaseOwner: string,
    leaseMs = 60_000,
    now = Date.now()
  ): CompletionOutboxRecord | undefined {
    return this.transaction(() => {
      const result = this.database
        .prepare(`
          UPDATE completion_outbox
             SET lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1
           WHERE outbox_id = ? AND scope_id = ?
             AND delivered_at IS NULL AND acknowledged_at IS NULL
             AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
        `)
        .run(leaseOwner, now + leaseMs, outboxId, scopeId, now, leaseOwner);
      if (result.changes !== 1) return undefined;
      const row = this.database
        .prepare("SELECT * FROM completion_outbox WHERE outbox_id = ?")
        .get(outboxId) as Record<string, unknown> | undefined;
      return row ? readCompletionOutboxRow(row) : undefined;
    });
  }

  markCompletionOutboxDelivered(
    outboxId: number,
    scopeId: string,
    leaseOwner: string,
    now = Date.now()
  ): CompletionOutboxRecord {
    return this.transaction(() => {
      const result = this.database
        .prepare(`
          UPDATE completion_outbox
             SET delivered_at = COALESCE(delivered_at, ?), lease_owner = NULL, lease_expires_at = NULL
           WHERE outbox_id = ? AND scope_id = ? AND (lease_owner = ? OR delivered_at IS NOT NULL)
        `)
        .run(now, outboxId, scopeId, leaseOwner);
      if (result.changes !== 1) throw new Error("Completion handoff lease is missing or owned by another widget.");
      const row = this.database
        .prepare("SELECT * FROM completion_outbox WHERE outbox_id = ?")
        .get(outboxId) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Unknown completion handoff event.");
      return readCompletionOutboxRow(row);
    });
  }

  releaseCompletionOutbox(
    outboxId: number,
    scopeId: string,
    leaseOwner: string
  ): void {
    this.database
      .prepare(`
        UPDATE completion_outbox SET lease_owner = NULL, lease_expires_at = NULL
         WHERE outbox_id = ? AND scope_id = ? AND lease_owner = ? AND delivered_at IS NULL
      `)
      .run(outboxId, scopeId, leaseOwner);
  }

  listBridgeInstances(): BridgeInstanceRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM bridge_instances ORDER BY started_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      instanceId: String(row.instance_id),
      startedAt: Number(row.started_at),
      stoppedAt: optionalNumber(row.stopped_at),
      terminationReason: optionalString(row.termination_reason),
      processId: Number(row.process_id)
    }));
  }

  getSettingsRecord(): SettingsStorageRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT payload, settings_revision, updated_at
          FROM user_settings WHERE singleton = 1
      `)
      .get() as (JsonRow & { settings_revision: number; updated_at: number | null }) | undefined;
    return row
      ? {
          settingsRevision: row.settings_revision,
          updatedAt: row.updated_at,
          payload: parsePayload(row, "settings")
        }
      : undefined;
  }

  getSettings(): unknown | undefined {
    return this.getSettingsRecord()?.payload;
  }

  getSettingsRevision(): number {
    return this.getSettingsRecord()?.settingsRevision || 0;
  }

  assertSettingsRevision(expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("SETTINGS_REVISION_CONFLICT: Invalid expected settings revision.");
    }
    if (this.getSettingsRevision() !== expectedRevision) {
      throw new Error(
        "SETTINGS_REVISION_CONFLICT: Settings changed after this card was opened."
      );
    }
  }

  /** Write one ordinary-settings generation. Caller decides whether the value is a no-op. */
  writeSettings(
    settings: unknown,
    expectedRevision: number,
    now = Date.now()
  ): SettingsStorageRecord {
    return this.transaction(() => {
      this.assertSettingsRevision(expectedRevision);
      const nextRevision = expectedRevision + 1;
      this.database
        .prepare(`
          INSERT INTO user_settings(singleton, payload, settings_revision, updated_at)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            payload = excluded.payload,
            settings_revision = excluded.settings_revision,
            updated_at = excluded.updated_at
        `)
        .run(JSON.stringify(settings), nextRevision, now);
      return {
        settingsRevision: nextRevision,
        updatedAt: now,
        payload: structuredClone(settings)
      };
    });
  }

  /** Compatibility/import write. New mutations must use writeSettings with CAS. */
  setSettings(settings: unknown): void {
    const record = settings && typeof settings === "object"
      ? settings as Record<string, unknown>
      : undefined;
    const revision = Number.isInteger(record?.settingsRevision)
      ? Number(record?.settingsRevision)
      : Number.isInteger(record?.revision)
        ? Number(record?.revision)
        : this.getSettingsRevision();
    this.database
      .prepare(`
        INSERT INTO user_settings(singleton, payload, settings_revision, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          payload = excluded.payload,
          settings_revision = excluded.settings_revision,
          updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(settings), revision, Date.now());
  }

  getProjectRegistrySnapshot(): ProjectRegistrySnapshot {
    const registry = this.database
      .prepare(`
        SELECT registry_revision, updated_at
          FROM project_registry WHERE singleton = 1
      `)
      .get() as ProjectRegistryStorageRow | undefined;
    if (!registry) throw new Error("Project registry metadata is missing.");
    const rows = this.database
      .prepare(`
        SELECT project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
               created_at, updated_at, archived_at
          FROM projects
         ORDER BY sort_order ASC, created_at ASC, project_id ASC
      `)
      .all() as ProjectStorageRow[];
    return {
      registryRevision: registry.registry_revision,
      updatedAt: registry.updated_at,
      projects: rows.map(readProjectStorageRow)
    };
  }

  getProjectRegistryRevision(): number {
    return this.getProjectRegistrySnapshot().registryRevision;
  }

  assertProjectRegistryRevision(expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error(
        `${PROJECT_REGISTRY_REVISION_CONFLICT}: Invalid expected project registry revision.`
      );
    }
    if (this.getProjectRegistryRevision() !== expectedRevision) {
      throw new Error(
        `${PROJECT_REGISTRY_REVISION_CONFLICT}: Project settings changed after this card was opened.`
      );
    }
  }

  /** Runtime authority for fresh admission, including legacy cached descriptors. */
  resolveProjectSelection(
    selection: RuntimeProjectSelection,
    allowedRoots: readonly string[]
  ): ProjectTarget {
    return this.transaction(() => {
      let project: ProjectTarget;
      if ("registryRevision" in selection) {
        const registryRevision = this.getProjectRegistryRevision();
        if (
          !Number.isInteger(selection.registryRevision) ||
          selection.registryRevision < 0 ||
          selection.registryRevision !== registryRevision
        ) {
          throw new Error(
            `${PROJECT_REGISTRY_CHANGED}: Project choices changed. Refresh the tool descriptor and retry.`
          );
        }
        const nameKey = projectNameKey(selection.name);
        const rows = this.database
          .prepare(`
            SELECT project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
                   created_at, updated_at, archived_at
              FROM projects
             WHERE name_key = ? AND archived_at IS NULL
          `)
          .all(nameKey) as ProjectStorageRow[];
        if (rows.length !== 1) {
          throw new Error(`${PROJECT_NOT_FOUND}: No active project has that exact normalized name.`);
        }
        project = readProjectStorageRow(rows[0] as ProjectStorageRow);
      } else {
        const projectRef = normalizeProjectRef(selection.projectRef);
        const row = this.database
          .prepare(`
            SELECT project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
                   created_at, updated_at, archived_at
              FROM projects
             WHERE project_ref = ?
          `)
          .get(projectRef) as ProjectStorageRow | undefined;
        if (!row) {
          throw new Error(`${PROJECT_NOT_FOUND}: Unknown project selection reference.`);
        }
        project = readProjectStorageRow(row);
        if (
          !Number.isInteger(selection.projectRevision) ||
          selection.projectRevision < 1 ||
          selection.projectRevision !== project.projectRevision
        ) {
          throw new Error(
            `${PROJECT_REGISTRY_CHANGED}: The selected project changed. Refresh the tool descriptor and retry.`
          );
        }
        if (normalizeProjectName(selection.name) !== project.name) {
          throw new Error(
            `${PROJECT_REGISTRY_CHANGED}: The selected project name changed. Refresh the tool descriptor and retry.`
          );
        }
        if (project.archivedAt !== undefined) {
          throw new Error(`${PROJECT_NOT_FOUND}: The selected project is archived.`);
        }
      }
      let canonical: string;
      try {
        canonical = canonicalProjectCwd(project.cwd, allowedRoots);
      } catch {
        throw new Error(
          `${PROJECT_UNAVAILABLE}: The selected project folder is unavailable. Check it in Codex settings.`
        );
      }
      if (canonical !== project.cwd) {
        throw new Error(
          `${PROJECT_UNAVAILABLE}: The selected project folder no longer has its admitted canonical identity.`
        );
      }
      return project;
    });
  }

  applyProjectOperations(
    operations: readonly ProjectRegistryOperation[],
    expectedRevision: number,
    allowedRoots: readonly string[],
    now = Date.now()
  ): ProjectRegistrySnapshot {
    if (operations.length > MAX_REGISTERED_PROJECTS * 2) {
      throw new Error(
        `PROJECT_OPERATION_LIMIT: At most ${MAX_REGISTERED_PROJECTS * 2} project operations are allowed per save.`
      );
    }
    return this.transaction(() => {
      this.assertProjectRegistryRevision(expectedRevision);
      const seen = new Map<string, Set<ProjectRegistryOperation["kind"]>>();
      for (const operation of operations) {
        if (operation.kind === "add" || operation.kind === "reorder") continue;
        const projectId = normalizeProjectId(operation.projectId);
        const kinds = seen.get(projectId) || new Set<ProjectRegistryOperation["kind"]>();
        if (
          kinds.has(operation.kind) ||
          kinds.has("archive") ||
          kinds.has("restore") ||
          operation.kind === "archive" && kinds.size > 0 ||
          operation.kind === "restore" && kinds.size > 0
        ) {
          throw new Error(
            `${PROJECT_OPERATION_CONFLICT}: Conflicting operations target one project.`
          );
        }
        kinds.add(operation.kind);
        seen.set(projectId, kinds);
      }

      let changed = false;
      const changedProjectIds = new Set<string>();
      for (const operation of operations) {
        if (operation.kind === "add") {
          const count = Number((this.database
            .prepare("SELECT COUNT(*) AS count FROM projects")
            .get() as CountRow).count);
          if (count >= MAX_REGISTERED_PROJECTS) {
            throw new Error(
              `${PROJECT_LIMIT_EXCEEDED}: At most ${MAX_REGISTERED_PROJECTS} projects may be registered.`
            );
          }
          const name = normalizeProjectName(operation.project.name);
          const nameKey = projectNameKey(name);
          const cwd = canonicalProjectCwd(operation.project.cwd, allowedRoots);
          const projectId = randomUUID();
          const projectRef = createProjectRef();
          this.assertActiveProjectUniqueness(nameKey, cwd);
          this.assertProjectCwdReusable(cwd, projectId);
          const maxSort = this.database
            .prepare("SELECT MAX(sort_order) AS value FROM projects")
            .get() as { value: number | null };
          this.database
            .prepare(`
              INSERT INTO projects(
                project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
                created_at, updated_at, archived_at
              ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, NULL)
            `)
            .run(
              projectId,
              projectRef,
              name,
              nameKey,
              cwd,
              (maxSort.value ?? -1) + 1,
              now,
              now
            );
          changed = true;
          continue;
        }

        if (operation.kind === "reorder") {
          const active = this.database
            .prepare("SELECT project_id FROM projects WHERE archived_at IS NULL ORDER BY sort_order, created_at")
            .all() as Array<{ project_id: string }>;
          const requested = operation.projectIds.map(normalizeProjectId);
          if (
            requested.length !== active.length ||
            new Set(requested).size !== requested.length ||
            active.some(({ project_id }) => !requested.includes(project_id))
          ) {
            throw new Error("PROJECT_REORDER_INVALID: Reorder must contain every active project exactly once.");
          }
          requested.forEach((projectId, index) => {
            const current = active.findIndex(({ project_id }) => project_id === projectId);
            if (current !== index) {
              this.database
                .prepare("UPDATE projects SET sort_order = ?, updated_at = ? WHERE project_id = ?")
                .run(index, now, projectId);
              changed = true;
            }
          });
          continue;
        }

        const projectId = normalizeProjectId(operation.projectId);
        const row = this.requireProjectStorageRow(projectId);
        if (operation.kind === "rename") {
          if (row.archived_at !== null) {
            throw new Error(`${PROJECT_ARCHIVED}: Restore an archived project to change its active name.`);
          }
          const name = normalizeProjectName(operation.name);
          const nameKey = projectNameKey(name);
          this.assertActiveProjectUniqueness(nameKey, undefined, projectId);
          if (row.name !== name || row.name_key !== nameKey) {
            this.database
              .prepare("UPDATE projects SET name = ?, name_key = ?, updated_at = ? WHERE project_id = ?")
              .run(name, nameKey, now, projectId);
            changed = true;
            changedProjectIds.add(projectId);
          }
          continue;
        }
        if (operation.kind === "relocate") {
          if (row.archived_at !== null) {
            throw new Error(`${PROJECT_ARCHIVED}: Restore an archived project to relocate it.`);
          }
          const cwd = canonicalProjectCwd(operation.cwd, allowedRoots);
          this.assertActiveProjectUniqueness(undefined, cwd, projectId);
          this.assertProjectCwdReusable(cwd, projectId);
          if (row.cwd !== cwd) {
            this.database
              .prepare("UPDATE projects SET cwd = ?, updated_at = ? WHERE project_id = ?")
              .run(cwd, now, projectId);
            changed = true;
            changedProjectIds.add(projectId);
          }
          continue;
        }
        if (operation.kind === "archive") {
          if (row.archived_at === null) {
            this.database
              .prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE project_id = ?")
              .run(now, now, projectId);
            changed = true;
            changedProjectIds.add(projectId);
          }
          continue;
        }

        if (row.archived_at === null) {
          if (operation.name !== undefined || operation.cwd !== undefined) {
            throw new Error(`${PROJECT_OPERATION_CONFLICT}: The project is already active.`);
          }
          continue;
        }
        const name = normalizeProjectName(operation.name ?? row.name);
        const nameKey = projectNameKey(name);
        const cwd = canonicalProjectCwd(operation.cwd ?? row.cwd, allowedRoots);
        this.assertActiveProjectUniqueness(nameKey, cwd, projectId);
        this.assertProjectCwdReusable(cwd, projectId);
        this.database
          .prepare(`
            UPDATE projects
               SET name = ?, name_key = ?, cwd = ?, archived_at = NULL, updated_at = ?
             WHERE project_id = ?
          `)
          .run(name, nameKey, cwd, now, projectId);
        changed = true;
        changedProjectIds.add(projectId);
      }

      if (changed) {
        const bumpProjectRevision = this.database.prepare(`
          UPDATE projects
             SET project_revision = project_revision + 1
           WHERE project_id = ?
        `);
        for (const projectId of changedProjectIds) bumpProjectRevision.run(projectId);
        this.database
          .prepare(`
            UPDATE project_registry
               SET registry_revision = registry_revision + 1, updated_at = ?
             WHERE singleton = 1
          `)
          .run(now);
      }
      return this.getProjectRegistrySnapshot();
    });
  }

  /** Import only the new UUID-based standalone-file format into an empty registry. */
  importProjectRegistry(snapshot: ProjectRegistrySnapshot): void {
    this.transaction(() => {
      const current = this.getProjectRegistrySnapshot();
      if (current.projects.length > 0 || current.registryRevision !== 0) return;
      if (
        !Number.isInteger(snapshot.registryRevision) ||
        snapshot.registryRevision < 0 ||
        !Number.isFinite(snapshot.updatedAt) ||
        snapshot.projects.length > MAX_REGISTERED_PROJECTS
      ) {
        throw new Error("Invalid project registry import.");
      }
      for (const project of snapshot.projects) {
        const projectId = normalizeProjectId(project.id);
        const projectRef = normalizeProjectRef(project.projectRef);
        if (!Number.isInteger(project.projectRevision) || project.projectRevision < 1) {
          throw new Error("Invalid project revision in import.");
        }
        const name = normalizeProjectName(project.name);
        const nameKey = projectNameKey(name);
        if (project.nameKey !== nameKey) throw new Error("Invalid project name key in import.");
        this.database
          .prepare(`
            INSERT INTO projects(
              project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
              created_at, updated_at, archived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            projectId,
            projectRef,
            project.projectRevision,
            name,
            nameKey,
            project.cwd,
            project.sortOrder,
            project.createdAt,
            project.updatedAt,
            project.archivedAt ?? null
          );
      }
      this.database
        .prepare(`
          UPDATE project_registry
             SET registry_revision = ?, updated_at = ?
           WHERE singleton = 1
        `)
        .run(snapshot.registryRevision, snapshot.updatedAt);
    });
  }

  private requireProjectStorageRow(projectId: string): ProjectStorageRow {
    const row = this.database
      .prepare(`
        SELECT project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
               created_at, updated_at, archived_at
          FROM projects WHERE project_id = ?
      `)
      .get(projectId) as ProjectStorageRow | undefined;
    if (!row) throw new Error(`${PROJECT_NOT_FOUND}: Unknown project.`);
    return row;
  }

  private assertActiveProjectUniqueness(
    nameKey: string | undefined,
    cwd: string | undefined,
    excludingProjectId?: string
  ): void {
    if (nameKey !== undefined) {
      const conflict = this.database
        .prepare(`
          SELECT 1 FROM projects
           WHERE name_key = ? AND archived_at IS NULL
             AND (? IS NULL OR project_id <> ?)
           LIMIT 1
        `)
        .get(nameKey, excludingProjectId || null, excludingProjectId || null);
      if (conflict) {
        throw new Error(`${PROJECT_NAME_CONFLICT}: An active project already has that name.`);
      }
    }
    if (cwd !== undefined) {
      const conflict = this.database
        .prepare(`
          SELECT 1 FROM projects
           WHERE cwd = ? AND archived_at IS NULL
             AND (? IS NULL OR project_id <> ?)
           LIMIT 1
        `)
        .get(cwd, excludingProjectId || null, excludingProjectId || null);
      if (conflict) {
        throw new Error(`${PROJECT_CWD_CONFLICT}: An active project already uses that folder.`);
      }
    }
  }

  private assertProjectCwdReusable(cwd: string, projectId: string): void {
    const pinned = this.database.prepare(`
      SELECT 1 FROM activities
       WHERE project_cwd_snapshot = ? AND project_uuid IS NOT ?
         AND lifecycle IN ('open','sealed','terminating')
      UNION ALL
      SELECT 1 FROM agent_threads t
        JOIN agents a ON a.agent_id = t.agent_id
       WHERE t.project_cwd_snapshot = ? AND t.project_uuid IS NOT ? AND t.is_current = 1
         AND a.lifecycle <> 'orphaned'
      UNION ALL
      SELECT 1 FROM jobs
       WHERE project_cwd_snapshot = ? AND project_uuid IS NOT ?
         AND archived_at IS NULL
         AND status IN ('running','terminating','termination-failed')
      LIMIT 1
    `).get(cwd, projectId, cwd, projectId, cwd, projectId);
    if (pinned) {
      throw new Error(
        `${PROJECT_CWD_STILL_PINNED}: Another project's resumable context still owns that folder.`
      );
    }
  }

  private requireSteeringDelivery(
    scopeId: string,
    requestId: string,
    actionHash: string
  ): SteeringDeliveryRecord {
    const normalizedScopeId = normalizeUuid(scopeId, "steering scopeId");
    const normalizedRequestId = normalizeUuid(requestId, "steering requestId");
    const normalizedActionHash = normalizeDigest(actionHash, "steering actionHash");
    const delivery = this.getSteeringDelivery(normalizedScopeId, normalizedRequestId);
    if (!delivery) throw new Error("Unknown steering delivery request.");
    if (delivery.actionHash !== normalizedActionHash) {
      throw new Error(
        "STEERING_REQUEST_CONFLICT: requestId was already used for a different steering payload in this scope."
      );
    }
    return delivery;
  }

  getMeta(key: string): string | undefined {
    const row = this.database
      .prepare("SELECT value FROM bridge_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.database
      .prepare(`
        INSERT INTO bridge_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, value);
  }

  close(): void {
    if (this.closed) return;
    const now = Date.now();
    this.database
      .prepare(`
        UPDATE bridge_instances
           SET stopped_at = ?, termination_reason = 'clean-shutdown'
         WHERE instance_id = ? AND stopped_at IS NULL
      `)
      .run(now, this.currentInstanceId);
    this.database.close();
    this.closed = true;
  }

  private createV1Schema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_scope_recent
        ON sessions(scope_id, last_used_at DESC);

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(scope_id, request_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_scope_recent
        ON jobs(scope_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_status_recent
        ON jobs(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS user_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        payload TEXT NOT NULL
      ) STRICT;
    `);
  }

  private migrateV1ToV2(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE scopes (
          scope_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE scope_versions (
          scope_id TEXT PRIMARY KEY REFERENCES scopes(scope_id) ON DELETE CASCADE,
          version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE bridge_instances (
          instance_id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          stopped_at INTEGER,
          termination_reason TEXT,
          process_id INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;

        CREATE TABLE activities (
          activity_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
          title TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('discussion','investigation','review','implementation','other')),
          execution_mode TEXT NOT NULL CHECK(execution_mode IN ('auto','foreground','background')),
          handoff_policy TEXT NOT NULL CHECK(handoff_policy IN ('none','notify','verify')),
          completion_trigger TEXT NOT NULL CHECK(completion_trigger IN ('manual','sealed-jobs-terminal')),
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('open','sealed','completed','cancelled','abandoned')),
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
        CREATE INDEX activities_scope_recent ON activities(scope_id, updated_at DESC);
        CREATE INDEX activities_scope_attention
          ON activities(scope_id, waiting_on, verification, updated_at DESC);

        CREATE TABLE activity_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
          scope_version INTEGER NOT NULL CHECK(scope_version >= 1),
          event_type TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
        CREATE INDEX activity_events_activity_cursor ON activity_events(activity_id, event_id);
        CREATE INDEX activity_events_scope_cursor ON activity_events(scope_id, scope_version, event_id);

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
        CREATE INDEX job_events_job_cursor ON job_events(job_id, event_id);
        CREATE INDEX job_events_scope_cursor ON job_events(scope_id, scope_version, event_id);

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
        CREATE INDEX completion_outbox_pending
          ON completion_outbox(delivered_at, next_attempt_at, created_at);
      `);

      const now = Date.now();
      this.database.exec(`
        INSERT OR IGNORE INTO scopes(scope_id, created_at, updated_at)
          SELECT scope_id, MIN(last_used_at), MAX(last_used_at) FROM sessions GROUP BY scope_id;
        INSERT OR IGNORE INTO scopes(scope_id, created_at, updated_at)
          SELECT scope_id, MIN(updated_at), MAX(updated_at) FROM jobs GROUP BY scope_id;
        INSERT OR IGNORE INTO scope_versions(scope_id, version, updated_at)
          SELECT scope_id, 0, updated_at FROM scopes;
        DROP INDEX IF EXISTS jobs_scope_recent;
        DROP INDEX IF EXISTS jobs_status_recent;
        ALTER TABLE jobs RENAME TO jobs_v1;
      `);
      this.database.exec(`
        CREATE TABLE jobs (
          job_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
          request_id TEXT NOT NULL,
          activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
          thread_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted','cancelled')),
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
        CREATE INDEX jobs_scope_recent ON jobs(scope_id, updated_at DESC);
        CREATE INDEX jobs_status_recent ON jobs(status, updated_at DESC);
        CREATE INDEX jobs_activity_recent ON jobs(activity_id, updated_at DESC);
        CREATE INDEX jobs_thread_recent ON jobs(thread_id, updated_at DESC);
      `);

      const legacyRows = this.database
        .prepare("SELECT * FROM jobs_v1 ORDER BY updated_at ASC")
        .all() as Array<{
        job_id: string;
        scope_id: string;
        request_id: string;
        status: string;
        updated_at: number;
        payload: string;
      }>;
      for (const row of legacyRows) {
        const parsed = parsePayload({ payload: row.payload }, "job") as Record<string, unknown>;
        const activityId = legacyActivityIdForJob(row.job_id);
        const createdAt = finiteNumber(parsed.createdAt) ?? row.updated_at;
        const threadId = readNestedThreadId(parsed);
        const terminalVersion = isTerminalActivityJobStatus(row.status) ? 1 : undefined;
        const counts = countsForSingleStatus(row.status);
        this.insertActivity({
          activityId,
          scopeId: row.scope_id,
          title: `Legacy Codex job ${row.job_id.slice(0, 8)}`,
          kind: "other",
          executionMode: "background",
          handoffPolicy: "none",
          completionTrigger: "manual",
          legacy: true,
          now: createdAt,
          updatedAt: row.updated_at,
          waitingOn: row.status === "running" ? "codex" : "orchestrator",
          counts
        });
        const hydratedPayload = {
          ...parsed,
          activityId,
          threadId,
          executionMode: "background",
          backendKind: "mcp-server",
          terminalVersion
        };
        this.database
          .prepare(`
            INSERT INTO jobs(
              job_id, scope_id, request_id, activity_id, thread_id, status, execution_mode,
              backend_kind, bridge_instance_id, worker_id, worker_generation,
              upstream_request_id, terminal_version, updated_at, archived_at, payload
            ) VALUES (?, ?, ?, ?, ?, ?, 'background', 'mcp-server', NULL, NULL, NULL, NULL, ?, ?, NULL, ?)
          `)
          .run(
            row.job_id,
            row.scope_id,
            row.request_id,
            activityId,
            threadId || null,
            row.status,
            terminalVersion || null,
            row.updated_at,
            JSON.stringify(hydratedPayload)
          );
        const scopeVersion = this.nextScopeVersion(row.scope_id, row.updated_at);
        this.insertActivityEvent({
          activityId,
          scopeId: row.scope_id,
          scopeVersion,
          eventType: "legacy-job-grouped",
          createdAt: row.updated_at,
          payload: { jobId: row.job_id }
        });
        this.insertJobEvent({
          jobId: row.job_id,
          activityId,
          scopeId: row.scope_id,
          scopeVersion,
          eventType: "legacy-imported",
          status: row.status,
          createdAt: row.updated_at,
          payload: { threadLinked: Boolean(threadId) }
        });
      }
      this.database.exec("DROP TABLE jobs_v1");
      this.setMeta("schema_version", "2");
      this.setMeta("schema_v2_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV2ToV3(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE activities_v3 (
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
          INSERT INTO activities_v3 SELECT * FROM activities;
          DROP TABLE activities;
          ALTER TABLE activities_v3 RENAME TO activities;
          CREATE INDEX activities_scope_recent ON activities(scope_id, updated_at DESC);
          CREATE INDEX activities_scope_attention
            ON activities(scope_id, waiting_on, verification, updated_at DESC);

          CREATE TABLE jobs_v3 (
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
          INSERT INTO jobs_v3 SELECT * FROM jobs;
          DROP TABLE jobs;
          ALTER TABLE jobs_v3 RENAME TO jobs;
          CREATE INDEX jobs_scope_recent ON jobs(scope_id, updated_at DESC);
          CREATE INDEX jobs_status_recent ON jobs(status, updated_at DESC);
          CREATE INDEX jobs_activity_recent ON jobs(activity_id, updated_at DESC);
          CREATE INDEX jobs_thread_recent ON jobs(thread_id, updated_at DESC);
        `);
        const now = Date.now();
        this.setMeta("schema_version", "3");
        this.setMeta("schema_v3_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
    const violations = this.database.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error("Bridge state schema v3 migration produced foreign-key violations.");
    }
  }

  private migrateV3ToV4(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.database.exec(`
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
          CREATE INDEX agents_scope_state_recent
            ON agents(scope_id, lifecycle, updated_at DESC);

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
          ) STRICT;
          CREATE INDEX agent_threads_agent_history
            ON agent_threads(agent_id, linked_at ASC);
          CREATE UNIQUE INDEX agent_threads_one_current
            ON agent_threads(agent_id) WHERE is_current = 1;

          CREATE TABLE activity_agents (
            assignment_id TEXT PRIMARY KEY,
            activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
            role TEXT NOT NULL,
            context_mode TEXT NOT NULL CHECK(context_mode IN ('continue','fork','fresh')),
            assigned_at INTEGER NOT NULL,
            released_at INTEGER
          ) STRICT;
          CREATE INDEX activity_agents_activity_history
            ON activity_agents(activity_id, assigned_at ASC);
          CREATE INDEX activity_agents_agent_history
            ON activity_agents(agent_id, assigned_at ASC);
          CREATE UNIQUE INDEX activity_agents_active_pair
            ON activity_agents(activity_id, agent_id) WHERE released_at IS NULL;

          CREATE TABLE agent_mutations (
            scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
            request_id TEXT NOT NULL,
            action_hash TEXT NOT NULL,
            result TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(scope_id, request_id)
          ) STRICT;

          ALTER TABLE activities ADD COLUMN continuation_of_activity_id TEXT REFERENCES activities(activity_id);
          ALTER TABLE activities ADD COLUMN card_generation INTEGER NOT NULL DEFAULT 1 CHECK(card_generation >= 1);
          CREATE INDEX activities_continuation
            ON activities(continuation_of_activity_id, created_at ASC);

          ALTER TABLE jobs ADD COLUMN agent_id TEXT REFERENCES agents(agent_id);
          ALTER TABLE jobs ADD COLUMN context_mode TEXT CHECK(context_mode IN ('continue','fork','fresh'));
          CREATE INDEX jobs_agent_recent ON jobs(agent_id, updated_at DESC);
        `);

        const jobRows = this.database
          .prepare(`
            SELECT job_id, scope_id, activity_id, thread_id, backend_kind, status,
                   updated_at, payload
              FROM jobs ORDER BY updated_at ASC, job_id ASC
          `)
          .all() as Array<{
            job_id: string;
            scope_id: string;
            activity_id: string;
            thread_id: string | null;
            backend_kind: string;
            status: string;
            updated_at: number;
            payload: string;
          }>;
        const sessionRows = this.database
          .prepare("SELECT thread_id, scope_id, cwd, last_used_at, payload FROM sessions ORDER BY last_used_at ASC")
          .all() as Array<{
            thread_id: string;
            scope_id: string;
            cwd: string;
            last_used_at: number;
            payload: string;
          }>;
        const sessionsByThread = new Map(sessionRows.map((row) => [row.thread_id, row]));
        const agentByLegacyKey = new Map<string, string>();
        const nameCounters = new Map<string, number>();
        const ensureLegacyAgent = (
          scopeId: string,
          legacyKey: string,
          threadId: string | undefined,
          job: (typeof jobRows)[number] | undefined,
          session: (typeof sessionRows)[number] | undefined
        ): string => {
          const mapKey = `${scopeId}\0${legacyKey}`;
          const existing = agentByLegacyKey.get(mapKey);
          if (existing) return existing;
          const agentId = stableUuid("bridge-agent-v4", scopeId, legacyKey);
          const index = (nameCounters.get(scopeId) || 0) + 1;
          nameCounters.set(scopeId, index);
          const agentName = `Legacy Codex Agent ${index}`;
          const normalizedName = normalizeAgentName(agentName).normalizedName;
          const activeJob = threadId
            ? [...jobRows].reverse().find(
                (candidate) =>
                  candidate.scope_id === scopeId &&
                  candidate.thread_id === threadId &&
                  isActiveActivityJobStatus(candidate.status)
              )
            : job && isActiveActivityJobStatus(job.status)
              ? job
              : undefined;
          const createdAt = Math.min(
            job?.updated_at ?? Number.MAX_SAFE_INTEGER,
            session?.last_used_at ?? Number.MAX_SAFE_INTEGER
          );
          const updatedAt = Math.max(job?.updated_at || 0, session?.last_used_at || 0, Date.now());
          this.database
            .prepare(`
              INSERT INTO agents(
                agent_id, scope_id, agent_name, normalized_name, lifecycle,
                current_thread_id, current_job_id, version, created_at, updated_at,
                archived_at, orphaned_reason
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)
            `)
            .run(
              agentId,
              scopeId,
              agentName,
              normalizedName,
              activeJob ? "active" : "idle",
              threadId || null,
              activeJob?.job_id || null,
              Number.isFinite(createdAt) ? createdAt : updatedAt,
              updatedAt
            );
          if (threadId) {
            const jobPayload = job
              ? parsePayload({ payload: job.payload }, "legacy job") as Record<string, unknown>
              : undefined;
            const sessionPayload = session
              ? parsePayload({ payload: session.payload }, "legacy session") as Record<string, unknown>
              : undefined;
            const cwd = normalizeOptionalString(session?.cwd) ||
              normalizeOptionalString(jobPayload?.cwd) ||
              normalizeOptionalString(sessionPayload?.cwd) ||
              ".";
            const sandbox = normalizeOptionalString(jobPayload?.sandbox) ||
              normalizeOptionalString(sessionPayload?.sandbox) ||
              "read-only";
            const backendKind = job?.backend_kind ||
              normalizeOptionalString(sessionPayload?.backendKind) ||
              "mcp-server";
            this.database
              .prepare(`
                INSERT INTO agent_threads(
                  thread_id, agent_id, scope_id, backend_kind, cwd, sandbox, context_mode,
                  is_current, linked_at, replaced_at, forked_from_thread_id
                ) VALUES (?, ?, ?, ?, ?, ?, 'continue', 1, ?, NULL, NULL)
              `)
              .run(
                threadId,
                agentId,
                scopeId,
                backendKind,
                cwd,
                sandbox,
                session?.last_used_at || job?.updated_at || updatedAt
              );
          }
          agentByLegacyKey.set(mapKey, agentId);
          return agentId;
        };

        for (const job of jobRows) {
          const session = job.thread_id ? sessionsByThread.get(job.thread_id) : undefined;
          const agentId = ensureLegacyAgent(
            job.scope_id,
            job.thread_id ? `thread:${job.thread_id}` : `job:${job.job_id}`,
            job.thread_id || undefined,
            job,
            session
          );
          this.database
            .prepare("UPDATE jobs SET agent_id = ?, context_mode = 'continue' WHERE job_id = ?")
            .run(agentId, job.job_id);
          const activity = this.database
            .prepare("SELECT lifecycle, created_at, updated_at FROM activities WHERE activity_id = ?")
            .get(job.activity_id) as { lifecycle: string; created_at: number; updated_at: number };
          const assignmentId = stableUuid("activity-agent-v4", job.activity_id, agentId);
          this.database
            .prepare(`
              INSERT OR IGNORE INTO activity_agents(
                assignment_id, activity_id, agent_id, role, context_mode, assigned_at, released_at
              ) VALUES (?, ?, ?, 'legacy', 'continue', ?, ?)
            `)
            .run(
              assignmentId,
              job.activity_id,
              agentId,
              activity.created_at,
              isTerminalActivityJobStatus(job.status) ||
                activity.lifecycle === "completed" ||
                activity.lifecycle === "cancelled" ||
                activity.lifecycle === "abandoned"
                ? Math.max(job.updated_at, activity.updated_at)
                : null
            );
        }
        for (const session of sessionRows) {
          if (agentByLegacyKey.has(`${session.scope_id}\0thread:${session.thread_id}`)) continue;
          ensureLegacyAgent(
            session.scope_id,
            `thread:${session.thread_id}`,
            session.thread_id,
            undefined,
            session
          );
        }

        const now = Date.now();
        this.setMeta("schema_version", "4");
        this.setMeta("schema_v4_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
    const violations = this.database.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error("Bridge state schema v4 migration produced foreign-key violations.");
    }
  }

  private migrateV4ToV5(): void {
    this.transaction(() => {
      this.database.exec(`
        ALTER TABLE sessions ADD COLUMN project_id TEXT;
        ALTER TABLE sessions ADD COLUMN project_label TEXT;

        ALTER TABLE activities ADD COLUMN project_id TEXT;
        ALTER TABLE activities ADD COLUMN project_label TEXT;
        ALTER TABLE activities ADD COLUMN project_cwd TEXT;
        CREATE INDEX activities_scope_project_recent
          ON activities(scope_id, project_id, updated_at DESC);

        ALTER TABLE jobs ADD COLUMN project_id TEXT;
        ALTER TABLE jobs ADD COLUMN project_label TEXT;
        CREATE INDEX jobs_project_recent ON jobs(project_id, updated_at DESC);

        ALTER TABLE agent_threads ADD COLUMN project_id TEXT;
        ALTER TABLE agent_threads ADD COLUMN project_label TEXT;
      `);
      const now = Date.now();
      this.setMeta("schema_version", "5");
      this.setMeta("schema_v5_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV5ToV6(): void {
    this.transaction(() => {
      this.database.exec(`
        ALTER TABLE agent_threads ADD COLUMN session_id TEXT;
      `);
      const now = Date.now();
      this.setMeta("schema_version", "6");
      this.setMeta("schema_v6_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV6ToV7(): void {
    this.transaction(() => {
      this.database.exec(`
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
          completed_at INTEGER,
          PRIMARY KEY(scope_id, request_id),
          CHECK((target_kind = 'job') = (target_job_id IS NOT NULL)),
          CHECK((widget_instance_present = 1) = (widget_instance_digest IS NOT NULL)),
          CHECK((caller_presentation_kind = 'automatic') = (caller_presentation_id IS NOT NULL))
        ) STRICT;
        CREATE INDEX cancellation_operations_target_job
          ON cancellation_operations(target_job_id, created_at ASC);
        CREATE INDEX cancellation_operations_target_activity
          ON cancellation_operations(target_activity_id, created_at ASC);

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
        CREATE INDEX cancellation_intents_operation
          ON cancellation_intents(scope_id, request_id, created_at ASC);
        CREATE INDEX cancellation_intents_target_job
          ON cancellation_intents(target_job_id, created_at ASC);
        CREATE INDEX cancellation_intents_target_activity
          ON cancellation_intents(target_activity_id, created_at ASC);
        CREATE INDEX cancellation_intents_cascade
          ON cancellation_intents(cascade_id, created_at ASC);

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
        CREATE INDEX transport_observations_recent
          ON transport_observations(created_at DESC, observation_id DESC);
      `);
      const now = Date.now();
      this.setMeta("schema_version", "7");
      this.setMeta("schema_v7_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV7ToV8(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE project_registry (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          registry_revision INTEGER NOT NULL CHECK(registry_revision >= 0),
          updated_at INTEGER NOT NULL
        ) STRICT;
        INSERT INTO project_registry(singleton, registry_revision, updated_at)
          VALUES (1, 0, 0);

        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          cwd TEXT NOT NULL,
          sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        ) STRICT;
        CREATE UNIQUE INDEX projects_active_name
          ON projects(name_key) WHERE archived_at IS NULL;
        CREATE UNIQUE INDEX projects_active_cwd
          ON projects(cwd) WHERE archived_at IS NULL;
        CREATE INDEX projects_ordered
          ON projects(archived_at, sort_order, created_at);

        ALTER TABLE user_settings ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 0
          CHECK(settings_revision >= 0);
        ALTER TABLE user_settings ADD COLUMN updated_at INTEGER;

        ALTER TABLE sessions ADD COLUMN project_uuid TEXT REFERENCES projects(project_id);
        ALTER TABLE sessions ADD COLUMN project_name_snapshot TEXT;

        ALTER TABLE activities ADD COLUMN project_uuid TEXT REFERENCES projects(project_id);
        ALTER TABLE activities ADD COLUMN project_name_snapshot TEXT;
        ALTER TABLE activities ADD COLUMN project_cwd_snapshot TEXT;
        CREATE INDEX activities_project_pin
          ON activities(project_uuid, project_cwd_snapshot, lifecycle);

        ALTER TABLE jobs ADD COLUMN project_uuid TEXT REFERENCES projects(project_id);
        ALTER TABLE jobs ADD COLUMN project_name_snapshot TEXT;
        ALTER TABLE jobs ADD COLUMN project_cwd_snapshot TEXT;
        CREATE INDEX jobs_project_pin
          ON jobs(project_uuid, project_cwd_snapshot, status);

        ALTER TABLE agent_threads ADD COLUMN project_uuid TEXT REFERENCES projects(project_id);
        ALTER TABLE agent_threads ADD COLUMN project_name_snapshot TEXT;
        ALTER TABLE agent_threads ADD COLUMN project_cwd_snapshot TEXT;
        CREATE INDEX agent_threads_project_pin
          ON agent_threads(project_uuid, project_cwd_snapshot, is_current);
      `);

      const settingsRow = this.database
        .prepare("SELECT payload FROM user_settings WHERE singleton = 1")
        .get() as JsonRow | undefined;
      if (settingsRow) {
        const payload = parsePayload(settingsRow, "settings") as Record<string, unknown>;
        const legacyRevision = Number.isInteger(payload.revision) && Number(payload.revision) >= 0
          ? Number(payload.revision)
          : 0;
        // Project rows in the pre-v8 JSON shape are intentionally not
        // identities in the UUID registry. Remove them (and the retired
        // default selectors) so user_settings remains ordinary-settings-only.
        const ordinarySettings = { ...payload };
        delete ordinarySettings.projects;
        delete ordinarySettings.defaultProjectId;
        delete ordinarySettings.defaultCwd;
        this.database
          .prepare(`
            UPDATE user_settings
               SET payload = ?, settings_revision = ?
             WHERE singleton = 1
          `)
          .run(JSON.stringify(ordinarySettings), legacyRevision);
      }

      const now = Date.now();
      this.setMeta("schema_version", "8");
      this.setMeta("schema_v8_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV8ToV9(): void {
    this.transaction(() => {
      this.database.exec(`
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
        CREATE INDEX steering_deliveries_job_recent
          ON steering_deliveries(job_id, created_at DESC);
        CREATE INDEX steering_deliveries_status_recent
          ON steering_deliveries(status, updated_at DESC);
      `);
      const now = Date.now();
      this.setMeta("schema_version", "9");
      this.setMeta("schema_v9_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV9ToV10(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        const rows = this.database
          .prepare(`
            SELECT project_id, name, name_key, cwd, sort_order,
                   created_at, updated_at, archived_at
              FROM projects
             ORDER BY sort_order ASC, created_at ASC, project_id ASC
          `)
          .all() as LegacyProjectStorageRow[];
        this.database.exec(`
          CREATE TABLE projects_v10 (
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
          ) STRICT;
        `);
        const insert = this.database.prepare(`
          INSERT INTO projects_v10(
            project_id, project_ref, project_revision, name, name_key, cwd,
            sort_order, created_at, updated_at, archived_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          insert.run(
            row.project_id,
            createProjectRef(),
            row.name,
            row.name_key,
            row.cwd,
            row.sort_order,
            row.created_at,
            row.updated_at,
            row.archived_at
          );
        }
        this.database.exec(`
          DROP TABLE projects;
          ALTER TABLE projects_v10 RENAME TO projects;
          CREATE UNIQUE INDEX projects_active_name
            ON projects(name_key) WHERE archived_at IS NULL;
          CREATE UNIQUE INDEX projects_active_cwd
            ON projects(cwd) WHERE archived_at IS NULL;
          CREATE INDEX projects_ordered
            ON projects(archived_at, sort_order, created_at);
        `);
        const now = Date.now();
        this.setMeta("schema_version", CURRENT_SCHEMA_VERSION);
        this.setMeta("schema_v10_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
    const violations = this.database.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error("Bridge state schema v10 migration produced foreign-key violations.");
    }
  }

  private registerBridgeInstance(): void {
    this.transaction(() => {
      const now = Date.now();
      this.database
        .prepare(`
          UPDATE bridge_instances
             SET stopped_at = ?, termination_reason = 'superseded-by-restart'
           WHERE stopped_at IS NULL AND instance_id <> ?
        `)
        .run(now, this.currentInstanceId);
      this.database
        .prepare(`
          INSERT INTO bridge_instances(
            instance_id, started_at, stopped_at, termination_reason, process_id, payload
          ) VALUES (?, ?, NULL, NULL, ?, ?)
        `)
        .run(
          this.currentInstanceId,
          now,
          process.pid,
          JSON.stringify({ schemaVersion: Number(CURRENT_SCHEMA_VERSION) })
        );
    });
  }

  private normalizeLegacyExecutionModes(): void {
    this.transaction(() => {
      const activityChanges = this.database
        .prepare("UPDATE activities SET execution_mode = 'background' WHERE execution_mode = 'auto'")
        .run().changes;
      const jobChanges = this.database
        .prepare("UPDATE jobs SET execution_mode = 'background' WHERE execution_mode = 'auto'")
        .run().changes;
      if (activityChanges > 0 || jobChanges > 0 || !this.getMeta("legacy_auto_execution_mode_migrated_at")) {
        this.setMeta("legacy_auto_execution_mode_migrated_at", new Date().toISOString());
      }
    });
  }

  private upsertJobInternal(
    job: JobRowInput,
    allowLegacyUnattributedCancellation = false
  ): void {
    if (!valueIsOneOf(ACTIVITY_JOB_STATUSES, job.status)) {
      throw new Error(`Invalid Codex job status for Activity storage: ${job.status}.`);
    }
    const activityId = normalizeUuid(
      job.activityId || legacyActivityIdForJob(job.jobId),
      "job activityId"
    );
    const scopeId = normalizeUuid(job.scopeId, "job scopeId");
    const executionMode = normalizeActivityExecutionMode(job.executionMode || "background");
    const previous = this.database
      .prepare(`
        SELECT scope_id, activity_id, thread_id, status, backend_kind, bridge_instance_id,
               terminal_version, agent_id, context_mode, project_id, project_label,
               project_uuid, project_name_snapshot, project_cwd_snapshot, archived_at
          FROM jobs WHERE job_id = ?
      `)
      .get(job.jobId) as PreviousJobRow | undefined;
    const terminalOrigin = job.terminalOrigin;
    if (terminalOrigin && !JOB_TERMINAL_ORIGINS.includes(terminalOrigin)) {
      throw new Error("Invalid Codex job terminal origin.");
    }
    const cancellationIntentId = job.cancellationIntentId
      ? normalizeUuid(job.cancellationIntentId, "job cancellationIntentId")
      : undefined;
    if (cancellationIntentId) {
      const intent = this.getCancellationIntent(cancellationIntentId);
      if (
        !intent ||
        intent.targetKind !== "job" ||
        intent.targetJobId !== job.jobId ||
        intent.scopeId !== job.scopeId
      ) {
        throw new Error(
          "CANCELLATION_PROVENANCE_REQUIRED: Job cancellation correlation does not match a durable target intent."
        );
      }
    }
    if (
      job.status === "cancelled" &&
      previous?.status !== "cancelled" &&
      !cancellationIntentId &&
      !(allowLegacyUnattributedCancellation &&
        terminalOrigin === "legacy-unattributed-cancellation")
    ) {
      throw new Error(
        "CANCELLATION_PROVENANCE_REQUIRED: A job cannot transition to cancelled without a durable cancellation intent."
      );
    }
    if (terminalOrigin === "explicit-cancellation" && !cancellationIntentId) {
      throw new Error(
        "CANCELLATION_PROVENANCE_REQUIRED: Explicit cancellation terminal origin requires a durable intent."
      );
    }
    const expectedStatusByOrigin: Partial<Record<JobTerminalOrigin, string>> = {
      "normal-completion": "completed",
      "upstream-failure": "failed",
      "app-server-interrupted": "interrupted",
      "explicit-cancellation": "cancelled",
      "assignment-containment": "interrupted",
      "bridge-restart": "interrupted",
      "worker-loss": "interrupted"
    };
    if (
      terminalOrigin &&
      expectedStatusByOrigin[terminalOrigin] &&
      job.status !== expectedStatusByOrigin[terminalOrigin]
    ) {
      throw new Error(
        `Invalid job terminal-origin matrix: ${terminalOrigin} cannot produce ${job.status}.`
      );
    }
    if (
      terminalOrigin === "app-server-interrupted" &&
      cancellationIntentId
    ) {
      throw new Error(
        "A spontaneous App Server interruption cannot claim a cancellation intent."
      );
    }
    if (
      job.status === "cancelled" &&
      previous?.status !== "cancelled" &&
      terminalOrigin !== "explicit-cancellation" &&
      !(allowLegacyUnattributedCancellation &&
        terminalOrigin === "legacy-unattributed-cancellation")
    ) {
      throw new Error(
        "A new cancelled terminal state requires explicit-cancellation origin."
      );
    }
    job.terminalOrigin = terminalOrigin;
    job.cancellationIntentId = cancellationIntentId;
    if (previous && previous.scope_id !== scopeId) {
      throw new Error("A persisted Codex job cannot move to another conversation scope.");
    }
    if (previous && previous.activity_id !== activityId) {
      throw new Error("A persisted Codex job cannot move to another Activity.");
    }
    const agentId = job.agentId
      ? normalizeUuid(job.agentId, "job agentId")
      : previous?.agent_id || undefined;
    if (previous?.agent_id && agentId !== previous.agent_id) {
      throw new Error("A persisted Codex job cannot move to another Agent.");
    }
    if (agentId) {
      const agent = this.getAgent(agentId);
      if (!agent || agent.scopeId !== scopeId) {
        throw new Error("The persisted Codex job Agent belongs to another scope or does not exist.");
      }
    }
    const contextMode = job.contextMode ||
      (previous?.context_mode && isAgentContextMode(previous.context_mode)
        ? previous.context_mode
        : undefined);
    if (contextMode && !isAgentContextMode(contextMode)) throw new Error("Invalid job context mode.");
    let project = normalizeProjectIdentity(job.projectId, job.projectLabel);
    const previousProject = normalizeProjectIdentity(
      previous?.project_uuid || undefined,
      previous?.project_name_snapshot || undefined
    );
    if (previousProject && project && previousProject.projectId !== project.projectId) {
      throw new Error(
        `${PROJECT_CONTEXT_CONFLICT}: A persisted Codex job cannot move to another project.`
      );
    }
    project = previousProject || project;
    const requestCollision = this.database
      .prepare(`
        SELECT job_id, archived_at FROM jobs
         WHERE scope_id = ? AND request_id = ? AND job_id <> ?
      `)
      .get(scopeId, job.requestId, job.jobId) as
      | { job_id: string; archived_at: number | null }
      | undefined;
    if (requestCollision) {
      throw new Error(
        requestCollision.archived_at
          ? "requestId belongs to an archived Codex job in this scope; its result body is no longer retained. Use a fresh requestId for a new logical turn."
          : "requestId was already used by another Codex job in this scope."
      );
    }

    this.ensureScope(scopeId, job.updatedAt);
    let activity = this.getActivity(activityId);
    let activityCreated = false;
    if (!activity) {
      const projectCwd = project
        ? normalizeRequiredString(job.cwd, "project working directory", 4_000)
        : undefined;
      this.insertActivity({
        activityId,
        scopeId,
        ...project,
        ...(projectCwd ? { projectCwd } : {}),
        title: `Codex job ${job.jobId.slice(0, 8)}`,
        kind: "other",
        executionMode,
        handoffPolicy: "none",
        completionTrigger: "manual",
        legacy: true,
        now: job.updatedAt
      });
      activity = this.requireActivity(activityId);
      activityCreated = true;
    } else if (activity.scopeId !== scopeId) {
      throw new Error("The requested Activity belongs to another conversation scope.");
    } else if (!previous && activity.lifecycle !== "open") {
      throw new Error("A new Codex job cannot be attached to a non-open Activity.");
    }

    let activityProject = this.getActivityProjectAdmission(activityId);
    if (activityProject && project && activityProject.projectId !== project.projectId) {
      throw new Error(
        `${PROJECT_CONTEXT_CONFLICT}: A Codex job must retain its Activity project.`
      );
    }
    if (!activityProject && project) {
      const projectCwd = normalizeRequiredString(job.cwd, "project working directory", 4_000);
      if (
        activity.counts.total > 0 &&
        !previous &&
        !this.activityJobsUseCwd(activityId, projectCwd)
      ) {
        throw new Error(
          `${PROJECT_CONTEXT_CONFLICT}: An Activity with admitted work cannot change projects.`
        );
      }
      this.database
        .prepare(`
          UPDATE activities
             SET project_id = ?, project_label = ?, project_cwd = ?,
                 project_uuid = ?, project_name_snapshot = ?, project_cwd_snapshot = ?
           WHERE activity_id = ? AND project_uuid IS NULL
        `)
        .run(
          project.projectId,
          project.projectLabel,
          projectCwd,
          project.projectId,
          project.projectLabel,
          projectCwd,
          activityId
        );
      activityProject = this.getActivityProjectAdmission(activityId);
    }
    if (activityProject) {
      if (job.cwd !== undefined && job.cwd !== activityProject.projectCwd) {
        throw new Error(
          `${PROJECT_CONTEXT_CONFLICT}: A Codex job working folder must match its Activity project.`
        );
      }
      job.cwd = activityProject.projectCwd;
      project = {
        projectId: activityProject.projectId,
        projectLabel: activityProject.projectLabel
      };
    }

    const threadId = normalizeOptionalString(job.threadId || job.sessionDecision?.threadId);
    const wasTerminal = previous ? isTerminalActivityJobStatus(previous.status) : false;
    const nowTerminal = isTerminalActivityJobStatus(job.status);
    const terminalVersion = nowTerminal
      ? wasTerminal
        ? previous?.terminal_version || job.terminalVersion || 1
        : Math.max(previous?.terminal_version || 0, job.terminalVersion || 0) + 1
      : undefined;
    const backendKind = normalizeOptionalString(job.backendKind) || previous?.backend_kind || "mcp-server";
    const bridgeInstanceId = previous
      ? normalizeOptionalString(job.bridgeInstanceId) || previous.bridge_instance_id || undefined
      : normalizeOptionalString(job.bridgeInstanceId) || this.currentInstanceId;
    job.activityId = activityId;
    job.scopeId = scopeId;
    job.threadId = threadId;
    job.executionMode = executionMode;
    job.backendKind = backendKind;
    job.agentId = agentId;
    job.contextMode = contextMode;
    job.projectId = project?.projectId;
    job.projectLabel = project?.projectLabel;
    job.bridgeInstanceId = bridgeInstanceId;
    job.terminalVersion = terminalVersion;

    this.database
      .prepare(`
        INSERT INTO jobs(
          job_id, scope_id, request_id, activity_id, thread_id, status, execution_mode,
          backend_kind, bridge_instance_id, worker_id, worker_generation, upstream_request_id,
          terminal_version, agent_id, context_mode, project_id, project_label,
          project_uuid, project_name_snapshot, project_cwd_snapshot,
          updated_at, archived_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          scope_id = excluded.scope_id,
          request_id = excluded.request_id,
          activity_id = excluded.activity_id,
          thread_id = excluded.thread_id,
          status = excluded.status,
          execution_mode = excluded.execution_mode,
          backend_kind = excluded.backend_kind,
          bridge_instance_id = excluded.bridge_instance_id,
          worker_id = excluded.worker_id,
          worker_generation = excluded.worker_generation,
          upstream_request_id = excluded.upstream_request_id,
          terminal_version = excluded.terminal_version,
          agent_id = excluded.agent_id,
          context_mode = excluded.context_mode,
          project_id = excluded.project_id,
          project_label = excluded.project_label,
          project_uuid = excluded.project_uuid,
          project_name_snapshot = excluded.project_name_snapshot,
          project_cwd_snapshot = excluded.project_cwd_snapshot,
          updated_at = excluded.updated_at,
          archived_at = NULL,
          payload = excluded.payload
      `)
      .run(
        job.jobId,
        scopeId,
        job.requestId,
        activityId,
        threadId || null,
        job.status,
        executionMode,
        backendKind,
        bridgeInstanceId || null,
        normalizeOptionalString(job.workerId) || null,
        Number.isInteger(job.workerGeneration) ? job.workerGeneration : null,
        normalizeOptionalString(job.upstreamRequestId) || null,
        terminalVersion || null,
        agentId || null,
        contextMode || null,
        project?.projectId || null,
        project?.projectLabel || null,
        project?.projectId || null,
        project?.projectLabel || null,
        project ? job.cwd || null : null,
        job.updatedAt,
        JSON.stringify(job)
      );

    const agentStateChanged = agentId
      ? this.syncAgentForJob(job, agentId, activityId, job.updatedAt)
      : false;
    const statusChanged = !previous || previous.status !== job.status;
    const threadChanged = (previous?.thread_id || undefined) !== threadId;
    const restoredFromArchive = Boolean(previous?.archived_at);
    if (!activityCreated && !statusChanged && !threadChanged && !restoredFromArchive && !agentStateChanged) return;

    const scopeVersion = this.nextScopeVersion(scopeId, job.updatedAt);
    if (activityCreated) {
      this.insertActivityEvent({
        activityId,
        scopeId,
        scopeVersion,
        eventType: "compatibility-activity-created",
        createdAt: job.updatedAt,
        payload: { jobId: job.jobId }
      });
    }
    const eventType = !previous
      ? "job-started"
      : statusChanged
        ? `job-${job.status}`
        : restoredFromArchive
          ? "job-retained-again"
          : "thread-linked";
    this.insertJobEvent({
      jobId: job.jobId,
      activityId,
      scopeId,
      scopeVersion,
      eventType,
      status: job.status,
      createdAt: job.updatedAt,
      payload: {
        threadLinked: Boolean(threadId),
        terminalVersion: terminalVersion || null,
        backendKind,
        agentId: agentId || null,
        contextMode: contextMode || null,
        terminalOrigin: terminalOrigin || null,
        cancellationIntentId: cancellationIntentId || null
      }
    });
    this.reconcileActivity(activityId, scopeVersion, job.updatedAt);
  }

  private syncAgentForJob(
    job: JobRowInput,
    agentId: string,
    activityId: string,
    now: number
  ): boolean {
    const agent = this.requireAgent(agentId);
    if (agent.lifecycle === "archived") {
      throw new Error("An archived Agent cannot own a running Codex job.");
    }
    let lifecycle: BridgeAgentLifecycle;
    let currentJobId: string | undefined;
    let assignmentReleased = false;
    if (isActiveActivityJobStatus(job.status)) {
      const pending = (job as JobRowInput & { pendingInteractions?: unknown }).pendingInteractions;
      lifecycle = Array.isArray(pending) && pending.length > 0 ? "waiting-input" : "active";
      currentJobId = job.jobId;
    } else {
      const active = this.database
        .prepare(`
          SELECT job_id, payload FROM jobs
           WHERE agent_id = ? AND archived_at IS NULL
             AND status IN ('running','terminating','termination-failed')
           ORDER BY updated_at DESC LIMIT 1
        `)
        .get(agentId) as { job_id: string; payload: string } | undefined;
      if (active) {
        const payload = parsePayload({ payload: active.payload }, "active Agent job") as Record<string, unknown>;
        lifecycle = Array.isArray(payload.pendingInteractions) && payload.pendingInteractions.length > 0
          ? "waiting-input"
          : "active";
        currentJobId = active.job_id;
      } else {
        lifecycle = agent.lifecycle === "orphaned" ? "orphaned" : "idle";
      }
      assignmentReleased = this.database
        .prepare(`
          UPDATE activity_agents SET released_at = COALESCE(released_at, ?)
           WHERE activity_id = ? AND agent_id = ? AND released_at IS NULL
        `)
        .run(now, activityId, agentId).changes > 0;
    }
    if (agent.lifecycle === lifecycle && agent.currentJobId === currentJobId) return assignmentReleased;
    this.database
      .prepare(`
        UPDATE agents SET lifecycle = ?, current_job_id = ?, version = version + 1, updated_at = ?
         WHERE agent_id = ?
      `)
      .run(lifecycle, currentJobId || null, now, agentId);
    return true;
  }

  private reconcileActivity(activityId: string, scopeVersion: number, now: number): void {
    const before = this.requireActivity(activityId);
    const counts = this.countActivityJobs(activityId);
    const decision = deriveActivityBarrier(before, counts);
    const completionTransition =
      decision.completionChannel &&
      (before.lifecycle !== decision.lifecycle ||
        before.waitingOn !== decision.waitingOn ||
        before.verification !== decision.verification);
    const completionVersion = completionTransition
      ? before.completionVersion + 1
      : before.completionVersion;
    const completedAt = decision.lifecycle === "completed" ? before.completedAt || now : before.completedAt;
    this.database
      .prepare(`
        UPDATE activities
           SET lifecycle = ?, waiting_on = ?, verification = ?, version = version + 1,
               completion_version = ?, updated_at = ?, completed_at = ?,
               total_jobs = ?, running_jobs = ?, completed_jobs = ?, failed_jobs = ?,
               interrupted_jobs = ?, cancelled_jobs = ?, terminal_jobs = ?
         WHERE activity_id = ?
      `)
      .run(
        decision.lifecycle,
        decision.waitingOn,
        decision.verification,
        completionVersion,
        now,
        completedAt || null,
        counts.total,
        counts.running,
        counts.completed,
        counts.failed,
        counts.interrupted,
        counts.cancelled,
        counts.terminal,
        activityId
      );
    this.insertActivityEvent({
      activityId,
      scopeId: before.scopeId,
      scopeVersion,
      eventType: completionTransition
        ? decision.completionChannel === "verify"
          ? "verification-pending"
          : "activity-completed"
        : decision.attentionRequired
          ? "attention-required"
          : "child-jobs-changed",
      createdAt: now,
      payload: { counts, waitingOn: decision.waitingOn }
    });
    if (completionTransition && decision.completionChannel) {
      this.insertCompletionOutbox({
        activityId,
        scopeId: before.scopeId,
        completionVersion,
        channel: decision.completionChannel,
        createdAt: now,
        payload: {
          activityId,
          completionVersion,
          channel: decision.completionChannel,
          counts,
          requiresResultVerification: decision.completionChannel === "verify"
        }
      });
    }
  }

  private countActivityJobs(activityId: string): ActivityJobCounts {
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status IN ('running','terminating','termination-failed') THEN 1 ELSE 0 END) AS running,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) AS interrupted,
               SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
               SUM(CASE WHEN status IN ('completed','failed','interrupted','cancelled') THEN 1 ELSE 0 END) AS terminal
          FROM jobs WHERE activity_id = ?
      `)
      .get(activityId) as Record<string, number | null>;
    return {
      total: Number(row.total || 0),
      running: Number(row.running || 0),
      completed: Number(row.completed || 0),
      failed: Number(row.failed || 0),
      interrupted: Number(row.interrupted || 0),
      cancelled: Number(row.cancelled || 0),
      terminal: Number(row.terminal || 0)
    };
  }

  private activityJobsUseCwd(activityId: string, cwd: string): boolean {
    const rows = this.database
      .prepare("SELECT payload FROM jobs WHERE activity_id = ? ORDER BY updated_at ASC")
      .all(activityId) as JsonRow[];
    return rows.length > 0 && rows.every((row) => {
      const payload = parsePayload(row, "project backfill job");
      return isRecord(payload) && normalizeOptionalString(payload.cwd) === cwd;
    });
  }

  private insertActivity(input: {
    activityId: string;
    scopeId: string;
    continuationOfActivityId?: string;
    title: string;
    kind: ActivityKind;
    executionMode: ActivityExecutionMode;
    handoffPolicy: ActivityHandoffPolicy;
    completionTrigger: ActivityCompletionTrigger;
    legacy: boolean;
    now: number;
    updatedAt?: number;
    waitingOn?: BridgeActivity["waitingOn"];
    counts?: ActivityJobCounts;
  } & Partial<ActivityProjectAdmission>): void {
    const counts = input.counts || countsForSingleStatus(undefined);
    if (!this.tableHasColumn("activities", "card_generation")) {
      this.database
        .prepare(`
          INSERT INTO activities(
            activity_id, scope_id, title, kind, execution_mode, handoff_policy,
            completion_trigger, lifecycle, waiting_on, verification, version,
            completion_version, legacy, created_at, updated_at, sealed_at, completed_at,
            total_jobs, running_jobs, completed_jobs, failed_jobs, interrupted_jobs,
            cancelled_jobs, terminal_jobs
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, 'not-required', 1, 0, ?, ?, ?, NULL, NULL,
                    ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.activityId,
          input.scopeId,
          normalizeActivityTitle(input.title),
          input.kind,
          input.executionMode,
          input.handoffPolicy,
          input.completionTrigger,
          input.waitingOn || "none",
          input.legacy ? 1 : 0,
          input.now,
          input.updatedAt ?? input.now,
          counts.total,
          counts.running,
          counts.completed,
          counts.failed,
          counts.interrupted,
          counts.cancelled,
          counts.terminal
        );
      return;
    }
    if (!this.tableHasColumn("activities", "project_id")) {
      this.database
      .prepare(`
        INSERT INTO activities(
          activity_id, scope_id, continuation_of_activity_id, card_generation,
          title, kind, execution_mode, handoff_policy,
          completion_trigger, lifecycle, waiting_on, verification, version,
          completion_version, legacy, created_at, updated_at, sealed_at, completed_at,
          total_jobs, running_jobs, completed_jobs, failed_jobs, interrupted_jobs,
          cancelled_jobs, terminal_jobs
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'open', ?, 'not-required', 1, 0, ?, ?, ?, NULL, NULL,
                  ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.activityId,
        input.scopeId,
        input.continuationOfActivityId || null,
        normalizeActivityTitle(input.title),
        input.kind,
        input.executionMode,
        input.handoffPolicy,
        input.completionTrigger,
        input.waitingOn || "none",
        input.legacy ? 1 : 0,
        input.now,
        input.updatedAt ?? input.now,
        counts.total,
        counts.running,
        counts.completed,
        counts.failed,
        counts.interrupted,
        counts.cancelled,
        counts.terminal
      );
      return;
    }
    const project = normalizeActivityProjectAdmission(
      input.projectId,
      input.projectLabel,
      input.projectCwd
    );
    this.database
      .prepare(`
        INSERT INTO activities(
          activity_id, scope_id, project_id, project_label, project_cwd,
          project_uuid, project_name_snapshot, project_cwd_snapshot,
          continuation_of_activity_id, card_generation,
          title, kind, execution_mode, handoff_policy,
          completion_trigger, lifecycle, waiting_on, verification, version,
          completion_version, legacy, created_at, updated_at, sealed_at, completed_at,
          total_jobs, running_jobs, completed_jobs, failed_jobs, interrupted_jobs,
          cancelled_jobs, terminal_jobs
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'open', ?, 'not-required', 1, 0, ?, ?, ?, NULL, NULL,
                  ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.activityId,
        input.scopeId,
        project?.projectId || null,
        project?.projectLabel || null,
        project?.projectCwd || null,
        project?.projectId || null,
        project?.projectLabel || null,
        project?.projectCwd || null,
        input.continuationOfActivityId || null,
        normalizeActivityTitle(input.title),
        input.kind,
        input.executionMode,
        input.handoffPolicy,
        input.completionTrigger,
        input.waitingOn || "none",
        input.legacy ? 1 : 0,
        input.now,
        input.updatedAt ?? input.now,
        counts.total,
        counts.running,
        counts.completed,
        counts.failed,
        counts.interrupted,
        counts.cancelled,
        counts.terminal
      );
  }

  private tableHasColumn(table: string, column: string): boolean {
    return (this.database.pragma(`table_info(${table})`) as Array<{ name: string }>)
      .some((entry) => entry.name === column);
  }

  private touchActivity(
    activityId: string,
    scopeVersion: number,
    now: number,
    eventType: string,
    payload: unknown
  ): void {
    const activity = this.requireActivity(activityId);
    this.database
      .prepare("UPDATE activities SET version = version + 1, updated_at = ? WHERE activity_id = ?")
      .run(now, activityId);
    this.insertActivityEvent({
      activityId,
      scopeId: activity.scopeId,
      scopeVersion,
      eventType,
      createdAt: now,
      payload
    });
  }

  private ensureScope(scopeId: string, now: number): void {
    this.database
      .prepare(`
        INSERT INTO scopes(scope_id, created_at, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(scope_id) DO UPDATE SET updated_at = MAX(updated_at, excluded.updated_at)
      `)
      .run(scopeId, now, now);
    this.database
      .prepare(`
        INSERT OR IGNORE INTO scope_versions(scope_id, version, updated_at) VALUES (?, 0, ?)
      `)
      .run(scopeId, now);
  }

  private nextScopeVersion(scopeId: string, now: number): number {
    this.ensureScope(scopeId, now);
    this.database
      .prepare("UPDATE scope_versions SET version = version + 1, updated_at = ? WHERE scope_id = ?")
      .run(now, scopeId);
    return this.getScopeVersion(scopeId);
  }

  private insertActivityEvent(input: Omit<ActivityEventRecord, "eventId">): void {
    this.database
      .prepare(`
        INSERT INTO activity_events(
          activity_id, scope_id, scope_version, event_type, created_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.activityId,
        input.scopeId,
        input.scopeVersion,
        input.eventType,
        input.createdAt,
        JSON.stringify(input.payload)
      );
  }

  private insertJobEvent(input: Omit<JobEventRecord, "eventId">): void {
    this.database
      .prepare(`
        INSERT INTO job_events(
          job_id, activity_id, scope_id, scope_version, event_type, status, created_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.jobId,
        input.activityId,
        input.scopeId,
        input.scopeVersion,
        input.eventType,
        input.status,
        input.createdAt,
        JSON.stringify(input.payload)
      );
  }

  private assertCancellationTarget(scopeId: string, target: CancellationTarget): void {
    const activity = this.getActivity(target.activityId);
    if (!activity || activity.scopeId !== scopeId) {
      throw new Error("Cancellation target Activity is missing or belongs to another scope.");
    }
    if (target.kind === "activity") {
      if (target.jobId) throw new Error("An Activity cancellation target cannot include a job id.");
      return;
    }
    if (!target.jobId) throw new Error("A job cancellation target requires a job id.");
    const row = this.database
      .prepare(`
        SELECT scope_id, activity_id, agent_id, thread_id, upstream_request_id
          FROM jobs WHERE job_id = ? AND archived_at IS NULL
      `)
      .get(target.jobId) as
      | {
          scope_id: string;
          activity_id: string;
          agent_id: string | null;
          thread_id: string | null;
          upstream_request_id: string | null;
        }
      | undefined;
    if (!row || row.scope_id !== scopeId || row.activity_id !== target.activityId) {
      throw new Error("Cancellation target job is missing or does not match its Activity scope.");
    }
    if (target.agentId && row.agent_id !== target.agentId) {
      throw new Error("Cancellation target Agent no longer matches the job.");
    }
    if (target.threadId && row.thread_id !== target.threadId) {
      throw new Error("Cancellation target thread no longer matches the job.");
    }
    if (target.turnId && row.upstream_request_id !== target.turnId) {
      throw new Error("Cancellation target turn no longer matches the job.");
    }
  }

  private insertCancellationIntent(input: {
    intentId: string;
    scopeId: string;
    requestId: string;
    parentIntentId?: string;
    cascadeId: string;
    source: CancellationSource;
    toolName: string;
    actionName: string;
    target: CancellationTarget;
    expectedVersion: number;
    callerPresentation?: CancellationPresentation;
    widgetProof?: { instanceDigest: string; cardGeneration: number };
    callerRequestDigest?: string;
    reasonCode: string;
    now: number;
  }): void {
    this.database
      .prepare(`
        INSERT INTO cancellation_intents(
          intent_id, scope_id, request_id, parent_intent_id, cascade_id, source,
          tool_name, action_name, target_kind, target_job_id, target_activity_id,
          target_agent_id, target_thread_id, target_turn_id, target_presentation_id,
          expected_version, caller_presentation_kind, caller_presentation_id,
          widget_instance_present, widget_instance_digest, card_generation,
          caller_request_digest, bridge_instance_id, reason_code, status,
          created_at, dispatched_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, NULL, NULL)
      `)
      .run(
        input.intentId,
        input.scopeId,
        input.requestId,
        input.parentIntentId || null,
        input.cascadeId,
        input.source,
        input.toolName,
        input.actionName,
        input.target.kind,
        input.target.jobId || null,
        input.target.activityId,
        input.target.agentId || null,
        input.target.threadId || null,
        input.target.turnId || null,
        input.target.presentationId || null,
        input.expectedVersion,
        input.callerPresentation?.kind || null,
        input.callerPresentation?.activityPresentationId || null,
        input.widgetProof ? 1 : 0,
        input.widgetProof?.instanceDigest || null,
        input.widgetProof?.cardGeneration || null,
        input.callerRequestDigest || null,
        this.currentInstanceId,
        input.reasonCode,
        input.now
      );
  }

  private requireCancellationIntent(intentId: string): CancellationIntentRecord {
    const intent = this.getCancellationIntent(intentId);
    if (!intent) throw new Error("Unknown durable cancellation intent.");
    return intent;
  }

  private recordCancellationIntentEvent(
    intent: CancellationIntentRecord,
    eventType: string,
    now: number
  ): void {
    const scopeVersion = this.nextScopeVersion(intent.scopeId, now);
    const payload = {
      cancellationIntentId: intent.intentId,
      cancellationRequestId: intent.requestId,
      source: intent.source,
      tool: intent.toolName,
      action: intent.actionName,
      reasonCode: intent.reasonCode,
      expectedVersion: intent.expectedVersion,
      parentIntentId: intent.parentIntentId || null,
      cascadeId: intent.cascadeId,
      callerPresentation: intent.callerPresentation || null,
      targetPresentationId: intent.targetPresentationId || null,
      widgetInstancePresent: intent.widgetInstancePresent,
      cardGeneration: intent.cardGeneration || null,
      bridgeInstanceId: intent.bridgeInstanceId
    };
    if (intent.targetKind === "job" && intent.targetJobId) {
      const row = this.database
        .prepare("SELECT status FROM jobs WHERE job_id = ?")
        .get(intent.targetJobId) as { status: string } | undefined;
      if (!row) throw new Error("Cancellation intent job disappeared before audit recording.");
      this.insertJobEvent({
        jobId: intent.targetJobId,
        activityId: intent.targetActivityId,
        scopeId: intent.scopeId,
        scopeVersion,
        eventType,
        status: row.status,
        createdAt: now,
        payload
      });
      return;
    }
    this.insertActivityEvent({
      activityId: intent.targetActivityId,
      scopeId: intent.scopeId,
      scopeVersion,
      eventType,
      createdAt: now,
      payload
    });
  }

  private insertCompletionOutbox(input: {
    activityId: string;
    scopeId: string;
    completionVersion: number;
    channel: "notify" | "verify";
    createdAt: number;
    payload: unknown;
  }): void {
    this.database
      .prepare(`
        INSERT OR IGNORE INTO completion_outbox(
          activity_id, scope_id, completion_version, channel, payload, attempt_count,
          next_attempt_at, lease_owner, lease_expires_at, delivered_at, acknowledged_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?)
      `)
      .run(
        input.activityId,
        input.scopeId,
        input.completionVersion,
        input.channel,
        JSON.stringify(input.payload),
        input.createdAt
      );
  }

  private getActivityRow(activityId: string): ActivityStorageRow | undefined {
    return this.database
      .prepare("SELECT * FROM activities WHERE activity_id = ?")
      .get(activityId) as ActivityStorageRow | undefined;
  }

  private requireAgent(agentId: string): BridgeAgent {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("Unknown Agent id in this conversation scope.");
    return agent;
  }

  private requireActivity(activityId: string): BridgeActivity {
    const activity = this.getActivity(activityId);
    if (!activity) throw new Error("Unknown Activity id.");
    return activity;
  }

  private requireMutableActivity(activityId: string, target: string): BridgeActivity {
    const activity = this.requireActivity(activityId);
    if (
      activity.lifecycle === "completed" ||
      activity.lifecycle === "cancelled" ||
      activity.lifecycle === "abandoned"
    ) {
      throw new Error(
        `A ${activity.lifecycle} Activity cannot transition to ${target}. Create a new Activity instead.`
      );
    }
    return activity;
  }

  private assertNoRunningJobs(activity: BridgeActivity, action: string): void {
    if (activity.counts.running > 0) {
      throw new Error(`Cannot ${action} an Activity while ${activity.counts.running} child job(s) are running.`);
    }
  }

  private assertEvidenceJobsBelongToActivity(activityId: string, jobIds: string[]): void {
    const lookup = this.database.prepare("SELECT activity_id FROM jobs WHERE job_id = ?");
    for (const jobId of jobIds) {
      const row = lookup.get(jobId) as { activity_id: string } | undefined;
      if (!row || row.activity_id !== activityId) {
        throw new Error(`Verification evidence job '${jobId}' is not a child of this Activity.`);
      }
    }
  }

  private transitionActivityTerminal(
    activity: BridgeActivity,
    lifecycle: "cancelled" | "abandoned",
    eventType: string,
    payload: unknown,
    now: number
  ): BridgeActivity {
    const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
    this.database
      .prepare(`
        UPDATE activities
           SET lifecycle = ?, waiting_on = 'none', verification = 'not-required',
               version = version + 1, updated_at = ?
         WHERE activity_id = ?
      `)
      .run(lifecycle, now, activity.activityId);
    this.insertActivityEvent({
      activityId: activity.activityId,
      scopeId: activity.scopeId,
      scopeVersion,
      eventType,
      createdAt: now,
      payload
    });
    this.acknowledgeCompletionOutbox(activity.activityId, undefined, now);
    return this.requireActivity(activity.activityId);
  }

  private acknowledgeCompletionOutbox(
    activityId: string,
    channel: "notify" | "verify" | undefined,
    now: number
  ): void {
    if (channel) {
      this.database
        .prepare(`
          UPDATE completion_outbox
             SET acknowledged_at = COALESCE(acknowledged_at, ?)
           WHERE activity_id = ? AND channel = ? AND acknowledged_at IS NULL
        `)
        .run(now, activityId, channel);
      return;
    }
    this.database
      .prepare(`
        UPDATE completion_outbox
           SET acknowledged_at = COALESCE(acknowledged_at, ?)
         WHERE activity_id = ? AND acknowledged_at IS NULL
      `)
      .run(now, activityId);
  }

  private enforcePrivateFileModes(): void {
    if (this.options.file === ":memory:") return;
    for (const file of [this.options.file, `${this.options.file}-wal`, `${this.options.file}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }
}

type NormalizedCancellationOperationInput = Omit<BeginCancellationOperationInput, "now"> & {
  now: number;
};

type NormalizedCancellationIntentInput = Omit<CreateCancellationIntentInput, "now"> & {
  now: number;
};

function normalizeCancellationOperationInput(
  input: BeginCancellationOperationInput
): NormalizedCancellationOperationInput {
  return {
    scopeId: normalizeUuid(input.scopeId, "cancellation scopeId"),
    requestId: normalizeUuid(input.requestId, "cancellation requestId"),
    actionHash: normalizeDigest(input.actionHash, "cancellation actionHash"),
    source: normalizeCancellationSource(input.source),
    toolName: normalizeRequiredString(input.toolName, "cancellation tool name", 100),
    actionName: normalizeRequiredString(input.actionName, "cancellation action name", 100),
    target: normalizeCancellationTarget(input.target),
    expectedVersion: normalizeExpectedVersion(input.expectedVersion),
    callerPresentation: normalizeCancellationPresentation(input.callerPresentation),
    widgetProof: normalizeCancellationWidgetProof(input.widgetProof),
    callerRequestDigest: normalizeOptionalDigest(input.callerRequestDigest),
    reasonCode: normalizeReasonCode(input.reasonCode),
    now: normalizeEventTimestamp(input.now ?? Date.now())
  };
}

function normalizeCancellationIntentInput(
  input: CreateCancellationIntentInput
): NormalizedCancellationIntentInput {
  return {
    scopeId: normalizeUuid(input.scopeId, "cancellation scopeId"),
    requestId: normalizeUuid(input.requestId, "cancellation requestId"),
    parentIntentId: normalizeUuid(input.parentIntentId, "parent cancellation intentId"),
    cascadeId: normalizeUuid(input.cascadeId, "cancellation cascadeId"),
    source: normalizeCancellationSource(input.source),
    toolName: normalizeRequiredString(input.toolName, "cancellation tool name", 100),
    actionName: normalizeRequiredString(input.actionName, "cancellation action name", 100),
    target: normalizeCancellationTarget(input.target),
    expectedVersion: normalizeExpectedVersion(input.expectedVersion),
    callerPresentation: normalizeCancellationPresentation(input.callerPresentation),
    widgetProof: normalizeCancellationWidgetProof(input.widgetProof),
    callerRequestDigest: normalizeOptionalDigest(input.callerRequestDigest),
    reasonCode: normalizeReasonCode(input.reasonCode),
    now: normalizeEventTimestamp(input.now ?? Date.now())
  };
}

function normalizeCancellationSource(source: CancellationSource): CancellationSource {
  if (!CANCELLATION_SOURCES.includes(source)) throw new Error("Unsupported cancellation source.");
  return source;
}

function normalizeCancellationTarget(target: CancellationTarget): CancellationTarget {
  if (target.kind !== "job" && target.kind !== "activity") {
    throw new Error("Unsupported cancellation target kind.");
  }
  const jobId = target.jobId
    ? normalizeRequiredString(target.jobId, "cancellation target jobId", 200)
    : undefined;
  if ((target.kind === "job") !== Boolean(jobId)) {
    throw new Error("Cancellation target kind and job id do not match.");
  }
  return {
    kind: target.kind,
    ...(jobId ? { jobId } : {}),
    activityId: normalizeUuid(target.activityId, "cancellation target activityId"),
    ...(target.agentId
      ? { agentId: normalizeUuid(target.agentId, "cancellation target agentId") }
      : {}),
    ...(target.threadId
      ? { threadId: normalizeRequiredString(target.threadId, "cancellation target threadId", 200) }
      : {}),
    ...(target.turnId
      ? { turnId: normalizeRequiredString(target.turnId, "cancellation target turnId", 200) }
      : {}),
    ...(target.presentationId
      ? {
          presentationId: normalizeUuid(
            target.presentationId,
            "cancellation target presentationId"
          )
        }
      : {})
  };
}

function normalizeCancellationPresentation(
  presentation: CancellationPresentation | undefined
): CancellationPresentation | undefined {
  if (!presentation) return undefined;
  if (presentation.kind === "explicit") {
    if (presentation.activityPresentationId) {
      throw new Error("An explicit caller presentation cannot include an automatic presentation id.");
    }
    return { kind: "explicit" };
  }
  if (presentation.kind !== "automatic" || !presentation.activityPresentationId) {
    throw new Error("An automatic caller presentation requires an exact presentation id.");
  }
  return {
    kind: "automatic",
    activityPresentationId: normalizeUuid(
      presentation.activityPresentationId,
      "caller activityPresentationId"
    )
  };
}

function normalizeCancellationWidgetProof(
  proof: { instanceDigest: string; cardGeneration: number } | undefined
): { instanceDigest: string; cardGeneration: number } | undefined {
  if (!proof) return undefined;
  if (!Number.isInteger(proof.cardGeneration) || proof.cardGeneration < 1) {
    throw new Error("Cancellation card generation must be a positive integer.");
  }
  return {
    instanceDigest: normalizeDigest(proof.instanceDigest, "widget instance digest"),
    cardGeneration: proof.cardGeneration
  };
}

function normalizeExpectedVersion(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("expectedVersion must be a positive integer.");
  }
  return value;
}

function normalizeReasonCode(value: string): string {
  if (!CANCELLATION_REASON_CODE_PATTERN.test(value)) {
    throw new Error("Cancellation/observation reasonCode must be a bounded stable code.");
  }
  return value;
}

function normalizeDigest(value: string, label: string): string {
  const normalized = normalizeRequiredString(value, label, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function normalizeOptionalDigest(value: string | undefined): string | undefined {
  return value ? normalizeDigest(value, "caller request digest") : undefined;
}

function normalizeEventTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid state-event timestamp.");
  return value;
}

function readSteeringDeliveryRow(row: Record<string, unknown>): SteeringDeliveryRecord {
  const status = row.status as SteeringDeliveryStatus;
  if (!STEERING_DELIVERY_STATUSES.includes(status)) {
    throw new Error(`Invalid persisted steering delivery status: ${String(row.status)}.`);
  }
  return {
    scopeId: String(row.scope_id),
    requestId: String(row.request_id),
    actionHash: String(row.action_hash),
    jobId: String(row.job_id),
    expectedJobVersion: Number(row.expected_job_version),
    promptSha256: String(row.prompt_sha256),
    status,
    bridgeInstanceId: String(row.bridge_instance_id),
    result: row.result
      ? parsePayload({ payload: String(row.result) }, "steering delivery result")
      : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    dispatchedAt: row.dispatched_at === null || row.dispatched_at === undefined
      ? undefined
      : Number(row.dispatched_at),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? undefined
      : Number(row.completed_at)
  };
}

function readCancellationOperationRow(row: Record<string, unknown>): CancellationOperationRecord {
  return {
    scopeId: String(row.scope_id),
    requestId: String(row.request_id),
    rootIntentId: String(row.root_intent_id),
    actionHash: String(row.action_hash),
    source: row.source as CancellationSource,
    toolName: String(row.tool_name),
    actionName: String(row.action_name),
    targetKind: row.target_kind as CancellationOperationRecord["targetKind"],
    targetJobId: row.target_job_id ? String(row.target_job_id) : undefined,
    targetActivityId: String(row.target_activity_id),
    targetAgentId: row.target_agent_id ? String(row.target_agent_id) : undefined,
    targetThreadId: row.target_thread_id ? String(row.target_thread_id) : undefined,
    targetTurnId: row.target_turn_id ? String(row.target_turn_id) : undefined,
    targetPresentationId: row.target_presentation_id
      ? String(row.target_presentation_id)
      : undefined,
    expectedVersion: Number(row.expected_version),
    callerPresentation: readCancellationPresentationRow(row),
    widgetInstancePresent: Number(row.widget_instance_present) === 1,
    widgetInstanceDigest: row.widget_instance_digest
      ? String(row.widget_instance_digest)
      : undefined,
    cardGeneration: row.card_generation === null || row.card_generation === undefined
      ? undefined
      : Number(row.card_generation),
    callerRequestDigest: row.caller_request_digest
      ? String(row.caller_request_digest)
      : undefined,
    bridgeInstanceId: String(row.bridge_instance_id),
    reasonCode: String(row.reason_code),
    status: row.status as CancellationOperationStatus,
    result: row.result
      ? parsePayload({ payload: String(row.result) }, "cancellation operation result")
      : undefined,
    createdAt: Number(row.created_at),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? undefined
      : Number(row.completed_at)
  };
}

function readCancellationIntentRow(row: Record<string, unknown>): CancellationIntentRecord {
  return {
    intentId: String(row.intent_id),
    scopeId: String(row.scope_id),
    requestId: String(row.request_id),
    parentIntentId: row.parent_intent_id ? String(row.parent_intent_id) : undefined,
    cascadeId: String(row.cascade_id),
    source: row.source as CancellationSource,
    toolName: String(row.tool_name),
    actionName: String(row.action_name),
    targetKind: row.target_kind as CancellationIntentRecord["targetKind"],
    targetJobId: row.target_job_id ? String(row.target_job_id) : undefined,
    targetActivityId: String(row.target_activity_id),
    targetAgentId: row.target_agent_id ? String(row.target_agent_id) : undefined,
    targetThreadId: row.target_thread_id ? String(row.target_thread_id) : undefined,
    targetTurnId: row.target_turn_id ? String(row.target_turn_id) : undefined,
    targetPresentationId: row.target_presentation_id
      ? String(row.target_presentation_id)
      : undefined,
    expectedVersion: Number(row.expected_version),
    callerPresentation: readCancellationPresentationRow(row),
    widgetInstancePresent: Number(row.widget_instance_present) === 1,
    widgetInstanceDigest: row.widget_instance_digest
      ? String(row.widget_instance_digest)
      : undefined,
    cardGeneration: row.card_generation === null || row.card_generation === undefined
      ? undefined
      : Number(row.card_generation),
    callerRequestDigest: row.caller_request_digest
      ? String(row.caller_request_digest)
      : undefined,
    bridgeInstanceId: String(row.bridge_instance_id),
    reasonCode: String(row.reason_code),
    status: row.status as CancellationIntentStatus,
    createdAt: Number(row.created_at),
    dispatchedAt: row.dispatched_at === null || row.dispatched_at === undefined
      ? undefined
      : Number(row.dispatched_at),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? undefined
      : Number(row.completed_at)
  };
}

function readCancellationPresentationRow(
  row: Record<string, unknown>
): CancellationPresentation | undefined {
  if (row.caller_presentation_kind === "explicit") return { kind: "explicit" };
  if (row.caller_presentation_kind === "automatic" && row.caller_presentation_id) {
    return {
      kind: "automatic",
      activityPresentationId: String(row.caller_presentation_id)
    };
  }
  return undefined;
}

function readTransportObservationRow(row: Record<string, unknown>): TransportObservationRecord {
  return {
    observationId: Number(row.observation_id),
    kind: row.kind as TransportObservationKind,
    scopeId: row.scope_id ? String(row.scope_id) : undefined,
    jobId: row.job_id ? String(row.job_id) : undefined,
    activityId: row.activity_id ? String(row.activity_id) : undefined,
    toolName: row.tool_name ? String(row.tool_name) : undefined,
    callerRequestDigest: row.caller_request_digest
      ? String(row.caller_request_digest)
      : undefined,
    bridgeInstanceId: String(row.bridge_instance_id),
    reasonCode: String(row.reason_code),
    createdAt: Number(row.created_at)
  };
}

function readProjectStorageRow(row: ProjectStorageRow): ProjectTarget {
  const id = normalizeProjectId(row.project_id);
  const projectRef = normalizeProjectRef(row.project_ref);
  if (!Number.isInteger(row.project_revision) || row.project_revision < 1) {
    throw new Error(`${PROJECT_REGISTRY_CHANGED}: Stored project revision is invalid.`);
  }
  const name = normalizeProjectName(row.name);
  const nameKey = projectNameKey(name);
  if (row.name_key !== nameKey) {
    throw new Error(`${PROJECT_NAME_CONFLICT}: Stored project name key is not canonical.`);
  }
  return {
    id,
    projectRef,
    projectRevision: row.project_revision,
    name,
    label: name,
    nameKey,
    cwd: row.cwd,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at })
  };
}

function hydrateJobPayload(row: JobStorageRow): unknown {
  const payload = parsePayload(row, "job");
  if (!isRecord(payload)) throw new Error("Invalid job payload in the bridge state database: expected an object.");
  return {
    ...payload,
    activityId: row.activity_id,
    threadId: row.thread_id || undefined,
    executionMode: normalizeActivityExecutionMode(row.execution_mode),
    backendKind: row.backend_kind,
    projectId: row.project_uuid || undefined,
    projectLabel: row.project_name_snapshot || undefined,
    bridgeInstanceId: row.bridge_instance_id || undefined,
    workerId: row.worker_id || undefined,
    workerGeneration: row.worker_generation ?? undefined,
    upstreamRequestId: row.upstream_request_id || undefined,
    terminalVersion: row.terminal_version ?? undefined,
    agentId: row.agent_id || undefined,
    contextMode: isAgentContextMode(row.context_mode) ? row.context_mode : undefined
  };
}

function normalizeActivityExecutionMode(value: unknown): ActivityExecutionMode {
  if (value === "auto") return "background";
  if (valueIsOneOf(ACTIVITY_EXECUTION_MODES, value)) return value;
  throw new Error(`Invalid Activity execution mode: ${String(value)}.`);
}

function readActivityRow(row: ActivityStorageRow): BridgeActivity {
  if (
    !valueIsOneOf(ACTIVITY_KINDS, row.kind) ||
    !valueIsOneOf(ACTIVITY_HANDOFF_POLICIES, row.handoff_policy) ||
    !valueIsOneOf(ACTIVITY_COMPLETION_TRIGGERS, row.completion_trigger) ||
    !valueIsOneOf(ACTIVITY_LIFECYCLES, row.lifecycle) ||
    !valueIsOneOf(ACTIVITY_WAITING_ON, row.waiting_on) ||
    !valueIsOneOf(ACTIVITY_VERIFICATION_STATES, row.verification)
  ) {
    throw new Error(`Invalid Activity row in the bridge state database: ${row.activity_id}.`);
  }
  return {
    activityId: row.activity_id,
    scopeId: row.scope_id,
    projectId: row.project_uuid || undefined,
    projectLabel: row.project_name_snapshot || undefined,
    continuationOfActivityId: row.continuation_of_activity_id || undefined,
    cardGeneration: row.card_generation,
    title: row.title,
    kind: row.kind,
    executionMode: normalizeActivityExecutionMode(row.execution_mode),
    handoffPolicy: row.handoff_policy,
    completionTrigger: row.completion_trigger,
    lifecycle: row.lifecycle,
    waitingOn: row.waiting_on,
    verification: row.verification as ActivityVerificationState,
    version: row.version,
    completionVersion: row.completion_version,
    legacy: row.legacy === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sealedAt: row.sealed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    counts: {
      total: row.total_jobs,
      running: row.running_jobs,
      completed: row.completed_jobs,
      failed: row.failed_jobs,
      interrupted: row.interrupted_jobs,
      cancelled: row.cancelled_jobs,
      terminal: row.terminal_jobs
    }
  };
}

function readAgentRow(row: AgentStorageRow): BridgeAgent {
  if (!isAgentLifecycle(row.lifecycle)) {
    throw new Error(`Invalid Agent lifecycle in bridge state: ${row.agent_id}.`);
  }
  return {
    agentId: row.agent_id,
    scopeId: row.scope_id,
    agentName: row.agent_name,
    normalizedName: row.normalized_name,
    lifecycle: row.lifecycle,
    currentThreadId: row.current_thread_id || undefined,
    currentJobId: row.current_job_id || undefined,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
    orphanedReason: row.orphaned_reason || undefined
  };
}

function readAgentThreadRow(row: AgentThreadStorageRow): BridgeAgentThread {
  if (!isAgentContextMode(row.context_mode)) {
    throw new Error(`Invalid Agent thread context mode: ${row.thread_id}.`);
  }
  return {
    threadId: row.thread_id,
    sessionId: row.session_id || undefined,
    agentId: row.agent_id,
    scopeId: row.scope_id,
    projectId: row.project_uuid || undefined,
    projectLabel: row.project_name_snapshot || undefined,
    backendKind: row.backend_kind,
    cwd: row.project_cwd_snapshot || row.cwd,
    sandbox: row.sandbox,
    contextMode: row.context_mode,
    isCurrent: row.is_current === 1,
    linkedAt: row.linked_at,
    replacedAt: row.replaced_at ?? undefined,
    forkedFromThreadId: row.forked_from_thread_id || undefined
  };
}

function readActivityProjectAdmission(
  row: Pick<
    ActivityStorageRow,
    "activity_id" | "project_uuid" | "project_name_snapshot" | "project_cwd_snapshot"
  >
): ActivityProjectAdmission | undefined {
  const values = [row.project_uuid, row.project_name_snapshot, row.project_cwd_snapshot];
  if (values.every((value) => value === null)) return undefined;
  if (values.some((value) => value === null)) {
    throw new Error(`Incomplete Activity project admission metadata: ${row.activity_id}.`);
  }
  return normalizeActivityProjectAdmission(
    row.project_uuid as string,
    row.project_name_snapshot as string,
    row.project_cwd_snapshot as string
  );
}

function readThreadProjectIdentity(
  row: Pick<
    AgentThreadStorageRow,
    "thread_id" | "project_uuid" | "project_name_snapshot"
  >
): { projectId: string; projectLabel: string } | undefined {
  try {
    return normalizeProjectIdentity(
      row.project_uuid || undefined,
      row.project_name_snapshot || undefined
    );
  } catch (error) {
    throw new Error(
      `Invalid Agent thread project metadata: ${row.thread_id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function readActivityAgentRow(row: ActivityAgentStorageRow): ActivityAgentAssignment {
  if (!isAgentContextMode(row.context_mode)) {
    throw new Error(`Invalid Activity Agent context mode: ${row.assignment_id}.`);
  }
  return {
    assignmentId: row.assignment_id,
    activityId: row.activity_id,
    agentId: row.agent_id,
    role: row.role,
    contextMode: row.context_mode,
    assignedAt: row.assigned_at,
    releasedAt: row.released_at ?? undefined
  };
}

function assertActivityPolicy(
  kind: unknown,
  executionMode: unknown,
  handoffPolicy: unknown,
  completionTrigger: unknown
): void {
  if (!valueIsOneOf(ACTIVITY_KINDS, kind)) throw new Error("Invalid Activity kind.");
  if (!valueIsOneOf(ACTIVITY_EXECUTION_MODES, executionMode)) {
    throw new Error("Invalid Activity execution mode.");
  }
  if (!valueIsOneOf(ACTIVITY_HANDOFF_POLICIES, handoffPolicy)) {
    throw new Error("Invalid Activity handoff policy.");
  }
  if (!valueIsOneOf(ACTIVITY_COMPLETION_TRIGGERS, completionTrigger)) {
    throw new Error("Invalid Activity completion trigger.");
  }
}

function normalizeUuid(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error(`${label} must be a UUID.`);
  return normalized;
}

export function normalizeActivityTitle(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Activity title cannot be empty.");
  return normalized.slice(0, 120);
}

function normalizeVerificationEvidence(
  evidence: ActivityVerificationEvidence
): ActivityVerificationEvidence {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("Verification evidence is required.");
  }
  const summary = normalizeRequiredBoundedText(evidence.summary, "Verification evidence summary", 1_000);
  return {
    summary,
    ...normalizeEvidenceList("jobIds", evidence.jobIds, 30, 200),
    ...normalizeEvidenceList("tests", evidence.tests, 20, 300),
    ...normalizeEvidenceList("artifacts", evidence.artifacts, 20, 500),
    ...normalizeEvidenceList("references", evidence.references, 20, 500)
  };
}

function normalizeEvidenceList<K extends keyof ActivityVerificationEvidence>(
  key: K,
  values: string[] | undefined,
  maxItems: number,
  maxLength: number
): Pick<ActivityVerificationEvidence, K> | Record<string, never> {
  if (values === undefined) return {};
  if (!Array.isArray(values) || values.length > maxItems) {
    throw new Error(`Verification evidence ${key} must contain at most ${maxItems} items.`);
  }
  const normalized = values.map((value) =>
    normalizeRequiredBoundedText(value, `Verification evidence ${key} item`, maxLength)
  );
  return { [key]: normalized } as Pick<ActivityVerificationEvidence, K>;
}

function normalizeRequiredBoundedText(value: string, label: string, maxLength: number): string {
  const normalized = normalizeOptionalBoundedText(value, maxLength);
  if (!normalized) throw new Error(`${label} cannot be empty.`);
  return normalized;
}

function normalizeOptionalBoundedText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) throw new Error(`Text cannot exceed ${maxLength} characters.`);
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeRequiredString(value: unknown, label: string, maximum: number): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized.length > maximum || /[\r\n]/.test(normalized)) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function normalizeProjectIdentity(
  projectId: string | undefined,
  projectLabel: string | undefined
): { projectId: string; projectLabel: string } | undefined {
  if (projectId === undefined && projectLabel === undefined) return undefined;
  if (projectId === undefined || projectLabel === undefined) {
    throw new Error("Project admission metadata requires both projectId and projectLabel.");
  }
  return {
    projectId: normalizeProjectId(projectId),
    projectLabel: normalizeProjectLabel(projectLabel)
  };
}

function normalizeActivityProjectAdmission(
  projectId: string | undefined,
  projectLabel: string | undefined,
  projectCwd: string | undefined
): ActivityProjectAdmission | undefined {
  const identity = normalizeProjectIdentity(projectId, projectLabel);
  if (!identity && projectCwd === undefined) return undefined;
  if (!identity || projectCwd === undefined) {
    throw new Error(
      "Activity project admission metadata requires projectId, projectLabel, and projectCwd."
    );
  }
  if (
    !path.isAbsolute(projectCwd) ||
    projectCwd.length > 4_000 ||
    /[\r\n\0]/u.test(projectCwd)
  ) {
    throw new Error("Invalid Activity project working directory.");
  }
  return { ...identity, projectCwd: path.normalize(projectCwd) };
}

function stableUuid(namespace: string, ...parts: string[]): string {
  const hex = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function normalizeEventType(value: string): string {
  const normalized = value.trim().slice(0, 120);
  if (!normalized || !/^[a-z0-9][a-z0-9._:-]*$/i.test(normalized)) {
    throw new Error("Invalid job telemetry event type.");
  }
  return normalized;
}

function readCompletionOutboxRow(row: Record<string, unknown>): CompletionOutboxRecord {
  return {
    outboxId: Number(row.outbox_id),
    activityId: String(row.activity_id),
    scopeId: String(row.scope_id),
    completionVersion: Number(row.completion_version),
    channel: row.channel as "notify" | "verify",
    payload: parsePayload({ payload: String(row.payload) }, "completion outbox"),
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: optionalNumber(row.next_attempt_at),
    leaseOwner: optionalString(row.lease_owner),
    leaseExpiresAt: optionalNumber(row.lease_expires_at),
    deliveredAt: optionalNumber(row.delivered_at),
    acknowledgedAt: optionalNumber(row.acknowledged_at),
    createdAt: Number(row.created_at)
  };
}

export function legacyActivityIdForJob(jobId: string): string {
  const digest = createHash("sha256").update(`legacy-activity\0${jobId}`).digest("hex").split("");
  digest[12] = "8";
  digest[16] = "8";
  const value = digest.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function countsForSingleStatus(status: string | undefined): ActivityJobCounts {
  return {
    total: status ? 1 : 0,
    running: status && isActiveActivityJobStatus(status) ? 1 : 0,
    completed: status === "completed" ? 1 : 0,
    failed: status === "failed" ? 1 : 0,
    interrupted: status === "interrupted" ? 1 : 0,
    cancelled: status === "cancelled" ? 1 : 0,
    terminal: status && isTerminalActivityJobStatus(status) ? 1 : 0
  };
}

function readNestedThreadId(payload: Record<string, unknown>): string | undefined {
  const direct = normalizeOptionalString(payload.threadId);
  if (direct) return direct;
  const decision = payload.sessionDecision;
  return isRecord(decision) ? normalizeOptionalString(decision.threadId) : undefined;
}

function readDashboardRetainedExecution(
  payload: Record<string, unknown>
): DashboardRetainedJobSummary["execution"] | undefined {
  const retainedExecution = isRecord(payload.execution) ? payload.execution : undefined;
  const decision = isRecord(payload.executionDecision) ? payload.executionDecision : undefined;
  const selection = decision && isRecord(decision.effectiveSelection)
    ? decision.effectiveSelection
    : retainedExecution;
  const model = selection && normalizeOptionalString(selection.model);
  const reasoningEffort = selection && normalizeOptionalString(selection.reasoningEffort);
  if (!model || !reasoningEffort) return undefined;

  let reroutedModel = retainedExecution && normalizeOptionalString(retainedExecution.reroutedModel);
  if (!reroutedModel && Array.isArray(payload.publicEvents)) {
    for (let index = payload.publicEvents.length - 1; index >= 0; index -= 1) {
      const event = payload.publicEvents[index];
      if (!isRecord(event) || event.type !== "model" || !isRecord(event.details)) continue;
      if (event.details.kind !== "rerouted") continue;
      reroutedModel = normalizeOptionalString(event.details.toModel);
      if (reroutedModel) break;
    }
  }
  if (reroutedModel === model) reroutedModel = undefined;
  return {
    model,
    reasoningEffort,
    ...(reroutedModel ? { reroutedModel } : {})
  };
}

function retainedDashboardJobFields(
  payload: Record<string, unknown>
): Pick<DashboardRetainedJobSummary, "createdAt" | "execution"> | Record<string, never> {
  const createdAt = finiteNumber(payload.createdAt);
  const execution = readDashboardRetainedExecution(payload);
  return {
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(execution ? { execution } : {})
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function parsePayload(row: JsonRow, label: string): unknown {
  try {
    return JSON.parse(row.payload);
  } catch (error) {
    throw new Error(
      `Invalid ${label} payload in the bridge state database: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
