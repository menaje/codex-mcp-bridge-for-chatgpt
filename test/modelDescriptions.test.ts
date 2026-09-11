import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  MAX_MODEL_DESCRIPTION_LENGTH,
  modelDescriptionProjection,
  normalizeModelDescriptionOverrides
} from "../src/modelDescriptions.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { SETTINGS_REVISION_CONFLICT, UserSettingsStore } from "../src/userSettings.js";
import { replaceStoredSettingsPayloadForTest } from "./helpers/sqliteSettings.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const config = () => loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" });

describe("user model descriptions", () => {
  it("stores only overrides, preserves them across restart and mode changes, and restores to current catalog text", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "model-descriptions-"));
    directories.push(directory);
    const databaseFile = path.join(directory, "state.sqlite");
    const firstState = new BridgeStateStore({ file: databaseFile });
    const store = new UserSettingsStore(config(), { stateStore: firstState });
    const automatic = store.current.modelPolicy;
    const description = "  Use for a bounded change.\nKeep the result concise.  ";
    store.update({ modelDescriptionOverrides: { "model-a": description, "temporarily-unavailable": "Keep this." } }, 0);
    firstState.close();
    const restartedState = new BridgeStateStore({ file: databaseFile });
    const restarted = new UserSettingsStore(config(), { stateStore: restartedState });
    expect(restarted.current.modelDescriptionOverrides).toEqual({
      "model-a": description.trim(), "temporarily-unavailable": "Keep this."
    });
    const model = { id: "model-a", description: "New official description" };
    expect(modelDescriptionProjection(model, restarted.current.modelDescriptionOverrides, true)).toEqual({
      description: description.trim(), descriptionSource: "user"
    });
    restarted.update({ modelPolicy: { mode: "fixed", selection: { model: "model-a", reasoningEffort: "medium" }, constraints: { allowDelegation: false } } }, 1);
    expect(modelDescriptionProjection(model, restarted.current.modelDescriptionOverrides, false)).toEqual({ description: model.description });
    restarted.update({ modelPolicy: automatic }, 2);
    expect(restarted.current.modelDescriptionOverrides["model-a"]).toBe(description.trim());
    restarted.update({ modelDescriptionOverrides: { "model-a": " \n\t", "temporarily-unavailable": "Keep this." } }, 3);
    expect(modelDescriptionProjection(model, restarted.current.modelDescriptionOverrides, true)).toEqual({ description: model.description });
    expect(readFileSync(databaseFile).includes(Buffer.from(model.description))).toBe(false);
    expect(restarted.current.modelDescriptionOverrides).toEqual({ "temporarily-unavailable": "Keep this." });
    restartedState.close();
  });

  it("loads older settings without copying a catalog description or advancing the settings revision", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "model-descriptions-legacy-"));
    directories.push(directory);
    const databaseFile = path.join(directory, "state.sqlite");
    const firstState = new BridgeStateStore({ file: databaseFile });
    const store = new UserSettingsStore(config(), { stateStore: firstState });
    store.update({ uiLocalePreference: "ko" }, 0);
    const saved = firstState.getSettingsRecord()!.payload as Record<string, unknown>;
    delete saved.modelDescriptionOverrides;
    firstState.close();
    replaceStoredSettingsPayloadForTest(databaseFile, saved);
    const restartedState = new BridgeStateStore({ file: databaseFile });
    const restarted = new UserSettingsStore(config(), { stateStore: restartedState });
    expect(restarted.current.modelDescriptionOverrides).toEqual({});
    expect(restarted.current.settingsRevision).toBe(1);
    restartedState.close();
  });

  it("enforces stale-write conflicts and keeps execution references independent of descriptions", () => {
    const store = new UserSettingsStore(config());
    const executionRef = store.executionPolicyRef();
    const envelopeRef = store.taskExecutionEnvelopeRef();
    store.update({ modelDescriptionOverrides: { "model-a": "First." } }, 0);
    expect(store.executionPolicyRef()).toBe(executionRef);
    expect(store.taskExecutionEnvelopeRef()).toBe(envelopeRef);
    expect(() => store.update({ modelDescriptionOverrides: { "model-a": "Stale." } }, 0)).toThrow(SETTINGS_REVISION_CONFLICT);
    const read = store.current;
    read.modelDescriptionOverrides["model-a"] = "Mutated snapshot";
    expect(store.current.modelDescriptionOverrides["model-a"]).toBe("First.");
    store.update({ uiLocalePreference: "ko" }, 1);
    expect(store.current.modelDescriptionOverrides["model-a"]).toBe("First.");
    store.reset(2);
    expect(store.current.modelDescriptionOverrides).toEqual({});
  });

  it("normalizes whitespace and rejects malformed or oversized text without altering saved settings", () => {
    expect(normalizeModelDescriptionOverrides({ b: " \n", a: "  Example\ntext  " })).toEqual({ a: "Example\ntext" });
    for (const value of [null, [], { a: 42 }, { "": "text" }, { " a": "text" }, { "a\0b": "text" }, { a: "x".repeat(MAX_MODEL_DESCRIPTION_LENGTH + 1) }]) {
      expect(() => normalizeModelDescriptionOverrides(value)).toThrow(/MODEL_DESCRIPTION/);
    }
    expect(() => normalizeModelDescriptionOverrides(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), "text"])))).toThrow("MODEL_DESCRIPTIONS_LIMIT");
    expect(() => normalizeModelDescriptionOverrides(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), "한".repeat(2_000)])))).toThrow("MODEL_DESCRIPTIONS_LIMIT");
    const hostile = normalizeModelDescriptionOverrides(JSON.parse('{"__proto__":"User text","constructor":"Another model"}'));
    expect(modelDescriptionProjection({ id: "__proto__" }, hostile, true).description).toBe("User text");
    expect(modelDescriptionProjection({ id: "toString" }, hostile, true)).toEqual({});
  });
});
