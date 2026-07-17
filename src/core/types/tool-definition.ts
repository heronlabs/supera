import type { ChatCompletionTool } from "openai/resources/chat/completions";

export type ToolArgs = Record<string, unknown>;

export type ToolHandler = (args: ToolArgs) => string;

export interface ToolRegistration {
  readonly definition: ChatCompletionTool;
  readonly handler: ToolHandler;
}

export { type ChatCompletionTool };
