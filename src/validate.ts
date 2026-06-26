/**
 * Repo validation gate. One ajv (2020-12, strict), one pass:
 *   1. every schema/*.schema.json compiles (catches broken $refs / bad schemas);
 *   2. the config + every example instance conform, and every receipt schema
 *      HAS an example (coverage cannot silently drop);
 *   3. every skill/agent markdown carries valid frontmatter.
 *
 * Coverage floors fail the run if a glob matches nothing or a new schema ships
 * without an example — so a broken check turns CI red, never passes vacuously.
 *
 * Run via `pnpm validate` (jiti loads the TypeScript directly). Replaces the
 * remark-lint-frontmatter-schema stack — same coverage, near-zero deps.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {basename, join} from 'node:path';
import Ajv2020, {type ValidateFunction} from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {parse as parseYaml} from 'yaml';
import {dedupeByRunId, percentile} from './metrics/metrics-rollup';
import {buildLocalEvent, summarizeTranscriptUsage} from '../hooks/session-end';

const root = process.cwd();
const errors: string[] = [];

const readJson = (rel: string): object =>
  JSON.parse(readFileSync(join(root, rel), 'utf8')) as object;

/** Pull the leading `---`-fenced YAML frontmatter block; {} when absent. */
const frontmatterData = (content: string): unknown => {
  const match = /^---\r?\n(.*?)\r?\n---/s.exec(content);
  return match ? parseYaml(match[1]) : {};
};

// strict catches malformed schemas; addFormats makes `format` keywords enforce
// instead of being silently ignored.
const ajv = new Ajv2020({allErrors: true, strict: true});
addFormats(ajv);

// 1. Every schema must compile. Keyed by filename for the instance checks below.
const compiled = new Map<string, ValidateFunction>();
const schemaFiles = readdirSync(join(root, 'schema'))
  .filter(f => f.endsWith('.schema.json'))
  .sort();
for (const file of schemaFiles) {
  try {
    compiled.set(file, ajv.compile(readJson(`schema/${file}`)));
  } catch (err) {
    errors.push(`schema/${file}: does not compile — ${(err as Error).message}`);
  }
}

// 2. Config + every example must conform to its schema. Examples are derived by
// convention (schema/examples/<base>.example.json -> schema/<base>.schema.json),
// so a new receipt schema is picked up without editing this file.
const exampleFiles = readdirSync(join(root, 'schema/examples')).filter(f =>
  f.endsWith('.example.json'),
);
const instances: Array<[string, string]> = [
  ['.claude/supera.json', 'supera.schema.json'],
  ...exampleFiles.map((f): [string, string] => [
    `schema/examples/${f}`,
    `${basename(f, '.example.json')}.schema.json`,
  ]),
];
for (const [instance, schema] of instances) {
  const validate = compiled.get(schema);
  if (!validate) {
    errors.push(`${instance}: no schema ${schema} to validate against`);
    continue;
  }
  if (!validate(readJson(instance))) {
    for (const e of validate.errors ?? []) {
      errors.push(`${instance}: ${e.instancePath || '/'} ${e.message}`);
    }
  }
}

// Coverage: every schema except the config + frontmatter contracts must ship a
// canonical example, so adding a receipt schema can't silently skip checks.
const exemptFromExample = new Set([
  'supera.schema.json',
  'frontmatter.schema.json',
]);
const exampled = new Set(
  exampleFiles.map(f => `${basename(f, '.example.json')}.schema.json`),
);
for (const schema of schemaFiles) {
  if (!exemptFromExample.has(schema) && !exampled.has(schema)) {
    errors.push(`schema/${schema}: no canonical example in schema/examples/`);
  }
}

// 3. Skill/agent frontmatter must satisfy the frontmatter contract.
const frontmatter = compiled.get('frontmatter.schema.json');
const skills = readdirSync(join(root, 'skills'), {recursive: true})
  .filter(f => f.endsWith('SKILL.md'))
  .map(f => `skills/${f}`);
const agents = readdirSync(join(root, 'agents'), {recursive: true})
  .filter(f => f.endsWith('.md'))
  .map(f => `agents/${f}`);
