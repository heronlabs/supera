/**
 * Daily metrics rollup. Reads the run-telemetry events collected from the
 * dogfood fleet's GitHub Actions artifacts, drops anything that no longer
 * conforms to schema/metrics-event.schema.json, dedups on gh.run_id, appends
 * the genuinely new events to events.jsonl, and regenerates DASHBOARD.md
 * (per-skill cost/turn/duration percentiles, success rate, and regressions).
 *
 * The pure helpers (percentile, dedupeByRunId, summarize, renderDashboard) hold
 * the only non-trivial logic on the telemetry path and are exported so
 * src/validate.ts exercises them in the repo's single gate. runRollup wires
 * them to the filesystem; main() is the CLI entry the metrics-rollup workflow
 * invokes via jiti.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export interface MetricsEvent {
  schema_version: string;
  ts: string;
  repo: string;
  skill: string;
  event: string;
  outcome: string;
  model: string;
  stack: string;
  run: {
    cost_usd: number;
    num_turns: number;
    duration_ms: number;
    tokens: {
      input: number;
      output: number;
      cache_read: number;
      cache_creation: number;
    };
  };
  gh: {run_id: number; run_attempt: number};
}

export interface SkillSummary {
  skill: string;
  runs: number;
  successRate: number;
  cost: {p50: number; p95: number};
  turns: {p50: number; p95: number};
  durationSeconds: {p50: number; p95: number};
  costRegression: number | null;
}

/** Linear-interpolation percentile; empty series is 0. */
export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
};

/** Append only events whose gh.run_id has not been seen, preserving order. */
export const dedupeByRunId = <T extends {gh: {run_id: number}}>(
  existing: T[],
  incoming: T[],
): T[] => {
  const seen = new Set(existing.map(event => event.gh.run_id));
  const added: T[] = [];
  for (const event of incoming) {
    if (seen.has(event.gh.run_id)) continue;
    seen.add(event.gh.run_id);
    added.push(event);
  }
  return [...existing, ...added];
};

const costRegression = (chronological: MetricsEvent[]): number | null => {
  if (chronological.length < 4) return null;
  const mid = Math.floor(chronological.length / 2);
  const priorP50 = percentile(
    chronological.slice(0, mid).map(event => event.run.cost_usd),
    50,
  );
  const recentP50 = percentile(
    chronological.slice(mid).map(event => event.run.cost_usd),
    50,
  );
  if (priorP50 === 0) return null;
  return recentP50 / priorP50 - 1;
};

/** Per-skill aggregates over all events, sorted by skill name. */
export const summarize = (events: MetricsEvent[]): SkillSummary[] => {
  const bySkill = new Map<string, MetricsEvent[]>();
  for (const event of events) {
    const group = bySkill.get(event.skill) ?? [];
    group.push(event);
    bySkill.set(event.skill, group);
  }
  return [...bySkill.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([skill, group]) => {
      const chronological = [...group].sort((a, b) => a.ts.localeCompare(b.ts));
      const successes = group.filter(
        event => event.outcome === 'success',
      ).length;
      const costs = group.map(event => event.run.cost_usd);
      const turns = group.map(event => event.run.num_turns);
      const durations = group.map(event => event.run.duration_ms / 1000);
      return {
        skill,
        runs: group.length,
        successRate: successes / group.length,
        cost: {p50: percentile(costs, 50), p95: percentile(costs, 95)},
        turns: {p50: percentile(turns, 50), p95: percentile(turns, 95)},
        durationSeconds: {
          p50: percentile(durations, 50),
          p95: percentile(durations, 95),
        },
        costRegression: costRegression(chronological),
      };
    });
};

const usd = (value: number): string => value.toFixed(2);
const round = (value: number): string => Math.round(value).toString();

export const renderDashboard = (
  events: MetricsEvent[],
  generatedAt: string,
): string => {
  const summaries = summarize(events);
  const lines: string[] = [
    '# supera telemetry — run metrics',
    '',
    `_Generated ${generatedAt} from ${events.length} run(s) across the dogfood fleet._`,
    '',
    '## Per-skill',
    '',
    '| skill | runs | success | cost p50 / p95 (USD) | turns p50 / p95 | duration p50 / p95 (s) |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const summary of summaries) {
    lines.push(
      `| ${summary.skill} | ${summary.runs} | ${Math.round(
        summary.successRate * 100,
      )}% | ${usd(summary.cost.p50)} / ${usd(summary.cost.p95)} | ${round(
        summary.turns.p50,
      )} / ${round(summary.turns.p95)} | ${round(
        summary.durationSeconds.p50,
      )} / ${round(summary.durationSeconds.p95)} |`,
    );
  }
  const regressions = summaries.filter(
    summary => summary.costRegression !== null && summary.costRegression > 0.25,
  );
  lines.push('', '## Regressions', '');
  if (regressions.length === 0) {
    lines.push('None detected.');
  } else {
    for (const summary of regressions) {
      lines.push(
        `- ⚠️ **${summary.skill}** cost p50 up ${Math.round(
          (summary.costRegression as number) * 100,
        )}% over the recent window.`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
};

const readEventsJsonl = (file: string): MetricsEvent[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as MetricsEvent);
};

const findEventFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findEventFiles(full));
    else if (entry.name === 'metrics-event.json') out.push(full);
  }
  return out;
};

export const runRollup = (options: {
  collectedDir: string;
  outDir: string;
}): void => {
  const ajv = new Ajv2020({strict: true});
  addFormats(ajv);
  const validate = ajv.compile(
    JSON.parse(
      readFileSync(
        join(process.cwd(), 'schema/metrics-event.schema.json'),
        'utf8',
      ),
    ) as object,
  );

  const incoming: MetricsEvent[] = [];
  for (const file of findEventFiles(options.collectedDir)) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (validate(raw)) {
      incoming.push(raw as MetricsEvent);
    } else {
      console.warn(
        `⚠ ${file}: dropped — does not conform to metrics-event schema`,
      );
    }
  }

  const eventsFile = join(options.outDir, 'events.jsonl');
  const existing = readEventsJsonl(eventsFile);
  const merged = dedupeByRunId(existing, incoming).sort((a, b) =>
    a.ts.localeCompare(b.ts),
  );

  mkdirSync(options.outDir, {recursive: true});
  writeFileSync(
    eventsFile,
    merged.map(event => JSON.stringify(event)).join('\n') +
      (merged.length ? '\n' : ''),
  );
  writeFileSync(
    join(options.outDir, 'DASHBOARD.md'),
    renderDashboard(merged, new Date().toISOString()),
  );
  console.log(
    `✓ rollup: ${existing.length} existing + ${
      merged.length - existing.length
    } new = ${merged.length} events`,
  );
};

const parseArgs = (argv: string[]): {collectedDir: string; outDir: string} => {
  let collectedDir = 'collected';
  let outDir = 'metrics';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--collected') collectedDir = argv[i + 1];
    else if (argv[i] === '--out') outDir = argv[i + 1];
  }
  return {collectedDir, outDir};
};

if (process.argv[1] && /metrics-rollup\.ts$/.test(process.argv[1])) {
  runRollup(parseArgs(process.argv.slice(2)));
}
