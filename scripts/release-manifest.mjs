import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_FILENAME = "release-manifest.json";
const REQUIRED_PACKAGE_FILES = new Set([
  "dist",
  "README.md",
  "LICENSE",
  "release-manifest.json",
  "release-manifest.schema.json"
]);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;

export function loadReleaseManifest(repoRoot = DEFAULT_REPO_ROOT) {
  const file = path.join(repoRoot, MANIFEST_FILENAME);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${MANIFEST_FILENAME}: ${errorMessage(error)}`);
  }
  validateReleaseManifest(parsed);
  return parsed;
}

export function validateReleaseManifest(value) {
  const root = requiredRecord(value, "release manifest");
  assertKeys(
    root,
    ["$schema", "manifestVersion", "product", "package", "toolchain", "repository", "release"],
    "release manifest"
  );
  if (root.$schema !== "./release-manifest.schema.json") fail("$schema must reference ./release-manifest.schema.json");
  if (root.manifestVersion !== 1) fail("manifestVersion must be 1");

  const product = requiredRecord(root.product, "product");
  assertKeys(product, ["displayName", "description", "runtimeName"], "product");
  boundedString(product.displayName, "product.displayName", 100);
  boundedString(product.description, "product.description", 240);
  identifier(product.runtimeName, "product.runtimeName", PACKAGE_NAME_PATTERN, 100);

  const packageInfo = requiredRecord(root.package, "package");
  assertKeys(packageInfo, ["name", "binaryName", "license", "files", "keywords"], "package");
  identifier(packageInfo.name, "package.name", PACKAGE_NAME_PATTERN, 214);
  identifier(packageInfo.binaryName, "package.binaryName", PACKAGE_NAME_PATTERN, 100);
  boundedString(packageInfo.license, "package.license", 50);
  if (!Array.isArray(packageInfo.files) || packageInfo.files.length < 1 || packageInfo.files.length > 30) {
    fail("package.files must contain 1 to 30 entries");
  }
  const packageFiles = packageInfo.files.map((entry, index) => {
    const value = boundedString(entry, `package.files[${index}]`, 160);
    if (
      value.startsWith("/") ||
      value.includes("\\") ||
      value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      !/^[A-Za-z0-9._/-]+$/.test(value)
    ) {
      fail(`package.files[${index}] must be a safe relative package path`);
    }
    return value;
  });
  if (new Set(packageFiles).size !== packageFiles.length) fail("package.files must be unique");
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!packageFiles.includes(required)) fail(`package.files must include ${required}`);
  }
  if (!Array.isArray(packageInfo.keywords) || packageInfo.keywords.length < 1 || packageInfo.keywords.length > 20) {
    fail("package.keywords must contain 1 to 20 entries");
  }
  const keywords = packageInfo.keywords.map((entry, index) =>
    identifier(entry, `package.keywords[${index}]`, PACKAGE_NAME_PATTERN, 50)
  );
  if (new Set(keywords).size !== keywords.length) fail("package.keywords must be unique");

  const toolchain = requiredRecord(root.toolchain, "toolchain");
  assertKeys(toolchain, ["node", "npm"], "toolchain");
  identifier(toolchain.node, "toolchain.node", /^(?:[2-9]\d*)$/, 3);
  identifier(toolchain.npm, "toolchain.npm", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 30);

  const repository = requiredRecord(root.repository, "repository");
  assertKeys(repository, ["provider", "owner", "name"], "repository");
  if (repository.provider !== "github") fail("repository.provider must be github");
  identifier(repository.owner, "repository.owner", GITHUB_OWNER_PATTERN, 39);
  identifier(repository.name, "repository.name", GITHUB_REPOSITORY_PATTERN, 100);

  const release = requiredRecord(root.release, "release");
  assertKeys(release, ["version", "tagPrefix", "channel", "generateNotes", "assets"], "release");
  const semver = typeof release.version === "string" ? SEMVER_PATTERN.exec(release.version) : null;
  if (!semver) {
    fail("release.version must be a valid SemVer value");
  }
  if (typeof release.tagPrefix !== "string" || !/^[A-Za-z0-9._-]{0,16}$/.test(release.tagPrefix)) {
    fail("release.tagPrefix contains unsupported characters");
  }
  if (release.channel !== "stable" && release.channel !== "prerelease") {
    fail("release.channel must be stable or prerelease");
  }
  const hasPrerelease = Boolean(semver[4]);
  if (release.channel === "stable" && hasPrerelease) fail("stable releases cannot use a prerelease version");
  if (release.channel === "prerelease" && !hasPrerelease) fail("prerelease channel requires a prerelease version");
  if (typeof release.generateNotes !== "boolean") fail("release.generateNotes must be boolean");
  if (
    !Array.isArray(release.assets) ||
    release.assets.length !== 2 ||
    !release.assets.includes("npm-tarball") ||
    !release.assets.includes("sha256") ||
    new Set(release.assets).size !== release.assets.length
  ) {
    fail("release.assets must contain npm-tarball and sha256 exactly once");
  }
  return value;
}

export function deriveReleaseMetadata(manifest) {
  validateReleaseManifest(manifest);
  const repositorySlug = `${manifest.repository.owner}/${manifest.repository.name}`;
  const repositoryUrl = `https://github.com/${repositorySlug}`;
  const version = manifest.release.version;
  const tag = `${manifest.release.tagPrefix}${version}`;
  const packageFilename = `${manifest.package.name}-${version}.tgz`;
  return {
    manifestVersion: manifest.manifestVersion,
    displayName: manifest.product.displayName,
    runtimeName: manifest.product.runtimeName,
    packageName: manifest.package.name,
    binaryName: manifest.package.binaryName,
    nodeVersion: manifest.toolchain.node,
    nodeEngine: `>=${manifest.toolchain.node}`,
    npmVersion: manifest.toolchain.npm,
    version,
    tag,
    releaseTitle: `${manifest.product.displayName} ${tag}`,
    channel: manifest.release.channel,
    prerelease: manifest.release.channel === "prerelease",
    generateNotes: manifest.release.generateNotes,
    packageFilename,
    checksumFilename: `${packageFilename}.sha256`,
    repositorySlug,
    repositoryUrl
  };
}