const markdown = [...skills, ...agents];
for (const file of markdown) {
  const data = frontmatterData(readFileSync(join(root, file), 'utf8'));
  if (frontmatter && !frontmatter(data)) {
    for (const e of frontmatter.errors ?? []) {
      errors.push(`${file}: frontmatter ${e.instancePath || '/'} ${e.message}`);
    }
  }
}

// Coverage floor: a broken glob must fail loud, not pass with zero files.
if (skills.length === 0) errors.push('skills/: no SKILL.md found');
if (agents.length === 0) errors.push('agents/: no *.md found');

// 4. Drift guard: /start inlines the audit-cron workflow, and it must stay
// byte-identical to the canonical .github/workflows/skill-audit.yml — the
// workflow is the base, the start template is the emitted copy. A silent
// divergence ships consumers a stale cron, so fail loud if they differ.
// The canonical workflow hardcodes `stack: pnpm` (supera dogfoods pnpm) while
// the start template emits `stack: <detected stack>`; that single bootstrap
// input legitimately differs per consumer, so normalize it away before the
// byte-compare (everything else must stay identical).
const normalizeStackInput = (yaml: string): string =>
  yaml.replace(/^(\s*stack:).*$/m, '$1 <stack>');
const canonicalWorkflowPath = '.github/workflows/skill-audit.yml';
const startSkillPath = 'skills/start/SKILL.md';
const workflow = readFileSync(join(root, canonicalWorkflowPath), 'utf8');
const yamlBlocks = [
  ...readFileSync(join(root, startSkillPath), 'utf8').matchAll(
    /```yaml\r?\n(.*?)\r?\n```/gs,
  ),
].map(m => `${m[1]}\n`);
const normalizedBlocks = yamlBlocks.map(normalizeStackInput);
if (workflow.trim().length === 0) {
  errors.push(
    `${canonicalWorkflowPath}: canonical audit-cron workflow is empty`,
  );
} else if (yamlBlocks.length === 0) {
  errors.push(
    `${startSkillPath}: no \`\`\`yaml block found to guard against ${canonicalWorkflowPath}`,
  );
} else if (!normalizedBlocks.includes(normalizeStackInput(workflow))) {
  errors.push(
    `${startSkillPath}: inlined audit-cron template has drifted from ${canonicalWorkflowPath} — they must stay byte-identical modulo the bootstrap \`stack\` input (the workflow is the canonical base, the start template is the emitted copy)`,
  );
}

// Same drift guard for the supera-bootstrap composite action: /start emits a
// .github/actions/supera-bootstrap/action.yml into the consumer (5d), and it
// must stay byte-identical to this repo's canonical action — a silent
// divergence ships consumers a stale bootstrap action, so fail loud.
const canonicalActionPath = '.github/actions/supera-bootstrap/action.yml';
const action = readFileSync(join(root, canonicalActionPath), 'utf8');
if (action.trim().length === 0) {
  errors.push(`${canonicalActionPath}: canonical bootstrap action is empty`);
} else if (yamlBlocks.length === 0) {
  errors.push(
    `${startSkillPath}: no \`\`\`yaml block found to guard against ${canonicalActionPath}`,
  );
} else if (!yamlBlocks.includes(action)) {
  errors.push(
    `${startSkillPath}: inlined supera-bootstrap template has drifted from ${canonicalActionPath} — they must stay byte-identical (the action is the canonical base, the start template is the emitted copy)`,
  );
}

// Same drift guard for the supera-metrics composite action: /start emits a
// .github/actions/supera-metrics/action.yml into the consumer (5e) — the
// telemetry emit step the skill workflows call — and it must stay byte-identical
// to this repo's canonical action. A silent divergence ships consumers a stale
// metrics emit, so fail loud.
const canonicalMetricsActionPath = '.github/actions/supera-metrics/action.yml';
const metricsAction = readFileSync(
  join(root, canonicalMetricsActionPath),
  'utf8',
);
if (metricsAction.trim().length === 0) {
  errors.push(
    `${canonicalMetricsActionPath}: canonical metrics action is empty`,
  );
} else if (yamlBlocks.length === 0) {
  errors.push(
    `${startSkillPath}: no \`\`\`yaml block found to guard against ${canonicalMetricsActionPath}`,
  );
} else if (!yamlBlocks.includes(metricsAction)) {
  errors.push(
    `${startSkillPath}: inlined supera-metrics template has drifted from ${canonicalMetricsActionPath} — they must stay byte-identical (the action is the canonical base, the start template is the emitted copy)`,
  );
}

