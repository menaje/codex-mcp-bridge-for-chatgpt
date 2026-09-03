import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SUPPORTED_CODEX_CLI_VERSION,
  verifySupportedCodexCli
} from "../src/appServerCompatibility.js";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_FILENAME = "app-server-schema.lock.json";
const GENERATION_TIMEOUT_MS = 120_000;

type SchemaFingerprint = {
  fileCount: number;
  sha256: string;
};

export type AppServerSchemaLock = {
  lockVersion: 1;
  supportedCodexCliVersion: string;
  includeExperimental: true;
  jsonSchema: SchemaFingerprint;
  typescript: SchemaFingerprint;
};

export function fingerprintGeneratedDirectory(
  directory: string,
  format: "json" | "typescript"
): SchemaFingerprint {
  const files = walkFiles(directory).sort();
  if (files.length === 0) throw new Error(`Codex generated no ${format} schema files.`);
  const digest = createHash("sha256");
  for (const file of files) {
    const relative = path.relative(directory, file).split(path.sep).join("/");
    const raw = readFileSync(file, "utf8");
    const normalized = format === "json"
      ? stableJson(parseGeneratedJson(raw, relative))
      : normalizeGeneratedTypeScript(raw);
    digest.update(relative);
    digest.update("\0");
    digest.update(normalized);
    digest.update("\0");
  }
  return { fileCount: files.length, sha256: digest.digest("hex") };
}

export function validateAppServerSchemaLock(
  value: unknown,
  expectedCodexCliVersion = SUPPORTED_CODEX_CLI_VERSION
): AppServerSchemaLock {
  const lock = requiredRecord(value, "App Server schema lock");
  assertExactKeys(
    lock,
    ["lockVersion", "supportedCodexCliVersion", "includeExperimental", "jsonSchema", "typescript"],
    "App Server schema lock"
  );
  if (lock.lockVersion !== 1) throw new Error("App Server schema lockVersion must be 1.");
  if (lock.supportedCodexCliVersion !== expectedCodexCliVersion) {
    throw new Error(
      `App Server schema lock targets Codex CLI ${String(lock.supportedCodexCliVersion)} but ` +
      `release-manifest.json supports ${expectedCodexCliVersion}. Run npm run app-server:compat:update with the supported CLI.`
    );
  }
  if (lock.includeExperimental !== true) {
    throw new Error("App Server schema lock must include experimental protocol fields.");
  }
  return {
    lockVersion: 1,
    supportedCodexCliVersion: expectedCodexCliVersion,
    includeExperimental: true,
    jsonSchema: validateFingerprint(lock.jsonSchema, "jsonSchema"),
    typescript: validateFingerprint(lock.typescript, "typescript")
  };
}

