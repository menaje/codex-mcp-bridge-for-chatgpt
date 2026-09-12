/** The backend accepts both names for the user-facing Fast processing mode. */
export function usesFastProcessing(
  execution: { serviceTier?: unknown } | null | undefined
): boolean {
  return typeof execution?.serviceTier === "string" &&
    /^(priority|fast)$/i.test(execution.serviceTier.trim());
}
