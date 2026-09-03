import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION_PLACEHOLDER = "0.0.0";
const ALLOWED_KINDS = new Set(["npm", "macos"]);

export function digestPayloadDirectory(directory, kind) {
  if (!ALLOWED_KINDS.has(kind)) throw new Error("Payload kind must be npm or macos.");
  const root = realpathSync(directory);
  const entries = walk(root);
  const hash = createHash("sha256");
  let fileCount = 0;
  for (const entry of entries) {
    const relative = entry.relative.split(path.sep).join("/");
    if (excludedPayloadPath(relative, kind)) continue;
    const stat = lstatSync(entry.absolute);
    const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
    if (stat.isDirectory()) {
      hash.update(`directory\0${relative}\0${mode}\0`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      hash.update(`symlink\0${relative}\0${mode}\0${readlinkSync(entry.absolute)}\0`);
      fileCount += 1;
      continue;
    }
    if (!stat.isFile()) throw new Error(`Unsupported payload entry: ${relative}.`);
    const content = normalizedFileContent(entry.absolute, relative, kind);
    hash.update(`file\0${relative}\0${mode}\0${content.length}\0`);
    hash.update(content);
    hash.update("\0");
    fileCount += 1;
  }
  return { kind, digest: hash.digest("hex"), fileCount };
}

export function comparePayloadDirectories(candidateDirectory, stableDirectory, kind) {
  const candidate = digestPayloadDirectory(candidateDirectory, kind);
  const stable = digestPayloadDirectory(stableDirectory, kind);
  if (candidate.digest !== stable.digest || candidate.fileCount !== stable.fileCount) {
    throw new Error(
      `${kind} payload changed outside the allowed RC-to-stable metadata boundary: ` +
      `${candidate.digest}/${candidate.fileCount} != ${stable.digest}/${stable.fileCount}.`
    );
  }
  return { kind, digest: stable.digest, fileCount: stable.fileCount, equivalent: true };
}

export function compareReleaseArtifacts(candidateArtifact, stableArtifact, kind) {
  if (!ALLOWED_KINDS.has(kind)) throw new Error("Payload kind must be npm or macos.");
  const temporary = mkdtempSync(path.join(tmpdir(), `codex-release-payload-${kind}-`));
  try {
    const candidateDirectory = path.join(temporary, "candidate");
    const stableDirectory = path.join(temporary, "stable");
    if (kind === "npm") {
      unpackNpmArchive(candidateArtifact, candidateDirectory);
      unpackNpmArchive(stableArtifact, stableDirectory);
    } else {
      if (process.platform !== "darwin") throw new Error("macOS DMG comparison requires macOS.");
      unpackMacDmg(candidateArtifact, candidateDirectory);
      unpackMacDmg(stableArtifact, stableDirectory);
      stripMacSignatures(candidateDirectory);
      stripMacSignatures(stableDirectory);
    }
    return comparePayloadDirectories(candidateDirectory, stableDirectory, kind);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function unpackNpmArchive(archive, destination) {
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > 50_000) throw new Error("npm archive has an invalid entry count.");
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, "");
    if (
      normalized.startsWith("/") ||
      normalized.includes("\\") ||
      normalized.split("/").some((segment) => segment === "..") ||
      !(normalized === "package" || normalized.startsWith("package/"))
    ) {
      throw new Error(`npm archive contains an unsafe path: ${entry}.`);
    }
  }
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destination]);
}

function unpackMacDmg(dmg, destination) {
  const mountRoot = mkdtempSync(path.join(tmpdir(), "codex-release-dmg-mount-"));
  let mounted = false;
  try {
    execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountRoot, dmg], {
      stdio: "ignore"
    });
    mounted = true;
    const apps = readdirSync(mountRoot).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("Release DMG must contain exactly one app bundle.");
    execFileSync("ditto", [path.join(mountRoot, apps[0]), destination]);
  } finally {
    if (mounted) execFileSync("hdiutil", ["detach", mountRoot], { stdio: "ignore" });
    rmSync(mountRoot, { recursive: true, force: true });
  }
}

