// test/withhold.test.mjs — organ 7's kernel: the withhold list's lines, and which paths it withholds. A name pattern
// matches the file's or any folder's name; a path pattern the path from the project; wildcards stop at '/', '**' does
// not; case and backslashes do not matter; garbage gives [] or false, never a throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import w, { parseWithhold, withheld } from '../src/withhold.mjs';

const yes = (pats, ...paths) => { for (const p of paths) assert.equal(withheld(pats, p), true, JSON.stringify(pats) + ' withholds ' + JSON.stringify(p)); };
const no = (pats, ...paths) => { for (const p of paths) assert.equal(withheld(pats, p), false, JSON.stringify(pats) + ' keeps ' + JSON.stringify(p)); };

test('the list: lines trimmed, blank lines and # comments dropped, CRLF too; anything but text is no list', () => {
  assert.deepEqual(parseWithhold('.env\n  *.pem  \n\n# a comment\n   # indented comment\nsecrets/\r\nid_rsa*\r\n'), ['.env', '*.pem', 'secrets/', 'id_rsa*']);
  assert.deepEqual(parseWithhold(''), []);
  assert.deepEqual(parseWithhold('\n\n  \n#only\n'), []);
  assert.deepEqual(parseWithhold('a#b\n#'), ['a#b'], 'a # inside a line is part of it');
  for (const g of [null, undefined, 3, {}, [], ['a'], true]) assert.deepEqual(parseWithhold(g), [], String(g));
  assert.equal(w.parseWithhold, parseWithhold); assert.equal(w.withheld, withheld);
});

test('a name pattern matches the file’s name or any folder’s name on its path, nothing more', () => {
  yes(['.env'], '.env', 'app/.env', 'a/b/c/.env', './.env', '././app/.env');
  no(['.env'], '.env.local', 'my.env', 'app/.envrc', 'envs/x', 'a.env/b');
  yes(['secrets'], 'secrets/db.json', 'app/secrets/deep/key.txt', 'secrets');
  no(['secrets'], 'my-secrets/db.json', 'secrets.md', 'app/secretsx/a');
  yes(['.env.*'], '.env.local', 'config/.env.production');
  no(['.env.*'], '.env', '.envx');
  yes(['*.pem'], 'server.pem', 'keys/a.b.pem', '.pem');
  no(['*.pem'], 'server.pem.bak', 'pem', 'a.pemx');
});

test('* and ? stop at a folder, ** does not; a path pattern matches from the project’s folder; a leading / is ignored', () => {
  yes(['id_rsa*'], 'id_rsa', 'home/.ssh/id_rsa.pub');
  yes(['?.key'], 'a.key', 'x/b.key'); no(['?.key'], 'ab.key', '.key');
  yes(['config/*.json'], 'config/prod.json'); no(['config/*.json'], 'config/a/prod.json', 'app/config/prod.json', 'config.json');
  yes(['config/**'], 'config/a/b/c.txt', 'config/x'); no(['config/**'], 'app/config/x', 'configx/a');
  yes(['**/deploy/*.yaml'], 'a/deploy/x.yaml', 'a/b/deploy/x.yaml'); no(['**/deploy/*.yaml'], 'deploy/x.yaml');
  yes(['/config/a.txt'], 'config/a.txt'); yes(['//config/a.txt'], 'config/a.txt');
  yes(['config/a.txt'], './config/a.txt'); yes(['app/.env'], '././app/.env');
  yes(['a/**/b'], 'a/x/y/b', 'a/x/b'); no(['a/**/b'], 'a/b');
  yes(['a**b'], 'ab', 'axxb'); no(['a**b'], 'a/x/y/b'); no(['a*b'], 'a/b');
  yes(['a?c'], 'abc'); no(['a?c'], 'a/c', 'ac');
  yes(['***'], 'any/thing'); yes(['**'], 'x', 'a/b/c');
  yes(['a/b'], 'a/b'); no(['a/b'], 'a/b/c', 'x/a/b');
  yes(['**'], 'a\nb'); yes(['a/**'], 'a/x\ny'); no(['a/*'], 'a/x/y');
});

test('case does not matter, a backslash is a slash, and regular-expression characters are only themselves', () => {
  yes(['.ENV'], '.env'); yes(['.env'], 'APP/.ENV'); yes(['Secrets'], 'SECRETS/a');
  yes(['config\\*.json'], 'config/a.json'); yes(['config/*.json'], 'config\\a.json'); yes(['.env'], 'app\\.env'); yes(['\\config\\a'], 'config/a');
  yes(['a.b'], 'a.b'); no(['a.b'], 'axb');
  yes(['a+b'], 'a+b'); no(['a+b'], 'aab');
  yes(['(x)'], '(x)'); no(['(x)'], 'x');
  yes(['[ab]'], '[ab]'); no(['[ab]'], 'a');
  yes(['a$'], 'a$'); no(['a$'], 'a');
  yes(['^a'], '^a'); no(['^a'], 'a');
  yes(['a|b'], 'a|b'); no(['a|b'], 'a', 'b');
  yes(['a{2}'], 'a{2}'); no(['a{2}'], 'aa');
  yes(['a]'], 'a]'); yes(['a}'], 'a}'); yes(['a)'], 'a)');
  yes(['.'], '.'); no(['.'], 'x');
});

test('several patterns: any one is enough; an empty pattern or an empty path withholds nothing', () => {
  yes(['nothing', '*.key', 'zzz'], 'k/a.key');
  no(['nothing', 'zzz'], 'k/a.key');
  no([], '.env');
  no([''], 'a', '', 'dir/'); no(['/'], 'a', 'dir/'); no(['//'], 'x/y', 'x/');
  no(['*'], ''); no(['**'], ''); no(['*'], './'); no(['**'], '././');
  yes(['', '.env'], '.env');
  yes([null, 3, {}, '.env'], '.env');
});

test('garbage gives false, never a throw', () => {
  const hostile = []; Object.defineProperty(hostile, 0, { get() { throw new Error('toxic'); } }); hostile.length = 1;
  for (const [pats, path] of [[null, '.env'], ['.env', '.env'], [{}, '.env'], [['.env'], null], [['.env'], 3], [['.env'], ['.env']], [undefined, undefined], [hostile, '.env'], [['.env'], { toString: () => '.env' }],
    ['x', 'x'], ['*', 'a'], [['.env'], { replace: () => '.env' }], [{ length: 1, 0: '.env' }, '.env']])
    assert.equal(withheld(pats, path), false, 'garbage case');
});

test('the starter list in examples/withhold withholds the common secret files and keeps ordinary ones', () => {
  const list = parseWithhold(readFileSync(new URL('../examples/withhold', import.meta.url), 'utf8'));
  assert.ok(list.length >= 20);
  yes(list, '.env', 'app/.env.local', 'prod.env', 'keys/server.pem', 'tls/a.key', 'client.p12', 'home/.ssh/id_rsa', 'home/.ssh/id_ed25519.pub', '.npmrc', '.aws/credentials', 'gcp/credentials.json', 'prod.tfvars', 'secrets/db.json', '.git-credentials');
  no(list, 'src/app.js', 'README.md', 'docs/envelope.md', 'data/keys.csv', 'notes/environment.txt', 'src/pem-parser.js', 'test/id.test.js', 'package.json');
});
