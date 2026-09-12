#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  closeSync,
  constants as fsConstants
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  requireMigrationBackupMetadata,
  sha256File,
  verifySqliteSnapshot,
  type StateMigrationBackupMetadata
} from "./stateBackup.js";
import {
  acquireStateMaintenanceLease,
  inspectStateDatabase,
  liveStateDatabaseOwners,
  writePrivateJson
} from "./stateDatabaseLifecycle.js";

export type StateRecoverySourceRuntime = {
  productVersion: string;
  buildId: string;
};

export type StateRecoveryReceipt = {
  receiptVersion: 1;
  kind: "bridge-state-pre-service-restore";
  restoredAt: string;
  sourceSchema: number;
  replacedSchema: number;
  databaseId: string;
  backupSha256: string;
  migrationCatalogSha256: string;
  sourceRuntime: StateRecoverySourceRuntime;
  sourceRuntimeProvenance: "recorded" | "operator-asserted";
  quarantineDirectory: string;
  restoredIntegrityCheck: "ok";
  restoredForeignKeyViolationCount: 0;
  serviceRestartVerified: false;
};

export function inspectStateRecovery(input: {
  databaseFile: string;
  backupFile: string;
}): {
  eligible: boolean;
  reasons: string[];
  sourceSchema: number | null;
  targetSchema: number | null;
  sourceRuntimeKnown: boolean;
  serviceOpenedAfterMigration: boolean | null;
} {
  const reasons: string[] = [];
  const parsed = parseBackupSchemas(input.backupFile);
  if (!parsed) reasons.push("Backup filename does not identify source and target schemas.");
  let inspection: ReturnType<typeof inspectStateDatabase>;
  try {
    inspection = inspectStateDatabase(input.databaseFile);
  } catch (error) {
    return {
      eligible: false,
      reasons: [`Current database inspection failed: ${errorMessage(error)}`],
      sourceSchema: parsed?.sourceSchema ?? null,
      targetSchema: parsed?.targetSchema ?? null,
      sourceRuntimeKnown: false,
      serviceOpenedAfterMigration: null
    };
  }
  if (!inspection.exists) reasons.push("The upgraded database does not exist.");
  if (parsed && inspection.schemaVersion !== parsed.targetSchema) {
    reasons.push("The current database is not at the backup's target schema.");
  }
  if (inspection.serviceOpenedAfterMigration !== false) {
    reasons.push(
      inspection.serviceOpenedAfterMigration === true
        ? "The service was opened after migration. Snapshot rollback is forbidden."
        : "The service-open boundary is unknown. Snapshot rollback is forbidden."
    );
  }
  const live = inspection.activeProcessIds.filter(processIsAlive);
  if (live.length > 0) reasons.push(`Live database owner processes remain: ${live.join(", ")}.`);
  let metadata: StateMigrationBackupMetadata | null = null;
  if (parsed && inspection.exists) {
    const databaseId = readDatabaseMeta(inspection.file, "state_database_id");
    if (!databaseId) {
      reasons.push("The upgraded database has no logical database identity.");
    } else {
      try {
        metadata = requireMigrationBackupMetadata({
          databaseFile: inspection.file,
          backupFile: input.backupFile,
          databaseId,
          sourceSchema: parsed.sourceSchema,
          targetSchema: parsed.targetSchema
        });
        if (inspection.lastMigrationId !== metadata.migrationPath.at(-1)?.id) {
          reasons.push("The current migration identity does not match the recovery backup.");
        }
      } catch (error) {
        reasons.push(`Backup verification failed: ${errorMessage(error)}`);
      }
    }
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    sourceSchema: parsed?.sourceSchema ?? null,
    targetSchema: parsed?.targetSchema ?? null,
    sourceRuntimeKnown: Boolean(metadata?.restoreContract?.sourceRuntimeKnown),
    serviceOpenedAfterMigration: inspection.serviceOpenedAfterMigration
  };
}

