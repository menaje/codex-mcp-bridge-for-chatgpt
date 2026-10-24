import Database from "better-sqlite3";
import { chmodSync, realpathSync } from "node:fs";

/** Cross-process mutex only: this file has no tables or historical content.
 * The state owner holds it through the OUTER settings commit/rollback. The
 * telemetry owner holds it through its destructive transaction. Neither owner
 * waits behind the other: SQLITE_BUSY preserves data and the caller retries.
 * OS SQLite locks are released on process death; no stale leases to override.
 * Telemetry never opens the operational database with write access. */
export function acquireHistoryPolicyGate(sourceFile: string): () => void {
  if (!sourceFile || sourceFile === ":memory:") return () => {};
  const file = realpathSync(sourceFile) + ".history-policy-gate.sqlite";
  const gate = new Database(file, { timeout: 0 });
  try {
    chmodSync(file, 0o600);
    gate.exec("BEGIN IMMEDIATE");
  } catch (error) {
    gate.close();
    throw error;
  }
  return () => {
    try { gate.exec("ROLLBACK"); } finally { gate.close(); }
  };
}

export function withHistoryPolicyGate<T>(sourceFile: string | undefined, operation: () => T): T {
  const release = sourceFile ? acquireHistoryPolicyGate(sourceFile) : () => {};
  try { return operation(); } finally { release(); }
}
