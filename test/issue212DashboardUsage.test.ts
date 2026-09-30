import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { projectCodexAccount, type CodexAccountSnapshot } from "../src/codexAccount.js";
import { CodexService } from "../src/codexService.js";
import { createBridgeMcpServer } from "../src/server.js";
import type { BridgeReadProjectionService, DashboardView } from "../src/tools.js";
import type { CodexUpstream } from "../src/upstream.js";
import { syntheticIdToken } from "./fixtures/syntheticAuth.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function account(id: string, usedPercent: number | null, observedAt: number): CodexAccountSnapshot {
  const session = {
    activeSessionId: `session-${id}`,
    sessions: [{ sessionId: `session-${id}`, isActive: true,
      userId: `user-${id}`, selectedWorkspaceAccountId: id }]
  };
  return projectCodexAccount(
    { account: { type: "chatgpt", planType: "plus" }, workspaceRouting: { chatgptAccountId: id } },
    usedPercent === null ? null : {
      accountId: id,
      rateLimitsByLimitId: { codex: { primary: { usedPercent, windowDurationMins: 10_080 } } }
    },
    observedAt,
    { before: session, after: session }
  );
}

function dashboard(): DashboardView {
  return {
    kind: "dashboard", generatedAt: new Date().toISOString(), scope: "bridge-wide",
    statusSource: "codex-runtime-only", coverage: "bridge-known-retained",
    enrichment: { state: "structural", runtimeRequests: 0, cacheHits: 0,
      timeouts: 0, durationMs: 0, usageTimedOut: false, pendingReads: 0 },
    codexAccount: null, weeklyUsage: null, counts: {}, activeRows: [], terminalRows: [],
    idleRows: [], pagination: {}, uiLocalePreference: "auto"
  } as unknown as DashboardView;
}

async function fixture(store: "file" | "keyring" | "auto") {
  const root = await mkdtemp(path.join(tmpdir(), "issue-212-dashboard-"));
  roots.push(root);
  const environment = {
    HOME: root, PATH: "", CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json")
  };
  const config = loadConfig(environment);
  const service = new CodexService(environment);
  let effectiveStore: "file" | "keyring" | "auto" = store;
  service.setAuthPolicyReader(async () => ({
    config: { config: { cliAuthCredentialsStore: effectiveStore } },
    requirements: { requirements: null }
  }));
  config.codexService = service;
  if (store === "file") {
    const home = path.join(root, ".codex");
    await mkdir(home);
    await writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt",
      tokens: { account_id: "account-a", id_token: syntheticIdToken("user-account-a", "account-a") } }));
  }
  const readProjection = {
    dashboardSnapshot: vi.fn(async () => dashboard()),
    dashboardHistoryDetail: vi.fn(),
    dashboardRuntimePlan: vi.fn(async () => ({ candidates: [] })),
    dashboardSnapshotWithEnrichment: vi.fn(async (_options, enrichment) => ({
      ...dashboard(), weeklyUsage: enrichment.weeklyUsage, enrichment: enrichment.summary
    })),
    settingsSnapshot: vi.fn()
  } as unknown as BridgeReadProjectionService;
  const upstream = {
    listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }),
    readAccountRateLimits: vi.fn(async () => ({ limitId: "codex", usedPercent: 1,
      remainingPercent: 99, windowDurationMins: 10_080, resetsAt: null, observedAt: Date.now() })),
    close: async () => undefined
  } as unknown as CodexUpstream;
  const server = createBridgeMcpServer(config, upstream, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, readProjection);
  const read = (enrich = true) => server.applicationService.dashboardSnapshot({ inspectRuntime: enrich });
  return { root, service, upstream, server, read,
    setStore: (next: typeof effectiveStore) => { effectiveStore = next; } };
}

