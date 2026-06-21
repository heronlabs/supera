/**
 * Repo validation gate. One ajv (2020-12), one pass:
 *   1. every schema/*.schema.json compiles (catches broken $refs / bad schemas);
 *   2. the config + one canonical example per receipt schema conform;
 *   3. every skill/agent markdown carries valid frontmatter.
 *
 * Run via `pnpm validate` (jiti loads the TypeScript directly). Replaces the
 * remark-lint-frontmatter-schema stack — same coverage, near-zero deps.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import Ajv2020, {type ValidateFunction} from 'ajv/dist/2020';
import {parse as parseYaml} from 'yaml';

/** Pull the leading `---`-fenced YAML frontmatter block; {} when absent. */
const frontmatterData = (content: string): unknown => {
  const match = /^---\r?\n(.*?)\r?\n---/s.exec(content);
  return match ? parseYaml(match[1]) : {};
};

const root = process.cwd();
const errors: string[] = [];

const readJson = (rel: string): object =>
  JSON.parse(readFileSync(join(root, rel), 'utf8')) as object;

const ajv = new Ajv2020({allErrors: true});

// 1. Every schema must compile. Keyed by filename for the instance checks below.
const compiled = new Map<string, ValidateFunction>();
for (const file of readdirSync(join(root, 'schema')).sort()) {
  if (!file.endsWith('.schema.json')) continue;
  try {
    compiled.set(file, ajv.compile(readJson(`schema/${file}`)));
  } catch (err) {
    errors.push(`schema/${file}: does not compile — ${(err as Error).message}`);
  }
}

// 2. Config + canonical examples must conform to their schema.
const instances: ReadonlyArray<readonly [string, string]> = [
  ['.claude/supera.json', 'supera.schema.json'],
  ['schema/examples/receipt.example.json', 'receipt.schema.json'],
  ['schema/examples/audit-receipt.example.json', 'audit-receipt.schema.json'],
];
for (const [instance, schema] of instances) {
  const validate = compiled.get(schema);
  if (!validate) continue; // compile failure already reported
  if (!validate(readJson(instance))) {
    for (const e of validate.errors ?? []) {
      errors.push(`${instance}: ${e.instancePath || '/'} ${e.message}`);
    }
  }
}

// 3. Skill/agent frontmatter must satisfy the frontmatter contract.
const frontmatter = compiled.get('frontmatter.schema.json');
const markdown = [
  ...readdirSync(join(root, 'skills'), {recursive: true})
    .filter(f => f.endsWith('SKILL.md'))
    .map(f => `skills/${f}`),
  ...readdirSync(join(root, 'agents'), {recursive: true})
    .filter(f => f.endsWith('.md'))
    .map(f => `agents/${f}`),
];
for (const file of markdown) {
  const data = frontmatterData(readFileSync(join(root, file), 'utf8'));
  if (frontmatter && !frontmatter(data)) {
    for (const e of frontmatter.errors ?? []) {
      errors.push(`${file}: frontmatter ${e.instancePath || '/'} ${e.message}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`✗ validation failed (${errors.length}):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  `✓ ${compiled.size} schemas compile, ${instances.length} instances + ${markdown.length} frontmatter blocks valid`,
);
