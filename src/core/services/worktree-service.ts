import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import type { Result } from "../types/result.js";
import { success, failure } from "../types/result.js";
import { GitService } from "../../infrastructure/git/git-service.js";
import { ChildProcessService } from "../../infrastructure/terminal/child-process-service.js";

const WT_DIR = ".worktrees";

/**
 * Manages git worktrees for isolated feature development.
 *
 * Creates, enters, and cleans up worktrees. Each worktree is created
 * from the base branch and gets its own install directory.
 */

export class WorktreeService {
  private readonly git: GitService;
  private readonly shell: ChildProcessService;
  private readonly repoRoot: string;

  constructor(git: GitService, shell: ChildProcessService) {
    this.git = git;
    this.shell = shell;
    const root = git.repoRoot();
    if (!root.ok) {
      throw new Error("Cannot determine repo root — are you in a git repo?");
    }
    this.repoRoot = resolve(root.data, "..");
  }

  /** Create a worktree for a branch, or reuse if it exists. */
  create(branch: string, base: string, remote: string): Result<string> {
    const wtPath = join(this.repoRoot, WT_DIR, branch);
    const baseRef = `${remote}/${base}`;

    // Fetch latest base
    this.git.fetch(remote, base);

    // Clean up stale worktree from crashed previous run
    if (existsSync(wtPath)) {
      const inList = this.git.listWorktrees();
      if (inList.ok && !inList.data.includes(wtPath)) {
        this.git.removeWorktree(wtPath, true);
      }
    }

    // Branch exists locally — reuse
    if (this.git.branchExists(branch)) {
      const result = this.shell.exec(
        `git worktree add "${wtPath}" "${branch}" 2>/dev/null || true`,
      );
      if (result.ok) return success(wtPath);
    }

    // Branch exists on remote — fetch and checkout
    if (this.git.remoteBranchExists(remote, branch)) {
      this.git.fetch(remote, branch);
      const result = this.shell.exec(
        `git worktree add "${wtPath}" "${branch}"`,
      );
      if (result.ok) return success(wtPath);
    }

    // Fresh branch
    const result = this.shell.exec(
      `git worktree add "${wtPath}" -b "${branch}" "${baseRef}"`,
    );
    if (!result.ok) {
      return failure(
        new Error(`Failed to create worktree ${wtPath}: ${String(result.error)}`),
      );
    }

    return success(wtPath);
  }

  /** Install dependencies in the worktree. */
  installDeps(worktreePath: string): Result<void> {
    if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) {
      return this.shellIn(worktreePath, "pnpm install --frozen-lockfile");
    }
    if (existsSync(join(worktreePath, "yarn.lock"))) {
      return this.shellIn(worktreePath, "yarn install --immutable");
    }
    if (existsSync(join(worktreePath, "package-lock.json"))) {
      return this.shellIn(worktreePath, "npm ci");
    }
    if (existsSync(join(worktreePath, "Cargo.toml"))) {
      return this.shellIn(worktreePath, "cargo fetch");
    }
    return success(undefined);
  }

  /** Determine the lockfile type for a worktree. */
  detectPackageManager(worktreePath: string): string {
    if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(worktreePath, "yarn.lock"))) return "yarn";
    if (existsSync(join(worktreePath, "package-lock.json"))) return "npm";
    if (existsSync(join(worktreePath, "Cargo.toml"))) return "cargo";
    return "unknown";
  }

  /** Remove a worktree and its branch. */
  cleanup(worktreePath: string, branch: string): Result<void> {
    const wtResult = this.git.removeWorktree(worktreePath, true);
    this.git.deleteBranch(branch);
    return wtResult;
  }

  /** Change the shell's working directory (for subsequent commands). */
  cd(worktreePath: string): void {
    process.chdir(worktreePath);
  }

  private shellIn(cwd: string, command: string): Result<void> {
    const result = this.shell.exec(`cd "${cwd}" && ${command}`);
    if (!result.ok) return failure(result.error);
    return success(undefined);
  }
}
