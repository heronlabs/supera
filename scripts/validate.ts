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
import {dedupeByRunId, percentile} from './metrics-rollup';

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

// Pin-only drift guard for the 5c pr-watch template: /start inlines a
// .github/workflows/supera-skill-pr-watch.yml (5c), but it carries a per-repo
// `<CI WORKFLOW NAME>` placeholder (and prose) that can never be byte-identical
// to this repo's canonical .github/workflows/skill-pr-watch.yml — so a full
// byte-compare is impossible. Instead compare ONLY the GitHub Actions SHA pins:
// every external `uses: <action>@<sha>` in the template must pin the same SHA as
// that action in the real workflow, or the template's pins have rotted. Local
// `uses: ./...` actions have no `@sha` and are ignored.
const canonicalPrWatchPath = '.github/workflows/skill-pr-watch.yml';
let prWatchWorkflow: string;
try {
  prWatchWorkflow = readFileSync(join(root, canonicalPrWatchPath), 'utf8');
} catch {
  prWatchWorkflow = '';
}
const prWatchTemplate = yamlBlocks.find(b =>
  /^name: 'Skill \| pr-watch'/m.test(b),
);
type ActionPin = {action: string; sha: string};
// A ref that is hex-shaped but not exactly 40 lowercase hex is a malformed pin
// (e.g. a truncated or upper-cased SHA) and must be flagged, not silently
// dropped; a non-hex ref like `@v6` is a legitimate floating tag and ignored.
const collectActionPins = (yaml: string, source: string): ActionPin[] => {
  const pins: ActionPin[] = [];
  for (const m of yaml.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) {
    const [, action, ref] = m;
    if (/^[0-9a-f]{40}$/.test(ref)) {
      pins.push({action, sha: ref});
    } else if (/^[0-9a-fA-F]+$/.test(ref)) {
      errors.push(
        `${source}: ${action}@${ref} looks like a SHA pin but is not 40 lowercase hex — pin to a full commit SHA`,
      );
    }
  }
  return pins;
};
if (prWatchWorkflow.trim().length === 0) {
  errors.push(`${canonicalPrWatchPath}: canonical pr-watch workflow is empty`);
} else if (!prWatchTemplate) {
  errors.push(
    `${startSkillPath}: no \`\`\`yaml block with \`name: 'Skill | pr-watch'\` found to guard against ${canonicalPrWatchPath}`,
  );
} else {
  const templatePins = collectActionPins(prWatchTemplate, startSkillPath);
  const workflowPins = collectActionPins(prWatchWorkflow, canonicalPrWatchPath);
  // Compare every action pinned in EITHER file: a drift in either direction,
  // or a template-only action, is an error. A canonical-only action (e.g.
  // actions/upload-artifact) is exempt — the template is intentionally a subset.
  const actions = new Set([
    ...templatePins.map(p => p.action),
    ...workflowPins.map(p => p.action),
  ]);
  for (const action of actions) {
    const templateShas = templatePins
      .filter(p => p.action === action)
      .map(p => p.sha);
    const workflowShas = workflowPins
      .filter(p => p.action === action)
      .map(p => p.sha);
    if (templateShas.length === 0) continue;
    for (const templateSha of templateShas) {
      if (!workflowShas.includes(templateSha)) {
        errors.push(
          `${startSkillPath}: inlined pr-watch template pins ${action}@${templateSha}, but ${canonicalPrWatchPath} pins ${action}@${workflowShas.join(', ') || '(absent)'} — the action SHA pins must match (the workflow is the canonical base, the start template is the emitted copy; only the action SHA pins are compared, the \`<CI WORKFLOW NAME>\` placeholder and prose are intentionally not)`,
        );
      }
    }
  }
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

if (errors.length > 0) {
  console.error(`✗ validation failed (${errors.length}):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  `✓ ${schemaFiles.length} schemas compile, ${instances.length} instances + ${markdown.length} frontmatter blocks valid, audit-cron + dependabot + bootstrap-action templates in sync, pr-watch template pins in sync`,
);
