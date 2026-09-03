import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDeterministicZip, readZipEntries } from "./build-skills-release.mjs";
import { deriveReleaseMetadata, loadReleaseManifest } from "./release-manifest.mjs";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_PACKAGE_DIRECTORY = "packaging/windows";
const WINDOWS_PACKAGE_FILES = [
  ".env.example",
  "README.md",
  "Get-CodexBridgeStatus.ps1",
  "Install-CodexBridge.ps1",
  "Resolve-CodexExecutable.ps1",
  "Start-CodexBridge.ps1",
  "Test-Prerequisites.ps1"
];
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function windowsArchiveFilename(version, architecture = "x64") {
  return `codex-mcp-bridge-for-chatgpt-${version}-windows-${architecture}.zip`;
}

export function collectWindowsRelease({
  repoRoot = DEFAULT_REPO_ROOT,
  packageFile,
  sourceCommit = resolveSourceCommit(repoRoot)
} = {}) {
  const manifest = loadReleaseManifest(repoRoot);
  const metadata = deriveReleaseMetadata(manifest);
  if (manifest.release.targets.windows.transport !== "http") {
    throw new Error("The first Windows server package must use the HTTP transport.");
  }
  if (typeof packageFile !== "string" || packageFile.length === 0) {
    throw new Error("A canonical npm package is required. Pass --package <path>.");
  }
  const resolvedPackage = path.resolve(repoRoot, packageFile);
  assertRegularFile(resolvedPackage, "canonical npm package");
  if (path.basename(resolvedPackage) !== metadata.packageFilename) {
    throw new Error(
      `Expected npm package ${metadata.packageFilename}; received ${path.basename(resolvedPackage)}.`
    );
  }
  if (typeof sourceCommit !== "string" || !COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("Windows release source commit must be a full lowercase Git SHA.");
  }

  const packageData = readFileSync(resolvedPackage);
  const rootDirectory = `codex-mcp-bridge-for-chatgpt-${metadata.version}-windows-${metadata.windowsArchitecture}`;
  const packagePath = `package/${metadata.packageFilename}`;
  const archiveManifest = {
    manifestVersion: 1,
    product: manifest.product.displayName,
    version: metadata.version,
    sourceCommit,
    target: {
      os: "windows",
      architecture: metadata.windowsArchitecture,
      format: metadata.windowsFormat,
      transport: metadata.windowsTransport,
      runtime: metadata.windowsRuntime
    },
    prerequisites: {
      nodeMajor: Number(metadata.nodeVersion),
      codexCli: metadata.codexCliVersion,
      tunnelClient: "external"
    },
    package: {
      name: metadata.packageName,
      path: packagePath,
      sha256: sha256(packageData)
    }
  };
  const archiveEntries = [
    {
      path: `${rootDirectory}/manifest.json`,
      data: Buffer.from(`${JSON.stringify(archiveManifest, null, 2)}\n`, "utf8")
    },
    {
      path: `${rootDirectory}/${packagePath}`,
      data: packageData
    },
    ...WINDOWS_PACKAGE_FILES.map((relativePath) => {
      const source = relativePath === ".env.example"
        ? path.join(repoRoot, relativePath)
        : path.join(repoRoot, WINDOWS_PACKAGE_DIRECTORY, relativePath);
      assertRegularFile(source, `Windows package source ${relativePath}`);
      return { path: `${rootDirectory}/${relativePath}`, data: readFileSync(source) };
    })
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));

  return {
    version: metadata.version,
    filename: metadata.windowsArchiveFilename,
    rootDirectory,
    sourceCommit,
    manifest: archiveManifest,
    packageFile: resolvedPackage,
    archiveEntries
  };
}

