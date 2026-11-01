// The product's name and short descriptions, in one place: rename here (and nowhere else).

/** Shown instead of an address until NEXT_PUBLIC_SALES_EMAIL is set: visible, and never a link. */
export const SALES_EMAIL_TODO = '[TODO: contact email]';

const salesEmail = process.env.NEXT_PUBLIC_SALES_EMAIL?.trim() || null;

export const BRAND = {
  name: 'Castellan',
  /** One line under the name: what it is. */
  tagline: 'Backup, restore and visibility for your Cloudflare edge',
  /** For search results and link previews, and the landing page's lede. */
  description: 'Find out whether your WAF, managed rules and rate limits stop what they should, measured on your own traffic, for any zone in any of your accounts, read-only. Then monitor, investigate, undo and back up the configuration behind them.',
  /**
   * Where "Contact sales" goes: NEXT_PUBLIC_SALES_EMAIL (inlined at build time). Null until it is
   * set, so no fake address ships: the page shows SALES_EMAIL_TODO and no mailto link.
   */
  salesEmail,
} as const;

/** A mailto: link to sales, or null while no address is set. */
export function salesHref(subject = `${BRAND.name}: plans and pricing`): string | null {
  return salesEmail ? `mailto:${salesEmail}?subject=${encodeURIComponent(subject)}` : null;
}
