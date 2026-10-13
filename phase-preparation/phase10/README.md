# Phase 10 preparation — isolated domain code

Status: **PREPARED / NOT PROMOTED.** This directory is deliberately outside every
canonical glob: the repository's `vitest.config.ts` includes `tests/**/*.test.ts`,
its root `tsconfig.json` includes `tests/**`, `scripts/**` and `vitest.config.ts`,
and `workspaces` in `package.json` is an explicit list. So nothing here enters the
required CI estate, the repository typecheck or the lint run until a patch request
moves it — which is what the directive requires of code whose predecessors are not
sealed.

It is pure domain logic: no database, no HTTP, no Nest, no imports from `apps/` or
`packages/`. It answers the questions a restaurant pack can answer without a
cluster, and it answers them against the LIVE sale contract's real constraints.

| File | What it owns |
|---|---|
| `src/split-bill.ts` | even, by-amount and by-line splits that conserve the total exactly, or refuse. **By-amount is `WAITING_FOR_INTEGRATED_SURFACE` (§51): the arithmetic is proven, the settlement path is not** |
| `src/bill-discount.ts` | a whole-bill discount apportioned onto line discounts by largest remainder, because the live sale contract has no order-level discount column |
| `src/table-session-state.ts` | the table session lifecycle, with the settlement fact supplied by the sale authority rather than read here |
| `src/preparation-state.ts` | the kitchen state machine, and the one place that decides whether a cancellation owes a waste movement |
| `src/order-to-sale.ts` | aggregating order lines and priced modifiers into the sale lines the sale authority will accept, and the kitchen's separate view |
| `src/recipe-version.ts` | immutable recipe versions and their deterministic expansion: Q4 quantities, HALF_EVEN scaling, and a refusal rather than a dropped component when one scales to zero (§49) |
| `src/stock-effect.ts` | the three stock-effect modes — direct, service, composed, and no fourth — and the completeness verifier that requires exact-set equality rather than a count (§46, §48) |
| `src/recipe-binding.ts` | the version bound to a line at `queued -> start`, and the readers that may only ever use the bound one |
| `src/aggregate-consumption.ts` | folding one sale line's contributions into one movement per component, on the component's own grain |
| `src/consumption-occasion.ts` | PART 7.7: which single occasion owes a line its stock, replay keyed on the command, one writer, and no valuation |
| `src/waste-expansion.ts` | the exact component set a cancellation wastes, expanded under the line's own bound version |
| `proofs/red-proofs.py` | plants the minimal defect for each law and requires the suite to red AND name the right case |
| `proofs/record-run.py` | runs the six gates as one identified run, derives the handoff's run-identity and digest tables from the log it produced, and `--self-test`s its own gates |

Run from the repository root:

```
npm ci
./node_modules/.bin/prettier --check phase-preparation/phase10
./node_modules/.bin/eslint phase-preparation/phase10 --max-warnings 0
./node_modules/.bin/tsc -p phase-preparation/phase10/tsconfig.json --noEmit
./node_modules/.bin/vitest run --config phase-preparation/phase10/vitest.config.ts
python3 phase-preparation/phase10/proofs/red-proofs.py
python3 phase-preparation/phase10/proofs/record-run.py --self-test
```

The six gates are run together, and the run recorded, with:

```
python3 phase-preparation/phase10/proofs/record-run.py --run --node /path/to/node24/bin/node
```

`--run` exits non-zero if any gate fails, if the tree is dirty when the run
starts, or if it is dirty when the run ends. `package.json` declares
`engines: node >=24 <25`, which is a RANGE: the red-proof harness refuses to
produce evidence below it or above it, and `--check` refuses a log whose
gates resolved anything outside it.

Every line a child process writes is recorded behind a `| ` prefix, and the
parser reads only lines at column 0. That is what stops a test from printing
a line shaped like a recorder line and having it believed; logs written
before that change cannot be verified by the current `--check`, which is
correct, since their cells were parsed from text a child could have written.

A law's red is attributed to the case declared for it by reading that case's
own `status` out of the runner's structured report (`--reporter=json`), never
by searching the runner's text. A test can print anything, including a line
shaped like another test's failure, and vitest forwards a test's own stdout
into the reporter stream — so prose cannot carry an attribution.

The case is identified by the pair the reporter gives, **file and full name**,
at resolution and again at lookup. `fullName` alone is the describe chain plus
the test name, so two files repeating both collapse into one entry and the
law is then credited with a red from a case nobody declared; that was measured
at `e2b8a2a` and it is why the pair is the key. The pair for each law is
DECLARED in `proofs/law-anchors.json`, generated by `--emit-anchors` from a
green baseline and reviewed as a diff: without it the law's case is merely
discovered by containment, and renaming it re-points the law at whatever else
happens to match. A declared title that resolves to no pair, to more than one,
or to a pair other than the one declared for it makes the harness exit 2
before any defect is planted.

`red-proofs.py` runs its own self-test arm at the start of every invocation,
on reporter reports written by hand, so deleting one of those refusals turns
this gate red rather than passing quietly.

The suite's JSON report is written into a fresh temporary directory. That
directory is discoverable from inside the suite; what the harness relies on is
that the runner writes the report **after every test has finished**, so no
test can be the last writer. Making the report read-only was measured not to
be the reason (the attempt ran as root, where a mode cannot deny a write), and
refusal-by-permission under a non-root user is unmeasured. A process outside
the suite is outside what this harness defends against.

`record-run.py --out` defaults to a scratch directory, never the handoff
folder that `--check-digests` guards: the published runs are produced with an
explicit `--out`. Files in that folder which belong to a reviewer are
enumerated by exact name in `REVIEWER_ARTEFACTS`, hashed like everything else
and emitted under their own heading, so the table covers them without
claiming them.

Each gate's two streams are recorded as two labelled blocks, its stdout and
then its stderr under `--- stderr:`. The counts in the run-identity table are
measured from **stdout alone**, and a gate whose output carries more than one
distinct figure for a cell has that cell recorded as ABSENT rather than
resolved in its favour — so a forged figure costs the run its evidence
instead of buying the forger a number.

The design, the laws these modules enforce, and the architectural finding that
gates the whole phase are in the project's shared folder under `phase10/`.
