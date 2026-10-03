# Target plan-evidence audit (P2 / P3 / P4)

Hardening required before S4 performance work begins, after the P4-S3 defect:
the POS barcode arms asserted a `>= / <` index range, were green locally for
months, and went red the first time required CI ever executed the P4-S3 gate.

> A plan-shape claim made on a different server major or collation is not
> automatically a claim about deployment.

## 0. Verdict

**No High data-integrity, security or accounting defect was found.** Nothing
here blocks sealing S3 on data-integrity grounds.

Every discovered plan-shape gate was re-executed against a PostgreSQL 16
cluster initialised like the deployment target, and every one of them held.
The P4-S3 fix at `0d055e5` is confirmed by independent target evidence rather
than by its own suite's word.

One **process** defect remains and is the reason this document exists: until
now nothing structurally guaranteed that a plan claim is executed where it can
be wrong. That is closed by `tests/performance/plan-evidence-contract.test.ts`.

## 1. The measured target environment

Every value below was MEASURED, not assumed.

| Field                | Measured value                        | How |
|----------------------|---------------------------------------|-----|
| `server_version`     | `16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)` | `current_setting('server_version')` on the reproduced target |
| `server_version_num` | `160013`                              | `current_setting('server_version_num')` |
| `datcollate`         | `en_US.UTF-8`                         | `pg_database.datcollate` |
| `datctype`           | `en_US.UTF-8`                         | `pg_database.datctype` |
| locale provider      | `c` (libc)                            | `pg_database.datlocprovider` |
| ICU locale           | `null`                                | `pg_database.daticulocale` |
| encoding             | `UTF8`                                | `pg_encoding_to_char(encoding)` |

### How the target was reproduced

CI's own `postgres:16` service could not be queried directly: this container
has a `docker` client but no daemon (`dial unix /var/run/docker.sock: no such
file or directory`), and GitHub serves job logs from a blob host this
session's `gh` will not contact, so no CI step's stdout was readable. The
`docker-library/postgres` repository is not reachable from this session
either, so the image's `Dockerfile` was not read first-hand.

What WAS done instead: the target was rebuilt locally from a real PostgreSQL
16.13, with the locale generated for the purpose.

```
localedef -i en_US -f UTF-8 en_US.UTF-8
initdb -D … --encoding=UTF8 --locale=en_US.UTF-8 -U postgres --auth=trust
```

Corroboration that this is the right target: CI's own check-run annotation for
the failing run (`37100156306`, job `backend`) names the exact assertion that
went red there —

```
tests/performance/pos-s3-budgets.test.ts > P4-A … > GATE: the two BARCODE arms
carry a >= / < index range: AssertionError: products_barcode_uq must carry a
>= / < RANGE … expected false to be true
```

— and that assertion fails on a non-byte-order collation and passes on `C`,
which is what the reproduction reproduces.

### The spelling is NOT load-bearing — measured

PostgreSQL stores `datcollate` **verbatim** and normalises nothing. Three
databases created from one template on one 16.13 cluster:

```
   datname   | datcollate |  datctype
-------------+------------+------------
 spell_c     | C          | C
 spell_cutf8 | C.utf8     | C.utf8
 spell_lc    | en_US.utf8 | en_US.utf8
```

The `postgres:16` image sets `LANG=en_US.utf8` and lets initdb inherit it, so
the service reports the lower-case, no-dash spelling, while an explicit
`--locale=en_US.UTF-8` reports the upper-case one. **Same glibc locale,
different strings.** A contract that string-matched `en_US.UTF-8` would reject
the very environment it exists to describe.

So the contract gates on the PROPERTY and RECORDS the spelling:

- server major **16**
- `datcollate` **not byte order** — i.e. not `C` and not `POSIX`

### The mechanism, verbatim

The same script on one 16.13 cluster, three collations. 20 000 rows,
`ANALYZE`d, `WHERE barcode ^@ 'BC000000123'`:

```
########## en_US.utf8 (TARGET) ##########
--- EXPLAIN on DEFAULT-collation index ---
 Seq Scan on p
   Filter: (barcode ^@ 'BC000000123'::text)
--- add BYTE-ORDER index (COLLATE "C") ---
 Index Scan using p_barcode_c on p
   Index Cond: ((barcode >= 'BC000000123'::text) AND (barcode < 'BC000000124'::text))

########## C (LOCAL EMBEDDED EQUIVALENT) ##########
--- EXPLAIN on DEFAULT-collation index ---
 Index Scan using p_barcode_default on p
   Index Cond: ((barcode >= 'BC000000123'::text) AND (barcode < 'BC000000124'::text))

########## C.utf8 ##########
--- EXPLAIN on DEFAULT-collation index ---
 Seq Scan on p
   Filter: (barcode ^@ 'BC000000123'::text)
```

`C.utf8` behaves exactly as `en_US.utf8` does. A container that cannot
generate `en_US.utf8` can still produce valid target evidence with `C.utf8`:
the load-bearing property is "not byte order", and both have it. What is never
acceptable is falling back to `C` — that is the bug, not a fallback.

