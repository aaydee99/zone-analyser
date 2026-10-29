import 'server-only';
import crypto from 'node:crypto';

// Minimal OpenPGP (RFC 4880) verifier — just enough to check a detached RSA
// signature over a release's SHA256SUMS against a pinned publisher key:
// armored public key → primary key + subkeys (with subkey-binding check) →
// v4 binary-document signature → RSA PKCS#1 v1.5 verify via node:crypto.

interface Packet { tag: number; body: Buffer }

function packets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let p = 0;
  while (p < buf.length) {
    const hdr = buf[p++];
    if (!(hdr & 0x80)) throw new Error('Invalid OpenPGP packet header');
    let tag: number;
    let len: number;
    if (hdr & 0x40) {
      tag = hdr & 0x3f;
      const o = buf[p++];
      if (o < 192) len = o;
      else if (o < 224) len = ((o - 192) << 8) + buf[p++] + 192;
      else if (o === 255) { len = buf.readUInt32BE(p); p += 4; }
      else throw new Error('Partial-length OpenPGP packets are not supported');
    } else {
      tag = (hdr >> 2) & 0x0f;
      const lt = hdr & 3;
      if (lt === 0) len = buf[p++];
      else if (lt === 1) { len = buf.readUInt16BE(p); p += 2; }
      else if (lt === 2) { len = buf.readUInt32BE(p); p += 4; }
      else throw new Error('Indeterminate-length OpenPGP packets are not supported');
    }
    out.push({ tag, body: buf.subarray(p, p + len) });
    p += len;
  }
  return out;
}

function dearmor(text: string): Buffer {
  const m = /-----BEGIN PGP [A-Z ]+-----\r?\n([\s\S]*?)-----END PGP [A-Z ]+-----/.exec(text);
  if (!m) throw new Error('Not an armored OpenPGP block');
  const lines = m[1].split(/\r?\n/);
  const blank = lines.findIndex((l) => l.trim() === '');
  const data = lines.slice(blank + 1).filter((l) => l && !l.startsWith('='));
  return Buffer.from(data.join(''), 'base64');
}

function mpi(buf: Buffer, at: number): [Buffer, number] {
  const bits = buf.readUInt16BE(at);
  const bytes = Math.ceil(bits / 8);
  return [buf.subarray(at + 2, at + 2 + bytes), at + 2 + bytes];
}

interface RsaKey { fingerprint: string; keyId: string; body: Buffer; key: crypto.KeyObject }

