import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSchema18Fixture } from "../test/helpers/stateSchemaFixtures.js";

type Arguments = {
  runtimeRoot: string;
  artifactKind: "npm" | "macos-arm64" | "macos-x64";
  fixtureRoot: string;
  report: string;
  previousRuntimeRoot?: string;
  artifactSha256?: string;
};

const options = parseArguments(process.argv.slice(2));
const runtimeRoot = realpathSync(options.runtimeRoot);
const fixtureRoot = realpathSync(options.fixtureRoot);
const runtimeManifest = readJson(path.join(runtimeRoot, "release-manifest.json"));
const runtimeCatalog = readJson(path.join(runtimeRoot, "state-migrations.json"));
const catalogBytes = readFileSync(path.join(runtimeRoot, "state-migrations.json"));
assert.equal(sha256(catalogBytes), runtimeManifest.stateCompatibility.migrationCatalogSha256);
assert.equal(runtimeCatalog.currentSchema, runtimeManifest.stateCompatibility.currentSchema);
assert.deepEqual(runtimeCatalog.supportedSourceSchemas, runtimeManifest.stateCompatibility.supportedSourceSchemas);
assert.deepEqual(runtimeCatalog.unsupportedSourceSchemas, [1, 2]);
assert.equal(runtimeCatalog.immutabilityPolicy, "append-only-after-release-v1");
const runtimeUiCatalog = readJson(path.join(runtimeRoot, "ui-release-catalog.json"));
const uiCatalogBytes = readFileSync(path.join(runtimeRoot, "ui-release-catalog.json"));
assert.equal(sha256(uiCatalogBytes), runtimeManifest.uiResources.releaseCatalogSha256);

const expectedArchitecture = options.artifactKind === "macos-arm64"
  ? "arm64"
  : options.artifactKind === "macos-x64"
    ? "x64"
    : process.arch;
assert.equal(process.arch, expectedArchitecture, "audit process architecture must match the artifact");
assert.ok(
  Number(process.versions.node.split(".")[0]) >= Number(runtimeManifest.toolchain.node),
  "audit Node.js must satisfy the artifact runtime requirement"
);

const runtimeRequire = createRequire(path.join(runtimeRoot, "package.json"));
const RuntimeDatabase = runtimeRequire("better-sqlite3") as typeof import("better-sqlite3").default;
const sqliteProbe = new RuntimeDatabase(":memory:");
const sqliteVersion = String((sqliteProbe.prepare("SELECT sqlite_version() AS version").get() as {
  version: string;
}).version);
sqliteProbe.close();
const betterSqlitePackage = readJson(path.join(runtimeRoot, "node_modules/better-sqlite3/package.json"));
const buildInfo = readJson(path.join(runtimeRoot, "dist/build-info.json"));

const currentStateModule = await import(pathToFileURL(path.join(runtimeRoot, "dist/stateStore.js")).href);
const currentRecoveryModule = await import(pathToFileURL(path.join(runtimeRoot, "dist/stateRecovery.js")).href);
const currentSettingsModule = await import(pathToFileURL(path.join(runtimeRoot, "dist/userSettings.js")).href);
const currentConfigModule = await import(pathToFileURL(path.join(runtimeRoot, "dist/config.js")).href);
const previousStateModule = options.previousRuntimeRoot
  ? await import(pathToFileURL(path.join(realpathSync(options.previousRuntimeRoot), "dist/stateStore.js")).href)
  : null;

