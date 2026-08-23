import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { enforceSandbox, findSensitiveFiles, loadConfig, requireAllowedCwd } from "../src/config.js";

describe("config policy", () => {
  it("defaults to current directory as the only allowed root", () => {
    const config = loadConfig({
      CODEX_GPT_BRIDGE_NO_AUTH: "1"
    });

    expect(config.allowedRoots).toEqual([realpathSync(process.cwd())]);
    expect(config.defaultSandbox).toBe("read-only");
    expect(config.defaultAccessStrategy).toBe("adaptive");
    expect(config.allowWorkspaceWrite).toBe(false);
    expect(config.allowDangerFullAccess).toBe(false);
    expect(config.defaultApprovalPolicy).toBe("on-request");
    expect(config.maxConcurrentJobs).toBe(30);
    expect(config.defaultModel).toBeUndefined();
    expect(config.defaultReasoningEffort).toBeUndefined();
    expect(config.operatorModelCeiling).toBeUndefined();
    expect(config.modelCatalogCacheTtlMs).toBe(600000);
    expect(config.modelCatalogTimeoutMs).toBe(30000);
    expect(config.modelCatalogStateFile).toMatch(/\.codex-mcp-bridge\/models\.json$/);
    expect(config.stateDatabaseFile).toMatch(/\.codex-mcp-bridge\/state\.sqlite$/);
    expect(config.settingsStateFile).toMatch(/\.codex-mcp-bridge\/settings\.json$/);
    expect(config.sessionStateFile).toMatch(/\.codex-mcp-bridge\/sessions\.json$/);
    expect(config.jobStateFile).toMatch(/\.codex-mcp-bridge\/jobs\.json$/);
    expect(config).not.toHaveProperty("defaultSessionMode");
    expect(config).not.toHaveProperty("autoResumeTtlMs");
    expect(config).not.toHaveProperty("fastReturnMs");
    expect(config.defaultBackend).toBe("mcp-server");
    expect(config.upstreamPoolSize).toBe(4);
    expect(config.maxRetainedJobs).toBe(100);
    expect(config.maxJobResultBytes).toBe(1048576);
    expect(config.jobStaleAfterMs).toBe(600000);
    expect(config.startupWarnings).toEqual([]);
  });

  it("loads the optional exact automatic-policy model and effort seed", () => {
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max",
      CODEX_MCP_BRIDGE_MODEL_SELECTION_CEILING: '[{"model":"gpt-5.6-sol","reasoningEffort":"max"},{"model":"gpt-5.6-terra","reasoningEffort":"high","serviceTier":"priority"}]',
      CODEX_MCP_BRIDGE_MODEL_CATALOG_CACHE_TTL_MS: "120000",
      CODEX_MCP_BRIDGE_MODEL_CATALOG_TIMEOUT_MS: "15000",
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: "/tmp/codex-mcp-bridge-test-models.json",
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: "/tmp/codex-mcp-bridge-test-state.sqlite",
      CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE: "/tmp/codex-mcp-bridge-test-settings.json",
      CODEX_MCP_BRIDGE_SESSION_STATE_FILE: "/tmp/codex-mcp-bridge-test-sessions.json",
      CODEX_MCP_BRIDGE_JOB_STATE_FILE: "/tmp/codex-mcp-bridge-test-jobs.json",
      CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY: "read-only",
      CODEX_MCP_BRIDGE_DEFAULT_SESSION_MODE: "new",
      CODEX_MCP_BRIDGE_AUTO_RESUME_TTL_MS: "900000",
      CODEX_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS: "7200000",
      CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "3",
      CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS: "50",
      CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES: "2000000",
      CODEX_MCP_BRIDGE_JOB_STALE_AFTER_MS: "300000"
    });

    expect(config.defaultModel).toBe("gpt-5.6-sol");
    expect(config.defaultReasoningEffort).toBe("max");
    expect(config.operatorModelCeiling).toEqual([
      { model: "gpt-5.6-sol", reasoningEffort: "max" },
      { model: "gpt-5.6-terra", reasoningEffort: "high", serviceTier: "priority" }
    ]);
    expect(config.modelCatalogCacheTtlMs).toBe(120000);
    expect(config.modelCatalogTimeoutMs).toBe(15000);
    expect(config.modelCatalogStateFile).toBe("/tmp/codex-mcp-bridge-test-models.json");
    expect(config.stateDatabaseFile).toBe("/tmp/codex-mcp-bridge-test-state.sqlite");
    expect(config.settingsStateFile).toBe("/tmp/codex-mcp-bridge-test-settings.json");
    expect(config.sessionStateFile).toBe("/tmp/codex-mcp-bridge-test-sessions.json");
    expect(config.jobStateFile).toBe("/tmp/codex-mcp-bridge-test-jobs.json");
    expect(config.defaultAccessStrategy).toBe("read-only");
    expect(config).not.toHaveProperty("defaultSessionMode");
    expect(config).not.toHaveProperty("autoResumeTtlMs");
    expect(config.defaultBackend).toBe("app-server");
    expect(config.upstreamPoolSize).toBe(3);
    expect(config.maxRetainedJobs).toBe(50);
    expect(config.maxJobResultBytes).toBe(2000000);
    expect(config.jobStaleAfterMs).toBe(300000);
    expect(config.startupWarnings).toEqual([
      expect.stringContaining("UPSTREAM_TIMEOUT_MS is retired"),
      expect.stringContaining("DEFAULT_SESSION_MODE is retired"),
      expect.stringContaining("AUTO_RESUME_TTL_MS is retired")
    ]);
  });

  it("requires a default model when a default reasoning effort is configured", () => {
    expect(() =>
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "high"
      })
    ).toThrow(/requires CODEX_MCP_BRIDGE_DEFAULT_MODEL/);
  });

  it("requires an exact default pair and validates the operator selection ceiling", () => {
    expect(() => loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol"
    })).toThrow(/requires CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT/);
    expect(() => loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_MODEL_SELECTION_CEILING: "not-json"
    })).toThrow(/JSON array/);
    expect(() => loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_MODEL_SELECTION_CEILING: '[{"model":"gpt-5.6-sol"}]'
    })).toThrow(/reasoning effort/i);
  });

  it("requires an absolute session state file", () => {
    expect(() =>
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_SESSION_STATE_FILE: "relative/sessions.json"
      })
    ).toThrow(/absolute path/);
  });

  it("requires an absolute settings state file", () => {
    expect(() =>
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE: "relative/settings.json"
      })
    ).toThrow(/absolute path/);
  });

  it("requires an absolute job state file", () => {
    expect(() =>
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_JOB_STATE_FILE: "relative/jobs.json"
      })
    ).toThrow(/absolute path/);
  });

  it("requires an absolute SQLite state database file", () => {
    expect(() =>
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: "relative/state.sqlite"
      })
    ).toThrow(/absolute path/);
  });

  it("ignores the retired task-timeout environment value", () => {
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS: "10800001"
    });
    expect(config).not.toHaveProperty("upstreamTimeoutMs");
    expect(config.startupWarnings).toEqual([
      expect.stringContaining("retired and ignored")
    ]);
  });

  it("ignores the retired fast-return threshold with a migration warning", () => {
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_FAST_RETURN_MS: "25000"
    });
    expect(config).not.toHaveProperty("fastReturnMs");
    expect(config.startupWarnings).toEqual([
      expect.stringContaining("FAST_RETURN_MS is retired and ignored")
    ]);
  });

  it("rejects an unknown default Codex backend", () => {
    expect(() => loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "unknown"
    })).toThrow(/default Codex backend/);
  });

  it("ignores retired session defaults even when their values are invalid", () => {
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_DEFAULT_SESSION_MODE: "invalid",
      CODEX_MCP_BRIDGE_AUTO_RESUME_TTL_MS: "invalid"
    });
    expect(config.startupWarnings).toEqual([
      expect.stringContaining("DEFAULT_SESSION_MODE is retired"),
      expect.stringContaining("AUTO_RESUME_TTL_MS is retired")
    ]);
  });

  it("does not allow more upstream workers than active jobs", () => {
    expect(() =>
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2",
        CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "3"
      })
    ).toThrow(/UPSTREAM_POOL_SIZE/);
  });

  it("retains at least enough job records for every active job", () => {
    expect(() =>
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "30",
        CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS: "20"
      })
    ).toThrow(/MAX_RETAINED_JOBS/);
  });

  it("requires token or explicit local no-auth", () => {
    expect(() =>
      loadConfig({
        CODEX_GPT_BRIDGE_HOST: "127.0.0.1"
      })
    ).toThrow(/TOKEN/);

    expect(() =>
      loadConfig({
        CODEX_GPT_BRIDGE_HOST: "0.0.0.0",
        CODEX_GPT_BRIDGE_NO_AUTH: "1"
      })
    ).toThrow(/NO_AUTH/);
  });

  it("accepts explicit MCP HTTP allowed hosts", () => {
    const config = loadConfig({
      CODEX_GPT_BRIDGE_ALLOWED_HOSTS: "127.0.0.1,localhost,example.trycloudflare.com",
      CODEX_GPT_BRIDGE_NO_AUTH: "1"
    });

    expect(config.allowedHosts).toEqual(["127.0.0.1", "localhost", "example.trycloudflare.com"]);
  });

  it("rejects cwd outside allowed roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const other = mkdtempSync(path.join(tmpdir(), "bridge-other-"));

    expect(requireAllowedCwd(root, [realpathSync(root)])).toBe(realpathSync(root));
    expect(() => requireAllowedCwd(other, [realpathSync(root)])).toThrow(/outside allowed roots/);
  });

  it("blocks write sandboxes unless explicitly enabled", () => {
    const config = loadConfig({
      CODEX_GPT_BRIDGE_NO_AUTH: "1"
    });

    expect(enforceSandbox(config, "read-only")).toBe("read-only");
    expect(() => enforceSandbox(config, "workspace-write")).toThrow(/ALLOW_WRITE/);
    expect(() => enforceSandbox(config, "danger-full-access")).toThrow(/ALLOW_DANGER_FULL_ACCESS/);
    expect(() =>
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_DEFAULT_SANDBOX: "danger-full-access"
      })
    ).toThrow(/ALLOW_DANGER_FULL_ACCESS/);

    const fullAccess = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
      CODEX_MCP_BRIDGE_APPROVAL_POLICY: "never"
    });
    expect(enforceSandbox(fullAccess, "danger-full-access")).toBe("danger-full-access");
    expect(fullAccess.defaultSandbox).toBe("read-only");
    expect(fullAccess.defaultApprovalPolicy).toBe("never");
  });

  it("allows an always-full default strategy only when the owner capability is enabled", () => {
    expect(() =>
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY: "always-full"
      })
    ).toThrow(/ALLOW_DANGER_FULL_ACCESS/);

    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
      CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY: "always-full"
    });
    expect(config.defaultAccessStrategy).toBe("always-full");
  });

  it("finds sensitive-looking files before delegation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");
    writeFileSync(path.join(root, "server.pem"), "secret\n");

    expect(await findSensitiveFiles(root)).toEqual([path.join(root, ".env"), path.join(root, "server.pem")]);
  });

  it("allows a documented .env.example template", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    writeFileSync(path.join(root, ".env.example"), "TOKEN=replace-me\n");

    expect(await findSensitiveFiles(root)).toEqual([]);
  });

  it("fails closed when the working directory itself cannot be scanned", async () => {
    const rootFile = path.join(mkdtempSync(path.join(tmpdir(), "bridge-root-")), "not-a-directory");
    writeFileSync(rootFile, "plain file\n");

    await expect(findSensitiveFiles(rootFile)).rejects.toThrow(/Could not scan/);
  });

  it("ignores generated test and build directories", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const vscodeTest = path.join(root, ".vscode-test", "runtime");
    const swiftBuild = path.join(root, ".build", "checkouts", "fixture");
    mkdirSync(vscodeTest, { recursive: true });
    mkdirSync(swiftBuild, { recursive: true });
    writeFileSync(path.join(vscodeTest, ".npmrc"), "registry=https://registry.npmjs.org\n");
    writeFileSync(path.join(swiftBuild, "test-pubkey.pem"), "public test fixture\n");

    expect(await findSensitiveFiles(root)).toEqual([]);
  });

  it("blocks sensitive-looking symlink names before delegation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const target = path.join(root, "target");
    writeFileSync(target, "TOKEN=secret\n");
    symlinkSync(target, path.join(root, ".env"));

    expect(await findSensitiveFiles(root)).toEqual([path.join(root, ".env")]);
  });
});
