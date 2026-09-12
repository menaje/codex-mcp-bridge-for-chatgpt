import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  constants as fsConstants
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { MODEL_POLICY_SCHEMA_VERSION } from "./modelPolicy.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  CURRENT_STATE_DATABASE_SCHEMA,
  STATE_MIGRATION_CATALOG_SHA256,
  stateMigrationPath
} from "./stateCompatibility.js";
import {
  databaseIdentity,
  readPrivateJson,
  writePrivateJson
} from "./stateDatabaseLifecycle.js";

const DATABASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StateMigrationBackupMetadata = {
  metadataVersion: 1;
  kind: "bridge-state-pre-upgrade";
  databaseId: string;
  sourceDatabaseIdentity: string;
  backupFile: string;
  snapshotSha256: string;
  sourceSchema: number;
  targetSchema: number;
  migrationPath: Array<{ id: string; fromSchema: number; toSchema: number; sha256: string }>;
  migrationCatalogSha256: string;
  sourceRuntime: {
    productVersion: string | null;
    buildId: string | null;
    userSettingsSchema: number | null;
  };
  targetRuntime: {
    productVersion: string;
    buildId: string;
    userSettingsSchema: number;
  };
  createdAt: string;
  verification: {
    integrityCheck: "ok";
    foreignKeyViolationCount: 0;
    tableCountsSha256: string;
    tableCount: number;
  };
  restoreContract: {
    automaticRestoreBoundary: "before-service-open";
    sourceRuntimeKnown: boolean;
    unknownSourceRuntimeAction: "supply-exact-pre-upgrade-runtime-and-settings" | null;
  };
};

export function migrationBackupMetadataPath(
  databaseFile: string,
  sourceSchema: number,
  targetSchema: number
): string {
  return `${databaseFile}.migration-v${sourceSchema}-to-v${targetSchema}.backup.json`;
}

