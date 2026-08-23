import type { CodexBackendKind } from "./config.js";
import type {
  CodexModelCatalogSnapshot,
  CodexModelDescriptor
} from "./modelCatalog.js";

export const MODEL_POLICY_SCHEMA_VERSION = 2 as const;

export type ModelSelection = {
  model: string;
  reasoningEffort: string;
  serviceTier?: string;
};

export type ModelPolicyConstraints = {
  allowDelegation: boolean;
};

export type AllowedSelections =
  | {
      kind: "explicit";
      selections: ModelSelection[];
    }
  | {
      kind: "catalog-visible";
    };

export type ModelPolicy =
  | {
      mode: "fixed";
      selection: ModelSelection;
      constraints: ModelPolicyConstraints;
    }
  | {
      mode: "automatic";
      preferredSelection?: ModelSelection;
      allowedSelections: AllowedSelections;
      constraints: ModelPolicyConstraints;
    };

export type BackendCapabilities = {
  selectionScope: "thread" | "turn";
  supportsModelOverrideOnContinue: boolean;
  supportsEffortOverrideOnContinue: boolean;
  supportsServiceTierOverrideOnContinue: boolean;
  supportsFork: boolean;
};

export type CatalogValidationState =
  | "valid"
  | "temporarily-unverified-with-last-known-good"
  | "invalid";

export type ExecutionDecisionSource =
  | "fixed"
  | "preferred"
  | "caller"
  | "backend-default"
  | "compatibility-fallback";

export type ExecutionDecision = {
  policyRevision: number;
  catalogFingerprint: string;
  catalogValidation: CatalogValidationState;
  backendKind: CodexBackendKind;
  requestedSelection?: ModelSelection;
  effectiveSelection: ModelSelection;
  effectiveReasoningEffort: string;
  savedSelectionSupported: boolean;
  preferenceWarning?: string;
  source: ExecutionDecisionSource;
  appliedAt: "thread-start" | "turn-start";
  reason: string;
};

export type ModelPolicyErrorCode =
  | "MODEL_SELECTION_FORBIDDEN"
  | "MODEL_POLICY_CHANGED"
  | "MODEL_UNAVAILABLE"
  | "THREAD_OVERRIDE_UNSUPPORTED";

export class ModelPolicyError extends Error {
  readonly name = "ModelPolicyError";

  constructor(
    readonly code: ModelPolicyErrorCode,
    message: string,
    readonly policyRevision: number,
    readonly nextActions: string[]
  ) {
    super(`${code}: ${message} (policy revision ${policyRevision})`);
  }
}

export type ResolveModelPolicyInput = {
  policyRevision: number;
  policy: ModelPolicy;
  /** Migration-only model preference from legacy settings that omitted effort. */
  legacyPreferredModel?: string;
  catalog: CodexModelCatalogSnapshot;
  operatorCeiling?: ModelSelection[];
  backendKind: CodexBackendKind;
  backendCapabilities: BackendCapabilities;
  operation: "start" | "continue";
  requestedSelection?: ModelSelection;
  requestedPolicyRevision?: number;
  currentSelection?: ModelSelection;
};

export function automaticModelPolicy(
  preferredSelection?: ModelSelection
): ModelPolicy {
  return {
    mode: "automatic",
    ...(preferredSelection ? { preferredSelection: cloneSelection(preferredSelection) } : {}),
    allowedSelections: { kind: "catalog-visible" },
    constraints: { allowDelegation: true }
  };
}

