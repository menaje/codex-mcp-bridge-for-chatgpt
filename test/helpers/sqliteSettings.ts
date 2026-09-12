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