export function createMigrationBackupMetadata(input: {
  databaseFile: string;
  backupFile: string;
  databaseId: string;
  sourceSchema: number;
  targetSchema: number;
  createdAt?: string;
}): StateMigrationBackupMetadata {
  if (input.targetSchema !== CURRENT_STATE_DATABASE_SCHEMA) {
    throw new Error(
      `Migration backup target ${input.targetSchema} does not match current schema ${CURRENT_STATE_DATABASE_SCHEMA}.`
    );
  }
  if (!DATABASE_ID_PATTERN.test(input.databaseId)) {
    throw new Error("Migration backup requires a valid logical database identity.");
  }
  assertRegularSnapshot(input.backupFile);
  chmodSync(input.backupFile, 0o600);
  syncSnapshotFile(input.backupFile);
  const verification = verifySqliteSnapshot(input.backupFile, input.sourceSchema);
  const source = readRuntimeIdentity(input.backupFile);
  const backupDatabaseId = readDatabaseMeta(input.backupFile, "state_database_id");
  if (backupDatabaseId !== input.databaseId) {
    throw new Error("Migration backup does not contain the source database identity marker.");
  }
  const metadata: StateMigrationBackupMetadata = {
    metadataVersion: 1,
    kind: "bridge-state-pre-upgrade",
    databaseId: input.databaseId,
    sourceDatabaseIdentity: databaseIdentity(input.databaseFile),
    backupFile: path.basename(input.backupFile),
    snapshotSha256: sha256File(input.backupFile),
    sourceSchema: input.sourceSchema,
    targetSchema: input.targetSchema,
    migrationPath: stateMigrationPath(input.sourceSchema).map((entry) => ({
      id: entry.id,
      fromSchema: entry.fromSchema,
      toSchema: entry.toSchema,
      sha256: entry.sha256
    })),
    migrationCatalogSha256: STATE_MIGRATION_CATALOG_SHA256,
    sourceRuntime: source,
    targetRuntime: {
      productVersion: PRODUCT_INFO.version,
      buildId: BRIDGE_BUILD_INFO.id,
      userSettingsSchema: MODEL_POLICY_SCHEMA_VERSION
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
    verification,
    restoreContract: {
      automaticRestoreBoundary: "before-service-open",
      sourceRuntimeKnown: source.productVersion !== null && source.buildId !== null,
      unknownSourceRuntimeAction: source.productVersion !== null && source.buildId !== null
        ? null
        : "supply-exact-pre-upgrade-runtime-and-settings"
    }
  };
  writePrivateJson(
    migrationBackupMetadataPath(input.databaseFile, input.sourceSchema, input.targetSchema),
    metadata
  );
  return metadata;
}

export function requireMigrationBackupMetadata(input: {
  databaseFile: string;
  backupFile: string;
  databaseId: string;
  sourceSchema: number;
  targetSchema: number;
}): StateMigrationBackupMetadata {
  const metadataFile = migrationBackupMetadataPath(
    input.databaseFile,
    input.sourceSchema,
    input.targetSchema
  );
  if (!existsSync(metadataFile)) {
    throw new Error(
      `Migration recovery metadata is missing for the original v${input.sourceSchema} backup.`
    );
  }
  assertRegularSnapshot(input.backupFile);
  chmodSync(input.backupFile, 0o600);
  const metadata = readPrivateJson(metadataFile) as Partial<StateMigrationBackupMetadata>;
  if (
    metadata.metadataVersion !== 1 ||
    metadata.kind !== "bridge-state-pre-upgrade" ||
    metadata.databaseId !== input.databaseId ||
    typeof metadata.databaseId !== "string" ||
    !DATABASE_ID_PATTERN.test(metadata.databaseId) ||
    metadata.sourceDatabaseIdentity !== databaseIdentity(input.databaseFile) ||
    !/^[0-9a-f]{64}$/.test(String(metadata.sourceDatabaseIdentity)) ||
    metadata.backupFile !== path.basename(input.backupFile) ||
    metadata.sourceSchema !== input.sourceSchema ||
    metadata.targetSchema !== input.targetSchema ||
    input.targetSchema !== CURRENT_STATE_DATABASE_SCHEMA ||
    metadata.migrationCatalogSha256 !== STATE_MIGRATION_CATALOG_SHA256 ||
    typeof metadata.snapshotSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(metadata.snapshotSha256) ||
    typeof metadata.createdAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.createdAt)) ||
    !validRuntimeIdentity(metadata.sourceRuntime, true) ||
    !validRuntimeIdentity(metadata.targetRuntime, false) ||
    metadata.targetRuntime?.productVersion !== PRODUCT_INFO.version ||
    metadata.targetRuntime?.buildId !== BRIDGE_BUILD_INFO.id ||
    metadata.targetRuntime?.userSettingsSchema !== MODEL_POLICY_SCHEMA_VERSION ||
    metadata.restoreContract?.automaticRestoreBoundary !== "before-service-open" ||
    typeof metadata.restoreContract.sourceRuntimeKnown !== "boolean" ||
    metadata.restoreContract.sourceRuntimeKnown !== (
      typeof metadata.sourceRuntime?.productVersion === "string" &&
      typeof metadata.sourceRuntime?.buildId === "string"
    ) ||
    metadata.restoreContract.unknownSourceRuntimeAction !== (
      metadata.restoreContract.sourceRuntimeKnown
        ? null
        : "supply-exact-pre-upgrade-runtime-and-settings"
    )
  ) {
    throw new Error("Migration recovery metadata does not match this database and upgrade.");
  }
  if (sha256File(input.backupFile) !== metadata.snapshotSha256) {
    throw new Error("Migration recovery backup checksum does not match its immutable metadata.");
  }
  const verification = verifySqliteSnapshot(input.backupFile, input.sourceSchema);
  if (
    metadata.verification?.integrityCheck !== "ok" ||
    metadata.verification.foreignKeyViolationCount !== 0 ||
    metadata.verification.tableCountsSha256 !== verification.tableCountsSha256 ||
    metadata.verification.tableCount !== verification.tableCount
  ) {
    throw new Error("Migration recovery backup verification no longer matches its metadata.");
  }
  if (readDatabaseMeta(input.backupFile, "state_database_id") !== input.databaseId) {
    throw new Error("Migration recovery backup belongs to another state database.");
  }
  const expectedPath = stateMigrationPath(input.sourceSchema);
  if (
    expectedPath.at(-1)?.toSchema !== input.targetSchema ||
    !Array.isArray(metadata.migrationPath) ||
    JSON.stringify(metadata.migrationPath) !== JSON.stringify(expectedPath.map((entry) => ({
      id: entry.id,
      fromSchema: entry.fromSchema,
      toSchema: entry.toSchema,
      sha256: entry.sha256
    })))
  ) {
    throw new Error("Migration recovery backup references a changed migration path.");
  }
  return metadata as StateMigrationBackupMetadata;
}

