import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectSkillsRelease, verifySkillsReleaseArchive } from "./build-skills-release.mjs";
import { deriveReleaseMetadata, loadReleaseManifest } from "./release-manifest.mjs";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function expectedReleaseAssetNames(repoRoot = DEFAULT_REPO_ROOT) {
  const metadata = deriveReleaseMetadata(loadReleaseManifest(repoRoot));
  return [
    metadata.packageFilename,
    metadata.checksumFilename,
    metadata.skillsArchiveFilename,
    metadata.macosArchiveFilename,
    metadata.releaseChecksumsFilename
  ];
}

export function writeReleaseChecksums({
  repoRoot = DEFAULT_REPO_ROOT,
  directory
} = {}) {
  const context = inspectReleaseAssets({ repoRoot, directory, requireChecksums: false });
  const contents = checksumContents(context.assetFiles);
  const checksumFile = path.join(context.directory, context.metadata.releaseChecksumsFilename);
  const temporary = `${checksumFile}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o644 });
    renameSync(temporary, checksumFile);
  } finally {
    rmSync(temporary, { force: true });
  }
  return checkReleaseAssets({ repoRoot, directory: context.directory });
}

export function checkReleaseAssets({
  repoRoot = DEFAULT_REPO_ROOT,
  directory
} = {}) {
  const context = inspectReleaseAssets({ repoRoot, directory, requireChecksums: true });
  const checksumFile = path.join(context.directory, context.metadata.releaseChecksumsFilename);
  const expected = checksumContents(context.assetFiles);
  const actual = readFileSync(checksumFile, "utf8");
  if (actual !== expected) throw new Error(`${context.metadata.releaseChecksumsFilename} does not match release assets.`);
  return {
    ...context,
    checksumFile,
    checksums: Object.fromEntries(
      context.assetFiles.map((file) => [path.basename(file), sha256(readFileSync(file))])
    )
  };
}

function inspectReleaseAssets({ repoRoot, directory, requireChecksums }) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("A release asset directory is required. Pass --directory <path>.");
  }
  const resolvedDirectory = path.resolve(repoRoot, directory);
  assertDirectory(resolvedDirectory);
  const metadata = deriveReleaseMetadata(loadReleaseManifest(repoRoot));
  const requiredNames = expectedReleaseAssetNames(repoRoot);
  const assetNames = requiredNames.filter((name) => name !== metadata.releaseChecksumsFilename);
  const actualNames = readdirSync(resolvedDirectory)
    .filter((name) => !name.startsWith("."))
    .sort(compareNames);
  const comparableNames = requireChecksums
    ? actualNames
    : actualNames.filter((name) => name !== metadata.releaseChecksumsFilename);
  const expectedNames = requireChecksums ? requiredNames : assetNames;
  const hasOnlyOptionalChecksum = actualNames.length === comparableNames.length ||
    (actualNames.length === comparableNames.length + 1 && actualNames.includes(metadata.releaseChecksumsFilename));
  if (!hasOnlyOptionalChecksum ||
      JSON.stringify(comparableNames) !== JSON.stringify([...expectedNames].sort(compareNames))) {
    throw new Error(
      `Release asset directory must contain exactly ${expectedNames.join(", ")}; found ${actualNames.join(", ") || "nothing"}.`
    );
  }
  const assetFiles = assetNames.map((name) => {
    const file = path.join(resolvedDirectory, name);
    assertRegularFile(file, name);
    return file;
  });

  const packageFile = path.join(resolvedDirectory, metadata.packageFilename);
  const npmChecksum = readFileSync(path.join(resolvedDirectory, metadata.checksumFilename), "utf8");
  const expectedNpmChecksum = `${sha256(readFileSync(packageFile))}  ${metadata.packageFilename}\n`;
  if (npmChecksum !== expectedNpmChecksum) {
    throw new Error(`${metadata.checksumFilename} does not match ${metadata.packageFilename}.`);
  }

  const skills = collectSkillsRelease(repoRoot);
  verifySkillsReleaseArchive(path.join(resolvedDirectory, metadata.skillsArchiveFilename), skills);

  verifyDmg(path.join(resolvedDirectory, metadata.macosArchiveFilename));
  return { directory: resolvedDirectory, metadata, assetFiles };
}

function checksumContents(files) {
  return [...files]
    .sort((left, right) => compareNames(path.basename(left), path.basename(right)))
    .map((file) => `${sha256(readFileSync(file))}  ${path.basename(file)}\n`)
    .join("");
}

function verifyDmg(file) {
  const data = readFileSync(file);
  if (data.length < 512 || data.subarray(data.length - 512, data.length - 508).toString("ascii") !== "koly") {
    throw new Error(`${path.basename(file)} is not a UDIF disk image.`);
  }
}

function assertDirectory(directory) {
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Release asset directory must be a non-symlink directory: ${directory}`);
  }
}

function assertRegularFile(file, label) {
  const stats = lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCommandLine(arguments_) {
  const [command, option, directory] = arguments_;
  if (!["write", "check"].includes(command) || option !== "--directory" || !directory || arguments_.length !== 3) {
    throw new Error("Usage: release-assets.mjs <write|check> --directory <path>");
  }
  return { command, directory };
}

async function main() {
  const command = parseCommandLine(process.argv.slice(2));
  const result = command.command === "write"
    ? writeReleaseChecksums({ directory: command.directory })
    : checkReleaseAssets({ directory: command.directory });
  console.log(`Verified ${Object.keys(result.checksums).length + 1} release assets for ${result.metadata.tag}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
