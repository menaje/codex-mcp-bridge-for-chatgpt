import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultRuntimeEnvFile,
  loadRuntimeEnvFile,
  resolveRuntimeEnvFile,
  validateSecureTunnelEnvironment
} from "../scripts/runtime-env.mjs";

const originalApiKey = process.env.CONTROL_PLANE_API_KEY;
const originalTunnelId = process.env.CONTROL_PLANE_TUNNEL_ID;

afterEach(() => {
  restoreEnvironment("CONTROL_PLANE_API_KEY", originalApiKey);
  restoreEnvironment("CONTROL_PLANE_TUNNEL_ID", originalTunnelId);
});

describe("runtime environment", () => {
  it("defaults outside the repository and falls back to a repository .env", () => {
    const root = temporaryDirectory();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const operatorFile = defaultRuntimeEnvFile({ environment: {}, homeDirectory: home });
    expect(operatorFile).toBe(path.join(home, ".config", "codex-mcp-bridge", ".env"));
    expect(resolveRuntimeEnvFile({ environment: {}, homeDirectory: home, repoRoot: repo })).toBe(operatorFile);

    writeFileSync(path.join(repo, ".env"), "CONTROL_PLANE_TUNNEL_ID=tunnel_repo123\n", { mode: 0o600 });
    expect(resolveRuntimeEnvFile({ environment: {}, homeDirectory: home, repoRoot: repo })).toBe(
      path.join(repo, ".env")
    );
  });

  it("prefers an explicit path and CODEX_MCP_BRIDGE_ENV_FILE", () => {
    const root = temporaryDirectory();
    expect(resolveRuntimeEnvFile({
      explicitPath: "explicit.env",
      environment: { CODEX_MCP_BRIDGE_ENV_FILE: "ignored.env" },
      repoRoot: root
    })).toBe(path.join(root, "explicit.env"));
    expect(resolveRuntimeEnvFile({
      environment: { CODEX_MCP_BRIDGE_ENV_FILE: "selected.env" },
      repoRoot: root
    })).toBe(path.join(root, "selected.env"));
  });

  it("loads a private regular dotenv file without overriding exported values", () => {
    const root = temporaryDirectory();
    const file = path.join(root, ".env");
    writeFileSync(
      file,
      "CONTROL_PLANE_API_KEY=sk-file-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_file1234\n",
      { mode: 0o600 }
    );
    process.env.CONTROL_PLANE_API_KEY = "sk-exported-1234567890123456";
    delete process.env.CONTROL_PLANE_TUNNEL_ID;

    expect(loadRuntimeEnvFile(file)).toBe(true);
    expect(process.env.CONTROL_PLANE_API_KEY).toBe("sk-exported-1234567890123456");
    expect(process.env.CONTROL_PLANE_TUNNEL_ID).toBe("tunnel_file1234");
  });

  it("rejects broad permissions and symlinks", () => {
    const root = temporaryDirectory();
    const broad = path.join(root, "broad.env");
    const target = path.join(root, "target.env");
    const link = path.join(root, "link.env");
    writeFileSync(broad, "TOKEN=value\n", { mode: 0o600 });
    chmodSync(broad, 0o644);
    writeFileSync(target, "TOKEN=value\n", { mode: 0o600 });
    symlinkSync(target, link);

    expect(() => loadRuntimeEnvFile(broad)).toThrow("permissions are too broad");
    expect(() => loadRuntimeEnvFile(link)).toThrow("regular, non-symlink file");
  });

  it("validates secure tunnel values without returning them in errors", () => {
    expect(validateSecureTunnelEnvironment({
      CONTROL_PLANE_API_KEY: "sk-runtime-1234567890123456",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_runtime123"
    }, "/private/.env")).toEqual({
      apiKey: "sk-runtime-1234567890123456",
      tunnelId: "tunnel_runtime123"
    });

    expect(() => validateSecureTunnelEnvironment({
      CONTROL_PLANE_API_KEY: "<runtime-key>",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_runtime123"
    }, "/private/.env")).toThrow("malformed or still a placeholder");
  });
});

function temporaryDirectory() {
  return mkdtempSync(path.join(tmpdir(), "codex-mcp-runtime-env-"));
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
