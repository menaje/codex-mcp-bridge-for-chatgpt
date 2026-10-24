/** Guidance shared with the originating host; this grants no delegated access. */
export const BRIDGE_DELEGATION_GUIDANCE =
  "Before delegating recovery or acceptance checks, read the exact prior Job result and execution evidence in the originating conversation and include the necessary reviewed facts in the task prompt. " +
  "A nested Codex execution has its own authenticated conversation scope. Copied Activity, Agent, Job or scope identifiers do not grant it access to the originating conversation. " +
  "HANDLE_UNAVAILABLE or an empty nested overview does not establish that the originating work is missing or unowned. Resolve those handles in the originating conversation; do not delegate repeated parent-handle lookups. " +
  "Bridge admission, upstream turn completion, OS process ownership and product acceptance are separate facts.";

/** Only the admitted binding is copied, never scope credentials or prior output. */
export function bridgeExecutionContext(binding: {
  jobId: string;
  requestId: string;
  activityId: string;
  agentId?: string;
  contextMode?: string;
}): string {
  return [
    "Bridge execution admission (bridge-generated metadata):",
    JSON.stringify({
      jobId: binding.jobId,
      requestId: binding.requestId,
      activityId: binding.activityId,
      ...(binding.agentId ? { agentId: binding.agentId } : {}),
      ...(binding.contextMode ? { contextMode: binding.contextMode } : {})
    }),
    "The bridge admitted this Job in the originating host conversation. This binding identifies the current execution; it is not proof of a previous process's ownership, turn acceptance, task success or product acceptance and grants no additional permissions.",
    "Nested Bridge MCP calls use this Codex conversation's own authenticated scope. Copying the binding or a parent scopeId cannot authorize parent Activity, Agent or Job reads. HANDLE_UNAVAILABLE or an empty nested codex_status overview does not invalidate this admission or prove that parent work is absent.",
    "Use reviewed parent facts supplied in the task prompt. If exact parent state or results are still required, report the missing facts to the originating host so it can read its own handles; do not repeat unavailable parent-handle queries or start duplicate work. Continue to check any required local process, lock, source and test evidence. A completed turn does not turn HOLD or failed acceptance into PASS."
  ].join("\n");
}
