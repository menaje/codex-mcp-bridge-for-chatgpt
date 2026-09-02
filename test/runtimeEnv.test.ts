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
  commitRuntimeEnvUpdate,
  defaultRuntimeEnvFile,
  inspectRuntimeEnvFile,
  loadRuntimeEnvFile,
  prepareRuntimeEnvUpdate,
  readRuntimeEnvSubset,
  repairRuntimeEnvPermissions,
  resolveRuntimeEnvFile,
  rollbackRuntimeEnvUpdate,
  updateRuntimeEnvFile,
  validateSecureTunnelEnvironment
} from "../scripts/runtime-env.mjs";

const originalApiKey = process.env.CONTROL_PLANE_API_KEY;
const originalTunnelId = process.env.CONTROL_PLANE_TUNNEL_ID;
const originalAllowedTest = process.env.APP_ALLOWED_TEST;
const originalBlockedTest = process.env.APP_BLOCKED_TEST;

afterEach(() => {
  restoreEnvironment("CONTROL_PLANE_API_KEY", originalApiKey);
  restoreEnvironment("CONTROL_PLANE_TUNNEL_ID", originalTunnelId);
  restoreEnvironment("APP_ALLOWED_TEST", originalAllowedTest);
  restoreEnvironment("APP_BLOCKED_TEST", originalBlockedTest);
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

    writeFileSync(path.join(repo, ".env"), "CONTROL_PLANE_TUNNEL_ID=tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr\n", { mode: 0o600 });
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
      "CONTROL_PLANE_API_KEY=sk-file-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_ffffffffffffffffffffffffffffffff\n",
      { mode: 0o600 }
    );
    process.env.CONTROL_PLANE_API_KEY = "sk-exported-1234567890123456";
    delete process.env.CONTROL_PLANE_TUNNEL_ID;

    expect(loadRuntimeEnvFile(file)).toBe(true);
    expect(process.env.CONTROL_PLANE_API_KEY).toBe("sk-exported-1234567890123456");
    expect(process.env.CONTROL_PLANE_TUNNEL_ID).toBe("tunnel_ffffffffffffffffffffffffffffffff");
  });

  it("can load only an app-managed allowlist while preserving the file", () => {
    const root = temporaryDirectory();
    const file = path.join(root, ".env");
    const contents = [
      "APP_ALLOWED_TEST='selected value'",
      "APP_BLOCKED_TEST=must-not-load",
      ""
    ].join("\n");
    writeFileSync(file, contents, { mode: 0o600 });
    delete process.env.APP_ALLOWED_TEST;
    delete process.env.APP_BLOCKED_TEST;

    expect(loadRuntimeEnvFile(file, {
      allowedKey: (key: string) => key === "APP_ALLOWED_TEST"
    })).toBe(true);
    expect(process.env.APP_ALLOWED_TEST).toBe("selected value");
    expect(process.env.APP_BLOCKED_TEST).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(contents);
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

  it("repairs only an owned regular dotenv and its direct directory permissions", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    const contents = [
      "# retained comment",
      "CONTROL_PLANE_API_KEY=sk-runtime-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
      "UNRELATED_SETTING=retained",
      ""
    ].join("\n");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(file, contents, { mode: 0o600 });
    chmodSync(directory, 0o755);
    expect(inspectRuntimeEnvFile(file)).toMatchObject({
      valid: false,
      issue: expect.stringContaining("directory permissions are too broad")
    });
    chmodSync(file, 0o644);

    expect(readRuntimeEnvSubset(
      file,
      ["UNRELATED_SETTING"],
      { allowBroadReadOnlyPermissions: true }
    )).toEqual({ UNRELATED_SETTING: "retained" });
    expect(repairRuntimeEnvPermissions(file)).toMatchObject({ valid: true });
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("repairs an owned over-readable configuration directory before first dotenv creation", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "existing-config");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o755 });

    expect(inspectRuntimeEnvFile(file)).toMatchObject({
      exists: false,
      valid: false,
      issue: expect.stringContaining("directory permissions are too broad")
    });
    expect(repairRuntimeEnvPermissions(file)).toMatchObject({
      exists: false,
      valid: false,
      issue: expect.stringContaining("not configured")
    });
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);

    expect(updateRuntimeEnvFile(file, {
      apiKey: "sk-first-run-1234567890123456",
      tunnelId: "tunnel_ffffffffffffffffffffffffffffffff"
    })).toMatchObject({ valid: true });
  });

  it("does not auto-repair group-writable runtime configuration", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "shared");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(file, [
      "CONTROL_PLANE_API_KEY=sk-runtime-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
      ""
    ].join("\n"), { mode: 0o600 });
    chmodSync(directory, 0o770);
    chmodSync(file, 0o660);

    expect(() => readRuntimeEnvSubset(
      file,
      ["CONTROL_PLANE_TUNNEL_ID"],
      { allowBroadReadOnlyPermissions: true }
    )).toThrow("permissions are too broad");
    expect(() => repairRuntimeEnvPermissions(file)).toThrow("group or world writable");
    expect(lstatSync(directory).mode & 0o777).toBe(0o770);
    expect(lstatSync(file).mode & 0o777).toBe(0o660);
  });

  it("validates secure tunnel values without returning them in errors", () => {
    expect(validateSecureTunnelEnvironment({
      CONTROL_PLANE_API_KEY: "sk-runtime-1234567890123456",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
    }, "/private/.env")).toEqual({
      apiKey: "sk-runtime-1234567890123456",
      tunnelId: "tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
    });

    expect(() => validateSecureTunnelEnvironment({
      CONTROL_PLANE_API_KEY: "<runtime-key>",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
    }, "/private/.env")).toThrow("malformed or still a placeholder");
    expect(() => validateSecureTunnelEnvironment({
      CONTROL_PLANE_API_KEY: "sk-runtime-1234567890123456",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_too-short"
    }, "/private/.env")).toThrow("32 lowercase letters or digits");
  });

  it("atomically creates a private dotenv and reports only redacted presence", () => {
    const root = temporaryDirectory();
    const file = path.join(root, "private", ".env");
    const status = updateRuntimeEnvFile(file, {
      apiKey: "sk-native-1234567890123456",
      tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn"
    });

    expect(lstatSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(status).toEqual({
      path: file,
      exists: true,
      valid: true,
      hasApiKey: true,
      hasTunnelId: true,
      tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
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
        "CONTROL_PLANE_TUNNEL_ID=tunnel_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );

    updateRuntimeEnvFile(file, {
      apiKey: "",
      tunnelId: "tunnel_pppppppppppppppppppppppppppppppp"
    });

    expect(readFileSync(file, "utf8")).toBe([
      "# operator note",
      "UNKNOWN_SETTING=keep-me",
      "CONTROL_PLANE_API_KEY=sk-existing-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_pppppppppppppppppppppppppppppppp",
      ""
    ].join("\n"));
  });

  it("accepts quoted values with inline comments and preserves those comments on replacement", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(file, [
      "export CONTROL_PLANE_API_KEY = \"sk-existing-1234567890123456\" # runtime key note",
      "CONTROL_PLANE_TUNNEL_ID = 'tunnel_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' # tunnel note",
      ""
    ].join("\n"), { mode: 0o600 });

    expect(inspectRuntimeEnvFile(file)).toMatchObject({ valid: true });
    updateRuntimeEnvFile(file, {
      apiKey: "",
      tunnelId: "tunnel_pppppppppppppppppppppppppppppppp"
    });

    expect(readFileSync(file, "utf8")).toBe([
      "export CONTROL_PLANE_API_KEY = \"sk-existing-1234567890123456\" # runtime key note",
      "CONTROL_PLANE_TUNNEL_ID = tunnel_pppppppppppppppppppppppppppppppp # tunnel note",
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
      "CONTROL_PLANE_TUNNEL_ID=tunnel_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
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
      "CONTROL_PLANE_TUNNEL_ID=tunnel_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    ].join("\r\n"));
  });

  it("keeps the original dotenv when the atomic replacement fails", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    const original = [
      "CONTROL_PLANE_API_KEY=sk-original-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo",
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

  it("stages without changing disk and can roll back a committed replacement", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    const original = [
      "CODEX_HOME=/private/codex-home",
      "CONTROL_PLANE_API_KEY=sk-original-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo",
      ""
    ].join("\n");
    writeFileSync(file, original, { mode: 0o600 });

    const prepared = prepareRuntimeEnvUpdate(file, {
      apiKey: "sk-next-12345678901234567890",
      tunnelId: "tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    });
    expect(prepared.changed).toBe(true);
    expect(prepared.tunnelIdChanged).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original);

    commitRuntimeEnvUpdate(prepared);
    expect(readFileSync(file, "utf8")).toContain("tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    rollbackRuntimeEnvUpdate(prepared);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("rejects a staged commit or rollback when another writer changed the file", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(
      file,
      "CONTROL_PLANE_API_KEY=sk-original-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo\n",
      { mode: 0o600 }
    );
    const prepared = prepareRuntimeEnvUpdate(file, { tunnelId: "tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    writeFileSync(
      file,
      "CONTROL_PLANE_API_KEY=sk-external-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\n",
      { mode: 0o600 }
    );
    expect(() => commitRuntimeEnvUpdate(prepared)).toThrow("RUNTIME_ENV_CHANGED");

    const committed = prepareRuntimeEnvUpdate(file, { tunnelId: "tunnel_cccccccccccccccccccccccccccccccc" });
    commitRuntimeEnvUpdate(committed);
    writeFileSync(
      file,
      "CONTROL_PLANE_API_KEY=sk-third-party-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_tttttttttttttttttttttttttttttttt\n",
      { mode: 0o600 }
    );
    expect(() => rollbackRuntimeEnvUpdate(committed)).toThrow("RUNTIME_ENV_CHANGED");
  });

  it("reads only requested helper settings from the private dotenv", () => {
    const root = temporaryDirectory();
    const file = path.join(root, ".env");
    writeFileSync(file, [
      "CONTROL_PLANE_API_KEY=sk-secret-1234567890123456",
      "CODEX_HOME='/private/codex home'",
      "CODEX_MCP_BRIDGE_CODEX=/opt/custom/codex",
      ""
    ].join("\n"), { mode: 0o600 });

    expect(readRuntimeEnvSubset(file, ["CODEX_HOME", "CODEX_MCP_BRIDGE_CODEX"]))
      .toEqual({
        CODEX_HOME: "/private/codex home",
        CODEX_MCP_BRIDGE_CODEX: "/opt/custom/codex"
      });
  });

  it("rejects a symlinked dotenv and an overly broad config directory", () => {
    const root = temporaryDirectory();
    const privateDirectory = path.join(root, "private");
    const target = path.join(privateDirectory, "target.env");
    const link = path.join(privateDirectory, ".env");
    mkdirSync(privateDirectory, { mode: 0o700 });
    writeFileSync(
      target,
      "CONTROL_PLANE_API_KEY=sk-target-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_gggggggggggggggggggggggggggggggg\n",
      { mode: 0o600 }
    );
    symlinkSync(target, link);
    expect(() => updateRuntimeEnvFile(link, { apiKey: "", tunnelId: "" }))
      .toThrow("regular, non-symlink file");

    const dangling = path.join(privateDirectory, "dangling.env");
    symlinkSync(path.join(privateDirectory, "missing-target.env"), dangling);
    expect(inspectRuntimeEnvFile(dangling)).toMatchObject({
      exists: true,
      valid: false,
      issue: expect.stringContaining("regular, non-symlink file")
    });
    expect(() => loadRuntimeEnvFile(dangling)).toThrow("regular, non-symlink file");
    expect(() => repairRuntimeEnvPermissions(dangling)).toThrow("regular, non-symlink file");
    expect(() => updateRuntimeEnvFile(dangling, {
      apiKey: "sk-new-1234567890123456",
      tunnelId: "tunnel_dddddddddddddddddddddddddddddddd"
    })).toThrow("regular, non-symlink file");

    const broadDirectory = path.join(root, "broad");
    mkdirSync(broadDirectory, { mode: 0o755 });
    expect(() => updateRuntimeEnvFile(path.join(broadDirectory, ".env"), {
      apiKey: "sk-new-1234567890123456",
      tunnelId: "tunnel_wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww"
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
