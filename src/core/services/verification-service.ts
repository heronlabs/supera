import type { Result } from "../types/result.js";
import type { SuperaConfig } from "../types/supera-config.js";
import type { VerificationValue } from "../types/receipt.js";
import { success, failure } from "../types/result.js";
import { ChildProcessService } from "../../infrastructure/terminal/child-process-service.js";

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

  verify(config: SuperaConfig): Result<VerificationResult> {
    const gates: Record<string, VerificationValue> = {};
    let allPassed = true;

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
