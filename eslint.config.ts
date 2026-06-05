import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
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
  unicorn.configs.recommended,
  {
    rules: {
      // Project uses camelCase / kebab-case mix; both fine.
      'unicorn/filename-case': 'off',
      // Many descriptive short names (e.g. `n`, `i`, `fmt`) are intentional.
      'unicorn/prevent-abbreviations': 'off',
      // Project uses `null` deliberately (e.g. nullable cost fields).
      'unicorn/no-null': 'off',
      // Conflicts with our deliberate `if (!x) return` style and chalk return values.
      'unicorn/no-array-callback-reference': 'off',
      // Number coercion via `Number(x)` is more explicit than `+x` for our reader code.
      'unicorn/prefer-number-properties': 'off',
      // `process.exit(1)` is the right thing in a CLI entrypoint.
      'unicorn/no-process-exit': 'off',
      // We rely on lexical `this` and arrow ergonomics; reduce is rarely used anyway.
      'unicorn/no-array-reduce': 'off',
      // Switch statements are clearer than object lookups for the window resolver.
      'unicorn/switch-case-braces': 'off',
      // We use `() => undefined` for console spies; rule fights this idiom.
      'unicorn/no-useless-undefined': 'off',
      // Mixed default/namespace `node:path` imports are fine; not worth the churn.
      'unicorn/import-style': 'off',
      // toSorted() is ES2023, support story OK but our `.sort()` chains are clear.
      'unicorn/no-array-sort': 'off',
      // Multiple `lines.push(...)` calls are easier to follow than coalesced calls.
      'unicorn/prefer-single-call': 'off',
      'unicorn/no-immediate-mutation': 'off',
      // False positives on closures that legitimately capture state.
      'unicorn/consistent-function-scoping': 'off',
      // The update-pricing script intentionally uses a promise chain at the bottom.
      'unicorn/prefer-top-level-await': 'off',
      // Minor; `(await x).foo` is clearer than two-line splits in our reader code.
      'unicorn/no-await-expression-member': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
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
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  {
    files: ['**/*.test.ts'],
    plugins: { vitest },
    languageOptions: {
      globals: globals.vitest,
    },
    rules: {
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'warn',
      'vitest/no-conditional-tests': 'error',
      'vitest/no-identical-title': 'error',
      'vitest/expect-expect': 'error',
      'vitest/valid-expect': 'error',
      'vitest/no-standalone-expect': 'error',
      'vitest/prefer-to-have-length': 'warn',
    },
  },
  prettier,
);
