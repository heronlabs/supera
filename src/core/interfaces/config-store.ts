import type { Result } from "../types/result.js";
import type { SuperaConfig } from "../types/supera-config.js";

/**
 * Config persistence abstraction.
 *
 * load() walks up from startDir until it finds .claude/supera.json.
 * save() writes it to a specific path (used by the start command).
 */

export interface ConfigStore {
  /** Load and validate supera.json from the repo root. */
  load(startDir?: string): Result<SuperaConfig>;

  /** Write a supera.json at the given path. */
  save(path: string, config: SuperaConfig): Result<void>;
}
