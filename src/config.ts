import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SuperaConfig } from "./types.js";

const CONFIG_FILE = ".claude/supera.json";

const DEFAULTS: SuperaConfig = {
  baseBranch: "main",
  remote: "origin",
  testCommands: {},
  mergeMethod: "squash",
};

/**
 * Walk up from `startDir` until a `.claude/supera.json` is found.
 * Returns the parsed config merged with defaults.
 */
export function loadConfig(startDir?: string): SuperaConfig {
  const dir = startDir ?? process.cwd();
  let current = resolve(dir);

  while (true) {
    const candidate = resolve(current, CONFIG_FILE);
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      return validate(parsed as Partial<SuperaConfig>);
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      throw new Error(
        `No ${CONFIG_FILE} found — run /start first. Searched from ${dir}`,
      );
    }
    current = parent;
  }
}

/** Merge user config with defaults, validate required fields. */
function validate(user: Partial<SuperaConfig>): SuperaConfig {
  const config: SuperaConfig = {
    baseBranch: user.baseBranch ?? DEFAULTS.baseBranch,
    remote: user.remote ?? DEFAULTS.remote,
    buildCommand: user.buildCommand,
    lintCommand: user.lintCommand,
    testCommands: user.testCommands ?? {},
    mergeMethod: validMergeMethod(user.mergeMethod),
  };

  if (!config.baseBranch || typeof config.baseBranch !== "string") {
    throw new Error("supera.json: baseBranch must be a non-empty string");
  }

  return config;
}

function validMergeMethod(
  raw?: string,
): "merge" | "squash" | "rebase" {
  if (raw === "merge" || raw === "squash" || raw === "rebase") return raw;
  return "squash";
}
