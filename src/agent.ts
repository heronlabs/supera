import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  AgentRunConfig,
  AgentRunResult,
  Receipt,
  ToolCallDelta,
} from "./types.js";

/**
 * Run the supera agent loop.
 *
 * Sends the system prompt + task to OpenAI, iterates on tool calls,
 * feeds observations back, parses the final receipt.
 */
export async function runAgent(
  config: AgentRunConfig,
  task: string,
): Promise<AgentRunResult> {
  const openai = new OpenAI({ apiKey: config.apiKey });

  const tools: ChatCompletionTool[] = config.tools.map((t) => t.definition);
  const handlerMap = new Map(
    config.tools.map((t) => [t.definition.function.name, t.handler]),
  );

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: task },
  ];

  let iterations = 0;

  while (iterations < config.maxIterations) {
    iterations++;

    const response = await openai.chat.completions.create({
      model: config.model,
      messages,
      tools,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    if (!choice || !choice.message) {
      throw new Error("OpenAI returned no response choice");
    }

    const msg = choice.message;

    // Build assistant message block — with or without tool_calls
    if (msg.tool_calls && msg.tool_calls.length > 0) {
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
    } else {
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
      });
    }

    // No tool calls → model produced final content. Try to parse receipt.
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const receipt = tryParseReceipt(msg.content);
      if (receipt) {
        return { receipt, iterations };
      }
      // No receipt yet — model may still be reasoning. Continue loop.
      continue;
    }

    // Execute each tool call
    for (const tc of msg.tool_calls) {
      const handler = handlerMap.get(tc.function.name);
      let result: string;

      if (!handler) {
        result = `ERROR: Unknown tool '${tc.function.name}'. Available: ${[...handlerMap.keys()].join(", ")}`;
      } else {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
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

  throw new Error(
    `Agent failed to complete after ${config.maxIterations} iterations. Last message content: ${
      (messages[messages.length - 1] as { content?: string }).content?.slice(0, 200) ?? "none"
    }`,
  );
}

/**
 * Try to extract a JSON receipt from the model's final content.
 * Supports both plain JSON and ```json ... ``` code blocks.
 */
function tryParseReceipt(content: string | null): Receipt | null {
  if (!content) return null;

  // Try code-fenced JSON first
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
