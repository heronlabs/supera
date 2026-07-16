#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { runAgent } from "./agent.js";
import { TOOLS } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { AgentRunConfig } from "./types.js";

const USAGE = `
supera — Autonomous AI agent for shipping code.

Usage:
  supera ship "<task description>"   Implement a task end-to-end
  supera start                       Bootstrap supera.json for a repo
  supera --help                      Show this help

Environment:
  OPENAI_API_KEY    (required)  OpenAI API key
  OPENAI_MODEL      (gpt-4o)    Model identifier
  MAX_ITERATIONS    (40)        Safety cutoff for the tool-calling loop
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];
  const taskArgs = args.slice(1);

  switch (command) {
    case "ship": {
      if (taskArgs.length === 0) {
        console.error("Error: 'ship' requires a task description.");
        console.error("Usage: supera ship \"<task description>\"");
        process.exit(1);
      }

      const task = taskArgs.join(" ");
      const config = loadConfig();

      const apiKey = process.env["OPENAI_API_KEY"];
      if (!apiKey) {
        console.error("Error: OPENAI_API_KEY environment variable is required.");
        process.exit(1);
      }

      const agentConfig: AgentRunConfig = {
        apiKey,
        model: process.env["OPENAI_MODEL"] ?? "gpt-4o",
        maxIterations: parseInt(process.env["MAX_ITERATIONS"] ?? "40", 10),
        systemPrompt: buildSystemPrompt(),
        tools: TOOLS,
      };

      console.error(`[supera] Starting agent for task: ${task.slice(0, 80)}...`);
      console.error(`[supera] Config: base=${config.baseBranch}, remote=${config.remote}, model=${agentConfig.model}`);

      try {
        const result = await runAgent(agentConfig, task);
        console.error(`[supera] Complete — ${result.iterations} iterations.`);
        console.error(`[supera] Verification: ${JSON.stringify(result.receipt.verification)}`);

        // Output the receipt as JSON to stdout for orchestrator consumption
        console.log(JSON.stringify(result.receipt, null, 2));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[supera] Failed: ${message}`);
        process.exit(1);
      }
      break;
    }

    case "start": {
      // Placeholder — bootstraps supera.json by detecting stack
      console.error("[supera] 'start' command not yet implemented. Coming soon.");
      process.exit(0);
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error(USAGE);
      process.exit(1);
    }
  }
}

main();
