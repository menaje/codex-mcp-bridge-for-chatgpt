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

export function executionSpeedText(execution: { processingSpeed?: string; serviceTier?: string; serviceTierScope?: string; requestState?: string }, translations: Record<string, string>): string {
  if (!execution.requestState) return "";
  const mode = execution.processingSpeed || (execution.serviceTierScope === "turn" ? execution.serviceTier === "default" ? "standard" : execution.serviceTier || "inherit" : "legacy");
  const fast = usesFastProcessing(execution);
  const rawPersistentTier = mode === "legacy" && execution.serviceTierScope !== "turn" && !fast ? execution.serviceTier?.trim() : undefined;
  const key = rawPersistentTier ? "settings.processingSpeed.unknown" : processingSpeedLabelKey(mode, fast);
  const speed = (translations[key] || execution.serviceTier || mode).replace("{value}", rawPersistentTier || mode);
  return translations["dashboard.execution.speed"].replace("{speed}", speed).replace("{state}", translations[execution.requestState === "accepted" ? "dashboard.execution.accepted" : "dashboard.execution.pending"]);
}