// Same drift guard for the Dependabot template: /start inlines a
// .github/dependabot.yml (the pnpm/npm + github-actions blocks), and it must
// stay byte-identical to this repo's canonical dogfood .github/dependabot.yml.
// A silent divergence ships consumers a stale Dependabot config, so fail loud.
const canonicalDependabotPath = '.github/dependabot.yml';
const dependabot = readFileSync(join(root, canonicalDependabotPath), 'utf8');
if (dependabot.trim().length === 0) {
  errors.push(
    `${canonicalDependabotPath}: canonical Dependabot config is empty`,
  );
} else if (yamlBlocks.length === 0) {
  errors.push(
    `${startSkillPath}: no \`\`\`yaml block found to guard against ${canonicalDependabotPath}`,
  );
} else if (!yamlBlocks.includes(dependabot)) {
  errors.push(
    `${startSkillPath}: inlined Dependabot template has drifted from ${canonicalDependabotPath} — they must stay byte-identical (the dogfood config is the canonical base, the start template is the emitted copy)`,
  );
}

// 5. Privacy invariant for the run-telemetry event. The metrics schema is the
// STRUCTURAL guarantee that a run never emits free text (a prompt, diff, path,
// or commit message): every object level is sealed (additionalProperties:false)
// and every string property is constrained to a closed shape — an enum, a
// const, a pattern, or a format. Enforce both here so a future edit can't
// silently open a leak; an unconstrained `type:"string"` IS the leak. Scoped to
// the metrics schema — the receipt/config/audit schemas carry intentional free
// text.
type SchemaNode = Record<string, unknown>;
const singleSubschemaKeys = [
  'items',
  'additionalProperties',
  'additionalItems',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const mapSubschemaKeys = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
];
const listSubschemaKeys = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

function* walkSchema(
  node: unknown,
  path: string,
): Generator<[string, SchemaNode]> {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const schema = node as SchemaNode;
  yield [path, schema];
  for (const key of singleSubschemaKeys) {
    if (key in schema) yield* walkSchema(schema[key], `${path}/${key}`);
  }
  for (const key of mapSubschemaKeys) {
    const map = schema[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [name, sub] of Object.entries(map)) {
        yield* walkSchema(sub, `${path}/${key}/${name}`);
      }
    }
  }
  for (const key of listSubschemaKeys) {
    const list = schema[key];
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i += 1) {
        yield* walkSchema(list[i], `${path}/${key}/${i}`);
      }
    }
  }
}

const isStringTyped = (schema: SchemaNode): boolean =>
  schema.type === 'string' ||
  (Array.isArray(schema.type) && schema.type.includes('string'));
const isConstrainedString = (schema: SchemaNode): boolean =>
  'enum' in schema ||
  'const' in schema ||
  'pattern' in schema ||
  'format' in schema;
const definesObject = (schema: SchemaNode): boolean =>
  schema.type === 'object' || 'properties' in schema;

const auditPrivacy = (schema: SchemaNode, label: string): string[] => {
  const violations: string[] = [];
  for (const [path, node] of walkSchema(schema, label)) {
    if (isStringTyped(node) && !isConstrainedString(node)) {
      violations.push(
        `${path}: unconstrained string (add enum/const/pattern/format) — free text would leak`,
      );
    }
    if (definesObject(node) && node.additionalProperties !== false) {
      violations.push(
        `${path}: object is not sealed (set additionalProperties:false)`,
      );
    }
  }
  return violations;
};

