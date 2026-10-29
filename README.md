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
node tools/measure-1c.mjs --check     # organ 1c (the strict schema)
```

The judge is pure JavaScript with no dependencies; it runs in Node 20+ and in the browser (the live page imports it).

```js
import { assessStrict } from './src/judge.mjs';
import { factsOf } from './src/record.mjs';
const judgement = assessStrict(record, await factsOf(record));   // { rubric, results: [P0..P10], review, counts }
```

## Record a job (organ 2: capture)

In the project you work in, copy `examples/claude-settings.json` to `.claude/settings.json` (or merge its `hooks`), with
the path to `bin/acg.mjs` filled in, and add `.acg/` to `.gitignore`. Nothing is installed globally. Then:

```
node /path/to/acg-autopilot/bin/acg.mjs seal --goal "what the job is for" --allowed Read,Edit --criteria "tests pass"
#   ...run the job in Claude Code: each prompt, tool use and file read or written is appended to .acg/jobs/<session>/log.jsonl
node /path/to/acg-autopilot/bin/acg.mjs note assumption --text "the header row is not data" --surfaced --basis intent
node /path/to/acg-autopilot/bin/acg.mjs claim --id c1 --text "all 40 tests pass" --evidence timeline:12 --criterion "tests pass"
node /path/to/acg-autopilot/bin/acg.mjs verify && node /path/to/acg-autopilot/bin/acg.mjs judge
node /path/to/acg-autopilot/bin/acg.mjs import ~/.claude/projects/<project>/<session>.jsonl --out past-job.json   # a finished job
```

The intent you seal waits as the pending intent and binds to the next job the hook sees, so it is recorded before the
first prompt. Every log line carries the hash of the line before it. The hook never blocks Claude Code and never prints:
an error goes to `.acg/errors.log`. An imported past job sealed no intent, and its record says so ("none sealed"), so it
fails P1.

## Sign a record (organ 3)

```
node /path/to/acg-autopilot/bin/acg.mjs keys                 # this machine's recorder, judge and reviewer keys; private seeds stay in .acg/keys
node /path/to/acg-autopilot/bin/acg.mjs bundle               # the record and its log, signed by the recorder and the judge
node /path/to/acg-autopilot/bin/acg.mjs review --check P2 --decision upheld --note "the assumption was real"
node /path/to/acg-autopilot/bin/acg.mjs verify-bundle .acg/jobs/<job>/bundle.json --trust trust.json
```

The recorder signs the record's hash and where its log ends; the judge signs the judgement's hash; a reviewer signs a
decision on each flagged check. Checking a bundle refuses a log cut short or rewritten with fresh hashes, a judgement
that judging the record again does not give, a signature moved onto another record, and any key not on the trust list.
Ed25519 through WebCrypto, so the browser checks a bundle exactly as Node does.

## How it is built

Each organ's claims are committed before its code (`claims/`), measured by a seeded suite (`tools/`), and the result
kept, failures included (`receipts/`). CI re-runs every measurement and mutation-tests the judge and the record
(witness): a test suite that lets a mutant live fails the build.

- `src/record.mjs`: the process record (schema v1), canonical JSON, the intent hash, evidence pointers.
- `src/judge.mjs`: `judge()` is rubric v1 (P1 to P10, as organ 1 measured it); `assess()` is rubric v2 (P0, then P1 to P10);
  `assessStrict()` is rubric v3, the one to use (the strict P0 of `src/schema.mjs`, then P1 to P10).
- `src/schema.mjs`: schema v1 field by field, each timeline entry's fields typed by its kind.
- `tools/suite.mjs`: clean jobs, one planted failure of each kind, late intents, malformed records.

Organ 1 (the record and the judge) and its follow-ups 1b and 1c (the well-formedness check, then the strict schema) are built and measured; 1c held 4 of 4; capture from Claude Code (organ 2, 6 of 7) and signed records (organ 3, 4 of 5, then 3b 1 of 1) too. The bridge to acg-assess and
the member portfolio are next. Honest scope: it measures process discipline and evidence, not whether the
work is correct; the planted-failure suite and the judge share an author, so the independent tests are a red team and
a pilot on real guild jobs, neither yet run.

MIT. Supplier and support: AI Native Solutions.