export function loadAppServerSchemaLock(
  repoRoot = DEFAULT_REPO_ROOT,
  expectedCodexCliVersion = SUPPORTED_CODEX_CLI_VERSION
): AppServerSchemaLock {
  const file = path.join(repoRoot, LOCK_FILENAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${LOCK_FILENAME} is missing or invalid. Run npm run app-server:compat:update.`);
  }
  return validateAppServerSchemaLock(parsed, expectedCodexCliVersion);
}

export function assertAppServerSchemaMatches(
  expected: AppServerSchemaLock,
  actual: AppServerSchemaLock
): void {
  const drift = (["jsonSchema", "typescript"] as const).filter((format) =>
    expected[format].fileCount !== actual[format].fileCount ||
    expected[format].sha256 !== actual[format].sha256
  );
  if (drift.length === 0) return;
  throw new Error(
    `Codex App Server protocol schema drift detected in ${drift.join(", ")} for CLI ` +
    `${expected.supportedCodexCliVersion}. Review the generated protocol before running ` +
    `npm run app-server:compat:update.`
  );
}

export async function generateAppServerSchemaLock(
  codexCommand = process.env.CODEX_MCP_BRIDGE_CODEX || "codex",
  repoRoot = DEFAULT_REPO_ROOT
): Promise<AppServerSchemaLock> {
  const supportedVersion = readManifestCodexCliVersion(repoRoot);
  if (supportedVersion !== SUPPORTED_CODEX_CLI_VERSION) {
    throw new Error("Runtime and release-manifest Codex CLI compatibility contracts disagree.");
  }
  await verifySupportedCodexCli(codexCommand);

  const temporary = mkdtempSync(path.join(tmpdir(), "codex-app-server-schema-"));
  const jsonDirectory = path.join(temporary, "json-schema");
  const typescriptDirectory = path.join(temporary, "typescript");
  const codexHome = path.join(temporary, "codex-home");
  mkdirSync(jsonDirectory);
  mkdirSync(typescriptDirectory);
  mkdirSync(codexHome);
  try {
    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      LANG: "C",
      LC_ALL: "C"
    };
    generateSchema(codexCommand, "generate-json-schema", jsonDirectory, repoRoot, env);
    generateSchema(codexCommand, "generate-ts", typescriptDirectory, repoRoot, env);
    return {
      lockVersion: 1,
      supportedCodexCliVersion: supportedVersion,
      includeExperimental: true,
      jsonSchema: fingerprintGeneratedDirectory(jsonDirectory, "json"),
      typescript: fingerprintGeneratedDirectory(typescriptDirectory, "typescript")
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function readManifestCodexCliVersion(repoRoot: string): string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path.join(repoRoot, "release-manifest.json"), "utf8"));
  } catch {
    throw new Error("Could not read the release-manifest Codex CLI compatibility contract.");
  }
  const toolchain = isRecord(manifest) ? manifest.toolchain : undefined;
  const version = isRecord(toolchain) ? toolchain.codexCli : undefined;
  if (typeof version !== "string") {
    throw new Error("release-manifest.json is missing toolchain.codexCli.");
  }
  return version;
}

export async function checkAppServerSchema(
  codexCommand = process.env.CODEX_MCP_BRIDGE_CODEX || "codex",
  repoRoot = DEFAULT_REPO_ROOT
): Promise<AppServerSchemaLock> {
  const expected = loadAppServerSchemaLock(repoRoot);
  const actual = await generateAppServerSchemaLock(codexCommand, repoRoot);
  assertAppServerSchemaMatches(expected, actual);
  return actual;
}

export async function updateAppServerSchemaLock(
  codexCommand = process.env.CODEX_MCP_BRIDGE_CODEX || "codex",
  repoRoot = DEFAULT_REPO_ROOT
): Promise<AppServerSchemaLock> {
  const lock = await generateAppServerSchemaLock(codexCommand, repoRoot);
  const file = path.join(repoRoot, LOCK_FILENAME);
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
  return lock;
}

function generateSchema(
  codexCommand: string,
  generator: "generate-json-schema" | "generate-ts",
  outputDirectory: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv
): void {
  try {
    execFileSync(
      codexCommand,
      ["app-server", generator, "--experimental", "--out", outputDirectory],
      {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GENERATION_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      }
    );
  } catch {
    throw new Error(
      `Configured Codex executable ${JSON.stringify(codexCommand)} could not run app-server ${generator} ` +
      `for supported CLI ${SUPPORTED_CODEX_CLI_VERSION}.`
    );
  }
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(file);
    if (entry.isFile() || entry.isSymbolicLink()) return [file];
    return [];
  });
}

function parseGeneratedJson(raw: string, relative: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Codex generated invalid JSON schema file ${relative}.`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  const primitive = JSON.stringify(value);
  if (primitive === undefined) throw new Error("Codex generated a non-JSON schema value.");
  return primitive;
}

function normalizeGeneratedTypeScript(value: string): string {
  return `${value.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd()}\n`;
}

function validateFingerprint(value: unknown, label: string): SchemaFingerprint {
  const fingerprint = requiredRecord(value, label);
  assertExactKeys(fingerprint, ["fileCount", "sha256"], label);
  if (!Number.isSafeInteger(fingerprint.fileCount) || fingerprint.fileCount <= 0) {
    throw new Error(`App Server ${label}.fileCount must be a positive integer.`);
  }
  if (typeof fingerprint.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint.sha256)) {
    throw new Error(`App Server ${label}.sha256 must be a SHA-256 digest.`);
  }
  return { fileCount: fingerprint.fileCount, sha256: fingerprint.sha256 };
}

function requiredRecord(value: unknown, label: string): Record<string, any> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}.`);
  }
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command === "check") {
    const lock = await checkAppServerSchema();
    console.log(
      `Codex App Server schemas match CLI ${lock.supportedCodexCliVersion} ` +
      `(${lock.jsonSchema.fileCount} JSON, ${lock.typescript.fileCount} TypeScript files).`
    );
    return;
  }
  if (command === "update") {
    const lock = await updateAppServerSchemaLock();
    console.log(`Updated ${LOCK_FILENAME} for Codex CLI ${lock.supportedCodexCliVersion}.`);
    return;
  }
  throw new Error("Usage: app-server-schema.ts <check|update>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
