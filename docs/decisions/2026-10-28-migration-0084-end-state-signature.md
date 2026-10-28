# `0084`'s end-state signature assertion, and the class behind it

Card **MIG-0084-E1**, 2026-10-28. Branch `p4/mig-0084-e1-signature`, over
`8eed1de6f61cc54842b606929ecb1d5f2347d788`.

Digests below name their hash function. A git object id and a SHA-256 of the
same blob's contents are different numbers for the same bytes, and reading one
against the other has already been mistaken for a contradiction in this
repository.

## 1. The defect

`0084` creates the set-based receivables reader with **eight** result columns:

```sql
CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_ids UUID[])
RETURNS TABLE (invoice_id UUID, paid_txn_minor BIGINT, paid_base_minor BIGINT,
               outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT,
               currency_code TEXT, due_date DATE, issue_date DATE)
```

and its own end-state block `0084-E(1)` compared the live catalogue against a
literal carrying **seven**:

```sql
IS DISTINCT FROM 'TABLE(invoice_id uuid, paid_txn_minor bigint, paid_base_minor bigint,
  outstanding_txn_minor bigint, outstanding_base_minor bigint, currency_code text, due_date date)'
```

The `DO $post$` block is unconditional, so the comparison was always true and
the migration raised `selling.migration_end_state_invalid` **on itself**.
`0000 → latest` could not complete on this lineage.

## 2. It is older than this card, and where it came from

Measured with `git log -S`, not relayed:

- `f8a9ed46` — the DR-13 / DR-14 / C-1 Q-1 commit — appended `issue_date DATE`
  to the `CREATE`. It changed `0084` by **+20/−3** and touched **zero**
  `IS DISTINCT FROM 'TABLE('` literals, in this file or any other.
- This **corrects the account the card was given.** The card's corroboration
  was that the sibling assertion for `customer_open_invoices_page` "*was*
  updated" and does carry `issue_date date`. It was never updated: that
  literal has carried `issue_date date` since the original authoring commit
  `168675b3`, because that routine's second result column always was
  `issue_date`. It was born right rather than brought into line.
- The conclusion survives on a stronger footing. The commit that moved a
  signature updated **neither** of the two literals that pin it, and the
  second of those is in a different file (§4).

So: a half-finished edit, older than this card, and **not attributed to it**.

## 3. The repair

The missing `issue_date date`, appended to E(1)'s expected literal. The
`CREATE` is untouched, no column is dropped, the assertion stays exact and
positional, and the `DO` block stays unconditional — its worth is precisely
that it cannot be satisfied by a near miss.

Two further strings moved with it, because they counted the appended columns
and would otherwise describe the check beside them wrongly: the exception
message now says "three appended columns", and so does the comment above the
block.

`0084` is a **candidate** migration (`frozenThrough` is `0079`), so amending it
in place is what DR-03 and DR-56 permit.

### What did not move, each measured

