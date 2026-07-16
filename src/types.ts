import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

// ── Supera config (matches schema/supera.schema.json) ──────────────────────

export interface SuperaConfig {
  baseBranch: string;
  remote: string;
  buildCommand?: string;
  lintCommand?: string;
  testCommands: Record<string, string>;
  mergeMethod: "merge" | "squash" | "rebase";
}

// ── Engineer receipt (matches schema/receipt.schema.json) ──────────────────

export type VerificationValue = "pass" | "fail" | "skipped";

export interface Receipt {
  summary: string;
  filesChanged: string[];
  verification: Record<string, VerificationValue>;
  notes?: string;
}

// ── Tool types ─────────────────────────────────────────────────────────────

/** Return value from every tool handler — always a plain string. */
export type ToolResult = string;

/** Input args for a tool call (parsed from OpenAI's JSON arguments). */
export type ToolArgs = Record<string, unknown>;

/** A tool handler receives parsed args and returns a deterministic string. */
export type ToolHandler = (args: ToolArgs) => ToolResult;

/** Tool registration: OpenAI function definition + handler. */
export interface ToolRegistration {
  definition: ChatCompletionTool;
  handler: ToolHandler;
}

// ── Agent types ────────────────────────────────────────────────────────────

export interface AgentRunConfig {
  /** OpenAI API key. */
  apiKey: string;
  /** Model identifier (defaults to gpt-4o). */
  model: string;
  /** Safety cutoff for the tool-calling loop. */
  maxIterations: number;
  /** Full system prompt text. */
  systemPrompt: string;
  /** Tools available to the agent. */
  tools: ToolRegistration[];
}

export interface AgentRunResult {
  receipt: Receipt;
  iterations: number;
}

// ── Tool-call message types (for the conversation) ─────────────────────────

export interface ToolCallDelta {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// ── Re-exports ─────────────────────────────────────────────────────────────

export type { ChatCompletionMessageParam, ChatCompletionTool };
