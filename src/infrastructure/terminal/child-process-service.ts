import { execSync } from "node:child_process";
import type { Result } from "../../core/types/result.js";
import { success, failure } from "../../core/types/result.js";

export interface ShellOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

type ExecChainResult = ChainResult | FailedChainResult;

export interface ChainResult {
  readonly ok: true;
  readonly data: string;
  execChain(nextCommand: string): ExecChainResult;
}

export interface FailedChainResult {
  readonly ok: false;
  readonly error: unknown;
  execChain(_nextCommand: string): ExecChainResult;
}

export class ChildProcessService {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  exec(command: string, timeoutMs?: number): Result<ShellOutput> {
    try {
      const stdout = execSync(command, {
        cwd: this.cwd,
        encoding: "utf-8",
        timeout: Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
        stdio: "pipe",
        maxBuffer: 10 * 1024 * 1024,
      });

      return success({
        stdout: stdout.trim(),
        stderr: "",
        exitCode: 0,
      });
    } catch (error: unknown) {
      const execErr = error as {
        stdout?: Buffer | string;
        stderr?: Buffer | string;
        status?: number;
        message?: string;
      };

      return success({
        stdout: (execErr.stdout?.toString() ?? "").trim(),
        stderr: (execErr.stderr?.toString() ?? "").trim(),
        exitCode: execErr.status ?? 1,
      });
    }
  }

  execChain(command: string): ExecChainResult {
    try {
      const data = execSync(command, {
        cwd: this.cwd,
        encoding: "utf-8",
        timeout: DEFAULT_TIMEOUT_MS,
        stdio: "pipe",
        maxBuffer: 10 * 1024 * 1024,
      }).trim();

      return {
        ok: true,
        data,
        execChain: (nextCommand: string) => this.execChain(nextCommand),
      };
    } catch (error: unknown) {
      const result: FailedChainResult = {
        ok: false,
        error,
        execChain: () => result,
      };
      return result;
    }
  }

  hasCommand(cmd: string): boolean {
    const result = this.exec(`which ${cmd}`);
    return result.ok && result.data.exitCode === 0;
  }
}
