import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import { LEGAL, LEGAL_DRAFT } from '@/lib/legal';
import { Fill, LegalPage, Section } from '@/components/landing/site-chrome';

// EXAMPLE software licence / terms of use outline for a lawyer to complete. Company facts and the
// clauses only a lawyer can write come from src/lib/legal.ts. Static.

export const metadata: Metadata = {
  title: `Terms — ${BRAND.name}`,
  description: `Example licence and terms of use for the ${BRAND.name} software.`,
  robots: { index: !LEGAL_DRAFT, follow: true },
};

export default function Terms() {
  return (
    <LegalPage
      title="Software licence and terms of use"
      lede={<p>An outline of the terms under which <Fill v={LEGAL.entityName} /> licenses the {BRAND.name} software to a customer, who runs its own copy. A signed order form or contract may replace or add to these terms: <Fill v={LEGAL.contractPrecedence} /></p>}
    >
      <Section id="parties" title="1 · Who these terms are between">
        <p>
          <Fill v={LEGAL.entityName} />, <Fill v={LEGAL.registeredAddress} />, company no. <Fill v={LEGAL.companyNumber} /> (&quot;we&quot;),
          and the organisation that obtains a licence (&quot;you&quot;). The software is for business use only.
        </p>
      </Section>

      <Section id="licence" title="2 · Licence">
        <p>
          We grant you a licence to install and run the software in infrastructure you control, for your own organisation&apos;s
          internal use, for the term and scope in your order. Scope: <Fill v={LEGAL.licenceScope} />
        </p>
        <p>Restrictions: <Fill v={LEGAL.licenceRestrictions} /></p>
      </Section>

      <Section id="you" title="3 · Your responsibilities">
        <ul>
          <li><strong>Your deployment.</strong> You run the console in your own accounts (Supabase, hosting such as Vercel and GitHub Actions or your own server, storage buckets) and keep them secure, updated and backed up.</li>
          <li><strong>Your Cloudflare credentials.</strong> You choose the API tokens and keys you store and what they may do. You are responsible for actions taken with them, including restores, reverts, cache purges, rollbacks and Logpush changes made through the console.</li>
          <li><strong>Review before you apply.</strong> A restore shows a plan before it writes to Cloudflare. Check it before you apply it.</li>
          <li><strong>Your users.</strong> You decide who gets an account and which role, and you are responsible for what they do in the console.</li>
          <li><strong>Your data.</strong> You are the controller of the personal data your copy processes (see the <Link href="/privacy">privacy notice</Link>, Part B). You need a legal basis for it and should give your staff a notice.</li>
          <li><strong>Other providers.</strong> Your use of Supabase, Vercel, GitHub, Cloudflare, AWS, Slack and any other service you connect is under your own agreements with them.</li>
        </ul>
      </Section>

      <Section id="oss" title="4 · Open-source components">
        <p>The software includes open-source components under their own licences. They are listed with their licence texts in the <Link href="/licenses">open-source notices</Link>. Nothing in these terms limits your rights under those licences.</p>
      </Section>

      <Section id="fees" title="5 · Fees">
        <p><Fill v={LEGAL.fees} /></p>
      </Section>

      <Section id="warranty" title="6 · Warranty">
        <p><Fill v={LEGAL.warranty} /></p>
      </Section>

      <Section id="liability" title="7 · Liability">
        <p><Fill v={LEGAL.liability} /></p>
      </Section>

      <Section id="termination" title="8 · Term and termination">
        <p><Fill v={LEGAL.termination} /></p>
        <p>When the licence ends you stop using the software. Your data stays in your own accounts and buckets; we hold no copy of it to return or delete.</p>
      </Section>

      <Section id="law" title="9 · Governing law">
        <p><Fill v={LEGAL.governingLaw} /></p>
      </Section>

      <Section id="changes" title="10 · Changes and contact">
        <p>We will post new versions of these terms on this page with their version and date. Contact: <Fill v={LEGAL.contactEmail} />.</p>
      </Section>
    </LegalPage>
  );
}
