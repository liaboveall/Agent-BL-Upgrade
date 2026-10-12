// ESLint (flat config). Deliberately conservative: it catches real bugs (undefined names,
// unreachable code, duplicate keys, unused variables, ...) without imposing a style, which
// the existing code base does not follow uniformly.
import js from '@eslint/js';
import globals from 'globals';

const sharedRules = {
  // Unused values are worth a look, but an underscore prefix marks them as intentional.
  'no-unused-vars': ['warn', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'none',
    ignoreRestSiblings: true
  }],
  // `while (true)` / `for (;;)` loops with an explicit break are used on purpose.
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['warn', 'always', { null: 'ignore' }],
  'prefer-const': 'warn',
  'no-var': 'error'
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      'public/vendor/**',
      'hardhat/artifacts/**',
      'hardhat/cache/**',
      'data/runtime/**',
      '.claude/**',
      'coverage/**'
    ]
  },
  js.configs.recommended,
  {
    // Server code, scripts and tests: Node, ES modules.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: sharedRules
  },
  {
    // The browser app.
    files: ['public/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: sharedRules
  },
  {
    // CommonJS helpers (shared by CJS and ESM scripts).
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: sharedRules
  },
  {
    // Mocha-style Hardhat tests.
    files: ['hardhat/test/**/*.js'],
    languageOptions: { globals: { ...globals.mocha } }
  }
];
