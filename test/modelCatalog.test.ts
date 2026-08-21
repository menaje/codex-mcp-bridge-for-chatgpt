import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexCliModelCatalog, parseCodexModelCatalog } from "../src/modelCatalog.js";

const catalogJson = JSON.stringify({
  models: [
    {
      slug: "gpt-current",
      display_name: "GPT Current",
      description: "Current selectable model",
      default_reasoning_level: "medium",
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
});
