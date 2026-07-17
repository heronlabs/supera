import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import type { Result } from "../../core/types/result.js";
import { success, failure } from "../../core/types/result.js";

const REPO_ROOT: string = process.cwd();

export class NodeFsService {
  readFile(path: string, offset?: number, limit?: number): Result<string> {
    try {
      const safe = this.resolve(path);
      if (!existsSync(safe)) {
        return failure(new Error(`File not found: ${path}`));
      }
      if (statSync(safe).isDirectory()) {
        return failure(new Error(`Path is a directory: ${path}`));
      }

      const content = readFileSync(safe, "utf-8");
      const lines = content.split("\n");

      const start = Math.max((offset ?? 1) - 1, 0);
      const end = limit ? start + limit : lines.length;
      const page = lines.slice(start, end);
      const total = lines.length;

      const numbered = page
        .map((line, i) => `${String(start + i + 1).padStart(4, " ")}\t${line}`)
        .join("\n");

      return success(
        `${numbered}\n--- ${relative(REPO_ROOT, safe)}:${start + 1}-${start + page.length}/${total} lines ---`,
      );
    } catch (error) {
      return failure(error);
    }
  }

  writeFile(path: string, content: string): Result<string> {
    try {
      const safe = this.resolve(path);
      writeFileSync(safe, content, "utf-8");
      return success(
        `Wrote ${content.split("\n").length} lines to ${relative(REPO_ROOT, safe)}`,
      );
    } catch (error) {
      return failure(error);
    }
  }

  editFile(
    path: string,
    oldString: string,
    newString: string,
  ): Result<string> {
    try {
      const safe = this.resolve(path);
      if (!existsSync(safe)) {
        return failure(new Error(`File not found: ${path}`));
      }
      if (oldString === newString) {
        return failure(new Error("oldString and newString are identical"));
      }

      const content = readFileSync(safe, "utf-8");

      const firstIndex = content.indexOf(oldString);
      if (firstIndex === -1) {
        return failure(
          new Error(`oldString not found in ${path}. Use readFile to verify exact content.`),
        );
      }

      if (content.indexOf(oldString, firstIndex + 1) !== -1) {
        return failure(
          new Error(`oldString is not unique in ${path}. Provide more surrounding context.`),
        );
      }

      const replaced = content.replace(oldString, newString);
      writeFileSync(safe, replaced, "utf-8");

      return success(`Replaced 1 occurrence in ${relative(REPO_ROOT, safe)}`);
    } catch (error) {
      return failure(error);
    }
  }

  listFiles(path: string): Result<string[]> {
    try {
      const safe = this.resolve(path);
      if (!existsSync(safe)) {
        return failure(new Error(`Path not found: ${path}`));
      }
      if (!statSync(safe).isDirectory()) {
        return failure(new Error(`Not a directory: ${path}`));
      }

      const entries = readdirSync(safe, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => `${d.isDirectory() ? "d" : "f"} ${d.name}`);

      return success(lines);
    } catch (error) {
      return failure(error);
    }
  }

  searchFiles(pattern: string, path?: string): Result<string[]> {
    try {
      const safe = path ? this.resolve(path) : REPO_ROOT;
      if (!existsSync(safe)) {
        return failure(new Error(`Path not found: ${path ?? "."}`));
      }

      const { execSync } = require("node:child_process") as {
        execSync: typeof import("node:child_process").execSync;
      };

      const cmd =
        `grep -rn --include='*.ts' --include='*.js' --include='*.json' --include='*.md' --include='*.yml' --include='*.yaml' ` +
        `-e '${pattern.replace(/'/g, "'\\''")}' '${safe}' 2>/dev/null | head -100`;

      const stdout = execSync(cmd, {
        encoding: "utf-8",
        timeout: 15_000,
        cwd: REPO_ROOT,
      });

      return success(
        stdout.trim() ? stdout.trim().split("\n") : [],
      );
    } catch (error: unknown) {
      const execErr = error as { status?: number };
      if (execErr.status === 1) return success([]);
      return failure(error);
    }
  }

  private resolve(rawPath: string): string {
    const resolved = resolve(rawPath);
    if (!resolved.startsWith(REPO_ROOT)) {
      throw new Error(`Path outside repo: ${rawPath}`);
    }
    return resolved;
  }
}
