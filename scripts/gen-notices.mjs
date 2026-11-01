#!/usr/bin/env node
// Writes public/THIRD_PARTY_NOTICES.txt (served at /THIRD_PARTY_NOTICES.txt) and
// src/app/licenses/packages.json (the summary the /licenses page shows). `npm run notices`.
//
// Covers the production dependency tree: package.json "dependencies", then each package's
// "dependencies" and "optionalDependencies" recursively, resolved through node_modules the way
// Node does (nested first, then upwards). Optional packages count only if installed, so
// platform-specific binaries (e.g. @img/sharp-*, @next/swc-*) reflect the machine this runs on:
// run it again in the build environment (Linux on Vercel or Docker) for that platform's list.
// Also adds the SIL OFL 1.1 notice for the self-hosted fonts and the CC BY 4.0 attribution for
// caniuse-lite. No dependencies.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'THIRD_PARTY_NOTICES.txt');
const SUMMARY = join(ROOT, 'src', 'app', 'licenses', 'packages.json');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const root = readJson(join(ROOT, 'package.json'));

/** The installed directory of `name` as seen from `from`, or null. */
function locate(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return p;
    if (dir === ROOT || dirname(dir) === dir) return null;
  }
}

function licenceOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ');
  return l?.type ?? 'UNKNOWN';
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\b|[-_.]|$)/i;
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim();
/** The package's licence files; plus its README's licence section when it has no licence file or
 *  bundles LGPL binaries (sharp's README lists the licences of the libraries it ships). */
function licenceTexts(dir, licence) {
  const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  const texts = files.filter((f) => LICENCE_FILE.test(f)).sort().map((f) => ({ file: f, text: read(join(dir, f)) }));
  const readme = files.find((f) => /^readme(\.md)?$/i.test(f));
  if (readme && (!texts.length || /LGPL/.test(licence))) {
    const m = read(join(dir, readme)).match(/^(#{1,3}) *Licen[cs](e|ing)\b.*$[\s\S]*?(?=^#{1,3} |(?![\s\S]))/im);
    if (m) texts.push({ file: `${readme} (licence section)`, text: m[0].trim() });
  }
  return texts;
}

// Walk the tree. Keyed by directory, so two installed versions of one package both appear.
const seen = new Map();
const missing = [];
const top = Object.keys(root.dependencies ?? {});
const queue = [...top, ...Object.keys(root.optionalDependencies ?? {})].map((name) => ({ name, from: ROOT, optional: !top.includes(name) }));
while (queue.length) {
  const { name, from, optional } = queue.shift();
  const dir = locate(name, from);
  if (!dir) { if (!optional) missing.push(name); continue; }
  if (seen.has(dir)) continue;
  const pkg = readJson(join(dir, 'package.json'));
  const licence = licenceOf(pkg);
  seen.set(dir, { name: pkg.name ?? name, version: pkg.version ?? '?', licence, homepage: pkg.homepage ?? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ?? '', texts: licenceTexts(dir, licence) });
  for (const d of Object.keys(pkg.dependencies ?? {})) queue.push({ name: d, from: dir, optional: false });
  for (const d of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: d, from: dir, optional: true });
}
if (missing.length) { console.error(`Not installed: ${[...new Set(missing)].join(', ')}. Run npm install first.`); process.exit(1); }

const pkgs = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));

// Fonts: copyright lines as in each font file's name table (ID 0), which the built woff2 files
// carry; licence URL http://scripts.sil.org/OFL.
const FONTS = [
  { name: 'Fira Sans', copyright: 'Digitized data copyright 2012-2016, The Mozilla Foundation and Telefonica S.A.' },
  { name: 'Fira Code', copyright: 'Copyright 2014-2020 The Fira Code Project Authors (https://github.com/tonsky/FiraCode)' },
  { name: 'Archivo', copyright: 'Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)' },
];

