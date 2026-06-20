import {defineConfig} from 'eslint/config';
import jsonc from 'eslint-plugin-jsonc';
import jsonSchemaValidator from 'eslint-plugin-json-schema-validator';
import yml from 'eslint-plugin-yml';
import gts from 'gts';

export default defineConfig([
  ...gts,
  ...jsonc.configs['flat/recommended-with-json'],
  {
    files: ['**/*.json'],
    ignores: ['schema/**', '.claude-plugin/**'],
    rules: {
      'jsonc/sort-keys': [
        'error',
        'asc',
        {
          caseSensitive: true,
          natural: false,
          minKeys: 2,
        },
      ],
    },
  },
  {
    files: ['.claude/supera.json', 'schema/examples/*.json'],
    plugins: {'json-schema-validator': jsonSchemaValidator},
    rules: {
      'json-schema-validator/no-invalid': [
        'error',
        {
          // Validating each instance forces the plugin's ajv to compile the
          // whole target schema (resolving every internal $ref), which is what
          // restores the old script's "all schemas compile" coverage. The
          // example fixtures double as living samples of each receipt.
          schemas: [
            {
              fileMatch: ['.claude/supera.json'],
              schema: './schema/supera.schema.json',
            },
            {
              fileMatch: ['schema/examples/receipt.example.json'],
              schema: './schema/receipt.schema.json',
            },
            {
              fileMatch: ['schema/examples/audit-receipt.example.json'],
              schema: './schema/audit-receipt.schema.json',
            },
          ],
        },
      ],
    },
  },
  ...yml.configs['flat/recommended'],
  {
    files: ['.github/**/*.yml', '.github/**/*.yaml'],
    rules: {'yml/sort-keys': 'off'},
  },
  {
    ignores: ['node_modules/', 'pnpm-lock.yaml', '.worktrees/'],
  },
]);
