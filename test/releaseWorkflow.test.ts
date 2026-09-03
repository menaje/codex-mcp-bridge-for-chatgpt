import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveReleaseMetadata, loadReleaseManifest } from "../scripts/release-manifest.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const MACOS_PACKAGER = readFileSync(path.join(REPO_ROOT, "macos/package-release.sh"), "utf8");
const MACOS_BUILDER = readFileSync(path.join(REPO_ROOT, "macos/build-app.sh"), "utf8");

describe("macOS and generic npm release workflow", () => {
  it("runs only for an explicit RC dispatch or a stable main promotion", () => {
    expect(WORKFLOW).toMatch(/on:\n  push:\n    branches:\n      - main/);
    expect(WORKFLOW).toContain("workflow_dispatch:");
    expect(WORKFLOW).not.toContain("pull_request:");
    expect(WORKFLOW).not.toMatch(/branches:\n(?:\s+- [^\n]+\n)*\s+- dev/);
    expect(WORKFLOW).toContain("macos-check:");
    expect(WORKFLOW).toContain("runs-on: macos-15");
    expect(WORKFLOW).toContain("node scripts/release-policy.mjs github-context");
    expect(WORKFLOW.match(/gh release create/g)).toHaveLength(1);
  });

  it("requires ad-hoc macOS and generic npm assets before assembly", () => {
    for (const job of [
      "npm-release-assets",
      "macos-release-package"
    ]) {
      expect(WORKFLOW).toContain(`${job}:`);
    }
    expect(WORKFLOW).toContain("npm run macos:package");
    expect(MACOS_PACKAGER).toContain('CODE_SIGN_IDENTITY="-"');
    expect(MACOS_PACKAGER.match(/\^Signature=adhoc\$/g)).toHaveLength(2);
    expect(MACOS_BUILDER).toContain("supports ad-hoc macOS signing only");
    expect(MACOS_BUILDER).not.toContain("--options runtime");
    expect(MACOS_PACKAGER).not.toContain("notarytool");
    expect(WORKFLOW).not.toContain("MACOS_DEVELOPER_ID");
    expect(WORKFLOW).not.toContain("APPLE_NOTARY");
    expect(WORKFLOW).not.toContain("skills:package");
    expect(WORKFLOW).not.toContain("skills_archive_filename");
    expect(WORKFLOW).not.toContain("archive/skills");
    expect(WORKFLOW).toContain("npm run release:assets -- write");
    expect(WORKFLOW).toContain("npm run release:assets -- check");
    expect(WORKFLOW).toContain("Smoke-test the packed generic npm server");
    expect(WORKFLOW).toContain("node_modules/.bin/codex-mcp-bridge");
    expect(WORKFLOW).toContain("npm run release:payload -- compare");
    expect(WORKFLOW).toContain("--kind npm");
    expect(WORKFLOW).toContain("--kind macos");
    expect(WORKFLOW).toContain("source_candidate_tag");
    expect(WORKFLOW).toContain("is not the latest RC");
  });

  it("publishes every manifest-derived filename in the one release command", () => {
    const metadata = deriveReleaseMetadata(loadReleaseManifest(REPO_ROOT));
    for (const output of [
      "package_filename",
      "checksum_filename",
      "macos_archive_filename",
      "release_checksums_filename"
    ]) {
      expect(WORKFLOW).toContain(`steps.metadata.outputs.${output}`);
    }
    expect(metadata.macosArchiveFilename).toContain("macOS-arm64-unnotarized.dmg");
  });
});
