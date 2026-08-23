import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BackendAwareModelCatalog,
  CodexCliModelCatalog,
  parseAppServerModelCatalog,
  parseCodexModelCatalog,
  type CodexModelCatalogProvider,
  type CodexModelCatalogSnapshot
} from "../src/modelCatalog.js";

const catalogJson = JSON.stringify({
  models: [
    {
      slug: "gpt-current",
      display_name: "GPT Current",
      description: "Current selectable model",
      default_reasoning_level: "medium",
      priority: 1,
      default_service_tier: "priority",
      service_tiers: [{ id: "priority", name: "Priority" }],
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "medium", description: "Balanced" },
        { effort: "medium", description: "Duplicate" }
      ],
      visibility: "list",
      supported_in_api: true
    },
    {
      slug: "hidden-model",
      display_name: "Hidden",
      default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "high" }],
      visibility: "hide"
    }
  ]
});

describe("Codex model catalog", () => {
  it("normalizes selectable models and filters hidden entries", () => {
    expect(parseCodexModelCatalog(catalogJson)).toEqual([
      {
        id: "gpt-current",
        displayName: "GPT Current",
        description: "Current selectable model",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { effort: "low", description: "Fast" },
          { effort: "medium", description: "Balanced" }
        ],
        isDefault: true,
        defaultServiceTier: "priority",
        serviceTiers: [{ id: "priority", name: "Priority" }],
        inputModalities: ["text", "image"],
        supportedInApi: true
      }
    ]);
  });

  it("uses a short-lived cache and supports an explicit refresh", async () => {
    let calls = 0;
    let now = Date.parse("2026-08-21T00:00:00.000Z");
    const catalog = new CodexCliModelCatalog(
      "/usr/local/bin/codex",
      1000,
      5000,
      async () => {
        calls += 1;
        return catalogJson;
      },
      () => now
    );

    const first = await catalog.getCatalog();
    const second = await catalog.getCatalog();
    const refreshed = await catalog.getCatalog({ refresh: true });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(refreshed.cached).toBe(false);
    expect(calls).toBe(2);
    expect(first.fetchedAt).toBe("2026-08-21T00:00:00.000Z");
    expect(first.validatedAt).toBe(first.fetchedAt);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.validation).toBe("valid");

    now += 2000;
  });

  it("returns the last successful catalog as stale when a later refresh fails", async () => {
    let calls = 0;
    let now = Date.parse("2026-08-21T00:00:00.000Z");
    const catalog = new CodexCliModelCatalog(
      "codex",
      1000,
      5000,
      async () => {
        calls += 1;
        if (calls > 1) throw new Error("offline");
        return catalogJson;
      },
      () => now
    );

    await catalog.getCatalog();
    now += 2000;
    const stale = await catalog.getCatalog();

    expect(stale.cached).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.validation).toBe("temporarily-unverified-with-last-known-good");
    expect(stale.warning).toContain("offline");
    expect(stale.models[0]?.id).toBe("gpt-current");
  });

  it("restores a private persisted catalog as a stale fallback after restart", async () => {
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-models-")), "models.json");
    let now = Date.parse("2026-08-21T00:00:00.000Z");
    const first = new CodexCliModelCatalog(
      "codex",
      1000,
      5000,
      async () => catalogJson,
      () => now,
      stateFile
    );
    await first.getCatalog();
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);

    now += 2000;
    const restored = new CodexCliModelCatalog(
      "codex",
      1000,
      5000,
      async () => {
        throw new Error("offline after restart");
      },
      () => now,
      stateFile
    );
    const stale = await restored.getCatalog();

    expect(stale.cached).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.warning).toContain("offline after restart");
    expect(stale.models[0]?.id).toBe("gpt-current");
  });

  it("rejects invalid or empty selectable catalogs", () => {
    expect(() => parseCodexModelCatalog("not-json")).toThrow(/invalid JSON/);
    expect(() => parseCodexModelCatalog(JSON.stringify({ models: [] }))).toThrow(/selectable models/);
  });

  it("normalizes the App Server model/list contract with exact backend capabilities", () => {
    expect(parseAppServerModelCatalog({
      data: [
        {
          id: "display-id",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Backend-visible model",
          defaultReasoningEffort: "max",
          supportedReasoningEfforts: [
            { reasoningEffort: "high" },
            { reasoningEffort: "max", description: "Maximum" }
          ],
          hidden: false,
          isDefault: true,
          defaultServiceTier: "priority",
          serviceTiers: [{ id: "priority", name: "Priority" }],
          inputModalities: ["text", "image"]
        },
        {
          id: "hidden-id",
          model: "hidden-model",
          displayName: "Hidden",
          description: "",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          hidden: true,
          isDefault: false,
          serviceTiers: [],
          inputModalities: ["text"]
        }
      ]
    })).toEqual([
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Backend-visible model",
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [
          { effort: "high" },
          { effort: "max", description: "Maximum" }
        ],
        isDefault: true,
        defaultServiceTier: "priority",
        serviceTiers: [{ id: "priority", name: "Priority" }],
        inputModalities: ["text", "image"]
      }
    ]);

    expect(parseAppServerModelCatalog({
      data: [{
        id: "text-image-default",
        model: "gpt-default-modalities",
        displayName: "Default modalities",
        description: "",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        hidden: false,
        isDefault: true,
        serviceTiers: []
      }]
    })[0]?.inputModalities).toEqual(["text", "image"]);
  });

  it("prefers App Server model/list and falls back explicitly to the CLI catalog", async () => {
    const cliSnapshot = snapshot("codex-cli", "c");
    const cli: CodexModelCatalogProvider = {
      async getCatalog() { return cliSnapshot; },
      getCachedCatalog() { return cliSnapshot; }
    };
    const appPayload = {
      data: [{
        id: "gpt-app",
        model: "gpt-app",
        displayName: "GPT App",
        description: "",
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        hidden: false,
        isDefault: true,
        serviceTiers: [],
        inputModalities: ["text"]
      }]
    };
    const app = new BackendAwareModelCatalog(
      "app-server",
      cli,
      async () => appPayload,
      1_000,
      () => Date.parse("2026-08-23T00:00:00.000Z")
    );
    await expect(app.getCatalog()).resolves.toMatchObject({
      source: "app-server",
      validation: "valid",
      models: [{ id: "gpt-app" }]
    });

    const fallback = new BackendAwareModelCatalog(
      "app-server",
      cli,
      async () => { throw new Error("model/list unavailable"); }
    );
    await expect(fallback.getCatalog()).resolves.toMatchObject({
      source: "codex-cli",
      stale: true,
      validation: "temporarily-unverified-with-last-known-good",
      warning: expect.stringContaining("model/list unavailable")
    });
    expect(fallback.getCachedCatalog({ backendKind: "app-server" })).toMatchObject({
      source: "codex-cli",
      stale: true,
      validation: "temporarily-unverified-with-last-known-good",
      warning: expect.stringContaining("unverified")
    });

    let refreshFails = false;
    const warm = new BackendAwareModelCatalog(
      "app-server",
      cli,
      async () => {
        if (refreshFails) throw new Error("refresh failed");
        return appPayload;
      }
    );
    await warm.getCatalog({ refresh: true, backendKind: "app-server" });
    refreshFails = true;
    await expect(warm.getCatalog({ refresh: true, backendKind: "app-server" }))
      .resolves.toMatchObject({
        source: "app-server",
        stale: true,
        warning: expect.stringContaining("refresh failed")
      });
    expect(warm.getCachedCatalog({ backendKind: "app-server" })).toMatchObject({
      source: "app-server",
      stale: true,
      warning: expect.stringContaining("refresh failed")
    });
    await expect(warm.getCatalog({ backendKind: "app-server" })).resolves.toMatchObject({
      source: "app-server",
      stale: true,
      warning: expect.stringContaining("refresh failed")
    });
  });
});

function snapshot(source: "app-server" | "codex-cli", fingerprint: string): CodexModelCatalogSnapshot {
  return {
    source,
    fetchedAt: "2026-08-23T00:00:00.000Z",
    validatedAt: "2026-08-23T00:00:00.000Z",
    fingerprint: fingerprint.repeat(64),
    cached: true,
    stale: false,
    validation: "valid",
    models: [{
      id: "gpt-cli",
      displayName: "GPT CLI",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ effort: "medium" }],
      isDefault: true,
      serviceTiers: [],
      inputModalities: ["text"]
    }]
  };
}