export function validateModelPolicy(value: unknown): ModelPolicy {
  if (!isRecord(value)) throw new Error("Invalid model policy.");
  const constraints = readConstraints(value.constraints);
  if (value.mode === "fixed") {
    const selection = readSelection(value.selection, "fixed model selection");
    if (!constraints.allowDelegation && selection.reasoningEffort === "ultra") {
      throw new Error("Ultra reasoning requires model-policy delegation to be enabled.");
    }
    return { mode: "fixed", selection, constraints };
  }
  if (value.mode !== "automatic" || !isRecord(value.allowedSelections)) {
    throw new Error("Invalid model policy mode.");
  }
  const allowed = value.allowedSelections;
  let allowedSelections: AllowedSelections;
  if (allowed.kind === "catalog-visible") {
    allowedSelections = { kind: "catalog-visible" };
  } else if (allowed.kind === "explicit" && Array.isArray(allowed.selections)) {
    const selections = allowed.selections.map((selection, index) =>
      readSelection(selection, `allowed model selection ${index + 1}`)
    );
    if (selections.length === 0) throw new Error("An explicit model allowlist cannot be empty.");
    if (selections.length > 500) throw new Error("An explicit model allowlist cannot exceed 500 selections.");
    const unique = new Set(selections.map(modelSelectionKey));
    if (unique.size !== selections.length) throw new Error("Explicit model selections must be unique.");
    if (!constraints.allowDelegation && selections.some((entry) => entry.reasoningEffort === "ultra")) {
      throw new Error("Ultra reasoning cannot be allowed while delegation is disabled.");
    }
    allowedSelections = { kind: "explicit", selections };
  } else {
    throw new Error("Invalid allowed model selections.");
  }
  const preferredSelection = value.preferredSelection === undefined
    ? undefined
    : readSelection(value.preferredSelection, "preferred model selection");
  if (
    preferredSelection &&
    allowedSelections.kind === "explicit" &&
    !allowedSelections.selections.some((entry) => sameModelSelection(entry, preferredSelection))
  ) {
    throw new Error("The preferred model selection must be included in the explicit allowlist.");
  }
  if (!constraints.allowDelegation && preferredSelection?.reasoningEffort === "ultra") {
    throw new Error("Ultra reasoning cannot be preferred while delegation is disabled.");
  }
  return {
    mode: "automatic",
    ...(preferredSelection ? { preferredSelection } : {}),
    allowedSelections,
    constraints
  };
}

export function validateModelSelection(value: unknown, label = "model selection"): ModelSelection {
  return readSelection(value, label);
}

export function validatePolicyAgainstCatalog(
  policy: ModelPolicy,
  catalog: CodexModelCatalogSnapshot,
  operatorCeiling: ModelSelection[] | undefined,
  policyRevision: number
): void {
  const normalized = validateModelPolicy(policy);
  if (normalized.mode === "fixed") {
    assertSelectionAllowed(normalized.selection, normalized, catalog, operatorCeiling, policyRevision);
    return;
  }
  const allowed = listAllowedModelSelections(normalized, catalog, operatorCeiling);
  if (allowed.length > 0) return;

  const catalogAllowed = listAllowedModelSelections(normalized, catalog);
  if (operatorCeiling && catalogAllowed.length > 0) {
    throw forbidden(
      policyRevision,
      "The model policy has no current catalog selection inside the operator model ceiling."
    );
  }
  throw unavailable(
    policyRevision,
    "The model policy and current backend catalog have no usable selection."
  );
}

