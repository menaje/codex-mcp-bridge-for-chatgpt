import {
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
  SUPPORTED_CODEX_CLI_VERSION,
  parseCodexCliVersion,
  probeCodexCliVersion,
  verifySupportedCodexCli
} from "../src/appServerCompatibility.js";
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
    expect(SUPPORTED_CODEX_CLI_VERSION).toBe("0.145.0");
    expect(parseCodexCliVersion("codex-cli 0.145.0\n")).toBe("0.145.0");
    await expect(probeCodexCliVersion(FAKE_CODEX, 2_000)).resolves.toBe(SUPPORTED_CODEX_CLI_VERSION);
  });

  it("reports configured, expected, and observed versions on mismatch", async () => {
    await expect(
      verifySupportedCodexCli("/configured/codex", 500, async () => "0.144.0")
    ).rejects.toThrow(
      'Configured Codex executable "/configured/codex" reported version 0.144.0; this bridge supports exactly Codex CLI 0.145.0'
    );
  });

  it("does not copy command output or child-process details into admission errors", async () => {
    const secretDetail = "/private/operator/path: SECRET_STDERR";
    let failure: Error | undefined;
    try {
      await verifySupportedCodexCli("configured-codex", 500, async () => {
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
      supportedCodexCliVersion: SUPPORTED_CODEX_CLI_VERSION,
      includeExperimental: true,
      jsonSchema: { fileCount: 347 },
      typescript: { fileCount: 697 }
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
