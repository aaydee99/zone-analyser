// Which rules use an account's IP, ASN, hostname and redirect lists: pure helpers for the `lists`
// check and the Lists page (no Node imports, unit-tested in tests/list-refs.test.ts).

/** List names a rule expression uses: `ip.src in $office_ips` → office_ips. Managed lists ($cf.malware …) are kept with their dots. */
export function expressionLists(expression: string | null | undefined): string[] {
  if (!expression) return [];
  const out = new Set<string>();
  // Strings in the expression are skipped: "$x" inside quotes is not a list.
  const code = expression.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const m of code.matchAll(/\$([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g)) out.add(m[1]);
  return [...out];
}

export interface RuleLike { id?: string; description?: string; expression?: string; action?: string; enabled?: boolean; action_parameters?: { from_list?: { name?: string } } }
export interface RulesetLike { id: string; name?: string; phase?: string; kind?: string; rules?: RuleLike[] }

export interface ListRef { list: string; rulesetId: string; ruleset: string; phase: string; ruleId: string; rule: string; action: string; enabled: boolean }

/** Every use of a list in a ruleset: in an expression, or as a bulk-redirect rule's `from_list`. */
export function rulesetRefs(rs: RulesetLike, only?: Set<string>): ListRef[] {
  const out: ListRef[] = [];
  for (const r of rs.rules ?? []) {
    const names = new Set(expressionLists(r.expression));
    if (r.action_parameters?.from_list?.name) names.add(r.action_parameters.from_list.name);
    for (const list of names) {
      if (only && !only.has(list)) continue;
      out.push({ list, rulesetId: rs.id, ruleset: rs.name ?? rs.id, phase: rs.phase ?? '', ruleId: r.id ?? '', rule: r.description || r.id || '', action: r.action ?? '', enabled: r.enabled !== false });
    }
  }
  return out;
}
