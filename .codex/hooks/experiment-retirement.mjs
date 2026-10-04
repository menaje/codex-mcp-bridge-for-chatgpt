import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const CACHE_PATHS = new Set(["node_modules", "dist", "macos/.build"]);
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const inside = (parent, child) => child === parent || (!relative(parent, child).startsWith("..") && !isAbsolute(relative(parent, child)));
const fail = message => { throw new Error(`Experiment retirement: ${message}`); };

function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${command} ${args[0]} failed: ${result.error?.message || result.stderr.trim()}`);
  return result.stdout.trim();
}
const git = (cwd, ...args) => run(cwd, "git", args);
const same = (left, right) => realpathSync(left) === realpathSync(right);

function childPath(parent, name) {
  if (typeof name !== "string" || !name || isAbsolute(name) || name.split(/[\\/]/).some(part => part === ".." || part === ".") || /[\r\n\0]/.test(name)) fail("invalid relative archive path");
  const result = resolve(parent, name);
  if (!inside(parent, result) || !inside(parent, realpathSync(dirname(result)))) fail("archive path escapes its directory");
  return result;
}

function leaves(directory, name) {
  const file = join(directory, name);
  const info = lstatSync(file);
  if (info.isDirectory()) return readdirSync(file).flatMap(child => leaves(directory, `${name}/${child}`));
  if (!info.isFile() && !info.isSymbolicLink()) fail(`unsupported file type: ${name}`);
  return [name];
}

function localState(plan) {
  const { cwd, record, archive } = plan;
  const ref = `refs/heads/${record.branch}`;
  if (git(cwd, "rev-parse", "--verify", ref) !== record.head || git(record.worktree, "rev-parse", "HEAD") !== record.head) fail("the original branch or worktree HEAD changed");
  if (git(record.worktree, "status", "--porcelain=v1", "--untracked-files=no")) fail("tracked changes must be resolved before retirement");
  const untracked = git(record.worktree, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  const ignored = git(record.worktree, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z").split("\0").filter(Boolean).map(name => name.replace(/\/$/, ""));
  const all = [...untracked, ...ignored.filter(name => !record.discardedCaches.includes(name)).flatMap(name => leaves(record.worktree, name))].sort();
  const expected = record.archive.files.map(file => file.source).sort();
  if (new Set(expected).size !== expected.length || JSON.stringify(all) !== JSON.stringify(expected)) fail("untracked or ignored files are missing from the archive inventory");
  for (const entry of record.archive.files) {
    const source = childPath(realpathSync(record.worktree), entry.source);
    const backup = childPath(archive, entry.backup);
    const sourceInfo = lstatSync(source), backupInfo = lstatSync(backup);
    if (entry.type === "symlink") {
      if (!sourceInfo.isSymbolicLink() || !backupInfo.isSymbolicLink() || readlinkSync(source) !== entry.target || readlinkSync(backup) !== entry.target) fail(`symlink archive differs: ${entry.source}`);
    } else if (entry.type !== "file" || !sourceInfo.isFile() || !backupInfo.isFile() || !/^[a-f0-9]{64}$/.test(entry.sha256) || sha256(source) !== entry.sha256 || sha256(backup) !== entry.sha256) {
      fail(`file archive differs: ${entry.source}`);
    }
  }
  return untracked;
}

function verifyBundle(plan) {
  const bundle = childPath(plan.archive, plan.record.archive.bundle);
  if (!lstatSync(bundle).isFile() || sha256(bundle) !== plan.record.archive.bundleSha256) fail("source bundle checksum differs");
  const restore = mkdtempSync(join(tmpdir(), "bridge-retirement-restore-"));
  try {
    const bare = join(restore, "source.git");
    git(plan.cwd, "clone", "--bare", bundle, bare);
    if (git(plan.cwd, `--git-dir=${bare}`, "rev-parse", `refs/heads/${plan.record.branch}`) !== plan.record.head) fail("standalone restore does not contain the original branch HEAD");
    git(plan.cwd, `--git-dir=${bare}`, "fsck", "--connectivity-only", "--no-reflogs");
  } finally {
    rmSync(restore, { recursive: true, force: true });
  }
}

function remoteHead(plan) {
  const remote = plan.record.github?.remote;
  if (!remote) return null;
  const lines = git(plan.cwd, "ls-remote", "--refs", remote, `refs/heads/${plan.record.branch}`).split("\n").filter(Boolean);
  if (!lines.length) return null;
  if (lines.length !== 1 || lines[0].split(/\s+/)[1] !== `refs/heads/${plan.record.branch}`) fail("remote branch could not be identified");
  const head = lines[0].split(/\s+/)[0];
  if (head !== plan.record.head) fail("remote branch HEAD changed; preserve it and archive the new work");
  return head;
}

function verifyReview(record) {
  const review = record.usageReview;
  if (review?.conversationIndependent !== true || review.manualWorktree !== true || review.noOpenWork !== true || typeof review.evidence !== "string" || !review.evidence.trim() || !Number.isFinite(Date.parse(review.reviewedAt)) || Date.now() - Date.parse(review.reviewedAt) > 15 * 60_000 || Date.parse(review.reviewedAt) > Date.now() + 60_000) fail("a fresh review of open work and conversation independence is required");
}

function inspectUsage(plan) {
  const processes = spawnSync("lsof", ["-nP", "-t", "+D", plan.record.worktree], { cwd: plan.cwd, encoding: "utf8", timeout: 15_000 });
  if (processes.error || ![0, 1].includes(processes.status) || processes.stdout.trim() || /permission denied|usage:|no such file/i.test(processes.stderr) || processes.stderr.includes(plan.record.worktree)) fail("worktree usage is active or could not be checked");
  const github = plan.record.github;
  if (github) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(github.repository) || !/^[\w.-]+$/.test(github.remote)) fail("invalid GitHub repository or remote");
    const url = git(plan.cwd, "remote", "get-url", github.remote);
    const repository = url.replace(/^https:\/\/github\.com\//, "").replace(/^git@github\.com:/, "").replace(/\.git$/, "");
    if (repository.toLowerCase() !== github.repository.toLowerCase()) fail("GitHub review does not match this Git remote");
    const prs = JSON.parse(run(plan.cwd, "gh", ["pr", "list", "--repo", github.repository, "--state", "open", "--head", plan.record.branch, "--json", "number"]));
    if (!Array.isArray(prs) || prs.length) fail("an open pull request still uses the experiment");
    if (github.issue !== undefined) {
      if (!Number.isSafeInteger(github.issue) || github.issue <= 0) fail("invalid experiment issue");
      const issue = JSON.parse(run(plan.cwd, "gh", ["issue", "view", String(github.issue), "--repo", github.repository, "--json", "state"]));
      if (issue.state !== "CLOSED") fail("the experiment issue is still open");
    }
    remoteHead(plan);
  } else if (git(plan.cwd, "remote")) {
    fail("a repository with remotes requires a GitHub open-work review");
  }
}

// The record documents existing human authorization; creating it never grants
// authority. Both the hook and the command perform fresh verification.
export function verifyExperimentRetirement(cwd, recordFile, inspect = inspectUsage) {
  cwd = realpathSync(cwd);
  const recordPath = realpathSync(recordFile);
  if (lstatSync(recordPath).size > 1024 * 1024) fail("retirement record is too large");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  if (record.version !== 1 || record.kind !== "archived-experiment-retirement" || !same(record.repository, git(cwd, "worktree", "list", "--porcelain").split("\n")[0].slice(9))) fail("retirement record does not identify this repository");
  if (typeof record.branch !== "string" || !record.branch.startsWith("codex/") || !/^[a-f0-9]{40,64}$/.test(record.head)) fail("only an exact task branch HEAD can be retired");
  git(cwd, "check-ref-format", "--branch", record.branch);
  const approval = record.approval;
  if (approval?.source !== "human" || approval.branch !== record.branch || approval.head !== record.head || !approval.instruction?.trim() || !Number.isFinite(Date.parse(approval.recordedAt))) fail("explicit human authorization for this branch and HEAD is required");
  const listed = git(cwd, "worktree", "list", "--porcelain").split("\n\n").filter(Boolean).map(block => ({
    path: block.split("\n").find(line => line.startsWith("worktree "))?.slice(9),
    branch: block.split("\n").find(line => line.startsWith("branch "))?.slice(7),
    locked: block.split("\n").some(line => line.startsWith("locked"))
  }));
  const found = listed.filter(item => item.branch === `refs/heads/${record.branch}`);
  if (found.length !== 1 || !same(found[0].path, record.worktree) || found[0].locked || same(record.worktree, cwd) || same(record.worktree, listed[0].path) || /[\\/]\.codex[\\/]worktrees[\\/]/.test(record.worktree)) fail("the worktree is current, shared, locked, managed, or not the recorded task worktree");
  if (!same(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")), resolve(record.worktree, git(record.worktree, "rev-parse", "--git-common-dir")))) fail("worktree Git ownership changed");
  const archive = realpathSync(record.archive.directory);
  if (listed.some(item => inside(realpathSync(item.path), archive) || inside(realpathSync(item.path), recordPath)) || !inside(archive, recordPath)) fail("the record and archive must be outside every active worktree");
  if (!Array.isArray(record.archive.files) || !Array.isArray(record.discardedCaches) || record.discardedCaches.some(name => !CACHE_PATHS.has(name))) fail("only declared dependency/build caches may be omitted");
  const plan = { cwd, recordPath, record, archive };
  verifyBundle(plan);
  plan.untracked = localState(plan);
  verifyReview(record);
  inspect(plan);
  return plan;
}

export function retireExperiment(cwd, recordFile, inspect = inspectUsage) {
  const plan = verifyExperimentRetirement(cwd, recordFile, inspect);
  const { record, recordPath } = plan;
  const receipt = { version: 1, branch: record.branch, head: record.head, archive: plan.archive,
    startedAt: new Date().toISOString(), retiredWithoutIntegration: true, status: "prepared",
    remoteRemoved: false, worktreeRemoved: false, branchRemoved: false, forceDeletionUsed: false };
  const save = () => {
    const temporary = `${recordPath}.result.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, `${recordPath}.result.json`);
  };
  save();
  const removed = [];
  try {
    // Check again immediately before deletion. A normal push also protects
    // against changes after the server advertises its current reference.
    localState(plan); verifyReview(record); inspect(plan); localState(plan);
    if (record.github) {
      if (remoteHead(plan)) git(plan.cwd, "push", record.github.remote, "--delete", record.branch);
      if (remoteHead(plan) !== null) fail("remote deletion was not confirmed");
      receipt.remoteRemoved = true; save();
    }
    localState(plan); verifyReview(record); inspect(plan); localState(plan);
    for (const source of plan.untracked) {
      unlinkSync(childPath(realpathSync(record.worktree), source));
      removed.push(source);
    }
    git(plan.cwd, "worktree", "remove", record.worktree);
    receipt.worktreeRemoved = true; save();
    // Deliberate archival retirement uses compare-and-delete, rather than a
    // forced branch deletion or invented integration into the product branch.
    if (git(plan.cwd, "worktree", "list", "--porcelain").split("\n").includes(`branch refs/heads/${record.branch}`)) fail("another worktree attached to the branch during retirement");
    git(plan.cwd, "update-ref", "-d", `refs/heads/${record.branch}`, record.head);
    receipt.branchRemoved = true;
    receipt.status = "completed"; receipt.completedAt = new Date().toISOString(); save();
    return receipt;
  } catch (error) {
    if (existsSync(record.worktree)) {
      for (const source of removed) {
        const destination = join(record.worktree, source);
        if (existsSync(destination)) continue;
        const entry = record.archive.files.find(file => file.source === source);
        mkdirSync(dirname(destination), { recursive: true });
        if (entry.type === "symlink") symlinkSync(entry.target, destination);
        else copyFileSync(childPath(plan.archive, entry.backup), destination);
      }
    }
    receipt.status = "pending"; receipt.error = error.message; save();
    throw error;
  }
}
