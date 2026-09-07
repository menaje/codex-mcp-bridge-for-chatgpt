import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexService } from "../src/codexService.js";
import { APP_SERVER_CAPABILITIES } from "../src/appServerUpstream.js";
import { LazyCodexUpstream } from "../src/lazyUpstream.js";
import { ContextualModelCatalog } from "../src/contextualModelCatalog.js";
import type { CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import { projectCodexAccount, estimateCodexCost } from "../src/codexAccount.js";
import { JsonRpcProcess } from "../src/jsonRpcProcess.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "codex-service-test-")); roots.push(root);
  const environment = { HOME: root, PATH: "", CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime") };
  return { root, environment, service: new CodexService(environment) };
}

describe("Codex execution context", () => {
  async function accountFixture() {
    const f = await fixture();
    const command = fileURLToPath(new URL("./fixtures/fake-codex-app-server-init-incompatible.mjs", import.meta.url));
    f.service.environment.PATH = process.env.PATH || "";
    const release = vi.fn(async () => {});
    vi.spyOn(f.service.cli, "acquire").mockResolvedValue({
      selection: { id: "fixture", source: "terminal", command, physicalPath: command, version: "99.0.0" },
      release
    });
    return { ...f, release };
  }

  it("rejects an incompatible account connection before querying the account and releases its lease", async () => {
    const f = await accountFixture();
    await expect(f.service.readCliAccount()).rejects.toThrow(/CODEX_PROTOCOL_INCOMPATIBLE.*platformFamily, platformOs/);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("handles failed initialization notification without querying the account or leaking its lease", async () => {
    const f = await accountFixture();
    const request = vi.spyOn(JsonRpcProcess.prototype, "request")
      .mockResolvedValueOnce({ userAgent: "fixture", platformFamily: "unix", platformOs: "test" })
      .mockResolvedValue({ account: null });
    vi.spyOn(JsonRpcProcess.prototype, "notify").mockImplementation(() => {
      const failure = Promise.reject(new Error("fixture notification transport failure"));
      void failure.catch(() => undefined);
      return failure;
    });
    await expect(f.service.readCliAccount()).rejects.toThrow("fixture notification transport failure");
    expect(request.mock.calls.map(call => call[0])).toEqual(["initialize"]);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("releases account ownership even when the connection cannot close cleanly", async () => {
    const f = await accountFixture();
    vi.spyOn(JsonRpcProcess.prototype, "request")
      .mockResolvedValueOnce({ userAgent: "fixture", platformFamily: "unix", platformOs: "test" })
      .mockResolvedValue({ account: null });
    vi.spyOn(JsonRpcProcess.prototype, "notify").mockResolvedValue();
    vi.spyOn(JsonRpcProcess.prototype, "close").mockRejectedValue(new Error("fixture close failure"));
    await expect(f.service.readCliAccount()).rejects.toThrow("fixture close failure");
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each(["mcp-server", "codex-sdk"] as const)("retires %s without rewriting historical credentials or storage", async kind => {
    const f = await fixture();
    const directory = path.join(f.environment.CODEX_MCP_BRIDGE_RUNTIME_HOME, "sdk", "profiles", "api-key");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "auth.json");
    const original = JSON.stringify({ fixture: "preserved-credential" });
    await writeFile(file, original);
    await expect(f.service.sessionPolicy(kind, true, "old-thread")).rejects.toThrow("CODEX_BACKEND_RETIRED");
    expect(await f.service.readAccount(kind)).toBeNull();
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await f.service.sessionPolicy("app-server", false)).toEqual({ persistent: false, visibleInCodexApp: false });
    expect(await f.service.sessionPolicy("app-server", true)).toEqual({ persistent: true, visibleInCodexApp: true });
  });

  it("keeps account display stable across metadata refreshes but clears it when authentication or selection changes", async () => {
    const f = await fixture();
    await mkdir(f.environment.CODEX_MCP_BRIDGE_RUNTIME_HOME, { recursive: true });
    const file = path.join(f.environment.CODEX_MCP_BRIDGE_RUNTIME_HOME, "cli-state.json");
    const state = { selection: { command: "/fixture/codex", version: "0.153.3" } };
    await writeFile(file, JSON.stringify(state));
    const account = projectCodexAccount({ account: { type: "chatgpt", email: "fixture@example.com" } }, null);
    const read = vi.spyOn(f.service, "readCliAccount").mockResolvedValue(account);
    await f.service.readAccount("app-server");
    await writeFile(file, JSON.stringify({ ...state, checkedAt: "2026-09-06", operation: { phase: "downloading" } }));
    expect(f.service.cachedAccount("app-server")).toEqual(account);
    expect(read).toHaveBeenCalledTimes(1);
    await writeFile(file, JSON.stringify({ selection: { command: "/fixture/other", version: "0.153.3" } }));
    expect(f.service.cachedAccount("app-server")).toBeNull();
    await f.service.readAccount("app-server");
    await mkdir(path.join(f.root, ".codex"));
    await writeFile(path.join(f.root, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apiKey", OPENAI_API_KEY: "fixture-secret" }));
    expect(f.service.cachedAccount("app-server")).toBeNull();
  });



  it("invalidates account caches but does not block normal token refreshes; account changes require new admission", async () => {
    const f = await fixture(), home = path.join(f.root, ".codex"); await mkdir(home);
    const auth = path.join(home, "auth.json");
    await writeFile(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "a", access_token: "secret-one" } }));
    const guard = f.service.admissionGuard(), before = f.service.cacheRevision(); guard();
    await writeFile(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "a", access_token: "secret-two" } }));
    expect(f.service.cacheRevision()).not.toBe(before); expect(() => guard()).not.toThrow();
    await writeFile(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "b" } }));
    expect(() => guard()).toThrow("CODEX_AUTH_CHANGED");
    expect(await readFile(auth, "utf8")).toContain('"b"');
  });
  it("drops another account's model cache even if the next account's refresh fails", async () => {
    let revision = "a", loads = 0;
    const snapshot = { fingerprint: "a", models: [] } as unknown as CodexModelCatalogSnapshot;
    const catalog = new ContextualModelCatalog("app-server", () => revision, () => {
      loads++; return { getCatalog: async () => { if (revision === "b") throw new Error("offline"); return snapshot; }, getCachedCatalog: () => snapshot };
    });
    expect(await catalog.getCatalog()).toBe(snapshot); revision = "b";
    expect(catalog.getCachedCatalog()).toBeUndefined();
    await expect(catalog.getCatalog()).rejects.toThrow("offline"); expect(loads).toBe(2);
  });
  it("allows authentication setup after an initial lazy admission failure without demanding a restart", async () => {
    const f = await fixture(), home = path.join(f.root, ".codex"); await mkdir(home);
    let ready = false;
    const upstream = new LazyCodexUpstream("app-server", APP_SERVER_CAPABILITIES, async () => {
      if (!ready) throw new Error("CODEX_AUTH_REQUIRED");
      return { listTools: async () => ({}), close: async () => {}, callTool: async () => ({ content: [] }) };
    }, undefined, f.service.admissionGuard());
    await expect(upstream.callTool("codex", {})).rejects.toThrow("CODEX_AUTH_REQUIRED");
    await writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "new-login" } }));
    ready = true;
    await expect(upstream.callTool("codex", {})).resolves.toEqual({ content: [] });
    await upstream.close();
  });
  it("does not make model authentication or quota queries depend on optional billing access", async () => {
    const f = await fixture();
    vi.spyOn(f.service, "readCliAccount").mockResolvedValue(projectCodexAccount({ account: { type: "apiKey" } }, null));
    const billing = vi.spyOn(f.service.billing, "snapshot").mockRejectedValue(new Error("billing offline"));
    expect((await f.service.readAccount("app-server"))?.authMode).toBe("api-key");
    expect(billing).not.toHaveBeenCalled();
  });
});