const metricsSchemaName = 'metrics-event.schema.json';
if (schemaFiles.includes(metricsSchemaName)) {
  errors.push(
    ...auditPrivacy(
      readJson(`schema/${metricsSchemaName}`) as SchemaNode,
      `schema/${metricsSchemaName}`,
    ),
  );
  // Negative self-test: the guard must catch a leak, never pass vacuously.
  const leakyFixture: SchemaNode = {
    type: 'object',
    additionalProperties: false,
    properties: {prompt: {type: 'string'}},
  };
  const unsealedFixture: SchemaNode = {
    type: 'object',
    properties: {skill: {type: 'string', const: 'ship'}},
  };
  if (auditPrivacy(leakyFixture, 'fixture').length === 0) {
    errors.push(
      'privacy guard regression: unconstrained string was not flagged',
    );
  }
  if (auditPrivacy(unsealedFixture, 'fixture').length === 0) {
    errors.push('privacy guard regression: unsealed object was not flagged');
  }
} else {
  errors.push(`schema/${metricsSchemaName}: missing run-telemetry contract`);
}

// 6. Rollup math gate. The daily rollup's pure helpers carry the only
// non-trivial logic on the telemetry path (percentiles, run-id dedup), so a
// regression there must turn this single gate red.
if (percentile([1, 2, 3, 4], 50) !== 2.5) {
  errors.push(
    `rollup percentile p50: expected 2.5, got ${percentile([1, 2, 3, 4], 50)}`,
  );
}
if (percentile([], 95) !== 0) {
  errors.push('rollup percentile: empty series must be 0');
}
const deduped = dedupeByRunId(
  [{gh: {run_id: 1}}],
  [{gh: {run_id: 1}}, {gh: {run_id: 2}}, {gh: {run_id: 2}}],
);
if (deduped.length !== 2) {
  errors.push(
    `rollup dedupeByRunId: expected 2 unique runs, got ${deduped.length}`,
  );
}

// 7. Local-arm gate (Phase 3). The SessionEnd hook derives a metrics-event from
// the local Claude Code transcript and the skill's run.json. Its pure helpers —
// summing transcript usage and assembling the event — are the only non-trivial
// logic on the local path, and the built event must conform to the same
// privacy-safe schema as the CI emit, so exercise both here and validate the
// result against the compiled schema.
const transcriptLines = [
  {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
      },
    },
  },
  {type: 'user', message: {content: 'ignored'}},
  {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 3,
        output_tokens: 7,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 0,
      },
    },
  },
];
const usage = summarizeTranscriptUsage(transcriptLines);
if (usage.turns !== 2) {
  errors.push(
    `hook summarizeTranscriptUsage turns: expected 2, got ${usage.turns}`,
  );
}
if (usage.tokens.input !== 13) {
  errors.push(
    `hook summarizeTranscriptUsage input tokens: expected 13, got ${usage.tokens.input}`,
  );
}
if (usage.tokens.cache_read !== 150) {
  errors.push(
    `hook summarizeTranscriptUsage cache_read: expected 150, got ${usage.tokens.cache_read}`,
  );
}
if (usage.model !== 'claude-opus-4-8') {
  errors.push(
    `hook summarizeTranscriptUsage model: expected claude-opus-4-8, got ${usage.model}`,
  );
}

