import type { Result } from "../types/result.js";
import type { SuperaConfig } from "../types/supera-config.js";
import type { Receipt } from "../types/receipt.js";
import type { ToolRegistration } from "../types/tool-definition.js";
import type { AgentRunner } from "../interfaces/agent-runner.js";
import { success, failure } from "../types/result.js";
import { receiptAllPass } from "../types/receipt.js";
import { GitService } from "../../infrastructure/git/git-service.js";
import { GhService } from "../../infrastructure/gh/gh-service.js";
import { ChildProcessService } from "../../infrastructure/terminal/child-process-service.js";
import { NodeFsService } from "../../infrastructure/filesystem/node-fs-service.js";
import { WorktreeService } from "./worktree-service.js";
import { VerificationService } from "./verification-service.js";
import { SystemPromptService } from "./system-prompt-service.js";
import { ToolBuilder } from "./tool-builder-service.js";

export interface ShipOutput {
  readonly receipt: Receipt;
  readonly prUrl: string;
  readonly prNumber: number;
  readonly branch: string;
  readonly worktreePath: string;
}

const MAX_VERIFY_ATTEMPTS = 3;
const MODEL = process.env["OPENAI_MODEL"] ?? "gpt-4o";
const MAX_ITERATIONS = parseInt(process.env["MAX_ITERATIONS"] ?? "40", 10);

/**
 * Orchestrates the full ship workflow.
 *
 * Pipeline: derive slug → worktree → install deps → run agent →
 * verify → fix loop → commit → push → create PR.
 *
 * This is the application-level orchestration that was previously
 * split across ship/SKILL.md and supera-engineer.md markdown files.
 */

export class ShipOrchestratorService {
  private readonly git: GitService;
  private readonly gh: GhService;
  private readonly shell: ChildProcessService;
  private readonly fs: NodeFsService;
  private readonly agent: AgentRunner;
  private readonly worktree: WorktreeService;
  private readonly promptService: SystemPromptService;

  constructor(
    git: GitService,
    gh: GhService,
    shell: ChildProcessService,
    fs: NodeFsService,
    agent: AgentRunner,
    worktree: WorktreeService,
    promptService: SystemPromptService,
  ) {
    this.git = git;
    this.gh = gh;
    this.shell = shell;
    this.fs = fs;
    this.agent = agent;
    this.worktree = worktree;
    this.promptService = promptService;
  }

  /** Run the full ship pipeline. */
  async execute(
    task: string,
    config: SuperaConfig,
  ): Promise<Result<ShipOutput>> {
    const slug = this.deriveSlug(task);

    // 1. Create or enter worktree
    const wt = this.worktree.create(slug, config.baseBranch, config.remote);
    if (!wt.ok) return failure(wt.error);
    const worktreePath = wt.data;

    this.worktree.cd(worktreePath);

    // 2. Install dependencies
    const install = this.worktree.installDeps(worktreePath);
    if (!install.ok) return failure(install.error);

    // 3. Build tools (bound to the current worktree context)
    const tools = ToolBuilder.build(this.fs, this.shell, this.git);

    // 4. Run agent with fix loop
    const systemPrompt = this.promptService.build();
    let receiptResult = await this.runAgentWithRetry(
      systemPrompt,
      task,
      tools,
      config,
    );
    if (!receiptResult.ok) return failure(receiptResult.error);

    let receipt: Receipt = receiptResult.data;

    // 5. Verify agent actually made changes
    const files = this.git.changedFiles();
    const untracked = this.git.untrackedFiles();
    const allChanged = [...(files.ok ? files.data : []), ...(untracked.ok ? untracked.data : [])];

    if (allChanged.length === 0) {
      return failure(
        new Error("Agent reported completion but no files changed — re-run with explicit instructions"),
      );
    }

    // 6. Commit
    const commitType = slug.split("-")[0] ?? "chore";
    const validTypes = ["feat", "fix", "docs", "refactor", "chore", "test", "ci", "perf", "style"];
    const type = validTypes.includes(commitType) ? commitType : "chore";
    const summary = receipt.summary.slice(0, 50);

    this.git.addAll();
    const commit = this.git.commit(type, summary);
    if (!commit.ok) return failure(commit.error);

    // 7. Push
    const push = this.git.push(config.remote, slug);
    if (!push.ok) return failure(push.error);

    // 8. Create PR
    const prTemplate = this.writePrTemplate(receipt);
    const prResult = this.gh.createPr({
      base: config.baseBranch,
      head: slug,
      title: `${type}: ${summary}`,
      bodyFile: prTemplate,
    });
    if (!prResult.ok) return failure(prResult.error);

    // 9. Extract PR number
    const prView = this.gh.viewPr(
      parseInt(prResult.data.match(/\/pull\/(\d+)/)?.[1] ?? "0", 10),
    );
    const prNumber = prView.ok ? prView.data.number : 0;

    return success({
      receipt,
      prUrl: prResult.data,
      prNumber,
      branch: slug,
      worktreePath,
    });
  }

