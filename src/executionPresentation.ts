/** The backend accepts both names for the user-facing Fast processing mode. */
export function usesFastProcessing(
  execution: { serviceTier?: unknown } | null | undefined
): boolean {
  return typeof execution?.serviceTier === "string" &&
    /^(priority|fast)$/i.test(execution.serviceTier.trim());
}

export function processingSpeedLabelKey(mode: string, legacyFast = false): string {
  return mode === "legacy" ? "settings.processingSpeed." + (legacyFast ? "legacyFast" : "legacyClear") :
    ["inherit", "standard", "fast", "ultrafast"].includes(mode) ? "settings.processingSpeed." + mode : "settings.processingSpeed.unknown";
}

/** Labels the recorded selection, never a server-confirmed processing grade. */
export function executionSpeedBadge(execution: { processingSpeed?: string; serviceTier?: string } | null | undefined): string {
  if (!execution) return "";
  const mode = execution.processingSpeed?.trim().toLowerCase();
  if (mode && !["legacy", "fast", "ultrafast"].includes(mode)) return "";
  const tier = execution.serviceTier?.trim().toLowerCase();
  if (tier === "ultrafast" || mode === "ultrafast") return "🚀 Ultrafast";
  if (tier === "fast" || tier === "priority" || mode === "fast") return "⚡ Fast";
  return "";
}
