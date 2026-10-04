import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { retireExperiment } from "../.codex/hooks/experiment-retirement.mjs";

const hook = fileURLToPath(new URL("../.codex/hooks/git-lifecycle.mjs", import.meta.url));
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture(run: (f: ReturnType<typeof makeFixture>) => void) {
  const f = makeFixture();
  try { run(f); } finally { rmSync(f.base, { recursive: true, force: true }); }
}

function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), "bridge-retirement-test-"));
  const repository = join(base, "repository"), worktree = join(base, "experiment worktree"), archive = join(base, "archive"), bin = join(base, "bin");
  for (const path of [repository, archive, bin]) mkdirSync(path);
  git(repository, "init", "--initial-branch=dev");
  git(repository, "config", "user.name", "Retirement Test");
  git(repository, "config", "user.email", "retirement@example.invalid");
  writeFileSync(join(repository, ".gitignore"), "output/\nnode_modules/\n");
  writeFileSync(join(repository, "README.md"), "baseline\n");
  git(repository, "add", "."); git(repository, "commit", "-m", "baseline");
  git(repository, "branch", "main");
  const baseline = git(repository, "rev-parse", "dev");
  const branch = "codex/historical-experiment";
  git(repository, "worktree", "add", "-b", branch, worktree, "dev");
  writeFileSync(join(worktree, "experiment.txt"), "unmerged experimental code\n");
  git(worktree, "add", "experiment.txt"); git(worktree, "commit", "-m", "experiment");
  const head = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "notes.txt"), "uncommitted research\n");
  mkdirSync(join(worktree, "output"));
  writeFileSync(join(worktree, "output", "failed-test.log"), "FAIL: original result\n");
  symlinkSync("/nonexistent/historical-codex", join(worktree, "output", "cli-link"));
  mkdirSync(join(worktree, "node_modules")); writeFileSync(join(worktree, "node_modules", "cache.txt"), "dependency cache\n");
  const files = ["notes.txt", "output/failed-test.log"].map(source => {
    mkdirSync(join(archive, "files", source, ".."), { recursive: true });
    copyFileSync(join(worktree, source), join(archive, "files", source));
    return { source, backup: `files/${source}`, type: "file", sha256: hash(join(worktree, source)) };
  });
  symlinkSync("/nonexistent/historical-codex", join(archive, "files", "output", "cli-link"));
  const bundle = join(archive, "source.bundle");
  git(repository, "bundle", "create", bundle, "--all");
  const record: any = {
    version: 1, kind: "archived-experiment-retirement", repository, worktree, branch, head,
    approval: { source: "human", branch, head, instruction: "Retire this disposable test fixture after preserving it.", recordedAt: new Date().toISOString() },
    archive: { directory: archive, bundle: "source.bundle", bundleSha256: hash(bundle), files: [...files, { source: "output/cli-link", backup: "files/output/cli-link", type: "symlink", target: "/nonexistent/historical-codex" }] },
    discardedCaches: ["node_modules"],
    usageReview: { conversationIndependent: true, manualWorktree: true, noOpenWork: true, evidence: "Disposable test fixture with no conversations or other users.", reviewedAt: new Date().toISOString() }
  };
  const recordFile = join(archive, "retirement.json");
  const write = () => writeFileSync(recordFile, JSON.stringify(record));
  const setProcesses = (body = "process.exit(1);") => writeFileSync(join(bin, "lsof"), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  write(); setProcesses();
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const command = (mode = "verify-retirement", cwd = repository) => spawnSync(process.execPath, [hook, mode, recordFile], { cwd, env, encoding: "utf8" });
  const check = (text: string, cwd = repository) => {
    const result = spawnSync(process.execPath, [hook, "pre-tool-use"], { cwd, env, input: JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command: text } }), encoding: "utf8" });
    expect(result.status).toBe(0); return JSON.parse(result.stdout);
  };
  const unchanged = () => {
    expect(git(repository, "rev-parse", branch)).toBe(head);
    expect(git(repository, "rev-parse", "dev")).toBe(baseline);
    expect(readFileSync(join(worktree, "notes.txt"), "utf8")).toBe("uncommitted research\n");
    expect(git(repository, "worktree", "list")).toContain(worktree);
  };
  return { base, repository, worktree, archive, bin, bundle, branch, head, baseline, record, recordFile, write, command, check, unchanged, setProcesses };
}