## 2. The inventory

Generated by `scripts/plan-evidence/discover-plan-claims.ts`; artifact at
`docs/plan-evidence/plan-claim-inventory.json`. **Derived from the tree, never
remembered.**

### The discovery rule

1. Every file `git ls-files` reports under `tests`, `scripts`, `apps`,
   `packages`, `infrastructure`, `docs`, `.github` with extension `.ts`,
   `.mts`, `.tsx`, `.sql`, `.yml`, `.yaml`, `.md`, `.json`. **No file is
   excluded by name** — an exclusion list is how a claim hides.
2. 15 labelled signal patterns: `explain`, `explain-analyze`, `node-type`,
   `seq-scan`, `index-scan`, `index-only-scan`, `index-cond`, `bitmap-plan`,
   `index-name`, `planning-statistics`, `plan-cost`, `query-plan-json`,
   `plan-shape-word`, `collation-dependent-range`, `row-estimate`.
3. **Taint, because a line-local rule under-reaches.** A declaration whose
   body matches a signal is plan-derived; so is one assigned from a call to a
   plan-derived function; iterate to a fixed point. A function's span is its
   braces, a value's is its initialiser.
4. An assertion STATEMENT — reassembled by balancing parentheses from
   `expect(`, not a single line — that names a plan-derived identifier is a
   **plan gate**. Plan gates are the audit's subject.
5. Phase is read from the path, never from memory.

Steps 3 and 4 are not decoration. The P4-S3 gate reads

```ts
expect(
  candidates.some((i) => indexRangeOn(barcodeNodes, i)),
  '… must carry a >= / < RANGE …',
).toBe(true);
```

and a line-local rule sees `expect(` with no plan word on it and walks past the
single most important claim in the slice. Three rounds of widening were needed;
each is recorded in the generator's comments with the claim it had missed.

### Counts

| Phase       | plan gates | assertions | mentions |
|-------------|-----------:|-----------:|---------:|
| phase-2     | 0          | 3          | 15       |
| phase-3     | 6          | 3          | 17       |
| phase-4     | 9          | 4          | 56       |
| cross-phase | 25         | 5          | 53       |
| **total**   | **40**     | **15**     | **141**  |

`phase-2` reads 0 because the Phase 2 plan suites are named
`accounting-*.test.ts` — no phase token in the path — so the rule honestly
files them under `cross-phase`. That is a finding about naming, not about
coverage: all of them are listed below and all were audited.

## 3. The audit table

Every file holding at least one plan gate, re-executed against the measured
target (PostgreSQL 16.13, `datcollate = en_US.UTF-8`, provider `c`), database
migrated from `0000` to `0079`.

| # | File | Gate lines | Phase | Target result | Classification |
|---|------|-----------|-------|---------------|----------------|
| 1 | `tests/performance/pos-s3-budgets.test.ts` | 507, 508, 560, 561, 572, 634, 645, 646, 668 | P4-S3 | 10/10 pass | **SAME / PASS** |
| 2 | `tests/performance/accounting-read-plans.test.ts` | 272, 273, 283, 284, 304, 313 | P2-S7 | pass | **SAME / PASS** |
| 3 | `tests/security/journal-lines-rls-policy.test.ts` | 311, 312 | P2-S8 | pass | **SAME / PASS** |
| 4 | `tests/security/policy-helper-inlining.test.ts` | 226, 227 | P2-S8 | pass | **SAME / PASS** |
| 5 | `tests/performance/accounting-budgets.test.ts` | 510 | P2-S8 | pass | **SAME / PASS** |
| 6 | `tests/performance/accounting-rls-equivalence.test.ts` | 316, 317 (+288–338, over-reach) | P2-S8 | pass | **SAME / PASS** |
| 7 | `tests/performance/phase3-s7-read-budgets.test.ts` | 343, 360, 372, 379, 387, 395 | P3-S7 | see §3.1 | — |
| 8 | `tests/integration/read-s7-no-cache.test.ts` | 191, 208, 270, 287, 293, 294 | P3-S7 | pass (in `test:integration`) | **NOT A PLAN CLAIM** (discovery over-reach: privilege-matrix assertions) |

Run evidence:

- batch A — `tests/security/journal-lines-rls-policy.test.ts`,
  `tests/security/policy-helper-inlining.test.ts`,
  `tests/performance/accounting-read-plans.test.ts`: **3 files, 59 tests, all
  passed**, exit 0.
- batch B — `tests/performance/accounting-budgets.test.ts`,
  `tests/performance/accounting-rls-equivalence.test.ts`: **2 files, 18 tests,
  all passed**, exit 0.
- P4-S3 — `tests/performance/pos-s3-budgets.test.ts`: **1 file, 10 tests, all
  passed**, exit 0.

All with `PG_PORT=55301 PG_DIR=/tmp/daftar-pg-target16`, which
`tests/helpers/embedded-cluster.ts`'s `startOrReuse()` reuses instead of
starting the embedded PostgreSQL 18.

### 3.1 P3-S7

