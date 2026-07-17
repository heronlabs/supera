import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SuperaConfig } from "../../core/types/supera-config.js";
import { DEFAULT_CONFIG } from "../../core/types/supera-config.js";

/**
 * Start command — bootstraps .claude/supera.json for a repo.
 *
 * Detects the stack (pnpm/npm/yarn/cargo), writes a minimal config.
 * Placeholder implementation — the full version would run build/lint/test
 * dry-runs to discover working commands.
 */

export class StartCommand {
  run(): SuperaConfig {
    const cwd = process.cwd();

    // Detect package manager
    const fs = require("node:fs") as typeof import("node:fs");
    let buildCommand: string | undefined;
    let lintCommand: string | undefined;
    const testCommands: Record<string, string> = {};

    if (fs.existsSync(join(cwd, "pnpm-lock.yaml"))) {
      buildCommand = "pnpm build";
      lintCommand = "pnpm lint:check";
      if (fs.existsSync(join(cwd, "vitest.config.ts"))) {
        testCommands["unit"] = "pnpm test:unit";
      }
    } else if (fs.existsSync(join(cwd, "yarn.lock"))) {
      buildCommand = "yarn build";
      lintCommand = "yarn lint";
      testCommands["unit"] = "yarn test";
    } else if (fs.existsSync(join(cwd, "package-lock.json"))) {
      buildCommand = "npm run build";
      lintCommand = "npm run lint";
      testCommands["unit"] = "npm test";
    } else if (fs.existsSync(join(cwd, "Cargo.toml"))) {
      buildCommand = "cargo build";
      lintCommand = "cargo clippy";
      testCommands["unit"] = "cargo test";
    }

    const config: SuperaConfig = {
      ...DEFAULT_CONFIG,
      buildCommand,
      lintCommand,
      testCommands,
    };

    // Write the config
    const superaDir = join(cwd, ".claude");
    const configPath = join(superaDir, "supera.json");

    if (!fs.existsSync(superaDir)) {
      fs.mkdirSync(superaDir, { recursive: true });
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    return config;
  }
}
