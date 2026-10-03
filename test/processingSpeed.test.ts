import { describe, expect, it } from "vitest";
import { PROCESSING_SPEED_MODES, migratedProcessingSpeed, retainedPolicyServiceTiers, resolveTurnSpeed, wireSpeedArguments } from "../src/processingSpeed.js";
import { UNVERIFIED_APP_SERVER_CAPABILITIES } from "../src/cliProtocol.js";
import { loadConfig } from "../src/config.js";
import { UserSettingsStore } from "../src/userSettings.js";
import type { CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import { executionSpeedText } from "../src/executionPresentation.js";
import { UI_TRANSLATIONS } from "../src/generated/localization.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeStateStore } from "../src/stateStore.js";
import { replaceStoredSettingsPayloadForTest } from "./helpers/sqliteSettings.js";

const selection = { model: "sol", reasoningEffort: "medium" };
const capabilities = { ...UNVERIFIED_APP_SERVER_CAPABILITIES, supportsPerTurnServiceTier: true, supportedPerTurnServiceTiers: ["default", "fast", "priority", "ultrafast"] };
const catalog: CodexModelCatalogSnapshot = { source: "app-server", fingerprint: "f".repeat(64), cached: false, stale: false, validation: "valid", fetchedAt: "2026-10-03T00:00:00Z", validatedAt: "2026-10-03T00:00:00Z",
  models: [{ id: "sol", displayName: "Sol", supportedReasoningEfforts: [{ effort: "medium" }], serviceTiers: [{ id: "priority", name: "Fast" }, { id: "fast", name: "Fast" }], inputModalities: ["text"] },
    { id: "astra", displayName: "Astra", supportedReasoningEfforts: [{ effort: "medium" }], serviceTiers: [{ id: "ultrafast", name: "Ultrafast" }], inputModalities: ["text"] }] };

describe("processing speed scope", () => {
  it.each([false, true, "future-tier"])("migrates surviving settings %s once without inventing discarded tier records", legacy => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-215-settings-")), file = path.join(root, "state.sqlite");
    const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" });
    let state = new BridgeStateStore({ file });
    try {
      const first = new UserSettingsStore(config, { stateStore: state });
      first.update({ uiLocalePreference: "ko" }, 0);
      const raw = structuredClone(state.getSettingsRecord()!.payload) as Record<string, any>;
      raw.schemaVersion = 7; delete raw.processingSpeed; delete raw.retainedServiceTiers;
      raw.usePriorityServiceTier = legacy === true;
      if (legacy === "future-tier") raw.modelPolicy = { mode: "fixed", selection: { ...selection, serviceTier: legacy }, constraints: { allowDelegation: true } };
      state.close(); replaceStoredSettingsPayloadForTest(file, raw); state = new BridgeStateStore({ file });
      const migrated = new UserSettingsStore(config, { stateStore: state });
      expect(migrated.current.processingSpeed).toBe(legacy === "future-tier" ? "unrecognized-legacy-tier" : "legacy");
      expect(migrated.current.usePriorityServiceTier).toBe(legacy === true);
      expect(migrated.current.retainedServiceTiers).toEqual(legacy === "future-tier" ? [{ path: "modelPolicy.selection", selection: raw.modelPolicy.selection }] : []);
      const persisted = state.getSettingsRecord();
      state.close(); state = new BridgeStateStore({ file });
      new UserSettingsStore(config, { stateStore: state });
      expect(state.getSettingsRecord()).toEqual(persisted);
    } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])("retains legacy persistent clear/Fast wire behavior: %s", fast => {
    const args = fast ? { serviceTier: "priority" } : {};
    for (const phase of ["thread", "turn"] as const) expect(wireSpeedArguments(args, phase)).toEqual({ serviceTier: fast ? "priority" : null });
  });
  it.each(["inherit", "standard", "fast"])("changes only speed and leaves the conversation setting untouched: %s", mode => {
    const resolved = resolveTurnSpeed(selection, mode, catalog, capabilities);
    expect(resolved).toMatchObject({ ...selection, serviceTierScope: "turn" });
    expect(wireSpeedArguments(resolved, "thread")).toEqual({});
    expect(wireSpeedArguments(resolved, "turn")).toEqual({ serviceTierForTurn: mode === "inherit" ? null : mode === "standard" ? "default" : "fast" });
  });
  it("separates protocol support from model eligibility without testing account entitlement", () => {
    expect(() => resolveTurnSpeed(selection, "ultrafast", catalog, capabilities)).toThrow("PROCESSING_SPEED_UNAVAILABLE");
    expect(resolveTurnSpeed({ ...selection, model: "astra" }, "ultrafast", catalog, capabilities)).toHaveProperty("serviceTier", "ultrafast");
    expect(() => resolveTurnSpeed(selection, "standard", catalog, UNVERIFIED_APP_SERVER_CAPABILITIES)).toThrow("PROCESSING_SPEED_UNSUPPORTED");
    expect(resolveTurnSpeed(selection, "standard", catalog, { ...capabilities, supportedPerTurnServiceTiers: ["default"] })).toHaveProperty("serviceTier", "default");
    expect(() => resolveTurnSpeed(selection, "fast", catalog, { ...capabilities, supportedPerTurnServiceTiers: ["default"] })).toThrow("PROCESSING_SPEED_UNSUPPORTED");
    expect(() => resolveTurnSpeed(selection, "future-tier", catalog, capabilities)).toThrow("PROCESSING_SPEED_UNRECOGNIZED");
  });
  it("preserves surviving raw tiers and does not reconstruct discarded values", () => {
    const policy = { mode: "fixed", selection: { ...selection, serviceTier: "future-tier" } };
    const retained = retainedPolicyServiceTiers(policy);
    expect(retained).toEqual([{ path: "modelPolicy.selection", selection: policy.selection }]);
    expect(migratedProcessingSpeed({}, retained)).toBe("unrecognized-legacy-tier");
    expect(migratedProcessingSpeed({ usePriorityServiceTier: false }, [])).toBe("legacy");
    expect(retainedPolicyServiceTiers({ mode: "fixed", selection })).toEqual([]);
    expect(migratedProcessingSpeed({ processingSpeed: "future-tier" }, [])).toBe("future-tier");
  });
  it.each(["ultrafast", "future-tier"])("protects %s from old-client boolean saves and signs the new policy separately from the stable task envelope", mode => {
    const settings = new UserSettingsStore(loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" }));
    const initial = settings.executionPolicyRef(), envelope = settings.taskExecutionEnvelopeRef();
    settings.update({ processingSpeed: mode }, 0);
    const changed = settings.executionPolicyRef();
    expect(changed).not.toBe(initial);
    settings.update({ usePriorityServiceTier: false, uiLocalePreference: "ko" }, 1);
    expect(settings.current.processingSpeed).toBe(mode);
    expect(settings.executionPolicyRef()).toBe(changed);
    expect(settings.taskExecutionEnvelopeRef()).toBe(envelope);
    const admitted = resolveTurnSpeed(selection, "fast", catalog, capabilities);
    settings.update({ processingSpeed: "standard" }, 2);
    expect(admitted.serviceTier).toBe("fast");
    expect(wireSpeedArguments(admitted, "turn")).toEqual({ serviceTierForTurn: "fast" });
  });
  it("labels speed as requested, accepted and unconfirmed in every supported locale", () => {
    for (const translations of Object.values(UI_TRANSLATIONS)) for (const mode of PROCESSING_SPEED_MODES) {
      const text = executionSpeedText({ processingSpeed: mode, requestState: "accepted", serviceTier: mode === "fast" ? "fast" : undefined }, translations);
      expect(text).not.toMatch(/undefined|\{(?:speed|state)\}/);
      expect(text).toContain(translations["dashboard.execution.accepted"]);
    }
  });
  it.each(["ultrafast", "flex", "future-tier"])("preserves a historical persistent wire tier instead of labeling it cleared: %s", tier => {
    for (const translations of Object.values(UI_TRANSLATIONS)) {
      const text = executionSpeedText({ serviceTier: tier, requestState: "requested" }, translations);
      expect(text).toContain(tier);
      expect(text).not.toContain(translations["settings.processingSpeed.legacyClear"]);
      expect(text).toContain(translations["dashboard.execution.pending"]);
    }
  });
});
