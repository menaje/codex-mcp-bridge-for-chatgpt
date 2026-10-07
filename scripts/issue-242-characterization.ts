/** Run: npx tsx scripts/issue-242-characterization.ts [100|1200|6000]. Output is aggregate JSON. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { ChildProcessStateReadService, type StateReadObservation } from "../src/stateReadProcess.js";
import { issue242Fixture, fixtureScope, summary } from "./issue-242-fixture.js";

const size = Number(process.argv[2] ?? 1_200);
const f = await issue242Fixture(size);
const observations: StateReadObservation[] = [];
const service = await ChildProcessStateReadService.start(f.file, f.environment, {
  onMeasurement: value => { if (observations.length < 128) observations.push(value); }
});
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const aggregates = (rows: StateReadObservation[]) => Object.fromEntries([
  "endToEndMs", "queueMs", "configMs", "databaseOpenMs", "sessionsMs", "jobsMs", "settingsMs",
  "facadeMs", "projectionMs", "cleanupMs", "jsonPreflightMs", "responseBytes", "sqlStatements", "selectStatements"
].map(key => [key, summary(rows.map(row => row[key as keyof StateReadObservation] as number))]));
try {
  assert.equal(f.jobs.size, size, "All fixture Jobs must hydrate in the current registry.");
  const before = f.database.prepare("SELECT count(*) AS n FROM bridge_instances").get() as { n: number };
  const groups: Record<string, unknown> = {};
  let rowKey: string | undefined;
  for (const includeHistory of [false, true]) {
    let offset = observations.length;
    const first = await service.dashboardSnapshot({ limit: 12, inspectRuntime: false, includeHistory });
    assert.equal(first.counts.retainedJobs, size);
    rowKey = first.terminalRows[0]?.rowKey ?? first.idleRows[0]?.rowKey;
    groups[`list-history-${includeHistory}-first`] = aggregates(observations.slice(offset));
    offset = observations.length;
    for (let i = 0; i < 10; i++) {
      const view = await service.dashboardSnapshot({ limit: 12, inspectRuntime: false, includeHistory });
      assert.deepEqual(view.counts, first.counts);
      assert.deepEqual(view.terminalRows.map(row => row.rowKey), first.terminalRows.map(row => row.rowKey));
    }
    groups[`list-history-${includeHistory}-warm`] = aggregates(observations.slice(offset));
  }
  if (rowKey) {
    const offset = observations.length;
    for (let i = 0; i < 10; i++) await service.dashboardHistoryDetail({ rowKey });
    groups.detailWarm = aggregates(observations.slice(offset));
  }
  let offset = observations.length;
  await Promise.all(Array.from({ length: 8 }, () => service.dashboardSnapshot({ limit: 12, includeHistory: false })));
  groups.burst8 = aggregates(observations.slice(offset));
  offset = observations.length;
  await service.settingsSnapshot();
  groups.settingsFirst = aggregates(observations.slice(offset));
  await service.close();
  const unmeasured = await ChildProcessStateReadService.start(f.file, f.environment);
  const control: Record<string, unknown> = {};
  try {
    for (const includeHistory of [false, true]) {
      await unmeasured.dashboardSnapshot({ limit: 12, includeHistory });
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const at = performance.now();
        await unmeasured.dashboardSnapshot({ limit: 12, includeHistory });
        times.push(performance.now() - at);
      }
      control[`list-history-${includeHistory}-warm`] = summary(times);
    }
  } finally { await unmeasured.close(); }
  const empty = await f.measure(() => Array.from({ length: 20 }, () => f.jobs.claimNativeCompletionNotifications(10, "fixture-consumer")));
  assert.ok(empty.result.every(rows => rows.length === 0));
  assert.equal(empty.changedRows, 0);
  const activityId = randomUUID();
  f.store.createActivity({ activityId, scopeId: fixtureScope, handoffPolicy: "notify", completionTrigger: "sealed-jobs-terminal" });
  const jobId = randomUUID();
  f.store.upsertJob({ jobId, activityId, scopeId: fixtureScope, requestId: "notify-fixture", status: "running", updatedAt: Date.now() });
  f.store.sealActivity(activityId);
  f.store.upsertJob({ jobId, activityId, scopeId: fixtureScope, requestId: "notify-fixture", status: "completed", updatedAt: Date.now() });
  const candidates = f.store.listPendingNotifyCompletionOutbox(10);
  assert.equal(candidates.length, 1);
  const claimed = await f.measure(() => f.jobs.claimNativeCompletionNotifications(10, "fixture-consumer"));
  const id = claimed.result[0]!.outboxId;
  const immediateRetry = await f.measure(() => {
    for (let i = 0; i < 10; i++) {
      f.jobs.releaseNativeCompletionNotifications([id], "fixture-consumer");
      assert.equal(f.jobs.claimNativeCompletionNotifications(10, "fixture-consumer").length, 1);
    }
  });
  const after = f.database.prepare("SELECT count(*) AS n FROM bridge_instances").get() as { n: number };
  assert.equal(after.n, before.n, "Read projections must not register a writer.");
  console.log(JSON.stringify({
    schema: 1, sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDiffSha256: (await import("node:crypto")).createHash("sha256").update(execFileSync("git", ["diff", "--", "src/stateReadProcess.ts", "src/runtimeProcess.ts"])).digest("hex"),
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      sqlite: (f.database.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v },
    fixture: { retainedJobs: size, agents: Math.ceil(size / 10), sessions: Math.ceil(size / 10),
      jobsPerAgent: 10, failedFraction: .2, resultBytesPerJob: 9, pageSize: 12,
      firstRead: "new child; OS filesystem cache uncontrolled", warm: "same child; registries rebuilt each request" },
    groups, uninstrumentedControl: control,
    overNative3sBudgetFraction: observations.filter(row => row.method === "dashboardSnapshot" && row.endToEndMs > 3_000).length /
      observations.filter(row => row.method === "dashboardSnapshot").length,
    actualReadDeadlineTimeoutFraction: observations.filter(row => row.callerAbandoned).length / observations.length,
    actualReadCapacityAfter: service.health().inFlight,
    completion: { empty20: { ...empty, result: undefined }, claimOne: { ...claimed, result: undefined },
      releaseReclaim10: { ...immediateRetry, result: undefined } },
    parentEventLoopDelayMs: { p50: lag.percentile(50) / 1e6, p95: lag.percentile(95) / 1e6, max: lag.max / 1e6 },
    limits: ["SQL counts include connection PRAGMAs; no per-statement duration or lock-wait measurement.",
      "projectionMs includes SQL and model/presentation work. jsonPreflightMs excludes IPC's second encoding.",
      "endToEndMs includes parent send/child queue/encoding/receive; transport-only time is not isolated.",
      "WAL file length delta is not WAL frame writes, fsync or physical I/O.",
      "Over-native-budget fraction is an IPC latency comparison, not measured Swift socket timeouts.",
      "Uninstrumented control uses a second child on the same unchanged fixture; OS cache and load are uncontrolled.",
      "No native event/timer rate or installed app/tunnel evidence is inferred from this synthetic workload."]
  }, null, 2));
} finally { lag.disable(); await service.close(); await f.close(); }