export function verifySqliteSnapshot(
  file: string,
  expectedSchema: number
): StateMigrationBackupMetadata["verification"] {
  assertRegularSnapshot(file);
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    const schema = readMeta(database, "schema_version");
    if (schema !== String(expectedSchema)) {
      throw new Error(
        `Migration recovery backup has version ${schema ?? "unknown"}; expected ${expectedSchema}.`
      );
    }
    const integrity = database.pragma("integrity_check") as Array<Record<string, unknown>>;
    if (
      integrity.length !== 1 ||
      String(Object.values(integrity[0] || {})[0]).toLowerCase() !== "ok"
    ) {
      throw new Error("Migration recovery backup failed PRAGMA integrity_check.");
    }
    const foreignKeyViolationCount = (database.pragma("foreign_key_check") as unknown[]).length;
    if (foreignKeyViolationCount !== 0) {
      throw new Error(
        `Migration recovery backup has ${foreignKeyViolationCount} foreign-key violation(s).`
      );
    }
    const tableCounts = (database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Array<{ name: string }>).map(({ name }) => ({
      name,
      rows: Number((database.prepare(`SELECT COUNT(*) AS count FROM ${sqlIdentifier(name)}`).get() as {
        count: number;
      }).count)
    }));
    return {
      integrityCheck: "ok",
      foreignKeyViolationCount: 0,
      tableCountsSha256: createHash("sha256").update(JSON.stringify(tableCounts)).digest("hex"),
      tableCount: tableCounts.length
    };
  } finally {
    database.close();
  }
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const noFollow = "O_NOFOLLOW" in fsConstants
    ? (fsConstants as typeof fsConstants & { O_NOFOLLOW: number }).O_NOFOLLOW
    : 0;
  const descriptor = openSync(file, fsConstants.O_RDONLY | noFollow);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Migration recovery snapshot is not a regular file.");
    let offset = 0;
    while (offset < stat.size) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
      offset += bytes;
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function validRuntimeIdentity(
  value: unknown,
  nullable: boolean
): value is StateMigrationBackupMetadata["sourceRuntime"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const productKnown = typeof candidate.productVersion === "string";
  const buildKnown = typeof candidate.buildId === "string";
  if (nullable && productKnown !== buildKnown) return false;
  const validString = (item: unknown) => nullable
    ? item === null || (typeof item === "string" && item.length > 0 && item.length <= 500)
    : typeof item === "string" && item.length > 0 && item.length <= 500;
  const settings = candidate.userSettingsSchema;
  return validString(candidate.productVersion) &&
    validString(candidate.buildId) &&
    (nullable
      ? settings === null || (Number.isSafeInteger(settings) && Number(settings) > 0)
      : Number.isSafeInteger(settings) && Number(settings) > 0);
}

function assertRegularSnapshot(file: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Migration recovery snapshot must be a regular non-symlink file.");
  }
}

function syncSnapshotFile(file: string): void {
  const noFollow = "O_NOFOLLOW" in fsConstants
    ? (fsConstants as typeof fsConstants & { O_NOFOLLOW: number }).O_NOFOLLOW
    : 0;
  const descriptor = openSync(file, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Migration recovery snapshot is not a regular file.");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readRuntimeIdentity(file: string): StateMigrationBackupMetadata["sourceRuntime"] {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const settingsSchema = tableExists(database, "user_settings")
      ? (() => {
          const row = database.prepare("SELECT payload FROM user_settings WHERE singleton=1").get() as
            | { payload: string }
            | undefined;
          if (!row) return null;
          try {
            const value = JSON.parse(row.payload) as { schemaVersion?: unknown };
            return Number.isSafeInteger(value.schemaVersion) ? Number(value.schemaVersion) : null;
          } catch {
            return null;
          }
        })()
      : null;
    return {
      productVersion: readMeta(database, "state_runtime_product_version") ?? null,
      buildId: readMeta(database, "state_runtime_build_id") ?? null,
      userSettingsSchema: settingsSchema
    };
  } finally {
    database.close();
  }
}

function readDatabaseMeta(file: string, key: string): string | null {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return readMeta(database, key) ?? null;
  } finally {
    database.close();
  }
}

function readMeta(database: Database.Database, key: string): string | undefined {
  const row = database.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name));
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
