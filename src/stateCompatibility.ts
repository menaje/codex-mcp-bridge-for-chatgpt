import catalog from "../state-migrations.json" with { type: "json" };
import manifest from "../release-manifest.json" with { type: "json" };

export type StateMigrationCatalogEntry = {
  id: string;
  fromSchema: number;
  toSchema: number;
  implementation: string;
  sha256: string;
};

export const STATE_MIGRATION_CATALOG_VERSION = catalog.catalogVersion;
export const STATE_MIGRATION_CATALOG_SHA256 = manifest.stateCompatibility.migrationCatalogSha256;
export const CURRENT_STATE_DATABASE_SCHEMA = catalog.currentSchema;
export const SUPPORTED_STATE_SOURCE_SCHEMAS = Object.freeze(
  [...catalog.supportedSourceSchemas]
);
export const SUPPORTED_STATE_SCHEMA_VERSIONS = new Set([
  ...SUPPORTED_STATE_SOURCE_SCHEMAS,
  CURRENT_STATE_DATABASE_SCHEMA
]);
export const STATE_MIGRATIONS = Object.freeze(
  catalog.migrations as readonly StateMigrationCatalogEntry[]
);

export function stateMigration(fromSchema: number, toSchema: number): StateMigrationCatalogEntry {
  const entry = STATE_MIGRATIONS.find(
    (candidate) => candidate.fromSchema === fromSchema && candidate.toSchema === toSchema
  );
  if (!entry) {
    throw new Error(`State migration catalog has no ${fromSchema}->${toSchema} entry.`);
  }
  return entry;
}

export function stateMigrationPath(sourceSchema: number): StateMigrationCatalogEntry[] {
  const path: StateMigrationCatalogEntry[] = [];
  let current = sourceSchema;
  while (current !== CURRENT_STATE_DATABASE_SCHEMA) {
    const entry = STATE_MIGRATIONS.find((candidate) => candidate.fromSchema === current);
    if (!entry) throw new Error(`State migration catalog cannot reach schema 19 from ${sourceSchema}.`);
    path.push(entry);
    current = entry.toSchema;
    if (path.length > STATE_MIGRATIONS.length) {
      throw new Error("State migration catalog contains a cycle.");
    }
  }
  return path;
}
