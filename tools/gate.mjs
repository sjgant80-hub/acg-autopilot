#!/usr/bin/env node
// tools/gate.mjs — the receipt of the gate CI runs, so the live page can show it without a number typed in. CI runs the
// tests and then witness (the mutation gate) on every kernel; a kernel with a surviving mutant fails its own step first.
// Each result is added to a run file here, and at the end the run must be exactly receipts/gate.json: the same kernels,
// the same tests, the same number of mutants, every one killed. A kernel that changes changes its mutants, so CI then
// fails and prints the new receipt, to be committed with the change. Nothing here can turn a survivor into a pass.
//   node tools/gate.mjs tests <node-test-output.txt> <run.json>
//   node tools/gate.mjs add <kernel> <tests> <witness-output.json> <run.json>
//   node tools/gate.mjs check <run.json>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const RECEIPT = new URL('../receipts/gate.json', import.meta.url);
const [cmd, ...a] = process.argv.slice(2);
const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { kind: 'acg-autopilot.gate', witness: 'v0.6', tests: null, kernels: [] });
const save = (p, run) => writeFileSync(p, JSON.stringify(run, null, 1) + '\n');

if (cmd === 'tests') {
  const out = readFileSync(a[0], 'utf8'), n = (k) => Number((out.match(new RegExp('^\\S*\\s*' + k + ' (\\d+)$', 'm')) || [])[1]);
  const tests = n('tests'), pass = n('pass'), fail = n('fail');
  if (!(tests > 0) || pass !== tests || fail !== 0) { console.log('the tests did not all pass: ' + tests + ' tests, ' + pass + ' pass, ' + fail + ' fail'); process.exit(1); }
  const run = load(a[1]); run.tests = { count: tests, passed: pass }; save(a[1], run);
  console.log(tests + ' tests, all pass');
} else if (cmd === 'add') {
  const [kernel, tests, wfile, rfile] = a, w = JSON.parse(readFileSync(wfile, 'utf8'));
  if (w.clean !== true || w.killed !== w.total || w.survived.length || (w.ignored || []).length) { console.log(kernel + ': not clean'); process.exit(1); }
  const run = load(rfile); run.kernels.push({ file: kernel, tests, total: w.total, killed: w.killed }); save(rfile, run);
  console.log(kernel + ': ' + w.killed + ' of ' + w.total + ' mutants killed');
} else if (cmd === 'check') {
  const run = load(a[0]), was = JSON.parse(readFileSync(RECEIPT, 'utf8'));
  const same = JSON.stringify({ tests: run.tests, kernels: run.kernels }) === JSON.stringify({ tests: was.tests, kernels: was.kernels });
  if (same) console.log('THE GATE AS THE RECEIPT SAYS · ' + run.tests.count + ' tests · ' + run.kernels.length + ' kernels, ' + run.kernels.reduce((n, k) => n + k.killed, 0) + ' mutants, every one killed');
  else console.log('THE GATE DIFFERS FROM receipts/gate.json — if the change is meant, commit this as receipts/gate.json:\n' + JSON.stringify({ ...was, tests: run.tests, kernels: run.kernels }, null, 1));
  process.exit(same ? 0 : 1);
} else { console.log('node tools/gate.mjs tests | add | check — see the top of the file'); process.exit(2); }
