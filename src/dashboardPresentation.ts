export const DASHBOARD_STATUS_FILTERS = [
  "all", "running", "response-required", "problems", "background"
] as const;

export type DashboardStatusFilter = (typeof DASHBOARD_STATUS_FILTERS)[number];

export function dashboardSummaryCategory(status: string): Exclude<DashboardStatusFilter, "all" | "background"> | null {
  if (status === "input-required" || status === "approval-required") return "response-required";
  if (["failed", "interrupted", "termination-failed", "liveness-unknown", "orphaned"].includes(status)) return "problems";
  return status === "running" ? "running" : null;
}
