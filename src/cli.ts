#!/usr/bin/env node

import { ShipCommand } from "./application/cli/ship-command.js";
import { StartCommand } from "./application/cli/start-command.js";
import type { ShipInputs } from "./application/cli/types/ship-input.js";
import type { ShipOutputs } from "./application/cli/types/ship-output.js";
import { ConfigLoaderService } from "./core/services/config-loader-service.js";
import { ShipOrchestratorService } from "./core/services/ship-orchestrator-service.js";
import { WorktreeService } from "./core/services/worktree-service.js";
import { SystemPromptService } from "./core/services/system-prompt-service.js";
import { ChildProcessService } from "./infrastructure/terminal/child-process-service.js";
import { GitService } from "./infrastructure/git/git-service.js";
import { GhService } from "./infrastructure/gh/gh-service.js";
import { NodeFsService } from "./infrastructure/filesystem/node-fs-service.js";
import { OpenAIAgentService } from "./infrastructure/openai/openai-agent-service.js";

export class CommandsFactory {
  static makeShip(): ShipCommand {
    const cwd = process.cwd();

    const shell = new ChildProcessService(cwd);
    const git = new GitService(shell);
    const gh = new GhService(cwd, shell);
    const fs = new NodeFsService();
    const configLoader = new ConfigLoaderService();
    const worktree = new WorktreeService(git, shell);
    const promptService = new SystemPromptService();

    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }
    const agent = new OpenAIAgentService(apiKey);

    const orchestrator = new ShipOrchestratorService(
      git,
      gh,
      shell,
      fs,
      agent,
      worktree,
      promptService,
    );

    return new ShipCommand(orchestrator, configLoader);
  }

  static makeStart(): StartCommand {
    return new StartCommand();
  }
}

const USAGE = [
  "supera — Autonomous AI agent for shipping code.",
  "",
  "Usage:",
  "  supera ship \"<task description>\"   Implement a task end-to-end",
  "  supera start                       Bootstrap supera.json for a repo",
  "  supera --help                      Show this help",
  "",
  "Environment:",
  "  OPENAI_API_KEY    (required)  OpenAI API key",
  "  OPENAI_MODEL      (gpt-4o)    Model identifier",
  "  MAX_ITERATIONS    (40)        Safety cutoff for the tool-calling loop",
].join("\n");

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const command = args[0];
  const rest = args.slice(1);

  try {
    switch (command) {
      case "ship": {
        if (rest.length === 0) {
          process.stderr.write(
            "Error: 'ship' requires a task description.\n",
          );
          process.exit(1);
        }

        const task = rest.join(" ");
        const shipCommand = CommandsFactory.makeShip();

        const inputs: ShipInputs = {
          task,
          openaiApiKey: process.env["OPENAI_API_KEY"] ?? "",
          openaiModel: process.env["OPENAI_MODEL"] ?? "gpt-4o",
          maxIterations: parseInt(
            process.env["MAX_ITERATIONS"] ?? "40",
            10,
          ),
        };

        process.stderr.write(
          `[supera] Shipping: ${task.slice(0, 80)}...\n`,
        );

        const outputs: ShipOutputs = await shipCommand.run(inputs);

        process.stderr.write(
          `[supera] Done — PR #${outputs.prNumber}: ${outputs.prUrl}\n`,
        );
        process.stderr.write(
          `[supera] Verification: ${JSON.stringify(outputs.receipt.verification)}\n`,
        );

        process.stdout.write(
          `${JSON.stringify(outputs.receipt, null, 2)}\n`,
        );
        break;
      }

      case "start": {
        const startCommand = CommandsFactory.makeStart();
        const config = startCommand.run();

        process.stderr.write("[supera] Bootstrapped .claude/supera.json\n");
        process.stderr.write(
          `[supera] Config: ${JSON.stringify(config, null, 2)}\n`,
        );
        break;
      }

      default: {
        process.stderr.write(`Unknown command: ${command}\n`);
        process.stderr.write(`${USAGE}\n`);
        process.exit(1);
      }
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

void main();
