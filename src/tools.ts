import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { execSync } from "node:child_process";
import type { ToolRegistration, ToolArgs } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const REPO_ROOT: string = process.cwd();

function error(tool: string, message: string): string {
  return `ERROR ${tool}: ${message}`;
}

function ok(tool: string, detail: string): string {
  return `OK ${tool}: ${detail}`;
}

function safeResolve(rawPath: string): string {
  const resolved = resolve(rawPath);
  // Prevent path traversal outside the repo
  if (!resolved.startsWith(REPO_ROOT)) {
    throw new Error(`Path outside repo: ${rawPath}`);
  }
  return resolved;
}

// ── Tool handlers ──────────────────────────────────────────────────────────

function handleReadFile(args: ToolArgs): string {
  try {
    const path = safeResolve(String(args["path"]));
    if (!existsSync(path)) {
      return error("readFile", `File not found: ${args["path"]}`);
    }
    if (statSync(path).isDirectory()) {
      return error("readFile", `Path is a directory: ${args["path"]}`);
    }

    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n");

    const offset = typeof args["offset"] === "number" ? args["offset"] : 1;
    const limit = typeof args["limit"] === "number" ? args["limit"] : lines.length;

    if (offset < 1) {
      return error("readFile", "offset must be >= 1");
    }

    const page = lines.slice(offset - 1, offset - 1 + limit);
    const total = lines.length;

    return page
      .map((line, i) => `${String(offset + i).padStart(4, " ")}\t${line}`)
      .join("\n") +
      `\n--- ${path}:${offset}-${offset + page.length - 1}/${total} lines ---`;
  } catch (e: unknown) {
    return error("readFile", e instanceof Error ? e.message : String(e));
  }
}

function handleWriteFile(args: ToolArgs): string {
  try {
    const path = safeResolve(String(args["path"]));
    const content = String(args["content"]);
    writeFileSync(path, content, "utf-8");
    return ok("writeFile", `Wrote ${content.split("\n").length} lines to ${relative(REPO_ROOT, path)}`);
  } catch (e: unknown) {
    return error("writeFile", e instanceof Error ? e.message : String(e));
  }
}

function handleEditFile(args: ToolArgs): string {
  try {
    const path = safeResolve(String(args["path"]));
    if (!existsSync(path)) {
      return error("editFile", `File not found: ${args["path"]}`);
    }

    const oldStr = String(args["oldString"]);
    const newStr = String(args["newString"]);

    if (oldStr === newStr) {
      return error("editFile", "oldString and newString are identical");
    }

    const content = readFileSync(path, "utf-8");

    const firstIndex = content.indexOf(oldStr);
    if (firstIndex === -1) {
      return error("editFile", `oldString not found in ${args["path"]}. Use readFile to check exact content.`);
    }

    // Verify uniqueness
    if (content.indexOf(oldStr, firstIndex + 1) !== -1) {
      return error("editFile", `oldString is not unique in ${args["path"]}. Provide more surrounding context.`);
    }

    const replaced = content.replace(oldStr, newStr);
    writeFileSync(path, replaced, "utf-8");

    return ok("editFile", `Replaced 1 occurrence in ${relative(REPO_ROOT, path)}`);
  } catch (e: unknown) {
    return error("editFile", e instanceof Error ? e.message : String(e));
  }
}

function handleListFiles(args: ToolArgs): string {
  try {
    const path = safeResolve(String(args["path"]));
    if (!existsSync(path)) {
      return error("listFiles", `Path not found: ${args["path"]}`);
    }
    if (!statSync(path).isDirectory()) {
      return error("listFiles", `Not a directory: ${args["path"]}`);
    }

    const entries = readdirSync(path, { withFileTypes: true });
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => `${d.isDirectory() ? "d" : "f"} ${d.name}`);

    return lines.join("\n") || "(empty directory)";
  } catch (e: unknown) {
    return error("listFiles", e instanceof Error ? e.message : String(e));
  }
}

function handleSearchFiles(args: ToolArgs): string {
  try {
    const pattern = String(args["pattern"]);
    const searchPath = args["path"] ? safeResolve(String(args["path"])) : REPO_ROOT;

    if (!existsSync(searchPath)) {
      return error("searchFiles", `Path not found: ${args["path"] ?? "."}`);
    }

    // Use grep -r for recursive search, respecting .gitignore via :(exclude) pathspec
    const cmd = `grep -rn --include='*.ts' --include='*.js' --include='*.json' --include='*.md' --include='*.yml' --include='*.yaml' -e '${pattern.replace(/'/g, "'\\''")}' '${searchPath}' 2>/dev/null | head -100`;
    const result = execSync(cmd, { encoding: "utf-8", timeout: 15_000, cwd: REPO_ROOT });
    return result.trim() || "(no matches)";
  } catch (e: unknown) {
    const execErr = e as { stderr?: string; status?: number };
    if (execErr.status === 1) return "(no matches)";
    return error("searchFiles", e instanceof Error ? e.message : String(e));
  }
}

