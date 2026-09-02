export type RuntimeEnvStatus = {
  path: string;
  exists: boolean;
  valid: boolean;
  hasApiKey: boolean;
  hasTunnelId: boolean;
  tunnelId: string | null;
  issue: string | null;
};

export function defaultRuntimeEnvFile(options?: {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}): string;

export function inspectRuntimeEnvFile(filePath: string): RuntimeEnvStatus;

export function repairRuntimeEnvPermissions(filePath: string): RuntimeEnvStatus;

export function loadRuntimeEnvFile(
  filePath: string,
  options?: {
    required?: boolean;
    apply?: (filePath: string) => void;
    allowedKey?: (key: string) => boolean;
    platform?: NodeJS.Platform;
    uid?: number;
  }
): boolean;

export function readRuntimeEnvSubset(
  filePath: string,
  keys: string[],
  options?: {
    platform?: NodeJS.Platform;
    uid?: number;
    allowBroadReadOnlyPermissions?: boolean;
  }
): Record<string, string>;

export type PreparedRuntimeEnvUpdate = {
  readonly path: string;
  readonly directory: string;
  readonly existed: boolean;
  readonly original: string;
  readonly next: string;
  readonly changed: boolean;
  readonly tunnelIdChanged: boolean;
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
};

export function prepareRuntimeEnvUpdate(
  filePath: string,
  values: { apiKey?: string; tunnelId?: string }
): PreparedRuntimeEnvUpdate;

export function commitRuntimeEnvUpdate(
  prepared: PreparedRuntimeEnvUpdate
): RuntimeEnvStatus;

export function rollbackRuntimeEnvUpdate(
  prepared: PreparedRuntimeEnvUpdate
): RuntimeEnvStatus;

export function updateRuntimeEnvFile(
  filePath: string,
  values: { apiKey?: string; tunnelId?: string }
): RuntimeEnvStatus;
