import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {describe, expect, it} from 'vitest';

const schemaDir = join(__dirname, '..', 'schema');

const compileSchema = (name: string) => {
  const schema = JSON.parse(readFileSync(join(schemaDir, name), 'utf8'));
  const ajv = new Ajv2020({strict: false});
  addFormats(ajv);
  return ajv.compile(schema);
};

const engineerReceipt = {
  implemented: 'add a pnpm tooling harness with vitest schema tests',
  files: [{path: 'package.json', note: 'devDependencies + scripts'}],
  verification: {
    test: {command: 'pnpm test:unit', result: 'PASS', output: '10 passed'},
  },
  status: 'ok',
};

const auditReceipt = {
  auditor: 'supply-chain',
  status: 'ok',
};

describe('receipt validation', () => {
  it('accepts a minimal engineer receipt', () => {
    const validate = compileSchema('receipt.schema.json');
    expect(validate(engineerReceipt)).toBe(true);
  });

  it('accepts a minimal audit receipt', () => {
    const validate = compileSchema('audit-receipt.schema.json');
    expect(validate(auditReceipt)).toBe(true);
  });
});