function stripMacSignatures(root) {
  const candidates = walk(root)
    .filter((entry) => lstatSync(entry.absolute).isFile() && isMachO(entry.absolute))
    .map((entry) => entry.absolute)
    .sort((left, right) => right.length - left.length);
  for (const file of candidates) {
    const display = spawnSync("codesign", ["--display", file], { stdio: "ignore" });
    if (display.status !== 0) continue;
    chmodSync(file, lstatSync(file).mode | 0o200);
    execFileSync("codesign", ["--remove-signature", file], { stdio: "ignore" });
  }
}

function isMachO(file) {
  const descriptor = openSync(file, "r");
  try {
    const magic = Buffer.allocUnsafe(4);
    if (readSync(descriptor, magic, 0, 4, 0) !== 4) return false;
    return new Set([
      "feedface",
      "cefaedfe",
      "feedfacf",
      "cffaedfe",
      "cafebabe",
      "bebafeca",
      "cafebabf",
      "bfbafeca"
    ]).has(magic.toString("hex"));
  } finally {
    closeSync(descriptor);
  }
}

function normalizedFileContent(file, relative, kind) {
  if (kind === "macos" && (relative === "Contents/Info.plist" || relative.endsWith("/Contents/Info.plist"))) {
    const json = execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
    const value = JSON.parse(json);
    value.CFBundleShortVersionString = VERSION_PLACEHOLDER;
    value.CFBundleVersion = "0";
    return Buffer.from(stableJson(value));
  }
  if (relative.endsWith("/release-manifest.json")) {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (isRecord(value.release)) {
      value.release.version = VERSION_PLACEHOLDER;
      value.release.stage = "normalized";
      value.release.channel = "normalized";
      value.release.sourceVersion = null;
      value.release.sourceCandidate = null;
    }
    return Buffer.from(stableJson(value));
  }
  if (relative.endsWith("/.codex-plugin/plugin.json")) {
    const value = JSON.parse(readFileSync(file, "utf8"));
    value.version = VERSION_PLACEHOLDER;
    return Buffer.from(stableJson(value));
  }
  if (relative.endsWith("/package.json")) {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (typeof value.version === "string" && value.name === "codex-mcp-bridge-for-chatgpt") {
      value.version = VERSION_PLACEHOLDER;
    }
    return Buffer.from(stableJson(value));
  }
  if (relative.endsWith("/package-lock.json")) {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value.name === "codex-mcp-bridge-for-chatgpt") {
      value.version = VERSION_PLACEHOLDER;
      if (isRecord(value.packages?.[""])) value.packages[""].version = VERSION_PLACEHOLDER;
    }
    return Buffer.from(stableJson(value));
  }
  return readFileSync(file);
}

function excludedPayloadPath(relative, kind) {
  if (relative.endsWith("/dist/build-info.json")) return true;
  if (kind !== "macos") return false;
  return relative.includes("/_CodeSignature/") ||
    relative.endsWith("/_CodeSignature") ||
    relative === "Contents/CodeResources" ||
    relative.endsWith("/Contents/CodeResources");
}

function walk(root, relative = "") {
  const absolute = relative ? path.join(root, relative) : root;
  const entries = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const childAbsolute = path.join(root, childRelative);
    entries.push({ absolute: childAbsolute, relative: childRelative });
    if (entry.isDirectory() && !entry.isSymbolicLink()) entries.push(...walk(root, childRelative));
  }
  return entries.sort((left, right) => left.relative.localeCompare(right.relative));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--kind", "--candidate", "--stable"].includes(key) || !value) {
      throw new Error("Usage: release-payload.mjs compare --kind <npm|macos> --candidate <file> --stable <file>");
    }
    parsed[key.slice(2)] = value;
  }
  if (!ALLOWED_KINDS.has(parsed.kind) || !parsed.candidate || !parsed.stable) {
    throw new Error("Usage: release-payload.mjs compare --kind <npm|macos> --candidate <file> --stable <file>");
  }
  return parsed;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "compare") {
    throw new Error("Usage: release-payload.mjs compare --kind <npm|macos> --candidate <file> --stable <file>");
  }
  const parsed = parseArguments(args);
  const result = compareReleaseArtifacts(parsed.candidate, parsed.stable, parsed.kind);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
