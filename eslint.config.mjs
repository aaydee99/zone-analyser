import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defineConfig, globalIgnores } from 'eslint/config';

// TypeScript 7 (what `tsc` runs) ships no compiler API, and typescript-eslint needs one. As the
// TS 7 release notes suggest, the TS 6 API is installed beside it (@typescript/typescript6); here
// `typescript` is pointed at it for the lint plugins only, so `tsc` and `next build` keep TS 7.
const TS6 = pathToFileURL(createRequire(import.meta.url).resolve('@typescript/typescript6')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'typescript' && /[\\/]node_modules[\\/](@typescript-eslint|typescript-eslint|ts-api-utils|eslint-config-next|eslint-plugin-[^\\/]+)[\\/]/.test(context.parentURL ?? '')) {
      return { url: TS6, format: 'commonjs', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { default: nextVitals } = await import('eslint-config-next/core-web-vitals');
const { default: nextTs } = await import('eslint-config-next/typescript');

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Rules the code base does not follow yet: reported as warnings (see `npm run lint`), not errors.
    // These React Compiler rules flag long-standing patterns (setState in an effect, Date.now() in
    // render) whose fixes are refactors, not one-liners.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      // `const { log: _log, ...rest } = r` drops a field on purpose.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    // Server and shared modules: no React here, so a function named use… (e.g. useCallOnce) is not a hook.
    files: ['src/lib/**/*.ts'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Not the console's own source: the bundled backup script, runtime data, the design-system kit.
    'runner/**',
    'data/**',
    'design-system/**',
    '.claude/**',
    '.agents/**',
  ]),
]);
