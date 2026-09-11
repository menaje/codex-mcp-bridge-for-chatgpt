export const DASHBOARD_STATUS_FILTERS = [
  "all", "running", "response-required", "problems", "background"
] as const;

export type DashboardStatusFilter = (typeof DASHBOARD_STATUS_FILTERS)[number];

export function dashboardSummaryCategory(status: string): Exclude<DashboardStatusFilter, "all" | "background"> | null {
  if (status === "input-required" || status === "approval-required") return "response-required";
  if (["failed", "interrupted", "termination-failed", "liveness-unknown", "orphaned"].includes(status)) return "problems";
  return status === "running" ? "running" : null;
}

export function dashboardRowMatchesStatus(
  row: { status: string; backgroundProcessCount?: number },
  status: DashboardStatusFilter
): boolean {
  if (status === "all") return true;
  if (status === "background") return (row.backgroundProcessCount || 0) > 0;
  return dashboardSummaryCategory(row.status) === status;
}
