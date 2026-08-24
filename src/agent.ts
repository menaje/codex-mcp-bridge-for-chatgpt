export const AGENT_LIFECYCLES = [
  "idle",
  "active",
  "waiting-input",
  "archived",
  "orphaned"
] as const;

export const AGENT_CONTEXT_MODES = ["continue", "fork", "fresh"] as const;

export type BridgeAgentLifecycle = (typeof AGENT_LIFECYCLES)[number];
export type AgentContextMode = (typeof AGENT_CONTEXT_MODES)[number];

/** A bridge-managed, scope-local Codex collaboration session. */
export type BridgeAgent = {
  agentId: string;
  scopeId: string;
  agentName: string;
  normalizedName: string;
  lifecycle: BridgeAgentLifecycle;
  currentThreadId?: string;
  currentJobId?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  orphanedReason?: string;
};

/** One immutable entry in an Agent's backend-thread history. */
export type BridgeAgentThread = {
  threadId: string;
  agentId: string;
  scopeId: string;
  projectId?: string;
  projectLabel?: string;
  backendKind: string;
  cwd: string;
  sandbox: string;
  contextMode: AgentContextMode;
  isCurrent: boolean;
  linkedAt: number;
  replacedAt?: number;
  forkedFromThreadId?: string;
};

/** Auditable many-to-many Activity ↔ Agent assignment history. */
export type ActivityAgentAssignment = {
  assignmentId: string;
  activityId: string;
  agentId: string;
  role: string;
  contextMode: AgentContextMode;
  assignedAt: number;
  releasedAt?: number;
};

export function normalizeAgentName(value: string): {
  agentName: string;
  normalizedName: string;
} {
  const agentName = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!agentName) throw new Error("Agent name cannot be empty.");
  if (agentName.length > 80) throw new Error("Agent name cannot exceed 80 characters.");
  return { agentName, normalizedName: agentName.toLowerCase() };
}

export function isAgentLifecycle(value: unknown): value is BridgeAgentLifecycle {
  return AGENT_LIFECYCLES.includes(value as BridgeAgentLifecycle);
}

export function isAgentContextMode(value: unknown): value is AgentContextMode {
  return AGENT_CONTEXT_MODES.includes(value as AgentContextMode);
}