const OFL = `SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects, to support the font creation efforts of academic and linguistic communities, and to provide a free and open framework in which fonts may be shared and improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and redistributed freely as long as they are not sold by themselves. The fonts, including any derivative works, can be bundled, embedded, redistributed and/or sold with any software provided that any reserved names are not used by derivative works. The fonts and derivatives, however, cannot be released under any other type of license. The requirement for fonts to remain under this license does not apply to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright Holder(s) under this license and clearly marked as such. This may include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the copyright statement(s).

"Original Version" refers to the collection of Font Software components as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting, or substituting -- in part or in whole -- any of the components of the Original Version, by changing formats or by porting the Font Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license. These can be included either as stand-alone text files, human-readable headers or in the appropriate machine-readable metadata fields within text or binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted by the corresponding Copyright Holder. This restriction only applies to the primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) and the Author(s) of the Font Software shall not be used to promote, endorse or advertise any Modified Version, except to acknowledge the contribution(s) of the Copyright Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be distributed entirely under this license, and must not be distributed under any other license. The requirement for fonts to remain under this license does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.`;

const RULE = '='.repeat(78);
const out = [
  'THIRD-PARTY NOTICES',
  '',
  `${root.name} ${root.version} includes the open-source software and fonts listed below, each under its own licence.`,
  `Generated by scripts/gen-notices.mjs (npm run notices) from the installed production dependency tree: ${pkgs.length} packages, plus 3 fonts.`,
  'Platform-specific optional packages are those installed where this file was generated.',
  '',
];
const cani = pkgs.find((p) => p.name === 'caniuse-lite');
if (cani) {
  out.push(RULE, 'ATTRIBUTION: caniuse-lite (CC BY 4.0)', RULE, '',
    `caniuse-lite ${cani.version} (https://github.com/browserslist/caniuse-lite) is a compact copy of the Can I Use`,
    'database (https://caniuse.com) by Alexis Deveria, licensed under the Creative Commons Attribution 4.0',
    'International licence (https://creativecommons.org/licenses/by/4.0/). Its full licence text is in the',
    'caniuse-lite entry below.', '');
}
out.push(RULE, 'FONTS: SIL Open Font License 1.1', RULE, '',
  'Self-hosted with the site (downloaded at build time by next/font).', '',
  ...FONTS.map((f) => `${f.name}: ${f.copyright}`), '',
  'These Font Software are licensed under the SIL Open Font License, Version 1.1. This license is copied below, and is also available with a FAQ at: http://scripts.sil.org/OFL', '',
  OFL, '');
const lgpl = pkgs.filter((p) => /LGPL/.test(p.licence));
if (lgpl.length) {
  out.push(RULE, 'LGPL COMPONENTS', RULE, '',
    `${lgpl.map((p) => `${p.name}@${p.version}`).join(', ')} ship prebuilt, unmodified libvips and related libraries,`,
    'loaded dynamically, under the GNU Lesser General Public License v3 (see each package\'s licence section below).',
    'Licence texts: https://www.gnu.org/licenses/lgpl-3.0.txt and https://www.gnu.org/licenses/gpl-3.0.txt.',
    'libvips source: https://github.com/libvips/libvips. You may replace these libraries with your own build.',
    '[TODO: paste the full LGPL-3.0 and GPL-3.0 texts here before distributing, or drop sharp from the deploy.]', '');
}
out.push(RULE, 'PACKAGES', RULE, '', ...pkgs.map((p) => `${p.name}@${p.version}  ${p.licence}`), '');
for (const p of pkgs) {
  out.push(RULE, `${p.name}@${p.version}`, `Licence: ${p.licence}`, ...(p.homepage ? [`Source: ${p.homepage.replace(/^git\+/, '')}`] : []), RULE, '');
  if (!p.texts.length) out.push(`No licence file is included in this package. Licence (from its package.json): ${p.licence}.`, '');
  for (const t of p.texts) out.push(`--- ${t.file} ---`, '', t.text, '');
}
for (const p of [OUT, SUMMARY]) mkdirSync(dirname(p), { recursive: true });
writeFileSync(OUT, out.join('\n'));

const byName = (n) => pkgs.find((p) => p.name === n);
const licences = {};
for (const p of pkgs) licences[p.licence] = (licences[p.licence] ?? 0) + 1;
writeFileSync(SUMMARY, JSON.stringify({
  total: pkgs.length,
  top: top.map((n) => ({ name: n, version: byName(n)?.version ?? '?', licence: byName(n)?.licence ?? '?' })),
  licences: Object.entries(licences).sort((a, b) => b[1] - a[1]).map(([licence, count]) => ({ licence, count })),
}, null, 2) + '\n');

console.log(`Wrote ${OUT} (${pkgs.length} packages, ${(statSync(OUT).size / 1024).toFixed(1)} KiB) and ${SUMMARY}`);
