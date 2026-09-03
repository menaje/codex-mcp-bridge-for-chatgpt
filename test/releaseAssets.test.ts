import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSkillsRelease } from "../scripts/build-skills-release.mjs";
import { deriveReleaseMetadata, loadReleaseManifest } from "../scripts/release-manifest.mjs";
import {
  checkReleaseAssets,
  expectedReleaseAssetNames,
  writeReleaseChecksums
} from "../scripts/release-assets.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
describe("macOS and npm release asset assembly", () => {
  it("accepts exactly one checked asset set and writes stable aggregate checksums", () => {
    const directory = createFixtureAssets();
    try {
      const result = writeReleaseChecksums({
        repoRoot: REPO_ROOT,
        directory
      });

      expect(result.metadata.version).toBe(loadReleaseManifest(REPO_ROOT).release.version);
      expect(Object.keys(result.checksums).sort()).toEqual(
        expectedReleaseAssetNames(REPO_ROOT)
          .filter((name) => name !== result.metadata.releaseChecksumsFilename)
          .sort()
      );
      expect(checkReleaseAssets({
        repoRoot: REPO_ROOT,
        directory
      }).checksums).toEqual(result.checksums);
      expect(readFileSync(result.checksumFile, "utf8").trim().split("\n")).toHaveLength(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects tampering and undeclared release files", () => {
    const directory = createFixtureAssets();
    try {
      writeReleaseChecksums({ repoRoot: REPO_ROOT, directory });
      const metadata = deriveReleaseMetadata(loadReleaseManifest(REPO_ROOT));
      appendFileSync(path.join(directory, metadata.macosArchiveFilename), "tampered");
      expect(() => checkReleaseAssets({
        repoRoot: REPO_ROOT,
        directory
      })).toThrow(/disk image|SHA256SUMS/);

      writeFileSync(path.join(directory, "undeclared.txt"), "unexpected");
      expect(() => checkReleaseAssets({
        repoRoot: REPO_ROOT,
        directory
      })).toThrow("must contain exactly");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

function createFixtureAssets(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-release-assets-test-"));
  const metadata = deriveReleaseMetadata(loadReleaseManifest(REPO_ROOT));
  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", directory],
    { cwd: REPO_ROOT, encoding: "utf8" }
  ));
  const packageFile = path.join(directory, packed[0].filename);
  const packageDigest = createHash("sha256").update(readFileSync(packageFile)).digest("hex");
  writeFileSync(
    path.join(directory, metadata.checksumFilename),
    `${packageDigest}  ${metadata.packageFilename}\n`
  );
  buildSkillsRelease({
    repoRoot: REPO_ROOT,
    outputFile: path.join(directory, metadata.skillsArchiveFilename)
  });
  const fakeDmg = Buffer.alloc(1024);
  fakeDmg.write("koly", fakeDmg.length - 512, "ascii");
  writeFileSync(path.join(directory, metadata.macosArchiveFilename), fakeDmg);
  return directory;
}
