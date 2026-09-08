import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { loadConfig } from "../src/config.js";
import { createBridgeMcpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { CodexJobRegistry } from "../src/tools.js";
import { modelActionGuidance } from "../src/toolGuidance.js";
import { projectRecoveryGuidance } from "../src/projectGuidance.js";
import type { CodexModelCatalogSnapshot } from "../src/modelCatalog.js";

const selection = { model: "gpt-5.6-sol", reasoningEffort: "max" };
const catalog: CodexModelCatalogSnapshot = {
  source: "codex-cli", fetchedAt: "2026-09-08T00:00:00Z", validatedAt: "2026-09-08T00:00:00Z",
  fingerprint: "a".repeat(64), cached: true, stale: false, validation: "valid",
  models: [{ id: selection.model, displayName: "Fixture", defaultReasoningEffort: "max",
    supportedReasoningEfforts: [{ effort: "max" }], serviceTiers: [], inputModalities: ["text"] }]
};
const metadata = { "openai/session": "tool-guidance-test" };

describe("tool guidance through production MCP", () => {
  let root: string, store: BridgeStateStore, settings: UserSettingsStore;
  let client: Client, server: ReturnType<typeof createBridgeMcpServer>;
  let oldCatalogValidator: boolean, legacyValidatorsInstalled: number, permittedFailureProbe: boolean;
  const upstreamCall = vi.fn(async () => { throw new Error("Guidance must not execute Codex"); });
  const getCatalog = vi.fn(async () => catalog);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    await client.callTool({ name, arguments: args, _meta: metadata }) as any;
  const task = (args: Record<string, unknown> = {}) => call("codex_task", {
    requestId: randomUUID(), taskContractVersion: "2", executionEnvelopeRef: settings.taskExecutionEnvelopeRef(),
    prompt: "Inspect the requested project", selection, ...args
  });
  const add = async (name: string) => {
    const cwd = path.join(root, randomUUID()); await mkdir(cwd);
    settings.updateWithProjectOperations({}, [{ kind: "add", project: { name, cwd } }], undefined, settings.current.registryRevision);
    return settings.current.projects.find(project => project.name === name && project.archivedAt === undefined)!;
  };
  const archive = (id: string) => settings.updateWithProjectOperations({}, [{ kind: "archive", projectId: id }], undefined, settings.current.registryRevision);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "tool-guidance-"));
    store = new BridgeStateStore({ file: ":memory:" });
    const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: root });
    settings = new UserSettingsStore(config, { stateStore: store });
    settings.update({ modelPolicy: { mode: "automatic", constraints: { allowDelegation: false },
      allowedSelections: { kind: "explicit", selections: [selection] } } }, settings.current.revision);
    upstreamCall.mockClear(); getCatalog.mockReset().mockResolvedValue(catalog); oldCatalogValidator = false; legacyValidatorsInstalled = 0; permittedFailureProbe = false;
    server = createBridgeMcpServer(config, { listTools: async () => ({ tools: [] }), callTool: upstreamCall, close: async () => {} },
      new SessionRegistry({ stateStore: store }), new CodexJobRegistry({ allowedRoots: [root], stateStore: store }),
      { getCatalog, getCachedCatalog: () => catalog }, settings);
    const ajv = new AjvJsonSchemaValidator();
    client = new Client({ name: "tool-guidance", version: "1" }, { jsonSchemaValidator: {
      getValidator(schema) {
        // Reproduce an SDK client retaining the exact pre-v2 catalog validator.
        const branches = (schema as any).anyOf as any[] | undefined;
        const legacyCatalog = branches?.find(branch => branch.properties?.models && !branch.properties.contractVersion);
        if (oldCatalogValidator && legacyCatalog) legacyValidatorsInstalled += 1;
        return ajv.getValidator(oldCatalogValidator && legacyCatalog ? legacyCatalog : schema);
      }
    } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
  });
  afterEach(async () => {
    expect(upstreamCall).toHaveBeenCalledTimes(permittedFailureProbe ? 1 : 0);
    await client.close(); await server.close(); store.close(); await rm(root, { recursive: true, force: true });
  });

  it("keeps settings recovery out of opener descriptions and retains the consolidated tool inventory", async () => {
    const { tools } = await client.listTools();
    const current = tools.filter(tool => tool._meta?.["codex/registrationTier"] !== "compatibility");
    expect(current).toHaveLength(17);
    expect(current.some(tool => ["codex_activity", "codex_input", "codex_activity_cancel", "codex_projects"].includes(tool.name))).toBe(false);
    const settingsTool = current.find(tool => tool.name === "codex_settings")!;
    expect(settingsTool.description).toBe("Open an interactive card for configuring this ChatGPT-to-Codex bridge.");
    const result = await task();
    expect(result.structuredContent.error.code).toBe("PROJECT_SETUP_REQUIRED");
    const hint = result.structuredContent.nextActions.join(" ");
    expect(hint).toContain("codex_settings({})");
    expect(hint).toContain("register");
  });

  it("keeps unavailable Alpha as the recovery target in both current and retained lookup paths", async () => {
    const alpha = await add("Alpha"); await add("Beta");
    await rename(alpha.cwd, alpha.cwd + "-offline");
    for (const result of [
      await call("codex_status", { query: { kind: "project", name: "Alpha" } }),
      await task({ projectLookup: { name: "Alpha" } }),
      await task({ project: { name: alpha.name, projectRef: alpha.projectRef, projectRevision: alpha.projectRevision } })
    ]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("PROJECT_UNAVAILABLE");
      const hint = result.structuredContent.nextActions.join(" ");
      expect(hint).toContain("Alpha"); expect(hint).toContain("repair");
      expect(hint).not.toContain("Beta"); expect(hint).not.toContain(alpha.cwd); expect(hint).not.toContain(alpha.id);
    }
  });

  it("distinguishes archived registrations and does not auto-select the sole available project", async () => {
    const alpha = await add("Alpha");
    const missing = await task();
    expect(missing.structuredContent.error.code).toBe("PROJECT_REQUIRED");
    expect(missing.structuredContent.nextActions.join(" ")).toContain("codex_status");
    expect(missing.structuredContent.nextActions.join(" ")).not.toContain("project=");
    archive(alpha.id);
    const archived = await task();
    expect(archived.structuredContent.error.code).toBe("PROJECT_REQUIRED");
    expect(archived.structuredContent.nextActions.join(" ")).toContain("restore");
    expect(archived.structuredContent.nextActions.join(" ")).not.toContain("register the project folder");
    const lookup = await call("codex_status", { query: { kind: "project", name: "Alpha" } });
    expect(lookup.structuredContent.error.message).toContain("archived");
    const replacement = await add("Alpha"); await rename(replacement.cwd, replacement.cwd + "-offline");
    const unavailable = await call("codex_status", { query: { kind: "project", name: "Alpha" } });
    expect(unavailable.structuredContent.error.message).toContain("unavailable");
    expect(unavailable.structuredContent.nextActions.join(" ")).toContain("repair");
  });

  it("does not turn an unregistered name into a settings-open instruction or substitute a deleted reference", async () => {
    const beta = await add("Beta");
    const missing = await call("codex_status", { query: { kind: "project", name: "Alpha" } });
    expect(missing.structuredContent.error.code).toBe("PROJECT_NOT_FOUND");
    expect(missing.structuredContent.nextActions[0]).toContain("Confirm the intended project with the user");
    const hint = projectRecoveryGuidance(settings.projectRegistry,
      { name: beta.name, projectRef: "prj_AAAAAAAAAAAAAAAAAAAAAA" }, () => "lookup").join(" ");
    expect(hint).toContain("not registered"); expect(hint).not.toContain(beta.projectRef);
  });

  it("recovers a renamed selector by the same opaque reference", async () => {
    const alpha = await add("Alpha");
    settings.updateWithProjectOperations({}, [{ kind: "rename", projectId: alpha.id, name: "Renamed" }], undefined, settings.current.registryRevision);
    await add("Alpha");
    const result = await task({ project: { name: alpha.name, projectRef: alpha.projectRef, projectRevision: alpha.projectRevision } });
    expect(result.structuredContent.error.code).toBe("PROJECT_REGISTRY_CHANGED");
    const hint = result.structuredContent.nextActions.join(" ");
    expect(hint).toContain('"name":"Renamed"'); expect(hint).toContain(alpha.projectRef);
    expect(hint).not.toContain(settings.current.projects.find(project => project.name === "Alpha")!.projectRef);
  });

  it("recovers unknown status and cancellation targets by reading the current conversation", async () => {
    for (const result of [await call("codex_status", { query: { kind: "job", id: "missing-job" } }),
      await call("codex_cancel", { requestId: randomUUID(), target: { kind: "job", id: "missing-job" }, expectedVersion: 1, reason: "Stop requested work" })]) {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("codex_status({})");
      expect(JSON.stringify(result)).not.toContain("Start a job");
    }
  });

  it("returns the admitted failure and exact replay without suggesting a new project execution", async () => {
    const alpha = await add("Alpha"), requestId = randomUUID();
    const input = { requestId, executionMode: "foreground", project: {
      name: alpha.name, projectRef: alpha.projectRef, projectRevision: alpha.projectRevision } };
    permittedFailureProbe = true;
    upstreamCall.mockRejectedValueOnce(new Error("PROJECT_UNAVAILABLE: Fixture failure after admission."));
    const failed = await task(input);
    expect(failed.structuredContent).toMatchObject({ state: "failed", jobId: expect.any(String), replay: false });
    expect(failed.structuredContent.nextActions).toEqual([]);
    const replay = await task(input);
    expect(replay.structuredContent).toMatchObject({ state: "failed", jobId: failed.structuredContent.jobId, replay: true });
  });

  it("keeps cached catalog-only callers valid while v2 reveals fixed versus automatic mode", async () => {
    oldCatalogValidator = true; await client.listTools();
    expect(legacyValidatorsInstalled).toBeGreaterThan(0);
    const automaticLegacy = await call("codex_models");
    settings.update({ modelPolicy: { mode: "fixed", selection, constraints: { allowDelegation: false } } }, settings.current.revision);
    const fixedLegacy = await call("codex_models");
    expect(fixedLegacy.structuredContent).toEqual(automaticLegacy.structuredContent);
    expect(fixedLegacy.structuredContent).not.toHaveProperty("selectionMode");
    oldCatalogValidator = false; await client.listTools();
    expect((await call("codex_models", { contractVersion: "2" })).structuredContent).toMatchObject({ contractVersion: "2", selectionMode: "fixed" });
    settings.update({ modelPolicy: { mode: "automatic", constraints: { allowDelegation: false }, allowedSelections: { kind: "explicit", selections: [selection] } } }, settings.current.revision);
    expect((await call("codex_models", { contractVersion: "2" })).structuredContent).toMatchObject({ selectionMode: "automatic", models: fixedLegacy.structuredContent.models });
  });

  it("reads mode and allowed models from one snapshot after an asynchronous catalog refresh", async () => {
    getCatalog.mockImplementationOnce(async () => {
      settings.update({ modelPolicy: { mode: "fixed", selection, constraints: { allowDelegation: false } } }, settings.current.revision);
      return catalog;
    });
    await client.listTools();
    expect((await call("codex_models", { contractVersion: "2", refresh: true })).structuredContent)
      .toMatchObject({ selectionMode: "fixed", models: [{ id: selection.model, efforts: [{ id: selection.reasoningEffort }] }] });
  });

  it("publishes exact, safe read actions and turns retained incomplete cancellation actions into inspection", async () => {
    const { tools } = await client.listTools();
    const validator = new AjvJsonSchemaValidator();
    for (const action of [
      { tool: "codex_settings", arguments: {}, userPrompt: "Register the intended project." },
      { tool: "codex_status", arguments: { query: { kind: "input", jobId: "job-1", waitMs: 55000 } } }
    ]) {
      const hint = modelActionGuidance(action), encoded = hint.slice(action.tool.length + 1, hint.indexOf(")"));
      expect(validator.getValidator(tools.find(tool => tool.name === action.tool)!.inputSchema)(JSON.parse(encoded)).valid).toBe(true);
      expect(hint).toContain(JSON.stringify(action.arguments));
    }
    const retained = modelActionGuidance({ tool: "codex_cancel", arguments: { jobId: "job-1", requestId: randomUUID(), expectedVersion: 1 } });
    expect(retained).toContain('codex_status({"query":{"kind":"job","id":"job-1"}})');
    expect(retained).not.toContain("codex_cancel(");
    expect(modelActionGuidance({ tool: "codex_status", arguments: { secret: "do-not-publish" } })).not.toContain("do-not-publish");
  });
});