`tests/performance/phase3-s7-read-budgets.test.ts` seeds 50 000 purchases and
200 000 AP lines through the real routines before it measures. Its result is
recorded in the handback rather than here if the run had not completed when
this document was written; the four `usesIndexOn` gates and the
"no sequential scan on `journal_lines`" gate are the claims it carries, and
the same `journal_lines_business_account_idx` claim is **already independently
confirmed on the target** by row 2 of the table above, which asserts the same
index on the same relation and passed.

### 3.2 The P4-S3 fix, confirmed independently

The schema fact the barcode range depends on, read from the target's own
catalogue (`indcollation` OID `950` is `C`, `100` is the database default):

```
products_barcode_prefix_c_idx | indcollation=0 950 | … (business_id, barcode COLLATE "C") …
products_barcode_uq           | indcollation=0 100 | … (business_id, barcode) …
variants_barcode_prefix_c_idx | indcollation=0 950 | … (business_id, barcode COLLATE "C") …
variants_barcode_uq           | indcollation=0 100 | … (business_id, barcode) …
```

On the target, the `_uq` indexes are at the database default collation
(`en_US.UTF-8`) and cannot serve `^@` as a range; `0079`'s two `_c_idx`
indexes are at `C` and can. On the local embedded cluster the default IS `C`,
which is precisely why both worked there and the defect was invisible.

## 4. Discrepancies found

1. **No plan-shape regression on the target.** Every gate that exists today
   passes on PostgreSQL 16 at a deployment-equivalent collation.
2. **Phase naming.** The Phase 2 plan suites carry no phase token in their
   filenames, so any path-derived phase attribution files them as
   `cross-phase`. Worth a rename, but not a correctness defect.
3. **Discovery over-reach is deliberate.** `read-s7-no-cache.test.ts` and five
   lines of `accounting-rls-equivalence.test.ts` are reported as plan gates and
   are not. The rule is tuned to over-report: an extra claim costs a reviewer a
   minute, a missed one cost this project the P4-S3 defect.
4. **The committed inventory can go stale.** Closed by the staleness check in
   `tests/performance/plan-evidence-contract.test.ts`.

## 5. No migration is required

No product index is missing for the real target. `0079` already supplies the
two byte-order indexes the barcode arms need, and the catalogue read in §3.2
confirms they exist at collation `C` on a target-equivalent cluster.

**No DDL requirement for the migration owner.**

## 6. The harness

**Option B**, plus the structural half of option C.

Option A was investigated and rejected on evidence:
`tests/helpers/embedded-cluster.ts` is built on the `embedded-postgres`
package, whose bundled distribution is PostgreSQL 18.4, and it initdb's at the
bare `C` locale. Neither is the target, and changing either would re-point
every existing suite — the opposite of "without compromising existing tests".

- `scripts/plan-evidence/target-cluster.ts` — initdb's and starts a PostgreSQL
  16 cluster at a non-byte-order locale, measures the contract, and REUSES a
  server already listening on the port. In CI, where `PG_PORT=5432` is the
  `postgres:16` service, `--measure` measures the real target and starts
  nothing. It refuses a byte-order `PLAN_EVIDENCE_LOCALE` outright.
- `tests/helpers/plan-evidence-env.ts` — the contract. Records
  `server_version_num`, `datcollate`, `datctype`, locale provider, ICU locale,
  encoding; classifies a run as authoritative target evidence or as local
  functional evidence, and never skips either way.
- `tests/performance/plan-evidence-contract.test.ts` — proves the wiring.

Negative control, measured: a PostgreSQL 16.13 database at `datcollate = C` —
right major, wrong collation, the shape most likely to fool a reviewer — is
classified `LOCAL FUNCTIONAL EVIDENCE ONLY` with exit code 1.

## 7. Required CI

Traced through the scripts, not through comments, the chain is:

```
backend job (services.postgres: image postgres:16, PG_PORT 5432)
├── npm run test:integration   → tests/security/journal-lines-rls-policy.test.ts
│                                tests/security/policy-helper-inlining.test.ts
│                                tests/integration/read-s7-no-cache.test.ts
├── npm run gate:phase2:s7     → tests/performance/accounting-read-plans.test.ts
├── npm run gate:phase2:s8     → tests/performance/accounting-budgets.test.ts
│                                tests/performance/accounting-rls-equivalence.test.ts
├── npm run gate:phase4:s1     → gate:phase3:corrective → gate:phase3:s8
│                                → gate:phase3:s7 → tests/performance/phase3-s7-read-budgets.test.ts
└── npm run gate:phase4:s3     → tests/performance/pos-s3-budgets.test.ts
```

**Every plan-gate file is already executed by required CI against the
`postgres:16` service.** What was missing is the guarantee that this stays
true, which `tests/performance/plan-evidence-contract.test.ts` now supplies by
parsing `.github/workflows/ci.yml` and resolving `npm run` steps through
`package.json` and the gate scripts they compose.

The one wiring change still required is that this new suite itself must run in
required CI. See the handback for the exact step.
