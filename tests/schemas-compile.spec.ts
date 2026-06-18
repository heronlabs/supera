import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {describe, expect, it} from 'vitest';

const schemaDir = join(__dirname, '..', 'schema');
const loadSchema = (name: string) =>
  JSON.parse(readFileSync(join(schemaDir, name), 'utf8'));

const compile = (schema: unknown) => {
  const ajv = new Ajv2020({strict: false});
  addFormats(ajv);
  return ajv.compile(schema as object);
};

describe('schema compilation', () => {
  it('compiles supera.schema.json without throwing', () => {
    expect(() => compile(loadSchema('supera.schema.json'))).not.toThrow();
  });

  it('compiles receipt.schema.json without throwing', () => {
    expect(() => compile(loadSchema('receipt.schema.json'))).not.toThrow();
  });

  it('compiles audit-receipt.schema.json without throwing', () => {
    expect(() =>
      compile(loadSchema('audit-receipt.schema.json')),
    ).not.toThrow();
  });
});