export function restoreStateDatabase(input: {
  databaseFile: string;
  backupFile: string;
  sourceRuntime: StateRecoverySourceRuntime;
  acknowledgeUnrecordedSourceRuntime?: boolean;
  now?: Date;
}): { receipt: StateRecoveryReceipt; receiptFile: string } {
  const parsed = parseBackupSchemas(input.backupFile);
  if (!parsed) {
    throw new Error("Backup filename must end in .pre-v<SOURCE>-to-v<TARGET>.sqlite.");
  }
  const lease = acquireStateMaintenanceLease(input.databaseFile, "recovery");
  const databaseFile = lease.databaseFile;
  const timestamp = (input.now ?? new Date()).toISOString();
  const suffix = timestamp.replace(/[:.]/g, "-");
  const quarantineDirectory = `${databaseFile}.recovery-${suffix}`;
  const temporaryRestore = `${databaseFile}.restore-tmp-${process.pid}-${randomUUID()}`;
  let currentMoved = false;
  try {
    const current = inspectStateDatabase(databaseFile, { verifyIntegrity: true });
    if (current.schemaVersion !== parsed.targetSchema) {
      throw new Error(
        `Current state schema is ${String(current.schemaVersion)}; expected migrated target ${parsed.targetSchema}.`
      );
    }
    if (current.serviceOpenedAfterMigration !== false) {
      throw new Error(
        current.serviceOpenedAfterMigration === true
          ? "Automatic snapshot restore is forbidden after the migrated service has opened. Preserve current data and use forward repair or explicit data reconciliation."
          : "Automatic snapshot restore is forbidden because the service-open boundary is unknown."
      );
    }
    const live = liveStateDatabaseOwners(databaseFile);
    if (live.length > 0) {
      throw new Error(`Stop every state database owner before restore; live process(es): ${live.join(", ")}.`);
    }
    const databaseId = readDatabaseMeta(databaseFile, "state_database_id");
    if (!databaseId) throw new Error("Current state database has no logical database identity.");
    const metadata = requireMigrationBackupMetadata({
      databaseFile,
      backupFile: input.backupFile,
      databaseId,
      sourceSchema: parsed.sourceSchema,
      targetSchema: parsed.targetSchema
    });
    const expectedLastMigration = metadata.migrationPath.at(-1)?.id;
    if (!expectedLastMigration || current.lastMigrationId !== expectedLastMigration) {
      throw new Error("Current database migration identity does not match the recovery backup.");
    }
    const sourceRuntimeProvenance = requireSourceRuntime(metadata, input);

    copyFileSync(input.backupFile, temporaryRestore, 0);
    chmodSync(temporaryRestore, 0o600);
    syncFile(temporaryRestore);
    if (sha256File(temporaryRestore) !== metadata.snapshotSha256) {
      throw new Error("Copied recovery snapshot checksum changed during restore preparation.");
    }
    verifySqliteSnapshot(temporaryRestore, parsed.sourceSchema);

    mkdirSync(quarantineDirectory, { mode: 0o700 });
    for (const candidate of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
      if (existsSync(candidate)) {
        renameSync(candidate, path.join(quarantineDirectory, path.basename(candidate)));
        if (candidate === databaseFile) currentMoved = true;
      }
    }
    renameSync(temporaryRestore, databaseFile);
    chmodSync(databaseFile, 0o600);
    syncDirectory(path.dirname(databaseFile));
    syncDirectory(quarantineDirectory);
    const restored = verifySqliteSnapshot(databaseFile, parsed.sourceSchema);
    if (readDatabaseMeta(databaseFile, "state_database_id") !== databaseId) {
      throw new Error("Restored snapshot database identity changed unexpectedly.");
    }

    const receipt: StateRecoveryReceipt = {
      receiptVersion: 1,
      kind: "bridge-state-pre-service-restore",
      restoredAt: timestamp,
      sourceSchema: parsed.sourceSchema,
      replacedSchema: parsed.targetSchema,
      databaseId,
      backupSha256: metadata.snapshotSha256,
      migrationCatalogSha256: metadata.migrationCatalogSha256,
      sourceRuntime: input.sourceRuntime,
      sourceRuntimeProvenance,
      quarantineDirectory: path.basename(quarantineDirectory),
      restoredIntegrityCheck: restored.integrityCheck,
      restoredForeignKeyViolationCount: restored.foreignKeyViolationCount,
      serviceRestartVerified: false
    };
    const receiptFile = `${databaseFile}.restore-${suffix}.json`;
    writePrivateJson(receiptFile, receipt);
    return { receipt, receiptFile };
  } catch (error) {
    rmSync(temporaryRestore, { force: true });
    if (currentMoved) {
      rmSync(databaseFile, { force: true });
      for (const name of [
        path.basename(databaseFile),
        `${path.basename(databaseFile)}-wal`,
        `${path.basename(databaseFile)}-shm`
      ]) {
        const quarantined = path.join(quarantineDirectory, name);
        if (existsSync(quarantined)) renameSync(quarantined, path.join(path.dirname(databaseFile), name));
      }
      rmSync(quarantineDirectory, { recursive: true, force: true });
      syncDirectory(path.dirname(databaseFile));
    }
    throw error;
  } finally {
    lease.release();
  }
}