const auditRoot = mkdtempSync(path.join(tmpdir(), "bridge-state-artifact-audit-"));
try {
  const cases = [];
  cases.push(await auditMigrationCase(3, "test/fixtures/state-v3-seeded.sql", true));
  cases.push(await auditMigrationCase(18, "test/fixtures/state-schema-v18.sql", false));
  const supportedStartCoverage = auditSupportedStarts();
  const interruptionRecovery = auditSchemaCommitInterruption();
  const uiCompatibility = auditUiCompatibility();

  const report = {
    reportVersion: 1,
    kind: "release-state-compatibility",
    generatedAt: new Date().toISOString(),
    artifact: {
      kind: options.artifactKind,
      sha256: options.artifactSha256 ?? null,
      productVersion: runtimeManifest.release.version,
      releaseStage: runtimeManifest.release.stage,
      buildCommit: buildInfo.commit,
      buildId: buildInfo.id,
      migrationCatalogSha256: runtimeManifest.stateCompatibility.migrationCatalogSha256,
      uiReleaseCatalogSha256: runtimeManifest.uiResources.releaseCatalogSha256
    },
    runtime: {
      platform: process.platform,
      osRelease: os.release(),
      architecture: process.arch,
      nodeVersion: process.version,
      nodeModuleAbi: process.versions.modules,
      betterSqlite3Version: betterSqlitePackage.version,
      sqliteVersion,
      nativeModuleLoaded: true,
      nodeBundledInArtifact: false,
      nodeSelectionContract: "Node.js >=22 selected by the operator or macOS runtime discovery"
    },
    compatibility: {
      currentSchema: runtimeManifest.stateCompatibility.currentSchema,
      supportedSourceSchemas: runtimeManifest.stateCompatibility.supportedSourceSchemas,
      persistentContracts: runtimeManifest.stateCompatibility.persistentContracts,
      stateProfilePolicy: runtimeManifest.stateCompatibility.stateProfilePolicy,
      rollbackPolicy: runtimeManifest.stateCompatibility.rollbackPolicy
    },
    uiCompatibility,
    supportedStartCoverage,
    interruptionRecovery,
    cases,
    boundaries: {
      migrationInterruptionTest: "artifact-deterministic-post-schema-commit-hook-and-resume",
      processTerminationTest: "not-claimed",
      powerLossTest: "not-claimed",
      userPayloadIncluded: false,
      migratedServiceOpenedBeforeRestore: false,
      priorRuntimeServiceOpenedAfterRestore: Boolean(previousStateModule),
      priorRuntimeExecution: previousStateModule ? "published-v0.3.0-package" : "not-supplied"
    }
  };
  mkdirSync(path.dirname(options.report), { recursive: true });
  writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(
    `Verified schema 3 and 18 migration/restore with ${betterSqlitePackage.version} / SQLite ${sqliteVersion}.\n`
  );
} finally {
  rmSync(auditRoot, { recursive: true, force: true });
}

