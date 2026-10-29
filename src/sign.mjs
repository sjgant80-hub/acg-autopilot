// src/sign.mjs — organ 3: Ed25519 signatures through the platform's own WebCrypto, so Node 20+ and a browser sign and
// verify alike. A signed object is { kind, payload, by, sig }: `by` the signer's public key (hex), `sig` over a message
// that names its kind, so a signature for one purpose can never be passed off as another. A private key stays a
// CryptoKey that cannot be exported; it is never part of anything signed. Total: a bad input is refused, never thrown.
import { canonical } from './record.mjs';

const PKCS8_PREFIX = '302e020100300506032b657004220420';
const ALG = { name: 'Ed25519' };
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => (typeof h === 'string' && /^([0-9a-f]{2})*$/.test(h) ? Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16)) : null);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const KINDS = Object.freeze(['recorded', 'judged', 'reviewed']);

/** the exact bytes a signature covers */
export const message = (kind, payload) => new TextEncoder().encode('acg-autopilot/' + kind + '/v1|' + canonical(payload));

/** a signer from a 32-byte seed: { publicHex, sign(bytes) }; the private key is not extractable */
export async function signerFromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('a seed is 32 bytes');
  const pk = await globalThis.crypto.subtle.importKey('pkcs8', Uint8Array.from([...fromHex(PKCS8_PREFIX), ...seed]), ALG, true, ['sign']);
  const x = (await globalThis.crypto.subtle.exportKey('jwk', pk)).x, publicHex = hex(Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0)));
  const key = await globalThis.crypto.subtle.importKey('pkcs8', Uint8Array.from([...fromHex(PKCS8_PREFIX), ...seed]), ALG, false, ['sign']);
  return { publicHex, sign: async (bytes) => hex(new Uint8Array(await globalThis.crypto.subtle.sign(ALG, key, bytes))) };
}

/** sign a payload for one purpose */
export async function signAs(signer, kind, payload) {
  if (!KINDS.includes(kind)) throw new Error('not a kind of signature: ' + kind);
  return { kind, payload, by: signer.publicHex, sig: await signer.sign(message(kind, payload)) };
}

/** verifySigned(s, kind, trusted) → { ok, why }: the shape, the kind, a key on the trust list, and the signature */
export async function verifySigned(s, kind, trusted) {
  if (!isObj(s) || s.kind !== kind) return { ok: false, why: 'not a ' + kind + ' signature' };
  if (!Array.isArray(trusted) || !trusted.includes(s.by)) return { ok: false, why: 'signed by a key not on the trust list' };
  const pub = fromHex(s.by), sig = fromHex(s.sig);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return { ok: false, why: 'the key or the signature is malformed' };
  try {
    const key = await globalThis.crypto.subtle.importKey('raw', pub, ALG, false, ['verify']);
    return (await globalThis.crypto.subtle.verify(ALG, key, sig, message(kind, s.payload))) ? { ok: true, why: 'signed by a trusted key' } : { ok: false, why: 'the signature does not verify' };
  } catch { return { ok: false, why: 'the signature could not be checked' }; }
}
