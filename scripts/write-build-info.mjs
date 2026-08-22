import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeSourceHash } from "./build-fingerprint.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const commit = git(["rev-parse", "HEAD"]) || "unknown";
const dirty = Boolean(git(["status", "--porcelain", "--untracked-files=normal"]));
const sourceHash = computeSourceHash(repoRoot);
const build = {
  version: packageJson.version,
  commit,
  dirty,
  sourceHash,
  builtAt: new Date().toISOString(),
  id: `${commit.slice(0, 12)}${dirty ? "-dirty" : ""}:${sourceHash.slice(0, 12)}`
};
mkdirSync(path.join(repoRoot, "dist"), { recursive: true });
writeFileSync(path.join(repoRoot, "dist", "build-info.json"), `${JSON.stringify(build, null, 2)}\n`);

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
