import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
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
import { deflateRawSync, inflateRawSync } from "node:zlib";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIRECTORY = "skills";
const SKILL_DOCUMENT = "SKILL.md";
const ARCHIVE_MANIFEST = "manifest.json";
const IGNORED_SOURCE_ENTRY_NAMES = new Set([".DS_Store"]);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const ZIP_DOS_DATE = 0x0021; // 1980-01-01, the earliest ZIP timestamp.
const ZIP_DOS_TIME = 0;
const CRC_TABLE = createCrcTable();

export function skillsArchiveFilename(bridgeVersion) {
  assertSemver(bridgeVersion, "package.json version");
  return `codex-mcp-bridge-skills-${bridgeVersion}.zip`;
}

export function collectSkillsRelease(repoRoot = DEFAULT_REPO_ROOT) {
  const packageJson = readJson(path.join(repoRoot, "package.json"));
  const bridgeVersion = packageJson?.version;
  assertSemver(bridgeVersion, "package.json version");

  const skillsRoot = path.join(repoRoot, SKILLS_DIRECTORY);
  assertDirectory(skillsRoot, "skills directory");
  const skillDirectories = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => !IGNORED_SOURCE_ENTRY_NAMES.has(entry.name))
    .sort((left, right) => compareArchivePaths(left.name, right.name));
  if (skillDirectories.length === 0) throw new Error("skills directory must contain at least one skill.");

  const skills = [];
  const files = [];
  for (const entry of skillDirectories) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SKILL_NAME_PATTERN.test(entry.name)) {
      throw new Error(`skills/${entry.name} must be a non-symlink skill directory with a safe name.`);
    }
    const skillRoot = path.join(skillsRoot, entry.name);
    const skillDocument = path.join(skillRoot, SKILL_DOCUMENT);
    assertRegularFile(skillDocument, `skills/${entry.name}/${SKILL_DOCUMENT}`);
    const frontmatter = parseFrontmatter(readFileSync(skillDocument, "utf8"), `skills/${entry.name}/${SKILL_DOCUMENT}`);
    if (frontmatter.name !== entry.name) {
      throw new Error(`skills/${entry.name}/${SKILL_DOCUMENT} frontmatter name must match its directory.`);
    }
    skills.push({
      name: frontmatter.name,
      skillVersion: bridgeVersion,
      path: `skills/${entry.name}/${SKILL_DOCUMENT}`
    });
    for (const relativePath of listRegularFiles(skillRoot)) {
      files.push({
        path: `skills/${entry.name}/${relativePath}`,
        data: readFileSync(path.join(skillRoot, relativePath))
      });
    }
  }
  files.sort((left, right) => compareArchivePaths(left.path, right.path));

  const rootDirectory = `codex-mcp-bridge-skills-${bridgeVersion}`;
  const manifest = { manifestVersion: 1, bridgeVersion, skills };
  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const archiveEntries = [
    { path: `${rootDirectory}/${ARCHIVE_MANIFEST}`, data: manifestData },
    ...files.map((file) => ({ path: `${rootDirectory}/${file.path}`, data: file.data }))
  ];
  return {
    bridgeVersion,
    filename: skillsArchiveFilename(bridgeVersion),
    rootDirectory,
    manifest,
    archiveEntries
  };
}

export function buildSkillsRelease({ repoRoot = DEFAULT_REPO_ROOT, outputFile } = {}) {
  if (typeof outputFile !== "string" || outputFile.length === 0) {
    throw new Error("An output ZIP path is required. Pass --output <path>.");
  }
  const release = collectSkillsRelease(repoRoot);
  const outputPath = path.resolve(repoRoot, outputFile);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, createDeterministicZip(release.archiveEntries));
    renameSync(temporary, outputPath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { ...release, outputFile: outputPath, sha256: sha256(readFileSync(outputPath)) };
}

export function verifySkillsReleaseArchive(archiveFile, expectedRelease) {
  const actualEntries = readZipEntries(readFileSync(archiveFile));
  const expectedEntries = expectedRelease.archiveEntries;
  const actualNames = actualEntries.map((entry) => entry.path);
  const expectedNames = expectedEntries.map((entry) => entry.path);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Skills ZIP contents differ from the expected manifest and skills tree.`);
  }
  for (let index = 0; index < expectedEntries.length; index += 1) {
    if (!actualEntries[index].data.equals(expectedEntries[index].data)) {
      throw new Error(`Skills ZIP entry content differs: ${expectedEntries[index].path}.`);
    }
  }
  const manifestEntry = actualEntries.find((entry) => entry.path === `${expectedRelease.rootDirectory}/${ARCHIVE_MANIFEST}`);
  if (!manifestEntry) throw new Error("Skills ZIP is missing manifest.json.");
  const manifest = parseArchiveManifest(manifestEntry.data);
  if (JSON.stringify(manifest) !== JSON.stringify(expectedRelease.manifest)) {
    throw new Error("Skills ZIP manifest content differs from the source skills manifest.");
  }
  return manifest;
}

export function checkSkillsRelease(repoRoot = DEFAULT_REPO_ROOT) {
  const release = collectSkillsRelease(repoRoot);
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "codex-mcp-bridge-skills-"));
  const archiveFile = path.join(temporaryDirectory, release.filename);
  try {
    const built = buildSkillsRelease({ repoRoot, outputFile: archiveFile });
    const manifest = verifySkillsReleaseArchive(archiveFile, release);
    verifyNpmPackExcludesSkills(repoRoot);
    return { ...built, manifest };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseFrontmatter(source, label) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) throw new Error(`${label} must start with YAML frontmatter.`);
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    if (fields.has(field[1])) throw new Error(`${label} frontmatter repeats ${field[1]}.`);
    fields.set(field[1], unquoteFrontmatter(field[2], label, field[1]));
  }
  const name = fields.get("name");
  if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`${label} frontmatter name must be a safe kebab-case skill name.`);
  }
  if (fields.has("version")) {
    throw new Error(`${label} frontmatter must omit version; skillVersion is derived from the bridge release version.`);
  }
  return { name };
}

function unquoteFrontmatter(value, label, field) {
  if (!value) throw new Error(`${label} frontmatter ${field} must be a non-empty scalar.`);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`${label} frontmatter ${field} must be a non-empty scalar.`);
  return value;
}

function listRegularFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareArchivePaths(left.name, right.name))) {
    if (IGNORED_SOURCE_ENTRY_NAMES.has(entry.name)) continue;
    const relativePath = path.posix.join(prefix, entry.name);
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${fullPath} must not be a symbolic link.`);
    if (entry.isDirectory()) {
      files.push(...listRegularFiles(fullPath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`${fullPath} must be a regular file or directory.`);
    }
  }
  return files;
}

