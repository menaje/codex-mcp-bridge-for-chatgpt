/** W3 counts on synthetic, temporary state only. Run with tsx; never accepts a user DB path. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { fixtureScope, issue242Fixture } from "./issue-242-fixture.js";
import { createModelCatalog } from "../src/server.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { registerBridgeTools } from "../src/tools.js";
import type { CodexProgress, CodexUpstream } from "../src/upstream.js";

const f = await issue242Fixture(40);
const upstream: CodexUpstream = { async listTools() { return { tools: [] }; },
  async callTool() { throw new Error("W3 count fixture cannot execute Jobs"); }, async close() {} };
const mcp = new McpServer({ name: "W3-counts", version: "1" });
const registration = registerBridgeTools(mcp, f.config, upstream, f.sessions, f.jobs,
  createModelCatalog(f.config, upstream), f.settings, new ScopeResolver({ stateStore: f.store }));
const topics: Record<string, number> = {};
const off = registration.applicationService.subscribeChanges!(topic => { topics[topic] = (topics[topic] ?? 0) + 1; });
const counts = <T>(measurement: Awaited<ReturnType<typeof f.measure<T>>>) => ({ ...measurement, result: undefined });
function complete() {
  const activityId = randomUUID(), jobId = randomUUID();
  f.store.createActivity({ activityId, scopeId: fixtureScope, handoffPolicy: "notify", completionTrigger: "sealed-jobs-terminal" });
  f.store.upsertJob({ jobId, activityId, scopeId: fixtureScope, requestId: jobId, status: "running", updatedAt: Date.now() });
  f.store.sealActivity(activityId);
  f.store.upsertJob({ jobId, activityId, scopeId: fixtureScope, requestId: jobId, status: "completed", updatedAt: Date.now() });
}
try {
  const sampleJobs = f.jobs.list(40, 0).slice(0, 4);
  sampleJobs.forEach(job => { job.status = "running"; });
  const progress = f.jobs as unknown as { recordProgress(job: unknown, progress: CodexProgress): void };
  const progress400 = await f.measure(() => {
    for (let i = 0; i < 400; i++) progress.recordProgress(sampleJobs[i % 4], { progress: i });
  });
  const progressTopics = { ...topics };
  assert.equal(progressTopics["completion-outbox-ready"] ?? 0, 0);
  assert.equal(progress400.changedRows, 0);
  const empty20 = await f.measure(() => Array.from({ length: 20 }, () => f.jobs.claimNativeCompletionNotifications(10, "consumer")));
  assert.ok(empty20.result.every(batch => batch.length === 0));
  const availability20 = await f.measure(() => Array.from({ length: 20 }, () => f.jobs.nativeCompletionAvailability()));
  const enqueue25 = await f.measure(() => { for (let i = 0; i < 25; i++) complete(); });
  const batches: number[] = [];
  const drainMethods = { claim: 0, delivered: 0 };
  const drain25 = await f.measure(() => {
    for (;;) {
      drainMethods.claim++;
      const batch = f.jobs.claimNativeCompletionNotifications(10, "consumer");
      if (!batch.length) break;
      batches.push(batch.length);
      drainMethods.delivered++;
      f.jobs.markNativeCompletionNotificationsDelivered(batch.map(row => row.outboxId), "consumer");
    }
  });
  assert.deepEqual(batches, [10, 10, 5]);
  complete();
  let pending = f.jobs.claimNativeCompletionNotifications(10, "consumer");
  const outboxId = pending[0]!.outboxId;
  const retryMethods = { claim: 0, release: 0 };
  const releaseReclaim10 = await f.measure(() => {
    for (let i = 0; i < 10; i++) {
      if (pending.length) {
        retryMethods.release++;
        f.jobs.releaseNativeCompletionNotifications(pending.map(row => row.outboxId), "consumer");
      }
      retryMethods.claim++;
      pending = f.jobs.claimNativeCompletionNotifications(10, "consumer");
    }
  });
  assert.equal(retryMethods.release, 1);
  assert.equal(releaseReclaim10.changedRows, 1);
  const afterRetry = f.store.getCompletionOutbox(outboxId)!;
  const originalNow = Date.now;
  let dueRetry;
  try {
    Date.now = () => afterRetry.nextAttemptAt!;
    dueRetry = await f.measure(() => f.jobs.claimNativeCompletionNotifications(10, "consumer"));
    assert.equal(dueRetry.result.length, 1);
  } finally { Date.now = originalNow; }
  console.log(JSON.stringify({
    schema: 1, sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "--", "src", "macos/Sources", "scripts/issue-242-completion.ts"])).digest("hex"),
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      sqlite: (f.database.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v },
    fixture: { retainedJobs: 40, progressJobs: 4, progressEvents: 400, backlog: 25 },
    progress400: { ...counts(progress400), topics: progressTopics, nativeClaimsTriggered: 0 },
    empty20: { ...counts(empty20), methods: { claim: 20 } },
    availability20: { ...counts(availability20), methods: { availability: 20 } },
    enqueue25: { ...counts(enqueue25), readinessNotices: 25 },
    drain25: { ...counts(drain25), batches, methods: drainMethods },
    releaseReclaim10: { ...counts(releaseReclaim10), methods: retryMethods, attemptCount: afterRetry.attemptCount },
    dueRetry: counts(dueRetry), claimDiagnostics: f.jobs.nativeCompletionClaimDiagnostics(),
    limits: ["Counts are direct application/store calls on temporary SQLite, not installed-app rates.",
      "Native real-socket method counts and event scheduling are verified separately by Swift tests.",
      "WAL file byte delta is not frame writes, fsync, disk IO or lock wait.",
      "Wall time is descriptive only; concurrent development/builds and filesystem cache were uncontrolled.",
      "Fixture progress is in-memory under the existing immediate persistence budget; no required durable progress/terminal record is removed."]
  }, null, 2));
} finally { off(); registration.dispose(); await mcp.close(); await f.close(); }
