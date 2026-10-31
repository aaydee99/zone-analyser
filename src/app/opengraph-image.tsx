import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import { BRAND } from '@/lib/brand';

// The link preview for the landing page (Open Graph; X/Twitter falls back to og:image for its large
// card). Built once at build time: the name, the mark and the one-line description. No figures or quotes.

export const alt = `${BRAND.name}: ${BRAND.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  const mark = await readFile(path.join(process.cwd(), 'public', 'brand', 'castellan-mark.svg'), 'utf8');
  const src = `data:image/svg+xml;base64,${Buffer.from(mark).toString('base64')}`;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '72px 80px', background: '#0b0b0e', color: '#f5f6f8' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain <img> only */}
          <img src={src} width={144} height={108} alt="" />
          <div style={{ fontSize: 88, fontWeight: 700, letterSpacing: -2 }}>{BRAND.name}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ fontSize: 50, lineHeight: 1.2, maxWidth: 1000 }}>{BRAND.tagline}</div>
          <div style={{ display: 'flex', height: 6, width: 160, background: '#d9b04c', borderRadius: 3 }} />
        </div>
      </div>
    ),
    size,
  );
}