export function checkReleaseMetadata(repoRoot = DEFAULT_REPO_ROOT) {
  const manifest = loadReleaseManifest(repoRoot);
  const prepared = preparePackageMetadata(repoRoot, manifest);
  const drift = [];
  if (!sameJson(prepared.packageJson, prepared.nextPackageJson)) drift.push("package.json");
  if (!sameJson(prepared.packageLock, prepared.nextPackageLock)) drift.push("package-lock.json");
  if (drift.length > 0) {
    throw new Error(`Release metadata drift in ${drift.join(", ")}. Run npm run release:sync.`);
  }
  return deriveReleaseMetadata(manifest);
}

export function syncReleaseMetadata(repoRoot = DEFAULT_REPO_ROOT) {
  const manifest = loadReleaseManifest(repoRoot);
  const prepared = preparePackageMetadata(repoRoot, manifest);
  writeJsonIfChanged(path.join(repoRoot, "package.json"), prepared.packageJson, prepared.nextPackageJson);
  writeJsonIfChanged(path.join(repoRoot, "package-lock.json"), prepared.packageLock, prepared.nextPackageLock);
  return deriveReleaseMetadata(manifest);
}

export function setReleaseVersion(requested, repoRoot = DEFAULT_REPO_ROOT) {
  const manifest = loadReleaseManifest(repoRoot);
  const version = resolveVersion(manifest.release.version, requested);
  const nextManifest = structuredClone(manifest);
  nextManifest.release.version = version;
  nextManifest.release.channel = SEMVER_PATTERN.exec(version)?.[4] ? "prerelease" : "stable";
  validateReleaseManifest(nextManifest);
  const prepared = preparePackageMetadata(repoRoot, nextManifest);
  writeJsonAtomically(path.join(repoRoot, MANIFEST_FILENAME), nextManifest);
  writeJsonIfChanged(path.join(repoRoot, "package.json"), prepared.packageJson, prepared.nextPackageJson);
  writeJsonIfChanged(path.join(repoRoot, "package-lock.json"), prepared.packageLock, prepared.nextPackageLock);
  return deriveReleaseMetadata(nextManifest);
}

