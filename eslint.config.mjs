import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(globalIgnores(['**/dist']), {
  files: ['packages/canvas-editor/**/*.{ts,tsx}'],
  extends: [js.configs.recommended, ...tseslint.configs.recommended],
  plugins: { 'react-hooks': reactHooks },
  languageOptions: {
    ecmaVersion: 2023,
    globals: globals.browser,
  },
  rules: {
    // Classic hook rules only: the editor does not use the React Compiler, whose rules (refs, set-state-in-effect,
    // use-memo) flag the editor's deliberate "latest value" refs.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    // Sanitizers (file names, font keys, javascript: URLs) deliberately match C0 control characters.
    'no-control-regex': 'off',
    // The doctype check matches a literal byte-order mark.
    'no-irregular-whitespace': ['error', { skipRegExps: true }],
    // Timers declared before the callbacks that clear them, assigned afterwards.
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
}, {
  // The popost CLI (skills/popost): command code is written against `Runtime`, so the same code runs on a real disk and
  // in the web host's in-process sandbox.
  files: ['skills/popost/**/*.ts'],
  extends: [js.configs.recommended, ...tseslint.configs.recommended],
  languageOptions: { ecmaVersion: 2023, globals: globals.node },
  rules: {
    // Sanitizers and file-name checks deliberately match C0 control characters.
    'no-control-regex': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
}, {
  // Only the Node runtime and the browser launcher touch the disk, the network, child processes or `process`.
  files: ['skills/popost/src/**/*.ts'],
  ignores: ['skills/popost/src/{node-runtime,cli}.ts', 'skills/popost/src/render/browser.ts', 'skills/popost/src/testing/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['node:fs', 'node:fs/*', 'fs', 'fs/*', 'node:child_process', 'child_process', 'node:http', 'http', 'node:https', 'https', 'node:net', 'net', 'node:os', 'os', 'node:process'],
        allowTypeImports: true,
        message: 'Command code uses the Runtime (src/runtime.ts), not Node modules.',
      }],
    }],
    'no-restricted-globals': ['error', { name: 'process', message: 'Command code uses the Runtime (env, cwd, stdout), not process.' }],
  },
});
