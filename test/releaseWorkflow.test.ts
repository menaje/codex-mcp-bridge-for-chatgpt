import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveReleaseMetadata, loadReleaseManifest } from "../scripts/release-manifest.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const MACOS_PACKAGER = readFileSync(path.join(REPO_ROOT, "macos/package-release.sh"), "utf8");

describe("cross-platform release workflow", () => {
  it("checks Windows and macOS on development pushes without publishing", () => {
    expect(WORKFLOW).toContain("windows-check:");
    expect(WORKFLOW).toContain("runs-on: windows-latest");
    expect(WORKFLOW).toContain("macos-check:");
    expect(WORKFLOW).toContain("runs-on: macos-15");
    expect(WORKFLOW).toMatch(/^  release:\n[\s\S]*?if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/m);
    expect(WORKFLOW.match(/gh release create/g)).toHaveLength(1);
  });

  it("requires ad-hoc macOS, canonical Windows, and common assets before assembly", () => {
    for (const job of [
      "common-release-assets",
      "windows-release-package",
      "macos-release-package"
    ]) {
      expect(WORKFLOW).toContain(`${job}:`);
    }
    expect(WORKFLOW).toContain("npm run macos:package");
    expect(MACOS_PACKAGER).toContain('CODE_SIGN_IDENTITY="-"');
    expect(MACOS_PACKAGER.match(/\^Signature=adhoc\$/g)).toHaveLength(2);
    expect(MACOS_PACKAGER).not.toContain("notarytool");
    expect(WORKFLOW).not.toContain("MACOS_DEVELOPER_ID");
    expect(WORKFLOW).not.toContain("APPLE_NOTARY");
    expect(WORKFLOW).toContain("npm run release:assets -- write");
    expect(WORKFLOW).toContain("npm run release:assets -- check");
  });

  it("publishes every manifest-derived filename in the one release command", () => {
    const metadata = deriveReleaseMetadata(loadReleaseManifest(REPO_ROOT));
    for (const output of [
      "package_filename",
      "checksum_filename",
      "skills_archive_filename",
      "macos_archive_filename",
      "windows_archive_filename",
      "release_checksums_filename"
    ]) {
      expect(WORKFLOW).toContain(`steps.metadata.outputs.${output}`);
    }
    expect(metadata.macosArchiveFilename).toContain("macOS-arm64-unnotarized.dmg");
    expect(metadata.windowsArchiveFilename).toContain("windows-x64.zip");
  });
});
