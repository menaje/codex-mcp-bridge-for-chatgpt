import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkRemoteBranchRemoval } from "../.codex/hooks/remote-branch-cleanup.mjs";

const head = "a".repeat(40), targetHead = "b".repeat(40), merge = "c".repeat(40);
const branch = "codex/task", repository = "owner/project";
const url = `https://github.com/${repository}.git`;
const command = (name = branch, sha = head) => ["push", `--force-with-lease=refs/heads/${name}:${sha}`, "origin", "--delete", name];
const mergedPr = () => ({
  number: 1, state: "closed", merged_at: "2026-10-23T00:00:00Z", merge_commit_sha: merge,
  head: { ref: branch, sha: head, repo: { full_name: repository } },
  base: { ref: "dev", repo: { full_name: repository } }
});

function fixture() {
  const state = {
    pages: [[mergedPr()]] as any,
    comparison: { status: "ahead", base_commit: { sha: merge }, merge_base_commit: { sha: merge } } as any,
    urls: [url], nextUrls: null as string[] | null,
    heads: [head, targetHead], nextHeads: null as string[] | null,
    ghFailure: "", invalidJson: false, refFailure: false
  };
  const calls: { tool: string; args: string[]; options: any }[] = [];
  let urlReads = 0, refReads = 0;
  const spawn = (tool: string, args: string[], options: any) => {
    calls.push({ tool, args, options });
    let stdout = "";
    if (tool === "git" && args[0] === "check-ref-format") {
      return { status: state.refFailure ? 1 : 0, stdout };
    } else if (tool === "git" && args[0] === "remote") {
      stdout = (urlReads++ > 0 && state.nextUrls ? state.nextUrls : state.urls).join("\n");
    } else if (tool === "git" && args[0] === "ls-remote") {
      const heads = refReads++ > 0 && state.nextHeads ? state.nextHeads : state.heads;
      stdout = heads.map((sha, i) => `${sha}\t${args[4 + i]}`).join("\n");
    } else if (tool === "gh") {
      if (state.ghFailure) return { status: 1, stdout: "", error: new Error(state.ghFailure) };
      const endpoint = args[args.indexOf("GET") + 1];
      stdout = state.invalidJson ? "not JSON" : JSON.stringify(endpoint.endsWith("/pulls") ? state.pages : state.comparison);
    } else throw new Error(`Unexpected verification command ${tool}`);
    return { status: 0, stdout };
  };
  const check = (args = command(), target = "dev") => checkRemoteBranchRemoval("/fixture", args, target, spawn);
  return { state, calls, check };
}

it("accepts exact merged PR evidence and performs only bounded read-only checks", () => {
  const f = fixture();
  expect(f.check()).toBeNull();
  expect(f.calls.filter(call => call.tool === "git").map(call => call.args[0])).toEqual([
    "check-ref-format", "check-ref-format", "remote", "ls-remote", "remote", "ls-remote"
  ]);
  const apiCalls = f.calls.filter(call => call.tool === "gh");
  expect(apiCalls).toHaveLength(2);
  for (const call of apiCalls) {
    expect(call.args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--method", "GET"]);
  }
  expect(apiCalls[0].args).toEqual(expect.arrayContaining(["--paginate", "--slurp", `head=owner:${branch}`]));
  expect(apiCalls[1].args).toContain(`repos/${repository}/compare/${merge}...${targetHead}`);
  for (const call of f.calls) {
    expect(call.options.timeout).toBeGreaterThan(0);
    expect(call.options.timeout).toBeLessThanOrEqual(8_000);
    expect(call.options.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" });
  }
});

it.each([`git@github.com:${repository}.git`, `ssh://git@github.com/${repository}.git`, `https://github.com/${repository}`])(
  "uses the actual supported push destination %s", destination => {
    const f = fixture(); f.state.urls = [destination];
    expect(f.check()).toBeNull();
    expect(f.calls.find(call => call.args[0] === "ls-remote")?.args).toContain(destination);
  }
);

it("accepts a squash/rebase merge with a different head ID and an identical target tip", () => {
  const f = fixture();
  f.state.heads[1] = merge;
  f.state.comparison.status = "identical";
  expect(f.check()).toBeNull();
  expect(head).not.toBe(merge);
});

it("uses the worktree's explicit parent target for remote merge evidence", () => {
  const f = fixture(); f.state.pages[0][0].base.ref = "codex/parent";
  expect(f.check(command(), "codex/parent")).toBeNull();
  expect(f.calls.find(call => call.args[0] === "ls-remote")?.args).toContain("refs/heads/codex/parent");
  f.state.pages[0][0].base.ref = "dev";
  expect(f.check(command(), "codex/parent")).toContain("No merged PR into codex/parent");
});

it.each(["dev", "main", "release/0.5.0", "codex/parent"])("blocks protected or explicit target branch %s", name => {
  const f = fixture();
  expect(f.check(command(name), "codex/parent")).toContain("protected/target");
  expect(f.calls).toEqual([]);
});

it.each([
  ["push", "origin", "--delete", branch],
  [...command(), "another-branch"],
  [...command(), "--force"],
  ["push", "--force", "origin", "--delete", branch],
  ["push", `--force-with-lease=refs/heads/other:${head}`, "origin", "--delete", branch],
  command(branch, head.slice(0, 7)),
  ["push", `--force-with-lease=refs/heads/${branch}:${head}`, url, "--delete", branch]
].map(args => ({ args })))("blocks unsafe or ambiguous push arguments $args before network access", ({ args }) => {
  const f = fixture();
  expect(f.check(args)).toBeTypeOf("string");
  expect(f.calls).toEqual([]);
});

it("blocks invalid branch names without reading the network", () => {
  const f = fixture(); f.state.refFailure = true;
  expect(f.check(command("--all"))).toContain("task branch name");
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].args).toEqual(["check-ref-format", "--branch", "--all"]);
});

