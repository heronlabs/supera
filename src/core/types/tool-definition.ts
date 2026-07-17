import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * A tool the agent can call. Pairs the OpenAI function schema
 * with the handler that executes it locally.
 *
 * Handlers must be synchronous and return a deterministic string.
 * Errors are returned as strings (prefixed with ERROR <tool>: ...)
 * so the LLM can read them and self-correct.
 */

export type ToolArgs = Record<string, unknown>;

export type ToolHandler = (args: ToolArgs) => string;

export interface ToolRegistration {
  readonly definition: ChatCompletionTool;
  readonly handler: ToolHandler;
}

export { type ChatCompletionTool };
