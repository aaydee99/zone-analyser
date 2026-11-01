// Company facts for the footer and the example legal pages (/privacy, /terms, /licenses), in one
// place. The values are SAMPLE company details and example legal wording: replace them with the
// real ones and have a lawyer review the pages before relying on them.
import { BRAND } from './brand';

export const LEGAL = {
  /** The company that runs this website and licenses the software. */
  entityName: 'Castellan Inc',
  registeredAddress: '1847 Larkspur Avenue, Suite 310, Wilmington, DE 19803, United States',
  companyNumber: '187656',
  /** Where people send privacy questions and requests about this website. */
  privacyEmail: 'privacy@castellan.com',
  /** The public contact address (see brand.ts). */
  contactEmail: BRAND.salesEmail,
  /** Who hosts this website and keeps its request logs. */
  websiteHost: 'Vercel Inc.',
  hostLogRetention: '30 days',
  salesEmailRetention: 'up to 24 months after our last conversation, or longer if we sign a contract with you',
  emailProvider: 'Google Workspace',
  governingLaw: 'These terms are governed by the laws of the State of Delaware, United States, without regard to its conflict-of-laws rules. The state and federal courts located in Wilmington, Delaware have exclusive jurisdiction over any dispute arising from them.',
  effectiveDate: '1 November 2026',
  version: '1.0',

  // /privacy
  legalBasis: 'our legitimate interests in running a secure website and in answering the people who write to us; where you are a customer, performing our contract with you.',
  transfers: 'our providers may process data in the United States and other countries. Where the law requires it, we rely on the EU Standard Contractual Clauses or an equivalent safeguard.',
  rightsAndAuthority: 'Depending on where you live, you may have the right to access, correct, delete or restrict the use of your personal data, to object to its use, and to receive a copy of it. Write to privacy@castellan.com and we will answer within 30 days. You may also complain to your local data protection authority.',
  supportAccess: 'Castellan Inc has no access to a customer\'s deployment. If a customer asks for help and grants temporary access, that access is limited to the support request and is covered by the customer\'s contract.',
  turnstileDetails: 'Turnstile checks the browser to tell people from automated traffic. Cloudflare processes the signals it needs for that check under its own Turnstile privacy terms; it is not used for advertising.',
  retentionGuidance: 'Each customer sets its own retention periods. As a starting point we suggest keeping the audit log for 12 months and run logs for 90 days.',

  // /terms
  contractPrecedence: 'if a signed order form or contract differs from these terms, the signed document wins. Using the software after accepting an order form means you accept these terms.',
  licenceScope: 'for the subscription term in your order, for the number of deployments listed there, covering your own Cloudflare accounts and zones and those you manage for your affiliates.',
  licenceRestrictions: 'you may not resell, sublicense or rent the software, offer it to third parties as a hosted service, or remove its notices. You may not reverse engineer it except where the law allows.',
  fees: 'Fees are set out in your order form and invoiced annually in advance, payable within 30 days. Subscriptions renew for another year unless either party gives notice at least 30 days before the end of the term. Fees already paid are not refundable, except as required by law.',
  warranty: 'Castellan Inc warrants that the software will perform materially as described in its documentation for 90 days from delivery. Apart from that, the software is provided "as is", without other warranties of any kind, express or implied.',
  liability: 'Neither party is liable for indirect, incidental or consequential damages, or for lost profits or data. Each party\'s total liability is limited to the fees paid in the 12 months before the claim. These limits do not apply where the law does not allow them.',
  termination: 'Either party may end these terms if the other materially breaches them and does not fix the breach within 30 days of written notice. When they end, you stop using the software and delete your copies; your data stays in your own systems.',
} as const;

export const isTodo = (s: string) => s.startsWith('[TODO:');

/** While the details above are samples, the legal pages ask not to be indexed. Set to false once they are real. */
export const LEGAL_DRAFT = true;

export const LEGAL_NOTICE = 'Example text with sample company details — draft for legal review, not legal advice.';
