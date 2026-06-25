/**
 * SessionEnd hook — the local arm of the telemetry system (issue #55 Phase 3).
 *
 * Claude Code fires this when a session ends, passing the session id and the
 * transcript path on stdin. If the session ran a supera skill and left a
 * .supera/metrics/run.json (the Phase 2 semantic file), this derives the
 * run-level cost / turns / tokens from the local transcript, assembles a
 * privacy-safe metrics-event (the same shape the CI workflows emit), and
 * appends it to ~/.supera/events.jsonl — LOCAL-ONLY by default.
 *
 * Opt-in fleet push: with SUPERA_METRICS=1 and an authenticated gh, it also
 * appends the event to the `metrics` branch via `gh api`, so a dev's local runs
 * roll up alongside the CI fleet.
 *
 * Privacy is structural, exactly as in CI: only the metrics schema's known,
 * constrained fields are ever written — no prompt, path, diff, or commit text.
 * The pure helpers (summarizeTranscriptUsage, buildLocalEvent) carry the only
 * non-trivial logic and are exercised by scripts/validate.ts.
 */
import {execFileSync} from 'node:child_process';
import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

const MODEL_PATTERN = /^claude-[a-z0-9.-]+$/;
const STACK_PATTERN = /^[a-z]+$/;
const SKILLS = ['ship', 'pr-watch', 'audit', 'refactor'] as const;
type Skill = (typeof SKILLS)[number];

export interface RunUsage {
  model: string;
  turns: number;
  durationMs: number;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  };
}

export interface Semantic {
  self_verify_retries?: number;
  ci_reruns?: number;
  phases_traversed?: string[];
  blocked_reason_category?: string;
  files_changed_count?: number;
  loc_delta?: number;
}

export interface LocalEvent {
  schema_version: '1';
  ts: string;
  repo: string;
  skill: string;
  event: 'run';
  outcome: string;
  model: string;
  stack: string;
  run: {
    cost_usd: number;
    num_turns: number;
    duration_ms: number;
    tokens: RunUsage['tokens'];
  };
  gh: {run_id: number; run_attempt: number};
  semantic?: Semantic;
}

interface TranscriptLine {
  type?: string;
  message?: {model?: string; usage?: Record<string, number>};
  timestamp?: string;
}

/** Per-million-token rates by Claude model family, mirroring the published price sheet. */
const PRICE_PER_MTOK: Array<{
  test: RegExp;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}> = [
  {
    test: /^claude-(fable|mythos)-/,
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
  },
  {
    test: /^claude-opus-/,
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  },
  {
    test: /^claude-sonnet-/,
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  {
    test: /^claude-haiku-/,
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
];

const estimateCostUsd = (model: string, tokens: RunUsage['tokens']): number => {
  const rate =
    PRICE_PER_MTOK.find(r => r.test.test(model)) ?? PRICE_PER_MTOK[1];
  const perMillion =
    tokens.input * rate.input +
    tokens.output * rate.output +
    tokens.cache_read * rate.cacheRead +
    tokens.cache_creation * rate.cacheWrite;
  return perMillion / 1_000_000;
};

/** Fold every assistant turn's usage into one run-level total. */
export const summarizeTranscriptUsage = (lines: unknown[]): RunUsage => {
  const tokens = {input: 0, output: 0, cache_read: 0, cache_creation: 0};
  let turns = 0;
  let model = '';
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  for (const raw of lines) {
    const line = raw as TranscriptLine;
    if (line.timestamp) {
      firstTs ??= line.timestamp;
      lastTs = line.timestamp;
    }
    if (line.type !== 'assistant') continue;
    turns += 1;
    if (line.message?.model && MODEL_PATTERN.test(line.message.model)) {
      model = line.message.model;
    }
    const used = line.message?.usage ?? {};
    tokens.input += used.input_tokens ?? 0;
    tokens.output += used.output_tokens ?? 0;
    tokens.cache_read += used.cache_read_input_tokens ?? 0;
    tokens.cache_creation += used.cache_creation_input_tokens ?? 0;
  }
  const durationMs =
    firstTs && lastTs
      ? Math.max(0, Date.parse(lastTs) - Date.parse(firstTs))
      : 0;
  return {model, turns, durationMs, tokens};
};

/** Assemble the schema-valid local metrics-event from run usage + the semantic file. */
export const buildLocalEvent = (input: {
  skill: string;
  repo: string;
  stack: string;
  ts: string;
  usage: RunUsage;
  semantic: Semantic | null;
}): LocalEvent => {
  const {usage} = input;
  const event: LocalEvent = {
    schema_version: '1',
    ts: input.ts,
    repo: input.repo,
    skill: input.skill,
    event: 'run',
    outcome: input.semantic?.blocked_reason_category ? 'blocked' : 'success',
    model: MODEL_PATTERN.test(usage.model) ? usage.model : 'claude-unknown',
    stack: STACK_PATTERN.test(input.stack) ? input.stack : 'unknown',
    run: {
      cost_usd: estimateCostUsd(usage.model, usage.tokens),
      num_turns: usage.turns,
      duration_ms: usage.durationMs,
      tokens: usage.tokens,
    },
    // Local runs have no GitHub Actions run; the rollup dedups on run_id, so a
    // local event uses 0 (it never collides with a real CI run_id >= 1).
    gh: {run_id: 0, run_attempt: 1},
  };
  if (input.semantic) event.semantic = input.semantic;
  return event;
};

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, 'utf8'));

