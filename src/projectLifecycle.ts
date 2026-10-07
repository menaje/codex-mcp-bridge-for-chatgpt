import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { BridgeStateStore } from "./stateStore.js";
import type { CodexUpstream } from "./upstream.js";
import type { CodexJobRegistry } from "./tools.js";

export type ProjectArchiveState =
  | "active"
  | "processing"
  | "unresolved"
  | "complete";
export type RetiredRequest = {
  namespace: string;
  scope_id: string;
  request_id: string;
  subject_id: string | null;
  request_hash: string | null;
  hash_version: number | null;
  outcome: string;
  retired_at: number;
};

/** All methods are synchronous. The caller owns the StateStore transaction. */
export class ProjectLifecycleStore {
  constructor(private readonly db: Database.Database) {}

  active(projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM projects WHERE project_id=? AND archive_state='active' AND deleted_at IS NULL",
        )
        .get(projectId),
    );
  }
  exists(projectId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM projects WHERE project_id=?")
        .get(projectId),
    );
  }
  assertActive(projectId?: string): void {
    if (projectId && !this.active(projectId))
      throw new Error(
        "PROJECT_ARCHIVED: Project use has ended or archive cleanup is pending.",
      );
  }
  retiredThread(threadId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM retired_threads WHERE thread_id=?")
        .get(threadId),
    );
  }
  receipt(
    namespace: string,
    scopeId: string,
    requestId: string,
  ): RetiredRequest | undefined {
    return this.db
      .prepare(
        "SELECT * FROM retired_requests WHERE namespace=? AND scope_id=? AND request_id=?",
      )
      .get(namespace, scopeId, requestId) as RetiredRequest | undefined;
  }
  jobReceipt(jobId: string, scopeId?: string): RetiredRequest | undefined {
    return this.db
      .prepare(
        "SELECT * FROM retired_requests WHERE namespace='task' AND subject_id=? AND (? IS NULL OR scope_id=?)",
      )
      .get(jobId, scopeId || null, scopeId || null) as
      | RetiredRequest
      | undefined;
  }
  containsRetiredReference(value: unknown): boolean {
    if (typeof value === "string")
      return Boolean(this.jobReceipt(value)) || this.retiredThread(value);
    if (Array.isArray(value))
      return value.some((item) => this.containsRetiredReference(item));
    if (value && typeof value === "object")
      return Object.entries(value).some(([key, item]) => {
        if (
          typeof item === "string" &&
          ["projectId", "project_id"].includes(key)
        )
          return !this.exists(item);
        if (
          typeof item === "string" &&
          ["activityId", "activity_id"].includes(key)
        )
          return !this.db
            .prepare("SELECT 1 FROM activities WHERE activity_id=?")
            .get(item);
        return this.containsRetiredReference(item);
      });
    return false;
  }
  assertRequest(
    namespace: string,
    scopeId: string,
    requestId: string,
    hash?: string,
  ): void {
    const receipt = this.receipt(namespace, scopeId, requestId);
    if (!receipt) return;
    if (hash && receipt.request_hash && hash !== receipt.request_hash)
      throw new Error(
        "REQUEST_ID_CONFLICT: This requestId was accepted with different content.",
      );
    throw new Error(
      receipt.request_hash
        ? "PROJECT_MANAGEMENT_ENDED: This request was already accepted. Its project and result management have ended; it cannot execute again."
        : "PROJECT_MANAGEMENT_ENDED: Acceptance is retained, but original content cannot be compared. This requestId cannot execute again.",
    );
  }
  legacyDeleted(projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM projects WHERE project_id=? AND deleted_at IS NOT NULL",
        )
        .get(projectId),
    );
  }
  pending(): Array<{ projectId: string; revision: number }> {
    return this.db
      .prepare(
        "SELECT project_id AS projectId,archive_revision AS revision FROM projects WHERE archive_state IN ('processing','unresolved') ORDER BY updated_at,project_id",
      )
      .all() as Array<{ projectId: string; revision: number }>;
  }
  jobIds(projectId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT j.job_id FROM jobs j JOIN activities a ON a.activity_id=j.activity_id WHERE a.project_id=?",
        )
        .all(projectId) as Array<{ job_id: string }>
    ).map((row) => row.job_id);
  }
  threadIds(projectId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT thread_id FROM sessions WHERE project_id=?
      UNION SELECT j.thread_id FROM jobs j JOIN activities a ON a.activity_id=j.activity_id
        LEFT JOIN sessions s ON s.thread_id=j.thread_id
        WHERE a.project_id=? AND j.thread_id IS NOT NULL AND (s.project_id IS NULL OR s.project_id=?)
      UNION SELECT c.thread_id FROM thread_connections c JOIN jobs j ON j.job_id=c.last_job_id
        JOIN activities a ON a.activity_id=j.activity_id LEFT JOIN sessions s ON s.thread_id=c.thread_id
        WHERE a.project_id=? AND (s.project_id IS NULL OR s.project_id=?)`,
        )
        .all(projectId, projectId, projectId, projectId, projectId) as Array<{
        thread_id: string;
      }>
    ).map((row) => row.thread_id);
  }
  threadProtected(threadId: string, projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM jobs j JOIN activities a ON a.activity_id=j.activity_id
      WHERE (j.thread_id=? OR j.source_thread_id=?) AND a.project_id IS NOT ?
      AND j.status IN ('running','terminating','termination-failed') LIMIT 1`,
        )
        .get(threadId, threadId, projectId),
    );
  }
  unfinished(projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM jobs j JOIN activities a ON a.activity_id=j.activity_id
      WHERE a.project_id=? AND j.status IN ('running','terminating','termination-failed') LIMIT 1`,
        )
        .get(projectId),
    );
  }
  unresolved(
    projectId: string,
    revision: number,
    reasons: string[],
    now = Date.now(),
  ): void {
    const changed = this.db
      .prepare(
        `UPDATE projects SET archive_state='unresolved',archive_reasons=?,updated_at=?
      WHERE project_id=? AND archive_revision=? AND archive_state IN ('processing','unresolved') AND archive_reasons!=?`,
      )
      .run(
        JSON.stringify(reasons),
        now,
        projectId,
        revision,
        JSON.stringify(reasons),
      ).changes;
    if (changed) this.bump(now);
  }
  complete(
    projectId: string,
    revision: number,
    now = Date.now(),
    confirmedThreads: readonly string[] = [],
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT archive_state,archive_revision FROM projects WHERE project_id=?",
      )
      .get(projectId) as
      | { archive_state: string; archive_revision: number }
      | undefined;
    if (
      !row ||
      row.archive_revision !== revision ||
      !["processing", "unresolved"].includes(row.archive_state) ||
      this.unfinished(projectId)
    )
      return false;
    const threads = this.threadIds(projectId);
    for (const threadId of threads) {
      if (this.threadProtected(threadId, projectId)) return false;
      const connection = this.db
        .prepare(
          "SELECT phase,evidence FROM thread_connections WHERE thread_id=?",
        )
        .get(threadId) as
        | { phase: string; evidence: string | null }
        | undefined;
      if (
        connection &&
        (connection.phase !== "released" || !connection.evidence) &&
        !confirmedThreads.includes(threadId)
      )
        return false;
      if (!connection && !confirmedThreads.includes(threadId)) return false;
    }
    this.db
      .prepare(
        `UPDATE scopes SET version=version+1,updated_at=? WHERE scope_id IN
      (SELECT scope_id FROM activities WHERE project_id=? UNION SELECT scope_id FROM sessions WHERE project_id=?)`,
      )
      .run(now, projectId, projectId);
    for (const threadId of threads) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO retired_threads(thread_id,retired_at) VALUES (?,?)",
        )
        .run(threadId, now);
      // Never clear another project's current thread or unrelated active Job.
      this.db
        .prepare(
          `UPDATE agents SET current_thread_id=NULL,
        current_job_id=CASE WHEN current_job_id IN (SELECT j.job_id FROM jobs j JOIN activities a ON a.activity_id=j.activity_id WHERE a.project_id=?) THEN NULL ELSE current_job_id END,
        lifecycle=CASE WHEN current_job_id IS NULL OR current_job_id IN (SELECT j.job_id FROM jobs j JOIN activities a ON a.activity_id=j.activity_id WHERE a.project_id=?) THEN 'idle' ELSE lifecycle END,
        version=version+1,updated_at=? WHERE current_thread_id=?`,
        )
        .run(projectId, projectId, now, threadId);
      // A recovery for the current discarded thread must not later target a
      // replacement thread on this shared Agent. Unrelated current threads stay.
      const recoveryKeys = this.db
        .prepare(
          `SELECT recovery_key FROM automatic_recovery WHERE job_id IS NULL AND agent_id IN
        (SELECT agent_id FROM agent_threads WHERE thread_id=? AND is_current=1)`,
        )
        .all(threadId) as Array<{ recovery_key: string }>;
      for (const { recovery_key } of recoveryKeys) {
        this.db
          .prepare(
            "DELETE FROM automatic_recovery_incidents WHERE recovery_key=?",
          )
          .run(recovery_key);
        this.db
          .prepare("DELETE FROM automatic_recovery WHERE recovery_key=?")
          .run(recovery_key);
      }
      this.db
        .prepare("DELETE FROM agent_threads WHERE thread_id=?")
        .run(threadId);
      this.db
        .prepare("DELETE FROM thread_connections WHERE thread_id=?")
        .run(threadId);
      this.db.prepare("DELETE FROM sessions WHERE thread_id=?").run(threadId);
    }
    this.db
      .prepare(
        `UPDATE agents SET current_job_id=NULL,
      lifecycle=CASE WHEN EXISTS (SELECT 1 FROM jobs j JOIN activities a ON a.activity_id=j.activity_id
        WHERE j.agent_id=agents.agent_id AND a.project_id IS NOT ? AND j.status IN ('running','terminating','termination-failed')) THEN lifecycle ELSE 'idle' END,
      version=version+1,updated_at=? WHERE current_job_id IN
        (SELECT j.job_id FROM jobs j JOIN activities a ON a.activity_id=j.activity_id WHERE a.project_id=?)`,
      )
      .run(projectId, now, projectId);
    this.db
      .prepare(
        `UPDATE activity_agents SET released_at=? WHERE released_at IS NULL AND activity_id IN (SELECT activity_id FROM activities WHERE project_id=?)`,
      )
      .run(now, projectId);
    this.db
      .prepare(
        `UPDATE activities SET lifecycle='abandoned',waiting_on='none',version=version+1,updated_at=?
      WHERE project_id=? AND lifecycle IN ('open','sealed','terminating')`,
      )
      .run(now, projectId);
    this.db
      .prepare(
        `DELETE FROM job_interactions WHERE job_id IN (SELECT j.job_id FROM jobs j JOIN activities a ON a.activity_id=j.activity_id WHERE a.project_id=?)`,
      )
      .run(projectId);
    this.db
      .prepare(
        `UPDATE projects SET archive_state='complete',archived_at=?,archive_reasons='[]',updated_at=?,project_revision=project_revision+1
      WHERE project_id=? AND archive_revision=?`,
      )
      .run(now, now, projectId, revision);
    this.bump(now);
    return true;
  }
  private bump(now: number): void {
    this.db
      .prepare(
        "UPDATE project_registry SET registry_revision=registry_revision+1,updated_at=? WHERE singleton=1",
      )
      .run(now);
  }
  private retain(
    namespace: string,
    scopeId: string,
    requestId: string,
    subjectId: string | null,
    hash: string | null,
    version: number | null,
    outcome: string,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO retired_requests(namespace,scope_id,request_id,subject_id,request_hash,hash_version,outcome,retired_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        namespace,
        scopeId,
        requestId,
        subjectId,
        hash,
        version,
        outcome,
        now,
      );
  }
  /** Called only after external cleanup and its CAS completion have committed. */
  delete(projectId: string, now = Date.now()): boolean {
    const project = this.db
      .prepare("SELECT archive_state FROM projects WHERE project_id=?")
      .get(projectId) as { archive_state: string } | undefined;
    if (!project) return false;
    if (project.archive_state !== "complete" || this.unfinished(projectId))
      throw new Error(
        "PROJECT_DELETE_REQUIRES_ARCHIVE: Wait for confirmed archive completion or retry cleanup.",
      );
    const jobs = this.db
      .prepare(
        `SELECT j.* FROM jobs j JOIN activities a ON a.activity_id=j.activity_id WHERE a.project_id=?`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    const ids = new Set(jobs.map((job) => String(job.job_id)));
    const activityIds = new Set(
      (
        this.db
          .prepare("SELECT activity_id FROM activities WHERE project_id=?")
          .all(projectId) as Array<{ activity_id: string }>
      ).map((row) => row.activity_id),
    );
    this.db
      .prepare(
        "UPDATE scopes SET version=version+1,updated_at=? WHERE scope_id IN (SELECT scope_id FROM activities WHERE project_id=?)",
      )
      .run(now, projectId);
    for (const job of jobs) {
      const payload = JSON.parse(String(job.payload)) as Record<
        string,
        unknown
      >;
      this.retain(
        "task",
        String(job.scope_id),
        String(job.request_id),
        String(job.job_id),
        typeof payload.requestHash === "string" ? payload.requestHash : null,
        typeof payload.requestHashVersion === "number"
          ? payload.requestHashVersion
          : null,
        String(job.status),
        now,
      );
    }
    // Hashes and observed outcomes survive; control payloads and relationships do not.
    for (const table of ["cancellation_operations", "steering_deliveries"]) {
      for (const row of this.db
        .prepare(`SELECT * FROM ${table}`)
        .all() as Array<Record<string, unknown>>) {
        if (
          !ids.has(String(row.target_job_id || row.job_id)) &&
          !activityIds.has(String(row.target_activity_id))
        )
          continue;
        this.retain(
          table === "steering_deliveries" ? "steering" : "cancellation",
          String(row.scope_id),
          String(row.request_id),
          null,
          String(row.action_hash),
          null,
          String(row.status),
          now,
        );
      }
    }
    for (const row of this.db
      .prepare("SELECT * FROM agent_mutations")
      .all() as Array<Record<string, unknown>>) {
      if (
        references(
          JSON.parse(String(row.result)),
          ids,
          activityIds,
          projectId,
        ) ||
        this.containsRetiredReference(JSON.parse(String(row.result)))
      ) {
        this.retain(
          "mutation",
          String(row.scope_id),
          String(row.request_id),
          null,
          String(row.action_hash),
          null,
          "management-ended",
          now,
        );
        this.db
          .prepare(
            "DELETE FROM agent_mutations WHERE scope_id=? AND request_id=?",
          )
          .run(row.scope_id, row.request_id);
      }
    }
    const refs = new Set<string>();
    for (const job of jobs) {
      const payload = JSON.parse(String(job.payload)) as {
        pendingInteractions?: Array<Record<string, unknown>>;
      };
      for (const interaction of payload.pendingInteractions || []) {
        // Matches codexInputs.questionReference without retaining the interaction.
        refs.add(requireQuestionHash(job, interaction));
      }
    }
    for (const row of this.db
      .prepare("SELECT * FROM codex_question_deliveries")
      .all() as Array<Record<string, unknown>>) {
      if (!ids.has(String(row.job_id)) && !refs.has(String(row.question_ref)))
        continue;
      this.retain(
        "question",
        String(row.scope_id),
        String(row.request_id),
        null,
        String(row.action_hash),
        null,
        String(row.status),
        now,
      );
      this.db
        .prepare(
          "DELETE FROM codex_question_deliveries WHERE scope_id=? AND request_id=?",
        )
        .run(row.scope_id, row.request_id);
    }
    // Metadata journals include event delegation, encrypted destinations, approved
    // followups and operational-command responses. Match identity fields, never cwd.
    for (const row of this.db
      .prepare("SELECT key,value FROM bridge_meta")
      .all() as Array<{ key: string; value: string }>) {
      let value: unknown;
      try {
        value = JSON.parse(row.value);
      } catch {
        value = row.value;
      }
      if (
        references(value, ids, activityIds, projectId) ||
        this.containsRetiredReference(value) ||
        [...ids, ...activityIds, projectId].some((id) => row.key.includes(id))
      )
        this.db.prepare("DELETE FROM bridge_meta WHERE key=?").run(row.key);
    }
    for (const row of this.db
      .prepare("SELECT command_id,result FROM operational_command_receipts")
      .all() as Array<{ command_id: string; result: string }>) {
      if (
        references(JSON.parse(row.result), ids, activityIds, projectId) ||
        this.containsRetiredReference(JSON.parse(row.result))
      )
        this.db
          .prepare(
            "UPDATE operational_command_receipts SET result=? WHERE command_id=?",
          )
          .run('{"code":"PROJECT_MANAGEMENT_ENDED"}', row.command_id);
    }
    const activityQuery =
      "SELECT activity_id FROM activities WHERE project_id=?";
    const jobQuery = `SELECT job_id FROM jobs WHERE activity_id IN (${activityQuery})`;
    this.db
      .prepare(
        `UPDATE cancellation_intents SET parent_intent_id=NULL WHERE parent_intent_id IN (SELECT intent_id FROM cancellation_intents WHERE target_activity_id IN (${activityQuery}))`,
      )
      .run(projectId);
    this.db
      .prepare(
        `DELETE FROM cancellation_intents WHERE target_activity_id IN (${activityQuery})`,
      )
      .run(projectId);
    this.db
      .prepare(
        `DELETE FROM cancellation_operations WHERE target_activity_id IN (${activityQuery})`,
      )
      .run(projectId);
    this.db
      .prepare(`DELETE FROM steering_deliveries WHERE job_id IN (${jobQuery})`)
      .run(projectId);
    this.db
      .prepare(
        `DELETE FROM automatic_recovery_incidents WHERE recovery_key IN (SELECT recovery_key FROM automatic_recovery WHERE job_id IN (${jobQuery}))`,
      )
      .run(projectId);
    this.db
      .prepare(`DELETE FROM automatic_recovery WHERE job_id IN (${jobQuery})`)
      .run(projectId);
    this.db
      .prepare(
        `DELETE FROM transport_observations WHERE job_id IN (${jobQuery}) OR activity_id IN (${activityQuery})`,
      )
      .run(projectId, projectId);
    this.db
      .prepare(
        `DELETE FROM activity_agents WHERE activity_id IN (${activityQuery})`,
      )
      .run(projectId);
    this.db
      .prepare(
        `UPDATE agents SET current_job_id=NULL,lifecycle='idle',version=version+1,updated_at=? WHERE current_job_id IN (${jobQuery})`,
      )
      .run(now, projectId);
    this.db
      .prepare(
        `UPDATE activities SET continuation_of_activity_id=NULL WHERE continuation_of_activity_id IN (${activityQuery})`,
      )
      .run(projectId);
    this.db
      .prepare(`DELETE FROM jobs WHERE activity_id IN (${activityQuery})`)
      .run(projectId);
    this.db.prepare("DELETE FROM activities WHERE project_id=?").run(projectId);
    this.db.prepare("DELETE FROM projects WHERE project_id=?").run(projectId);
    return true;
  }
}

function requireQuestionHash(
  job: Record<string, unknown>,
  interaction: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        job: job.job_id,
        scope: job.scope_id,
        worker: job.worker_id || undefined,
        generation: job.worker_generation ?? undefined,
        thread: job.thread_id || undefined,
        input: interaction,
      }),
    )
    .digest("hex");
}
function references(
  value: unknown,
  jobs: Set<string>,
  activities: Set<string>,
  projectId: string,
): boolean {
  if (typeof value === "string")
    return jobs.has(value) || activities.has(value) || value === projectId;
  if (Array.isArray(value))
    return value.some((item) => references(item, jobs, activities, projectId));
  if (value && typeof value === "object")
    return Object.values(value).some((item) =>
      references(item, jobs, activities, projectId),
    );
  return false;
}

/** No external await occurs inside a SQLite transaction. Each attempt can be
 * repeated after process loss; a stale attempt cannot complete a newer intent. */
export class ProjectLifecycleController {
  private pending?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(
    private readonly state: BridgeStateStore,
    private readonly jobs: CodexJobRegistry,
    private readonly upstream: CodexUpstream,
    private readonly externalTimeoutMs = 10_000,
  ) {}
  start(): void {
    this.timer = setInterval(() => void this.sweep(), 10_000);
    this.timer.unref();
    void this.sweep();
  }
  sweep(): Promise<void> {
    if (this.state.isClosed) {
      this.closed = true;
      if (this.timer) clearInterval(this.timer);
    }
    if (this.closed) return Promise.resolve();
    return (this.pending ||= this.run().finally(() => {
      this.pending = undefined;
    }));
  }
  private async run(): Promise<void> {
    for (const intent of this.state.projectLifecycle.pending()) {
      if (this.closed) return;
      const reasons: string[] = [];
      const confirmedThreads: string[] = [];
      try {
        for (const jobId of this.state.projectLifecycle.jobIds(
          intent.projectId,
        )) {
          if (this.closed || this.state.isClosed) return;
          try {
            await this.external(this.jobs.stopForProjectArchive(jobId));
          } catch (error) {
            reasons.push(`Job ${jobId}: ${message(error)}`);
          }
        }
        if (this.state.projectLifecycle.unfinished(intent.projectId))
          reasons.push("Execution termination is not confirmed.");
        if (!reasons.length) {
          const threads = this.state.projectLifecycle.threadIds(
            intent.projectId,
          );
          for (const threadId of threads) {
            if (this.closed || this.state.isClosed) return;
            if (
              this.state.projectLifecycle.threadProtected(
                threadId,
                intent.projectId,
              )
            ) {
              reasons.push(
                `Thread ${threadId}: another project has active work.`,
              );
              continue;
            }
            const connection = this.state.threadConnections.get(threadId);
            if (connection?.phase === "released" && connection.evidence)
              continue;
            const session = this.state
              .listSessions()
              .find(
                (value) =>
                  (value as { threadId: string }).threadId === threadId,
              ) as { backendKind: string } | undefined;
            if (session?.backendKind !== "app-server" && session) {
              confirmedThreads.push(threadId);
              this.state.threadConnections.update(threadId, {
                phase: "released",
                evidence: "connection-absent",
              });
              continue;
            }
            // Loaded-only probes never resume an old conversation to inspect it.
            if (this.upstream.listLoadedBackgroundTerminals) {
              const processes = await this.external(
                this.upstream.listLoadedBackgroundTerminals(
                  threadId,
                  "app-server",
                ),
              );
              for (const process of processes || []) {
                if (!this.upstream.terminateBackgroundTerminal)
                  throw new Error("Background termination is unsupported.");
                const stopped = await this.external(
                  this.upstream.terminateBackgroundTerminal(
                    threadId,
                    process.processId,
                  ),
                );
                if (!stopped.terminated)
                  throw new Error(
                    `Background process ${process.processId} did not stop.`,
                  );
              }
              if (
                processes?.length &&
                (
                  await this.external(
                    this.upstream.listLoadedBackgroundTerminals(
                      threadId,
                      "app-server",
                    ),
                  )
                )?.length
              )
                throw new Error("Background processes remain active.");
            }
            const result = await this.external(
              this.upstream.releaseThreadConnection?.(threadId, {
                eligibleThreadIds: threads,
                previousWorkerPid: connection?.workerPid,
                retireContext: true,
                canRelease: (id) =>
                  !this.closed &&
                  threads.includes(id) &&
                  !this.state.projectLifecycle.unfinished(intent.projectId) &&
                  !this.state.projectLifecycle.threadProtected(
                    id,
                    intent.projectId,
                  ),
              }) || Promise.resolve(undefined),
            );
            if (result?.phase !== "released" || !result.evidence)
              reasons.push(
                `Thread ${threadId}: ${result?.reason || "release unconfirmed"}`,
              );
            else {
              confirmedThreads.push(threadId);
              this.state.threadConnections.update(threadId, {
                phase: "released",
                evidence: result.evidence,
              });
            }
          }
        }
        if (this.closed || this.state.isClosed) return;
        this.state.transaction(() => {
          if (reasons.length)
            this.state.projectLifecycle.unresolved(
              intent.projectId,
              intent.revision,
              reasons,
            );
          else if (
            !this.state.projectLifecycle.complete(
              intent.projectId,
              intent.revision,
              Date.now(),
              confirmedThreads,
            )
          )
            this.state.projectLifecycle.unresolved(
              intent.projectId,
              intent.revision,
              ["Cleanup target changed; retrying authoritative state."],
            );
        });
        if (
          this.state.projectLifecycle.legacyDeleted(intent.projectId) &&
          !this.state.projectLifecycle
            .pending()
            .some((row) => row.projectId === intent.projectId)
        ) {
          this.state.transaction(() => {
            this.state.applyProjectOperations(
              [{ kind: "delete", projectId: intent.projectId }],
              this.state.getProjectRegistryRevision(),
              [],
            );
          });
        }
        this.jobs.refreshRetiredProjectState();
      } catch (error) {
        if (this.state.isClosed) return;
        this.state.transaction(() =>
          this.state.projectLifecycle.unresolved(
            intent.projectId,
            intent.revision,
            [...reasons, message(error)],
          ),
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  private async external<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Cleanup confirmation timed out; the original operation may still be pending.",
                ),
              ),
            this.externalTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
