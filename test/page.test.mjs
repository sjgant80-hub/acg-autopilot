// test/page.test.mjs — the live page's own checks: a self-only security policy with nothing inline, every id the script
// reaches for exists, every button is wired, every anchor resolves, every local file it links exists, and it explains itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const HTML = read('index.html'), APP = read('page/app.mjs'), CSS = read('page/style.css');

test('a self-only security policy, and nothing inline it would have to allow', () => {
  const csp = (HTML.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1];
  assert.ok(csp);
  for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(!/unsafe-/.test(csp));
  for (const [, attrs, body] of HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) { assert.match(attrs, /src="page\/app\.mjs"/); assert.equal(body.trim(), ''); }
  assert.ok(!/\sstyle="/.test(HTML) && !/\son[a-z]+="/i.test(HTML));
  assert.ok(!/fetch\(\s*['"`]https?:/.test(APP), 'fetches nothing off its own origin');
});

test('every id the script uses exists; every button is wired; every anchor and local file resolves', () => {
  const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, id] of APP.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(id), '#' + id);
  for (const [, id] of HTML.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)) assert.ok(APP.includes("$('" + id + "').addEventListener('click'"), '#' + id + ' wired');
  for (const [, a] of HTML.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(a), 'anchor #' + a);
  for (const [, u] of HTML.matchAll(/\s(?:src|href)="([^"#][^"]*)"/g)) if (!/^https:\/\//.test(u)) assert.ok(existsSync(new URL('../' + u, import.meta.url)), u);
  for (const [, u] of APP.matchAll(/from '\.\.\/([^']+)'/g)) assert.ok(existsSync(new URL('../' + u, import.meta.url)), u);
});

test('the page explains itself, and both themes define its colours', () => {
  for (const id of ['what', 'start', 'try', 'record', 'signed', 'portfolio', 'how', 'checks', 'measured', 'blueprint', 'adopt', 'business', 'cost', 'paper', 'faq']) assert.match(HTML, new RegExp('<section id="' + id + '"'), id);
  assert.ok(HTML.includes('<svg viewBox'), 'a diagram');
  for (const h of ['Roll-out', 'Cost, data and ownership', 'Risks, answered straight']) assert.ok(HTML.includes('<h3>' + h + '</h3>'), h);
  const vars = new Set([...CSS.matchAll(/var\((--[a-z]+)\)/g)].map((m) => m[1]));
  for (const block of [CSS.match(/:root\{[^}]+\}/)[0], CSS.match(/:root:not\(\[data-theme="dark"\]\)\{[^}]+\}/)[0]]) for (const v of vars) if (!['--mono', '--sans'].includes(v)) assert.ok(block.includes(v + ':'), v);
});

const RECEIPT = (o) => JSON.parse(read('receipts/organ-' + o + '.json'));
const at = (o, path) => path.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);

test('every number the prose shows is bound to a receipt, and none is typed in', () => {
  const binds = [...HTML.matchAll(/data-r="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(binds.length >= 19, 'the prose numbers are bound');
  for (const b of binds) { const [o, path] = b.split(':'); assert.equal(typeof at(RECEIPT(o), path), 'number', b); }
  // the prose, without the head, the diagram, the record format, code, and the bound numbers themselves
  const prose = HTML.replace(/<head>[\s\S]*?<\/head>/, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<pre[\s\S]*?<\/pre>/g, '')
    .replace(/<(span|td) class="mono">[\s\S]*?<\/\1>/g, ' ').replace(/<span data-r="[^"]+">…<\/span>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\b[Oo]rgans? \d+[a-z]?\b/g, ' ');
  const ALLOWED = {
    '0': 'the share input’s range, 0 to 1, as src/reviewcase.mjs checks it',
    '1': 'the share input’s range, 0 to 1, as src/reviewcase.mjs checks it',
    '12': 'an illustration of how a judgement reads (“entry 12”), not a measurement',
  };
  const typed = [...prose.matchAll(/(?<![A-Za-z0-9.\-])\d[\d,.]*(?![A-Za-z0-9])/g)].map((m) => m[0]).filter((n) => !(n in ALLOWED));
  assert.deepEqual(typed, [], 'numbers typed into the page');
  assert.ok(!HTML.includes('£') && !/\bper seat\b|\bpricing\b|\btier\b/i.test(HTML), 'no prices of ours; money on the page comes from the cost case kernel');
});

test('the blueprint’s gate column is the gate’s receipt, and every kernel is gated in CI', () => {
  const gate = JSON.parse(read('receipts/gate.json')), CI = read('.github/workflows/ci.yml');
  const files = gate.kernels.map((k) => k.file);
  for (const [, f] of HTML.matchAll(/data-gate="([^"]+)"/g)) assert.ok(files.includes(f), f + ' is in receipts/gate.json');
  for (const k of gate.kernels) { assert.ok(CI.includes(k.file), k.file + ' is mutation-tested in ci.yml'); assert.equal(k.killed, k.total, k.file); assert.ok(k.total > 0, k.file); }
  for (const f of readdirSync(new URL('../src/', import.meta.url))) assert.ok(files.includes('src/' + f), 'src/' + f + ' is in the gate');
  assert.ok(gate.tests.count > 0 && gate.tests.passed === gate.tests.count);
});

test('the brochure is on the page: every role, security, roll-out, ownership, risks, the board, the cost case and its sources', () => {
  for (const id of ['business', 'security', 'cost', 'trace', 'c-out', 'c-src']) assert.match(HTML, new RegExp('id="' + id + '"'), id);
  for (const h of ['The chief executive', 'The finance director', 'The operations director', 'The technology and security leads', 'The engineering leads and reviewers', 'Hiring managers', 'Compliance, audit and risk',
    'Security and data protection', 'Roll-out in a business', 'Ownership, support and exit', 'The case for the board', 'How it is worked out', 'Where the figures come from']) assert.ok(HTML.includes('>' + h + '</h3>'), h);
  assert.ok(HTML.includes('Supplied by AI Native Solutions') && HTML.includes('href="https://www.ai-nativesolutions.com"'), 'the supplier, and how to reach them');
  assert.ok(HTML.includes('Powered by the Konomi architecture, created by Thomas Frumkin.'), 'the credit');
  assert.ok(APP.includes("get('data/basis.json')") && APP.includes('reviewCase(BASIS'), 'the cost case is the kernel over the sourced basis');
  assert.ok(HTML.includes('class="wait"') && HTML.includes('class="on"'), 'the diagram says what is built and what waits');
});
