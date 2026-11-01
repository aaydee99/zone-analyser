import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import { LEGAL, LEGAL_DRAFT } from '@/lib/legal';
import { Fill, LegalPage, Section } from '@/components/landing/site-chrome';

// EXAMPLE privacy notice, drafted from what the code does (AUDIT.md B1) for a lawyer to review.
// Company facts come from src/lib/legal.ts. Static: no cookies, no request-time data.

export const metadata: Metadata = {
  title: `Privacy — ${BRAND.name}`,
  description: `How the ${BRAND.name} website handles personal data, and what the self-hosted ${BRAND.name} software processes.`,
  robots: { index: !LEGAL_DRAFT, follow: true },
};

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy notice"
      lede={<p>Part A covers this website and email sent to us. Part B describes what the {BRAND.name} software processes when a customer runs it, so customers can write the notice they give their own staff.</p>}
    >
      <Section id="a" title="Part A · This website">
        <p>
          The website at this address is run by <Fill v={LEGAL.entityName} />, <Fill v={LEGAL.registeredAddress} /> (&quot;we&quot;).
          We decide how the personal data described in this part is used (we are its controller).
          Questions and requests: <Fill v={LEGAL.privacyEmail} />.
        </p>
      </Section>

      <Section id="a1" title="A1 · What we collect">
        <ul>
          <li>
            <strong>Requests to the website.</strong> Like any website, our hosting provider (<Fill v={LEGAL.websiteHost} />) receives
            your IP address, browser user agent, the page requested and the time, and may keep them in server logs.
            We use them to deliver the site and keep it secure. Kept for <Fill v={LEGAL.hostLogRetention} />.
          </li>
          <li>
            <strong>Email you send us.</strong> If you write to <Fill v={LEGAL.contactEmail} />, we receive your email address, your name
            and anything you put in the message. We use it to answer you and to talk about a possible purchase.
            Received through <Fill v={LEGAL.emailProvider} /> and kept for <Fill v={LEGAL.salesEmailRetention} />.
          </li>
        </ul>
        <p>That is all. There are no forms to fill in on the public pages.</p>
      </Section>

      <Section id="a2" title="A2 · No cookies, analytics or tracking">
        <p>
          The public pages set no cookies and use no browser storage. There are no analytics, advertising or tracking scripts.
          Fonts are served from this website itself, so your browser does not contact a font provider, and the pages load no
          third-party content. The website asks browsers not to send a referrer to other sites.
        </p>
        <p>
          The <Link href="/console/login">Sign in</Link> page belongs to the console, for authorised users only. Signing in sets a session
          cookie, and the operator of the console may turn on a Cloudflare Turnstile check there (see Part B).
        </p>
      </Section>

      <Section id="a3" title="A3 · Legal basis, sharing and transfers">
        <ul>
          <li>Legal basis: <Fill v={LEGAL.legalBasis} /></li>
          <li>We share this data only with the providers named above, who handle it for us. We do not sell it.</li>
          <li>International transfers: <Fill v={LEGAL.transfers} /></li>
        </ul>
      </Section>

      <Section id="a4" title="A4 · Your rights">
        <p>
          You can ask us for a copy of your personal data, to correct or delete it, or to stop using it, by writing
          to <Fill v={LEGAL.privacyEmail} />. You may also complain to a data protection authority.
        </p>
        <p><Fill v={LEGAL.rightsAndAuthority} /></p>
        <p>This website and the software are for business use. They are not meant for children.</p>
      </Section>

      <Section id="b" title={`Part B · The ${BRAND.name} software, run by each customer`}>
        <p>
          Each customer runs its own copy of the console in its own accounts: its own Supabase project, its own hosting (for
          example Vercel and GitHub Actions, or its own server) and its own storage buckets. The customer decides what the
          console is used for and is the controller of the data in it. The software does not send console data to us.{' '}
          <Fill v={LEGAL.supportAccess} />
        </p>
        <p>
          Customers should give their own staff a privacy notice. The rest of this part lists what the software processes,
          to help with that. Staff who want their data corrected or deleted should contact their console administrator.
        </p>
      </Section>

      <Section id="b1" title="B1 · What the console processes">
        <ul>
          <li><strong>Staff accounts:</strong> email address, name, role. Passwords are handled by Supabase Auth. There is no public sign-up: administrators add users.</li>
          <li><strong>Sessions:</strong> a session cookie (<code>cfbc_session</code>, at most 12 hours). The database keeps a hash of the session token, the browser user agent and the expiry. IP addresses are not recorded.</li>
          <li><strong>Audit log:</strong> each action with the user&apos;s ID and email, the action, its target, details and time, including failed sign-ins with the email address that was typed. Secrets and passwords are not recorded.</li>
          <li><strong>Rate limiting:</strong> a one-way hash of the client IP address, deleted about an hour after its window ends.</li>
          <li><strong>History:</strong> the email of whoever requested or approved backups, restores and reports.</li>
          <li><strong>Zone details:</strong> owner, contact and notes typed in by staff (free text).</li>
          <li><strong>Slack, if configured:</strong> Slack user and team IDs, up to 200 characters of each command, and notes about Slack users.</li>
          <li>
            <strong>Cloudflare data</strong> read with the customer&apos;s own tokens: configuration (which may contain email addresses, for
            example in Access policies or notification settings), the Cloudflare audit log with the email address and IP
            address of whoever made each change, traffic analytics, and security events with visitor IP address, country and
            network (ASN) in Ray ID and WAF lookups. Live Worker logs show what the customer&apos;s Workers log, in sessions of at most
            10 minutes that are deleted when they stop.
          </li>
          <li><strong>Backups:</strong> Terraform and JSON copies of the Cloudflare configuration, stored in the customer&apos;s own R2 or S3 buckets.</li>
          <li><strong>Browser storage (console only):</strong> the session cookie above, plus <code>sessionStorage</code> and <code>localStorage</code> entries that remember a pending request, a restore in progress and view choices.</li>
          <li>
            <strong>Cloudflare Turnstile, if the operator turns it on:</strong> on the sign-in and setup pages only. Cloudflare receives the
            challenge data from the browser and the visitor&apos;s IP address for verification.{' '}
            <Fill v={LEGAL.turnstileDetails} />
          </li>
        </ul>
        <p>The software sends no email, has no analytics and uses no AI services.</p>
      </Section>

      <Section id="b2" title="B2 · Services a customer may connect">
        <p>All of these run in the customer&apos;s own accounts, under the customer&apos;s agreements with each provider:</p>
        <ul>
          <li><strong>Supabase:</strong> the database and sign-in: accounts, sessions, the audit log and the other console data in B1.</li>
          <li><strong>Vercel:</strong> web hosting; receives every request, and its logs hold server output.</li>
          <li><strong>GitHub Actions:</strong> runs the worker; its logs hold the worker&apos;s output.</li>
          <li><strong>Cloudflare:</strong> the API (read, and written to only by restores, reverts, cache purges, rollbacks and Logpush changes), Turnstile, DNS over HTTPS (hostname lookups) and R2.</li>
          <li><strong>AWS S3:</strong> backup storage.</li>
          <li><strong>Slack:</strong> findings, reports and command answers (which can include visitor IP addresses from Ray ID lookups).</li>
          <li><strong>Webhooks:</strong> findings sent to an address the customer chooses.</li>
          <li><strong>Redis (optional):</strong> hashed rate-limit keys and short-lived caches (about 2 minutes), which can include Cloudflare activity.</li>
        </ul>
        <p>The server also downloads Terraform and cf-terraforming from HashiCorp and GitHub; those requests carry only the server&apos;s IP address.</p>
      </Section>

      <Section id="b3" title="B3 · How long it is kept">
        <ul>
          <li>Expired sessions are deleted at the next sign-in; rate-limit rows after about an hour; worker relay records after a few minutes; each report keeps its newest 50 runs.</li>
          <li>The audit log, backup runs and their logs, approvals, notifications and Cloudflare alerts are kept until the customer deletes them. The software does not purge them automatically.</li>
          <li>Deleting a user removes the account, sessions and personal settings. Copies of the user&apos;s email address remain in the audit log and in history records.</li>
          <li><Fill v={LEGAL.retentionGuidance} /></li>
        </ul>
      </Section>

      <Section id="changes" title="Changes and contact">
        <p>
          We will post changes on this page with a new version and date. Contact: <Fill v={LEGAL.privacyEmail} />,{' '}
          <Fill v={LEGAL.entityName} />, <Fill v={LEGAL.registeredAddress} />.
        </p>
      </Section>
    </LegalPage>
  );
}
