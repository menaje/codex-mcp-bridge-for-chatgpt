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
    token?: string;
    startedAt?: string;
    processAlive?: (pid: number) => boolean;
    platform?: NodeJS.Platform;
    uid?: number;
  }
): {
  directory: string;
  release(): void;
};

export function releaseStoppedRuntimeLock(lockDirectory: string, expectedOwner: { pid: number; token: string }, options?: { processAlive?: (pid: number) => boolean }): void;