function remoteFixture(f: ReturnType<typeof makeFixture>, prs: number[] = [], issue = "CLOSED") {
  const remote = join(f.base, "remote.git");
  git(f.repository, "init", "--bare", remote);
  git(f.repository, "remote", "add", "origin", remote);
  git(f.repository, "push", "origin", f.branch);
  f.record.github = { repository: "fixture/experiment", remote: "origin", issue: 222 };
  f.write();
  writeFileSync(join(f.bin, "gh"), `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==="pr")console.log(${JSON.stringify(JSON.stringify(prs.map(number => ({ number }))))});else if(a[0]==="issue")console.log(${JSON.stringify(JSON.stringify({ state: issue }))});else process.exit(1);\n`, { mode: 0o755 });
  writeFileSync(join(f.bin, "git"), `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==="remote"&&a[1]==="get-url")console.log("https://github.com/fixture/experiment.git");else{const r=require("node:child_process").spawnSync("/usr/bin/git",a,{stdio:"inherit"});process.exit(r.status??1);}\n`, { mode: 0o755 });
  return remote;
}

it("verifies a standalone restore and preserves source state during inspection", () => fixture(f => {
  const result = f.command(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ verified: true, head: f.head });
  f.unchanged();
  expect(f.check(`'${process.execPath}' '${hook}' retire-experiment '${f.recordFile}'`)).toEqual({});
  expect(f.check(`git worktree remove '${f.worktree}'`).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(f.check(`git branch -D ${f.branch}`).hookSpecificOutput.permissionDecision).toBe("deny");
}));

it("retires the unmerged experiment without changing dev or main and retains recovery evidence", () => fixture(f => {
  const result = f.command("retire-experiment"); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", worktreeRemoved: true, branchRemoved: true, forceDeletionUsed: false, retiredWithoutIntegration: true });
  expect(existsSync(f.worktree)).toBe(false);
  expect(git(f.repository, "branch", "--list", f.branch)).toBe("");
  expect(git(f.repository, "rev-parse", "dev")).toBe(f.baseline);
  expect(git(f.repository, "rev-parse", "main")).toBe(f.baseline);
  expect(readFileSync(join(f.archive, "files", "output", "failed-test.log"), "utf8")).toContain("FAIL");
  expect(readFileSync(join(f.archive, "files", "notes.txt"), "utf8")).toContain("uncommitted research");
  expect(JSON.parse(readFileSync(`${f.recordFile}.result.json`, "utf8")).status).toBe("completed");
  const restore = join(f.base, "independent.git");
  git(f.repository, "clone", "--bare", f.bundle, restore);
  expect(git(f.repository, `--git-dir=${restore}`, "rev-parse", f.branch)).toBe(f.head);
}));

it.each(["missing", "agent", "different-head"])("rejects %s human authorization before mutation", kind => fixture(f => {
  if (kind === "missing") delete f.record.approval;
  else if (kind === "agent") f.record.approval.source = "agent";
  else f.record.approval.head = f.baseline;
  f.write(); const result = f.command("retire-experiment");
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("human authorization"); f.unchanged();
}));

it.each(["bundle", "file", "prerequisite"])("rejects a %s archive that cannot preserve the original state", kind => fixture(f => {
  if (kind === "bundle") writeFileSync(f.bundle, "corrupted\n");
  else if (kind === "file") writeFileSync(join(f.archive, "files", "notes.txt"), "different\n");
  else { rmSync(f.bundle); git(f.repository, "bundle", "create", f.bundle, f.branch, "^dev"); f.record.archive.bundleSha256 = hash(f.bundle); f.write(); }
  const result = f.command("retire-experiment"); expect(result.status).not.toBe(0); f.unchanged();
}));

