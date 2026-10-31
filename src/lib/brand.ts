// The product's name and short descriptions, in one place: rename here (and nowhere else).

/** Placeholder used until NEXT_PUBLIC_SALES_EMAIL is set. Links still work, they just go nowhere useful. */
export const SALES_EMAIL_PLACEHOLDER = 'sales@example.com';

export const BRAND = {
  name: 'Castellan',
  /** One line under the name: what it is. */
  tagline: 'Backup, restore and visibility for your Cloudflare edge',
  /** For search results and link previews. */
  description: 'Back up every Cloudflare zone and account setting to Terraform and JSON, restore any of it in minutes, see every change and who made it, and read traffic and security analytics for any account or zone.',
  /**
   * Where "Contact sales" goes. Set NEXT_PUBLIC_SALES_EMAIL (inlined at build time) to your own
   * address before launch; until then it falls back to the placeholder.
   */
  salesEmail: process.env.NEXT_PUBLIC_SALES_EMAIL?.trim() || SALES_EMAIL_PLACEHOLDER,
} as const;
