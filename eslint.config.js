// Flat ESLint config covering all TypeScript in the repo (runtime container,
// lambdas, CDK). Linting via typescript-eslint (recommended rules, not type-aware); prettier owns
// formatting, so eslint-config-prettier turns off any stylistic rules that
// would conflict.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/cdk.out/**', '**/dist/**', '**/*.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // The agent tool layer deliberately uses `any` at the Strands SDK
      // boundary (see the comments in tools.ts/slackTools.ts); allow it
      // rather than scatter disables.
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow intentionally-unused args when prefixed with `_`.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
