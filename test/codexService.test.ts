import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexService } from "../src/codexService.js";
import { CodexSdkUpstream, SDK_CAPABILITIES } from "../src/sdkUpstream.js";
import { LazyCodexUpstream } from "../src/lazyUpstream.js";
import { ContextualModelCatalog } from "../src/contextualModelCatalog.js";
import type { CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import { projectCodexAccount, estimateCodexCost } from "../src/codexAccount.js";
import { projectSdkResolution } from "../src/sdkBundleResolution.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "codex-service-test-")); roots.push(root);
  const environment = { HOME: root, PATH: "", CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime") };
  return { root, environment, service: new CodexService(environment) };
}

describe("Codex execution context", () => {
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
  it("separates persistence from app sharing, preserves private thread bindings after preference changes and restart", async () => {
    const f = await fixture();
    const privatePolicy = await f.service.sessionPolicy("codex-sdk", false);
    const sharedPolicy = await f.service.sessionPolicy("codex-sdk", true);
    expect(privatePolicy).toMatchObject({ persistent: true, visibleInCodexApp: false });
    expect(sharedPolicy).toMatchObject({ persistent: true, visibleInCodexApp: true });
    expect(privatePolicy.contextId).not.toBe(sharedPolicy.contextId);
    f.service.bindThread("thread-private", f.service.context(privatePolicy.contextId!));
    const reentered = new CodexService(f.environment);
    expect(reentered.threadContext("thread-private").id).toBe(privatePolicy.contextId);
    await expect(reentered.sessionPolicy("codex-sdk", true, "thread-private")).rejects.toThrow("SDK_FORK_STORAGE_CHANGE");
    expect(() => reentered.threadContext("legacy-unbound")).toThrow("SDK_SESSION_CONTEXT_UNKNOWN");
  });
  it("never advertises app sharing for API profiles or an unconfirmed custom app home", async () => {
    const f = await fixture();
    await mkdir(path.join(f.environment.CODEX_MCP_BRIDGE_RUNTIME_HOME, "sdk"), { recursive: true });
    await writeFile(path.join(f.environment.CODEX_MCP_BRIDGE_RUNTIME_HOME, "sdk", "auth-policy.json"), JSON.stringify({ schemaVersion: 1, requestedAuthMode: "api-key", apiBillingConfirmedAt: new Date().toISOString() }));
    expect(await f.service.sessionPolicy("codex-sdk", true)).toMatchObject({ persistent: true, visibleInCodexApp: false });
    expect((await f.service.sdkContext(true)).home).toContain("profiles/api-key");
    const other = await fixture();
    expect(await new CodexService({ ...other.environment, CODEX_HOME: path.join(other.root, "custom") }).sessionPolicy("codex-sdk", true)).toMatchObject({ visibleInCodexApp: false });
  });
  it("routes SDK continuations and forks to their original profile, including after adapter recreation", async () => {
    const f = await fixture(), calls: string[] = [];
    const first = await f.service.sdkContext(false), second = await f.service.sdkContext(true);
    const create = () => new CodexSdkUpstream(1, {}, f.environment, f.service, context => new LazyCodexUpstream("codex-sdk", SDK_CAPABILITIES, async () => ({
      listTools: async () => ({}), close: async () => {},
      callTool: async (name, args, _progress, assigned) => {
        expect(args).not.toHaveProperty("_bridgeCodexContext"); calls.push(context.id);
        const threadId = name === "codex" ? `thread-${context.id}` : String(args.threadId);
        assigned?.({ backendKind: "codex-sdk", workerId: `sdk-${context.id}-0`, workerGeneration: 1, threadId });
        return { content: [], structuredContent: { threadId, backendKind: "codex-sdk" } };
      }
    })));
    const sdk = create();
    await sdk.callTool("codex", { _bridgeCodexContext: first.id });
    await sdk.callTool("codex", { _bridgeCodexContext: second.id });
    await sdk.close();
    const resumed = create();
    await resumed.callTool("codex-reply", { threadId: `thread-${first.id}` });
    expect(calls).toEqual([first.id, second.id, first.id]); await resumed.close();
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
    const upstream = new LazyCodexUpstream("codex-sdk", SDK_CAPABILITIES, async () => {
      if (!ready) throw new Error("SDK_AUTH_REQUIRED");
      return { listTools: async () => ({}), close: async () => {}, callTool: async () => ({ content: [] }) };
    }, undefined, f.service.admissionGuard());
    await expect(upstream.callTool("codex", {})).rejects.toThrow("SDK_AUTH_REQUIRED");
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

describe("SDK latest bundle resolution", () => {
  const wheel = (name: string, version: string, requires_dist?: string[]) => ({ metadata: { name, version, requires_dist },
    download_info: { url: `https://files.pythonhosted.org/${name}.whl`, archive_info: { hashes: { sha256: "a".repeat(64) } } } });
  it("installs the SDK's exact CLI dependency rather than the independently latest CLI and freezes every wheel", () => {
    const result = projectSdkResolution({ install: [wheel("openai-codex", "0.148.0", ["openai-codex-cli-bin==0.147.5"]), wheel("openai-codex-cli-bin", "0.147.5"), wheel("pydantic", "2.13.5")] }, "0.148.0");
    expect(result.codexRuntime).toBe("0.147.5"); expect(result.requirements.match(/--hash=sha256/g)).toHaveLength(3);
  });
  it("rejects source builds, untrusted wheel URLs, and mismatched CLI dependencies", () => {
    const sdk = wheel("openai-codex", "0.148.0", ["openai-codex-cli-bin==0.147.5"]), cli = wheel("openai-codex-cli-bin", "0.148.0");
    expect(() => projectSdkResolution({ install: [sdk, cli] }, "0.148.0")).toThrow("SDK_RUNTIME_DEPENDENCY_MISMATCH");
    sdk.download_info.url = "https://example.com/unsafe.whl";
    expect(() => projectSdkResolution({ install: [sdk, cli] }, "0.148.0")).toThrow("SDK_RESOLUTION_UNTRUSTED");
  });
});