const localEvent = buildLocalEvent({
  skill: 'ship',
  repo: 'heronlabs/supera',
  stack: 'pnpm',
  ts: '2026-06-25T10:00:00Z',
  usage,
  semantic: {self_verify_retries: 1, blocked_reason_category: 'ci-red'},
});
const metricsValidate = compiled.get(metricsSchemaName);
if (metricsValidate && !metricsValidate(localEvent)) {
  for (const e of metricsValidate.errors ?? []) {
    errors.push(`hook buildLocalEvent: ${e.instancePath || '/'} ${e.message}`);
  }
}
if (localEvent.semantic?.blocked_reason_category !== 'ci-red') {
  errors.push(
    'hook buildLocalEvent: semantic block category not carried through',
  );
}
// A run with no semantic file must still produce a schema-valid event with no
// semantic key (the field is optional, never an empty object).
const bareEvent = buildLocalEvent({
  skill: 'audit',
  repo: 'heronlabs/supera',
  stack: 'pnpm',
  ts: '2026-06-25T10:00:00Z',
  usage,
  semantic: null,
});
if ('semantic' in bareEvent) {
  errors.push(
    'hook buildLocalEvent: omitted semantic must not add a semantic key',
  );
}
// Privacy is structural on the LOCAL arm too: a run.json carrying a stray or
// free-text key (SKILL.md heredocs are LLM-filled) must be allowlisted down to
// exactly the six schema fields before it can reach events.jsonl or the metrics
// branch — the local mirror of the CI jq allowlist. Feed a leaky run.json and
// assert only allowlisted keys survive.
const leakyEvent = buildLocalEvent({
  skill: 'ship',
  repo: 'heronlabs/supera',
  stack: 'pnpm',
  ts: '2026-06-25T10:00:00Z',
  usage,
  semantic: {
    blocked_reason_category: 'ci-red',
    files_changed_count: 4,
    leaked_path: 'src/auth/token.ts',
    prompt: 'fix the bug in the login flow',
  } as never,
});
const allowedSemanticKeys = new Set([
  'self_verify_retries',
  'ci_reruns',
  'phases_traversed',
  'blocked_reason_category',
  'files_changed_count',
  'loc_delta',
]);
const leakedKeys = Object.keys(leakyEvent.semantic ?? {}).filter(
  k => !allowedSemanticKeys.has(k),
);
if (leakedKeys.length > 0) {
  errors.push(
    `hook buildLocalEvent: leaked non-allowlisted semantic key(s) ${leakedKeys.join(', ')} — privacy must be structural on the local arm`,
  );
}
if (metricsValidate && !metricsValidate(leakyEvent)) {
  for (const e of metricsValidate.errors ?? []) {
    errors.push(
      `hook buildLocalEvent leaky-input: ${e.instancePath || '/'} ${e.message}`,
    );
  }
}
// Structural privacy is about VALUES, not just keys: an allowlisted string
// field carrying a free-text / out-of-enum VALUE (heredocs are LLM-filled) must
// be dropped, phases_traversed filtered to the phase-ladder enum, and the
// integer counts type/range-checked — otherwise a path-bearing reason rides
// through and the event fails the schema. Assert the cleaned event re-validates
// and carries no stray value.
const valueLeakEvent = buildLocalEvent({
  skill: 'ship',
  repo: 'heronlabs/supera',
  stack: 'pnpm',
  ts: '2026-06-25T10:00:00Z',
  usage,
  semantic: {
    blocked_reason_category: 'ci-red: tests failing in src/auth/login.ts',
    phases_traversed: ['fresh', 'totally-bogus-phase', 'built'],
    files_changed_count: -7,
    loc_delta: 12,
  } as never,
});
if (metricsValidate && !metricsValidate(valueLeakEvent)) {
  for (const e of metricsValidate.errors ?? []) {
    errors.push(
      `hook buildLocalEvent value-leak: ${e.instancePath || '/'} ${e.message} — a non-conforming semantic value reached the event`,
    );
  }
}
if ('blocked_reason_category' in (valueLeakEvent.semantic ?? {})) {
  errors.push(
    'hook buildLocalEvent value-leak: free-text blocked_reason_category was not dropped',
  );
}
if (
  JSON.stringify(valueLeakEvent.semantic?.phases_traversed ?? []) !==
  JSON.stringify(['fresh', 'built'])
) {
  errors.push(
    'hook buildLocalEvent value-leak: phases_traversed not filtered to the enum',
  );
}
if ('files_changed_count' in (valueLeakEvent.semantic ?? {})) {
  errors.push(
    'hook buildLocalEvent value-leak: negative files_changed_count was not dropped',
  );
}
if (JSON.stringify(valueLeakEvent.semantic ?? {}).includes('login.ts')) {
  errors.push(
    'hook buildLocalEvent value-leak: free-text path leaked into semantic',
  );
}

if (errors.length > 0) {
  console.error(`✗ validation failed (${errors.length}):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  `✓ ${schemaFiles.length} schemas compile, ${instances.length} instances + ${markdown.length} frontmatter blocks valid, audit-cron + dependabot + bootstrap-action + metrics-action templates in sync`,
);
