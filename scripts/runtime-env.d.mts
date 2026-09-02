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

export function updateRuntimeEnvFile(
  filePath: string,
  values: { apiKey?: string; tunnelId?: string }
): RuntimeEnvStatus;
