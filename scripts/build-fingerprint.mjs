import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function computeSourceHash(repoRoot) {
  const files = [
    "release-manifest.json",
    "release-manifest.schema.json",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    ...walk(repoRoot, "src"),
    ...walk(repoRoot, "scripts")
  ].sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(path.join(repoRoot, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function hasTrackedSourceChanges(repoRoot) {
  try {
    return Boolean(execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim());
  } catch {
    return false;
  }
}

function walk(repoRoot, relativeDirectory) {
  const entries = readdirSync(path.join(repoRoot, relativeDirectory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...walk(repoRoot, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}