const readJsonl = (path: string): unknown[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line));

const skillFromTranscript = (lines: unknown[]): Skill | null => {
  for (const raw of lines) {
    const skill = (raw as {attributionSkill?: string}).attributionSkill;
    const match = SKILLS.find(s => skill === s || skill === `supera:${s}`);
    if (match) return match;
  }
  return null;
};

const pushToFleet = (event: LocalEvent): void => {
  const repo = execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    {encoding: 'utf8'},
  ).trim();
  const path = 'metrics/events.jsonl';
  // One round-trip: the GitHub contents API returns base64 `content` and the
  // blob `sha` in the same response, so read both from a single call (a 404 on a
  // missing file throws and is swallowed by main's best-effort catch).
  const meta = execFileSync(
    'gh',
    [
      'api',
      `repos/${repo}/contents/${path}?ref=metrics`,
      '-q',
      '{content: (.content // ""), sha: (.sha // "")}',
    ],
    {encoding: 'utf8'},
  ).trim();
  const {content: existing, sha: blobSha} = JSON.parse(meta) as {
    content: string;
    sha: string;
  };
  const decoded = existing
    ? Buffer.from(existing, 'base64').toString('utf8')
    : '';
  const sha = decoded ? blobSha : '';
  const next = `${decoded}${JSON.stringify(event)}\n`;
  const content = Buffer.from(next, 'utf8').toString('base64');
  const args = [
    'api',
    '-X',
    'PUT',
    `repos/${repo}/contents/${path}`,
    '-f',
    'message=chore: local metrics event',
    '-f',
    'branch=metrics',
    '-f',
    `content=${content}`,
  ];
  if (sha) args.push('-f', `sha=${sha}`);
  execFileSync('gh', args, {stdio: 'ignore'});
};

const main = (): void => {
  let payload: {transcript_path?: string; cwd?: string};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const transcriptPath = payload.transcript_path;
  const cwd = payload.cwd ?? process.cwd();
  if (!transcriptPath) return;

  let lines: unknown[];
  try {
    lines = readJsonl(transcriptPath);
  } catch {
    return;
  }

  const skill = skillFromTranscript(lines);
  if (!skill) return;

  let semantic: Semantic | null = null;
  try {
    semantic = readJson(
      join(cwd, '.supera', 'metrics', 'run.json'),
    ) as Semantic;
  } catch {
    // No semantic file → the run didn't reach the write step; skip silently.
    return;
  }

  let repo = 'local/unknown';
  let stack = 'unknown';
  try {
    repo = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      {cwd, encoding: 'utf8'},
    ).trim();
  } catch {
    // gh unavailable or not a GitHub repo — keep the placeholder.
  }
  try {
    stack = String(
      (readJson(join(cwd, '.claude', 'supera.json')) as {stack?: string})
        .stack ?? 'unknown',
    );
  } catch {
    // No config — keep the placeholder.
  }

  const usage = summarizeTranscriptUsage(lines);
  const event = buildLocalEvent({
    skill,
    repo: /^[^/]+\/[^/]+$/.test(repo) ? repo : 'local/unknown',
    stack,
    ts: new Date().toISOString(),
    usage,
    semantic,
  });

  const eventsFile = join(homedir(), '.supera', 'events.jsonl');
  mkdirSync(dirname(eventsFile), {recursive: true});
  appendFileSync(eventsFile, `${JSON.stringify(event)}\n`);

  if (process.env.SUPERA_METRICS === '1') {
    try {
      pushToFleet(event);
    } catch {
      // Fleet push is best-effort — a missing/unauthenticated gh never breaks
      // the local capture.
    }
  }
};

// Only run the side-effecting entrypoint as a script; importing for tests is pure.
if (process.argv[1] && /session-end\.ts$/.test(process.argv[1])) {
  main();
}