export function buildWindowsRelease({ repoRoot = DEFAULT_REPO_ROOT, packageFile, outputFile, sourceCommit } = {}) {
  if (typeof outputFile !== "string" || outputFile.length === 0) {
    throw new Error("An output ZIP path is required. Pass --output <path>.");
  }
  const release = collectWindowsRelease({ repoRoot, packageFile, sourceCommit });
  const outputPath = path.resolve(repoRoot, outputFile);
  if (path.basename(outputPath) !== release.filename) {
    throw new Error(`Windows archive must be named ${release.filename}.`);
  }
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

export function verifyWindowsReleaseArchive(archiveFile, expectedRelease) {
  const archive = readFileSync(archiveFile);
  const actualEntries = readZipEntries(archive);
  const expectedEntries = expectedRelease.archiveEntries;
  if (JSON.stringify(actualEntries.map((entry) => entry.path)) !==
      JSON.stringify(expectedEntries.map((entry) => entry.path))) {
    throw new Error("Windows ZIP contents differ from the declared release package.");
  }
  for (let index = 0; index < expectedEntries.length; index += 1) {
    if (!actualEntries[index].data.equals(expectedEntries[index].data)) {
      throw new Error(`Windows ZIP entry differs: ${expectedEntries[index].path}.`);
    }
  }
  const manifestEntry = actualEntries.find(
    (entry) => entry.path === `${expectedRelease.rootDirectory}/manifest.json`
  );
  if (!manifestEntry) throw new Error("Windows ZIP is missing manifest.json.");
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  if (JSON.stringify(manifest) !== JSON.stringify(expectedRelease.manifest)) {
    throw new Error("Windows ZIP manifest differs from the expected release metadata.");
  }
  const packageEntry = actualEntries.find(
    (entry) => entry.path === `${expectedRelease.rootDirectory}/${expectedRelease.manifest.package.path}`
  );
  if (!packageEntry || sha256(packageEntry.data) !== expectedRelease.manifest.package.sha256) {
    throw new Error("Windows ZIP embedded npm package checksum is invalid.");
  }
  return manifest;
}

export function checkWindowsRelease(repoRoot = DEFAULT_REPO_ROOT) {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "codex-windows-release-"));
  try {
    const packageFile = createNpmPackage(repoRoot, temporaryDirectory);
    const metadata = deriveReleaseMetadata(loadReleaseManifest(repoRoot));
    const sourceCommit = resolveSourceCommit(repoRoot);
    const first = buildWindowsRelease({
      repoRoot,
      packageFile,
      outputFile: path.join(temporaryDirectory, metadata.windowsArchiveFilename),
      sourceCommit
    });
    verifyWindowsReleaseArchive(first.outputFile, first);
    const secondDirectory = path.join(temporaryDirectory, "second");
    const second = buildWindowsRelease({
      repoRoot,
      packageFile,
      outputFile: path.join(secondDirectory, metadata.windowsArchiveFilename),
      sourceCommit
    });
    if (!readFileSync(first.outputFile).equals(readFileSync(second.outputFile))) {
      throw new Error("Windows release ZIP is not reproducible from identical inputs.");
    }
    return { ...first, verified: true };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function createNpmPackage(repoRoot, outputDirectory) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(npm, ["pack", "--json", "--pack-destination", outputDirectory], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  const packed = JSON.parse(output);
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
    throw new Error("npm pack did not return one package filename.");
  }
  return path.join(outputDirectory, packed[0].filename);
}

function resolveSourceCommit(repoRoot) {
  const requested = process.env.RELEASE_SOURCE_COMMIT || process.env.GITHUB_SHA;
  if (requested) return requested.trim().toLowerCase();
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })
    .trim()
    .toLowerCase();
}

function assertRegularFile(filePath, label) {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function parseCommandLine(arguments_) {
  const [command, ...rest] = arguments_;
  if (command === "check" && rest.length === 0) return { command };
  if (command === "build") {
    const values = {};
    for (let index = 0; index < rest.length; index += 2) {
      const option = rest[index];
      const value = rest[index + 1];
      if (!["--package", "--output", "--source-commit"].includes(option) || !value) {
        throw new Error("Usage: build-windows-release.mjs build --package <tgz> --output <zip> [--source-commit <sha>]");
      }
      values[option.slice(2).replace("source-commit", "sourceCommit")] = value;
    }
    return { command, packageFile: values.package, outputFile: values.output, sourceCommit: values.sourceCommit };
  }
  throw new Error("Usage: build-windows-release.mjs check | build --package <tgz> --output <zip> [--source-commit <sha>]");
}

async function main() {
  const command = parseCommandLine(process.argv.slice(2));
  if (command.command === "check") {
    const result = checkWindowsRelease();
    console.log(`Verified ${result.filename} for commit ${result.sourceCommit}.`);
    return;
  }
  const result = buildWindowsRelease(command);
  verifyWindowsReleaseArchive(result.outputFile, result);
  console.log(`Built ${result.outputFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
