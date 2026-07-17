import type { Result } from "../types/result.js";

/**
 * File system abstraction.
 *
 * All paths must be absolute — the implementation rejects relative paths
 * and path traversal attempts. Every method returns Result for explicit
 * error handling.
 */

export interface FileSystem {
  /** Read a file, returning numbered lines with a summary footer. */
  readFile(path: string, offset?: number, limit?: number): Result<string>;

  /** Create or overwrite a file. Returns confirmation. */
  writeFile(path: string, content: string): Result<string>;

  /**
   * Replace oldString with newString in a file.
   * oldString must be unique in the file — the implementation checks this.
   */
  editFile(path: string, oldString: string, newString: string): Result<string>;

  /** List directory contents, sorted alphabetically. Prefixes: 'd' and 'f'. */
  listFiles(path: string): Result<string[]>;

  /** Grep recursively. Returns matching lines (file:line:content). */
  searchFiles(pattern: string, path?: string): Result<string[]>;
}
