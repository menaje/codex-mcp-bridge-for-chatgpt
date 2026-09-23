import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const hook = fileURLToPath(new URL("../.codex/hooks/git-lifecycle.mjs", import.meta.url));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function runHook(mode: "stop" | "pre-tool-use", cwd: string, data: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [hook, mode], {
    cwd,
    input: JSON.stringify({ cwd, ...data }),
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

function setTarget(cwd: string, target: string) {
  const result = spawnSync(process.execPath, [hook, "set-target", target], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function withRepository(run: (repository: string) => void) {
  const repository = mkdtempSync(join(tmpdir(), "git-lifecycle-hooks-"));
  try {
    git(repository, "init", "--initial-branch=dev");
    git(repository, "config", "user.name", "Hook Test");
    git(repository, "config", "user.email", "hook@example.invalid");
    writeFileSync(join(repository, "README.md"), "baseline\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "baseline");
    run(repository);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

it("continues once for an unintegrated task commit, then accepts integration", () => {
  withRepository(repository => {
    git(repository, "switch", "-c", "codex/task");
    writeFileSync(join(repository, "task.txt"), "change\n");
    git(repository, "add", "task.txt");
    git(repository, "commit", "-m", "task change");

    expect(runHook("stop", repository, {}).decision).toBe("block");
    expect(runHook("stop", repository, { stop_hook_active: true })).toEqual({});

    git(repository, "switch", "dev");
    git(repository, "merge", "--ff-only", "codex/task");
    git(repository, "switch", "codex/task");
    expect(runHook("stop", repository, {})).toEqual({});
  });
});

it("guards local branch deletion without changing Git state", () => {
  withRepository(repository => {
    git(repository, "switch", "-c", "codex/task");
    writeFileSync(join(repository, "task.txt"), "change\n");
    git(repository, "add", "task.txt");
    git(repository, "commit", "-m", "task change");
    git(repository, "switch", "dev");

    const command = "git branch -d codex/task";
    expect(runHook("pre-tool-use", repository, {
      tool_name: "Bash", tool_input: { command }
    }).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(git(repository, "branch", "--list", "codex/task")).toContain("codex/task");

    git(repository, "merge", "--ff-only", "codex/task");
    expect(runHook("pre-tool-use", repository, {
      tool_name: "Bash", tool_input: { command }
    })).toEqual({});
    expect(runHook("pre-tool-use", repository, {
      tool_name: "Bash", tool_input: { command: "git branch -D codex/task" }
    }).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

it("uses the explicit parent branch target for a task checkout", () => {
  withRepository(repository => {
    git(repository, "switch", "-c", "codex/parent");
    git(repository, "switch", "-c", "codex/task");
    writeFileSync(join(repository, "task.txt"), "change\n");
    git(repository, "add", "task.txt");
    git(repository, "commit", "-m", "task change");
    setTarget(repository, "codex/parent");
    expect(runHook("stop", repository, {}).decision).toBe("block");

    git(repository, "switch", "codex/parent");
    git(repository, "merge", "--ff-only", "codex/task");
    git(repository, "switch", "codex/task");
    expect(runHook("stop", repository, {})).toEqual({});
  });
});

it("guards dirty and unintegrated worktrees, including git -C from another worktree", () => {
  withRepository(repository => {
    const worker = join(repository, "..", `${basename(repository)} worker worktree`);
    const controller = join(repository, "..", `${basename(repository)} controller worktree`);
    try {
      git(repository, "worktree", "add", "-b", "codex/worker", worker, "dev");
      git(repository, "worktree", "add", "-b", "codex/controller", controller, "dev");
      setTarget(worker, "codex/controller");
      writeFileSync(join(worker, "task.txt"), "change\n");
      const command = `git -C '${repository}' worktree remove '${worker}'`;
      const check = () => runHook("pre-tool-use", controller, {
        tool_name: "Bash", tool_input: { command }
      });

      expect(check().hookSpecificOutput.permissionDecision).toBe("deny");
      git(worker, "add", "task.txt");
      git(worker, "commit", "-m", "task change");
      expect(check().hookSpecificOutput.permissionDecision).toBe("deny");

      git(controller, "merge", "--ff-only", "codex/worker");
      expect(check()).toEqual({});
      expect(git(repository, "worktree", "list")).toContain(worker);
    } finally {
      git(repository, "worktree", "remove", "--force", worker);
      git(repository, "worktree", "remove", "--force", controller);
    }
  });
});

it("rejects ambiguous cleanup commands and leaves ordinary commands alone", () => {
  withRepository(repository => {
    expect(runHook("pre-tool-use", repository, {
      tool_name: "Bash", tool_input: { command: "git status && git branch -d codex/task" }
    }).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(runHook("pre-tool-use", repository, {
      tool_name: "Bash", tool_input: { command: "git status --short" }
    })).toEqual({});
  });
});
