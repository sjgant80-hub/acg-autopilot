// src/withhold.mjs — organ 7: the withhold list. A file named in .acg/withhold is kept out of .acg: the recorder keeps no
// copy of it, no hash of its bytes and no hash of the tool input that carried it, and the record names it as an artifact
// not stored, so P7 fails at that entry and a reviewer sees that an input was withheld.
//   A line with no '/' matches the name of the file or of any folder on its path; a line with a '/' matches the path from
//   the project's folder (a leading '/' is ignored). '*' is any run of characters but '/', '?' one character but '/',
//   '**' any run including '/'. Letters match regardless of case; a backslash counts as '/'. Blank lines and lines
//   starting with '#' are ignored.
// Pure, total, deterministic: garbage in gives [] or false, never a throw. Sealed in claims/organ-7.json before this file.

const isText = (x) => typeof x === 'string';
const slashed = (s) => s.replace(/\\/g, '/');
const literal = (s) => s.replace(/[.+^${}()|[\]]/g, '\\$&');

/** the list's text → its patterns: each line trimmed (so a CRLF list reads the same); blank lines and '#' comments dropped; anything but text → [] */
export function parseWithhold(text) {
  if (!isText(text)) return [];
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && l[0] !== '#');
}

/** one pattern → { slash, re }, or null for a pattern that is empty once its leading '/' is gone */
function compile(pattern) {
  const p = slashed(pattern).replace(/^\/+/, '');
  if (p === '') return null;
  const re = p.split('**').map((a) => a.split('*').map((b) => b.split('?').map(literal).join('[^/]')).join('[^/]*')).join('.*');
  return { slash: p.includes('/'), re: new RegExp('^' + re + '$', 'is') };
}

/** is this path (relative to the project's folder) withheld by these patterns? anything unreadable → false */
export function withheld(patterns, path) {
  try {
    if (!Array.isArray(patterns) || !isText(path)) return false;
    const p = slashed(path).replace(/^(\.\/)+/, '');
    if (p === '') return false;
    const names = p.split('/');
    for (const pattern of patterns) {
      const c = isText(pattern) ? compile(pattern) : null;
      if (c !== null && (c.slash ? c.re.test(p) : names.some((n) => c.re.test(n)))) return true;
    }
    return false;
  } catch { return false; }
}

export default { parseWithhold, withheld };
