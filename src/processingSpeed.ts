import type { BackendCapabilities, ModelSelection } from "./modelPolicy.js";
import type { CodexModelCatalogSnapshot } from "./modelCatalog.js";

export const PROCESSING_SPEED_MODES = ["legacy", "inherit", "standard", "fast", "ultrafast"] as const;
export type ProcessingSpeedMode = typeof PROCESSING_SPEED_MODES[number];
export type RetainedServiceTier = { path: string; selection: Record<string, unknown> };

export const ULTRAFAST_ACCESS_UNVERIFIED = "PROCESSING_SPEED_ACCESS_UNVERIFIED: Ultrafast account and workspace access cannot be verified by the selected CLI. The saved choice is preserved; choose another speed before starting new work.";

/** Current public account/read contracts expose plan names, not Ultrafast entitlement,
 * per-user workspace permission or inference residency. Catalogs do not supply that proof. */
export function requireProcessingSpeedAccess(mode: string): void {
  if (mode === "ultrafast") throw new Error(ULTRAFAST_ACCESS_UNVERIFIED);
}

export function isProcessingSpeedMode(value: unknown): value is ProcessingSpeedMode {
  return typeof value === "string" && PROCESSING_SPEED_MODES.includes(value as ProcessingSpeedMode);
}

/** Internal adapter arguments carry scope; only wireSpeedArguments emits protocol fields. */
export function selectionSpeedArguments(selection: ModelSelection): Record<string, unknown> {
  return {
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
    ...(selection.serviceTierScope ? { serviceTierScope: selection.serviceTierScope } : {})
  };
}

export function wireSpeedArguments(args: Record<string, unknown>, phase: "thread" | "turn"): Record<string, unknown> {
  const tier = typeof args.serviceTier === "string" && args.serviceTier.trim() ? args.serviceTier.trim() : null;
  if (args.serviceTierScope === "turn") return phase === "turn" ? { serviceTierForTurn: tier } : {};
  return { serviceTier: tier };
}

export function speedTierForModel(catalog: CodexModelCatalogSnapshot, modelId: string, mode: "fast" | "ultrafast", legacy = false): string | undefined {
  const model = catalog.models.find(entry => entry.id === modelId && !entry.hidden);
  if (!model) return undefined;
  const ids = [model.defaultServiceTier, ...model.serviceTiers.map(tier => tier.id)].filter((id): id is string => Boolean(id));
  const names = mode === "ultrafast" ? ["ultrafast"] : legacy ? ["priority", "fast"] : ["fast", "priority"];
  return names.flatMap(name => ids.filter(id => id.toLowerCase() === name))[0];
}

export function resolveTurnSpeed(selection: ModelSelection, mode: string, catalog: CodexModelCatalogSnapshot, capabilities: BackendCapabilities): ModelSelection {
  if (!isProcessingSpeedMode(mode) || mode === "legacy") throw new Error(`PROCESSING_SPEED_UNRECOGNIZED: Saved speed '${mode}' is preserved. Choose a supported speed before starting new work.`);
  if (capabilities.supportsPerTurnServiceTier !== true) throw new Error("PROCESSING_SPEED_UNSUPPORTED: The selected CLI has not verified per-turn speed support. Choose a compatible CLI or retain the existing speed behavior.");
  const tier = mode === "inherit" ? undefined : mode === "standard" ? "default" : speedTierForModel(catalog, selection.model, mode);
  if ((mode === "fast" || mode === "ultrafast") && !tier) throw new Error(`PROCESSING_SPEED_UNAVAILABLE: ${mode} is not advertised for model ${selection.model}. The selection was not replaced.`);
  if (tier && !capabilities.supportedPerTurnServiceTiers?.includes(tier)) throw new Error(`PROCESSING_SPEED_UNSUPPORTED: The selected CLI has not verified per-turn tier '${tier}'. No turn was started.`);
  return { model: selection.model, reasoningEffort: selection.reasoningEffort, serviceTierScope: "turn", ...(tier ? { serviceTier: tier } : {}) };
}

/** Preserve surviving raw tier records before the retired policy transformation removes them. */
export function retainedPolicyServiceTiers(policy: unknown): RetainedServiceTier[] {
  if (!policy || typeof policy !== "object") return [];
  const value = policy as Record<string, unknown>;
  const records: RetainedServiceTier[] = [];
  const keep = (selection: unknown, path: string) => {
    if (selection && typeof selection === "object" && Object.hasOwn(selection, "serviceTier")) records.push({ path, selection: structuredClone(selection as Record<string, unknown>) });
  };
  keep(value.selection, "modelPolicy.selection");
  keep(value.fallbackSelection, "modelPolicy.fallbackSelection");
  keep(value.preferredSelection, "modelPolicy.preferredSelection");
  const allowed = value.allowedSelections as { selections?: unknown[] } | undefined;
  if (Array.isArray(allowed?.selections)) allowed.selections.forEach((entry, index) => keep(entry, `modelPolicy.allowedSelections.selections[${index}]`));
  return records;
}

export function migratedProcessingSpeed(value: Record<string, unknown>, retained: RetainedServiceTier[]): string {
  if (typeof value.processingSpeed === "string" && value.processingSpeed.length > 0) return value.processingSpeed;
  return retained.some(({ selection }) => selection.serviceTier !== null && (typeof selection.serviceTier !== "string" || !["default", "standard", "priority", "fast"].includes(selection.serviceTier.toLowerCase())))
    ? "unrecognized-legacy-tier" : "legacy";
}
