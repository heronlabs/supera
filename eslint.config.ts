import {defineConfig} from 'eslint/config';
import jsonc from 'eslint-plugin-jsonc';
import yml from 'eslint-plugin-yml';
import gts from 'gts';
import tseslint from 'typescript-eslint';

export default defineConfig([
  ...gts,
  {
    files: ['tests/**/*.ts', '*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
  },
  ...jsonc.configs['flat/recommended-with-json'],
  ...yml.configs['flat/recommended'],
  {
    files: ['**/*.json', '**/*.yml', '**/*.yaml'],
    rules: {
      'prettier/prettier': 'off',
      'jsonc/sort-keys': 'off',
      'yml/sort-keys': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'coverage/', 'pnpm-lock.yaml', 'tools/**/*.mjs'],
  },
]);
