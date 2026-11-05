// test/egress.test.mjs — what the page says about data leaving the machine, held as a check rather than a sentence: the
// kernels, the command line and the page script import nothing that can open a connection, call nothing that sends, and
// the package has no runtime dependencies. The page's own policy (connect-src 'self') is checked in test/page.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const CODE = [...readdirSync(new URL('../src/', import.meta.url)).map((f) => 'src/' + f), 'bin/acg.mjs', 'page/app.mjs', 'tools/suite.mjs'];   // suite.mjs: the page imports it

test('the recorder, the judge and every kernel import only the platform’s file, path and hash modules, and each other', () => {
  const ALLOWED = new Set(['node:fs', 'node:path', 'node:crypto']);
  for (const f of CODE) {
    for (const [, spec] of read(f).matchAll(/(?:^|\n)\s*import\b[^'"]*?from\s*['"]([^'"]+)['"]/g)) assert.ok(spec.startsWith('./') || spec.startsWith('../') || ALLOWED.has(spec), f + ' imports ' + spec);
    assert.ok(!/\bimport\s*\(/.test(read(f)), f + ': no dynamic import');
    assert.ok(!/\brequire\s*\(/.test(read(f)), f + ': no require');
  }
});

test('nothing in them sends: no fetch beyond the page’s own files, no sockets, beacons or event streams', () => {
  for (const f of CODE) {
    const src = read(f);
    for (const word of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'RTCPeerConnection', 'importScripts']) assert.ok(!src.includes(word), f + ' uses ' + word);
    if (f !== 'page/app.mjs') assert.ok(!/\bfetch\s*\(/.test(src), f + ' calls fetch');
  }
  const app = read('page/app.mjs'), calls = [...app.matchAll(/\bfetch\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.ok(!/https?:|\/\//.test(c), 'the page fetches only its own files: ' + c);
});

test('no runtime dependencies to vet', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) assert.equal(pkg[k], undefined, k);
});