function handleExecuteCommand(args: ToolArgs): string {
  try {
    const cmd = String(args["command"]);
    const timeoutMs = typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : 120_000;

    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: Math.min(timeoutMs, 600_000),
      cwd: REPO_ROOT,
      maxBuffer: 10 * 1024 * 1024,
    });

    return `OK command:\n${result.trim() || "(no output)"}`;
  } catch (e: unknown) {
    const execErr = e as { stdout?: string; stderr?: string; status?: number };
    const out = execErr.stdout?.trim();
    const errOut = execErr.stderr?.trim();
    const parts: string[] = [];
    if (out) parts.push(`stdout:\n${out}`);
    if (errOut) parts.push(`stderr:\n${errOut}`);
    const detail = parts.join("\n") || (e instanceof Error ? e.message : String(e));
    return `ERROR command (exit ${execErr.status ?? 1}): ${detail}`;
  }
}

function handleGitDiff(args: ToolArgs): string {
  try {
    const staged = args["staged"] === true;
    const cmd = staged ? "git diff --cached --stat" : "git diff --stat";
    const result = execSync(cmd, { encoding: "utf-8", timeout: 15_000, cwd: REPO_ROOT });
    return result.trim() || "(no changes)";
  } catch (e: unknown) {
    return error("gitDiff", e instanceof Error ? e.message : String(e));
  }
}

function handleGitStatus(args: ToolArgs): string {
  try {
    const result = execSync("git status --porcelain", {
      encoding: "utf-8",
      timeout: 15_000,
      cwd: REPO_ROOT,
    });
    return result.trim() || "(clean — no changes)";
  } catch (e: unknown) {
    return error("gitStatus", e instanceof Error ? e.message : String(e));
  }
}

// ── Tool registry ──────────────────────────────────────────────────────────

export const TOOLS: ToolRegistration[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "readFile",
        description:
          "Read a file from the local filesystem. Returns numbered lines with a summary footer. Use for exploring code, reading config, checking existing patterns.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path to the file.",
            },
            offset: {
              type: "number",
              description: "Line number to start reading from (1-indexed, default 1).",
            },
            limit: {
              type: "number",
              description: "Maximum lines to read (default: all).",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    handler: handleReadFile,
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
            path: {
              type: "string",
              description: "Absolute path to the file.",
            },
            content: {
              type: "string",
              description: "Full file content.",
            },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    handler: handleWriteFile,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "editFile",
        description:
          "Replace a string in a file with another string. The oldString must match exactly (including whitespace) and be unique in the file. Use readFile first to confirm the exact text.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path to the file.",
            },
            oldString: {
              type: "string",
              description: "Exact text to replace (must be unique in the file).",
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
    handler: handleEditFile,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "listFiles",
        description:
          "List files and directories in a path. Returns entries prefixed with 'd' (directory) or 'f' (file), sorted alphabetically.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path to list.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    handler: handleListFiles,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "searchFiles",
        description:
          "Search for a pattern recursively in text files (grep -r). Returns matching file:line:content lines, capped at 100 results.",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Grep-compatible regex pattern.",
            },
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
    handler: handleSearchFiles,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "executeCommand",
        description:
          "Execute a shell command and return stdout/stderr. Use for git operations, npm/pnpm commands, builds, tests — any shell command needed during implementation.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Shell command to run.",
            },
            timeoutMs: {
              type: "number",
              description: "Timeout in milliseconds (default 120000, max 600000).",
            },
            description: {
              type: "string",
              description: "Short description of what this command does (for logging).",
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
    handler: handleExecuteCommand,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "gitDiff",
        description:
          "Show working tree changes (unstaged by default, staged with staged:true). Returns diffstat — file names and change counts.",
        parameters: {
          type: "object",
          properties: {
            staged: {
              type: "boolean",
              description: "Show staged (git add'ed) changes instead of working tree changes.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    handler: handleGitDiff,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "gitStatus",
        description:
          "Show git working tree status in short format. Returns one line per changed file: 'M' for modified, '??' for untracked, 'D' for deleted.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    handler: handleGitStatus,
  },
];