function verifyNpmPackExcludesSkills(repoRoot) {
  const packageJson = readJson(path.join(repoRoot, "package.json"));
  if (Array.isArray(packageJson.files) && packageJson.files.some((entry) => entry === "skills" || entry.startsWith("skills/"))) {
    throw new Error("package.json files must not include skills; npm package is runtime-only.");
  }
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, encoding: "utf8" });
  let packed;
  try {
    packed = JSON.parse(output);
  } catch (error) {
    throw new Error(`npm pack --dry-run returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = Array.isArray(packed) && Array.isArray(packed[0]?.files) ? packed[0].files : undefined;
  if (!files) throw new Error("npm pack --dry-run did not report package files.");
  const skillsFile = files.find((file) => typeof file?.path === "string" && (file.path === "skills" || file.path.startsWith("skills/")));
  if (skillsFile) throw new Error(`npm package unexpectedly includes ${skillsFile.path}.`);
}

function createDeterministicZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(ZIP_DOS_TIME, 10);
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(ZIP_DOS_TIME, 12);
    central.writeUInt16LE(ZIP_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    const localRecord = Buffer.concat([local, name, compressed]);
    localRecords.push(localRecord);
    centralRecords.push(Buffer.concat([central, name]));
    offset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(centralDirectory.length, 12);
  footer.writeUInt32LE(offset, 16);
  footer.writeUInt16LE(0, 20);
  return Buffer.concat([...localRecords, centralDirectory, footer]);
}

function readZipEntries(archive) {
  const footerOffset = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(footerOffset + 10);
  const centralOffset = archive.readUInt32LE(footerOffset + 16);
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Skills ZIP central directory is invalid.");
    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Skills ZIP local header is invalid for ${name}.`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const data = compression === 8 ? inflateRawSync(compressed) : compression === 0 ? compressed : undefined;
    if (!data || data.length !== uncompressedSize) throw new Error(`Skills ZIP entry is invalid: ${name}.`);
    entries.push({ path: name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(archive) {
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Skills ZIP end-of-central-directory record is missing.");
}

function parseArchiveManifest(data) {
  try {
    const manifest = JSON.parse(data.toString("utf8"));
    if (
      !manifest || manifest.manifestVersion !== 1 || !SEMVER_PATTERN.test(manifest.bridgeVersion) ||
      !Array.isArray(manifest.skills) ||
      manifest.skills.some((skill) =>
        !skill || !SKILL_NAME_PATTERN.test(skill.name) || !SEMVER_PATTERN.test(skill.skillVersion) ||
        skill.path !== `skills/${skill.name}/${SKILL_DOCUMENT}`
      )
    ) {
      throw new Error("invalid manifest shape");
    }
    return manifest;
  } catch (error) {
    throw new Error(`Skills ZIP manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertDirectory(directory, label) {
  let stats;
  try {
    stats = lstatSync(directory);
  } catch {
    throw new Error(`${label} is missing: ${directory}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory.`);
}

function assertRegularFile(file, label) {
  let stats;
  try {
    stats = lstatSync(file);
  } catch {
    throw new Error(`${label} is missing.`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSemver(value, label) {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) throw new Error(`${label} must be valid SemVer.`);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable() {
  return Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function compareArchivePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCommandLine(arguments_) {
  const [command, ...rest] = arguments_;
  if (command === "check" && rest.length === 0) return { command };
  if (command === "build" && rest.length === 2 && rest[0] === "--output") return { command, outputFile: rest[1] };
  throw new Error("Usage: build-skills-release.mjs check | build --output <path>");
}

async function main() {
  const command = parseCommandLine(process.argv.slice(2));
  if (command.command === "check") {
    const result = checkSkillsRelease();
    console.log(`Verified ${result.filename}: ${result.manifest.skills.length} skill(s); npm package excludes skills/.`);
    return;
  }
  const result = buildSkillsRelease({ outputFile: command.outputFile });
  verifySkillsReleaseArchive(result.outputFile, result);
  console.log(`Built ${result.outputFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
