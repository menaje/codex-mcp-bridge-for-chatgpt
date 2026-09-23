import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { CodexService } from "../src/codexService.js";
import { projectCodexAccount, type CodexAccountSnapshot } from "../src/codexAccount.js";
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
    const codexHome = path.join(root, ".codex");
    await mkdir(codexHome);
    const authFile = path.join(codexHome, "auth.json");
    await writeFile(authFile, JSON.stringify({
      auth_mode: "chatgpt", tokens: { account_id: "fixture-account", access_token: "one" }
    }));
    const structuralSnapshot = vi.fn(async () => structuralDashboard());
    const readProjection = {
      dashboardSnapshot: structuralSnapshot,
      dashboardHistoryDetail: vi.fn(),
      dashboardRuntimePlan: vi.fn(async () => ({ candidates: [] })),
      dashboardSnapshotWithEnrichment: vi.fn(async () => structuralDashboard()),
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
      const observedAt = Date.now() - 60 * 60_000;
      const account = projectCodexAccount(
        { account: { type: "chatgpt", email: "fixture@example.com", planType: "plus" } },
        { rateLimitsByLimitId: { codex: { primary: { usedPercent: 40, windowDurationMins: 10080 } } } },
        observedAt
      );
      const partial = projectCodexAccount(
        { account: { type: "chatgpt", email: "fixture@example.com", planType: "plus" } },
        null,
        Date.now()
      );
      vi.spyOn(service, "readCliAccount").mockResolvedValueOnce(account).mockResolvedValueOnce(partial);
      await expect(service.readAccount("app-server")).resolves.toEqual(account);

      const retained = await server.applicationService.dashboardSnapshot({
        inspectRuntime: false
      });

      expect(structuralSnapshot).toHaveBeenCalledOnce();
      expect(readProjection.dashboardRuntimePlan).not.toHaveBeenCalled();
      expect(retained.codexAccount).toEqual(account);
      expect(retained.usageContext).toBe(service.accountDisplayContext());
      expect(retained.enrichment.oldestObservationAt).toBe(
        new Date(account.usageObservedAt!).toISOString()
      );

      await writeFile(authFile, JSON.stringify({
        auth_mode: "chatgpt", tokens: { account_id: "fixture-account", access_token: "two" }
      }));
      const refreshed = await server.applicationService.dashboardSnapshot({ inspectRuntime: true });
      expect(refreshed.usageContext).toBe(retained.usageContext);
      expect(refreshed.codexAccount).toMatchObject({
        planType: "plus", usageStatus: "unavailable", usageObservedAt: observedAt
      });
      expect((refreshed.codexAccount as unknown as CodexAccountSnapshot).windows[0].remainingPercent).toBe(60);
      expect(refreshed.enrichment.usageUnavailable).toBe(true);
      expect(refreshed.enrichment.oldestObservationAt).toBe(new Date(observedAt).toISOString());

      await writeFile(authFile, JSON.stringify({
        auth_mode: "chatgpt", tokens: { account_id: "replacement-account" }
      }));
      const changedContext = await server.applicationService.dashboardSnapshot({
        inspectRuntime: false
      });
      expect(changedContext.codexAccount).toBeNull();
      expect(changedContext.usageContext).not.toBe(retained.usageContext);
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
