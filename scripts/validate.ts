import {readFileSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv/dist/2020.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(repoRoot, 'schema');
const skillsDir = join(repoRoot, 'skills');
const agentsDir = join(repoRoot, 'agents');

const rel = (absolutePath: string) => relative(repoRoot, absolutePath);
const readJson = (absolutePath: string): unknown =>
  JSON.parse(readFileSync(absolutePath, 'utf8'));

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listFiles(
  directory: string,
  predicate: (name: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(entry => entry.isFile() && predicate(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
    .sort();
}

function compileSchemas(schemaPathsToCheck: string[]) {
  const ajv = new Ajv({allErrors: true, strict: false});

  for (const path of schemaPathsToCheck) {
    let schema: unknown;
    try {
      schema = readJson(path);
    } catch (error) {
      fail(`schema ${rel(path)} is not valid JSON: ${messageOf(error)}`);
    }
    try {
      ajv.compile(schema);
    } catch (error) {
      fail(
        `schema ${rel(path)} is not a valid JSON Schema: ${messageOf(error)}`,
      );
    }
  }

  console.log(
    `PASS schemas: compiled ${schemaPathsToCheck.length} JSON Schema(s)`,
  );
}

function validateRepoConfig() {
  const ajv = new Ajv({allErrors: true, strict: false});
  const schema = readJson(join(schemaDir, 'supera.schema.json'));
  const config = readJson(join(repoRoot, '.claude', 'supera.json'));
  const validate = ajv.compile(schema);

  if (!validate(config)) {
    const details = (validate.errors ?? [])
      .map(error => `  ${error.instancePath || '/'} ${error.message}`)
      .join('\n');
    fail(`.claude/supera.json violates supera.schema.json:\n${details}`);
  }

  console.log('PASS config: .claude/supera.json satisfies supera.schema.json');
}

function frontmatterOf(path: string): string | null {
  const source = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---/.exec(source);
  return match ? match[1] : null;
}

function fieldValue(frontmatter: string, field: string): string | null {
  const match = new RegExp(`^${field}:[ \\t]*(.*)$`, 'm').exec(frontmatter);
  if (!match) return null;
  return match[1]
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

async function checkFrontmatter() {
  const files = [
    ...(await listFiles(skillsDir, name => name === 'SKILL.md')),
    ...(await listFiles(agentsDir, name => name.endsWith('.md'))),
  ];
  const offenders: string[] = [];

  for (const path of files) {
    const frontmatter = frontmatterOf(path);
    if (frontmatter === null) {
      offenders.push(`${rel(path)}: missing leading --- frontmatter block`);
      continue;
    }
    for (const field of ['name', 'description']) {
      if (!fieldValue(frontmatter, field)) {
        offenders.push(`${rel(path)}: empty or missing '${field}:'`);
      }
    }
  }

  if (offenders.length > 0) {
    fail(
      `frontmatter check found ${offenders.length} offender(s):\n${offenders.map(line => `  ${line}`).join('\n')}`,
    );
  }

  console.log(
    `PASS frontmatter: ${files.length} skill/agent file(s) have name + description`,
  );
}

const schemaPaths = await listFiles(schemaDir, name => name.endsWith('.json'));
compileSchemas(schemaPaths);
validateRepoConfig();
await checkFrontmatter();
console.log('PASS validate: all checks green');
