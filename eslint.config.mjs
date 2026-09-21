// DAFTAR — real ESLint flat config. `npm run lint` fails on any violation.
// No workspace may weaken this with eslint-disable / ts-ignore (CI guard enforces).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      // Plain-JS dev launcher (no tsconfig project); CI-relevant scripts are TS.
      'scripts/*.mjs',
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/build/**',
      '**/coverage/**',
      'apps/android/**',
      'apps/*/next.config.mjs',
      'infrastructure/database/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Tests and scripts: console allowed; supertest response bodies are `any`
    // by library design, so type-aware unsafe-* rules are scoped off here only.
    files: [
      'tests/**',
      'scripts/**',
      '**/test/**',
      '**/*.test.ts',
      'apps/api/src/main.ts',
      'apps/api/src/infra/migrate.ts',
      'apps/api/src/modules/outbox/publisher.ts',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