function auditUiCompatibility(): Record<string, unknown> {
  const manifest = readJson(path.join(runtimeRoot, "dist/ui-manifest.json"));
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.releaseInventory.catalog, "ui-release-catalog.json");
  assert.equal(manifest.releaseInventory.catalogSha256, runtimeManifest.uiResources.releaseCatalogSha256);
  assert.deepEqual(manifest.releaseInventory.activeResources, runtimeUiCatalog.activeResources);
  assert.deepEqual(manifest.releaseInventory.compatibilityResources, runtimeUiCatalog.compatibilityResources);
  assert.deepEqual(manifest.releaseInventory.retirement, runtimeUiCatalog.retirement);
  assert.deepEqual(runtimeUiCatalog.activeResources, ["settings", "dashboard", "question"]);
  assert.deepEqual(runtimeUiCatalog.compatibilityResources, ["activity"]);
  assert.equal(runtimeUiCatalog.retirement.activity.newPresentations, false);

  const selected = [] as Array<any>;
  const physicalFiles = new Set<string>();
  const counts = {
    selected: 0,
    developmentCurrent: 0,
    publishedBaseline: 0,
    temporaryException: 0,
    uniqueBytes: 0
  };
  const toolSource = walkFiles(path.join(runtimeRoot, "dist"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  for (const [name, resource] of Object.entries(manifest.resources) as Array<[string, any]>) {
    for (const revision of [resource, ...(resource.previous || [])]) {
      const relativeDirectory = path.join("dist", "ui", name);
      const plain = path.join(runtimeRoot, relativeDirectory, `${revision.digest}.html`);
      const encoded = `${plain}.base64`;
      const file = existsSync(plain) ? plain : encoded;
      assert.ok(existsSync(file), `selected UI snapshot is missing: ${name}/${revision.digest}`);
      const stored = readFileSync(file, "utf8");
      const html = file.endsWith(".base64")
        ? Buffer.from(stored.trim(), "base64").toString("utf8")
        : stored;
      assert.equal(
        sha256(Buffer.from(stableJson({ html, metadata: revision.metadata }))),
        revision.digest,
        `selected UI snapshot digest must match: ${name}/${revision.digest}`
      );
      const provenance = revision.releaseProvenance;
      assert.ok(Array.isArray(provenance?.inventories) && provenance.inventories.length > 0);
      assert.ok(Array.isArray(provenance?.sourceIds) && provenance.sourceIds.length > 0);
      assert.ok(Array.isArray(provenance?.requiredTools) && provenance.requiredTools.length > 0);
      assert.ok(provenance.requiredTools.includes(provenance.presenterTool));
      for (const tool of provenance.requiredTools) {
        assert.ok(
          toolSource.includes(`"${tool}"`) || toolSource.includes(`'${tool}'`),
          `selected UI tool contract is missing from the artifact: ${tool}`
        );
      }
      const relative = path.relative(runtimeRoot, file);
      physicalFiles.add(relative);
      counts.uniqueBytes += Buffer.byteLength(html);
      counts.selected += 1;
      if (provenance.inventories.includes("development-current")) counts.developmentCurrent += 1;
      if (provenance.inventories.includes("published-baseline")) counts.publishedBaseline += 1;
      if (provenance.inventories.includes("temporary-exception")) counts.temporaryException += 1;
      selected.push({
        name,
        digest: revision.digest,
        uri: revision.uri,
        inventories: provenance.inventories,
        sourceIds: provenance.sourceIds,
        presenterTool: provenance.presenterTool,
        requiredTools: provenance.requiredTools,
        bytes: Buffer.byteLength(html)
      });
    }
  }
  assert.deepEqual(
    selected.map(({ bytes: _bytes, ...entry }) => entry),
    manifest.releaseInventory.selected
  );
  const packagedFiles = new Set(
    walkFiles(path.join(runtimeRoot, "dist", "ui")).map((file) => path.relative(runtimeRoot, file))
  );
  assert.deepEqual(packagedFiles, physicalFiles, "artifact must contain only explicitly selected UI snapshots");

  const catalogRevisions = [
    ...runtimeUiCatalog.publishedBaselines.flatMap((source: any) =>
      source.resources.map((revision: any) => ({ sourceId: source.id, revision }))
    ),
    ...runtimeUiCatalog.temporaryExceptions.flatMap((source: any) =>
      source.resources.map((revision: any) => ({ sourceId: source.id, revision }))
    )
  ];
  for (const { sourceId, revision } of catalogRevisions) {
    assert.ok(selected.some((entry) =>
      entry.name === revision.name && entry.digest === revision.digest &&
      entry.uri === revision.uri && entry.sourceIds.includes(sourceId)
    ), `catalog revision was not selected: ${sourceId}/${revision.name}`);
  }
  assert.equal(counts.selected, 8);
  assert.equal(counts.developmentCurrent, 3);
  assert.equal(counts.publishedBaseline, 2);
  assert.equal(counts.temporaryException, 4);
  return {
    catalogVersion: runtimeUiCatalog.catalogVersion,
    activeResources: runtimeUiCatalog.activeResources,
    compatibilityResources: runtimeUiCatalog.compatibilityResources,
    selectionCounts: counts,
    selected,
    unclassifiedSnapshotCount: 0,
    publishedBaseline: runtimeUiCatalog.publishedBaselines.map((entry: any) => ({
      id: entry.id,
      version: entry.version,
      tag: entry.tag,
      commit: entry.commit,
      artifactSha256: entry.artifact.sha256
    })),
    temporaryExceptions: runtimeUiCatalog.temporaryExceptions.map((entry: any) => ({
      id: entry.id,
      kind: entry.kind,
      commit: entry.commit,
      buildId: entry.buildId,
      exitCondition: entry.exitCondition
    })),
    activityRetirement: runtimeUiCatalog.retirement.activity
  };
}

function auditSupportedStarts(): Array<{
  sourceSchema: number;
  provenance: string;
  reachedSchema: number;
}> {
  const results = [];
  for (const sourceSchema of runtimeCatalog.supportedSourceSchemas as number[]) {
    const caseRoot = path.join(auditRoot, `direct-start-${sourceSchema}`);
    const databaseFile = path.join(caseRoot, "state.sqlite");
    mkdirSync(caseRoot, { mode: 0o700 });
    const derived = runtimeCatalog.derivedCheckpoints.find(
      (entry: any) => entry.schema === sourceSchema
    );
    if (derived) {
      seedSchema(Number(derived.sourceFixtureSchema), databaseFile);
      let checkpointReached = false;
      assert.throws(
        () => new currentStateModule.BridgeStateStore({
          file: databaseFile,
          onMigrationProgress(progress: any) {
            if (progress.targetSchema === sourceSchema) {
              checkpointReached = true;
              throw new Error(`derived-checkpoint-${sourceSchema}`);
            }
          }
        }),
        new RegExp(`derived-checkpoint-${sourceSchema}`)
      );
      assert.equal(checkpointReached, true);
      const checkpoint = new RuntimeDatabase(databaseFile);
      try {
        assert.equal(Number(readMeta(checkpoint, "schema_version")), sourceSchema);
        checkpoint.prepare(`DELETE FROM bridge_meta WHERE
          key='schema_v19_upgrade_source' OR
          key='state_database_id' OR
          key='state_schema_origin' OR
          key IN ('state_runtime_product_version','state_runtime_build_id') OR
          key LIKE 'state_migration%' OR
          key LIKE 'state_last_migration%' OR
          key LIKE 'state_service_opened%'`).run();
      } finally {
        checkpoint.close();
      }
      removeMigrationArtifacts(databaseFile, Number(derived.sourceFixtureSchema));
    } else {
      seedSchema(sourceSchema, databaseFile);
    }

    const direct = new currentStateModule.BridgeStateStore({ file: databaseFile });
    try {
      assert.equal(direct.schemaVersion, runtimeCatalog.currentSchema);
      assert.equal(direct.getMeta("schema_v19_source_version"), String(sourceSchema));
    } finally {
      direct.close();
    }
    results.push({
      sourceSchema,
      provenance: derived
        ? `derived:${derived.sourceFixtureSchema}:${derived.afterMigrationId}`
        : `fixture:${runtimeCatalog.fixtures.find((entry: any) => entry.schema === sourceSchema)?.source}`,
      reachedSchema: runtimeCatalog.currentSchema
    });
  }
  return results;
}

function auditSchemaCommitInterruption(): Record<string, unknown> {
  const caseRoot = path.join(auditRoot, "schema-commit-interruption");
  const databaseFile = path.join(caseRoot, "state.sqlite");
  mkdirSync(caseRoot, { mode: 0o700 });
  seedSchema(18, databaseFile);
  let hookFired = false;
  assert.throws(
    () => new currentStateModule.BridgeStateStore({
      file: databaseFile,
      onMigrationSchemaCommitted(progress: any) {
        assert.equal(progress.migrationId, "bridge-state-18-to-19");
        hookFired = true;
        throw new Error("artifact-schema-commit-interruption");
      }
    }),
    /artifact-schema-commit-interruption/
  );
  assert.equal(hookFired, true);
  const interrupted = new RuntimeDatabase(databaseFile, { readonly: true, fileMustExist: true });
  try {
    assert.equal(Number(readMeta(interrupted, "schema_version")), 19);
    assert.match(String(readMeta(interrupted, "state_migration_pending")), /bridge-state-18-to-19/);
  } finally {
    interrupted.close();
  }
  const resumed = new currentStateModule.BridgeStateStore({ file: databaseFile });
  try {
    assert.equal(resumed.schemaVersion, 19);
    assert.equal(resumed.getMeta("state_migration_pending"), undefined);
    assert.match(
      String(resumed.getMeta("state_migration:bridge-state-18-to-19")),
      /bridge-state-18-to-19/
    );
  } finally {
    resumed.close();
  }
  return {
    sourceSchema: 18,
    committedSchemaBeforeProvenance: 19,
    pendingRecordObserved: true,
    resumedSchema: 19,
    provenanceFinalized: true
  };
}

function seedSchema(schema: number, databaseFile: string): void {
  if (schema === 3) {
    const database = new RuntimeDatabase(databaseFile);
    try {
      database.exec(readFileSync(path.join(fixtureRoot, "test/fixtures/state-v3-seeded.sql"), "utf8"));
    } finally {
      database.close();
    }
    return;
  }
  if (schema === 16) {
    const database = new RuntimeDatabase(databaseFile);
    try {
      database.exec(readFileSync(path.join(fixtureRoot, "test/fixtures/state-schema-v16.sql"), "utf8"));
    } finally {
      database.close();
    }
    return;
  }
  if (schema === 18) {
    createSchema18Fixture(databaseFile);
    return;
  }
  throw new Error(`No fixture source is declared for schema ${schema}.`);
}

function removeMigrationArtifacts(databaseFile: string, originalSourceSchema: number): void {
  for (const candidate of [
    `${databaseFile}.pre-v${originalSourceSchema}-to-v19.sqlite`,
    `${databaseFile}.migration-v${originalSourceSchema}-to-v19.backup.json`,
    `${databaseFile}.migration-status.json`,
    `${databaseFile}.migration-lock.json`
  ]) rmSync(candidate, { force: true });
}

async function auditMigrationCase(
  sourceSchema: number,
  fixtureRelative: string,
  runPreviousRuntime: boolean
): Promise<Record<string, unknown>> {
  const fixture = path.join(fixtureRoot, fixtureRelative);
  const catalogFixture = runtimeCatalog.fixtures.find((entry: any) => entry.schema === sourceSchema);
  assert.ok(catalogFixture, `catalog fixture for schema ${sourceSchema}`);
  assert.equal(catalogFixture.path, fixtureRelative);
  assert.equal(sha256(readFileSync(fixture)), catalogFixture.sha256);

  const caseRoot = path.join(auditRoot, `schema-${sourceSchema}`);
  const databaseFile = path.join(caseRoot, "state.sqlite");
  const fs = await import("node:fs");
  fs.mkdirSync(caseRoot, { mode: 0o700 });
  if (sourceSchema === 18) createSchema18Fixture(databaseFile);
  const source = new RuntimeDatabase(databaseFile);
  if (sourceSchema !== 18) source.exec(readFileSync(fixture, "utf8"));
  const sourceRuntime = sourceSchema === 18
    ? { productVersion: "0.3.0-development-schema18", buildId: "b1104aa4b2f" }
    : { productVersion: "0.3.0", buildId: "published-v0.3.0" };
  if (sourceSchema === 18) {
    source.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_runtime_product_version',?)")
      .run(sourceRuntime.productVersion);
    source.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_runtime_build_id',?)")
      .run(sourceRuntime.buildId);
  } else {
    source.prepare("INSERT INTO user_settings(singleton,payload) VALUES (1,?)").run(JSON.stringify({
      schemaVersion: 2,
      revision: 4,
      updatedAt: "2026-08-26T00:00:00.000Z",
      accessStrategy: "always-full",
      defaultModel: null,
      defaultReasoningEffort: null,
      defaultCwd: null,
      defaultSessionMode: "auto",
      autoResumeTtlMs: 6 * 60 * 60 * 1000,
      modelPolicy: {
        mode: "automatic",
        preferredSelection: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        allowedSelections: { kind: "catalog-visible" },
        constraints: { allowDelegation: true }
      },
      maxConcurrentJobs: 7,
      completionDeliveryMode: "card-only",
      projects: [{ id: "retired-json-project", cwd: "/tmp/retired-json-project" }],
      historyRetentionDays: 30
    }));
  }
  const sourceCounts = semanticCounts(source);
  source.close();

  const checkpoints: Array<{ id: string; targetSchema: number }> = [];
  const startedAt = Date.now();
  let state = new currentStateModule.BridgeStateStore({
    file: databaseFile,
    onMigrationProgress(progress: any) {
      checkpoints.push({ id: progress.migrationId, targetSchema: progress.targetSchema });
    }
  });
  assert.equal(state.schemaVersion, 19);
  assert.equal(state.getMeta("schema_v19_source_version"), String(sourceSchema));
  const migratedDatabase = new RuntimeDatabase(databaseFile, { readonly: true, fileMustExist: true });
  const migratedCounts = semanticCounts(migratedDatabase);
  const migrationDisposition = {
    removedLegacySessions: Number(readMeta(migratedDatabase, "schema_v19_removed_legacy_session_count") || 0),
    removedLegacyAgentThreads: Number(readMeta(migratedDatabase, "schema_v19_removed_legacy_agent_thread_count") || 0)
  };
  const executionContexts = {
    total: tableCount(migratedDatabase, "sessions"),
    appServer: Number((migratedDatabase.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE backend_kind='app-server'"
    ).get() as { count: number }).count),
    retiredBackend: Number((migratedDatabase.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE backend_kind<>'app-server'"
    ).get() as { count: number }).count)
  };
  migratedDatabase.close();
  for (const field of [
    "jobs", "questions", "questionDeliveries", "completionOutbox",
    "cancellationOperations", "cancellationIntents", "steeringDeliveries",
    "automaticRecovery", "automaticRecoveryIncidents", "resultHolds"
  ] as const) {
    assert.equal(migratedCounts[field], sourceCounts[field], `${field} must retain its authority rows`);
  }
  assert.equal(
    migratedCounts.sessions + migrationDisposition.removedLegacySessions,
    sourceCounts.sessions,
    "session removals must equal the declared invalid legacy-context count"
  );
  const config = currentConfigModule.loadConfig({
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: databaseFile
  });
  const settings = new currentSettingsModule.UserSettingsStore(config, { stateStore: state });
  const settingsContract = {
    schemaVersion: settings.current.schemaVersion,
    accessStrategy: settings.current.accessStrategy,
    modelPolicyMode: settings.current.modelPolicy.mode,
    historyRetentionDays: settings.current.historyRetentionDays,
    effectiveSandbox: settings.resolveSandbox(),
    retiredPreferredSelectionRemoved: !("preferredSelection" in settings.current.modelPolicy),
    registeredProjectCount: settings.current.projects.length
  };
  assert.equal(settingsContract.schemaVersion, 4);
  assert.equal(settingsContract.retiredPreferredSelectionRemoved, true);
  if (sourceSchema === 3) {
    assert.equal(settingsContract.accessStrategy, "always-full");
    assert.equal(settingsContract.effectiveSandbox, "read-only");
    assert.equal(settingsContract.registeredProjectCount, 0);
  }
  state.close();
  state = new currentStateModule.BridgeStateStore({ file: databaseFile });
  state.close();
  state = new currentStateModule.BridgeStateStore({ file: databaseFile });
  state.close();

  const backupFile = `${databaseFile}.pre-v${sourceSchema}-to-v19.sqlite`;
  const eligibility = currentRecoveryModule.inspectStateRecovery({ databaseFile, backupFile });
  assert.equal(eligibility.eligible, true);
  const restored = currentRecoveryModule.restoreStateDatabase({
    databaseFile,
    backupFile,
    sourceRuntime,
    acknowledgeUnrecordedSourceRuntime: sourceSchema === 3
  });
  const restoredDatabase = new RuntimeDatabase(databaseFile, { readonly: true, fileMustExist: true });
  assert.equal(Number(readMeta(restoredDatabase, "schema_version")), sourceSchema);
  assert.deepEqual(semanticCounts(restoredDatabase), sourceCounts);
  restoredDatabase.close();

  let previousRuntime = "not-applicable";
  if (runPreviousRuntime) {
    assert.ok(previousStateModule, "published v0.3.0 runtime is required for the schema-3 restore case");
    const prior = new previousStateModule.BridgeStateStore({ file: databaseFile });
    assert.equal(prior.schemaVersion, 3);
    assert.equal(prior.listSessions().length, sourceCounts.sessions);
    assert.equal(prior.listJobs().length, sourceCounts.jobs);
    prior.close();
    await verifyPreviousRuntimeService(realpathSync(options.previousRuntimeRoot!), databaseFile);
    previousRuntime = "state-read-then-health-opened-and-cleanly-stopped-with-published-v0.3.0";
  }

  const metadataFile = `${databaseFile}.migration-v${sourceSchema}-to-v19.backup.json`;
  const metadata = readJson(metadataFile);
  return {
    sourceSchema,
    sourceKind: catalogFixture.kind,
    source: catalogFixture.source,
    fixtureSha256: catalogFixture.sha256,
    migrationDurationMs: Date.now() - startedAt,
    checkpoints,
    twoCurrentRestarts: true,
    settingsContract,
    sourceCounts,
    migratedCounts,
    migrationDisposition,
    workMeaning: {
      historicalJobReceiptsPreserved: migratedCounts.jobs === sourceCounts.jobs,
      executionContexts,
      removedSessionContextsDeclared: (
        migratedCounts.sessions + migrationDisposition.removedLegacySessions === sourceCounts.sessions
      ),
      requestReplayPerformed: false
    },
    backup: {
      bytes: statSync(backupFile).size,
      sha256: metadata.snapshotSha256,
      integrityCheck: metadata.verification.integrityCheck,
      foreignKeyViolationCount: metadata.verification.foreignKeyViolationCount,
      databaseIdentityMatched: true,
      migrationPathMatched: true,
      mode: (statSync(backupFile).mode & 0o777).toString(8)
    },
    restore: {
      completed: true,
      sourceRuntimeProvenance: restored.receipt.sourceRuntimeProvenance,
      replacedDatabaseQuarantined: true,
      restoredSchema: sourceSchema,
      semanticCountsMatched: true,
      priorRuntime: previousRuntime,
      serviceRestartVerified: runPreviousRuntime,
      recoveryReceiptServiceRestartVerified: restored.receipt.serviceRestartVerified
    }
  };
}

