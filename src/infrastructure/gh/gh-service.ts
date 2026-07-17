import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "../../core/types/result.js";
import { success, failure } from "../../core/types/result.js";
import { ChildProcessService } from "../terminal/child-process-service.js";

/**
 * GitHub CLI operations.
 *
 * Thin wrapper around `gh`. Follows the pattern from
 * action-tag-release-build's GhService.
 */

export interface PullRequestInfo {
  readonly number: number;
  readonly url: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly state: string;
  readonly mergeable: string;
  readonly reviewDecision: string;
}

export class GhService {
  private readonly cwd: string;
  private readonly shell: ChildProcessService;

  constructor(cwd: string, shell: ChildProcessService) {
    this.cwd = cwd;
    this.shell = shell;
  }

  /** Create a pull request. Returns the PR URL. */
  createPr(params: {
    readonly base: string;
    readonly head: string;
    readonly title: string;
    readonly bodyFile: string;
  }): Result<string> {
    const cmd =
      `gh pr create ` +
      `--base "${params.base}" ` +
      `--head "${params.head}" ` +
      `--title "${params.title.replace(/"/g, '\\"')}" ` +
      `--body-file "${params.bodyFile}"`;

    const result = this.shell.exec(cmd);
    if (!result.ok) {
      // Try fallback — PR might already exist
      const existing = this.shell.exec(
        `gh pr list --head "${params.head}" --json url -q '.[0].url'`,
      );
      if (existing.ok && existing.data.stdout) {
        return success(existing.data.stdout.trim());
      }
      return failure(result.error);
    }

    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "gh pr create failed"));
    }

    return success(result.data.stdout.trim());
  }

  /** View PR details as JSON. */
  viewPr(prNumber: number): Result<PullRequestInfo> {
    const result = this.shell.exec(
      `gh pr view ${prNumber} --json number,url,headRefName,baseRefName,state,mergeable,reviewDecision`,
    );

    if (!result.ok) return failure(result.error);
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "gh pr view failed"));
    }

    try {
      const parsed: PullRequestInfo = JSON.parse(result.data.stdout);
      return success(parsed);
    } catch (error) {
      return failure(error);
    }
  }

  /** Merge a PR. */
  mergePr(prNumber: number, method: "merge" | "squash" | "rebase"): Result<void> {
    const result = this.shell.exec(
      `gh pr merge ${prNumber} --${method}`,
    );
    if (!result.ok) return failure(result.error);
    if (result.data.exitCode !== 0) {
      return failure(new Error(result.data.stderr || "gh pr merge failed"));
    }
    return success(undefined);
  }

  /** Post a comment on a PR. */
  commentOnPr(prNumber: number, body: string): Result<void> {
    const tmpFile = join(this.cwd, ".supera", ".pr-comment.tmp.md");
    try {
      writeFileSync(tmpFile, body, "utf-8");
    } catch (error) {
      return failure(error);
    }

    const result = this.shell.exec(
      `gh pr comment ${prNumber} --body-file "${tmpFile}"`,
    );
    if (!result.ok) return failure(result.error);
    if (result.data.exitCode !== 0) {
      return failure(
        new Error(result.data.stderr || "gh pr comment failed"),
      );
    }
    return success(undefined);
  }

  /** Get PR checks status. */
  checksStatus(prNumber: number): Result<string> {
    const result = this.shell.exec(
      `gh pr view ${prNumber} --json statusCheckRollup -q '.statusCheckRollup[] | "\(.name): \(.conclusion // "PENDING")"'`,
    );
    if (!result.ok) return result;
    return success(result.data.stdout || "(no checks)");
  }
}
