import type { CodexModelDescriptor } from "./modelCatalog.js";
import {
  TextIntegrityError,
  canonicalHumanText,
  opaqueIdentifier,
  utf8ByteLength
} from "./textIntegrity.js";

export type ModelDescriptionOverrides = Record<string, string>;
export type ModelDescriptionVersion = {
  version: number;
  description: string | null;
  /** Unknown for the current value imported from pre-history settings. */
  createdAt: string | null;
};
export type ModelDescriptionHistoryPage = {
  kind: "model-description-history";
  modelId: string;
  versions: ModelDescriptionVersion[];
  nextBeforeVersion: number | null;
};

export const MAX_MODEL_DESCRIPTION_LENGTH = 2_000;
export const MAX_MODEL_DESCRIPTION_OVERRIDES = 100;
export const MAX_MODEL_DESCRIPTION_OVERRIDES_BYTES = 64 * 1_024;

export function modelDescriptionId(id: string): string {
  try {
    const modelId = opaqueIdentifier(id, {
      field: "Model ID", maxCharacters: 200,
      rejectControlCharacters: true, rejectNul: true
    });
    if (!modelId || modelId !== modelId.trim()) throw new Error("invalid model id");
    return modelId;
  } catch {
    throw new Error("MODEL_DESCRIPTIONS_INVALID: Invalid model ID.");
  }
}

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
    // A catalog model ID is protocol-owned and opaque; do not NFC it.
    const modelId = modelDescriptionId(id);
    let description: string;
    try {
      description = canonicalHumanText(raw, {
        field: "Model description",
        allowEmpty: true,
        maxCharacters: MAX_MODEL_DESCRIPTION_LENGTH,
        trim: true,
        // Multi-line model guidance is a display field, not a compact label.
        // NUL remains forbidden while line breaks are intentionally retained.
        rejectControlCharacters: false
      });
    } catch (error) {
      if (error instanceof TextIntegrityError && error.code === "TEXT_TOO_LONG") {
        throw new Error(`MODEL_DESCRIPTION_TOO_LONG: A model description may contain at most ${MAX_MODEL_DESCRIPTION_LENGTH} characters.`);
      }
      throw new Error("MODEL_DESCRIPTIONS_INVALID: Each model ID must have a text description.");
    }
    if (description) normalized.push([modelId, description]);
  }
  const result = Object.fromEntries(normalized.sort(([left], [right]) => left.localeCompare(right)));
  if (utf8ByteLength(JSON.stringify(result), "Model description overrides") > MAX_MODEL_DESCRIPTION_OVERRIDES_BYTES) {
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
