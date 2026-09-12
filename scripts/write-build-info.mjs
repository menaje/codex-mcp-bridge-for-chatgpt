import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeSourceHash, hasTrackedSourceChanges } from "./build-fingerprint.mjs";
import { loadReleaseManifest } from "./release-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = loadReleaseManifest(repoRoot);
const commit = git(["rev-parse", "HEAD"]) || "unknown";
const dirty = hasTrackedSourceChanges(repoRoot);
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
      const sourceDirectory = path.join(repoRoot, "ui-resources", name);
      const source = [
        path.join(sourceDirectory, `${revision.digest}.html`),
        path.join(sourceDirectory, `${revision.digest}.html.base64`)
      ].find(existsSync);
      if (!source) throw new Error(`Selected UI snapshot is missing: ${name}/${revision.digest}`);
      copyFileSync(source, path.join(targetDirectory, path.basename(source)));
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
