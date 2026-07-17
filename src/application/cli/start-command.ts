import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SuperaConfig } from "../../core/types/supera-config.js";
import { DEFAULT_CONFIG } from "../../core/types/supera-config.js";

export class StartCommand {
  run(): SuperaConfig {
    const cwd = process.cwd();

    let buildCommand: string | undefined;
    let lintCommand: string | undefined;
    const testCommands: Record<string, string> = {};

    if (existsSync(join(cwd, "pnpm-lock.yaml"))) {
      buildCommand = "pnpm build";
      lintCommand = "pnpm lint:check";
      if (existsSync(join(cwd, "vitest.config.ts"))) {
        testCommands["unit"] = "pnpm test:unit";
      }
    } else if (existsSync(join(cwd, "yarn.lock"))) {
      buildCommand = "yarn build";
      lintCommand = "yarn lint";
      testCommands["unit"] = "yarn test";
    } else if (existsSync(join(cwd, "package-lock.json"))) {
      buildCommand = "npm run build";
      lintCommand = "npm run lint";
      testCommands["unit"] = "npm test";
    } else if (existsSync(join(cwd, "Cargo.toml"))) {
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

    const superaDir = join(cwd, ".claude");
    const configPath = join(superaDir, "supera.json");

    if (!existsSync(superaDir)) {
      mkdirSync(superaDir, { recursive: true });
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    return config;
  }
}
