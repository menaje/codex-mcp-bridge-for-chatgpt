import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { CodexService } from "../src/codexService.js";
import { projectCodexAccount } from "../src/codexAccount.js";
import { createBridgeMcpServer } from "../src/server.js";
import type {
  BridgeReadProjectionService,
  DashboardView
} from "../src/tools.js";
import type { CodexUpstream } from "../src/upstream.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Dashboard account refresh presentation", () => {
  it("projects the previous same-context account onto a structural read-process snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dashboard-account-refresh-"));
    roots.push(root);
    const environment = {
      HOME: root,
      PATH: "",
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json")
    };
    const config = loadConfig(environment);
    const service = new CodexService(environment);
    config.codexService = service;
    const structuralSnapshot = vi.fn(async () => structuralDashboard());
    const readProjection = {
      dashboardSnapshot: structuralSnapshot,
      dashboardHistoryDetail: vi.fn(),
      dashboardRuntimePlan: vi.fn(),
      dashboardSnapshotWithEnrichment: vi.fn(),
      settingsSnapshot: vi.fn()
    } as unknown as BridgeReadProjectionService;
    const upstream = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => undefined
    } as CodexUpstream;
    const server = createBridgeMcpServer(
      config,
      upstream,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readProjection
    );
    try {
      const account = {
        ...projectCodexAccount({ account: { type: "chatgpt", email: "fixture@example.com" } }, null),
        observedAt: Date.now() - 60 * 60_000
      };
      vi.spyOn(service, "readCliAccount").mockResolvedValue(account);
      await expect(service.readAccount("app-server")).resolves.toEqual(account);

      const retained = await server.applicationService.dashboardSnapshot({
        inspectRuntime: false
      });

      expect(structuralSnapshot).toHaveBeenCalledOnce();
      expect(readProjection.dashboardRuntimePlan).not.toHaveBeenCalled();
      expect(retained.codexAccount).toEqual(account);
      expect(retained.enrichment.oldestObservationAt).toBe(
        new Date(account.observedAt).toISOString()
      );

      const codexHome = path.join(root, ".codex");
      await mkdir(codexHome);
      await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { account_id: "replacement-account" }
      }));
      const changedContext = await server.applicationService.dashboardSnapshot({
        inspectRuntime: false
      });
      expect(changedContext.codexAccount).toBeNull();
    } finally {
      await server.close();
    }
  });
});

function structuralDashboard(): DashboardView {
  return {
    kind: "dashboard",
    generatedAt: new Date().toISOString(),
    scope: "bridge-wide",
    statusSource: "codex-runtime-only",
    coverage: "bridge-known-retained",
    enrichment: {
      state: "structural",
      runtimeRequests: 0,
      cacheHits: 0,
      timeouts: 0,
      durationMs: 0,
      usageTimedOut: false,
      pendingReads: 0
    },
    codexAccount: null,
    weeklyUsage: null,
    counts: {},
    activeRows: [],
    terminalRows: [],
    idleRows: [],
    pagination: {},
    uiLocalePreference: "auto"
  } as unknown as DashboardView;
}
