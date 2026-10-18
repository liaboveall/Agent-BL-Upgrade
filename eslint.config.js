// ESLint (flat config). Deliberately conservative: it catches real bugs (undefined names,
// unreachable code, duplicate keys, unused variables, ...) without imposing a style, which
// the existing code base does not follow uniformly.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

// JSX references a component by name; core no-unused-vars cannot see that, so mark them used.
const jsxUsesVars = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const markUsed = (node, name) => context.sourceCode.markVariableAsUsed(name, node);
    return {
      JSXOpeningElement(node) {
        let name = node.name;
        while (name.type === 'JSXMemberExpression') name = name.object;
        if (name.type === 'JSXIdentifier' && /^[A-Z]/u.test(name.name)) markUsed(node, name.name);
      }
    };
  }
};

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
      'dist/**',
      'hardhat/artifacts/**',
      'hardhat/cache/**',
      'data/runtime/**',
      'artifacts/**',
      '.claude/**',
      'coverage/**',
      'test-results/**', 'playwright-report/**'
    ]
  },
  js.configs.recommended,
  { files: ['tests/browser/**/*.js'], languageOptions: { globals: { ...globals.browser } } },
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
    // The React dashboard (web/, built by Vite into dist/).
    files: ['web/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks, local: { rules: { 'jsx-uses-vars': jsxUsesVars } } },
    rules: {
      ...sharedRules,
      'local/jsx-uses-vars': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // Vite config runs in Node.
    files: ['web/vite.config.js'],
    languageOptions: { globals: { ...globals.node } }
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