function rsaKey(body: Buffer): RsaKey | null {
  if (body[0] !== 4 || body[5] !== 1 && body[5] !== 3) return null; // v4, RSA (encrypt+sign or sign-only)
  const [n, p] = mpi(body, 6);
  const [e] = mpi(body, p);
  const hdr = Buffer.from([0x99, (body.length >> 8) & 0xff, body.length & 0xff]);
  const fingerprint = crypto.createHash('sha1').update(hdr).update(body).digest('hex').toUpperCase();
  const key = crypto.createPublicKey({ key: { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') }, format: 'jwk' });
  return { fingerprint, keyId: fingerprint.slice(-16), body, key };
}

const HASHES: Record<number, string> = { 2: 'sha1', 8: 'sha256', 9: 'sha384', 10: 'sha512', 11: 'sha224' };

interface Sig { type: number; hash: string; hashedPart: Buffer; issuer: string | null; value: Buffer }

function parseSig(body: Buffer): Sig {
  if (body[0] !== 4) throw new Error('Only v4 OpenPGP signatures are supported');
  const type = body[1];
  if (body[2] !== 1 && body[2] !== 3) throw new Error('Only RSA signatures are supported');
  const hash = HASHES[body[3]];
  if (!hash || hash === 'sha1') throw new Error('Unsupported or weak signature hash');
  const hashedLen = body.readUInt16BE(4);
  const hashedPart = body.subarray(0, 6 + hashedLen);
  const unhashedLen = body.readUInt16BE(6 + hashedLen);
  const subs = [body.subarray(6, 6 + hashedLen), body.subarray(8 + hashedLen, 8 + hashedLen + unhashedLen)];
  let issuer: string | null = null;
  for (const area of subs) {
    for (let p = 0; p < area.length;) {
      let len = area[p++];
      if (len >= 192 && len < 255) len = ((len - 192) << 8) + area[p++] + 192;
      else if (len === 255) { len = area.readUInt32BE(p); p += 4; }
      const st = area[p] & 0x7f;
      const data = area.subarray(p + 1, p + len);
      if (st === 16) issuer = data.toString('hex').toUpperCase();
      if (st === 33 && data[0] === 4) issuer = data.subarray(1).toString('hex').toUpperCase().slice(-16);
      p += len;
    }
  }
  const after = 8 + hashedLen + unhashedLen + 2; // skip the 2-byte hash prefix
  const [value] = mpi(body, after);
  return { type, hash, hashedPart, issuer, value };
}

function verifyWith(key: RsaKey, sig: Sig, signedData: Buffer): boolean {
  const trailer = Buffer.alloc(6);
  trailer[0] = 4; trailer[1] = 0xff; trailer.writeUInt32BE(sig.hashedPart.length, 2);
  const modLen = Math.ceil((key.key.asymmetricKeyDetails?.modulusLength ?? 0) / 8);
  const value = sig.value.length < modLen ? Buffer.concat([Buffer.alloc(modLen - sig.value.length), sig.value]) : sig.value;
  return crypto.verify(sig.hash, Buffer.concat([signedData, sig.hashedPart, trailer]), key.key, value);
}

const keyHashInput = (k: RsaKey) => Buffer.concat([Buffer.from([0x99, (k.body.length >> 8) & 0xff, k.body.length & 0xff]), k.body]);

/**
 * Verifies a detached binary signature over `data`. The armored key must have the
 * pinned primary fingerprint; the signature may come from the primary key or from a
 * subkey that the primary key has certified (subkey binding signature).
 */
export function verifyDetached(armoredKey: string, pinnedFingerprint: string, signature: Buffer, data: Buffer) {
  const pkts = packets(dearmor(armoredKey));
  const primaryPkt = pkts.find((p) => p.tag === 6);
  const primary = primaryPkt ? rsaKey(primaryPkt.body) : null;
  const pin = pinnedFingerprint.replace(/\s+/g, '').toUpperCase();
  if (!primary || primary.fingerprint !== pin) {
    throw new Error(`Publisher key fingerprint ${primary?.fingerprint ?? 'unknown'} does not match the pinned ${pin}`);
  }
  const signers = new Map<string, RsaKey>([[primary.keyId, primary]]);
  for (let i = 0; i < pkts.length; i++) {
    if (pkts[i].tag !== 14) continue;
    const sub = rsaKey(pkts[i].body);
    const binding = pkts[i + 1]?.tag === 2 ? parseSig(pkts[i + 1].body) : null;
    if (sub && binding && binding.type === 0x18 && verifyWith(primary, binding, Buffer.concat([keyHashInput(primary), keyHashInput(sub)]))) {
      signers.set(sub.keyId, sub);
    }
  }

  const sigPkt = packets(signature).find((p) => p.tag === 2);
  if (!sigPkt) throw new Error('No signature packet found');
  const sig = parseSig(sigPkt.body);
  if (sig.type !== 0x00) throw new Error('Not a binary-document signature');
  const signer = sig.issuer ? signers.get(sig.issuer) : undefined;
  if (!signer) throw new Error(`Signature was made by key ${sig.issuer ?? 'unknown'}, which is not a certified HashiCorp key`);
  if (!verifyWith(signer, sig, data)) throw new Error('Signature does not match the published checksums');
  return signer.keyId;
}
