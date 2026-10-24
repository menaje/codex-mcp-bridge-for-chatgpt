import Database from "better-sqlite3";

/** Injects an older settings document while preserving the relational revision. */
export function replaceStoredSettingsPayloadForTest(
  file: string,
  payload: unknown
): void {
  const database = new Database(file);
  try {
    const result = database
      .prepare("UPDATE user_settings SET payload = ? WHERE singleton = 1")
      .run(JSON.stringify(payload));
    if (result.changes !== 1) throw new Error("Expected one stored settings row.");
  } finally {
    database.close();
  }
}

/** Reproduces the pre-#224 delete behavior in an isolated test database. */
export function tombstoneProjectForTest(file: string, projectId: string, now = Date.now()): void {
  const database = new Database(file);
  try {
    database.transaction(() => {
      const result = database.prepare(`
        UPDATE projects SET archived_at = COALESCE(archived_at, ?), deleted_at = ?, updated_at = ?
         WHERE project_id = ? AND deleted_at IS NULL
      `).run(now, now, now, projectId);
      if (result.changes !== 1) throw new Error("Expected one legacy project tombstone.");
      if ((database.pragma("table_info(projects)") as Array<{name:string}>).some(column=>column.name==="archive_state")) {
        database.prepare("UPDATE projects SET archive_state='processing',archive_revision=archive_revision+1,archive_requested_at=?,archived_at=NULL WHERE project_id=?").run(now,projectId);
      }
      database.prepare(`UPDATE project_registry SET registry_revision = registry_revision + 1, updated_at = ?`)
        .run(now);
    })();
  } finally {
    database.close();
  }
}
