import type { Result, VoidResult } from "../types/result.js";
import type { SuperaConfig } from "../types/supera-config.js";
import type { VerificationValue } from "../types/receipt.js";
import { success, failure, ok } from "../types/result.js";
import { ChildProcessService } from "../../infrastructure/terminal/child-process-service.js";

/**
 * Runs the verification gates: build, lint, and test layers.
 *
 * Reads commands from SuperaConfig. Each gate that is configured
 * gets a 'pass' or 'fail'. Unconfigured gates are 'skipped'.
 */

export interface VerificationResult {
  readonly allPassed: boolean;
  readonly gates: Record<string, VerificationValue>;
}

export class VerificationService {
  private readonly shell: ChildProcessService;
  private readonly cwd: string;

  constructor(shell: ChildProcessService, cwd?: string) {
    this.shell = shell;
    this.cwd = cwd ?? process.cwd();
  }

  /** Run all configured verification gates. */
  verify(config: SuperaConfig): Result<VerificationResult> {
    const gates: Record<string, VerificationValue> = {};
    let allPassed = true;

    // Build
    if (config.buildCommand) {
      const result = this.exec(config.buildCommand);
      if (!result.ok) {
        gates["build"] = "fail";
        allPassed = false;
      } else {
        gates["build"] = result.data;
        if (result.data === "fail") allPassed = false;
      }
    }

    // Lint
    if (config.lintCommand) {
      const result = this.exec(config.lintCommand);
      if (!result.ok) {
        gates["lint"] = "fail";
        allPassed = false;
      } else {
        gates["lint"] = result.data;
        if (result.data === "fail") allPassed = false;
      }
    }

    // Test layers (unit, integration, e2e, ...)
    const testLayers = Object.keys(config.testCommands);
    for (const layer of testLayers) {
      const cmd = config.testCommands[layer];
      if (!cmd) {
        gates[layer] = "skipped";
        continue;
      }
      const result = this.exec(cmd);
      if (!result.ok) {
        gates[layer] = "fail";
        allPassed = false;
      } else {
        gates[layer] = result.data;
        if (result.data === "fail") allPassed = false;
      }
    }

    // If no gates at all, report empty
    if (Object.keys(gates).length === 0) {
      gates["build"] = "skipped";
      gates["lint"] = "skipped";
      gates["unit"] = "skipped";
    }

    return success({ allPassed, gates });
  }

  private exec(command: string): Result<VerificationValue> {
    const result = this.shell.exec(command);
    if (!result.ok) return failure(result.error);
    return success(result.data.exitCode === 0 ? "pass" : "fail");
  }
}