export function resolveModelPolicy(input: ResolveModelPolicyInput): ExecutionDecision {
  const policy = validateModelPolicy(input.policy);
  if (
    input.requestedPolicyRevision !== undefined &&
    input.requestedPolicyRevision !== input.policyRevision
  ) {
    throw new ModelPolicyError(
      "MODEL_POLICY_CHANGED",
      `The request used policy revision ${input.requestedPolicyRevision}, but revision ${input.policyRevision} is active.`,
      input.policyRevision,
      ["Refresh the Codex tool descriptor or settings view and retry with the current revision."]
    );
  }

  let effectiveSelection: ModelSelection;
  let source: ExecutionDecisionSource;
  let preferredFallback = false;
  let savedSelectionSupported = true;
  let preferenceWarning: string | undefined;
  const preferredSelection = policy.mode === "automatic"
    ? policy.preferredSelection
    : undefined;
  const legacyPreferredModel = input.legacyPreferredModel === undefined
    ? undefined
    : identifier(input.legacyPreferredModel, "legacy preferred model", 200);
  const legacyPreferredSelection =
    policy.mode === "automatic" && !preferredSelection && legacyPreferredModel
      ? catalogDefaultSelection(
          input.catalog,
          policy,
          input.operatorCeiling,
          legacyPreferredModel
        )
      : undefined;
  if (policy.mode === "fixed") {
    if (input.requestedSelection) {
      throw new ModelPolicyError(
        "MODEL_SELECTION_FORBIDDEN",
        "This bridge is in fixed model mode and does not accept a per-call model selection.",
        input.policyRevision,
        ["Omit selection and retry; the saved fixed selection will be applied."]
      );
    }
    if (catalogSupportsSelection(input.catalog, policy.selection)) {
      effectiveSelection = cloneSelection(policy.selection);
      source = "fixed";
    } else {
      const fallback = savedSelectionFallback(
        policy.selection,
        input.catalog,
        input.operatorCeiling,
        policy.constraints.allowDelegation
      );
      if (!fallback) {
        throw unavailable(
          input.policyRevision,
          `Saved fixed selection ${selectionLabel(policy.selection)} is no longer available and no compatible upstream default exists.`
        );
      }
      effectiveSelection = fallback;
      source = "compatibility-fallback";
      savedSelectionSupported = false;
      preferenceWarning =
        `Saved selection ${selectionLabel(policy.selection)} is unsupported by the current catalog. ` +
        `This turn uses ${selectionLabel(fallback)} without rewriting the saved preference.`;
    }
  } else if (input.requestedSelection) {
    effectiveSelection = readSelection(input.requestedSelection, "requested model selection");
    source = "caller";
  } else if (
    preferredSelection &&
    listAllowedModelSelections(policy, input.catalog, input.operatorCeiling)
      .some((selection) => sameModelSelection(selection, preferredSelection))
  ) {
    effectiveSelection = cloneSelection(preferredSelection);
    source = "preferred";
  } else if (legacyPreferredSelection) {
    effectiveSelection = legacyPreferredSelection;
    source = "preferred";
  } else {
    preferredFallback = Boolean(preferredSelection || legacyPreferredModel);
    const backendDefault = catalogDefaultSelection(input.catalog, policy, input.operatorCeiling);
    if (!backendDefault) {
      throw unavailable(
        input.policyRevision,
        "The backend catalog does not expose a usable default model and reasoning effort."
      );
    }
    effectiveSelection = backendDefault;
    source = "backend-default";
    if (preferredFallback) {
      savedSelectionSupported = false;
      const savedLabel = preferredSelection
        ? selectionLabel(preferredSelection)
        : String(legacyPreferredModel);
      preferenceWarning =
        `Saved preferred selection ${savedLabel} is unsupported by the current catalog. ` +
        `This turn uses ${selectionLabel(backendDefault)} without rewriting the saved preference.`;
    }
  }

  if (source === "compatibility-fallback") {
    assertFallbackAllowed(
      effectiveSelection,
      policy.constraints.allowDelegation,
      input.catalog,
      input.operatorCeiling,
      input.policyRevision
    );
  } else {
    assertSelectionAllowed(
      effectiveSelection,
      policy,
      input.catalog,
      input.operatorCeiling,
      input.policyRevision
    );
  }

  if (
    input.operation === "continue" &&
    selectionChanged(input.currentSelection, effectiveSelection)
  ) {
    const capabilities = input.backendCapabilities;
    const supported =
      capabilities.supportsModelOverrideOnContinue &&
      capabilities.supportsEffortOverrideOnContinue &&
      (!effectiveSelection.serviceTier || capabilities.supportsServiceTierOverrideOnContinue);
    if (!supported) {
      throw new ModelPolicyError(
        "THREAD_OVERRIDE_UNSUPPORTED",
        `Backend ${input.backendKind} cannot apply the selected model configuration to the continued thread.`,
        input.policyRevision,
        ["Start explicit fresh context with contextMode='fresh'.", "Use the App Server backend for turn-level selection changes."]
      );
    }
  }

  const turnOverride =
    input.operation === "continue" &&
    input.backendCapabilities.supportsModelOverrideOnContinue &&
    input.backendCapabilities.supportsEffortOverrideOnContinue;
  const catalogValidation: CatalogValidationState = input.catalog.stale
    ? "temporarily-unverified-with-last-known-good"
    : "valid";
  return {
    policyRevision: input.policyRevision,
    catalogFingerprint: input.catalog.fingerprint,
    catalogValidation,
    backendKind: input.backendKind,
    ...(input.requestedSelection
      ? { requestedSelection: cloneSelection(input.requestedSelection) }
      : {}),
    effectiveSelection,
    effectiveReasoningEffort: effectiveSelection.reasoningEffort,
    savedSelectionSupported,
    ...(preferenceWarning ? { preferenceWarning } : {}),
    source,
    appliedAt: turnOverride ? "turn-start" : "thread-start",
    reason: `${decisionReason(source, input.operation, input.backendKind, catalogValidation)}${preferredFallback
      ? " The saved preferred selection was outside the current allowed catalog intersection."
      : ""}`
  };
}

