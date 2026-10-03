import type Database from "better-sqlite3";
import type { BridgeStateStore, JobCompletionDeliveryRecord } from "../../src/stateStore.js";

// Seed upgrade fixtures with records written by the retired v3 sender. This is
// test-only SQL: production never rewrites historical delivery receipts.
export function historicalCompletion(
  store: BridgeStateStore,
  jobId: string,
  state: JobCompletionDeliveryRecord["state"],
  fields: Record<string, string | number | null> = {}
): JobCompletionDeliveryRecord {
  const db = (store as unknown as { database: Database.Database }).database;
  const values = { state, attempt_count: 1, ...fields };
  for (const key of Object.keys(values)) {
    if (!/^[a-z_]+$/.test(key)) throw new Error("Invalid fixture column");
  }
  db.prepare(`UPDATE job_completion_deliveries SET ${Object.keys(values).map(key => `${key}=?`).join(",")} WHERE job_id=?`)
    .run(...Object.values(values), jobId);
  return store.getJobCompletionDelivery(jobId)!;
}
