import type { Result } from "../types/result.js";
import type { Receipt } from "../types/receipt.js";
import type { ToolRegistration } from "../types/tool-definition.js";

/**
 * Runs the AI agent loop.
 *
 * The agent receives a system prompt, a task description, and a set of tools.
 * It iterates on tool calls until it produces a Receipt (or max iterations).
 *
 * This is the core contract — implementations can swap the model backend
 * (OpenAI, Claude, local) without changing the orchestrator.
 */

export interface AgentRunnerConfig {
  readonly systemPrompt: string;
  readonly task: string;
  readonly tools: readonly ToolRegistration[];
  readonly model: string;
  readonly maxIterations: number;
}

export interface AgentRunner {
  run(config: AgentRunnerConfig): Promise<Result<Receipt>>;
}
