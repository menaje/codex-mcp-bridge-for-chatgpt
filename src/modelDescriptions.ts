import type { CodexModelDescriptor } from "./modelCatalog.js";

export type ModelDescriptionOverrides = Record<string, string>;

export const MAX_MODEL_DESCRIPTION_LENGTH = 2_000;
export const MAX_MODEL_DESCRIPTION_OVERRIDES = 100;
export const MAX_MODEL_DESCRIPTION_OVERRIDES_BYTES = 64 * 1_024;

/** Only user-authored text is persisted. Catalog descriptions remain upstream data. */
export function normalizeModelDescriptionOverrides(value: unknown): ModelDescriptionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MODEL_DESCRIPTIONS_INVALID: Model descriptions must be keyed by model ID.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_MODEL_DESCRIPTION_OVERRIDES) {
    throw new Error(`MODEL_DESCRIPTIONS_LIMIT: At most ${MAX_MODEL_DESCRIPTION_OVERRIDES} model descriptions may be saved.`);
  }
  const normalized: Array<[string, string]> = [];
  for (const [id, raw] of entries) {
    if (!id || id !== id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id) || typeof raw !== "string") {
      throw new Error("MODEL_DESCRIPTIONS_INVALID: Each model ID must have a text description.");
    }
    const description = raw.trim();
    if (description.length > MAX_MODEL_DESCRIPTION_LENGTH) {
      throw new Error(`MODEL_DESCRIPTION_TOO_LONG: A model description may contain at most ${MAX_MODEL_DESCRIPTION_LENGTH} characters.`);
    }
    if (description) normalized.push([id, description]);
  }
  const result = Object.fromEntries(normalized.sort(([left], [right]) => left.localeCompare(right)));
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_MODEL_DESCRIPTION_OVERRIDES_BYTES) {
    throw new Error("MODEL_DESCRIPTIONS_LIMIT: Saved model descriptions exceed the total text limit.");
  }
  return result;
}

export function modelDescriptionProjection(
  model: Pick<CodexModelDescriptor, "id" | "description">,
  overrides: ModelDescriptionOverrides,
  automatic: boolean
): { description?: string; descriptionSource?: "user" } {
  const override = automatic && Object.prototype.hasOwnProperty.call(overrides, model.id)
    ? overrides[model.id]
    : undefined;
  if (override) return { description: override, descriptionSource: "user" };
  return model.description ? { description: model.description } : {};
}
