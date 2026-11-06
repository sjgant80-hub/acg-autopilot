# ACG-Assess Autopilot

**Live page: https://sjgant80-hub.github.io/acg-autopilot/** (judge a process record in your browser)

Automated process review for agentic work, built to feed the AI Craftspeople Guild's process-review tool,
acg-assess (Alex's design; its rubric governs, and the checks here are a proposal to align with it). Any team that runs
AI agents can use it on its own work: the live page carries the case for a business, with a cost case worked out from
sourced figures and the reader's own numbers.

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
node tools/measure-3.mjs --check      # organ 3 (signed records; F5 needs the real transcripts and is local)
node tools/measure-3b.mjs --check     # organ 3b (a false judgement refused)
node tools/measure-4.mjs --check      # organ 4 (key care)
node tools/measure-5.mjs --check      # organ 5 (the member's portfolio)
node tools/measure-6.mjs --check      # organ 6 (Gemini CLI import; the real sessions are local: --local)
node tools/measure-6b.mjs --check     # organ 6b (a job with no model call is not imported)
node tools/measure-7.mjs --check      # organ 7 (the withhold list: secret files kept out of .acg)
```

CI also runs witness, the mutation gate, on every kernel in `src/`, and checks the run against `receipts/gate.json`
(the numbers the page's blueprint shows).

The judge is pure JavaScript with no dependencies; it runs in Node 20+ and in the browser (the live page imports it).

```js
import { assessStrict } from './src/judge.mjs';
import { factsOf } from './src/record.mjs';
const judgement = assessStrict(record, await factsOf(record));   // { rubric, results: [P0..P10], review, counts }
```

## Record a job (organ 2: capture)

In the project you work in, copy `examples/claude-settings.json` to `.claude/settings.json` (or merge its `hooks` and
`permissions`), with the path to `bin/acg.mjs` filled in, and add `.acg/` to `.gitignore`. Nothing is installed
globally. Install it from a commit you have read, outside the project, and keep it pinned: the hook runs this code on
every tool use. Then:

```
node /path/to/acg-autopilot/bin/acg.mjs seal --goal "what the job is for" --allowed Read,Edit --criteria "tests pass"
#   ...run the job in Claude Code: each prompt, tool use and file read or written is appended to .acg/jobs/<session>/log.jsonl
node /path/to/acg-autopilot/bin/acg.mjs note assumption --text "the header row is not data" --surfaced --basis intent
node /path/to/acg-autopilot/bin/acg.mjs claim --id c1 --text "all 40 tests pass" --evidence timeline:12 --criterion "tests pass"
node /path/to/acg-autopilot/bin/acg.mjs verify && node /path/to/acg-autopilot/bin/acg.mjs judge
node /path/to/acg-autopilot/bin/acg.mjs import ~/.claude/projects/<project>/<session>.jsonl --out past-job.json   # a finished job
node /path/to/acg-autopilot/bin/acg.mjs import ~/.gemini/tmp/<project>/chats/<session>.jsonl --harness gemini --out past-job.json   # a finished Gemini CLI job (organ 6)
```

The intent you seal waits as the pending intent and binds to the next job the hook sees, so it is recorded before the
first prompt. Every log line carries the hash of the line before it. The hook never blocks Claude Code and never prints:
an error goes to `.acg/errors.log`. An imported past job sealed no intent, and its record says so ("none sealed"), so it
fails P1. Either import refuses a job with no model call (organ 6b): there is nothing to judge, and P1 would pass on
nothing.

The agent works beside its own record. Until a job is bundled, `.acg` is a folder on the agent's machine, written as
the same user; the chain and the signatures catch a change made after bundling, not an agent rewriting its own log
while the job runs. So the example settings also deny Claude Code's own file tools reading or editing `.acg`
(`Read(./.acg/**)`, `Edit(./.acg/**)`; `test/settings.test.mjs` keeps them there). By Claude Code's documentation those
rules cover its file tools, the shell file commands it recognises and shell redirections, not a script that opens files
itself. For a line the operating system holds, turn on Claude Code's sandbox (macOS, Linux, WSL2) with
`sandbox.filesystem.denyWrite` on the record's folder: hooks run outside the sandbox, so the recorder still writes, but
the agent's own `acg note` and `acg claim` then cannot, and the person adds them. Keep the keys sealed and set
`ACG_PASSPHRASE` only on the command that signs, never in the environment Claude Code starts from: the hook never signs,
and an agent without the passphrase cannot sign a rewritten log. Bundle each job when it ends.

## Keep secrets out of the record (organ 7)

Without a list, the recorder copies every file the agent reads or writes into `.acg`, secret files included. Copy the
starter list of common secret files into the project's `.acg/withhold` and add your own:

```
cp /path/to/acg-autopilot/examples/withhold .acg/withhold
```

A file on the list is recorded by name only: no copy in `.acg`, no hash of its bytes, no hash of the tool input that
carried it. The record lists it as an artifact not stored, so the job's P7 fails at that file and a reviewer sees that an
input was withheld. A line with no `/` matches a file's or folder's name anywhere; a line with a `/` matches the path
from the project; `*` and `?` stop at a folder, `**` does not; case and backslashes do not matter; `#` starts a
comment. A list that cannot be read withholds every file and says so in `.acg/errors.log`. It keeps a secret out of
the record; it does not stop the agent reading the file. Measured over 50 jobs through the real command line
(`receipts/organ-7.json`): nothing of any withheld file found under `.acg`, while the same search found every one with no
list.

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

## Key care (organ 4)

```
ACG_PASSPHRASE='…' node /path/to/acg-autopilot/bin/acg.mjs keys         # new keys sealed under the passphrase; no plain seed written
ACG_PASSPHRASE='…' node /path/to/acg-autopilot/bin/acg.mjs keys --seal  # seal plain keys made earlier, same public keys
node /path/to/acg-autopilot/bin/acg.mjs revoke --key <hex> --reason "stolen laptop"   # every bundle it signed is refused
node /path/to/acg-autopilot/bin/acg.mjs rotate --role recorder         # a new key for the role; the old one revoked as rotated
```

A sealed key is the seed encrypted with AES-256-GCM under a key stretched from the passphrase (PBKDF2-SHA-256, 600,000
rounds by default), with a fresh salt and nonce; a wrong passphrase or a changed file does not open it. A revoked key is
trusted for nothing, and `verify-bundle` names it as revoked. It protects keys at rest, not in use, and it cannot use a
hardware key.

## A member's portfolio (organ 5)

```
node /path/to/acg-autopilot/bin/acg.mjs portfolio --member ana --include all --reveal <job>   # or --include job1,job2
node /path/to/acg-autopilot/bin/acg.mjs check-portfolio portfolio.json --trust trust.json      # exit code 2 when refused
```

The judge checks each signed bundle in full and then attests it, signing only what a portfolio shows: the record's
hash, the job, the member's pseudonymous id, the rubric, each check's outcome, the review queue, each reviewer decision
as upheld or overturned (never its note), and the recorder's and reviewer's public keys. A portfolio holds only the jobs
its member names, and the full bundle only for the jobs they reveal; its scores are counts (each check's pass, flag and
fail; flags upheld, overturned and undecided; for each habit the spec names, the jobs that kept it). Anyone with the
trust list checks it without the records, and judges each revealed job again. Trust only a judge key the member does not hold (the guild's, or your team's): on one
machine `acg keys` makes all three keys, and a portfolio attested by the member's own judge key proves only what they
say. It shows what its member chose: it cannot prove nothing was left out, it does not tie the pseudonym to a person, and it shows no change over time, because
a signature carries no time the member could not also write.

## How it is built

Each organ's claims are committed before its code (`claims/`), measured by a seeded suite (`tools/`), and the result
kept, failures included (`receipts/`). CI re-runs every measurement and mutation-tests the judge and the record
(witness): a test suite that lets a mutant live fails the build.

- `src/record.mjs`: the process record (schema v1), canonical JSON, the intent hash, evidence pointers.
- `src/judge.mjs`: `judge()` is rubric v1 (P1 to P10, as organ 1 measured it); `assess()` is rubric v2 (P0, then P1 to P10);
  `assessStrict()` is rubric v3, the one to use (the strict P0 of `src/schema.mjs`, then P1 to P10).
- `src/schema.mjs`: schema v1 field by field, each timeline entry's fields typed by its kind.
- `src/log.mjs`, `src/normalise.mjs`, `src/transcript.mjs`, `bin/acg.mjs`: capture (organ 2): the hash-chained log, the
  record from the log, a past transcript imported, the command line and the hook.
- `src/gemini.mjs`: a second harness (organ 6): a finished Gemini CLI session imported as a record.
- `src/withhold.mjs`, `examples/withhold`: the withhold list (organ 7): which files the recorder keeps out of `.acg`.
- `src/sign.mjs`, `src/bundle.mjs`: signed records (organ 3).
- `src/keystore.mjs`, `src/trust.mjs`: key care (organ 4): sealed keys, revocation, rotation.
- `src/portfolio.mjs`: the member's portfolio (organ 5): the judge's attestation, the portfolio of the jobs a member chose, the check an employer runs.
- `src/reviewcase.mjs`, `data/basis.json`: the page's cost case, every external figure from the sourced basis, the reader's
  set-up hours and the weeks the saving takes to pay them back.
- `test/egress.test.mjs`: the kernels, the command line and the page import nothing that can open a connection, and the
  package has no runtime dependencies.
- `examples/claude-settings.json`, `test/settings.test.mjs`: the per-project hook settings to copy, and the check that
  they run the recorder on every event its hook reads and deny Claude Code's file tools the `.acg` folder.
- `tools/suite.mjs`: clean jobs, one planted failure of each kind, late intents, malformed records.
- `tools/gate.mjs`, `receipts/gate.json`: the gate's own receipt, checked by CI.

Built and measured: organ 1 (the record and the judge) and its follow-ups 1b and 1c (the well-formedness check, then the
strict schema), capture from Claude Code (organ 2), signed records (organ 3, then 3b), key care (organ 4), the member's portfolio (organ 5), a second harness, Gemini CLI, by import (organ 6), and the withhold list (organ 7); the receipts hold every
result, failures included. Waiting: the bridge into acg-assess (it needs acg-assess's record format). Honest scope: it measures process discipline and evidence, not whether the work is correct; the
planted-failure suite and the judge share an author, so the independent tests are a red team and a pilot on real guild
jobs, neither yet run.

MIT. Supplied by AI Native Solutions (https://www.ai-nativesolutions.com); support, service levels, warranty and liability
are agreed per deployment, and it keeps running without us. Powered by the Konomi architecture, created by Thomas Frumkin.
