import { spawnSync } from "node:child_process";

const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// This is a read-only preflight. The explicit lease makes Git reject deletion
// if the verified branch head changes after this hook returns.
export function checkRemoteBranchRemoval(cwd, args, target, spawn = spawnSync) {
  const [action, lease, remote, deletion, branch] = args;
  if (args.length !== 5 || action !== "push" || deletion !== "--delete" ||
      !lease.startsWith("--force-with-lease=")) {
    return "Use one simple git push with an explicit --force-with-lease=refs/heads/<branch>:<head>, one named remote, and --delete <branch>.";
  }
  if (!/^[\w][\w.-]*$/.test(remote)) return "Remote cleanup requires one configured remote name.";
  if (["dev", "main", target].includes(branch) || branch.startsWith("release/")) {
    return `Cleanup of ${branch} follows the protected/target branch workflow.`;
  }
  const branchRef = `refs/heads/${branch}`;
  const targetRef = `refs/heads/${target}`;
  const prefix = `--force-with-lease=${branchRef}:`;
  const expected = lease.startsWith(prefix) ? lease.slice(prefix.length) : "";
  if (!objectId.test(expected)) return "The deletion lease must name the exact branch and a full commit ID.";

  // Leave time for the surrounding hook's local repository checks and output
  // within its ten-second deadline. Missing tools, auth and timeouts fail closed.
  const deadline = Date.now() + 8_000;
  function run(command, commandArgs, label) {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error("Remote verification timed out; retry after checking connectivity.");
    const result = spawn(command, commandArgs, {
      cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }
    });
    if (result.error || result.status !== 0) throw new Error(`Could not verify ${label}; preserve the remote branch.`);
    return result.stdout.trim();
  }
  function api(endpoint, fields = []) {
    const output = run("gh", ["api", "--hostname", "github.com", "--method", "GET", endpoint, ...fields], "GitHub merge evidence");
    try { return JSON.parse(output); }
    catch { throw new Error("GitHub returned invalid merge evidence; preserve the remote branch."); }
  }
  function pushUrl() {
    const urls = run("git", ["remote", "get-url", "--push", "--all", remote], "the push destination").split(/\r?\n/);
    if (urls.length !== 1 || !urls[0]) throw new Error("Remote cleanup requires exactly one push destination.");
    return urls[0];
  }
  function remoteRefs(url) {
    const lines = run("git", ["ls-remote", "--exit-code", "--refs", url, branchRef, targetRef], "the live remote heads").split(/\r?\n/);
    const refs = new Map();
    for (const line of lines) {
      const [sha, ref, extra] = line.split(/\s+/);
      if (!objectId.test(sha) || ![branchRef, targetRef].includes(ref) || extra || refs.has(ref)) {
        throw new Error("The remote heads could not be identified unambiguously.");
      }
      refs.set(ref, sha);
    }
    if (refs.size !== 2) throw new Error("The remote task or integration branch is missing.");
    return refs;
  }

  try {
    run("git", ["check-ref-format", "--branch", branch], "the task branch name");
    run("git", ["check-ref-format", "--branch", target], "the integration target name");
    const url = pushUrl();
    const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    if (!match) return "Remote merge verification supports GitHub HTTPS and SSH push destinations only.";
    const [, owner, name] = match;
    const repository = `${owner}/${name}`;
    const refs = remoteRefs(url);
    if (refs.get(branchRef) !== expected) return "The remote branch head changed or the deletion lease is stale; inspect the new work.";

    // Include every base and page: an open PR against another branch still
    // represents active work. Use the push repository, never inferred cwd state.
    const pages = api(`repos/${repository}/pulls`, ["--paginate", "--slurp", "-f", "state=all", "-f", `head=${owner}:${branch}`, "-f", "per_page=100"]);
    if (!Array.isArray(pages) || pages.length === 0 || !pages.every(Array.isArray)) {
      return "GitHub returned incomplete PR evidence; preserve the remote branch.";
    }
    const prs = pages.flat();
    if (prs.some(pr => !pr || !["open", "closed"].includes(pr.state) ||
        typeof pr.head?.ref !== "string" || typeof pr.base?.ref !== "string" ||
        (pr.state === "open" && typeof pr.head.repo?.full_name !== "string"))) {
      return "GitHub returned incomplete PR evidence; preserve the remote branch.";
    }
    const sameRepository = repo => typeof repo?.full_name === "string" &&
      repo.full_name.toLowerCase() === repository.toLowerCase();
    const ownPrs = prs.filter(pr => pr.head.ref === branch && sameRepository(pr.head.repo));
    if (ownPrs.some(pr => pr.state === "open")) return `Branch ${branch} still has an open PR; preserve the remote branch.`;
    const merged = ownPrs.filter(pr => pr.state === "closed" &&
      typeof pr.merged_at === "string" && Number.isFinite(Date.parse(pr.merged_at)) &&
      pr.head.sha === expected && pr.base.ref === target && sameRepository(pr.base.repo) &&
      objectId.test(pr.merge_commit_sha));
    if (merged.length === 0) return `No merged PR into ${target} matches the current remote head of ${branch}.`;

    let integrated = false;
    for (const pr of merged) {
      // For squash/rebase merges the PR head need not be an ancestor. The exact
      // merged PR head plus its reachable merge commit is explicit integration
      // evidence; a PR merged before new head commits is insufficient.
      const comparison = api(`repos/${repository}/compare/${pr.merge_commit_sha}...${refs.get(targetRef)}`);
      if (["ahead", "identical"].includes(comparison?.status) &&
          comparison.base_commit?.sha === pr.merge_commit_sha &&
          comparison.merge_base_commit?.sha === pr.merge_commit_sha) {
        integrated = true;
        break;
      }
    }
    if (!integrated) return `The merged PR commit is no longer reachable from remote ${target}; preserve the branch.`;
    if (pushUrl() !== url) return "The push destination changed during verification; retry the review.";
    const latest = remoteRefs(url);
    if ([branchRef, targetRef].some(ref => latest.get(ref) !== refs.get(ref))) {
      return "Remote heads changed during verification; inspect them and retry.";
    }
    return null;
  } catch (error) {
    return error instanceof Error && error.message
      ? error.message : "Remote branch verification failed; preserve the remote branch.";
  }
}
