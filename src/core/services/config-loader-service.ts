import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Result } from "../types/result.js";
import type { SuperaConfig } from "../types/supera-config.js";
import { DEFAULT_CONFIG } from "../types/supera-config.js";
import { success, failure } from "../types/result.js";

const CONFIG_FILE = ".claude/supera.json";

export class ConfigLoaderService {
  load(startDir?: string): Result<SuperaConfig> {
    const dir = startDir ?? process.cwd();
    let current = resolve(dir);

    while (true) {
      const candidate = resolve(current, CONFIG_FILE);
      if (existsSync(candidate)) {
        try {
          const raw = readFileSync(candidate, "utf-8");
          const parsed: unknown = JSON.parse(raw);
          const config = this.validate(parsed as Partial<SuperaConfig>);
          return success(config);
        } catch (error) {
          return failure(
            new Error(
              `Failed to parse ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      }

      const parent = resolve(current, "..");
      if (parent === current) {
        return failure(
          new Error(
            `No ${CONFIG_FILE} found — run /start first. Searched from ${dir}`,
          ),
        );
      }
      current = parent;
    }
  }

  private validate(raw: Partial<SuperaConfig>): SuperaConfig {
    const config: SuperaConfig = {
      baseBranch: raw.baseBranch ?? DEFAULT_CONFIG.baseBranch,
      remote: raw.remote ?? DEFAULT_CONFIG.remote,
      buildCommand: raw.buildCommand,
      lintCommand: raw.lintCommand,
      testCommands: raw.testCommands ?? {},
      mergeMethod: this.validMergeMethod(raw.mergeMethod),
    };

    if (!config.baseBranch || typeof config.baseBranch !== "string") {
      throw new Error("supera.json: baseBranch must be a non-empty string");
    }

    return config;
  }

  private validMergeMethod(
    raw?: string,
  ): "merge" | "squash" | "rebase" {
    if (raw === "merge" || raw === "squash" || raw === "rebase") return raw;
    return "squash";
  }
}