it.each(["untracked", "ignored", "tracked", "cache"])("rejects %s work that the archive does not preserve", kind => fixture(f => {
  if (kind === "untracked") writeFileSync(join(f.worktree, "new-work.txt"), "new\n");
  else if (kind === "ignored") writeFileSync(join(f.worktree, "output", "new-evidence.txt"), "new\n");
  else if (kind === "tracked") writeFileSync(join(f.worktree, "experiment.txt"), "new tracked work\n");
  else { f.record.discardedCaches.push("output"); f.write(); }
  expect(f.command("retire-experiment").status).not.toBe(0); f.unchanged();
}));

it("blocks active processes and an incomplete or stale open-work review", () => fixture(f => {
  f.setProcesses('console.log("12345");');
  expect(f.command("retire-experiment").stderr).toContain("worktree usage"); f.unchanged();
  f.setProcesses(); f.record.usageReview.noOpenWork = false; f.write();
  expect(f.command("retire-experiment").stderr).toContain("fresh review"); f.unchanged();
  f.record.usageReview.noOpenWork = true; f.record.usageReview.reviewedAt = "2000-01-01T00:00:00Z"; f.write();
  expect(f.command("retire-experiment").stderr).toContain("fresh review"); f.unchanged();
}));

it("rejects archives within active worktrees, a current checkout, and protected branches", () => fixture(f => {
  expect(f.command("retire-experiment", f.worktree).stderr).toContain("current"); f.unchanged();
  f.record.archive.directory = f.worktree; f.write();
  expect(f.command("retire-experiment").stderr).toContain("outside"); f.unchanged();
  f.record.archive.directory = f.archive; f.record.branch = "dev"; f.write();
  expect(f.command("retire-experiment").stderr).toContain("task branch"); f.unchanged();
}));

it("preserves a branch that changes after initial verification", () => fixture(f => {
  let inspections = 0;
  expect(() => retireExperiment(f.repository, f.recordFile, () => {
    if (++inspections === 2) {
      writeFileSync(join(f.worktree, "experiment.txt"), "new commit\n");
      git(f.worktree, "add", "experiment.txt"); git(f.worktree, "commit", "-m", "new work");
    }
  })).toThrow("HEAD changed");
  expect(git(f.repository, "rev-parse", f.branch)).not.toBe(f.head);
  expect(readFileSync(join(f.worktree, "notes.txt"), "utf8")).toContain("uncommitted research");
  expect(JSON.parse(readFileSync(`${f.recordFile}.result.json`, "utf8")).status).toBe("pending");
}));

it("restores backed-up files if ordinary worktree removal fails", () => fixture(f => {
  let inspections = 0;
  expect(() => retireExperiment(f.repository, f.recordFile, () => {
    if (++inspections === 3) git(f.repository, "worktree", "lock", f.worktree);
  })).toThrow("worktree failed");
  f.unchanged();
  const result = JSON.parse(readFileSync(`${f.recordFile}.result.json`, "utf8"));
  expect(result).toMatchObject({ status: "pending", worktreeRemoved: false, branchRemoved: false });
}));

it("checks GitHub open work and deletes only the archived remote branch", () => fixture(f => {
  const remote = remoteFixture(f);
  const result = f.command("retire-experiment"); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", remoteRemoved: true });
  expect(git(f.repository, `--git-dir=${remote}`, "for-each-ref", "--format=%(refname)")).toBe("");
  expect(git(f.repository, "rev-parse", "dev")).toBe(f.baseline);
}));

it.each(["open-pr", "open-issue", "changed-head"])("preserves the experiment when remote review finds %s", kind => fixture(f => {
  const remote = remoteFixture(f, kind === "open-pr" ? [123] : [], kind === "open-issue" ? "OPEN" : "CLOSED");
  if (kind === "changed-head") {
    const tree = git(f.repository, "rev-parse", `${f.head}^{tree}`);
    const next = git(f.repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", `--git-dir=${remote}`, "commit-tree", tree, "-p", f.head, "-m", "new remote work");
    git(f.repository, `--git-dir=${remote}`, "update-ref", `refs/heads/${f.branch}`, next, f.head);
  }
  const result = f.command("retire-experiment"); expect(result.status).not.toBe(0); f.unchanged();
  expect(git(f.repository, `--git-dir=${remote}`, "rev-parse", f.branch)).toBeTruthy();
}));
