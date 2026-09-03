import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HARD_MAX_CONCURRENT_JOBS,
  enforceSandbox,
  findSensitiveFiles,
  isPathWithinRoot,
  loadConfig,
  requireAllowedCwd
} from "../src/config.js";

describe("config policy", () => {
  it("starts without a second allowed-root registry", () => {
    const config = loadConfig({
      CODEX_GPT_BRIDGE_NO_AUTH: "1"
    });

    expect(config.allowedRoots).toEqual([]);
    expect(config.mcpTransportMode).toBe("stateless");
    expect(config.mcpSessionIdleTtlMs).toBe(30 * 60 * 1000);
    expect(config.maxMcpSessions).toBe(64);
    expect(config.defaultSandbox).toBe("read-only");
    expect(config.defaultAccessStrategy).toBe("adaptive");
    expect(config.allowWorkspaceWrite).toBe(false);
    expect(config.allowDangerFullAccess).toBe(false);
    expect(config.defaultApprovalPolicy).toBe("on-request");
    expect(config.maxConcurrentJobs).toBe(HARD_MAX_CONCURRENT_JOBS);
    expect(config.enableRecoveryTools).toBe(false);
    expect(config).not.toHaveProperty("defaultModel");
    expect(config).not.toHaveProperty("defaultReasoningEffort");
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

  it("loads and validates bounded stateful MCP transport settings", () => {
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "stateful",
      CODEX_MCP_BRIDGE_MCP_SESSION_IDLE_TTL_MS: "120000",
      CODEX_MCP_BRIDGE_MAX_MCP_SESSIONS: "12"
    });

    expect(config.mcpTransportMode).toBe("stateful");
    expect(config.mcpSessionIdleTtlMs).toBe(120000);
    expect(config.maxMcpSessions).toBe(12);

    expect(() => loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "persistent"
    })).toThrow(/MCP transport mode/);
    expect(() => loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_MCP_SESSION_IDLE_TTL_MS: "0"
    })).toThrow(/positive integer/);
    expect(() => loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_MAX_MCP_SESSIONS: "0"
    })).toThrow(/positive integer/);
  });

  it("ignores retired automatic-policy model and effort seeds", () => {
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
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "30",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "3",
      CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS: "50",
      CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES: "2000000",
      CODEX_MCP_BRIDGE_JOB_STALE_AFTER_MS: "300000"
    });

    expect(config).not.toHaveProperty("defaultModel");
    expect(config).not.toHaveProperty("defaultReasoningEffort");
    expect(config.operatorModelCeiling).toEqual([
      { model: "gpt-5.6-sol", reasoningEffort: "max" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" }
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
      expect.stringContaining("AUTO_RESUME_TTL_MS is retired"),
      expect.stringContaining("DEFAULT_MODEL and CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT are retired")
    ]);
  });

  it("ignores either retired model seed independently", () => {
    for (const retired of [
      { CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "high" },
      { CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol" }
    ]) {
      const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", ...retired });
      expect(config).not.toHaveProperty("defaultModel");
      expect(config).not.toHaveProperty("defaultReasoningEffort");
      expect(config.startupWarnings).toEqual([
        expect.stringContaining("retired and ignored")
      ]);
    }
  });

  it("validates the operator selection ceiling", () => {
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

  it("enforces one hard maximum for active jobs and enables recovery only by explicit operator opt-in", () => {
    expect(() =>
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: String(HARD_MAX_CONCURRENT_JOBS + 1),
        CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS: String(HARD_MAX_CONCURRENT_JOBS + 1)
      })
    ).toThrow(new RegExp(`MAX_CONCURRENT_JOBS cannot exceed ${HARD_MAX_CONCURRENT_JOBS}`));

    const enabled = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ENABLE_RECOVERY_TOOLS: "1"
    });
    expect(enabled.enableRecoveryTools).toBe(true);
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

  it("admits registered folders anywhere by default and retains explicit legacy restrictions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-root-"));
    const other = mkdtempSync(path.join(tmpdir(), "bridge-other-"));

    expect(requireAllowedCwd(root, [realpathSync(root)])).toBe(realpathSync(root));
    expect(requireAllowedCwd(other, [])).toBe(realpathSync(other));
    expect(() => requireAllowedCwd(other, [realpathSync(root)])).toThrow(/legacy operator restriction/);
  });

  it("requires a project target to be an existing folder rather than a file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-folder-"));
    const file = path.join(root, "file.txt");
    writeFileSync(file, "not a folder");

    expect(() => requireAllowedCwd(file, [])).toThrow(/must be a folder/);
  });

  it("treats the filesystem root as a valid containment ceiling", () => {
    expect(requireAllowedCwd(tmpdir(), [path.parse(tmpdir()).root])).toBe(realpathSync(tmpdir()));
  });

  it("handles Windows drive roots without a doubled-separator boundary", () => {
    expect(isPathWithinRoot("C:\\workspace\\project", "C:\\", path.win32)).toBe(true);
    expect(isPathWithinRoot("D:\\workspace", "C:\\", path.win32)).toBe(false);
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
    const rustBuild = path.join(root, "target", "checkouts", "fixture");
    mkdirSync(vscodeTest, { recursive: true });
    mkdirSync(swiftBuild, { recursive: true });
    mkdirSync(rustBuild, { recursive: true });
    writeFileSync(path.join(vscodeTest, ".npmrc"), "registry=https://registry.npmjs.org\n");
    writeFileSync(path.join(swiftBuild, "test-pubkey.pem"), "public test fixture\n");
    writeFileSync(path.join(rustBuild, "test-pubkey.pem"), "public test fixture\n");

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
