import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultRuntimeEnvFile,
  inspectRuntimeEnvFile,
  loadRuntimeEnvFile,
  resolveRuntimeEnvFile,
  updateRuntimeEnvFile,
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

  it("atomically creates a private dotenv and reports only redacted presence", () => {
    const root = temporaryDirectory();
    const file = path.join(root, "private", ".env");
    const status = updateRuntimeEnvFile(file, {
      apiKey: "sk-native-1234567890123456",
      tunnelId: "tunnel_native123"
    });

    expect(lstatSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(status).toEqual({
      path: file,
      exists: true,
      valid: true,
      hasApiKey: true,
      hasTunnelId: true,
      tunnelId: "tunnel_native123",
      issue: null
    });
    expect(JSON.stringify(status)).not.toContain("sk-native");
  });

  it("preserves comments, unknown values, and a saved key when its input is blank", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(
      file,
      [
        "# operator note",
        "UNKNOWN_SETTING=keep-me",
        "CONTROL_PLANE_API_KEY=sk-existing-1234567890123456",
        "CONTROL_PLANE_TUNNEL_ID=tunnel_existing123",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );

    updateRuntimeEnvFile(file, {
      apiKey: "",
      tunnelId: "tunnel_replaced123"
    });

    expect(readFileSync(file, "utf8")).toBe([
      "# operator note",
      "UNKNOWN_SETTING=keep-me",
      "CONTROL_PLANE_API_KEY=sk-existing-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_replaced123",
      ""
    ].join("\n"));
  });

  it("preserves CRLF separators and the absence of a final newline", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    const original = [
      "# windows-style operator note",
      "UNKNOWN_SETTING=keep-me",
      "CONTROL_PLANE_API_KEY=sk-existing-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_existing123"
    ].join("\r\n");
    writeFileSync(file, original, { mode: 0o600 });

    updateRuntimeEnvFile(file, {
      apiKey: "sk-replaced-1234567890123456",
      tunnelId: ""
    });

    expect(readFileSync(file, "utf8")).toBe([
      "# windows-style operator note",
      "UNKNOWN_SETTING=keep-me",
      "CONTROL_PLANE_API_KEY=sk-replaced-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_existing123"
    ].join("\r\n"));
  });

  it("keeps the original dotenv when the atomic replacement fails", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    const original = [
      "CONTROL_PLANE_API_KEY=sk-original-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_original123",
      ""
    ].join("\n");
    writeFileSync(file, original, { mode: 0o600 });

    expect(() => updateRuntimeEnvFile(
      file,
      { apiKey: "sk-replacement-1234567890123456", tunnelId: "" },
      { renameFile: () => { throw new Error("simulated rename failure"); } }
    )).toThrow("simulated rename failure");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(inspectRuntimeEnvFile(file).valid).toBe(true);
  });

  it("rejects a symlinked dotenv and an overly broad config directory", () => {
    const root = temporaryDirectory();
    const privateDirectory = path.join(root, "private");
    const target = path.join(privateDirectory, "target.env");
    const link = path.join(privateDirectory, ".env");
    mkdirSync(privateDirectory, { mode: 0o700 });
    writeFileSync(
      target,
      "CONTROL_PLANE_API_KEY=sk-target-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_target123\n",
      { mode: 0o600 }
    );
    symlinkSync(target, link);
    expect(() => updateRuntimeEnvFile(link, { apiKey: "", tunnelId: "" }))
      .toThrow("regular, non-symlink file");

    const broadDirectory = path.join(root, "broad");
    mkdirSync(broadDirectory, { mode: 0o755 });
    expect(() => updateRuntimeEnvFile(path.join(broadDirectory, ".env"), {
      apiKey: "sk-new-1234567890123456",
      tunnelId: "tunnel_new123"
    })).toThrow("directory permissions are too broad");
  });
});

function temporaryDirectory() {
  return mkdtempSync(path.join(tmpdir(), "codex-mcp-runtime-env-"));
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
