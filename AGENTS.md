# Repository work lifecycle

- Create task branches and worktrees when they help isolate work. Choose the integration target when starting: `dev` for ordinary development, or the explicitly requested parent branch. Follow [release governance](docs/release-governance.md) for release branches and `main`.
- For a target other than `dev`, run `node .codex/hooks/git-lifecycle.mjs set-target <branch>` from each task worktree. The hook stores that choice in worktree Git metadata. Set it in the checkout used for later branch cleanup as well.
- Before reporting a code-changing task as complete, verify that its changes are committed and integrated into the chosen target branch. A finished Codex turn or handoff does not establish Git integration.
- After integration, remove only the task branch and task-owned worktrees that can be safely removed independently of the Codex conversation. Check for uncommitted files, unmerged commits, open work, and other users or processes of the worktree before removal. Never use force deletion to bypass a failed check.
- If integration or cleanup remains pending, preserve the work and state exactly what remains in the final response. Squash and cherry-pick integration require explicit evidence because commit ancestry alone will not prove them.
- Keep Codex conversation state separate from Git cleanup. Do not archive, unarchive, pin, unpin, or hide a task solely to clean its branch or worktree. Codex-managed worktrees follow the app's existing cleanup setting; if one remains because immediate removal would change the conversation state, report that cleanup as pending. Remove permanent or manually created worktrees separately after the same checks.

The project Codex hooks in `.codex/hooks.json` provide a read-only end-of-turn check and a guard for common Git deletion commands. They do not merge branches or remove worktrees automatically, and they are not a complete Git enforcement boundary.
