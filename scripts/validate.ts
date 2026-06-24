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

// 4. Drift guard: /init inlines the audit-cron workflow, and it must stay
// byte-identical to the canonical .github/workflows/skill-audit.yml — the
// workflow is the base, the init template is the emitted copy. A silent
// divergence ships consumers a stale cron, so fail loud if they differ.
// The canonical workflow hardcodes `stack: pnpm` (supera dogfoods pnpm) while
// the init template emits `stack: <detected stack>`; that single bootstrap
// input legitimately differs per consumer, so normalize it away before the
// byte-compare (everything else must stay identical).
const normalizeStackInput = (yaml: string): string =>
  yaml.replace(/^(\s*stack:).*$/m, '$1 <stack>');
const canonicalWorkflowPath = '.github/workflows/skill-audit.yml';
const initSkillPath = 'skills/init/SKILL.md';
const workflow = readFileSync(join(root, canonicalWorkflowPath), 'utf8');
const yamlBlocks = [
  ...readFileSync(join(root, initSkillPath), 'utf8').matchAll(
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
    `${initSkillPath}: no \`\`\`yaml block found to guard against ${canonicalWorkflowPath}`,
  );
} else if (!normalizedBlocks.includes(normalizeStackInput(workflow))) {
  errors.push(
    `${initSkillPath}: inlined audit-cron template has drifted from ${canonicalWorkflowPath} — they must stay byte-identical modulo the bootstrap \`stack\` input (the workflow is the canonical base, the init template is the emitted copy)`,
  );
}

// Same drift guard for the supera-bootstrap composite action: /init emits a
// .github/actions/supera-bootstrap/action.yml into the consumer (5d), and it
// must stay byte-identical to this repo's canonical action — a silent
// divergence ships consumers a stale bootstrap action, so fail loud.
const canonicalActionPath = '.github/actions/supera-bootstrap/action.yml';
const action = readFileSync(join(root, canonicalActionPath), 'utf8');
if (action.trim().length === 0) {
  errors.push(`${canonicalActionPath}: canonical bootstrap action is empty`);
} else if (yamlBlocks.length === 0) {
  errors.push(
    `${initSkillPath}: no \`\`\`yaml block found to guard against ${canonicalActionPath}`,
  );
} else if (!yamlBlocks.includes(action)) {
  errors.push(
    `${initSkillPath}: inlined supera-bootstrap template has drifted from ${canonicalActionPath} — they must stay byte-identical (the action is the canonical base, the init template is the emitted copy)`,
  );
}

// Same drift guard for the Dependabot template: /init inlines a
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
    `${initSkillPath}: no \`\`\`yaml block found to guard against ${canonicalDependabotPath}`,
  );
} else if (!yamlBlocks.includes(dependabot)) {
  errors.push(
    `${initSkillPath}: inlined Dependabot template has drifted from ${canonicalDependabotPath} — they must stay byte-identical (the dogfood config is the canonical base, the init template is the emitted copy)`,
  );
}

if (errors.length > 0) {
  console.error(`✗ validation failed (${errors.length}):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  `✓ ${schemaFiles.length} schemas compile, ${instances.length} instances + ${markdown.length} frontmatter blocks valid, audit-cron + dependabot + bootstrap-action templates in sync`,
);
