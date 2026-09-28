import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { ChildProcessStateReadService } from "../src/stateReadProcess.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";

type Checkpoint = { busy: number; log: number; checkpointed: number };

function percentile(sorted: number[], proportion: number): number {
  return Number(sorted[Math.ceil(sorted.length * proportion) - 1]!.toFixed(3));
}

function summary(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: sorted.length >= 100 ? percentile(sorted, 0.99) : null,
    maxMs: Number(sorted.at(-1)!.toFixed(3))
  };
}

function fileBytes(file: string): number {
  return existsSync(file) ? statSync(file).size : 0;
}

const root = await mkdtemp(path.join(tmpdir(), "bridge-issue-197-"));
const file = path.join(root, "state.sqlite");
const environment = {
  ...process.env,
  CODEX_MCP_BRIDGE_NO_AUTH: "1",
  CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
  CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
  CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
  CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
};
let store: BridgeStateStore | undefined;
let service: ChildProcessStateReadService | undefined;
let reader: Database.Database | undefined;
let checkpoint: Database.Database | undefined;
let locker: Database.Database | undefined;
let phaseMarks: Map<string, number> | undefined;
try {
  const config = loadConfig(environment);
  store = new BridgeStateStore({
    file,
    onTransactionPhase: phase => {
      if (phaseMarks && !phaseMarks.has(phase)) phaseMarks.set(phase, performance.now());
    }
  });
  const settings = new UserSettingsStore(config, { stateStore: store });
  new ScopeResolver({ stateStore: store });
  service = await ChildProcessStateReadService.start(file, environment);
  reader = new Database(file, { readonly: true, fileMustExist: true });
  checkpoint = new Database(file);
  checkpoint.pragma("busy_timeout = 50");
  const sqliteVersion = (checkpoint.prepare("SELECT sqlite_version() AS version").get() as {
    version: string;
  }).version;
  const pragmas = {
    journalMode: checkpoint.pragma("journal_mode", { simple: true }),
    pageSize: checkpoint.pragma("page_size", { simple: true }),
    schema: store.getMeta("schema_version")
  };
  assert.equal(pragmas.journalMode, "wal");

  settings.update({ uiLocalePreference: "en" }, 0);
  reader.exec("BEGIN");
  assert.deepEqual(reader.prepare(
    "SELECT settings_revision AS revision FROM user_settings WHERE singleton = 1"
  ).get(), { revision: 1 });

  const writeMs: number[] = [];
  const lockWaitMs: number[] = [];
  const sqlAndMappingMs: number[] = [];
  const commitBoundaryMs: number[] = [];
  const readMs: number[] = [];
  const scopeId = randomUUID();
  for (let index = 0; index < 160; index += 1) {
    phaseMarks = new Map();
    const start = performance.now();
    store.createAgent({ scopeId, agentName: `Synthetic ${index}` });
    const end = performance.now();
    writeMs.push(end - start);
    const lockStart = phaseMarks.get("write-lock-wait");
    const executing = phaseMarks.get("executing");
    const committing = phaseMarks.get("committing");
    assert.ok(lockStart !== undefined && executing !== undefined && committing !== undefined);
    lockWaitMs.push(executing - lockStart);
    sqlAndMappingMs.push(committing - executing);
    commitBoundaryMs.push(end - committing);
    phaseMarks = undefined;
    if (index % 8 === 0) {
      const readStart = performance.now();
      await service.settingsSnapshot();
      readMs.push(performance.now() - readStart);
    }
  }
  const pinned = checkpoint.pragma("wal_checkpoint(PASSIVE)")[0] as Checkpoint;
  const pinnedBytes = fileBytes(`${file}-wal`);
  const blockedTruncate = checkpoint.pragma("wal_checkpoint(TRUNCATE)")[0] as Checkpoint;
  assert.ok(pinned.log > pinned.checkpointed, "A deliberate old reader should pin WAL frames");
  assert.equal(blockedTruncate.busy, 1);

  reader.exec("COMMIT");
  const released = checkpoint.pragma("wal_checkpoint(PASSIVE)")[0] as Checkpoint;
  const recoveredTruncate = checkpoint.pragma("wal_checkpoint(TRUNCATE)")[0] as Checkpoint;
  assert.equal(recoveredTruncate.busy, 0);
  assert.equal(fileBytes(`${file}-wal`), 0);

  // Completed product reads must not keep an old snapshot alive.
  await Promise.all(Array.from({ length: 16 }, () => service!.settingsSnapshot()));
  const afterProductReads = checkpoint.pragma("wal_checkpoint(TRUNCATE)")[0] as Checkpoint;
  assert.equal(afterProductReads.busy, 0);

  locker = new Database(file);
  locker.exec("BEGIN IMMEDIATE");
  const lockedAt = performance.now();
  let lockErrorCode: string | undefined;
  try {
    store.createAgent({ scopeId, agentName: "Locked synthetic agent" });
  } catch (error) {
    lockErrorCode = (error as { code?: string }).code;
  } finally {
    locker.exec("ROLLBACK");
  }
  const externalLockWaitMs = performance.now() - lockedAt;
  assert.equal(lockErrorCode, "SQLITE_BUSY");
  store.createAgent({ scopeId, agentName: "Recovered synthetic agent" });

  process.stdout.write(`${JSON.stringify({
    scenario: "issue-197-isolated-state-wal",
    fixture: "synthetic-temporary-schema-current",
    sqliteVersion,
    pragmas,
    writes: {
      call: summary(writeMs),
      beginImmediate: summary(lockWaitMs),
      sqlAndMapping: summary(sqlAndMappingMs),
      commitAndReturn: summary(commitBoundaryMs),
      phaseMetric: "Application callback boundaries; commitAndReturn includes post-COMMIT JS. No fsync timing."
    },
    productReads: summary(readMs),
    deliberateLongReader: {
      passive: pinned,
      walPhysicalBytesBeforeRelease: pinnedBytes,
      truncateWhilePinned: blockedTruncate,
      passiveAfterRelease: released,
      truncateAfterRelease: recoveredTruncate
    },
    productReadsAfterRelease: { concurrent: 16, truncate: afterProductReads },
    externalWriteLock: {
      errorCode: lockErrorCode,
      elapsedMs: Number(externalLockWaitMs.toFixed(3)),
      subsequentWriteCommitted: true
    },
    note: "WAL physical bytes are not uncheckpointed frames; this fixture is not operating DB evidence."
  })}\n`);
} finally {
  if (reader?.inTransaction) reader.exec("ROLLBACK");
  reader?.close();
  if (locker?.inTransaction) locker.exec("ROLLBACK");
  locker?.close();
  checkpoint?.close();
  await service?.close();
  store?.close();
  await rm(root, { recursive: true, force: true });
}
