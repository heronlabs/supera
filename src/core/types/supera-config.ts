/**
 * Per-repo configuration loaded from .claude/supera.json.
 * Schema is defined in schema/supera.schema.json — this type mirrors it.
 */

export interface SuperaConfig {
  readonly baseBranch: string;
  readonly remote: string;
  readonly buildCommand?: string;
  readonly lintCommand?: string;
  readonly testCommands: Record<string, string>;
  readonly mergeMethod: "merge" | "squash" | "rebase";
}

export const DEFAULT_CONFIG: SuperaConfig = {
  baseBranch: "main",
  remote: "origin",
  testCommands: {},
  mergeMethod: "squash",
};
