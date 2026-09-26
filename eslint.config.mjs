import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        EW: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'off',
      // getNestedValue() in utils.ts returns a genuine any - callers treat the
      // result as a string. Warn rather than error so lint stays usable as a
      // pre-deploy gate; tsconfig has noImplicitAny off anyway.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // tools/ has its own tsconfig and runs on Node, so it is linted separately.
    ignores: ['built/', 'dist/', 'node_modules/', 'vendor/', 'tools/'],
  },
];