function preparePackageMetadata(repoRoot, manifest) {
  const metadata = deriveReleaseMetadata(manifest);
  const packageFile = path.join(repoRoot, "package.json");
  const lockFile = path.join(repoRoot, "package-lock.json");
  const packageJson = readJson(packageFile);
  const packageLock = readJson(lockFile);
  if (!isRecord(packageLock.packages) || !isRecord(packageLock.packages[""])) {
    throw new Error("package-lock.json is missing packages[''] metadata.");
  }

  const nextPackageJson = structuredClone(packageJson);
  nextPackageJson.name = metadata.packageName;
  nextPackageJson.version = metadata.version;
  nextPackageJson.description = manifest.product.description;
  nextPackageJson.packageManager = `npm@${metadata.npmVersion}`;
  nextPackageJson.bin = { [metadata.binaryName]: "dist/cli.js" };
  nextPackageJson.files = [...manifest.package.files];
  nextPackageJson.keywords = [...manifest.package.keywords];
  nextPackageJson.license = manifest.package.license;
  nextPackageJson.repository = { type: "git", url: `${metadata.repositoryUrl}.git` };
  nextPackageJson.homepage = `${metadata.repositoryUrl}#readme`;
  nextPackageJson.bugs = { url: `${metadata.repositoryUrl}/issues` };
  nextPackageJson.engines = { node: metadata.nodeEngine };

  const nextPackageLock = structuredClone(packageLock);
  nextPackageLock.name = metadata.packageName;
  nextPackageLock.version = metadata.version;
  nextPackageLock.packages[""].name = metadata.packageName;
  nextPackageLock.packages[""].version = metadata.version;
  return { packageJson, nextPackageJson, packageLock, nextPackageLock };
}

function resolveVersion(current, requested) {
  if (requested === "major" || requested === "minor" || requested === "patch") {
    const match = SEMVER_PATTERN.exec(current);
    if (!match) fail(`Cannot increment invalid current version: ${current}`);
    let major = Number(match[1]);
    let minor = Number(match[2]);
    let patch = Number(match[3]);
    if (requested === "major") {
      major += 1;
      minor = 0;
      patch = 0;
    } else if (requested === "minor") {
      minor += 1;
      patch = 0;
    } else {
      patch += 1;
    }
    return `${major}.${minor}.${patch}`;
  }
  if (typeof requested === "string" && SEMVER_PATTERN.test(requested)) return requested;
  throw new Error("Version must be major, minor, patch, or an exact SemVer value.");
}

function requiredRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    fail(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function boundedString(value, label, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\r\n\0]/.test(value)) {
    fail(`${label} must be a single-line string of at most ${maxLength} characters`);
  }
  return value;
}

function identifier(value, label, pattern, maxLength) {
  boundedString(value, label, maxLength);
  if (!pattern.test(value)) fail(`${label} contains unsupported characters`);
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path.basename(file)}: ${errorMessage(error)}`);
  }
}

function writeJsonIfChanged(file, current, next) {
  if (!sameJson(current, next)) writeJsonAtomically(file, next);
}

function writeJsonAtomically(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  const mode = statSync(file).mode & 0o777;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, file);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new Error(`Invalid ${MANIFEST_FILENAME}: ${message}.`);
}

function printGithubOutput(metadata) {
  const output = {
    manifest_version: metadata.manifestVersion,
    display_name: metadata.displayName,
    runtime_name: metadata.runtimeName,
    package_name: metadata.packageName,
    binary_name: metadata.binaryName,
    node_version: metadata.nodeVersion,
    node_engine: metadata.nodeEngine,
    npm_version: metadata.npmVersion,
    version: metadata.version,
    tag: metadata.tag,
    release_title: metadata.releaseTitle,
    channel: metadata.channel,
    prerelease: metadata.prerelease,
    generate_notes: metadata.generateNotes,
    package_filename: metadata.packageFilename,
    checksum_filename: metadata.checksumFilename,
    repository: metadata.repositorySlug,
    repository_url: metadata.repositoryUrl
  };
  for (const [key, value] of Object.entries(output)) process.stdout.write(`${key}=${String(value)}\n`);
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === "check") {
    const metadata = checkReleaseMetadata();
    console.log(`Release manifest is synchronized for ${metadata.tag}.`);
    return;
  }
  if (command === "sync") {
    const metadata = syncReleaseMetadata();
    console.log(`Synchronized package metadata from ${MANIFEST_FILENAME} for ${metadata.tag}.`);
    return;
  }
  if (command === "version") {
    const metadata = setReleaseVersion(argument);
    console.log(`Set release version to ${metadata.version} (${metadata.channel}).`);
    return;
  }
  if (command === "github-output") {
    printGithubOutput(checkReleaseMetadata());
    return;
  }
  throw new Error("Usage: release-manifest.mjs <check|sync|version|github-output> [major|minor|patch|semver]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
