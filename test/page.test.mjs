// test/page.test.mjs — the live page's own checks: a self-only security policy with nothing inline, every id the script
// reaches for exists, every button is wired, every anchor resolves, every local file it links exists, and it explains itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

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
  for (const id of ['what', 'start', 'try', 'how', 'checks', 'measured', 'blueprint', 'adopt', 'paper', 'faq']) assert.match(HTML, new RegExp('<section id="' + id + '"'), id);
  assert.ok(HTML.includes('<svg viewBox'), 'a diagram');
  for (const h of ['Roll-out', 'Cost, data and ownership', 'Risks, answered straight']) assert.ok(HTML.includes('<h3>' + h + '</h3>'), h);
  const vars = new Set([...CSS.matchAll(/var\((--[a-z]+)\)/g)].map((m) => m[1]));
  for (const block of [CSS.match(/:root\{[^}]+\}/)[0], CSS.match(/:root:not\(\[data-theme="dark"\]\)\{[^}]+\}/)[0]]) for (const v of vars) if (!['--mono', '--sans'].includes(v)) assert.ok(block.includes(v + ':'), v);
});
