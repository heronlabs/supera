import type { Result } from "../../core/types/result.js";
import { success, failure } from "../../core/types/result.js";
import { ChildProcessService } from "../terminal/child-process-service.js";

/**
 * Git operations via the git CLI.
 *
 * Thin wrapper — all logic delegates to `git` commands.
 * Follows the exact pattern from action-tag-release-build's GitService.
 */

export class GitService {
  private readonly shell: ChildProcessService;

  constructor(shell: ChildProcessService) {
    this.shell = shell;
  }

  /** Show working tree status (porcelain format). */
  status(): Result<string> {
    const result = this.shell.exec("git status --porcelain");
    if (!result.ok) return result;
    return success(result.data.stdout || "(clean — no changes)");
  }

  /** Show diffstat of working tree changes. */
  diffStat(staged?: boolean): Result<string> {
    const cmd = staged ? "git diff --cached --stat" : "git diff --stat";
    const result = this.shell.exec(cmd);
    if (!result.ok) return result;
    return success(result.data.stdout || "(no changes)");
  }

  /** List changed files (unstaged + staged). */
  changedFiles(): Result<string[]> {
    const unstaged = this.shell.exec("git diff --name-only");
    const staged = this.shell.exec("git diff --cached --name-only");

    const files = new Set<string>();

    if (unstaged.ok && unstaged.data.stdout) {
      unstaged.data.stdout.split("\n").filter(Boolean).forEach((f) => files.add(f));
    }

    if (staged.ok && staged.data.stdout) {
      staged.data.stdout.split("\n").filter(Boolean).forEach((f) => files.add(f));
    }

    return success([...files].sort());
  }

  /** List untracked files. */
  untrackedFiles(): Result<string[]> {
    const result = this.shell.exec("git ls-files --others --exclude-standard");
    if (!result.ok) return success([]);
    return success(result.data.stdout.split("\n").filter(Boolean));
  }

  /** Stage all changes. */
  addAll(): Result<void> {
    const result = this.shell.exec("git add -A");
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "git add failed"));
    }
    return success(undefined);
  }

  /** Create a commit with a conventional-commit subject. */
  commit(type: string, summary: string): Result<void> {
    const msg = `${type}: ${summary}`;
    const result = this.shell.exec(`git commit -m "${msg.replace(/"/g, '\\"')}"`);
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "git commit failed"));
    }
    return success(undefined);
  }

  /** Push branch to remote. */
  push(remote: string, branch: string): Result<void> {
    const result = this.shell.exec(`git push -u ${remote} ${branch}`);
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "git push failed"));
    }
    return success(undefined);
  }

  /** Force push (with lease) after rebase. */
  forcePush(remote: string, branch: string): Result<void> {
    const result = this.shell.exec(
      `git push --force-with-lease ${remote} ${branch}`,
    );
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "git force-push failed"));
    }
    return success(undefined);
  }

  /** Get current branch name. */
  currentBranch(): Result<string> {
    const result = this.shell.exec("git branch --show-current");
    if (!result.ok) return result;
    return success(result.data.stdout.trim());
  }

  /** Check if a branch exists locally. */
  branchExists(branch: string): boolean {
    const result = this.shell.exec(
      `git show-ref --verify --quiet "refs/heads/${branch}"`,
    );
    return result.ok;
  }

  /** Check if a branch exists on remote. */
  remoteBranchExists(remote: string, branch: string): boolean {
    const result = this.shell.exec(
      `git ls-remote --heads "${remote}" "${branch}"`,
    );
    return result.ok && result.data.stdout.length > 0;
  }

  /** Fetch from remote. */
  fetch(remote: string, branch?: string): Result<void> {
    const cmd = branch
      ? `git fetch ${remote} ${branch}`
      : `git fetch ${remote}`;
    const result = this.shell.exec(cmd);
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "git fetch failed"));
    }
    return success(undefined);
  }

  /** Create a new worktree. */
  createWorktree(path: string, branch: string, base: string): Result<void> {
    const cmd = `git worktree add "${path}" -b "${branch}" "${base}"`;
    const result = this.shell.exec(cmd);
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(
        new Error(result.data.stderr || "git worktree add failed"),
      );
    }
    return success(undefined);
  }

  /** Remove a worktree. */
  removeWorktree(path: string, force?: boolean): Result<void> {
    const flag = force ? "--force" : "";
    const result = this.shell.exec(`git worktree remove ${flag} "${path}"`);
    if (!result.ok) return result;
    return success(undefined);
  }

  /** List worktrees. */
  listWorktrees(): Result<string> {
    const result = this.shell.exec("git worktree list");
    if (!result.ok) return result;
    return success(result.data.stdout);
  }

  /** Rebase current branch onto another. */
  rebase(onto: string): Result<void> {
    const result = this.shell.exec(`git rebase ${onto}`);
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "git rebase failed"));
    }
    return success(undefined);
  }

  /** Get the repo root directory. */
  repoRoot(): Result<string> {
    const result = this.shell.exec("git rev-parse --git-common-dir");
    if (!result.ok) return result;
    return success(result.data.stdout.trim());
  }

  /** Delete a local branch. */
  deleteBranch(branch: string): Result<void> {
    const result = this.shell.exec(`git branch -d "${branch}"`);
    if (!result.ok) return failure(result.error);
    return success(undefined);
  }
}
