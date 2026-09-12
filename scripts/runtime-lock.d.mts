export type RuntimeLockOwner = {
  pid: number;
  token: string;
  startedAt: string;
};

export function defaultRuntimeLockDirectory(options?: {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}): string;

export function readRuntimeLockOwner(
  lockDirectory?: string,
  options?: {
    platform?: NodeJS.Platform;
    uid?: number;
  }
): RuntimeLockOwner | null;

export function acquireRuntimeLock(
  lockDirectory?: string,
  options?: {
    pid?: number;
    startedAt?: string;
    processAlive?: (pid: number) => boolean;
    platform?: NodeJS.Platform;
    uid?: number;
  }
): {
  directory: string;
  release(): void;
};