function savedSelectionFallback(
  saved: ModelSelection,
  catalog: CodexModelCatalogSnapshot,
  operatorCeiling: ModelSelection[] | undefined,
  allowDelegation: boolean
): ModelSelection | undefined {
  const model = catalog.models.find((entry) => entry.id === saved.model && !entry.hidden);
  const orderedModels = model
    ? [model]
    : [
        ...catalog.models.filter((entry) => !entry.hidden && entry.isDefault),
        ...catalog.models.filter((entry) => !entry.hidden && !entry.isDefault)
      ];
  for (const candidateModel of orderedModels) {
    const efforts = [
      candidateModel.defaultReasoningEffort,
      ...candidateModel.supportedReasoningEfforts.map((entry) => entry.effort)
    ].filter((value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index && (allowDelegation || value !== "ultra")
    );
    const tiers = [
      candidateModel.serviceTiers.some((tier) => tier.id === saved.serviceTier)
        ? saved.serviceTier
        : undefined,
      candidateModel.defaultServiceTier,
      undefined,
      ...candidateModel.serviceTiers.map((tier) => tier.id)
    ].filter((value, index, values) => values.indexOf(value) === index);
    for (const reasoningEffort of efforts) {
      for (const serviceTier of tiers) {
        const selection: ModelSelection = {
          model: candidateModel.id,
          reasoningEffort,
          ...(serviceTier ? { serviceTier } : {})
        };
        if (
          catalogSupportsSelection(catalog, selection) &&
          (!operatorCeiling || operatorCeiling.some((entry) => sameModelSelection(entry, selection)))
        ) return selection;
      }
    }
  }
  return undefined;
}

function assertFallbackAllowed(
  selection: ModelSelection,
  allowDelegation: boolean,
  catalog: CodexModelCatalogSnapshot,
  operatorCeiling: ModelSelection[] | undefined,
  policyRevision: number
): void {
  if (!catalogSupportsSelection(catalog, selection)) {
    throw unavailable(policyRevision, `Fallback selection ${selectionLabel(selection)} is unavailable.`);
  }
  if (!allowDelegation && selection.reasoningEffort === "ultra") {
    throw forbidden(policyRevision, "Ultra reasoning is disabled by the active model policy.");
  }
  if (operatorCeiling && !operatorCeiling.some((entry) => sameModelSelection(entry, selection))) {
    throw forbidden(policyRevision, `Fallback selection ${selectionLabel(selection)} exceeds the operator ceiling.`);
  }
}

export function listAllowedModelSelections(
  policy: ModelPolicy,
  catalog: CodexModelCatalogSnapshot,
  operatorCeiling?: ModelSelection[]
): ModelSelection[] {
  const normalized = validateModelPolicy(policy);
  const candidates = normalized.mode === "fixed"
    ? [normalized.selection]
    : normalized.allowedSelections.kind === "explicit"
      ? normalized.allowedSelections.selections
      : catalogSelections(catalog.models);
  const ceiling = operatorCeiling?.map((selection) => readSelection(selection, "operator model ceiling"));
  return deduplicateSelections(candidates).filter((selection) =>
    catalogSupportsSelection(catalog, selection) &&
    (normalized.constraints.allowDelegation || selection.reasoningEffort !== "ultra") &&
    (!ceiling || ceiling.some((entry) => sameModelSelection(entry, selection)))
  );
}

export function catalogSupportsSelection(
  catalog: CodexModelCatalogSnapshot,
  selection: ModelSelection
): boolean {
  const model = catalog.models.find((entry) => entry.id === selection.model);
  if (!model || model.hidden) return false;
  if (!model.supportedReasoningEfforts.some((entry) => entry.effort === selection.reasoningEffort)) {
    return false;
  }
  return !selection.serviceTier || model.serviceTiers.some((entry) => entry.id === selection.serviceTier);
}

export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined
): boolean {
  if (!left || !right) return left === right;
  return modelSelectionKey(left) === modelSelectionKey(right);
}

