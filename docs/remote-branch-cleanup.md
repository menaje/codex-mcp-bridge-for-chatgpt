# Verified remote branch cleanup

The repository's Git lifecycle hook allows a single remote branch deletion after a read-only check of its live push destination and GitHub PR history. The GitHub CLI (`gh`) must be installed and authenticated for the push repository. GitHub HTTPS and SSH remotes with one push destination are supported; unavailable or incomplete evidence blocks deletion.

The check requires all of the following:

- The branch is neither `dev`, `main`, `release/*`, nor the current worktree's chosen integration target.
- No open PR uses that repository's branch, including PRs against another base.
- A merged PR into the chosen target names exactly the current remote branch head and the same head/base repository.
- The PR's merge commit remains reachable from the live remote target. This also provides explicit evidence for squash and rebase merges, where head ancestry alone is insufficient.
- The push destination and both remote heads remain unchanged during verification.

Use one literal command, with a full commit ID obtained from the live remote branch:

```sh
git push --force-with-lease=refs/heads/codex/task:<verified-head> origin --delete codex/task
```

The explicit lease makes the server reject deletion if the task branch advances after verification. It does not waive any merge or open-work check. Multiple branches, arbitrary push options, missing leases, unmerged/new head commits, and unknown verification results remain blocked. The hook has an eight-second remote verification budget within its ten-second timeout; connectivity or authentication failures leave the branch intact.

The hook does not establish task ownership or check external worktree users. Follow `AGENTS.md` and review ownership, uncommitted files, other processes and conversation independence before cleanup. It does not change Git state itself or merge branches. Existing local branch, worktree and archival experiment checks still apply.
