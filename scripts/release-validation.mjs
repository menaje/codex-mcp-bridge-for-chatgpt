import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function classifyChangedPaths(paths) {
  let node = false;
  let macos = false;
  for (const rawPath of paths) {
    const relative = rawPath.replaceAll("\\", "/");
    if (relative.startsWith("macos/")) macos = true;
    if (
      relative.startsWith("src/") ||
      relative.startsWith("test/") ||
      relative.startsWith("scripts/") ||
      relative.startsWith("ui-resources/") ||
      relative.startsWith(".codex-plugin/") ||
      relative.startsWith(".github/workflows/") ||
      [
        ".app.json",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "release-manifest.json",
        "release-manifest.schema.json",
        "ui-manifest.lock.json"
      ].includes(relative)
    ) {
      node = true;
    }
    if (
      relative === "package.json" ||
      relative === "package-lock.json" ||
      relative === "release-manifest.json" ||
      relative === "release-manifest.schema.json"
    ) {
      macos = true;
    }
  }
  return { node, macos };
}

export function collectChangedPaths(repoRoot = DEFAULT_REPO_ROOT, baseRef = process.env.RELEASE_BASE_REF ?? "origin/dev") {
  const paths = new Set();
  if (gitSucceeds(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])) {
    addLines(paths, git(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB", `${baseRef}...HEAD`]));
  }
  addLines(paths, git(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB"]));
  addLines(paths, git(repoRoot, ["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"]));
  addLines(paths, git(repoRoot, ["ls-files", "--others", "--exclude-standard"]));
  return [...paths].sort();
}

export function affectedValidationPlan(paths) {
  const affected = classifyChangedPaths(paths);
  const commands = [["npm", ["run", "validate:fast"]]];
  if (affected.node) commands.push(["npm", ["run", "check"]]);
  if (affected.macos) commands.push(["npm", ["run", "macos:check"]]);
  return { paths, ...affected, commands };
}

function runAffectedValidation(repoRoot = DEFAULT_REPO_ROOT, baseRef) {
  const plan = affectedValidationPlan(collectChangedPaths(repoRoot, baseRef));
  for (const [command, args] of plan.commands) {
    execFileSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  }
  return plan;
}

function git(repoRoot, args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  } catch (error) {
    throw new Error(`Could not inspect changed paths: ${errorMessage(error)}`);
  }
}

function gitSucceeds(repoRoot, args) {
  try {
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function addLines(target, value) {
  for (const line of value.split(/\r?\n/)) {
    if (line) target.add(line);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "affected") {
    throw new Error("Usage: release-validation.mjs affected [--base <git-ref>]");
  }
  let baseRef;
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--base" || !args[1]) {
      throw new Error("Usage: release-validation.mjs affected [--base <git-ref>]");
    }
    baseRef = args[1];
  }
  const plan = runAffectedValidation(DEFAULT_REPO_ROOT, baseRef);
  console.log(
    `Affected validation passed (${plan.paths.length} path(s), Node=${plan.node}, macOS=${plan.macos}).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
