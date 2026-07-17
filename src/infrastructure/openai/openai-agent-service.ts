import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Result } from "../../core/types/result.js";
import type { Receipt } from "../../core/types/receipt.js";
import type { ToolRegistration } from "../../core/types/tool-definition.js";
import type {
  AgentRunner,
  AgentRunnerConfig,
} from "../../core/interfaces/agent-runner.js";
import { success, failure } from "../../core/types/result.js";

/**
 * Runs the agent loop via OpenAI's chat completions API.
 *
 * Implements the AgentRunner interface. This is the "brain" —
 * it sends the system prompt + task to the model, executes tool calls,
 * feeds observations back, and parses the receipt when the model finishes.
 *
 * Tool handlers MUST be synchronous and return deterministic strings.
 * Errors are returned as strings (not thrown) so the model can self-correct.
 */

interface ToolCallDelta {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export class OpenAIAgentService implements AgentRunner {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async run(config: AgentRunnerConfig): Promise<Result<Receipt>> {
    const openai = new OpenAI({ apiKey: this.apiKey });

    const tools: ChatCompletionTool[] = config.tools.map((t) => t.definition);
    const handlerMap = new Map(
      config.tools.map((t) => [t.definition.function.name, t.handler]),
    );

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: config.systemPrompt },
      { role: "user", content: config.task },
    ];

    let iterations = 0;

    try {
      while (iterations < config.maxIterations) {
        iterations++;

        const response = await openai.chat.completions.create({
          model: config.model,
          messages,
          tools,
          tool_choice: "auto",
        });

        const choice = response.choices[0];
        if (!choice?.message) {
          return failure(new Error("OpenAI returned no response choice"));
        }

        const msg = choice.message;

        // No tool calls → model produced final content. Try to parse receipt.
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          messages.push({
            role: "assistant",
            content: msg.content ?? null,
          });

          const receipt = tryParseReceipt(msg.content);
          if (receipt) {
            return success(receipt);
          }
          // No receipt yet — model may still be reasoning. Continue loop.
          continue;
        }

        // Push assistant message with tool calls
        messages.push({
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: msg.tool_calls.map(
            (tc): ToolCallDelta => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }),
          ),
        });

        // Execute each tool call, push results
        for (const tc of msg.tool_calls) {
          const handler = handlerMap.get(tc.function.name);
          let result: string;

          if (!handler) {
            result = `ERROR: Unknown tool '${tc.function.name}'. Available: ${[...handlerMap.keys()].join(", ")}`;
          } else {
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(
                tc.function.arguments,
              ) as Record<string, unknown>;
            } catch {
              result = `ERROR: Invalid JSON arguments for tool '${tc.function.name}': ${tc.function.arguments}`;
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: result,
              });
              continue;
            }
            result = handler(args);
          }

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          });
        }
      }

      return failure(
        new Error(
          `Agent failed to complete after ${config.maxIterations} iterations`,
        ),
      );
    } catch (error) {
      return failure(error);
    }
  }
}

/**
 * Try to extract a JSON receipt from the model's final content.
 * Supports both plain JSON and ```json ... ``` code blocks.
 */
function tryParseReceipt(content: string | null): Receipt | null {
  if (!content) return null;

  const fenceMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = fenceMatch ? fenceMatch[1]!.trim() : content.trim();

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (isReceipt(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Minimal type guard for Receipt shape. */
function isReceipt(value: unknown): value is Receipt {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["summary"] === "string" &&
    Array.isArray(r["filesChanged"]) &&
    typeof r["verification"] === "object" &&
    r["verification"] !== null
  );
}
