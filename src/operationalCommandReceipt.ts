export const OPERATIONAL_COMMAND_RECEIPT_RESULT_MAX_BYTES = 64 * 1024;

/**
 * Durable proof that one logical state mutation committed. The receipt lives
 * in the same transaction as the mutation so a lost IPC response can be
 * resolved by retrying the same command ID and payload hash.
 */
export const V25_OPERATIONAL_COMMAND_RECEIPT_MIGRATION_SCHEMA = `
  CREATE TABLE operational_command_receipts (
    command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
    operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 80),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
    aggregate_key TEXT CHECK(
      aggregate_key IS NULL OR length(aggregate_key) BETWEEN 1 AND 512
    ),
    resulting_version INTEGER CHECK(
      resulting_version IS NULL OR resulting_version >= 0
    ),
    result TEXT NOT NULL CHECK(
      json_valid(result) AND
      json_type(result) = 'object' AND
      length(CAST(result AS BLOB)) <= ${OPERATIONAL_COMMAND_RECEIPT_RESULT_MAX_BYTES}
    ),
    worker_generation TEXT NOT NULL CHECK(length(worker_generation) = 36),
    committed_at INTEGER NOT NULL CHECK(committed_at >= 0)
  ) STRICT;
  CREATE INDEX operational_command_receipts_committed
    ON operational_command_receipts(committed_at, command_id);
`;

export type OperationalCommandReceiptInput = {
  commandId: string;
  operation: string;
  payloadSha256: string;
  aggregateKey?: string;
  workerGeneration: string;
  committedAt?: number;
};

export type OperationalCommandApplication<T> = {
  result: T;
  resultingVersion?: number;
};

export type OperationalCommandReceipt<T = unknown> = {
  commandId: string;
  operation: string;
  payloadSha256: string;
  aggregateKey?: string;
  resultingVersion?: number;
  result: T;
  workerGeneration: string;
  committedAt: number;
};

export type OperationalCommandExecution<T> = {
  receipt: OperationalCommandReceipt<T>;
  replayed: boolean;
};