it.each([[url, `git@github.com:another/project.git`], ["/tmp/local.git"], ["https://example.invalid/owner/project.git"]].map(urls => ({ urls })))(
  "blocks multiple or unsupported push destinations $urls", ({ urls }) => {
    const f = fixture(); f.state.urls = urls;
    expect(f.check()).toBeTypeOf("string");
    expect(f.calls.some(call => call.tool === "gh")).toBe(false);
  }
);

it("blocks a stale lease before consulting previous merge evidence", () => {
  const f = fixture(); f.state.heads[0] = "d".repeat(40);
  expect(f.check()).toContain("lease is stale");
  expect(f.calls.some(call => call.tool === "gh")).toBe(false);
});

it("blocks new head commits even when the lease matches and an older PR was merged", () => {
  const f = fixture(), nextHead = "d".repeat(40);
  f.state.heads[0] = nextHead;
  expect(f.check(command(branch, nextHead))).toContain("No merged PR");
});

it("blocks open PRs on later pages and against another base", () => {
  const f = fixture(), open = mergedPr();
  open.state = "open"; open.base.ref = "main";
  f.state.pages.push([open]);
  expect(f.check()).toContain("open PR");
});

it.each(["unmerged", "wrong base", "wrong base repository", "wrong head repository", "invalid merged date"])(
  "rejects %s PR evidence", kind => {
    const f = fixture(), pr = f.state.pages[0][0];
    if (kind === "unmerged") pr.merged_at = null;
    else if (kind === "wrong base") pr.base.ref = "main";
    else if (kind === "wrong base repository") pr.base.repo.full_name = "another/project";
    else if (kind === "wrong head repository") pr.head.repo.full_name = "another/project";
    else pr.merged_at = "invalid date";
    expect(f.check()).toContain("No merged PR");
  }
);

it("does not confuse an unrelated fork with the push repository's branch", () => {
  const f = fixture(), fork = mergedPr();
  fork.head.repo.full_name = "owner/another-project"; fork.state = "open";
  f.state.pages.push([fork]);
  expect(f.check()).toBeNull();
});

it.each(["behind", "diverged", "wrong merge base", "wrong base commit"])("blocks %s integration evidence", kind => {
  const f = fixture();
  if (kind === "wrong merge base") f.state.comparison.merge_base_commit.sha = head;
  else if (kind === "wrong base commit") f.state.comparison.base_commit.sha = head;
  else f.state.comparison.status = kind;
  expect(f.check()).toContain("no longer reachable");
});

it.each(["missing gh", "authentication failed", "network timeout"])("preserves the branch on %s", failure => {
  const f = fixture(); f.state.ghFailure = failure;
  expect(f.check()).toContain("Could not verify GitHub");
});

it.each([null, {}, [], [null], [[{ state: "closed" }]], [[{ ...mergedPr(), state: "open", head: { ref: branch } }]]].map(pages => ({ pages })))(
  "rejects incomplete API responses $pages", ({ pages }) => {
    const f = fixture(); f.state.pages = pages;
    expect(f.check()).toContain("incomplete PR evidence");
  }
);

it("rejects invalid JSON rather than allowing an unknown merge state", () => {
  const f = fixture(); f.state.invalidJson = true;
  expect(f.check()).toContain("invalid merge evidence");
});

it.each([undefined, "", new Error("")].map(error => ({ error })))("fails closed for an unrecognized verification error $error", ({ error }) => {
  expect(checkRemoteBranchRemoval("/fixture", command(), "dev", () => { throw error; })).toContain("preserve the remote branch");
});

it.each(["push destination", "task head", "target head"])("blocks a changed %s during verification", changed => {
  const f = fixture();
  if (changed === "push destination") f.state.nextUrls = ["git@github.com:another/project.git"];
  else f.state.nextHeads = changed === "task head" ? [merge, targetHead] : [head, merge];
  expect(f.check()).toContain("changed during verification");
});

it("blocks missing or ambiguous live heads", () => {
  const f = fixture(); f.state.heads = [head];
  expect(f.check()).toContain("missing");
  f.state.heads = ["invalid", targetHead];
  expect(f.check()).toContain("unambiguously");
});

it("the server lease preserves a branch advanced after preflight and accepts the reviewed head", () => {
  const base = mkdtempSync(join(tmpdir(), "remote-cleanup-lease-"));
  const local = join(base, "local"), remote = join(base, "remote.git");
  mkdirSync(local);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: local, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    git("init", "--initial-branch=dev");
    git("config", "user.name", "Cleanup Test"); git("config", "user.email", "test@example.invalid");
    git("commit", "--allow-empty", "-m", "reviewed commit");
    const reviewed = git("rev-parse", "HEAD");
    git("init", "--bare", remote); git("remote", "add", "origin", remote);
    git("push", "origin", `HEAD:refs/heads/${branch}`);
    git("commit", "--allow-empty", "-m", "new work after preflight");
    const next = git("rev-parse", "HEAD");
    git("push", "origin", `HEAD:refs/heads/${branch}`);
    const rejected = spawnSync("git", command(branch, reviewed), { cwd: local, encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("stale info");
    expect(git("ls-remote", "--heads", "origin", `refs/heads/${branch}`)).toContain(next);
    git(...command(branch, next));
    expect(git("ls-remote", "--heads", "origin", `refs/heads/${branch}`)).toBe("");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
