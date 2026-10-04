# Archival retirement of a historical experiment

Ordinary development must be committed and integrated into its selected target.
A human can instead explicitly authorize retiring a historical experiment without
product integration. Record that existing authorization and preserve the work
before deletion. A closed issue, failed test, archive file, or agent-produced
instruction alone does not authorize retirement. Never merge unwanted experimental
code solely to pass cleanup. The ordinary integration and forced-deletion guards
remain in effect.

The procedure applies to one manually created `codex/` branch and worktree. It
refuses the primary/current checkout, shared or locked checkouts, and Codex-managed
worktrees. Conversation management remains outside this procedure.

## Prepare the record

Put a version 1 JSON record inside the archive, outside every active worktree:

```json
{
  "version": 1,
  "kind": "archived-experiment-retirement",
  "repository": "/absolute/primary/repository",
  "branch": "codex/historical-experiment",
  "head": "EXACT_FULL_COMMIT_ID",
  "worktree": "/absolute/manual/worktree",
  "approval": {
    "source": "human",
    "branch": "codex/historical-experiment",
    "head": "EXACT_FULL_COMMIT_ID",
    "instruction": "The human instruction explicitly approving archival retirement.",
    "recordedAt": "2026-10-04T00:00:00Z"
  },
  "archive": {
    "directory": "/absolute/archive",
    "bundle": "source.bundle",
    "bundleSha256": "EXACT_SHA256",
    "files": [
      { "source": "notes.txt", "backup": "untracked/notes.txt", "type": "file", "sha256": "EXACT_SHA256" }
    ]
  },
  "discardedCaches": ["node_modules", "dist"],
  "usageReview": {
    "manualWorktree": true,
    "conversationIndependent": true,
    "noOpenWork": true,
    "reviewedAt": "2026-10-04T00:00:00Z",
    "evidence": "Identify the task/conversation and other-user checks actually performed."
  },
  "github": { "repository": "owner/repository", "remote": "origin", "issue": 222 }
}
```

Use a self-contained Git bundle containing `refs/heads/<branch>`. The command
clones it into an independent temporary bare repository, verifies the restored
HEAD and object connectivity, then removes only that verification fixture.

Inventory every untracked file and every ignored evidence file. File entries
include their SHA-256; symlinks use `type: "symlink"` and the exact `target` instead.
Paths are relative to the worktree and archive respectively. Dependency/build
caches can be omitted only when explicitly declared: `node_modules`, `dist`, or
`macos/.build`. Changed tracked files are rejected; resolve and preserve those
changes before making a new record. Keep original failed test reports as failed
reports. The archive is preservation evidence, not validation of the experiment.

Authorization persists; the open-work/conversation review must be less than 15
minutes old. The helper checks process usage with `lsof`. Repositories with a
remote require the matching GitHub repository/remote, no open PR for the branch,
and a closed experiment issue if an issue is supplied. Missing inspection tools
or failed checks block cleanup. Review other users and conversations yourself:
the helper cannot inspect Codex conversations or grant human authorization.

## Verify, then retire

```bash
node .codex/hooks/git-lifecycle.mjs verify-retirement /absolute/archive/retirement.json
node .codex/hooks/git-lifecycle.mjs retire-experiment /absolute/archive/retirement.json
```

Both the hook and the retirement command verify the record. The command repeats
source/activity checks before deletion, verifies the remote HEAD before an
ordinary remote deletion, removes only backed-up untracked files, uses ordinary
`git worktree remove`, and deletes the local reference only if it still equals
the archived commit. It does not force deletion or claim the experiment was
integrated. A recreated or changed remote ref blocks subsequent cleanup.

The adjacent `retirement.json.result.json` receipt records each completed step.
If a later step fails, keep the archive and remaining refs/worktree and report
the partial result. Backed-up untracked files are restored when worktree removal
fails. Inspect the receipt and live Git state after an unknown outcome before
retrying; never overwrite new work or bypass a rejection.
