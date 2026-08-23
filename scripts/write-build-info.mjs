import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeSourceHash } from "./build-fingerprint.mjs";
import { loadReleaseManifest } from "./release-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = loadReleaseManifest(repoRoot);
const commit = git(["rev-parse", "HEAD"]) || "unknown";
const dirty = Boolean(git(["status", "--porcelain", "--untracked-files=normal"]));
const sourceHash = computeSourceHash(repoRoot);
const build = {
  version: manifest.release.version,
  commit,
  dirty,
  sourceHash,
  builtAt: new Date().toISOString(),
  id: `${commit.slice(0, 12)}${dirty ? "-dirty" : ""}:${sourceHash.slice(0, 12)}`
};
mkdirSync(path.join(repoRoot, "dist"), { recursive: true });
writeFileSync(path.join(repoRoot, "dist", "build-info.json"), `${JSON.stringify(build, null, 2)}\n`);
copyUiResources();

function copyUiResources() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "ui-manifest.lock.json"), "utf8"));
  writeFileSync(
    path.join(repoRoot, "dist", "ui-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  for (const [name, resource] of Object.entries(manifest.resources || {})) {
    const revisions = [resource, ...(Array.isArray(resource.previous) ? resource.previous : [])];
    const targetDirectory = path.join(repoRoot, "dist", "ui", name);
    mkdirSync(targetDirectory, { recursive: true });
    for (const revision of revisions) {
      copyFileSync(
        path.join(repoRoot, "ui-resources", name, `${revision.digest}.html`),
        path.join(targetDirectory, `${revision.digest}.html`)
      );
    }
  }
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
