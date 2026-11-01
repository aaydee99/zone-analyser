// Plain-text tests of Cloudflare rule expressions and URL patterns for the audit rules. Pure.
// These do not parse the rules language: they recognise a few exact shapes, documented below, and
// anything they do not recognise counts as "not broad" (so the audit never over-reports).

/** The expression without surrounding whitespace, outer parentheses and doubled spaces. */
export function norm(expr: string | undefined): string {
  let e = (expr ?? '').replace(/\s+/g, ' ').trim();
  for (;;) {
    if (!(e.startsWith('(') && e.endsWith(')'))) return e;
    // Only strip a pair that encloses everything: "(a) and (b)" keeps its parentheses.
    let depth = 0, closesAtEnd = true;
    for (let i = 0; i < e.length; i++) {
      if (e[i] === '(') depth++;
      else if (e[i] === ')') { depth--; if (depth === 0 && i < e.length - 1) { closesAtEnd = false; break; } }
    }
    if (!closesAtEnd) return e;
    e = e.slice(1, -1).trim();
  }
}

/**
 * Conditions that match a whole hostname or every path: `true`; `http.host eq "…"` / `==` / `in {…}`;
 * `ends_with(http.host, "…")`; `starts_with(http.request.uri.path, "/")`; `http.request.uri.path contains "/"`;
 * `http.request.uri.path matches "^/"` (or ".*"); `http.request.uri.path ne ""`.
 */
const BROAD_ATOM = [
  /^true$/,
  /^http\.host (?:eq|==) "[^"]*"$/,
  /^http\.host in \{[^}]*\}$/,
  /^ends_with\(http\.host, ?"[^"]*"\)$/,
  /^starts_with\(http\.request\.uri\.path, ?"\/"\)$/,
  /^http\.request\.uri\.path (?:contains|matches|~) "(?:\/|\^\/|\.\*|\^\/\.\*)"$/,
  /^http\.request\.uri\.path (?:ne|!=) ""$/,
];

/** The expression matches every request of the zone or of whole hostnames: it is made only of broad conditions joined by `and` (or is one). */
export function isBroad(expr: string | undefined): boolean {
  const e = norm(expr);
  if (!e) return false;
  if (/ or |\|\|/.test(e)) return e.split(/ or |\|\|/).every((p) => isBroad(p));
  return e.split(/ and |&&/).every((p) => BROAD_ATOM.some((r) => r.test(norm(p))));
}

/** Paths that usually serve per-user or privileged content. */
export const SENSITIVE_SEGMENTS = ['account', 'accounts', 'api', 'user', 'users', 'login', 'signin', 'sign-in', 'logout', 'admin', 'wp-admin', 'administrator',
  'checkout', 'cart', 'basket', 'profile', 'me', 'my', 'auth', 'oauth', 'session', 'sessions', 'dashboard', 'billing', 'payment', 'payments', 'order', 'orders', 'settings', 'graphql'];
const SENSITIVE = new RegExp(`/(${SENSITIVE_SEGMENTS.map((s) => s.replace(/-/g, '\\-')).join('|')})(?=[/"*?.\\s)]|$)`, 'gi');

/** The sensitive path segments a rule expression or URL pattern names ("/api", "/login"), lower-case, once each. */
export function sensitivePaths(text: string | undefined): string[] {
  return [...new Set([...(text ?? '').matchAll(SENSITIVE)].map((m) => `/${m[1].toLowerCase()}`))];
}

/** A page rule or Worker route pattern that covers every path of a host: "example.com/*", "*example.com/*", "*.example.com/*". */
export const isBroadPattern = (pattern: string | undefined) => /^(?:https?:\/\/)?\*?[^/]*\/\*$/.test((pattern ?? '').trim());

/** Fields a client sets freely (headers, user agent, referer, cookies, query). */
const CLIENT_FIELD = /http\.request\.headers|http\.user_agent|http\.referer|http\.cookie|http\.request\.uri\.query|http\.request\.uri\.args|http\.request\.cookies|http\.x_forwarded_for|raw\.http\.request/;
/** Fields only Cloudflare or a client certificate sets. */
const TRUSTED_FIELD = /ip\.src|cf\.tls_client_auth|cf\.client\.bot|cf\.bot_management\.verified_bot|cf\.verified_bot_category|cf\.edge\.server_port|ip\.geoip|ip\.src\.asnum/;
/** The expression decides only on values the client chooses (and on nothing Cloudflare vouches for). */
export const onlyClientFields = (expr: string | undefined) => CLIENT_FIELD.test(expr ?? '') && !TRUSTED_FIELD.test(expr ?? '');

/** Literal paths an expression compares the URI path with: eq / == / starts_with / contains. */
export function literalPaths(expr: string | undefined): { path: string; how: 'eq' | 'prefix' | 'contains' }[] {
  const e = expr ?? '';
  const out: { path: string; how: 'eq' | 'prefix' | 'contains' }[] = [];
  for (const m of e.matchAll(/http\.request\.uri\.path (?:eq|==) "([^"]+)"/g)) out.push({ path: m[1], how: 'eq' });
  for (const m of e.matchAll(/starts_with\(http\.request\.uri\.path, ?"([^"]+)"\)/g)) out.push({ path: m[1], how: 'prefix' });
  for (const m of e.matchAll(/http\.request\.uri\.path contains "([^"]+)"/g)) out.push({ path: m[1], how: 'contains' });
  for (const m of e.matchAll(/http\.request\.uri\.path in \{([^}]*)\}/g)) for (const p of m[1].matchAll(/"([^"]+)"/g)) out.push({ path: p[1], how: 'eq' });
  return out;
}

export const pathMatches = (path: string, p: { path: string; how: 'eq' | 'prefix' | 'contains' }) =>
  p.how === 'eq' ? path === p.path : p.how === 'prefix' ? path.startsWith(p.path) : path.includes(p.path);
