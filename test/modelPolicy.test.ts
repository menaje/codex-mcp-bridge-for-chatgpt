import { describe, expect, it } from "vitest";
import type { CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import {
  ModelPolicyError,
  listAllowedModelSelections,
  resolveModelPolicy,
  sameModelPolicy,
  validatePolicyAgainstCatalog,
  type BackendCapabilities,
  type ModelPolicy,
  type ModelSelection
} from "../src/modelPolicy.js";

const APP_CAPABILITIES: BackendCapabilities = {
  selectionScope: "turn",
  supportsModelOverrideOnContinue: true,
  supportsEffortOverrideOnContinue: true,
  supportsServiceTierOverrideOnContinue: true,
  supportsFork: false
};

const MCP_CAPABILITIES: BackendCapabilities = {
  selectionScope: "thread",
  supportsModelOverrideOnContinue: false,
  supportsEffortOverrideOnContinue: false,
  supportsServiceTierOverrideOnContinue: false,
  supportsFork: false
};

const SOL_MAX: ModelSelection = { model: "gpt-5.6-sol", reasoningEffort: "max" };
const SOL_HIGH: ModelSelection = { model: "gpt-5.6-sol", reasoningEffort: "high" };
const TERRA_MEDIUM: ModelSelection = { model: "gpt-5.6-terra", reasoningEffort: "medium" };
const TERRA_HIGH: ModelSelection = { model: "gpt-5.6-terra", reasoningEffort: "high" };
const SOL_PRIORITY: ModelSelection = {
  model: "gpt-5.6-sol",
  reasoningEffort: "max",
  serviceTier: "priority"
};

const FIXED_POLICY: ModelPolicy = {
  mode: "fixed",
  selection: SOL_MAX,
  constraints: { allowDelegation: true }
};

const AUTOMATIC_POLICY: ModelPolicy = {
  mode: "automatic",
  preferredSelection: TERRA_MEDIUM,
  allowedSelections: { kind: "catalog-visible" },
  constraints: { allowDelegation: true }
};

describe("model policy resolver", () => {
  it("enforces a fixed exact selection and rejects every caller override", () => {
    const decision = decide({ policy: FIXED_POLICY, operation: "start" });
    expect(decision).toMatchObject({
      policyRevision: 7,
      source: "fixed",
      effectiveSelection: SOL_MAX,
      appliedAt: "thread-start",
      catalogFingerprint: "a".repeat(64)
    });
    expectPolicyError(
      () => decide({ policy: FIXED_POLICY, requestedSelection: SOL_HIGH }),
      "MODEL_SELECTION_FORBIDDEN"
    );
  });

  it("resolves automatic caller, preferred, and backend-default selections deterministically", () => {
    expect(decide({ policy: AUTOMATIC_POLICY }).source).toBe("preferred");
    expect(decide({ policy: AUTOMATIC_POLICY }).effectiveSelection).toEqual(TERRA_MEDIUM);
    expect(decide({ policy: AUTOMATIC_POLICY, requestedSelection: SOL_HIGH })).toMatchObject({
      source: "caller",
      requestedSelection: SOL_HIGH,
      effectiveSelection: SOL_HIGH
    });
    const withoutPreferred: ModelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "catalog-visible" },
      constraints: { allowDelegation: true }
    };
    expect(decide({ policy: withoutPreferred })).toMatchObject({
      source: "backend-default",
      effectiveSelection: SOL_MAX
    });
    expect(decide({ policy: withoutPreferred }).effectiveSelection).toEqual(SOL_MAX);
  });

  it("falls back from a drifted automatic preference to the validated backend default", () => {
    const withoutPreferredModel = catalog({
      models: catalog().models.filter((model) => model.id !== TERRA_MEDIUM.model)
    });
    expect(decide({ policy: AUTOMATIC_POLICY, catalog: withoutPreferredModel })).toMatchObject({
      source: "backend-default",
      effectiveSelection: SOL_MAX,
      reason: expect.stringContaining("preferred selection was outside")
    });
    expect(() =>
      validatePolicyAgainstCatalog(AUTOMATIC_POLICY, withoutPreferredModel, undefined, 7)
    ).not.toThrow();
  });

  it("validates automatic policy drift by its surviving live intersection", () => {
    const partial: ModelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "explicit", selections: [SOL_MAX, TERRA_MEDIUM] },
      constraints: { allowDelegation: true }
    };
    const withoutTerra = catalog({
      models: catalog().models.filter((model) => model.id !== TERRA_MEDIUM.model)
    });

    expect(listAllowedModelSelections(partial, withoutTerra)).toEqual([SOL_MAX]);
    expect(() => validatePolicyAgainstCatalog(partial, withoutTerra, undefined, 7)).not.toThrow();
    expect(decide({ policy: partial, catalog: withoutTerra, requestedSelection: SOL_MAX }))
      .toMatchObject({ source: "caller", effectiveSelection: SOL_MAX });
  });

  it("materializes a migrated model-only preference with that model's catalog default", () => {
    const policy: ModelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "catalog-visible" },
      constraints: { allowDelegation: true }
    };
    expect(decide({ policy, legacyPreferredModel: "gpt-5.6-terra" })).toMatchObject({
      source: "preferred",
      effectiveSelection: TERRA_MEDIUM
    });
    expect(decide({ policy, legacyPreferredModel: "gpt-5.6-sol" }).effectiveSelection)
      .toEqual(SOL_MAX);
  });

  it("keeps explicit allowlists closed when the catalog expands", () => {
    const explicit: ModelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "explicit", selections: [SOL_MAX, TERRA_MEDIUM] },
      constraints: { allowDelegation: true }
    };
    expect(listAllowedModelSelections(explicit, catalog())).toEqual([SOL_MAX, TERRA_MEDIUM]);
    expectPolicyError(
      () => decide({ policy: explicit, requestedSelection: TERRA_HIGH }),
      "MODEL_SELECTION_FORBIDDEN"
    );
    expect(listAllowedModelSelections(AUTOMATIC_POLICY, catalog())).toContainEqual(TERRA_HIGH);
  });

  it("intersects user policy with the exact operator ceiling and delegation constraint", () => {
    expectPolicyError(
      () => decide({ policy: AUTOMATIC_POLICY, requestedSelection: SOL_HIGH, operatorCeiling: [SOL_MAX] }),
      "MODEL_SELECTION_FORBIDDEN"
    );
    const delegationDisabled: ModelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "catalog-visible" },
      constraints: { allowDelegation: false }
    };
    expect(
      listAllowedModelSelections(delegationDisabled, catalog())
        .some((selection) => selection.reasoningEffort === "ultra")
    ).toBe(false);
    expectPolicyError(
      () => decide({
        policy: delegationDisabled,
        requestedSelection: { model: "gpt-5.6-sol", reasoningEffort: "ultra" }
      }),
      "MODEL_SELECTION_FORBIDDEN"
    );
  });

  it("keeps service tier outside the model and effort choice", () => {
    expect(() => decide({ policy: AUTOMATIC_POLICY, requestedSelection: SOL_PRIORITY }))
      .toThrow(/only model and reasoningEffort/i);
  });

  it("does not materialize backend service tiers in the model policy resolver", () => {
    const catalogVisible: ModelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "catalog-visible" },
      constraints: { allowDelegation: true }
    };
    expect(decide({ policy: catalogVisible }).effectiveSelection).toEqual(SOL_MAX);
    expect(listAllowedModelSelections(catalogVisible, catalog())
      .every((selection) => selection.serviceTier === undefined)).toBe(true);
  });

  it("compares explicit allowlists as sets for no-op policy updates", () => {
    const left: ModelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "explicit", selections: [SOL_MAX, TERRA_MEDIUM] },
      constraints: { allowDelegation: true }
    };
    const right: ModelPolicy = {
      ...left,
      allowedSelections: { kind: "explicit", selections: [TERRA_MEDIUM, SOL_MAX] }
    };
    expect(sameModelPolicy(left, right)).toBe(true);
  });

  it("rejects stale policy revisions with recoverable actions", () => {
    try {
      decide({ policy: AUTOMATIC_POLICY, requestedPolicyRevision: 6 });
      throw new Error("Expected stale revision rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelPolicyError);
      expect(error).toMatchObject({
        code: "MODEL_POLICY_CHANGED",
        policyRevision: 7,
        nextActions: [expect.stringContaining("Refresh")]
      });
    }
  });

  it("applies App Server changes at turn start and rejects unsupported MCP continuation changes", () => {
    expect(decide({
      policy: AUTOMATIC_POLICY,
      operation: "continue",
      backendKind: "app-server",
      backendCapabilities: APP_CAPABILITIES,
      currentSelection: SOL_MAX,
      requestedSelection: TERRA_HIGH
    })).toMatchObject({ appliedAt: "turn-start", effectiveSelection: TERRA_HIGH });

    const unsupported = expectPolicyError(
      () => decide({
        policy: AUTOMATIC_POLICY,
        operation: "continue",
        backendKind: "mcp-server",
        backendCapabilities: MCP_CAPABILITIES,
        currentSelection: SOL_MAX,
        requestedSelection: TERRA_HIGH
      }),
      "THREAD_OVERRIDE_UNSUPPORTED"
    );
    expect(unsupported.nextActions).toEqual([
      expect.stringContaining("contextMode='fresh'"),
      expect.stringContaining("App Server")
    ]);
    expect(unsupported.nextActions.join(" ")).not.toContain("sessionMode");
    expect(decide({
      policy: {
        mode: "automatic",
        preferredSelection: SOL_MAX,
        allowedSelections: { kind: "catalog-visible" },
        constraints: { allowDelegation: true }
      },
      operation: "continue",
      backendKind: "mcp-server",
      backendCapabilities: MCP_CAPABILITIES,
      currentSelection: SOL_MAX
    })).toMatchObject({ appliedAt: "thread-start", effectiveSelection: SOL_MAX });
  });

  it("uses a visible compatible fallback for saved catalog drift and distinguishes cached refresh failure", () => {
    const removed = catalog().models.filter((model) => model.id !== SOL_MAX.model);
    expect(decide({ policy: FIXED_POLICY, catalog: catalog({ models: removed }) })).toMatchObject({
      source: "compatibility-fallback",
      savedSelectionSupported: false,
      effectiveSelection: TERRA_MEDIUM,
      effectiveReasoningEffort: TERRA_MEDIUM.reasoningEffort,
      preferenceWarning: expect.stringContaining("unsupported by the current catalog")
    });
    const stale = catalog({
      stale: true,
      validation: "temporarily-unverified-with-last-known-good"
    });
    expect(decide({ policy: FIXED_POLICY, catalog: stale })).toMatchObject({
      catalogValidation: "temporarily-unverified-with-last-known-good"
    });
  });

  it("distinguishes an operator-ceiling violation from an empty catalog intersection", () => {
    const policy: ModelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "explicit", selections: [SOL_MAX] },
      constraints: { allowDelegation: true }
    };
    expectPolicyError(
      () => validatePolicyAgainstCatalog(policy, catalog(), [TERRA_MEDIUM], 8),
      "MODEL_SELECTION_FORBIDDEN"
    );
    const withoutSol = catalog({
      models: catalog().models.filter((model) => model.id !== SOL_MAX.model)
    });
    expectPolicyError(
      () => validatePolicyAgainstCatalog(policy, withoutSol, undefined, 8),
      "MODEL_UNAVAILABLE"
    );
  });

  it("property-checks every projected selection against the runtime resolver", () => {
    const policies: ModelPolicy[] = [
      AUTOMATIC_POLICY,
      {
        mode: "automatic",
        allowedSelections: {
          kind: "explicit",
          selections: [SOL_HIGH, SOL_MAX, TERRA_HIGH]
        },
        constraints: { allowDelegation: true }
      },
      {
        mode: "automatic",
        allowedSelections: { kind: "catalog-visible" },
        constraints: { allowDelegation: false }
      }
    ];
    for (const policy of policies) {
      const projected = listAllowedModelSelections(policy, catalog(), undefined);
      expect(projected.length).toBeGreaterThan(0);
      for (const selection of projected) {
        expect(decide({ policy, requestedSelection: selection }).effectiveSelection).toEqual(selection);
      }
      for (const selection of allCatalogSelections()) {
        if (projected.some((entry) => JSON.stringify(entry) === JSON.stringify(selection))) continue;
        expectPolicyError(
          () => decide({ policy, requestedSelection: selection }),
          "MODEL_SELECTION_FORBIDDEN"
        );
      }
    }
  });
});

