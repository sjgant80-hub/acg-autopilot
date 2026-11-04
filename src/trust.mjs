// src/trust.mjs — organ 4: a trust list that can revoke (claims/organ-4.json).
//   { recorders: [hex], judges: [hex], reviewers: [hex], revoked: [{ key, reason, at }] }
// A revoked key is trusted for nothing, whichever list it is still on, and a bundle it signed is refused saying it was
// revoked. That includes bundles signed before the revocation: a signature carries no time a thief could not also
// write, so such a record must be signed again by a key still trusted. Rotating a role adds its new key and revokes
// the old one. Pure and total: a list that cannot be read trusts nothing.
import { verifyBundle } from './bundle.mjs';

export const ROLES = Object.freeze(['recorders', 'judges', 'reviewers']);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const KEY = /^[0-9a-f]{64}$/;
const keys = (x) => (Array.isArray(x) ? x.filter((k) => typeof k === 'string' && KEY.test(k)) : []);

/** the revoked keys of a trust list: key → { reason, at } (an entry that is not { key, reason, at } of the right types still revokes its key) */
export function revokedOf(trust) {
  const out = new Map();
  for (const r of isObj(trust) && Array.isArray(trust.revoked) ? trust.revoked : []) if (isObj(r) && typeof r.key === 'string' && KEY.test(r.key)) out.set(r.key, { reason: typeof r.reason === 'string' ? r.reason : 'no reason given', at: typeof r.at === 'string' ? r.at : 'no date given' });
  return out;
}

/** the keys a list still trusts: each role's list, less every revoked key */
export function effective(trust) {
  try {
    const t = isObj(trust) ? trust : {}, rev = revokedOf(t);
    return Object.fromEntries(ROLES.map((r) => [r, keys(t[r]).filter((k) => !rev.has(k))]));
  } catch { return Object.fromEntries(ROLES.map((r) => [r, []])); }
}

/** revoke(trust, key, reason, at) → a new list: the key on the revoked list with its reason and date, and on no role */
export function revoke(trust, key, reason, at) {
  if (typeof key !== 'string' || !KEY.test(key)) throw new Error('a key to revoke is 64 hex characters');
  if (typeof reason !== 'string' || !reason.trim() || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new Error('a revocation needs a reason and a date');
  const t = isObj(trust) ? trust : {}, prior = Array.isArray(t.revoked) ? t.revoked.filter((r) => !(isObj(r) && r.key === key)) : [];
  return { ...Object.fromEntries(ROLES.map((r) => [r, keys(t[r]).filter((k) => k !== key)])), revoked: [...prior, { key, reason: reason.trim(), at }] };
}

/** rotate(trust, role, oldKey, newKey, at) → a new list: the new key trusted for the role, the old one revoked as rotated */
export function rotate(trust, role, oldKey, newKey, at) {
  if (!ROLES.includes(role)) throw new Error('a role is one of ' + ROLES.join(', '));
  if (typeof newKey !== 'string' || !KEY.test(newKey) || newKey === oldKey) throw new Error('a new key, 64 hex characters, not the old one');
  const t = revoke(trust, oldKey, 'rotated', at);
  return { ...t, [role]: [...t[role].filter((k) => k !== newKey), newKey] };
}

/** verifyTrusted(bundle, trust) → verifyBundle against the keys still trusted; a signature by a revoked key says so */
export async function verifyTrusted(b, trust) {
  const v = await verifyBundle(b, effective(trust)), rev = revokedOf(trust);
  const sig = (x) => (isObj(b) && isObj(b[x]) ? b[x].by : undefined), by = { recorder: sig('recorded'), judge: sig('judged'), reviewer: sig('reviewed') };
  const said = (p) => {
    const role = p.slice(0, p.indexOf(':')), k = by[role];
    if (p !== role + ': signed by a key not on the trust list' || !rev.has(k)) return p;
    const r = rev.get(k);
    return role + ': signed by a revoked key (' + r.reason + ', ' + r.at + ')';
  };
  return { ok: v.ok, problems: v.problems.map(said) };
}