async function verifyPreviousRuntimeService(runtime: string, databaseFile: string): Promise<void> {
  const port = await availablePort();
  let diagnosticOutput = "";
  const child = spawn(process.execPath, [path.join(runtime, "dist/cli.js")], {
    cwd: runtime,
    env: {
      ...process.env,
      CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
      CODEX_MCP_BRIDGE_PORT: String(port),
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: databaseFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      diagnosticOutput = `${diagnosticOutput}${String(chunk)}`.slice(-4_000);
    });
  }
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          "Published v0.3.0 runtime exited before its health endpoint opened" +
          (diagnosticOutput.trim() ? `: ${diagnosticOutput.trim()}` : ".")
        );
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) return;
      } catch {
        // Startup is still in progress.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Published v0.3.0 runtime did not become healthy within 15 seconds.");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000))
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
    }
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function semanticCounts(database: import("better-sqlite3").Database): {
  sessions: number;
  jobs: number;
  questions: number;
  questionDeliveries: number;
  completionOutbox: number;
  cancellationOperations: number;
  cancellationIntents: number;
  steeringDeliveries: number;
  automaticRecovery: number;
  automaticRecoveryIncidents: number;
  resultHolds: number;
} {
  return {
    sessions: tableCount(database, "sessions"),
    jobs: tableCount(database, "jobs"),
    questions: tableCount(database, "user_questions"),
    questionDeliveries: tableCount(database, "codex_question_deliveries"),
    completionOutbox: tableCount(database, "completion_outbox"),
    cancellationOperations: tableCount(database, "cancellation_operations"),
    cancellationIntents: tableCount(database, "cancellation_intents"),
    steeringDeliveries: tableCount(database, "steering_deliveries"),
    automaticRecovery: tableCount(database, "automatic_recovery"),
    automaticRecoveryIncidents: tableCount(database, "automatic_recovery_incidents"),
    resultHolds: tableCount(database, "result_holds")
  };
}

