import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  comparePayloadDirectories,
  compareReleaseArtifacts,
  digestPayloadDirectory
} from "../scripts/release-payload.mjs";

describe("RC-to-stable payload equivalence", () => {
  it("normalizes only enumerated npm release and build identity fields", () => {
    const candidate = fixture("0.4.0-rc.2", "candidate", "prerelease", null, "candidate-build");
    const stable = fixture("0.4.0", "stable", "stable", "0.4.0-rc.2", "stable-build");

    expect(comparePayloadDirectories(candidate, stable, "npm")).toMatchObject({
      kind: "npm",
      equivalent: true,
      fileCount: 6
    });
  });

  it("fails when executable payload changes outside the allowlist", () => {
    const candidate = fixture("0.4.0-rc.1", "candidate", "prerelease", null, "candidate-build");
    const stable = fixture("0.4.0", "stable", "stable", "0.4.0-rc.1", "stable-build");
    writeFileSync(path.join(stable, "package/dist/cli.js"), "console.log('changed');\n");

    expect(() => comparePayloadDirectories(candidate, stable, "npm"))
      .toThrow(/payload changed outside the allowed/);
  });

  it("unpacks and compares actual npm tar archives", () => {
    const candidate = fixture("0.4.0-rc.3", "candidate", "prerelease", null, "candidate-build");
    const stable = fixture("0.4.0", "stable", "stable", "0.4.0-rc.3", "stable-build");
    const candidateArchive = path.join(candidate, "candidate.tgz");
    const stableArchive = path.join(stable, "stable.tgz");
    execFileSync("tar", ["-czf", candidateArchive, "-C", candidate, "package"]);
    execFileSync("tar", ["-czf", stableArchive, "-C", stable, "package"]);

    expect(compareReleaseArtifacts(candidateArchive, stableArchive, "npm"))
      .toMatchObject({ equivalent: true, kind: "npm" });
  });

  it("includes file modes and unknown metadata in the digest", () => {
    const root = fixture("0.4.0", "development", "none", null, "build");
    const first = digestPayloadDirectory(root, "npm");
    writeFileSync(path.join(root, "package/config.json"), "{\"policy\":2}\n");
    const second = digestPayloadDirectory(root, "npm");
    expect(second.digest).not.toBe(first.digest);
    expect(second.fileCount).toBe(first.fileCount);
  });

  it.skipIf(process.platform !== "darwin")("preserves native executable permissions while excluding DMG signatures", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-payload-dmg-"));
    try {
      const binary = path.join(root, "probe");
      execFileSync("cc", ["-x", "c", "-", "-o", binary], { input: "int main(void) { return 0; }\n" });
      execFileSync("codesign", ["--force", "--sign", "-", binary], { stdio: "pipe" });
      const archives: string[] = [];
      for (const [name, mode] of [["candidate", 0o555], ["stable", 0o755]] as const) {
        const staging = path.join(root, name);
        const executable = path.join(staging, "Probe.app", "Contents", "MacOS", "probe");
        mkdirSync(path.dirname(executable), { recursive: true });
        copyFileSync(binary, executable);
        chmodSync(executable, mode);
        const archive = path.join(root, `${name}.dmg`);
        execFileSync("hdiutil", ["create", "-srcfolder", staging, "-format", "UDZO", archive], { stdio: "pipe" });
        archives.push(archive);
      }
      expect(compareReleaseArtifacts(archives[0], archives[0], "macos")).toMatchObject({ equivalent: true });
      expect(() => compareReleaseArtifacts(archives[0], archives[1], "macos"))
        .toThrow(/payload changed outside the allowed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function fixture(
  version: string,
  stage: string,
  channel: string,
  sourceCandidate: string | null,
  buildId: string
): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-payload-fixture-"));
  const packageRoot = path.join(root, "package");
  mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  mkdirSync(path.join(packageRoot, ".codex-plugin"), { recursive: true });
  writeJson(path.join(packageRoot, "package.json"), {
    name: "codex-mcp-bridge-for-chatgpt",
    version,
    bin: { "codex-mcp-bridge": "dist/cli.js" }
  });
  writeJson(path.join(packageRoot, "package-lock.json"), {
    name: "codex-mcp-bridge-for-chatgpt",
    version,
    packages: { "": { name: "codex-mcp-bridge-for-chatgpt", version } }
  });
  writeJson(path.join(packageRoot, "release-manifest.json"), {
    release: { version, stage, channel, sourceCandidate },
    policy: "same"
  });
  writeJson(path.join(packageRoot, ".codex-plugin/plugin.json"), {
    name: "codex-mcp-bridge",
    version
  });
  writeFileSync(path.join(packageRoot, "dist/cli.js"), "console.log('same');\n");
  writeJson(path.join(packageRoot, "dist/build-info.json"), { version, id: buildId });
  writeFileSync(path.join(packageRoot, "config.json"), "{\"policy\":1}\n");
  return root;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