| Invariant | Measured |
| --- | --- |
| The six `$fn$` body digests (SHA-256 of each body's own text) | `d3bf197f…` `ed8e657a…` `0eddaab0…` `9c3d304e…` `9c496f40…` `dd9294e1…` — **identical** before and after. The edit is inside `DO $post$`, not inside any body. |
| `scripts/guards/p4s7-body-digests.ts --dr13` | exit **0**, `P4S7 DR-13 BODY LAW: PASS`, both GREEN and RED arms printed |
| `check:migrations` | exit **0**, "80 frozen migrations verified (frozen through `0079_phase4_pos_till_sessions_cart.sql`)" |
| `0084` non-comment line **count** | **443 → 443**: unchanged. Two non-comment lines changed in content, one comment line. +21 bytes. |
| `0084` total lines | 1309 → 1309 |
| `phase4-s1-gate.ts --structural-only` | exit **0**, `P4-S1 GATE: PASS (structural checks only)` |
| `phase4-gate.ts --prove-red` | exit **0**, "119 of 119 caught by name", `MISSED` occurrences **0** |

## 4. The second instance, and the ownership expansion

With `0084` repaired, a fresh `0000 → latest` reached `0084`, **applied it**,
and then died on `0085`:

> `selling.migration_end_state_invalid: the live set-based invoice_outstanding
> is not 0084's seven-column form (found TABLE(…, due_date date, issue_date
> date)), so 0085 is not applying on the 0084 head`

That pre-condition is right about its purpose and wrong about the number: the
`0084` head it tests for is now eight columns. `0085` was last touched by its
own authoring commit `f2b7d7ae`, so the literal was never revisited, and no
open branch touches `0085` (measured across every Phase 4 branch).

**This card's ownership is `0084` only.** The fix to `0085` is an expansion,
taken on the coordinator's amendment §2 — "do not fix it inside this card
unless it is the same single-string class" — and it is that class exactly: one
literal left stale by the same commit. It is kept in a **separate commit**
(`bab792f3`) so it can be reverted alone, leaving the `0084` repair and the law
intact. `0085`'s non-comment line count is unchanged at 608 and no `CREATE` in
it is touched.

## 5. The law, and what it does not guarantee

`tests/guards/mig-0084-end-state-signature-law.test.ts`. One corrected string
leaves the next half-finished edit free to do this again; what let this one
live a whole card's lifetime is that **nothing compared the two halves of the
file to each other**.

There are **four** `pg_get_function_result(to_regprocedure(…)) IS DISTINCT FROM
'TABLE(…)'` assertions in `0084` — not two. One is a **pre-condition** inside
`DO $pre$` (lines 390–468), which asserts the *prior*, five-column `0083`
shape and by design must **not** match what the file creates. Three are
**end-state** assertions inside `DO $post$` (1061–1308), for
`invoice_outstanding(uuid, uuid[])`, `invoice_outstanding(uuid, uuid)` and
`customer_open_invoices_page(uuid, uuid, date, uuid, integer)`. Of those three,
two agreed with their `CREATE` and one did not.

The law:

1. finds both `DO` blocks and fails if either is missing, since nothing below
   would mean anything;
2. pins the inventory **exactly** — one in `$pre$`, three in `$post$`, none
   elsewhere, none with a routine name it cannot read. A floor catches deletion
   and lets a silent addition through; an exact pin makes adding an assertion
   an edit to this law, which is the moment a human checks it;
3. compares every end-state assertion's literal against the signature the same
   file creates, **column name by column name and type by type, in order**,
   reporting the routine, both lists and both line numbers;
4. treats an end-state assertion about a routine the file does **not** create
   as a finding, not a row to skip. The skip-list is pinned **empty**, so
   adding one requires writing a reason;
5. requires the `$pre$` assertion to **differ** from what the file creates.

**Normalisation.** `pg_get_function_result` renders lowercase, canonicalised
type names; the `CREATE` is upper case. The normalisation lowercases, collapses
whitespace runs, and removes space around commas — and performs **no type
mapping at all**. It therefore **preserves every type distinction**: `date` is
not `timestamptz`, `bigint` is not `integer`, `uuid[]` is not `uuid`. The price
is that it cannot read a spelling that is not already canonical — `timestamptz`
prints as `timestamp with time zone`, `int8` as `bigint`, `varchar` as
`character varying` — so it **fails closed** on any type token outside a pinned
list of self-canonical names, and says which token.

**What it does not guarantee.** It compares the file **to itself**. It says
nothing about the live catalogue — not that the routine exists, not what shape
it really has. It says nothing about whether `0084` applies. And it reads
**`0084` only**: the second instance of this very class, in `0085`, would not
have been caught by it, and a third would not be either. A law over every
candidate migration's signature literals — end-state *and* pre-condition — is a
**separate card**, named here so it is not mistaken for covered.

**Also found and deliberately not changed:** E(1)'s `FOREACH` loop checks the
routine's definition text for `'currency_code', 'due_date'` and does not
mention `'issue_date'`. That is a weaker-than-sibling check, not a
contradiction — it cannot make the migration fail wrongly — and it is outside
the stated repair. Reported, not fixed.

## 6. Red first, and the controls

Every mutation was proved applied — the file's SHA-256 changed and the
substitution matched exactly one site — **before** its result was read. A
substitution that matches nothing is a control that did not run, not a control
that passed. Each was restored byte-for-byte afterwards (SHA-256 equal to the
committed blob, `git status --porcelain` empty).

**Red first, statically.** On the tree before the fix the law exits **1**,
`mig84_5` fails, and it names `invoice_outstanding(uuid, uuid[])`, the missing
`issue_date date`, and both line numbers — the assertion at `0084:1076` and the
`CREATE` at `0084:593`. The other six cases pass, so the failure is a measured
disagreement and not a suite that would not load.

**Red first, live.** See §7.

| Control | Law exit | Case(s) red by name |
| --- | --- | --- |
| c1 E(1) back to seven columns | 1 | `mig84_5` |
| c2 a ninth column on the `CREATE`, E(1) untouched | 1 | `mig84_5` (drift in the *other* direction) |
| c3 two columns reordered in E(1), same set | 1 | `mig84_5` (so the law is positional too) |
| c4a `date` → `timestamptz` in E(1) | 1 | `mig84_3`, `mig84_5` (fails closed on the spelling *and* mismatches) |
| c4b `date` → `integer` in E(1) | 1 | `mig84_5` (both self-canonical: a pure positional type mismatch) |
| c6 the `$pre$` literal made equal to the `CREATE` | 1 | `mig84_6` |
| c7 one end-state assertion put out of sight | 1 | `mig84_2` |
| c8 an end-state assertion about a routine this file does not create | 1 | `mig84_4`, `mig84_5` |
| c9 `TEXT` → `VARCHAR` on the `CREATE` side | 1 | `mig84_3`, `mig84_5` |
| c11 `DO $post$` renamed | 1 | `mig84_0`, `mig84_2` |
| **c5 / c10 the clean tree — positive control** | **0** | none, **7 passed (7)** |

Each substantive case has a plant that reddens it by name: `mig84_0` ← c11,
`mig84_2` ← c7, `mig84_3` ← c4a/c9, `mig84_4` ← c8, `mig84_5` ← c1/c2/c3/c4b,
`mig84_6` ← c6. `mig84_1` is itself the comparator's positive control: it shows
the comparator reports a count, a name, a type and an order difference, so that
the empty problem lists the other cases assert are not empty because nothing
was looked at.

The claims are in separate `it` blocks, so no earlier assertion dominates a
later one; where two cases red together (c4a, c8, c9, c11) both are reported.

## 7. The live evidence, and what it does and does not establish

A real PostgreSQL 16.15, `server_encoding = UTF8`, in a `postgres:16` container
inside WSL `Ubuntu-24.04`, published on `5432` and reached from Windows at
`localhost:5432`. Nothing was listening on 5432 beforehand — measured **0** on
Windows and **0** inside WSL, with the Debian cluster `inactive`. The node
runner and the repository stayed on Windows; only the database was in WSL,
because `/mnt/c` is deliberately not mounted and was not mounted. The role
bootstrap and the migrate step used the same environment variables as `ci.yml`'s
*Create DAFTAR database + DB roles* and *Fresh database migrate* steps; the one
deviation is that `CREATE DATABASE` was issued through `docker exec psql`
inside the container rather than a Windows `psql`, which is not installed.
`embedded-postgres` was not used: it initialises a non-UTF-8 cluster on Windows
and dies on `22P05`, which is the dead end that blocked every earlier attempt.

| Run | Exit | What it showed |
| --- | --- | --- |
| `npm run migrate -w @daftar/api`, empty database, **before the fix** | **1** | `selling.migration_end_state_invalid: the set-based invoice_outstanding does not carry the two appended columns in the fixed order (found TABLE(…, due_date date, issue_date date))`. `schema_migrations` held **84** rows, newest `0083_phase4_ar_outstanding_set_based.sql`, and the live signature had rolled back to `0083`'s five-column form. It died on **`0084`**. |
| after the `0084` fix, fresh database | **1** | `0084` **applied** — 85 rows, newest `0084` — then `0085`'s pre-condition failed (§4) |
| after the `0085` fix, fresh database | **0** | **87 applied**, `0000` through `0086` |
| re-migrate, same database | **0** | "migrations applied: none (up to date)" |
| `npm run verify:history` | **0** | `MIGRATION HISTORY VERIFY: PASS — database history matches repository and manifest.` |
| negative control: `issue_date date` removed from E(1) again, fresh database | **1** | the same end-state refusal, now worded "three appended columns" |
| restored, fresh database | **0** | reaches latest again |

**The candidate sweep, by name.** `0000 → latest` applies every file in order,
so one successful run *is* the sweep. Read back from `schema_migrations` after
the green run:

| Migration | Applied from zero |
| --- | --- |
| `0080_phase4_cash_invoice_no_receivable.sql` | yes |
| `0081_phase4_customer_payments_credits.sql` | yes |
| `0082_phase4_customer_settlement_structural_pin.sql` | yes |
| `0083_phase4_ar_outstanding_set_based.sql` | yes |
| `0084_phase4_ar_fixed_cost_and_open_invoice_page.sql` | yes |
| `0085_phase4_allocation_recompute_set_based.sql` | yes — **for the first time** |
| `0086_phase4_rls_quals_once_per_query.sql` | yes — **for the first time** |

The live signature after the run is
`TABLE(invoice_id uuid, …, currency_code text, due_date date, issue_date date)`.

**What this does not establish.** Nothing about the Phase 4 **gates** or §E —
those belong to a seal-candidate run (DR-26) and are not this card's. Nothing
about the integration, golden or performance suites, which were not run. And
the law remains a static law: it would still pass on a tree whose migration
could not apply for some other reason.

## 8. Teardown

The throwaway database was dropped and the container removed, so nothing is
left running and nothing is left listening on 5432 — stated here because the
next card measures a quiet machine. No stray vitest config was ever written
into the tree: the configuration used to run the law without `globalSetup`
lived outside the repository, and the law's green was then reproduced through
the **committed** `vitest.config.ts` — `ensurePostgres()` reuses a server that
is already listening, so `tests/guards/**` ran for real with no change to the
committed setup.