export function sameModelPolicy(left: ModelPolicy, right: ModelPolicy): boolean {
  return modelPolicyKey(validateModelPolicy(left)) === modelPolicyKey(validateModelPolicy(right));
}

export function modelSelectionKey(selection: ModelSelection): string {
  return JSON.stringify([
    selection.model,
    selection.reasoningEffort,
    selection.serviceTier || null
  ]);
}

function assertSelectionAllowed(
  selection: ModelSelection,
  policy: ModelPolicy,
  catalog: CodexModelCatalogSnapshot,
  operatorCeiling: ModelSelection[] | undefined,
  policyRevision: number
): void {
  if (!catalogSupportsSelection(catalog, selection)) {
    throw unavailable(
      policyRevision,
      `Selection ${selectionLabel(selection)} is not available in catalog ${catalog.fingerprint}.`
    );
  }
  if (!policy.constraints.allowDelegation && selection.reasoningEffort === "ultra") {
    throw forbidden(policyRevision, "Ultra reasoning is disabled by the active model policy.");
  }
  if (
    operatorCeiling &&
    !operatorCeiling.some((entry) => sameModelSelection(entry, selection))
  ) {
    throw forbidden(policyRevision, `Selection ${selectionLabel(selection)} exceeds the operator model ceiling.`);
  }
  if (policy.mode === "fixed" && !sameModelSelection(policy.selection, selection)) {
    throw forbidden(policyRevision, "The selected model configuration differs from the fixed policy.");
  }
  if (
    policy.mode === "automatic" &&
    policy.allowedSelections.kind === "explicit" &&
    !policy.allowedSelections.selections.some((entry) => sameModelSelection(entry, selection))
  ) {
    throw forbidden(policyRevision, `Selection ${selectionLabel(selection)} is not in the user allowlist.`);
  }
}

