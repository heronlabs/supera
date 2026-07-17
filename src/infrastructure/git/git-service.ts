import type { Result } from "../../core/types/result.js";
import { success, failure } from "../../core/types/result.js";
import { ChildProcessService } from "../terminal/child-process-service.js";

export class GitService {
  private readonly shell: ChildProcessService;

  constructor(shell: ChildProcessService) {
    this.shell = shell;
  }

  status(): Result<string> {
    const result = this.shell.exec("git status --porcelain");
    if (!result.ok) return result;
    return success(result.data.stdout || "(clean — no changes)");
  }

  diffStat(staged?: boolean): Result<string> {
    const cmd = staged ? "git diff --cached --stat" : "git diff --stat";
    const result = this.shell.exec(cmd);
    if (!result.ok) return result;
    return success(result.data.stdout || "(no changes)");
  }

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

  untrackedFiles(): Result<string[]> {
    const result = this.shell.exec("git ls-files --others --exclude-standard");
    if (!result.ok) return success([]);
    return success(result.data.stdout.split("\n").filter(Boolean));
  }

  addAll(): Result<void> {
    const result = this.shell.exec("git add -A");
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "git add failed"));
    }
    return success(undefined);
  }

  commit(type: string, summary: string): Result<void> {
    const msg = `${type}: ${summary}`;
    const result = this.shell.exec(`git commit -m "${msg.replace(/"/g, '\\"')}"`);
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "git commit failed"));
    }
    return success(undefined);
  }

  push(remote: string, branch: string): Result<void> {
    const result = this.shell.exec(`git push -u ${remote} ${branch}`);
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "git push failed"));
    }
    return success(undefined);
  }

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

  currentBranch(): Result<string> {
    const result = this.shell.exec("git branch --show-current");
    if (!result.ok) return result;
    return success(result.data.stdout.trim());
  }

  branchExists(branch: string): boolean {
    const result = this.shell.exec(
      `git show-ref --verify --quiet "refs/heads/${branch}"`,
    );
    return result.ok;
  }

  remoteBranchExists(remote: string, branch: string): boolean {
    const result = this.shell.exec(
      `git ls-remote --heads "${remote}" "${branch}"`,
    );
    return result.ok && result.data.stdout.length > 0;
  }

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

  removeWorktree(path: string, force?: boolean): Result<void> {
    const flag = force ? "--force" : "";
    const result = this.shell.exec(`git worktree remove ${flag} "${path}"`);
    if (!result.ok) return result;
    return success(undefined);
  }

  listWorktrees(): Result<string> {
    const result = this.shell.exec("git worktree list");
    if (!result.ok) return result;
    return success(result.data.stdout);
  }

  rebase(onto: string): Result<void> {
    const result = this.shell.exec(`git rebase ${onto}`);
    if (!result.ok) return result;
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "git rebase failed"));
    }
    return success(undefined);
  }

  repoRoot(): Result<string> {
    const result = this.shell.exec("git rev-parse --git-common-dir");
    if (!result.ok) return result;
    return success(result.data.stdout.trim());
  }

  deleteBranch(branch: string): Result<void> {
    const result = this.shell.exec(`git branch -d "${branch}"`);
    if (!result.ok) return failure(result.error);
    return success(undefined);
  }
}
