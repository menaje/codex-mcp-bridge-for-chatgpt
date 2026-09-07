import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODEX_CLI_TEST_VERSION,
  parseCodexCliVersion,
  probeCodexCliVersion,
  verifyCodexCli
} from "../src/appServerCompatibility.js";
import { verifyCliConnection } from "../src/runtimeCompatibility.js";
import {
  assertAppServerSchemaMatches,
  fingerprintGeneratedDirectory,
  validateAppServerSchemaLock,
  type AppServerSchemaLock
} from "../scripts/app-server-schema.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

describe("App Server compatibility contract", () => {
  it("parses the official CLI version shape and uses the manifest pin", async () => {
    expect(CODEX_CLI_TEST_VERSION).toBe("0.153.3");
    expect(parseCodexCliVersion("codex-cli 0.153.3\n")).toBe("0.153.3");
    await expect(probeCodexCliVersion(FAKE_CODEX, 2_000)).resolves.toBe(CODEX_CLI_TEST_VERSION);
  });

  it.each(["0.144.0", "0.153.4", "99.0.0", "100.0.0-alpha.1"])("accepts the diagnostic version %s without a bridge allowlist", async version => {
    await expect(verifyCodexCli("selected-codex", 500, async () => version)).resolves.toBe(version);
  });

  it.each([true, false])("checks an isolated public connection and cleans up (valid=%s)", async valid => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-connection-test-"));
    const executable = path.join(root, "codex.mjs");
    const log = path.join(root, "request.json");
    const result = valid
      ? { userAgent: "future-codex", platformFamily: "unix", platformOs: "test", futureField: { enabled: true } }
      : { userAgent: "future-codex", platformFamily: "unix" };
    writeFileSync(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  writeFileSync(process.env.CONNECTION_TEST_LOG, JSON.stringify({ message, home: process.env.CODEX_HOME, args: process.argv.slice(2) }));
  process.stdout.write(JSON.stringify({ id: message.id, result: ${JSON.stringify(result)} }) + "\\n");
});
`, { mode: 0o700 });
    try {
      const connection = verifyCliConnection(executable, {
        ...process.env, CODEX_HOME: root, CONNECTION_TEST_LOG: log
      });
      if (valid) await expect(connection).resolves.toBeUndefined();
      else await expect(connection).rejects.toThrow(/CODEX_PROTOCOL_INCOMPATIBLE.*platformOs/);
      const request = JSON.parse(readFileSync(log, "utf8"));
      expect(request.args).toEqual(["app-server", "--listen", "stdio://"]);
      expect(request.message.method).toBe("initialize");
      expect(request.home).not.toBe(root);
      expect(existsSync(request.home)).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not copy command output or child-process details into admission errors", async () => {
    const secretDetail = "/private/operator/path: SECRET_STDERR";
    let failure: Error | undefined;
    try {
      await verifyCodexCli("configured-codex", 500, async () => {
        throw new Error(secretDetail);
      });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain('Configured Codex executable "configured-codex" could not be verified');
    expect(failure?.message).not.toContain(secretDetail);
  });

  it("canonicalizes JSON object order and TypeScript platform line endings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-schema-fingerprint-"));
    const firstJson = path.join(root, "first-json");
    const secondJson = path.join(root, "second-json");
    const firstTs = path.join(root, "first-ts");
    const secondTs = path.join(root, "second-ts");
    for (const directory of [firstJson, secondJson, firstTs, secondTs]) mkdirSync(directory);
    try {
      writeFileSync(path.join(firstJson, "schema.json"), '{"b":2,"a":{"y":2,"x":1}}\n');
      writeFileSync(path.join(secondJson, "schema.json"), '{"a":{"x":1,"y":2},"b":2}\n');
      writeFileSync(path.join(firstTs, "Protocol.ts"), "export type Protocol = string;  \r\n");
      writeFileSync(path.join(secondTs, "Protocol.ts"), "export type Protocol = string;\n");

      expect(fingerprintGeneratedDirectory(firstJson, "json")).toEqual(
        fingerprintGeneratedDirectory(secondJson, "json")
      );
      expect(fingerprintGeneratedDirectory(firstTs, "typescript")).toEqual(
        fingerprintGeneratedDirectory(secondTs, "typescript")
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates the minimal lock and detects a generated schema drift", () => {
    const raw = JSON.parse(readFileSync(path.join(REPO_ROOT, "app-server-schema.lock.json"), "utf8"));
    const expected = validateAppServerSchemaLock(raw);
    expect(expected).toMatchObject({
      supportedCodexCliVersion: CODEX_CLI_TEST_VERSION,
      includeExperimental: true,
      jsonSchema: { fileCount: 416 },
      typescript: { fileCount: 827 }
    });
    const actual: AppServerSchemaLock = {
      ...expected,
      jsonSchema: { ...expected.jsonSchema, sha256: "0".repeat(64) }
    };
    expect(() => assertAppServerSchemaMatches(expected, actual)).toThrow(
      /protocol schema drift detected in jsonSchema/
    );
  });
});
