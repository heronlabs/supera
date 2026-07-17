import type { ToolRegistration, ToolArgs } from "../types/tool-definition.js";
import { NodeFsService } from "../../infrastructure/filesystem/node-fs-service.js";
import { ChildProcessService } from "../../infrastructure/terminal/child-process-service.js";
import { GitService } from "../../infrastructure/git/git-service.js";

/**
 * Builds the ToolRegistration array for the agent.
 *
 * Each tool maps a file system, shell, or git operation to an OpenAI
 * function definition. Handlers wrap the operation in try/catch and
 * return deterministic error strings so the model can self-correct.
 *
 * Tool argument parsing is intentionally simple — no Zod here.
 * This matches the reference repo's pattern of lightweight type guards.
 */

function error(tool: string, message: string): string {
  return `ERROR ${tool}: ${message}`;
}

export class ToolBuilder {
  static build(
    fs: NodeFsService,
    shell: ChildProcessService,
    git: GitService,
  ): readonly ToolRegistration[] {
    return [
      {
        definition: {
          type: "function",
          function: {
            name: "readFile",
            description:
              "Read a file from the local filesystem. Returns numbered lines with a summary footer.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Absolute path to the file." },
                offset: {
                  type: "number",
                  description: "Line number to start reading from (1-indexed).",
                },
                limit: {
                  type: "number",
                  description: "Maximum lines to read.",
                },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
        },
        handler: (args: ToolArgs): string => {
          try {
            const result = fs.readFile(
              String(args["path"]),
              typeof args["offset"] === "number" ? args["offset"] : undefined,
              typeof args["limit"] === "number" ? args["limit"] : undefined,
            );
            return result.ok ? result.data : `ERROR readFile: ${String(result.error)}`;
          } catch (e) {
            return error("readFile", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        definition: {
          type: "function",
          function: {
            name: "writeFile",
            description:
              "Create or overwrite a file. Use for new files or complete rewrites only. For partial edits, use editFile.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Absolute path to the file." },
                content: { type: "string", description: "Full file content." },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
        },
        handler: (args: ToolArgs): string => {
          try {
            const result = fs.writeFile(
              String(args["path"]),
              String(args["content"]),
            );
            return result.ok ? result.data : `ERROR writeFile: ${String(result.error)}`;
          } catch (e) {
            return error("writeFile", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        definition: {
          type: "function",
          function: {
            name: "editFile",
            description:
              "Replace a string in a file. oldString must match exactly and be unique in the file. Use readFile first to confirm the exact text.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Absolute path to the file." },
                oldString: {
                  type: "string",
                  description: "Exact text to replace (must be unique).",
                },
                newString: {
                  type: "string",
                  description: "Replacement text.",
                },
              },
              required: ["path", "oldString", "newString"],
              additionalProperties: false,
            },
          },
        },
        handler: (args: ToolArgs): string => {
          try {
            const result = fs.editFile(
              String(args["path"]),
              String(args["oldString"]),
              String(args["newString"]),
            );
            return result.ok ? result.data : `ERROR editFile: ${String(result.error)}`;
          } catch (e) {
            return error("editFile", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        definition: {
          type: "function",
          function: {
            name: "listFiles",
            description:
              "List files and directories. Returns entries prefixed with 'd' (directory) or 'f' (file).",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Absolute path to list." },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
        },
        handler: (args: ToolArgs): string => {
          try {
            const result = fs.listFiles(String(args["path"]));
            if (!result.ok) return `ERROR listFiles: ${String(result.error)}`;
            return result.data.join("\n") || "(empty directory)";
          } catch (e) {
            return error("listFiles", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        definition: {
          type: "function",
          function: {
            name: "searchFiles",
            description:
              "Search for a pattern in text files (grep -r). Returns matching file:line:content lines.",
            parameters: {
              type: "object",
              properties: {
                pattern: { type: "string", description: "Grep-compatible regex." },
                path: {
                  type: "string",
                  description: "Directory to search (default: repo root).",
                },
              },
              required: ["pattern"],
              additionalProperties: false,
            },
          },
        },
        handler: (args: ToolArgs): string => {
          try {
            const result = fs.searchFiles(
              String(args["pattern"]),
              args["path"] ? String(args["path"]) : undefined,
            );
            if (!result.ok) return `ERROR searchFiles: ${String(result.error)}`;
            return result.data.join("\n") || "(no matches)";
          } catch (e) {
            return error("searchFiles", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        definition: {
          type: "function",
          function: {
            name: "executeCommand",
            description:
              "Execute a shell command. Use for git, npm/pnpm, builds, tests — any shell operation needed during implementation.",
            parameters: {
              type: "object",
              properties: {
                command: { type: "string", description: "Shell command to run." },
                timeoutMs: {
                  type: "number",
                  description: "Timeout in milliseconds (max 600000).",
                },
                description: {
                  type: "string",
                  description: "What this command does (for logging).",
                },
              },
              required: ["command"],
              additionalProperties: false,
            },
          },
        },
        handler: (args: ToolArgs): string => {
          try {
            const result = shell.exec(
              String(args["command"]),
              typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : undefined,
            );
            if (!result.ok) return `ERROR executeCommand: ${String(result.error)}`;
            const out = result.data.stdout.trim();
            const err = result.data.stderr.trim();
            const parts: string[] = [];
            if (out) parts.push(out);
            if (err) parts.push(`stderr:\n${err}`);
            return `OK (exit ${result.data.exitCode}):\n${parts.join("\n") || "(no output)"}`;
          } catch (e) {
            return error("executeCommand", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        definition: {
          type: "function",
          function: {
            name: "gitDiff",
            description:
              "Show working tree changes (unstaged default, staged with staged:true). Returns diffstat.",
            parameters: {
              type: "object",
              properties: {
                staged: {
                  type: "boolean",
                  description: "Show staged changes instead of working tree changes.",
                },
              },
              additionalProperties: false,
            },
          },
        },
        handler: (args: ToolArgs): string => {
          try {
            const result = git.diffStat(args["staged"] === true);
            return result.ok ? result.data : `ERROR gitDiff: ${String(result.error)}`;
          } catch (e) {
            return error("gitDiff", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        definition: {
          type: "function",
          function: {
            name: "gitStatus",
            description:
              "Show git working tree status (porcelain format). Returns one line per changed file.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        },
        handler: (_args: ToolArgs): string => {
          try {
            const result = git.status();
            return result.ok ? result.data : `ERROR gitStatus: ${String(result.error)}`;
          } catch (e) {
            return error("gitStatus", e instanceof Error ? e.message : String(e));
          }
        },
      },
    ];
  }
}
