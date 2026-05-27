import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**', 'aitrack*.png'],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true, ignoreIIFE: false }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowBoolean: true,
          allowNumber: true,
        },
      ],
      eqeqeq: ['error', 'always'],
      'no-implicit-coercion': 'error',
      'no-return-await': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: globals.vitest,
    },
  },
  prettier,
);
