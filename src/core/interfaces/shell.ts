import type { Result } from "../types/result.js";

/**
 * Shell command execution abstraction.
 *
 * Operations that modify state (git, npm, etc.) go through this interface.
 * The implementation wraps execSync or spawn with timeouts and error capture.
 */

export interface ShellOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface Shell {
  /** Execute a command, return stdout/stderr/exitCode. Never throws. */
  exec(command: string, timeoutMs?: number): Result<ShellOutput>;
}
