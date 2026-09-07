/** With this native CLI feature enabled, app approvals use MCP elicitation
 * instead of sharing the native requestUserInput channel. Verify it against
 * the loaded thread before each turn; never infer it from a CLI version. */
export const MCP_APPROVAL_ROUTING_FEATURE = "tool_call_mcp_elicitation";

export function questionOrigin(
  routingVerified: boolean,
  associatedItem: "app-approval" | "unknown" | undefined,
  questionIds: string[]
): "codex-question" | "app-approval" | "unknown" {
  // Reject the legacy app approval namespace even if a CLI unexpectedly
  // emits it after reporting that the dedicated routing feature is enabled.
  if (associatedItem === "app-approval" || questionIds.some(id => id.startsWith("mcp_tool_call_approval"))) return "app-approval";
  if (!routingVerified || associatedItem !== undefined || questionIds.length === 0) return "unknown";
  return "codex-question";
}