describe("issue 212: dashboard account-wide weekly usage", () => {
  it("shows file-backed usage on the structural card with its real confirmation time", async () => {
    const f = await fixture("file");
    try {
      const observedAt = Date.now() - 3_600_000;
      vi.spyOn(f.service, "readCliAccount").mockResolvedValue(account("account-a", 42, observedAt));
      const enriched = await f.read();
      expect(enriched.weeklyUsage?.remainingPercent).toBe(58);
      expect(enriched.weeklyUsage?.observedAt).toBe(new Date(observedAt).toISOString());
      expect(enriched.usageDisplayStatus).toBe("available");
      const structural = await f.read(false);
      expect(structural.weeklyUsage).toEqual(enriched.weeklyUsage);
      expect(structural.usageDisplayStatus).toBe("checking");
      expect(vi.mocked(f.upstream.readAccountRateLimits)).not.toHaveBeenCalled();
    } finally { await f.server.close(); }
  });

  it("removes file-backed usage as soon as the account changes", async () => {
    const f = await fixture("file");
    try {
      vi.spyOn(f.service, "readCliAccount")
        .mockResolvedValueOnce(account("account-a", 40, Date.now() - 60_000))
        .mockResolvedValueOnce(account("account-b", 15, Date.now()));
      await f.read();
      const authFile = path.join(f.root, ".codex", "auth.json");
      await writeFile(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: {
        account_id: "account-b", id_token: syntheticIdToken("user-account-b", "account-b")
      } }));
      const switching = await f.read(false);
      expect(switching.weeklyUsage).toBeNull();
      expect(switching.codexAccount).toBeNull();
      expect(switching.usageDisplayStatus).toBe("switching");
      const current = await f.read();
      expect(current.weeklyUsage?.remainingPercent).toBe(85);
      expect(current.usageDisplayStatus).toBe("available");
    } finally { await f.server.close(); }
  });

  it("does not project a cached file account after the effective store switches to Keyring", async () => {
    const f = await fixture("file");
    try {
      const readAccount = vi.spyOn(f.service, "readCliAccount")
        .mockResolvedValueOnce(account("account-a", 40, Date.now() - 60_000))
        .mockResolvedValueOnce(account("account-b", 20, Date.now()));
      await f.read();
      f.setStore("keyring");
      const changed = await f.read();
      expect(changed.weeklyUsage).toBeNull();
      expect(changed.usageDisplayStatus).toBe("switching");
      const current = await f.read();
      expect(current.weeklyUsage?.remainingPercent).toBe(80);
      expect(current.usageDisplayStatus).toBe("available");
      expect(readAccount).toHaveBeenCalledTimes(2);
    } finally { await f.server.close(); }
  });

  for (const store of ["keyring", "auto"] as const) {
    it(`shows only a fresh ${store} account observation and clears it during a switch`, async () => {
      const f = await fixture(store);
      try {
        const readAccount = vi.spyOn(f.service, "readCliAccount")
          .mockResolvedValueOnce(account("account-a", 40, Date.now() - 60_000))
          .mockResolvedValueOnce(account("account-b", 20, Date.now()));
        const first = await f.read();
        expect(first.weeklyUsage?.remainingPercent).toBe(60);
        expect(first.usageDisplayStatus).toBe("available");
        expect(first.usageContext).toBeNull();
        const structural = await f.read(false);
        expect(structural.weeklyUsage).toBeNull();
        expect(structural.usageDisplayStatus).toBe("checking");
        const switched = await f.read();
        expect(switched.weeklyUsage?.remainingPercent).toBe(80);
        expect(switched.codexAccount).toMatchObject({ accountKey: account("account-b", 20, Date.now()).accountKey });
        expect(readAccount).toHaveBeenCalledTimes(2);
        expect(vi.mocked(f.upstream.readAccountRateLimits)).not.toHaveBeenCalled();
      } finally { await f.server.close(); }
    });
  }

  it("retains a proven same-owner Keyring value after a limits failure without changing its timestamp", async () => {
    const f = await fixture("keyring");
    try {
      const observedAt = Date.now() - 3_600_000;
      vi.spyOn(f.service, "readCliAccount")
        .mockResolvedValueOnce(account("account-a", 35, observedAt))
        .mockResolvedValueOnce(account("account-a", null, Date.now()));
      await f.read();
      const failed = await f.read();
      expect(failed.weeklyUsage?.remainingPercent).toBe(65);
      expect(failed.weeklyUsage?.observedAt).toBe(new Date(observedAt).toISOString());
      expect(failed.usageDisplayStatus).toBe("unavailable");
      expect(failed.enrichment.usageUnavailable).toBe(true);
    } finally { await f.server.close(); }
  });

  it("does not show limits that contradict the selected account", async () => {
    const f = await fixture("keyring");
    try {
      vi.spyOn(f.service, "readCliAccount").mockResolvedValue(projectCodexAccount(
        { account: { type: "chatgpt" }, workspaceRouting: { chatgptAccountId: "account-a" } },
        { accountId: "account-b", rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 30, windowDurationMins: 10_080 } }
        } }
      ));
      const view = await f.read();
      expect(view.weeklyUsage).toBeNull();
      expect(view.usageDisplayStatus).toBe("unavailable");
    } finally { await f.server.close(); }
  });

  it("distinguishes timeout, temporary failure, no limit, and sign-out without inventing a percentage", async () => {
    const f = await fixture("auto");
    try {
      let release!: (value: CodexAccountSnapshot) => void;
      const slow = new Promise<CodexAccountSnapshot>(resolve => { release = resolve; });
      const readAccount = vi.spyOn(f.service, "readCliAccount")
        .mockReturnValueOnce(slow)
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce(projectCodexAccount({ account: { type: "chatgpt" } }, {}, Date.now()))
        .mockResolvedValueOnce(projectCodexAccount({ account: null }, null, Date.now()));
      const timedOut = await f.read();
      expect(timedOut.usageDisplayStatus).toBe("timed-out");
      expect(timedOut.weeklyUsage).toBeNull();
      expect(timedOut.enrichment.usageTimedOut).toBe(true);
      release(account("account-a", 25, Date.now()));
      await slow;
      await new Promise(resolve => setImmediate(resolve));
      const failed = await f.read();
      expect(failed.usageDisplayStatus).toBe("unavailable");
      expect(failed.weeklyUsage).toBeNull();
      expect(failed.enrichment.usageUnavailable).toBe(true);
      const noLimit = await f.read();
      expect(noLimit.usageDisplayStatus).toBe("no-limit");
      expect(noLimit.weeklyUsage).toBeNull();
      const signedOut = await f.read();
      expect(signedOut.usageDisplayStatus).toBe("signed-out");
      expect(signedOut.weeklyUsage).toBeNull();
      expect(readAccount).toHaveBeenCalledTimes(4);
    } finally { await f.server.close(); }
  });
});
