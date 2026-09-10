export type ManagedTunnelStatus = {
  phase: string;
  profile: string | null;
  transport: string | null;
  doctorPassed: boolean;
  processRunning: boolean;
  connected: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastProblem: StatusProblem | null;
};

export type StatusProblem = {
  code: string;
  arguments: Record<string, string>;
};

export type ManagedRuntimeStatus = {
  protocol: string;
  version: number;
  generatedAt: string;
  launcherPid: number;
  phase: string;
  runtimeBuildId: string;
  tunnel: ManagedTunnelStatus;
  stale: boolean;
};

export const MANAGED_RUNTIME_STATUS_PROTOCOL: string;
export const MANAGED_RUNTIME_STATUS_VERSION: number;
export const MAX_TUNNEL_CONTROL_PLANE_AGE_MS: number;
export function hasRecentTunnelControlPlanePoll(report: unknown, now?: number): boolean;

export function readManagedRuntimeStatus(
  filePath: string,
  options?: { maximumAgeMs?: number }
): ManagedRuntimeStatus | null;

export function writeManagedRuntimeStatus(
  filePath: string,
  status: Record<string, unknown>
): void;