function catalogDefaultSelection(
  catalog: CodexModelCatalogSnapshot,
  policy: ModelPolicy,
  operatorCeiling?: ModelSelection[],
  preferredModel?: string
): ModelSelection | undefined {
  const allowedKeys = new Set(
    listAllowedModelSelections(policy, catalog, operatorCeiling).map(modelSelectionKey)
  );
  const ordered = [
    ...catalog.models.filter((model) => !model.hidden && model.isDefault),
    ...catalog.models.filter((model) => !model.hidden && !model.isDefault)
  ].filter((model) => !preferredModel || model.id === preferredModel);
  for (const model of ordered) {
    const efforts = [
      model.defaultReasoningEffort,
      ...model.supportedReasoningEfforts.map((entry) => entry.effort)
    ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
    const serviceTiers = [
      model.defaultServiceTier,
      undefined,
      ...model.serviceTiers.map((tier) => tier.id)
    ].filter((value, index, values) => values.indexOf(value) === index);
    for (const reasoningEffort of efforts) {
      for (const serviceTier of serviceTiers) {
        const selection: ModelSelection = {
          model: model.id,
          reasoningEffort,
          ...(serviceTier ? { serviceTier } : {})
        };
        if (allowedKeys.has(modelSelectionKey(selection))) return selection;
      }
    }
  }
  return undefined;
}

function modelPolicyKey(policy: ModelPolicy): string {
  if (policy.mode === "fixed") {
    return JSON.stringify([
      "fixed",
      modelSelectionKey(policy.selection),
      policy.constraints.allowDelegation
    ]);
  }
  return JSON.stringify([
    "automatic",
    policy.preferredSelection ? modelSelectionKey(policy.preferredSelection) : null,
    policy.allowedSelections.kind,
    policy.allowedSelections.kind === "explicit"
      ? policy.allowedSelections.selections.map(modelSelectionKey).sort()
      : null,
    policy.constraints.allowDelegation
  ]);
}

function catalogSelections(models: CodexModelDescriptor[]): ModelSelection[] {
  return models.flatMap((model) =>
    model.supportedReasoningEfforts.flatMap(({ effort }) => [
      { model: model.id, reasoningEffort: effort },
      ...model.serviceTiers.map((tier) => ({
        model: model.id,
        reasoningEffort: effort,
        serviceTier: tier.id
      }))
    ])
  );
}

function selectionChanged(
  currentSelection: ModelSelection | undefined,
  nextSelection: ModelSelection
): boolean {
  return !sameModelSelection(currentSelection, nextSelection);
}

function readConstraints(value: unknown): ModelPolicyConstraints {
  if (value === undefined) return { allowDelegation: true };
  if (!isRecord(value) || typeof value.allowDelegation !== "boolean") {
    throw new Error("Invalid model policy constraints.");
  }
  return { allowDelegation: value.allowDelegation };
}

function readSelection(value: unknown, label: string): ModelSelection {
  if (!isRecord(value)) throw new Error(`Invalid ${label}.`);
  const model = identifier(value.model, `${label} model`, 200);
  const reasoningEffort = identifier(value.reasoningEffort, `${label} reasoning effort`, 100);
  const serviceTier = value.serviceTier === undefined
    ? undefined
    : identifier(value.serviceTier, `${label} service tier`, 100);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "model" && key !== "reasoningEffort" && key !== "serviceTier")) {
    throw new Error(`Invalid ${label}: unknown fields are not allowed.`);
  }
  return { model, reasoningEffort, ...(serviceTier ? { serviceTier } : {}) };
}

function identifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function deduplicateSelections(selections: ModelSelection[]): ModelSelection[] {
  const seen = new Set<string>();
  return selections.flatMap((selection) => {
    const normalized = readSelection(selection, "model selection");
    const key = modelSelectionKey(normalized);
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

function cloneSelection(selection: ModelSelection): ModelSelection {
  return {
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {})
  };
}

function unavailable(policyRevision: number, message: string): ModelPolicyError {
  return new ModelPolicyError(
    "MODEL_UNAVAILABLE",
    message,
    policyRevision,
    ["Refresh the model catalog and settings.", "Choose an exact selection allowed by both operator and user policy."]
  );
}

function forbidden(policyRevision: number, message: string): ModelPolicyError {
  return new ModelPolicyError(
    "MODEL_SELECTION_FORBIDDEN",
    message,
    policyRevision,
    ["Choose an exact selection exposed by the current codex_task descriptor.", "Open Codex settings to review the active policy and operator ceiling."]
  );
}

function selectionLabel(selection: ModelSelection): string {
  return `${selection.model}/${selection.reasoningEffort}${selection.serviceTier ? `/${selection.serviceTier}` : ""}`;
}

function decisionReason(
  source: ExecutionDecisionSource,
  operation: "start" | "continue",
  backendKind: CodexBackendKind,
  validation: CatalogValidationState
): string {
  const sourceText = source === "fixed"
    ? "the saved fixed policy"
    : source === "preferred"
      ? "the saved preferred selection"
      : source === "caller"
        ? "the caller's exact selection"
        : source === "compatibility-fallback"
          ? "the current upstream default because the saved selection is unsupported"
          : "the validated backend catalog default";
  return `Selected from ${sourceText} for ${operation} on ${backendKind}; catalog state is ${validation}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
