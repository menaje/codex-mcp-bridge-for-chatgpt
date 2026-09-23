import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function git(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5_000 });
}

function output(cwd, ...args) {
  const result = git(cwd, ...args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function root(cwd) {
  return output(cwd, "rev-parse", "--show-toplevel");
}

function commonGitDir(cwd) {
  const directory = output(cwd, "rev-parse", "--git-common-dir");
  return directory ? resolve(cwd, directory) : null;
}

function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function targetRefs(cwd) {
  const target = targetName(cwd);
  return [`refs/remotes/origin/${target}`, `refs/heads/${target}`].filter(ref =>
    git(cwd, "show-ref", "--verify", "--quiet", ref).status === 0
  );
}

function targetFile(cwd) {
  const location = output(cwd, "rev-parse", "--git-path", "codex-integration-target");
  return location ? resolve(cwd, location) : null;
}

function targetName(cwd) {
  const location = targetFile(cwd);
  if (!location) return "dev";
  try {
    return readFileSync(location, "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

function setTarget(cwd, name) {
  if (!name || git(cwd, "check-ref-format", "--branch", name).status !== 0) {
    throw new Error("Provide an existing integration target branch name.");
  }
  if (git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${name}`).status !== 0 &&
      git(cwd, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`).status !== 0) {
    throw new Error(`Integration target ${name} was not found.`);
  }
  const location = targetFile(cwd);
  if (!location) throw new Error("A Git worktree is required to save the integration target.");
  writeFileSync(location, `${name}\n`);
  process.stdout.write(`Integration target for this worktree: ${name}\n`);
}

function integrated(cwd, commit, targets) {
  return targets.some(target => git(cwd, "merge-base", "--is-ancestor", commit, target).status === 0);
}

function dirty(cwd) {
  const result = git(cwd, "status", "--porcelain=v1", "--untracked-files=all");
  return result.status !== 0 || result.stdout.length > 0;
}

function protectedBranch(name) {
  return name === "dev" || name === "main" || name.startsWith("release/");
}

function stop(input) {
  if (input.stop_hook_active) return {};
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (!root(cwd)) return {};
  const target = targetName(cwd);
  const targets = targetRefs(cwd);
  if (targets.length === 0) return { systemMessage: `Git lifecycle: ${target} is unavailable; verify the integration target manually.` };

  const branch = output(cwd, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (branch === "main" || branch?.startsWith("release/")) return {};
  const head = output(cwd, "rev-parse", "HEAD");
  if (!head) return {};
  const hasChanges = dirty(cwd);
  const isIntegrated = integrated(cwd, head, targets);
  if (!hasChanges && (branch === target || isIntegrated)) return {};

  const location = branch || "detached worktree";
  const pending = [hasChanges ? "uncommitted files" : null, !isIntegrated ? `commits outside ${target}` : null]
    .filter(Boolean).join(" and ");
  return {
    decision: "block",
    reason: `Git lifecycle check for ${location}: ${pending}. For changes owned by this task, integrate into the chosen target and clean up its temporary branch/worktree before claiming completion. If this is read-only work, another task owns the changes, or integration is pending, leave them intact and report that status. Do not force-delete.`
  };
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
}

// Accept only a single literal Git command. Shell operators and expansions are
// intentionally rejected for cleanup, so a check always covers the actual target.
function shellWords(command) {
  const words = [];
  let word = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "$" || char === "`") return null;
      else if (char === "\\" && index + 1 < command.length) word += command[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < command.length) {
      word += command[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (char === "\n" || char === "\r") return null;
      if (started) words.push(word);
      word = "";
      started = false;
    } else if (/[;&|`$<>]/.test(char)) {
      return null;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

function looksLikeCleanup(command) {
  return /\bgit\b/.test(command) && (
    /\bworktree\b[\s\S]*\bremove\b/.test(command) ||
    /\bbranch\b[\s\S]*(?:-d\b|-D\b|--delete\b)/.test(command) ||
    /\bpush\b[\s\S]*--delete\b/.test(command)
  );
}

function commandParts(words, cwd) {
  if (words[0] !== "git") return null;
  let index = 1;
  let commandCwd = cwd;
  while (words[index] === "-C" && words[index + 1]) {
    commandCwd = resolve(commandCwd, words[index + 1]);
    index += 2;
  }
  return { cwd: commandCwd, args: words.slice(index) };
}

function worktrees(cwd) {
  const listing = output(cwd, "worktree", "list", "--porcelain");
  if (listing === null) return [];
  return listing.split("\n\n").map(block => {
    const lines = block.split("\n");
    return {
      path: lines.find(line => line.startsWith("worktree "))?.slice(9),
      branch: lines.find(line => line.startsWith("branch "))?.slice(7),
      head: lines.find(line => line.startsWith("HEAD "))?.slice(5)
    };
  });
}

function checkBranchRemoval(cwd, args, targets, target) {
  if (args.length !== 3 || !["-d", "--delete"].includes(args[1])) {
    return "Use one simple `git branch -d <branch>` command; forced or ambiguous deletion is blocked.";
  }
  const branch = args[2];
  if (protectedBranch(branch)) return `Cleanup of ${branch} follows the protected/release branch workflow.`;
  const ref = `refs/heads/${branch}`;
  if (git(cwd, "show-ref", "--verify", "--quiet", ref).status !== 0) return `Local branch ${branch} was not found.`;
  if (!integrated(cwd, ref, targets)) return `Branch ${branch} is not an ancestor of ${target}. Verify integration, including squash/PR evidence, before manual cleanup.`;
  return null;
}

function checkWorktreeRemoval(cwd, sessionRoot, args) {
  if (args.length !== 3) return "Use one simple `git worktree remove <path>` command; forced or ambiguous deletion is blocked.";
  const candidate = resolve(cwd, args[2]);
  const listed = worktrees(cwd);
  const found = listed.find(item => item.path && samePath(item.path, candidate));
  if (!found) return "The requested worktree is not registered. Inspect it before removing anything.";
  if (samePath(found.path, sessionRoot)) return "Do not remove the worktree that is running this Codex task.";
  const branch = found.branch?.replace(/^refs\/heads\//, "");
  if (branch && protectedBranch(branch)) return `Cleanup of ${branch} follows the protected/release branch workflow.`;
  if (dirty(found.path)) return "The worktree has uncommitted files. Preserve or integrate them before removal.";
  const worktreeTargets = targetRefs(found.path);
  if (worktreeTargets.length === 0 || !found.head || !integrated(cwd, found.head, worktreeTargets)) {
    return `The worktree HEAD is not an ancestor of ${targetName(found.path)}. Verify integration before removal.`;
  }
  return null;
}

function preToolUse(input) {
  const command = input.tool_input?.command;
  if (input.tool_name !== "Bash" || typeof command !== "string" || !looksLikeCleanup(command)) return {};
  const words = shellWords(command);
  const parts = words && commandParts(words, input.cwd || process.cwd());
  if (!parts) return deny("Run branch/worktree cleanup as one simple literal Git command after verifying integration.");
  const sessionRoot = root(input.cwd || process.cwd());
  const commandRoot = root(parts.cwd);
  const sessionGitDir = commonGitDir(input.cwd || process.cwd());
  const commandGitDir = commonGitDir(parts.cwd);
  if (!sessionRoot || !commandRoot || !sessionGitDir || !commandGitDir) {
    return deny("The Git repository could not be verified for cleanup.");
  }
  if (!samePath(sessionGitDir, commandGitDir)) return {};
  const args = parts.args;
  let reason;
  if (args[0] === "branch") {
    const taskCwd = input.cwd || process.cwd();
    const targets = targetRefs(taskCwd);
    reason = targets.length > 0
      ? checkBranchRemoval(parts.cwd, args, targets, targetName(taskCwd))
      : "The integration target could not be verified.";
  } else if (args[0] === "worktree" && args[1] === "remove") {
    reason = checkWorktreeRemoval(parts.cwd, sessionRoot, args);
  }
  else if (args[0] === "push" && args.includes("--delete")) reason = "Verify the merged PR before deleting a remote branch; this hook cannot prove remote integration.";
  else reason = "Unsupported Git cleanup command; verify integration and use a simple branch/worktree removal command.";
  return reason ? deny(reason) : {};
}

if (process.argv[2] === "set-target") {
  try {
    setTarget(process.cwd(), process.argv[3]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
} else {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    input = null;
  }

  if (!input || typeof input !== "object") {
    process.stdout.write(JSON.stringify(process.argv[2] === "pre-tool-use"
      ? deny("Git cleanup hook input was unavailable; inspect the command manually.") : {}));
  } else {
    const result = process.argv[2] === "stop" ? stop(input) : preToolUse(input);
    process.stdout.write(JSON.stringify(result));
  }
}
