import { canonicalHumanText, searchKey } from "./textIntegrity.js";

export const AGENT_LIFECYCLES = [
  "idle",
  "active",
  "waiting-input",
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
  orphanedReason?: string;
};

/** One immutable entry in an Agent's backend-thread history. */
export type BridgeAgentThread = {
  threadId: string;
  sessionId?: string;
  agentId: string;
  scopeId: string;
  projectId?: string;
  projectName?: string;
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

// Kept byte-for-byte compatible for the v3-to-v4 state migration. New writes
// use canonicalAgentName so the current text-integrity policy does not silently
// change a released migration's provenance.
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

/** Current-write policy for a human-visible agent name. */
export function canonicalAgentName(value: string): {
  agentName: string;
  normalizedName: string;
} {
  let agentName: string;
  try {
    agentName = canonicalHumanText(value, {
      field: "Agent name",
      maxCharacters: 80,
      collapseWhitespace: true,
      trim: true
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeds")) {
      throw new Error("Agent name cannot exceed 80 characters.");
    }
    throw new Error("Agent name cannot be empty.");
  }
  return { agentName, normalizedName: searchKey(agentName, { field: "Agent name" }) };
}

export function isAgentLifecycle(value: unknown): value is BridgeAgentLifecycle {
  return AGENT_LIFECYCLES.includes(value as BridgeAgentLifecycle);
}

export function isAgentContextMode(value: unknown): value is AgentContextMode {
  return AGENT_CONTEXT_MODES.includes(value as AgentContextMode);
}
