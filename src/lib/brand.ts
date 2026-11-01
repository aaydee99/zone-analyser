// The product's name and short descriptions, in one place: rename here (and nowhere else).

/** The contact address on the landing page. NEXT_PUBLIC_SALES_EMAIL (inlined at build time) overrides it. */
const salesEmail = process.env.NEXT_PUBLIC_SALES_EMAIL?.trim() || 'sales@castellan.com';

export const BRAND = {
  name: 'Castellan',
  /** One line under the name: what it is. */
  tagline: 'Backup, restore and visibility for your Cloudflare edge',
  /** For search results and link previews, and the landing page's lede. */
  description: 'Find out whether your WAF, managed rules and rate limits stop what they should, measured on your own traffic, for any zone in any of your accounts, read-only. Then monitor, investigate, undo and back up the configuration behind them.',
  /** Where "Contact sales" goes. */
  salesEmail,
} as const;

/** A mailto: link to sales. */
export function salesHref(subject = `${BRAND.name}: plans and pricing`): string {
  return `mailto:${salesEmail}?subject=${encodeURIComponent(subject)}`;
}