function requireSourceRuntime(
  metadata: StateMigrationBackupMetadata,
  input: {
    sourceRuntime: StateRecoverySourceRuntime;
    acknowledgeUnrecordedSourceRuntime?: boolean;
  }
): "recorded" | "operator-asserted" {
  if (
    !input.sourceRuntime.productVersion.trim() ||
    !input.sourceRuntime.buildId.trim() ||
    input.sourceRuntime.productVersion.length > 200 ||
    input.sourceRuntime.buildId.length > 500
  ) {
    throw new Error("Restore requires the exact source product version and build identity.");
  }
  if (metadata.restoreContract.sourceRuntimeKnown) {
    if (
      metadata.sourceRuntime.productVersion !== input.sourceRuntime.productVersion ||
      metadata.sourceRuntime.buildId !== input.sourceRuntime.buildId
    ) {
      throw new Error("Requested source runtime does not match the runtime recorded in backup metadata.");
    }
    return "recorded";
  }
  if (!input.acknowledgeUnrecordedSourceRuntime) {
    throw new Error(
      "Backup metadata predates runtime identity recording. Explicitly attest the exact pre-upgrade product version and build before restoring."
    );
  }
  return "operator-asserted";
}

function readDatabaseMeta(file: string, key: string): string | null {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    database.close();
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is not available on every supported filesystem.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncFile(file: string): void {
  const noFollow = "O_NOFOLLOW" in fsConstants
    ? (fsConstants as typeof fsConstants & { O_NOFOLLOW: number }).O_NOFOLLOW
    : 0;
  const descriptor = openSync(file, fsConstants.O_RDONLY | noFollow);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseBackupSchemas(file: string): { sourceSchema: number; targetSchema: number } | null {
  const match = /\.pre-v(\d+)-to-v(\d+)\.sqlite$/.exec(file);
  if (!match) return null;
  return { sourceSchema: Number(match[1]), targetSchema: Number(match[2]) };
}

function processIsAlive(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseArguments(argv: string[]): {
  command: "inspect" | "restore";
  databaseFile: string;
  backupFile: string;
  sourceRuntime?: StateRecoverySourceRuntime;
  acknowledgeUnrecordedSourceRuntime?: boolean;
} {
  const [commandValue, ...rest] = argv;
  if (commandValue !== "inspect" && commandValue !== "restore") throw new Error(usage());
  const values = new Map<string, string>();
  let acknowledge = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--acknowledge-unrecorded-source-runtime") {
      acknowledge = true;
      continue;
    }
    if (!argument.startsWith("--") || index + 1 >= rest.length) throw new Error(usage());
    values.set(argument, rest[++index]);
  }
  const databaseFile = values.get("--database");
  const backupFile = values.get("--backup");
  if (!databaseFile || !backupFile || !path.isAbsolute(databaseFile) || !path.isAbsolute(backupFile)) {
    throw new Error(usage());
  }
  const productVersion = values.get("--source-product-version");
  const buildId = values.get("--source-build-id");
  return {
    command: commandValue,
    databaseFile,
    backupFile,
    ...(productVersion && buildId ? { sourceRuntime: { productVersion, buildId } } : {}),
    acknowledgeUnrecordedSourceRuntime: acknowledge
  };
}

function usage(): string {
  return "Usage: stateRecovery.js inspect --database /absolute/state.sqlite --backup /absolute/backup.sqlite\n" +
    "   or: stateRecovery.js restore --database /absolute/state.sqlite --backup /absolute/backup.sqlite " +
    "--source-product-version <version> --source-build-id <id> [--acknowledge-unrecorded-source-runtime]";
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "inspect") {
    process.stdout.write(`${JSON.stringify(inspectStateRecovery(parsed), null, 2)}\n`);
    return;
  }
  if (!parsed.sourceRuntime) throw new Error(usage());
  const result = restoreStateDatabase({
    databaseFile: parsed.databaseFile,
    backupFile: parsed.backupFile,
    sourceRuntime: parsed.sourceRuntime,
    acknowledgeUnrecordedSourceRuntime: parsed.acknowledgeUnrecordedSourceRuntime
  });
  process.stdout.write(`${JSON.stringify({
    restored: true,
    sourceSchema: result.receipt.sourceSchema,
    replacedSchema: result.receipt.replacedSchema,
    receiptFile: result.receiptFile,
    serviceRestartVerified: false
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
