import {defineConfig} from 'eslint/config';
import jsonc from 'eslint-plugin-jsonc';
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
  ...yml.configs['flat/recommended'],
  {
    files: ['.github/**/*.yml', '.github/**/*.yaml'],
    rules: {'yml/sort-keys': 'off'},
  },
  {
    ignores: ['node_modules/', 'pnpm-lock.yaml', '.worktrees/'],
  },
]);
