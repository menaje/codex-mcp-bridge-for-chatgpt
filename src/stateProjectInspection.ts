import path from "node:path";
import Database from "better-sqlite3";
import {
  CURRENT_STATE_DATABASE_SCHEMA,
  SUPPORTED_STATE_SCHEMA_VERSIONS
} from "./stateCompatibility.js";
import { inspectStateDatabase } from "./stateDatabaseLifecycle.js";

/**
 * Shared read-only compatibility boundary for out-of-process state consumers.
 * The macOS helper never interprets project schema or opens a writer directly.
 */
export function inspectRegisteredProjectRoots(stateDatabaseFile: string): string[] {
  const inspection = inspectStateDatabase(stateDatabaseFile);
  const schemaVersion = inspection.schemaVersion;
  if (schemaVersion === null || !SUPPORTED_STATE_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new Error(
      `Project registry is unavailable while state schema ${String(schemaVersion)} ` +
      `is outside the helper's supported state schemas through ${CURRENT_STATE_DATABASE_SCHEMA}.`
    );
  }
  // The UUID project registry was introduced by schema 8. Supported older
  // schemas have no authoritative project roots for an external reader.
  if (schemaVersion < 8) return [];
  const database = new Database(stateDatabaseFile, { readonly: true, fileMustExist: true });
  try {
    const columns = database.pragma("table_info(projects)") as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === "cwd")) {
      throw new Error("Project registry table is unavailable.");
    }
    const hasDeletedAt = columns.some((column) => column.name === "deleted_at");
    const rows = database.prepare(
      hasDeletedAt
        ? "SELECT cwd FROM projects WHERE deleted_at IS NULL"
        : "SELECT cwd FROM projects"
    ).all() as Array<{ cwd?: unknown }>;
    if (rows.some((row) => typeof row.cwd !== "string" || !path.isAbsolute(row.cwd))) {
      throw new Error("Project registry contains an invalid folder path.");
    }
    return [...new Set(rows.map((row) => row.cwd as string))];
  } finally {
    database.close();
  }
}
