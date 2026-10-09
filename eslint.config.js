// @ts-check
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./packages/*/tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'object-shorthand': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Deep-module boundaries: packages talk to each other through their public entry only,
    // and only the pi adapter may touch pi itself. Protocol drift then changes one file.
    files: ['packages/**/*.ts'],
    ignores: ['packages/core/lib/pi/rpc-transport.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@earendil-works/pi-coding-agent',
              message:
                'Only packages/core/lib/pi/rpc-transport.ts may import pi. Go through PiTransport.',
              allowTypeImports: false,
            },
          ],
          patterns: [
            {
              group: ['@deeptokens/*/lib/*', '@deeptokens/*/dist/*'],
              message: 'Import a package by its public entry, not its internals.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/mcp/main.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // expect(mock.method) is how vitest asserts on calls.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
)
