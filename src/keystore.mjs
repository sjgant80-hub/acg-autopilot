// src/keystore.mjs — organ 4: a private seed kept sealed under a passphrase (claims/organ-4.json). The passphrase is
// stretched with PBKDF2-SHA-256 into an AES-256-GCM key that encrypts the 32-byte seed, with a fresh random salt and
// nonce; the kind, the role and the stretch are bound in as associated data, so a file changed anywhere does not open.
// All through the platform's own WebCrypto, so Node 20+ and a browser seal and open alike. Sealing refuses bad input;
// opening is total: a wrong passphrase, a changed file or garbage is answered with its reason, never thrown.
// It protects a key at rest. It does not protect a key in use, and it cannot reach a hardware key.
import { canonical } from './record.mjs';

export const KIND = 'acg-autopilot.sealed-key/1';
export const ITERATIONS = 600000;                      // the default stretch
export const LIMITS = Object.freeze({ min: 1000, max: 10000000, passphrase: 8 });
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => (typeof h === 'string' && /^([0-9a-f]{2})+$/.test(h) ? Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16)) : null);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
/** is this a stretch a sealed key may have? */
export const strengthOk = (n) => Number.isInteger(n) && n >= LIMITS.min && n <= LIMITS.max;
/** the bytes bound to the sealed seed besides the seed itself */
const boundOf = (s) => new TextEncoder().encode(canonical({ kind: s.kind, role: s.role, kdf: s.kdf, cipher: s.cipher }));

async function keyOf(passphrase, salt, iterations) {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** sealSeed(seed, passphrase, { role, iterations }) → a plain object to keep as a file; no form of the seed is in it */
export async function sealSeed(seed, passphrase, opts) {
  const o = isObj(opts) ? opts : {}, iterations = o.iterations === undefined ? ITERATIONS : o.iterations;
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('a seed is 32 bytes');
  if (typeof passphrase !== 'string' || passphrase.length < LIMITS.passphrase) throw new Error('a passphrase of ' + LIMITS.passphrase + ' characters or more');
  if (!strengthOk(iterations)) throw new Error('iterations: a whole number from ' + LIMITS.min + ' to ' + LIMITS.max);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const s = { kind: KIND, role: typeof o.role === 'string' ? o.role : 'key', kdf: { name: 'PBKDF2-SHA-256', iterations, salt: hex(salt) }, cipher: { name: 'AES-256-GCM', iv: hex(iv) } };
  const sealed = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: boundOf(s) }, await keyOf(passphrase, salt, iterations), seed);
  return { ...s, sealed: hex(new Uint8Array(sealed)) };
}

/** openSeed(sealed, passphrase) → { ok: true, seed } or { ok: false, why } */
export async function openSeed(s, passphrase) {
  try {
    if (!isObj(s) || s.kind !== KIND || typeof s.role !== 'string' || !isObj(s.kdf) || !isObj(s.cipher) || s.kdf.name !== 'PBKDF2-SHA-256' || s.cipher.name !== 'AES-256-GCM') return { ok: false, why: 'not a sealed key' };
    const salt = fromHex(s.kdf.salt), iv = fromHex(s.cipher.iv), sealed = fromHex(s.sealed);
    if (!salt || salt.length !== 16 || !iv || iv.length !== 12 || !sealed || sealed.length !== 48) return { ok: false, why: 'the sealed key is malformed' };
    if (!strengthOk(s.kdf.iterations)) return { ok: false, why: 'the sealed key’s stretch is out of range' };
    if (typeof passphrase !== 'string' || !passphrase) return { ok: false, why: 'no passphrase was given' };
    let seed;
    try { seed = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: boundOf(s) }, await keyOf(passphrase, salt, s.kdf.iterations), sealed)); } catch { return { ok: false, why: 'the passphrase does not open this key, or the file has been changed' }; }
    return { ok: true, seed };
  } catch { return { ok: false, why: 'the sealed key could not be read' }; }
}
