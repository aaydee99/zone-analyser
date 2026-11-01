import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import { LEGAL_DRAFT } from '@/lib/legal';
import { LegalPage, Section } from '@/components/landing/site-chrome';
// Written by `npm run notices` (scripts/gen-notices.mjs) together with public/THIRD_PARTY_NOTICES.txt.
import summary from './packages.json';

export const metadata: Metadata = {
  title: `Open-source notices — ${BRAND.name}`,
  description: `The open-source software and fonts included in ${BRAND.name}, and their licences.`,
  robots: { index: !LEGAL_DRAFT, follow: true },
};

const NOTICES = '/THIRD_PARTY_NOTICES.txt';

export default function Licenses() {
  return (
    <LegalPage
      title="Open-source notices"
      lede={<p>{BRAND.name} is built on open-source software. Each component keeps its own licence; the full list with every licence text is in <a href={NOTICES} className="lp-link text-ink-2 hover:text-ink">THIRD_PARTY_NOTICES.txt</a>.</p>}
    >
      <Section id="runtime" title="Runtime packages">
        <p>The packages the software depends on directly. With what they depend on, the production tree has {summary.total} packages.</p>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-[14px]">
            <thead className="bg-sunken/70 text-ink-2">
              <tr><th scope="col" className="px-4 py-2.5 font-semibold">Package</th><th scope="col" className="px-4 py-2.5 font-semibold">Version</th><th scope="col" className="px-4 py-2.5 font-semibold">Licence</th></tr>
            </thead>
            <tbody>
              {summary.top.map((p) => (
                <tr key={p.name} className="border-t border-line">
                  <td className="px-4 py-2.5 font-mono text-[13px] text-ink">{p.name}</td>
                  <td className="px-4 py-2.5 font-mono text-[13px]">{p.version}</td>
                  <td className="px-4 py-2.5">{p.licence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>Licences across the whole tree: {summary.licences.map((l) => `${l.licence} (${l.count})`).join(', ')}.</p>
      </Section>

      <Section id="fonts" title="Fonts">
        <p>Fira Sans, Fira Code and Archivo, under the SIL Open Font License 1.1. They are served from this site itself.</p>
      </Section>

      <Section id="data" title="Data">
        <p>caniuse-lite, browser support data from the Can I Use project (caniuse.com), a dependency of the framework, under the Creative Commons Attribution 4.0 licence.</p>
      </Section>

      <Section id="full" title="Full notices">
        <p>
          <a href={NOTICES}>Read THIRD_PARTY_NOTICES.txt</a>: every package with its version, licence and licence text, the font licence and
          the attributions above. See also the <Link href="/terms">terms</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}
