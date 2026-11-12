// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'data/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // Plain JS run directly by Node (the Docker healthcheck); no-undef needs
    // to know Node's globals, which typescript-eslint only covers for .ts.
    files: ['docker/**/*.js'],
    languageOptions: { globals: { process: 'readonly' } },
  },
);