function tableCount(database: import("better-sqlite3").Database, table: string): number {
  const exists = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table);
  if (!exists) return 0;
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
    count: number;
  }).count);
}

function readMeta(database: import("better-sqlite3").Database, key: string): string | null {
  const row = database.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(usage());
    values.set(key, value);
  }
  const runtimeRoot = values.get("--runtime-root");
  const artifactKind = values.get("--artifact-kind") as Arguments["artifactKind"] | undefined;
  const fixtureRoot = values.get("--fixture-root");
  const report = values.get("--report");
  if (
    !runtimeRoot ||
    !fixtureRoot ||
    !report ||
    !["npm", "macos-arm64", "macos-x64"].includes(String(artifactKind))
  ) throw new Error(usage());
  return {
    runtimeRoot,
    artifactKind: artifactKind as Arguments["artifactKind"],
    fixtureRoot,
    report,
    ...(values.get("--previous-runtime-root")
      ? { previousRuntimeRoot: values.get("--previous-runtime-root") }
      : {}),
    ...(values.get("--artifact-sha256") ? { artifactSha256: values.get("--artifact-sha256") } : {})
  };
}

function usage(): string {
  return "Usage: state-release-audit.ts --runtime-root <dir> --artifact-kind <npm|macos-arm64|macos-x64> " +
    "--fixture-root <repo> --report <json> --previous-runtime-root <dir> [--artifact-sha256 <digest>]";
}

function walkFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