describe("account usage and billing projection", () => {
  it("preserves model display names and labels the Spark allowance without its internal codename", () => {
    const account = projectCodexAccount({ account: { type: "chatgpt" } }, { rateLimitsByLimitId: {
      codex_bengalfox: { primary: { usedPercent: 1, windowDurationMins: 10080 } },
      another: { limitName: "Another model", primary: { usedPercent: 2, windowDurationMins: 300 } }
    } });
    expect(account.windows.map(window => window.limitName)).toEqual(["GPT-5.3-Codex-Spark", "Another model"]);
  });
  const limits = { accountId: "private-account", rateLimitsByLimitId: { codex: { limitId: "codex",
    primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 100 }, secondary: { usedPercent: 80, windowDurationMins: 10080 },
    credits: { hasCredits: true, unlimited: false, balance: "12.5" } } }, rateLimitResetCredits: { availableCount: 2 } };
  it("retains short and weekly windows and distinguishes additional credits from reset coupons", () => {
    const result = projectCodexAccount({ account: { type: "chatgpt", email: "private@example.com", planType: "plus" } }, limits);
    expect(result.windows.map(window => window.remainingPercent)).toEqual([70, 20]);
    expect(result.credits?.balance).toBe("12.5"); expect(result.resetCredits?.availableCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.billing.costsAvailable).toBe(false);
  });
  it("never assigns ChatGPT quotas or credit balances to API usage, or treats unavailable costs as zero", () => {
    const result = projectCodexAccount({ account: { type: "apiKey" } }, limits);
    expect(result).toMatchObject({ authMode: "api-key", windows: [], credits: null, resetCredits: null, billing: { kind: "api", costsAvailable: false } });
    expect(projectCodexAccount(null, null)).toMatchObject({ authenticated: false, windows: [], accountKey: null, billing: { kind: "unknown" } });
    expect(estimateCodexCost({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, null)).toBeNull();
  });
  it("labels estimates and avoids charging cached input twice or inventing a price", () => {
    expect(estimateCodexCost({ inputTokens: 1000000, cachedInputTokens: 500000, outputTokens: 1000000 },
      { inputPerMillion: 2, cachedInputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-05" })).toEqual({ kind: "estimate", usd: 5.5, asOf: "2026-09-05" });
    expect(estimateCodexCost({ inputTokens: 1, cachedInputTokens: 2, outputTokens: 1 },
      { inputPerMillion: 2, cachedInputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-05" })).toBeNull();
  });
});
