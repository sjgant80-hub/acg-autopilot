# ACG-Assess Autopilot

**Live page: https://sjgant80-hub.github.io/acg-autopilot/** (judge a process record in your browser)

Automated process review for agentic work, built to feed the AI Craftspeople Guild's process-review tool,
acg-assess (Alex's design; its rubric governs, and the checks here are a proposal to align with it).

An agent did a job. This checks **how** it was done: was the intent written down and hashed before the first model
call, were only allowed tools used, were assumptions surfaced, are the final claims backed by evidence, did anything
other than the agent check the result. A separate judge (code, never the agent) reads the job's **process record** and
answers each check with pass, flag or fail, why, and pointers to the evidence. Judgement calls (hidden assumptions,
overclaiming, plain language, the person's direction) can only flag; every flag goes to a human reviewer.

## Run it

```
node --test test/*.test.mjs           # the record and the judge
node tools/measure-1.mjs --check      # organ 1 against its sealed claims, byte for byte
node tools/measure-1b.mjs --check     # organ 1b (P0, well-formed)
```

The judge is pure JavaScript with no dependencies; it runs in Node 20+ and in the browser (the live page imports it).

```js
import { assess } from './src/judge.mjs';
import { factsOf } from './src/record.mjs';
const judgement = assess(record, await factsOf(record));   // { rubric, results: [P0..P10], review, counts }
```

## How it is built

Each organ's claims are committed before its code (`claims/`), measured by a seeded suite (`tools/`), and the result
kept, failures included (`receipts/`). CI re-runs every measurement and mutation-tests the judge and the record
(witness): a test suite that lets a mutant live fails the build.

- `src/record.mjs`: the process record (schema v1), canonical JSON, the intent hash, evidence pointers.
- `src/judge.mjs`: `judge()` is rubric v1 (P1 to P10, as organ 1 measured it); `assess()` is rubric v2 (P0, then P1 to P10).
- `tools/suite.mjs`: clean jobs, one planted failure of each kind, late intents, malformed records.

Organ 1 (the record and the judge) is built and measured. Capture from a live harness, the bridge to acg-assess and
the member portfolio are the next organs. Honest scope: it measures process discipline and evidence, not whether the
work is correct; the planted-failure suite and the judge share an author, so the independent tests are a red team and
a pilot on real guild jobs, neither yet run.

MIT. Supplier and support: AI Native Solutions.