  /** Derive a branch slug from the task description. */
  private deriveSlug(task: string): string {
    // Try to detect a conventional-commit prefix from the task
    const prefixMatch = task.match(
      /^(feat|fix|docs|refactor|chore|test|ci|perf|style)/i,
    );
    const prefix = prefixMatch ? prefixMatch[1]!.toLowerCase() : "chore";

    const slugged = task
      .replace(/^[a-z]+[:(\s]+/i, "") // Remove prefix if present
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50 - prefix.length - 1);

    return `${prefix}-${slugged}`;
  }

  /** Run the agent, then verify, looping up to 3 times on failure. */
  private async runAgentWithRetry(
    systemPrompt: string,
    task: string,
    tools: readonly ToolRegistration[],
    config: SuperaConfig,
  ): Promise<Result<Receipt>> {
    const verificationService = new VerificationService(
      this.shell,
      process.cwd(),
    );

    for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
      // Run agent
      const agentResult = await this.agent.run({
        systemPrompt,
        task: attempt === 1 ? task : `PREVIOUS ATTEMPT FAILED. Fix these verification failures and re-verify:\n\n${task}`,
        tools,
        model: MODEL,
        maxIterations: MAX_ITERATIONS,
      });

      if (!agentResult.ok) {
        if (attempt === MAX_VERIFY_ATTEMPTS) return agentResult;
        continue;
      }

      let receipt = agentResult.data;

      // Verify
      const verifyResult = verificationService.verify(config);
      if (!verifyResult.ok) {
        if (attempt === MAX_VERIFY_ATTEMPTS) {
          // Verification infra failed — not the agent's fault
          return success({
            ...receipt,
            verification: { build: "fail", lint: "fail", unit: "fail" },
            notes: `Verification service error: ${String(verifyResult.error)}`,
          });
        }
        continue;
      }

      // Override self-reported verification with actual results
      receipt = { ...receipt, verification: verifyResult.data.gates };

      if (receiptAllPass(receipt)) {
        return success(receipt);
      }

      if (attempt === MAX_VERIFY_ATTEMPTS) {
        // Return the last receipt — orchestrator decides
        return success(receipt);
      }
    }

    return failure(new Error("Max verification attempts reached"));
  }

  /** Write a PR body template and return its path. */
  private writePrTemplate(receipt: Receipt): string {
    const templateDir = ".supera";
    const templatePath = `${templateDir}/pr-template.md`;

    this.shell.exec(`mkdir -p ${templateDir}`);

    const body = [
      "## Description",
      "",
      receipt.summary,
      "",
      "## Checklist",
      "",
      ...Object.entries(receipt.verification).map(
        ([gate, status]) =>
          `- [${status === "pass" ? "x" : " "}] ${gate} — ${status}`,
      ),
      "",
      ...(receipt.notes ? ["## Notes", "", receipt.notes, ""] : []),
    ].join("\n");

    this.fs.writeFile(templatePath, body);
    return templatePath;
  }
}
