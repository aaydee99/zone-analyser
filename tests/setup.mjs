// Loaded with `node --import ./tests/setup.mjs --test`: lets Node's own TypeScript support
// (type stripping) run the console's source as-is. It resolves what the bundler would:
// `@/x` → src/x, extension-less relative imports → .ts / .tsx / index.ts, and `server-only` → an
// empty module. Only pure helpers are tested this way; nothing here starts Next.js.
import { existsSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';

const SRC = new URL('../src/', import.meta.url);
const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
const isFile = (u) => existsSync(u) && statSync(u).isFile();

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export {}', format: 'module', shortCircuit: true };
    let spec = specifier;
    if (spec.startsWith('@/')) spec = new URL(spec.slice(2), SRC).href;
    if ((spec.startsWith('.') || spec.startsWith('file:')) && context.parentURL) {
      const base = new URL(spec, context.parentURL);
      if (!isFile(base)) {
        for (const ext of EXTS) {
          const u = new URL(base.href + ext);
          if (isFile(u)) return next(u.href, context);
        }
      }
      return next(base.href, context);
    }
    return next(spec, context);
  },
});
