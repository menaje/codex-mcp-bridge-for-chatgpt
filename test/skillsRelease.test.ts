import {
  existsSync,
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
  buildSkillsRelease,
  checkSkillsRelease,
  collectSkillsRelease,
  verifySkillsReleaseArchive
} from "../scripts/build-skills-release.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("skills release archive", () => {
  it("creates a deterministic installable ZIP with a complete source manifest", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-skills-release-test-"));
    try {
      const release = collectSkillsRelease(REPO_ROOT);
      const first = buildSkillsRelease({ repoRoot: REPO_ROOT, outputFile: path.join(directory, "first.zip") });
      const second = buildSkillsRelease({ repoRoot: REPO_ROOT, outputFile: path.join(directory, "second.zip") });

      expect(first.filename).toBe(`codex-mcp-bridge-skills-${release.bridgeVersion}.zip`);
      expect(first.manifest).toEqual({
        manifestVersion: 1,
        bridgeVersion: release.bridgeVersion,
        skills: expect.arrayContaining([
          expect.objectContaining({
            name: "codex",
            skillVersion: "0.1.2",
            path: "skills/codex/SKILL.md"
          })
        ])
      });
      expect(readFileSync(first.outputFile)).toEqual(readFileSync(second.outputFile));
      expect(verifySkillsReleaseArchive(first.outputFile, release)).toEqual(release.manifest);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("checks the ZIP and proves npm pack remains runtime-only without leaving an artifact", () => {
    const result = checkSkillsRelease(REPO_ROOT);

    expect(result.manifest.bridgeVersion).toBe(JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version);
    expect(result.manifest.skills).toHaveLength(1);
    expect(existsSync(result.outputFile)).toBe(false);
  }, 15_000);

  it("ignores Finder metadata without weakening skill-directory validation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-skills-source-test-"));
    try {
      const skillRoot = path.join(root, "skills", "example-skill");
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(path.join(root, "package.json"), '{"version":"1.2.3"}\n');
      writeFileSync(path.join(root, "skills", ".DS_Store"), "finder metadata");
      writeFileSync(path.join(skillRoot, ".DS_Store"), "finder metadata");
      writeFileSync(
        path.join(skillRoot, "SKILL.md"),
        "---\nname: example-skill\nversion: 0.1.0\ndescription: Example.\n---\n"
      );

      const release = collectSkillsRelease(root);

      expect(release.manifest.skills).toEqual([
        {
          name: "example-skill",
          skillVersion: "0.1.0",
          path: "skills/example-skill/SKILL.md"
        }
      ]);
      expect(release.archiveEntries.map((entry) => entry.path)).not.toContain(
        expect.stringContaining(".DS_Store")
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