function decide(overrides: Partial<Parameters<typeof resolveModelPolicy>[0]> = {}) {
  return resolveModelPolicy({
    policyRevision: 7,
    policy: AUTOMATIC_POLICY,
    catalog: catalog(),
    backendKind: "mcp-server",
    backendCapabilities: MCP_CAPABILITIES,
    operation: "start",
    ...overrides
  });
}

function catalog(
  overrides: Partial<CodexModelCatalogSnapshot> = {}
): CodexModelCatalogSnapshot {
  return {
    source: "app-server",
    fetchedAt: "2026-08-23T00:00:00.000Z",
    validatedAt: "2026-08-23T00:00:00.000Z",
    fingerprint: "a".repeat(64),
    cached: false,
    stale: false,
    validation: "valid",
    models: [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: ["high", "max", "ultra"].map((effort) => ({ effort })),
        isDefault: true,
        defaultServiceTier: "priority",
        serviceTiers: [{ id: "priority", name: "Priority" }],
        inputModalities: ["text", "image"]
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6-Terra",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "high"].map((effort) => ({ effort })),
        isDefault: false,
        serviceTiers: [],
        inputModalities: ["text"]
      }
    ],
    ...overrides
  };
}

function allCatalogSelections(): ModelSelection[] {
  return [
    SOL_HIGH,
    SOL_MAX,
    { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
    TERRA_MEDIUM,
    TERRA_HIGH
  ];
}

function expectPolicyError(operation: () => unknown, code: ModelPolicyError["code"]): ModelPolicyError {
  try {
    operation();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ModelPolicyError);
    expect(error).toMatchObject({ code });
    return error as ModelPolicyError;
  }
}
