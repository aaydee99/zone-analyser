// Company facts for the footer and the example legal pages (/privacy, /terms, /licenses), in one
// place. Every "[TODO: …]" is shown as-is on the pages until you replace it here. The page texts
// are EXAMPLES drafted for a lawyer to review: none of this is legal advice.
import { BRAND, SALES_EMAIL_TODO } from './brand';

const todo = (what: string) => `[TODO: ${what}]`;

export const LEGAL = {
  /** The company that runs this website and licenses the software. */
  entityName: todo('legal entity name'),
  registeredAddress: todo('registered address'),
  companyNumber: todo('company registration number'),
  /** Where people send privacy questions and requests about this website. */
  privacyEmail: todo('privacy contact email'),
  /** The public contact address: NEXT_PUBLIC_SALES_EMAIL (see brand.ts). */
  contactEmail: BRAND.salesEmail ?? SALES_EMAIL_TODO,
  /** Who hosts this website and keeps its request logs. */
  websiteHost: todo('website hosting provider (Vercel?), confirm'),
  hostLogRetention: todo('how long hosting/server logs are kept'),
  salesEmailRetention: todo('how long sales emails are kept'),
  emailProvider: todo('email provider that receives the contact address, if any'),
  governingLaw: todo('governing law and courts'),
  effectiveDate: todo('effective date'),
  version: todo('version'),

  // /privacy: clauses a lawyer or the owner has to write or confirm.
  legalBasis: todo('legal basis for each use, e.g. legitimate interests for logs and for replying to email; lawyer to confirm'),
  transfers: todo('where the providers process data and the transfer safeguards used'),
  rightsAndAuthority: todo('the rights and the supervisory authority that apply under the governing law'),
  supportAccess: todo("if you ever get access to a customer's deployment, e.g. for support, say so here and cover it in a contract"),
  turnstileDetails: todo("confirm from Cloudflare's Turnstile documentation what it collects and stores in the browser"),
  retentionGuidance: todo('customers set their own retention periods; say here if you offer guidance'),

  // /terms
  contractPrecedence: todo('which document wins if an order form or contract differs; click-through or signed acceptance'),
  licenceScope: todo('term, number of deployments, accounts or zones, and whether it covers affiliates and contractors'),
  licenceRestrictions: todo('e.g. no resale, sublicensing or hosting for third parties; lawyer to write'),
  fees: todo('fees, invoicing, renewal and refund terms, or "as set out in your order form"'),
  warranty: todo('warranty and disclaimer wording; lawyer to write'),
  liability: todo('limitation and exclusion of liability; lawyer to write'),
  termination: todo('term, renewal, termination for convenience or breach, and notice periods'),
} as const;

export const isTodo = (s: string) => s.startsWith('[TODO:');

/** True while any placeholder above is unfilled: the legal pages then ask not to be indexed. */
export const LEGAL_DRAFT = Object.values(LEGAL).some(isTodo);

export const LEGAL_NOTICE = 'Example text — draft for legal review, not legal advice. Replace every TODO before publishing.';
